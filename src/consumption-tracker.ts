/**
 * Consumption Tracker v0.5.4
 *
 * Tracks per-provider usage across multiple time windows:
 *  - 5-hour rolling (matches Claude Code / Codex CLI subscription windows)
 *  - Weekly rolling (last 7 days)
 *  - Monthly rolling (last 30 days)
 *  - All-time cumulative
 *
 * Each request is bucketed into 1-hour slots, and totals are computed
 * by summing relevant buckets on query. This is a sliding window approach
 * that avoids per-request clock math.
 *
 * Persistence: hourly buckets flushed to data/consumption-history.json
 * on every 10-minute mark and on shutdown. Keeps ~35 days of hourly data
 * (840 buckets × 6 providers = ~200KB JSON).
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = join(__dirname, '../data/consumption-history.json');

const HOUR_MS = 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
const MONTH_MS = 30 * 24 * HOUR_MS;
const RETENTION_MS = 35 * 24 * HOUR_MS; // Keep 35 days of hourly buckets

// ─── Types ───────────────────────────────────────────────

export interface HourlyBucket {
  /** Start of the hour (ms since epoch) */
  hourStart: number;
  /** Number of requests in this hour */
  requests: number;
  /** Input tokens */
  tokensIn: number;
  /** Output tokens */
  tokensOut: number;
  /** Estimated cost (USD) */
  cost: number;
  /** Latency sum for averaging */
  latencySum: number;
  /** Latency count for averaging */
  latencyCount: number;
  /** Error count */
  errors: number;
}

export interface ProviderConsumption {
  provider: string;
  /** Hourly buckets, indexed by hour start (ms) */
  buckets: Record<number, HourlyBucket>;
  /** Cumulative all-time totals */
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  totalErrors: number;
  /** First request timestamp (for age tracking) */
  firstRequestAt: number;
  /** Last request timestamp */
  lastRequestAt: number;
}

export interface ConsumptionHistory {
  version: string;
  updatedAt: number;
  providers: Record<string, ProviderConsumption>;
}

export interface WindowConsumption {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cost: number;
  errors: number;
  avgLatencyMs: number;
  /** Window duration in ms */
  windowMs: number;
  /** Window start (ms since epoch) */
  windowStart: number;
  /** Window end (ms since epoch) */
  windowEnd: number;
  /** How many hours of data contributed */
  hoursCovered: number;
}

export interface ProviderConsumptionReport {
  provider: string;
  fiveHour: WindowConsumption;
  weekly: WindowConsumption;
  monthly: WindowConsumption;
  allTime: WindowConsumption;
  /** Days since first request (for context) */
  ageInDays: number;
  /** Average daily usage over the last 7 days */
  dailyAverage: {
    requests: number;
    tokens: number;
    cost: number;
  };
  /** Trend: % change in token usage from previous period */
  trend: {
    fiveHourVsPrevious: number;     // % change vs 5-10h ago
    weeklyVsPrevious: number;       // % change vs 7-14d ago
  };
  /** Quota status per window — null = unlimited for that metric */
  quota: ProviderQuotaStatus;
}

export interface QuotaWindowStatus {
  /** Used requests in this window */
  usedRequests: number;
  /** Max requests in this window (null = unlimited) */
  limitRequests: number | null;
  /** Remaining requests (null = unlimited) */
  remainingRequests: number | null;
  /** % of request quota used (null = unlimited) */
  usedPctRequests: number | null;
  /** Used tokens in this window */
  usedTokens: number;
  /** Max tokens in this window (null = unlimited) */
  limitTokens: number | null;
  /** Remaining tokens (null = unlimited) */
  remainingTokens: number | null;
  /** % of token quota used (null = unlimited) */
  usedPctTokens: number | null;
  /** When the window resets */
  resetAt: string;
  /** Type of reset */
  resetType: 'fixed' | 'rolling';
  /** Estimated time to quota exhaustion at current rate (null = safe) */
  etaExhaustion?: {
    requests?: number;  // ms until request quota hits 100%
    tokens?: number;    // ms until token quota hits 100%
  } | null;
}

export interface ProviderQuotaStatus {
  fiveHour: QuotaWindowStatus;
  weekly: QuotaWindowStatus;
  monthly: QuotaWindowStatus;
}

export interface ConsumptionReport {
  generatedAt: number;
  totalProviders: number;
  totalFiveHour: WindowConsumption;
  totalWeekly: WindowConsumption;
  totalMonthly: WindowConsumption;
  providers: ProviderConsumptionReport[];
}

// ─── Helpers ─────────────────────────────────────────────

