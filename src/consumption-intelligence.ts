/**
 * Token Consumption Intelligence v0.5.7
 *
 * Decision engine that selects the optimal model/provider for
 * each routing tier based on:
 *  - Static tier config (v04_config.json) as PRIMARY source
 *  - Active provider health probing (not just cached scores)
 *  - Model availability and health (from Model Matrix)
 *  - Token consumption history and cost efficiency
 *  - Provider rate limits and latency
 *  - Complexity tier requirements
 *
 * v0.5.7: Static-first routing with active provider probing.
 *   - Static tier config is PRIMARY; dynamic discovery is fallback.
 *   - Providers are actively probed (lightweight /models check) before use.
 *   - Quota-exhausted providers are excluded from dynamic candidates.
 *   - Provider health scores factor real quota state, not just cached metadata.
 */

import { modelMatrix, ModelEntry, EffortLevel, ProviderSummary } from './model-matrix.js';
import { agentRegistry } from './agent-registry.js';
import { getConfig, saveConfig } from './v04-config.js';
import { providerQuota, getMultiWindowQuota } from './provider-quota.js';

// ─── Types ───────────────────────────────────────────────

export interface ConsumptionDecision {
  provider: string;
  model: string;
  tier: EffortLevel;
  reason: DecisionReason;
  estimatedTokens: number;
  estimatedCost: number;
  confidence: number;
  alternatives: Array<{ provider: string; model: string; reason: string }>;
  // v0.5.6: flag to distinguish real request decisions from health/balance checks.
  // Health checks pollute the ActivityPanel and confuse operators about what
  // tier was actually used for user traffic.
  source: 'request' | 'health-check' | 'balance-check' | 'recovery-check';
  timestamp: number;
}

export type DecisionReason =
  | 'cheapest_available'
  | 'fastest_available'
  | 'most_capable'
  | 'only_available'
  | 'consumption_balanced'
  | 'provider_preferred'
  | 'static_fallback';

export interface ConsumptionStats {
  totalTokensIn: number;
  totalTokensOut: number;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  estimatedTotalCost: number;
  providers: ProviderSummary[];
  tierDistribution: Record<EffortLevel, number>;
  modelCount: number;
  availableModels: number;
}

// ─── Pricing Tables ─────────────────────────────────────

interface ProviderPricing {
  inputCostPer1k: number;
  outputCostPer1k: number;
  freeTier: boolean;
  rateLimitRPM: number;
}

const PROVIDER_PRICING: Record<string, ProviderPricing> = {
  'ollama':          { inputCostPer1k: 0,     outputCostPer1k: 0,     freeTier: true,  rateLimitRPM: Infinity },
  'ollama-cloud':    { inputCostPer1k: 0,     outputCostPer1k: 0,     freeTier: true,  rateLimitRPM: 100 },
  'opencodego':      { inputCostPer1k: 0,     outputCostPer1k: 0,     freeTier: true,  rateLimitRPM: 50 },
  'zai':             { inputCostPer1k: 0,     outputCostPer1k: 0,     freeTier: true,  rateLimitRPM: 30 },
  'openrouter':      { inputCostPer1k: 0,     outputCostPer1k: 0,     freeTier: true,  rateLimitRPM: 20 },
  'bailian':         { inputCostPer1k: 0.001, outputCostPer1k: 0.002, freeTier: false, rateLimitRPM: 60 },
};

// ─── Tier capability requirements ────────────────────────

interface TierRequirements {
  minContextWindow: number;
  minMaxTokens: number;
  needsReasoning: boolean;
  needsVision: boolean;
  needsTools: boolean;
  maxLatencyMs: number;
  maxCostPer1kInput: number;
}

