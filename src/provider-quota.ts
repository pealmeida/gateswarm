/**
 * Provider Quota & Load Balancer v0.5.4
 *
 * Tracks provider-level rate limits, quotas, and usage patterns.
 * Balances token consumption across providers to optimize free-tier usage.
 * Auto-switches when a provider approaches its limit.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { modelMatrix, EffortLevel } from './model-matrix.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUOTA_FILE = join(__dirname, '../data/provider-quota.json');

// ─── Types ───────────────────────────────────────────────

export interface ProviderQuota {
  provider: string;
  name: string;

  // ── Rate limits ──
  rpm: number;              // Requests per minute
  rpd: number;              // Requests per day
  rpmRemaining: number;
  rpdRemaining: number;
  rpmResetAt: number;

  // ── Token limits (estimated) ──
  tokensDailyLimit: number;
  tokensRemaining: number;

  // ── Usage (current window) ──
  requestsThisMinute: number;
  requestsToday: number;
  tokensToday: number;
  lastRequestAt: number;
  minuteWindowStart: number;

  // ── Cumulative (all-time) ──
  totalRequests: number;
  totalTokens: number;

  // ── Health ──
  rateLimitHits: number;
  consecutive429s: number;
  throttled: boolean;
  throttledUntil: number;
  healthScore: number;       // 0–100, higher = better

  // ── Cost estimate ──
  estimatedCost: number;
}

export interface ProviderQuotaState {
  version: string;
  updatedAt: number;
  quotas: Record<string, ProviderQuota>;
}

export interface LoadBalanceDecision {
  provider: string;
  score: number;
  reason: string;
  remainingRPM: number;
  remainingRPD: number;
  healthScore: number;
  estimatedCost: number;
}

// ─── Provider configs ────────────────────────────────────

// ─── Multi-window quota configs ──────────────────────────

/**
 * Quota limits per provider across 3 time windows:
 *  - 5h: 5-hour rolling window (matches Claude Code / Codex CLI subscriptions)
 *  - weekly: 7-day rolling limit
 *  - monthly: 30-day rolling limit
 *
 * `null` means no limit for that window.
 * `resetAt` describes when the window resets.
 */
export interface WindowQuotaConfig {
  /** Max requests in window (null = unlimited) */
  requests: number | null;
  /** Max tokens in window (null = unlimited) */
  tokens: number | null;
  /** Human-readable reset schedule */
  resetAt: string;
  /** Type of reset */
  resetType: 'fixed' | 'rolling';
}

export interface MultiWindowQuotaConfig {
  fiveHour: WindowQuotaConfig;
  weekly: WindowQuotaConfig;
  monthly: WindowQuotaConfig;
}

const MULTI_WINDOW_QUOTAS: Record<string, MultiWindowQuotaConfig> = {
  'ollama': {
    // Local Ollama — truly unlimited
    fiveHour: { requests: null, tokens: null, resetAt: 'never', resetType: 'rolling' },
    weekly:  { requests: null, tokens: null, resetAt: 'never', resetType: 'rolling' },
    monthly: { requests: null, tokens: null, resetAt: 'never', resetType: 'rolling' },
  },
  'ollama-cloud': {
    // Ollama Cloud free tier: session-based quota (~reset every 24h)
    // Session is the primary constraint — maps to 5h window approximately
    // Real dashboard shows session % + deficit system
    fiveHour: { requests: 200,    tokens: 50000,  resetAt: '01:00 UTC (session)',   resetType: 'rolling' },
    weekly:  { requests: 2000,   tokens: 500000, resetAt: 'Monday 01:00 UTC',      resetType: 'fixed' },
    monthly: { requests: null,    tokens: null,   resetAt: 'never',                 resetType: 'rolling' },
  },
  'opencodego': {
    // OpenCode Go (opencode.ai/zen): token-based quotas across 3 windows
    // 5h is the most constraining; monthly is nearly exhausted (96%)
    fiveHour: { requests: null,   tokens: 50000,  resetAt: 'rolling 5h',            resetType: 'rolling' },
    weekly:  { requests: null,   tokens: 300000, resetAt: 'rolling 7d',            resetType: 'rolling' },
    monthly: { requests: null,   tokens: 500000, resetAt: '1st of month UTC',      resetType: 'fixed' },
  },
  'zai': {
    // Z.AI Coding Lite Plan: token quota resets every 5 days
    // Real dashboard: tokens 72% used, 5h 8%, MCP 0/100
    fiveHour: { requests: null,   tokens: 30000,  resetAt: 'rolling 5h',            resetType: 'rolling' },
    weekly:  { requests: null,   tokens: 200000, resetAt: 'Monday 00:00 UTC',      resetType: 'fixed' },
    monthly: { requests: null,   tokens: null,   resetAt: 'never',                 resetType: 'rolling' },
  },
  'openrouter': {
    // OpenRouter free tier: limited by credits / rate
    fiveHour: { requests: 100,    tokens: 25000,  resetAt: '00:00 UTC',             resetType: 'rolling' },
    weekly:  { requests: 1000,    tokens: null,   resetAt: 'Monday 00:00 UTC',      resetType: 'fixed' },
    monthly: { requests: null,    tokens: null,   resetAt: 'never',                 resetType: 'rolling' },
  },
  'bailian': {
    // Alibaba Bailian Coding Plan
    fiveHour: { requests: 300,    tokens: 250000, resetAt: '00:00 UTC',             resetType: 'rolling' },
    weekly:  { requests: 30000,   tokens: null,   resetAt: 'Monday 00:00 UTC',      resetType: 'fixed' },
    monthly: { requests: 100000,  tokens: null,   resetAt: '1st of month UTC',      resetType: 'fixed' },
  },
};