/** Get the start-of-hour timestamp for a given ms */
function hourStart(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

/** Get an empty bucket for an hour */
function emptyBucket(hour: number): HourlyBucket {
  return {
    hourStart: hour,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    latencySum: 0,
    latencyCount: 0,
    errors: 0,
  };
}

/** Sum buckets in a time range */
function sumBuckets(
  buckets: Record<number, HourlyBucket>,
  startMs: number,
  endMs: number,
): { bucket: WindowConsumption; hoursCovered: number } {
  let requests = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let errors = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let hoursCovered = 0;

  const startHour = hourStart(startMs);
  const endHour = hourStart(endMs);

  for (let h = startHour; h <= endHour; h += HOUR_MS) {
    const b = buckets[h];
    if (b) {
      requests += b.requests;
      tokensIn += b.tokensIn;
      tokensOut += b.tokensOut;
      cost += b.cost;
      errors += b.errors;
      latencySum += b.latencySum;
      latencyCount += b.latencyCount;
      hoursCovered++;
    }
  }

  return {
    bucket: {
      requests,
      tokensIn,
      tokensOut,
      totalTokens: tokensIn + tokensOut,
      cost,
      errors,
      avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
      windowMs: endMs - startMs,
      windowStart: startMs,
      windowEnd: endMs,
      hoursCovered,
    },
    hoursCovered,
  };
}

// ─── Consumption Tracker ─────────────────────────────────

class ConsumptionTracker {
  private history: ConsumptionHistory;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** Last time we ran GC to prune old buckets */
  private lastGcAt = 0;
  private retentionGcInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.history = { version: '0.5.4', updatedAt: Date.now(), providers: {} };
  }

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
      const saved = JSON.parse(raw) as ConsumptionHistory;
      this.history = saved;
      console.log(`📈 Consumption Tracker: loaded history (${Object.keys(saved.providers).length} providers, ${this.countTotalBuckets()} hourly buckets)`);
    } catch {
      console.log('📈 Consumption Tracker: starting fresh');
    }

    // Prune old buckets every 6 hours
    this.retentionGcInterval = setInterval(() => this.pruneOldBuckets(), 6 * 60 * 60 * 1000);
  }

  private countTotalBuckets(): number {
    return Object.values(this.history.providers).reduce(
      (s, p) => s + Object.keys(p.buckets).length, 0
    );
  }

  /**
   * Record a request. Called from the gateway after every chat completion.
   */
  recordUsage(provider: string, data: {
    tokensIn: number;
    tokensOut: number;
    cost?: number;
    latencyMs: number;
    error?: boolean;
  }): void {
    if (!provider) return;

    let p = this.history.providers[provider];
    if (!p) {
      p = {
        provider,
        buckets: {},
        totalRequests: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalCost: 0,
        totalErrors: 0,
        firstRequestAt: 0,
        lastRequestAt: 0,
      };
      this.history.providers[provider] = p;
    }

    const now = Date.now();
    const h = hourStart(now);

    let bucket = p.buckets[h];
    if (!bucket) {
      bucket = emptyBucket(h);
      p.buckets[h] = bucket;
    }

    bucket.requests++;
    bucket.tokensIn += data.tokensIn || 0;
    bucket.tokensOut += data.tokensOut || 0;
    bucket.cost += data.cost || 0;
    bucket.latencySum += data.latencyMs || 0;
    bucket.latencyCount++;
    if (data.error) bucket.errors++;

    p.totalRequests++;
    p.totalTokensIn += data.tokensIn || 0;
    p.totalTokensOut += data.tokensOut || 0;
    p.totalCost += data.cost || 0;
    if (data.error) p.totalErrors++;
    if (p.firstRequestAt === 0) p.firstRequestAt = now;
    p.lastRequestAt = now;

    this.markDirty();

    // Prune if bucket count is way too high (>2000 = 83 days, should not happen)
    if (Object.keys(p.buckets).length > 2000) {
      this.pruneOldBuckets();
    }
  }

  /**
   * Remove buckets older than retention period.
   */
  private pruneOldBuckets(): void {
    const now = Date.now();
    if (now - this.lastGcAt < HOUR_MS) return; // At most once per hour
    this.lastGcAt = now;

    const cutoff = now - RETENTION_MS;
    let totalPruned = 0;

    for (const p of Object.values(this.history.providers)) {
      const keys = Object.keys(p.buckets).map(Number);
      for (const k of keys) {
        if (k < cutoff) {
          delete p.buckets[k];
          totalPruned++;
        }
      }
    }

    if (totalPruned > 0) {
      console.log(`🧹 [Consumption] Pruned ${totalPruned} hourly buckets older than 35 days`);
      this.markDirty();
    }
  }

  /**
   * Build a full consumption report with all time windows for all providers.
   */
  buildReport(options?: {
    /** Multi-window quota configs (from provider-quota.ts getMultiWindowQuota) */
    windowQuotas?: Record<string, import('./provider-quota.js').MultiWindowQuotaConfig>;
  }): ConsumptionReport {
    const now = Date.now();
    const fiveHourStart = now - FIVE_HOUR_MS;
    const tenHourStart = now - 2 * FIVE_HOUR_MS; // For trend
    const weeklyStart = now - WEEK_MS;
    const twoWeekStart = now - 2 * WEEK_MS;
    const monthlyStart = now - MONTH_MS;

    const providerReports: ProviderConsumptionReport[] = [];

    for (const p of Object.values(this.history.providers)) {
      const fiveHour = sumBuckets(p.buckets, fiveHourStart, now).bucket;
      const weekly = sumBuckets(p.buckets, weeklyStart, now).bucket;
      const monthly = sumBuckets(p.buckets, monthlyStart, now).bucket;
      const allTime = sumBuckets(p.buckets, 0, now).bucket;

      const previous5h = sumBuckets(p.buckets, tenHourStart, fiveHourStart).bucket;
      const previousWeek = sumBuckets(p.buckets, twoWeekStart, weeklyStart).bucket;

      const fiveHourVsPrevious = previous5h.totalTokens > 0
        ? ((fiveHour.totalTokens - previous5h.totalTokens) / previous5h.totalTokens) * 100
        : fiveHour.totalTokens > 0 ? 100 : 0;
      const weeklyVsPrevious = previousWeek.totalTokens > 0
        ? ((weekly.totalTokens - previousWeek.totalTokens) / previousWeek.totalTokens) * 100
        : weekly.totalTokens > 0 ? 100 : 0;

      const ageInDays = p.firstRequestAt > 0
        ? (now - p.firstRequestAt) / (24 * HOUR_MS)
        : 0;

      // Daily average over the last 7 days
      const daysCovered = Math.max(1, Math.min(7, weekly.hoursCovered / 24));
      const dailyAverage = {
        requests: Math.round(weekly.requests / daysCovered),
        tokens: Math.round(weekly.totalTokens / daysCovered),
        cost: +(weekly.cost / daysCovered).toFixed(6),
      };

      // Build quota status for each window
      const windowQuota = options?.windowQuotas?.[p.provider];
      const quota: ProviderQuotaStatus = {
        fiveHour: this.buildWindowQuota(fiveHour, windowQuota?.fiveHour, 5 * 60 * 60 * 1000, fiveHour.requests, fiveHour.totalTokens),
        weekly:   this.buildWindowQuota(weekly,   windowQuota?.weekly,   7 * 24 * 60 * 60 * 1000, weekly.requests, weekly.totalTokens),
        monthly:  this.buildWindowQuota(monthly,  windowQuota?.monthly,  30 * 24 * 60 * 60 * 1000, monthly.requests, monthly.totalTokens),
      };

      const report: ProviderConsumptionReport = {
        provider: p.provider,
        fiveHour,
        weekly,
        monthly,
        allTime,
        ageInDays: +ageInDays.toFixed(1),
        dailyAverage,
        trend: {
          fiveHourVsPrevious: +fiveHourVsPrevious.toFixed(1),
          weeklyVsPrevious: +weeklyVsPrevious.toFixed(1),
        },
        quota,
      };

      providerReports.push(report);
    }

    // Sort by 5-hour token usage (most active first)
    providerReports.sort((a, b) => b.fiveHour.totalTokens - a.fiveHour.totalTokens);

    // Aggregate totals across all providers
    const totalFiveHour = this.aggregate(providerReports.map(r => r.fiveHour));
    const totalWeekly = this.aggregate(providerReports.map(r => r.weekly));
    const totalMonthly = this.aggregate(providerReports.map(r => r.monthly));

    return {
      generatedAt: now,
      totalProviders: providerReports.length,
      totalFiveHour,
      totalWeekly,
      totalMonthly,
      providers: providerReports,
    };
  }

  /**
   * Build quota status for a single window (5h, weekly, or monthly).
   * Computes used/limit/remaining + ETA to exhaustion.
   */
  private buildWindowQuota(
    usage: WindowConsumption,
    config: import('./provider-quota.js').WindowQuotaConfig | undefined,
    windowMs: number,
    usedRequests: number,
    usedTokens: number,
  ): QuotaWindowStatus {
    if (!config) {
      // No config — unlimited
      return {
        usedRequests,
        limitRequests: null,
        remainingRequests: null,
        usedPctRequests: null,
        usedTokens,
        limitTokens: null,
        remainingTokens: null,
        usedPctTokens: null,
        resetAt: 'never',
        resetType: 'rolling',
        etaExhaustion: null,
      };
    }

    const limitReq = config.requests;
    const limitTok = config.tokens;

    const remainingReq = limitReq === null ? null : Math.max(0, limitReq - usedRequests);
    const remainingTok = limitTok === null ? null : Math.max(0, limitTok - usedTokens);

    const usedPctReq = limitReq === null || limitReq === 0
      ? null
      : +((usedRequests / limitReq) * 100).toFixed(1);
    const usedPctTok = limitTok === null || limitTok === 0
      ? null
      : +((usedTokens / limitTok) * 100).toFixed(1);

    // ETA to exhaustion: assume linear usage over the window so far
    // ms_have_elapsed_in_window = windowMs * hoursCovered / total_hours_in_window
    // Actually since usage is over a fully-elapsed window, we'd project forward
    // by extrapolating: used / hours_covered * total_hours_in_window
    // For a "live" rolling window, easier: if used > 0 and hoursCovered > 0,
    //   rate = used / hoursCovered (per hour)
    //   hoursToExhaust = (limit - used) / rate
    //   etaMs = hoursToExhaust * HOUR_MS
    let etaExhaustion: QuotaWindowStatus['etaExhaustion'] = null;

    if (usage.hoursCovered > 0) {
      const hoursInWindow = windowMs / (60 * 60 * 1000);
      const reqRatePerHour = usedRequests / usage.hoursCovered;
      const tokRatePerHour = usedTokens / usage.hoursCovered;

      if (limitReq !== null && remainingReq !== null && reqRatePerHour > 0) {
        const hoursToReqExhaust = remainingReq / reqRatePerHour;
        const etaReqMs = hoursToReqExhaust * 60 * 60 * 1000;
        // Only flag if exhaustion is within the window
        if (etaReqMs < windowMs && remainingReq < limitReq) {
          etaExhaustion = { ...(etaExhaustion || {}), requests: Math.round(etaReqMs) };
        }
      }
      if (limitTok !== null && remainingTok !== null && tokRatePerHour > 0) {
        const hoursToTokExhaust = remainingTok / tokRatePerHour;
        const etaTokMs = hoursToTokExhaust * 60 * 60 * 1000;
        if (etaTokMs < windowMs && remainingTok < limitTok) {
          etaExhaustion = { ...(etaExhaustion || {}), tokens: Math.round(etaTokMs) };
        }
      }
      // Silence unused warning for hoursInWindow
      void hoursInWindow;
    }

    return {
      usedRequests,
      limitRequests: limitReq,
      remainingRequests: remainingReq,
      usedPctRequests: usedPctReq,
      usedTokens,
      limitTokens: limitTok,
      remainingTokens: remainingTok,
      usedPctTokens: usedPctTok,
      resetAt: config.resetAt,
      resetType: config.resetType,
      etaExhaustion,
    };
  }

  private aggregate(windows: WindowConsumption[]): WindowConsumption {
    const valid = windows.filter(w => w.hoursCovered > 0);
    return {
      requests: valid.reduce((s, w) => s + w.requests, 0),
      tokensIn: valid.reduce((s, w) => s + w.tokensIn, 0),
      tokensOut: valid.reduce((s, w) => s + w.tokensOut, 0),
      totalTokens: valid.reduce((s, w) => s + w.totalTokens, 0),
      cost: +valid.reduce((s, w) => s + w.cost, 0).toFixed(6),
      errors: valid.reduce((s, w) => s + w.errors, 0),
      avgLatencyMs: valid.length > 0
        ? Math.round(valid.reduce((s, w) => s + w.avgLatencyMs, 0) / valid.length)
        : 0,
      windowMs: valid[0]?.windowMs || 0,
      windowStart: valid[0]?.windowStart || 0,
      windowEnd: valid[0]?.windowEnd || 0,
      hoursCovered: valid.reduce((s, w) => s + w.hoursCovered, 0),
    };
  }

  // ─── Persistence ───────────────────────────────────────

  private markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 30000); // Save every 30s
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.history.updatedAt = Date.now();
    try {
      await fs.mkdir(dirname(HISTORY_FILE), { recursive: true });
      await fs.writeFile(HISTORY_FILE, JSON.stringify(this.history), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.error('❌ [Consumption] Failed to persist:', (err as Error).message);
    }
    this.saveTimer = null;
  }

  getHistory(): ConsumptionHistory {
    return this.history;
  }
}

export const consumptionTracker = new ConsumptionTracker();