const TIER_REQUIREMENTS: Record<EffortLevel, TierRequirements> = {
  trivial:    { minContextWindow: 8000,   minMaxTokens: 256,   needsReasoning: false, needsVision: false, needsTools: false, maxLatencyMs: 15000, maxCostPer1kInput: Infinity },
  light:      { minContextWindow: 32000,  minMaxTokens: 2048,  needsReasoning: false, needsVision: false, needsTools: false, maxLatencyMs: 20000, maxCostPer1kInput: Infinity },
  moderate:   { minContextWindow: 64000,  minMaxTokens: 4096,  needsReasoning: true,  needsVision: false, needsTools: true,  maxLatencyMs: 30000, maxCostPer1kInput: Infinity },
  heavy:      { minContextWindow: 128000, minMaxTokens: 8192,  needsReasoning: true,  needsVision: false, needsTools: true,  maxLatencyMs: 45000, maxCostPer1kInput: Infinity },
  intensive:  { minContextWindow: 200000, minMaxTokens: 16384, needsReasoning: true,  needsVision: false, needsTools: true,  maxLatencyMs: 75000, maxCostPer1kInput: Infinity },
  extreme:    { minContextWindow: 500000, minMaxTokens: 32768, needsReasoning: true,  needsVision: false, needsTools: true,  maxLatencyMs: 120000, maxCostPer1kInput: Infinity },
};

// ─── Consumption Intelligence Engine ─────────────────────

class ConsumptionIntelligence {
  private decisions: ConsumptionDecision[] = [];
  private readonly maxDecisionHistory = 100;

  // ─── v0.5.7: Active provider probing ──────────────────
  // Track when each provider was last probed and whether it passed.
  private providerProbes: Map<string, { probedAt: number; healthy: boolean; error?: string }> = new Map();
  private readonly PROBE_TTL_MS = 60000; // Re-probe every 60s