/**
 * Get the multi-window quota config for a provider.
 */
export function getMultiWindowQuota(provider: string): MultiWindowQuotaConfig | undefined {
  return MULTI_WINDOW_QUOTAS[provider];
}

const PROVIDER_QUOTA_CONFIGS: Record<string, Partial<ProviderQuota>> = {
  'ollama': {
    name: 'Ollama (Local CPU)',
    rpm: Infinity,
    rpd: Infinity,
    rpmRemaining: Infinity,
    rpdRemaining: Infinity,
    tokensDailyLimit: Infinity,
    tokensRemaining: Infinity,
  },
  'ollama-cloud': {
    name: 'Ollama Cloud (Hosted)',
    rpm: 100,               // Free tier: ~100 RPM
    rpd: 10000,             // Free tier: generous daily limit
    rpmRemaining: 100,
    rpdRemaining: 10000,
    tokensDailyLimit: 500000,
    tokensRemaining: 500000,
  },
  'opencodego': {
    name: 'OpenCode Go',
    rpm: 50,                // Free tier
    rpd: 5000,
    rpmRemaining: 50,
    rpdRemaining: 5000,
    tokensDailyLimit: 300000,
    tokensRemaining: 300000,
  },
  'zai': {
    name: 'ZAI (GLM Coding Lite)',
    rpm: 30,                // Coding lite plan
    rpd: 3000,
    rpmRemaining: 30,
    rpdRemaining: 3000,
    tokensDailyLimit: 200000,
    tokensRemaining: 200000,
  },
  'openrouter': {
    name: 'OpenRouter (Free)',
    rpm: 20,                // Free tier: lowest limit
    rpd: 200,
    rpmRemaining: 20,
    rpdRemaining: 200,
    tokensDailyLimit: 50000,
    tokensRemaining: 50000,
  },
  'bailian': {
    name: 'Bailian (Coding Plan)',
    rpm: 60,
    rpd: 5000,
    rpmRemaining: 60,
    rpdRemaining: 5000,
    tokensDailyLimit: 500000,
    tokensRemaining: 500000,
  },
};

// ─── Quota Manager ───────────────────────────────────────