  /**
   * Actively probe a provider's health by calling its /models endpoint.
   * Returns true if the provider responds successfully.
   */
  private async probeProvider(providerId: string): Promise<{ healthy: boolean; error?: string }> {
    const cached = this.providerProbes.get(providerId);
    if (cached && (Date.now() - cached.probedAt) < this.PROBE_TTL_MS) {
      return { healthy: cached.healthy, error: cached.error };
    }

    const providerConfig = agentRegistry.getProvider(providerId);
    if (!providerConfig) {
      const result = { healthy: false, error: 'no provider config' };
      this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });
      return result;
    }

    // CLI providers: check if binary exists
    if (providerConfig.type === 'cli-agent') {
      const healthCheck = (providerConfig as any).cliConfig?.healthCheck;
      if (healthCheck) {
        try {
          const { execSync } = await import('child_process');
          execSync(healthCheck.command, { timeout: 5000 });
          const result = { healthy: true };
          this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });
          return result;
        } catch (e: any) {
          const result = { healthy: false, error: e.message };
          this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });
          return result;
        }
      }
      // No health check defined — assume healthy
      const result = { healthy: true };
      this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });
      return result;
    }

    // HTTP API providers: call /models endpoint first, then deep-probe with chat completion
    const baseUrl = agentRegistry.getProviderBaseUrl(providerId);
    const apiKey = agentRegistry.getProviderApiKey(providerId);
    if (!baseUrl) {
      const result = { healthy: false, error: 'no base URL' };
      this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });
      return result;
    }

    try {
      // Step 1: Quick /models check
      const modelsUrl = baseUrl.replace(/\/+$/, '') + '/models';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(modelsUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        const isQuotaError = body.includes('UsageLimitError') ||
          body.includes('usage limit') ||
          body.includes('quota_exhausted') ||
          body.includes('insufficient_quota') ||
          resp.status === 429 || resp.status === 402;

        const error = isQuotaError
          ? `quota_exhausted (HTTP ${resp.status})`
          : `HTTP ${resp.status}: ${body.slice(0, 100)}`;

        const result = { healthy: false, error };
        this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });

        if (isQuotaError) {
          providerQuota.record429(providerId);
          console.log(`🔴 [Intel Probe] ${providerId}: QUOTA EXHAUSTED — marking throttled`);
        }

        return result;
      }

      // Step 2: Deep probe — send a minimal chat completion to catch quota errors
      // that /models doesn't reveal (e.g., OpenCode Go UsageLimitError, ZAI rate limits).
      // Use a model from this provider's catalog to get accurate error responses.
      const chatUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';
      const deepController = new AbortController();
      const deepTimeout = setTimeout(() => deepController.abort(), 8000);

      // Pick a model known to exist on this provider
      const providerModels = agentRegistry.getProviderModels(providerId);
      const probeModel = providerModels?.[0] || 'deepseek-v4-pro';

      try {
        const deepResp = await fetch(chatUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: probeModel,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,  // Request 5 tokens so empty response = real error, not max_tokens=1 artifact
          }),
          signal: deepController.signal,
        });
        clearTimeout(deepTimeout);

        const deepBody = await deepResp.text().catch(() => '');

        // Check for quota errors in BOTH non-200 status AND 200 body content
        // ZAI returns 200 OK with error in body when rate-limited
        const isQuotaError = deepBody.includes('UsageLimitError') ||
          deepBody.includes('usage limit') ||
          deepBody.includes('quota_exhausted') ||
          deepBody.includes('insufficient_quota') ||
          deepBody.includes('GoUsageLimitError') ||
          deepBody.includes('Limit Exhausted') ||
          deepBody.includes('Rate limit reached') ||
          deepBody.includes('Weekly/Monthly Limit') ||
          !deepResp.ok && (deepResp.status === 429 || deepResp.status === 402);

        if (isQuotaError) {
          const result = { healthy: false, error: `quota_exhausted: ${deepBody.slice(0, 120)}` };
          this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });
          providerQuota.record429(providerId);
          console.log(`🔴 [Intel Probe] ${providerId}: DEEP PROBE FAILED — quota exhausted`);
          return result;
        }

        // Also check: if HTTP 200 but body contains error object with no choices
        if (deepResp.ok) {
          try {
            const json = JSON.parse(deepBody);
            if (json.error && !json.choices) {
              const errMsg = json.error.message || json.error.code || JSON.stringify(json.error);
              const isRateLimit = errMsg.includes('limit') || errMsg.includes('rate') || errMsg.includes('quota') || errMsg.includes('exhausted');
              if (isRateLimit) {
                const result = { healthy: false, error: `rate_limited: ${errMsg.slice(0, 120)}` };
                this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });
                providerQuota.record429(providerId);
                console.log(`🔴 [Intel Probe] ${providerId}: DEEP PROBE FAILED — rate limited (200 OK with error body)`);
                return result;
              }
            }
            // No choices + no content = likely error
            if (!json.choices && !json.error) {
              console.log(`🟡 [Intel Probe] ${providerId}: deep probe returned 200 but no choices — may be degraded`);
            }
          } catch { /* not JSON, ignore */ }
        }
        // Deep probe passed — provider is fully healthy
      } catch (deepErr: any) {
        // Deep probe network error — not necessarily unhealthy, /models passed
        if (deepErr.name === 'AbortError') {
          console.log(`🟡 [Intel Probe] ${providerId}: deep probe timed out — using /models result only`);
        }
      }
      clearTimeout(deepTimeout);

      const result = { healthy: true };
      this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });
      return result;
    } catch (err: any) {
      const result = { healthy: false, error: err.message };
      this.providerProbes.set(providerId, { probedAt: Date.now(), ...result });
      return result;
    }
  }

  /**
   * Check if a provider is healthy based on probe + quota state.
   * Returns false if: probe failed, throttled, or healthScore < 30.
   * If no probe cache exists, assumes healthy (probe happens in selectModel).
   */
  private isProviderHealthy(providerId: string): boolean {
    // Check probe cache first — negative probe = definitely unhealthy
    const probe = this.providerProbes.get(providerId);
    if (probe && !probe.healthy) return false;

    // Check quota state
    const pq = providerQuota.getQuota(providerId);
    if (pq) {
      if (pq.throttled && pq.throttledUntil > Date.now()) return false;
      if (pq.healthScore < 30) return false;
    }

    // No negative probe, not throttled, health OK → assume healthy
    return true;
  }

  /**
   * Select the best model for a given complexity tier.
   *
   * v0.5.7: Static-first routing with active provider probing.
   * 1. Check static tier config from v04_config.json — this is PRIMARY.
   * 2. Actively probe the static model's provider.
   * 3. If healthy → use static config (with dynamic alternatives as fallback).
   * 4. If unhealthy → run dynamic discovery but exclude unhealthy providers.
   * 5. Dynamic candidates are filtered by active probe results + quota health.
   */
  async selectModel(tier: EffortLevel, options?: {
    preferProvider?: string;
    excludeProviders?: string[];
    estimatedPromptTokens?: number;
    source?: 'request' | 'health-check' | 'balance-check' | 'recovery-check';
  }): Promise<ConsumptionDecision> {
    const reqs = TIER_REQUIREMENTS[tier];
    const staticCfg = getConfig().tier_models[tier];

    // ── v0.5.7: Static config is PRIMARY ──────────────────
    // Probe the static config's provider first. If healthy, use it.
    // Skip static priority only for recovery-check (we're looking for alternatives).
    if (staticCfg && options?.source !== 'recovery-check') {
      const probe = await this.probeProvider(staticCfg.provider);
      if (probe.healthy && this.isProviderHealthy(staticCfg.provider)) {
        const decision: ConsumptionDecision = {
          provider: staticCfg.provider,
          model: staticCfg.model,
          tier,
          reason: 'provider_preferred',
          estimatedTokens: options?.estimatedPromptTokens || 500,
          estimatedCost: 0,
          confidence: 0.90,
          alternatives: (staticCfg.fallback_models || []).map(f => ({
            provider: f.provider,
            model: f.model,
            reason: 'static_fallback',
          })),
          source: options?.source || 'request',
          timestamp: Date.now(),
        };
        this.decisions.push(decision);
        if (this.decisions.length > this.maxDecisionHistory) this.decisions.shift();
        console.log(`🧠 [Intel] ${tier} → ${decision.provider}/${decision.model} (static_primary, conf=${decision.confidence.toFixed(2)})`);
        return decision;
      }
      console.log(`🟡 [Intel] ${tier}: static provider ${staticCfg.provider} unhealthy (${probe.error || 'healthScore low'}) — falling back to dynamic`);
    }

    // ── Dynamic discovery (fallback) ──────────────────────
    // v0.5.7: Before scoring dynamic candidates, probe all candidate providers
    // that haven't been probed yet. This catches quota-exhausted providers
    // that aren't in the static config (e.g., opencodego when bailian is static).
    const allModels = modelMatrix.getAvailableModels();

    // Collect unique providers from tier-matching candidates
    const candidateProviders = new Set<string>();
    for (const m of allModels) {
      const tierIdx = this.tierRank(tier);
      const modelTierIdx = this.tierRank(m.recommendedTier);
      if (modelTierIdx === tierIdx || modelTierIdx === tierIdx + 1 || modelTierIdx === tierIdx - 1) {
        if (!(tierIdx <= 1 && modelTierIdx >= 3)) {
          candidateProviders.add(m.provider);
        }
      }
    }

    // Probe unprobed candidate providers (skip already-known unhealthy ones)
    const probeResults = new Map<string, boolean>();
    for (const pid of candidateProviders) {
      if (this.providerProbes.has(pid)) continue; // Already probed
      if (pid === 'ollama') continue; // Local, always available
      const probe = await this.probeProvider(pid);
      probeResults.set(pid, probe.healthy);
    }

    // Filter by tier capability + active provider health
    const excludeSet = new Set(options?.excludeProviders || []);
    const candidates = allModels.filter(m => {
      // Skip providers without base URL (can't route to them)
      const providerConfig = agentRegistry.getProvider(m.provider);
      if (!providerConfig) return false;
      const baseUrl = agentRegistry.getProviderBaseUrl(m.provider);
      if (!baseUrl && !['ollama', 'ollama-cloud'].includes(m.provider)) return false;
      // Note: API key can be empty for free-tier providers (openrouter free models)

      // ── v0.5.7: Exclude unhealthy providers ──
      if (excludeSet.has(m.provider)) return false;
      if (!this.isProviderHealthy(m.provider)) return false;

      // ── Tier matching ──
      const tierIdx = this.tierRank(tier);
      const modelTierIdx = this.tierRank(m.recommendedTier);
      if (modelTierIdx !== tierIdx && modelTierIdx !== tierIdx + 1 && modelTierIdx !== tierIdx - 1) return false;
      if (tierIdx <= 1 && modelTierIdx >= 3) return false;

      // Check capability requirements
      if (m.contextWindow < reqs.minContextWindow) return false;
      if (m.maxTokens < reqs.minMaxTokens) return false;
      if (reqs.needsReasoning && !m.supportsReasoning) return false;
      if (reqs.needsVision && !m.supportsVision) return false;
      if (reqs.needsTools && !m.supportsTools) return false;
      if (m.avgLatencyMs > reqs.maxLatencyMs && m.avgLatencyMs > 0) return false;
      return true;
    });

    if (candidates.length === 0) {
      // Ultimate fallback: use static config even if provider is unhealthy
      if (staticCfg) {
        console.log(`🧠 [Intel] ${tier}: no healthy candidates — using static config anyway: ${staticCfg.provider}/${staticCfg.model}`);
        return {
          provider: staticCfg.provider,
          model: staticCfg.model,
          tier,
          reason: 'static_fallback',
          estimatedTokens: options?.estimatedPromptTokens || 500,
          estimatedCost: 0,
          confidence: 0.2,
          alternatives: [],
          source: options?.source || 'request',
          timestamp: Date.now(),
        };
      }
      throw new Error(`No models available for tier: ${tier}`);
    }

    // Score candidates
    const scored = candidates.map(m => ({
      model: m,
      score: this.scoreModel(m, tier, reqs, options?.preferProvider),
    }));

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].model;

    // Build alternatives
    const alternatives = scored.slice(1, 4).map(s => ({
      provider: s.model.provider,
      model: s.model.id,
      reason: `score=${s.score.toFixed(1)}`,
    }));

    const decision: ConsumptionDecision = {
      provider: best.provider,
      model: best.id,
      tier,
      reason: this.determineReason(best, options?.preferProvider),
      estimatedTokens: options?.estimatedPromptTokens || 500,
      estimatedCost: (best.costPer1kInput + best.costPer1kOutput) * (options?.estimatedPromptTokens || 500) / 2000,
      confidence: Math.min(0.95, scored[0].score / 100),
      alternatives,
      source: options?.source || 'request',
      timestamp: Date.now(),
    };

    this.decisions.push(decision);
    if (this.decisions.length > this.maxDecisionHistory) this.decisions.shift();

    console.log(`🧠 [Intel] ${tier} → ${decision.provider}/${decision.model} (${decision.reason}, conf=${decision.confidence.toFixed(2)})`);
    return decision;
  }

  /**
   * Check if a model should be switched out (e.g., after consecutive failures).
   */
  shouldSwitch(provider: string, modelId: string): boolean {
    const model = modelMatrix.getModel(provider, modelId);
    if (!model) return false;
    return model.consecutiveFailures >= 3 || !model.available;
  }

  /**
   * Get the best alternative when a model fails.
   */
  async getFallback(tier: EffortLevel, failedProvider: string, failedModel: string, source: 'request' | 'health-check' | 'balance-check' | 'recovery-check' = 'request'): Promise<ConsumptionDecision | null> {
    const excludeProviders = new Set([failedProvider]);

    // Try same tier excluding failed provider
    try {
      return await this.selectModel(tier, { excludeProviders: [...excludeProviders], source });
    } catch {
      // Fall back to next tier up
      const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
      const idx = tiers.indexOf(tier);
      for (let i = idx + 1; i < tiers.length; i++) {
        try {
          return await this.selectModel(tiers[i], { excludeProviders: [...excludeProviders], source });
        } catch { /* continue */ }
      }
    }
    return null;
  }

  /**
   * Score a model for a specific tier's requirements.
   * Higher score = better fit.
   *
   * v0.5.4: Per-tier weighted scoring.
   * For lower tiers (trivial/light): reward small/fast/cheap models.
   * For higher tiers (heavy+): reward capable/large models.
   * Cost efficiency is always a factor but not overwhelming.
   */
  private scoreModel(m: ModelEntry, tier: EffortLevel, reqs: TierRequirements, preferProvider?: string): number {
    let score = 0;

    // ── Size scoring: use model's recommendedTier as primary indicator ──
    // (already correctly classified by comprehensive model-matrix.ts)
    const tierIdx = this.tierRank(tier);
    const modelTierIdx = this.tierRank(m.recommendedTier);

    // Strong bonus when model's natural tier matches target tier
    let sizeScore = 0;
    if (modelTierIdx === tierIdx) {
      sizeScore = 25; // Perfect fit
    } else if (modelTierIdx === tierIdx + 1) {
      sizeScore = 15; // One tier above — acceptable
    } else if (modelTierIdx === tierIdx - 1) {
      sizeScore = 8; // One tier below — underpowered but usable
    } else if (modelTierIdx > tierIdx + 1) {
      sizeScore = 5; // Much larger than needed — wasteful
    } else {
      sizeScore = 0; // Too small for this tier
    }
    score += sizeScore;

    // Capability match (0–20)
    const cwRatio = Math.min(1, m.contextWindow / reqs.minContextWindow);
    score += 10 * cwRatio;

    const mtRatio = Math.min(1, m.maxTokens / reqs.minMaxTokens);
    score += 5 * mtRatio;

    if (reqs.needsReasoning && m.supportsReasoning) score += 3;
    if (reqs.needsVision && m.supportsVision) score += 2;
    if (reqs.needsTools && m.supportsTools) score += 2;

    // Cost efficiency (0–20) — cheap models get bonus, but not overwhelming
    const totalCost = m.costPer1kInput + m.costPer1kOutput;
    if (totalCost === 0) score += 20; // free
    else if (totalCost <= 0.001) score += 15; // very cheap
    else if (totalCost <= 0.01) score += 10;
    else if (totalCost <= 0.05) score += 5;
    else score += 1; // expensive

    // Health & availability (0–25) — v0.5.5: includes provider-level quota health
    let healthScore = 0;

    // Model-level health (0–10)
    if (m.consecutiveFailures === 0) healthScore += 10;
    else if (m.consecutiveFailures === 1) healthScore += 5;
    else healthScore += 0;

    // Provider-level quota health (0–15) — the critical missing piece
    const pq = providerQuota.getQuota(m.provider);
    if (pq) {
      // Throttled providers get zero — they're unusable right now
      if (pq.throttled && pq.throttledUntil > Date.now()) {
        healthScore += 0;
      } else {
        // Use the provider's health score (0–100) scaled to 0–15
        healthScore += Math.round(pq.healthScore * 0.15);
      }
    } else {
      // Unknown provider — neutral score
      healthScore += 7;
    }
    score += healthScore;

    // Latency (0–10) — faster models score higher
    if (m.avgLatencyMs > 0) {
      if (m.avgLatencyMs < 3000) score += 10;
      else if (m.avgLatencyMs < 8000) score += 6;
      else if (m.avgLatencyMs < 20000) score += 3;
      else score += 1;
    } else {
      score += 5; // unknown — assume average
    }

    // Provider preference bonus (0–5)
    if (preferProvider && m.provider === preferProvider) score += 5;

    // ── v0.5.7: Provider reputation score (0–10) ──
    // Known reliable providers get bonus over experimental/random ones.
    // This prevents ollama-cloud experimental models from outscoring
    // openrouter's known-good models when all static providers are down.
    const PROVIDER_REPUTATION: Record<string, number> = {
      // 'openrouter': 10,   // Removed per user request
      'bailian':    8,    // Alibaba official, but currently key-expired
      'zai':        7,    // Z.AI official GLM models
      'opencodego': 6,    // OpenCode multi-model gateway
      'claude-cli': 9,    // Anthropic official CLI
      'codex-cli':  9,    // OpenAI official CLI
      'ollama-cloud': 3,  // Hosted but models are experimental/unvetted
      'ollama':     2,    // Local only, tiny models
      'pi-agent':   5,    // Local Pi agent
      'hermes-agent': 5,  // Local Hermes agent
      'openclaw-agent': 5,
    };
    score += PROVIDER_REPUTATION[m.provider] || 3;

    // Track record bonus: models with more successful requests score higher (up to +5)
    if (m.totalRequests > 0) {
      const successRate = 1 - (m.errorCount / m.totalRequests);
      score += Math.min(5, Math.round(successRate * 5));
    }

    return score;
  }

  private determineReason(model: ModelEntry, preferProvider?: string): DecisionReason {
    if (preferProvider && model.provider === preferProvider) return 'provider_preferred';
    if (model.costPer1kInput === 0 && model.costPer1kOutput === 0) return 'cheapest_available';
    if (model.avgLatencyMs > 0 && model.avgLatencyMs < 3000) return 'fastest_available';
    return 'consumption_balanced';
  }

  private tierRank(tier: EffortLevel): number {
    const ranks: Record<EffortLevel, number> = {
      trivial: 0, light: 1, moderate: 2, heavy: 3, intensive: 4, extreme: 5,
    };
    return ranks[tier];
  }

  // ─── Consumption Stats ────────────────────────────────

  getStats(): ConsumptionStats {
    const matrixStats = modelMatrix.getConsumptionStats();
    return {
      ...matrixStats,
      estimatedTotalCost: matrixStats.estimatedCost,
      tierDistribution: modelMatrix.getTierDistribution(),
      modelCount: matrixStats.totalModels,
      availableModels: matrixStats.availableModels,
    };
  }

  getRecentDecisions(limit = 20, source?: 'request' | 'health-check' | 'balance-check' | 'recovery-check'): ConsumptionDecision[] {
    const all = this.decisions.slice().reverse();
    if (!source) return all.slice(0, limit);
    return all.filter(d => (d.source || 'request') === source).slice(0, limit);
  }

  async getTierRecommendations(): Promise<Record<EffortLevel, ConsumptionDecision>> {
    const recs: Partial<Record<EffortLevel, ConsumptionDecision>> = {};
    const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    for (const tier of tiers) {
      try {
        // v0.5.6: mark as health-check so it doesn't pollute the ActivityPanel
        recs[tier] = await this.selectModel(tier, { source: 'health-check' });
      } catch { /* skip */ }
    }
    return recs as Record<EffortLevel, ConsumptionDecision>;
  }

  // ─── v0.5.5: Self-Healing Tier Rebalancing ─────────────────
  // When the default provider/model for a tier becomes unavailable (exhausted,
  // throttled, or returning 429s), swap to the next best available option.
  // The swap is persisted to v04_config.json so it survives restarts.
  // When the original provider recovers, restore the preferred default.

  private tierSwaps: Map<EffortLevel, {
    originalProvider: string;
    originalModel: string;
    swapProvider: string;
    swapModel: string;
    swappedAt: number;
    reason: string;
  }> = new Map();

  /**
   * Check if a tier's default provider is exhausted and needs rebalancing.
   * Called after every request that hit a 429 or quota exhaustion.
   */
  recordFallbackOutcome(tier: EffortLevel, triedProvider: string, triedModel: string, success: boolean, errorType?: string): void {
    if (success) return; // Successes don't trigger rebalancing

    // If the tried provider is the tier's default AND it failed with a quota error,
    // trigger a rebalance.
    const cfg = getConfig();
    const tierCfg = cfg.tier_models[tier];
    if (!tierCfg) return;

    const isDefault = tierCfg.provider === triedProvider && tierCfg.model === triedModel;
    const isQuotaError = errorType === 'rate-limited' || errorType === '429' || errorType === 'quota_exhausted';

    if (isDefault && isQuotaError) {
      console.log(`🔄 [Intel] ${tier} default ${triedProvider}/${triedModel} failed (${errorType}) — rebalancing...`);
      this.rebalanceTier(tier, triedProvider, triedModel, errorType || 'unknown');
    }
  }

  /**
   * Swap a tier's default provider/model to the next best available option.
   * Persists the change to v04_config.json.
   */
  private async rebalanceTier(tier: EffortLevel, failedProvider: string, failedModel: string, reason: string): Promise<void> {
    const cfg = getConfig();
    const tierCfg = cfg.tier_models[tier];
    if (!tierCfg) return;

    // Don't rebalance if already swapped (avoid loops)
    const existingSwap = this.tierSwaps.get(tier);
    if (existingSwap && existingSwap.swapProvider === failedProvider) return;

    // Find the best available model for this tier (excluding the failed one)
    let newDecision: ConsumptionDecision;
    try {
      newDecision = await this.selectModel(tier, {
        excludeProviders: [failedProvider],
        estimatedPromptTokens: 500,
        source: 'recovery-check',
      });
    } catch {
      // No candidates at all — try one tier below
      const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
      const idx = tiers.indexOf(tier);
      for (let i = idx - 1; i >= 0; i--) {
        try {
          newDecision = await this.selectModel(tiers[i], { estimatedPromptTokens: 500, source: 'recovery-check' });
          console.log(`🔄 [Intel] ${tier}: no candidates — using ${tiers[i]}-tier model: ${newDecision.provider}/${newDecision.model}`);
          break;
        } catch { continue; }
      }
      return; // If we get here, nothing worked
    }

    // Record the swap
    if (!existingSwap) {
      this.tierSwaps.set(tier, {
        originalProvider: tierCfg.provider,
        originalModel: tierCfg.model,
        swapProvider: newDecision.provider,
        swapModel: newDecision.model,
        swappedAt: Date.now(),
        reason,
      });
    } else {
      existingSwap.swapProvider = newDecision.provider;
      existingSwap.swapModel = newDecision.model;
      existingSwap.swappedAt = Date.now();
      existingSwap.reason = reason;
    }

    // Persist to v04_config.json
    tierCfg.provider = newDecision.provider;
    tierCfg.model = newDecision.model;

    // Also update fallbacks — put the failed provider at the end
    if (tierCfg.fallback_models) {
      tierCfg.fallback_models = tierCfg.fallback_models.filter(
        f => !(f.provider === failedProvider && f.model === failedModel)
      );
      tierCfg.fallback_models.push({ provider: failedProvider, model: failedModel });
    }

    try {
      await saveConfig(cfg);
      console.log(`✅ [Intel] ${tier} rebalanced: ${failedProvider}/${failedModel} → ${newDecision.provider}/${newDecision.model}`);
    } catch (err) {
      console.error(`❌ [Intel] Failed to persist tier rebalance:`, (err as Error).message);
    }
  }

  /**
   * Check if any swapped providers have recovered and should be restored.
   * Called periodically (e.g., every 5 minutes).
   */
  async checkRecovery(): Promise<void> {
    for (const [tier, swap] of this.tierSwaps) {
      // Only check recovery if the swap is at least 5 minutes old
      if (Date.now() - swap.swappedAt < 300000) continue;

      const pq = providerQuota.getQuota(swap.originalProvider);
      if (!pq) continue;

      // Recover if: not throttled AND health > 80
      if ((!pq.throttled || pq.throttledUntil <= Date.now()) && pq.healthScore > 80) {
        console.log(`🔄 [Intel] ${tier}: ${swap.originalProvider} recovered (health=${pq.healthScore}) — restoring default`);
        const cfg = getConfig();
        const tierCfg = cfg.tier_models[tier];
        if (tierCfg) {
          tierCfg.provider = swap.originalProvider;
          tierCfg.model = swap.originalModel;
          // Remove the swapped provider from fallbacks, put original back as default
          if (tierCfg.fallback_models) {
            tierCfg.fallback_models = tierCfg.fallback_models.filter(
              f => !(f.provider === swap.swapProvider && f.model === swap.swapModel)
            );
            // Put the swap target in fallbacks (in case it fails again)
            tierCfg.fallback_models.unshift({ provider: swap.swapProvider, model: swap.swapModel });
          }
          try {
            await saveConfig(cfg);
            this.tierSwaps.delete(tier);
            console.log(`✅ [Intel] ${tier} restored to ${swap.originalProvider}/${swap.originalModel}`);
          } catch (err) {
            console.error(`❌ [Intel] Failed to persist recovery:`, (err as Error).message);
          }
        }
      }
    }
  }

  /**
   * Get current tier swap state (for observability).
   */
  getTierSwaps(): Array<{ tier: EffortLevel; original: string; current: string; swappedAt: string; reason: string }> {
    const result: Array<{ tier: EffortLevel; original: string; current: string; swappedAt: string; reason: string }> = [];
    for (const [tier, swap] of this.tierSwaps) {
      result.push({
        tier,
        original: `${swap.originalProvider}/${swap.originalModel}`,
        current: `${swap.swapProvider}/${swap.swapModel}`,
        swappedAt: new Date(swap.swappedAt).toISOString(),
        reason: swap.reason,
      });
    }
    return result;
  }
}

export const consumptionIntelligence = new ConsumptionIntelligence();