class ProviderQuotaManager {
  private state: ProviderQuotaState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.state = { version: '0.5.4', updatedAt: Date.now(), quotas: {} };
  }

  async initialize(): Promise<void> {
    // Initialize from configs
    for (const [provider, config] of Object.entries(PROVIDER_QUOTA_CONFIGS)) {
      this.state.quotas[provider] = {
        provider,
        ...config,
        requestsThisMinute: 0,
        requestsToday: 0,
        tokensToday: 0,
        lastRequestAt: 0,
        minuteWindowStart: Date.now(),
        totalRequests: 0,
        totalTokens: 0,
        rateLimitHits: 0,
        consecutive429s: 0,
        throttled: false,
        throttledUntil: 0,
        healthScore: 100,
        estimatedCost: 0,
      } as ProviderQuota;
    }

    // Load persisted state
    try {
      const raw = await fs.readFile(QUOTA_FILE, 'utf-8');
      const saved = JSON.parse(raw) as ProviderQuotaState;
      // Merge cumulative totals from saved state
      for (const [provider, savedQuota] of Object.entries(saved.quotas)) {
        const current = this.state.quotas[provider];
        if (current) {
          current.totalRequests = savedQuota.totalRequests || 0;
          current.totalTokens = savedQuota.totalTokens || 0;
          current.rateLimitHits = savedQuota.rateLimitHits || 0;
          current.estimatedCost = savedQuota.estimatedCost || 0;
          current.tokensToday = savedQuota.tokensToday || 0;
          current.requestsToday = savedQuota.requestsToday || 0;
        }
      }
      console.log(`📊 Provider Quota: loaded cumulative stats (${Object.keys(saved.quotas).length} providers)`);
    } catch {
      console.log('📊 Provider Quota: starting fresh');
    }
  }

  // ─── Record usage ─────────────────────────────────────

  recordRequest(provider: string, tokens: number): void {
    const quota = this.state.quotas[provider];
    if (!quota) return;

    const now = Date.now();

    // Reset minute window if needed
    if (now - quota.minuteWindowStart >= 60000) {
      quota.requestsThisMinute = 0;
      quota.minuteWindowStart = now;
    }

    quota.requestsThisMinute++;
    quota.requestsToday++;
    quota.tokensToday += tokens;
    quota.totalRequests++;
    quota.totalTokens += tokens;
    quota.lastRequestAt = now;

    // Update remaining
    quota.rpmRemaining = Math.max(0, quota.rpm - quota.requestsThisMinute);
    quota.rpdRemaining = Math.max(0, quota.rpd - quota.requestsToday);
    quota.tokensRemaining = Math.max(0, quota.tokensDailyLimit - quota.tokensToday);

    // Update health score
    this.updateHealthScore(provider);

    this.markDirty();
  }

  record429(provider: string): void {
    const quota = this.state.quotas[provider];
    if (!quota) return;

    quota.rateLimitHits++;
    quota.consecutive429s++;

    // Escalate throttling
    if (quota.consecutive429s >= 3) {
      quota.throttled = true;
      quota.throttledUntil = Date.now() + 300000; // 5 min cooldown
      console.log(`🚫 [Quota] ${provider} throttled for 5min after ${quota.consecutive429s} consecutive 429s`);
    } else if (quota.consecutive429s >= 1) {
      quota.throttled = true;
      quota.throttledUntil = Date.now() + 60000; // 1 min cooldown
    }

    this.updateHealthScore(provider);
    this.markDirty();
  }

  recordSuccess(provider: string): void {
    const quota = this.state.quotas[provider];
    if (!quota) return;
    quota.consecutive429s = 0;
    quota.throttled = false;
    this.updateHealthScore(provider);
  }

  // ─── Health scoring ────────────────────────────────────

  private updateHealthScore(provider: string): void {
    const quota = this.state.quotas[provider];
    if (!quota) return;

    let score = 100;

    // Penalize for rate limit hits
    score -= quota.rateLimitHits * 15;

    // Penalize for consecutive 429s
    score -= quota.consecutive429s * 25;

    // Penalize for approaching RPM limit
    if (quota.rpm < Infinity && quota.requestsThisMinute > 0) {
      const rpmUsage = quota.requestsThisMinute / quota.rpm;
      if (rpmUsage > 0.8) score -= 30;
      else if (rpmUsage > 0.5) score -= 15;
      else if (rpmUsage > 0.3) score -= 5;
    }

    // Penalize for throttled
    if (quota.throttled && quota.throttledUntil > Date.now()) {
      score -= 50;
    }

    // Penalize for approaching daily limit
    if (quota.rpd < Infinity && quota.requestsToday > 0) {
      const rpdUsage = quota.requestsToday / quota.rpd;
      if (rpdUsage > 0.8) score -= 25;
      else if (rpdUsage > 0.5) score -= 10;
    }

    // Penalize for token limit approach
    if (quota.tokensDailyLimit < Infinity && quota.tokensToday > 0) {
      const tokenUsage = quota.tokensToday / quota.tokensDailyLimit;
      if (tokenUsage > 0.8) score -= 20;
      else if (tokenUsage > 0.5) score -= 8;
    }

    quota.healthScore = Math.max(0, score);
  }

  // ─── Load balancing ────────────────────────────────────

  /**
   * Score providers for a given tier. Returns ranked list.
   * Considers: remaining quota, health score, cost, latency.
   */
  rankProvidersForTier(tier: EffortLevel, excludeProvider?: string): LoadBalanceDecision[] {
    const results: LoadBalanceDecision[] = [];

    for (const [provider, quota] of Object.entries(this.state.quotas)) {
      if (excludeProvider && provider === excludeProvider) continue;
      if (quota.throttled && quota.throttledUntil > Date.now()) continue;
      if (quota.healthScore <= 0) continue;

      // Check if provider has any models in this tier
      const models = modelMatrix.getModelsForTier(tier)
        .filter(m => m.provider === provider);
      if (models.length === 0) continue;

      // Score: health (40%) + remaining capacity (35%) + cost (25%)
      let score = 0;

      // Health score contribution
      score += quota.healthScore * 0.4;

      // Remaining capacity
      const rpmRatio = quota.rpm === Infinity ? 1 : Math.max(0, quota.rpmRemaining / quota.rpm);
      const rpdRatio = quota.rpd === Infinity ? 1 : Math.max(0, quota.rpdRemaining / quota.rpd);
      score += (rpmRatio * 20 + rpdRatio * 15);

      // Cost contribution (cheaper = higher score)
      if (quota.estimatedCost === 0) score += 25;
      else if (quota.estimatedCost < 0.001) score += 15;
      else score += 5;

      // Provider-specific latency bonus
      const summary = modelMatrix.getProviderSummary(provider);
      if (summary && summary.avgLatencyMs > 0 && summary.avgLatencyMs < 5000) {
        score += 5;
      }

      results.push({
        provider,
        score,
        reason: this.getRankReason(quota),
        remainingRPM: quota.rpmRemaining,
        remainingRPD: quota.rpdRemaining,
        healthScore: quota.healthScore,
        estimatedCost: quota.estimatedCost,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Check if the current provider should be switched out.
   */
  shouldSwitch(provider: string): { shouldSwitch: boolean; reason: string } {
    const quota = this.state.quotas[provider];
    if (!quota) return { shouldSwitch: false, reason: 'unknown' };

    if (quota.throttled && quota.throttledUntil > Date.now()) {
      return { shouldSwitch: true, reason: 'throttled' };
    }

    if (quota.healthScore < 30) {
      return { shouldSwitch: true, reason: `low health (${quota.healthScore})` };
    }

    if (quota.rpm < Infinity && quota.rpmRemaining <= 0) {
      return { shouldSwitch: true, reason: 'RPM exhausted' };
    }

    if (quota.rpd < Infinity && quota.rpdRemaining <= 5) {
      return { shouldSwitch: true, reason: 'approaching daily limit' };
    }

    if (quota.tokensDailyLimit < Infinity && quota.tokensRemaining <= 0) {
      return { shouldSwitch: true, reason: 'token budget exhausted' };
    }

    return { shouldSwitch: false, reason: 'ok' };
  }

  private getRankReason(quota: ProviderQuota): string {
    if (quota.healthScore >= 90) return 'healthy + ample capacity';
    if (quota.healthScore >= 60) return 'moderate capacity';
    if (quota.healthScore >= 30) return 'low capacity';
    if (quota.throttled) return 'throttled';
    return 'unknown';
  }

  // ─── Queries ───────────────────────────────────────────

  getQuota(provider: string): ProviderQuota | undefined {
    return this.state.quotas[provider];
  }

  getAllQuotas(): ProviderQuota[] {
    return Object.values(this.state.quotas);
  }

  getUsageSummary() {
    const quotas = Object.values(this.state.quotas);
    const totalTokens = quotas.reduce((s, q) => s + q.totalTokens, 0);
    const totalRequests = quotas.reduce((s, q) => s + q.totalRequests, 0);
    const totalToday = quotas.reduce((s, q) => s + q.tokensToday, 0);
    const totalCost = quotas.reduce((s, q) => s + q.estimatedCost, 0);
    const throttledCount = quotas.filter(q => q.throttled).length;

    return {
      totalTokens,
      totalRequests,
      tokensToday: totalToday,
      estimatedTotalCost: totalCost,
      providersThrottled: throttledCount,
      providers: quotas.map(q => ({
        provider: q.provider,
        name: q.name,
        healthScore: q.healthScore,
        rpm: q.rpm === Infinity ? '∞' : `${q.rpmRemaining}/${q.rpm}`,
        rpd: q.rpd === Infinity ? '∞' : `${q.rpdRemaining}/${q.rpd}`,
        tokens: q.tokensDailyLimit === Infinity ? '∞' : `${q.tokensRemaining}/${q.tokensDailyLimit}`,
        requestsToday: q.requestsToday,
        tokensToday: q.tokensToday,
        throttled: q.throttled,
        cost: q.estimatedCost.toFixed(6),
        lastRequest: q.lastRequestAt ? new Date(q.lastRequestAt).toISOString() : 'never',
      })),
    };
  }

  /**
   * v0.5.5: Feed real dashboard quota data into health scoring.
   * Called after quota-sync scraper runs. If a provider's real dashboard
   * shows >80% usage in any window, penalize health score heavily.
   */
  applyRealQuotaData(realData: Record<string, {
    fiveHourUsedPct: number | null;
    weeklyUsedPct: number | null;
    monthlyUsedPct: number | null;
  }>): void {
    for (const [provider, data] of Object.entries(realData)) {
      const quota = this.state.quotas[provider];
      if (!quota) continue;

      // Check each window — if any is critically high, penalize
      const criticalThreshold = 85;
      const warningThreshold = 70;

      let penalty = 0;
      if (data.monthlyUsedPct !== null && data.monthlyUsedPct >= criticalThreshold) {
        penalty += 40; // Monthly near exhaustion — severe
        console.log(`🚨 [Quota] ${provider} monthly at ${data.monthlyUsedPct}% — critical penalty`);
      } else if (data.monthlyUsedPct !== null && data.monthlyUsedPct >= warningThreshold) {
        penalty += 20;
      }
      if (data.weeklyUsedPct !== null && data.weeklyUsedPct >= criticalThreshold) {
        penalty += 30;
      } else if (data.weeklyUsedPct !== null && data.weeklyUsedPct >= warningThreshold) {
        penalty += 15;
      }
      if (data.fiveHourUsedPct !== null && data.fiveHourUsedPct >= criticalThreshold) {
        penalty += 25;
        // Auto-throttle if 5h window is critically exhausted
        if (!quota.throttled) {
          quota.throttled = true;
          quota.throttledUntil = Date.now() + 300000; // 5 min
        }
      } else if (data.fiveHourUsedPct !== null && data.fiveHourUsedPct >= warningThreshold) {
        penalty += 10;
      }

      quota.healthScore = Math.max(0, quota.healthScore - penalty);
    }
    this.markDirty();
  }

  /**
   * Reset daily counters at midnight.
   */
  dailyReset(): void {
    const now = new Date();
    for (const quota of Object.values(this.state.quotas)) {
      quota.requestsToday = 0;
      quota.tokensToday = 0;
      quota.requestsThisMinute = 0;
      quota.rpmRemaining = quota.rpm;
      quota.rpdRemaining = quota.rpd;
      quota.tokensRemaining = quota.tokensDailyLimit;
      // v0.5.5: Don't fully reset throttled/health — carry over rate-limit penalty.
      // A provider that was rate-limited yesterday is likely still constrained.
      // Only clear throttling if the cooldown has expired.
      if (quota.throttled && quota.throttledUntil <= Date.now()) {
        quota.throttled = false;
      }
      // Carry over 50% of the rate-limit penalty into the new day
      if (quota.consecutive429s > 0) {
        quota.consecutive429s = Math.max(0, quota.consecutive429s - 1);
      }
      // Health: recover to at most 80 if previously penalized, 100 if clean
      quota.healthScore = Math.min(100, quota.healthScore + 30);
    }
    console.log(`📊 [Quota] Daily reset at ${now.toISOString()}`);
    this.markDirty();
  }

  // ─── Persistence ───────────────────────────────────────

  private markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 10000);
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.state.updatedAt = Date.now();
    try {
      await fs.mkdir(dirname(QUOTA_FILE), { recursive: true });
      await fs.writeFile(QUOTA_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.error('❌ [Quota] Failed to persist:', (err as Error).message);
    }
    this.saveTimer = null;
  }

  getState(): ProviderQuotaState {
    return this.state;
  }
}

export const providerQuota = new ProviderQuotaManager;
