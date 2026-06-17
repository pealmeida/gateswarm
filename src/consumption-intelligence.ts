/**
 * Token Consumption Intelligence v0.5.4
 *
 * Decision engine that selects the optimal model/provider for
 * each routing tier based on:
 *  - Model availability and health (from Model Matrix)
 *  - Token consumption history and cost efficiency
 *  - Provider rate limits and latency
 *  - Complexity tier requirements
 *
 * Replaces the static tier config with dynamic, consumption-aware routing.
 */

import { modelMatrix, ModelEntry, EffortLevel, ProviderSummary } from './model-matrix.js';
import { agentRegistry } from './agent-registry.js';
import { getConfig } from './v04-config.js';
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
  trivial:    { minContextWindow: 8000,   minMaxTokens: 256,   needsReasoning: false, needsVision: false, needsTools: false, maxLatencyMs: 5000,  maxCostPer1kInput: Infinity },
  light:      { minContextWindow: 32000,  minMaxTokens: 2048,  needsReasoning: false, needsVision: false, needsTools: false, maxLatencyMs: 8000,  maxCostPer1kInput: Infinity },
  moderate:   { minContextWindow: 64000,  minMaxTokens: 4096,  needsReasoning: true,  needsVision: false, needsTools: true,  maxLatencyMs: 15000, maxCostPer1kInput: Infinity },
  heavy:      { minContextWindow: 128000, minMaxTokens: 8192,  needsReasoning: true,  needsVision: false, needsTools: true,  maxLatencyMs: 30000, maxCostPer1kInput: Infinity },
  intensive:  { minContextWindow: 200000, minMaxTokens: 16384, needsReasoning: true,  needsVision: false, needsTools: true,  maxLatencyMs: 60000, maxCostPer1kInput: Infinity },
  extreme:    { minContextWindow: 500000, minMaxTokens: 32768, needsReasoning: true,  needsVision: false, needsTools: true,  maxLatencyMs: 90000, maxCostPer1kInput: Infinity },
};

// ─── Consumption Intelligence Engine ─────────────────────

class ConsumptionIntelligence {
  private decisions: ConsumptionDecision[] = [];
  private readonly maxDecisionHistory = 100;

  /**
   * Select the best model for a given complexity tier.
   * Uses multi-factor scoring: capability match (40%) + cost efficiency (30%)
   * + health/availability (20%) + latency (10%).
   */
  selectModel(tier: EffortLevel, options?: {
    preferProvider?: string;
    excludeProviders?: string[];
    estimatedPromptTokens?: number;
  }): ConsumptionDecision {
    const reqs = TIER_REQUIREMENTS[tier];
    const allModels = modelMatrix.getAvailableModels();

    // Filter by tier capability
    const candidates = allModels.filter(m => {
      // Skip providers without API keys (unless explicitly preferred)
      const providerConfig = agentRegistry.getProvider(m.provider);
      if (!providerConfig) return false;
      const isConfigured = agentRegistry.getProviderBaseUrl(m.provider) && agentRegistry.getProviderApiKey(m.provider);
      if (!isConfigured && m.provider !== options?.preferProvider) {
        // Allow ollama (local) and ollama-cloud even without key check
        if (!['ollama', 'ollama-cloud'].includes(m.provider)) return false;
      }
      // ── Tier matching: use model-matrix tier classification ──
      const tierIdx = this.tierRank(tier);
      const modelTierIdx = this.tierRank(m.recommendedTier);

      // Accept models from target tier, one above, or one below (emergency fallback)
      // v0.5.5: allow tierIdx-1 so we can use lower-tier models from different
      // providers when all same-tier providers are rate-limited
      if (modelTierIdx !== tierIdx && modelTierIdx !== tierIdx + 1 && modelTierIdx !== tierIdx - 1) return false;

      // Reject models that are WAY too large for trivial/light (wasteful)
      if (tierIdx <= 1 && modelTierIdx >= 3) return false;
      // Filter excluded providers
      if (options?.excludeProviders?.includes(m.provider)) return false;
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
      // Fallback: use static config from v04_config.json
      const staticCfg = getConfig().tier_models[tier];
      if (staticCfg) {
        console.log(`🧠 [Intel] ${tier}: no candidates — falling back to static config: ${staticCfg.provider}/${staticCfg.model}`);
        return {
          provider: staticCfg.provider,
          model: staticCfg.model,
          tier,
          reason: 'static_fallback',
          estimatedTokens: options?.estimatedPromptTokens || 500,
          estimatedCost: 0,
          confidence: 0.3,
          alternatives: [],
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
    };

    // Record decision
    this.decisions.push(decision);
    if (this.decisions.length > this.maxDecisionHistory) {
      this.decisions.shift();
    }

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
  getFallback(tier: EffortLevel, failedProvider: string, failedModel: string): ConsumptionDecision | null {
    const excludeProviders = new Set([failedProvider]);

    // Try same tier excluding failed provider
    try {
      return this.selectModel(tier, { excludeProviders: [...excludeProviders] });
    } catch {
      // Fall back to next tier up
      const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
      const idx = tiers.indexOf(tier);
      for (let i = idx + 1; i < tiers.length; i++) {
        try {
          return this.selectModel(tiers[i], { excludeProviders: [...excludeProviders] });
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

  getRecentDecisions(limit = 20): ConsumptionDecision[] {
    return this.decisions.slice(-limit).reverse();
  }

  getTierRecommendations(): Record<EffortLevel, ConsumptionDecision> {
    const recs: Partial<Record<EffortLevel, ConsumptionDecision>> = {};
    const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    for (const tier of tiers) {
      try {
        recs[tier] = this.selectModel(tier);
      } catch { /* skip */ }
    }
    return recs as Record<EffortLevel, ConsumptionDecision>;
  }
}

export const consumptionIntelligence = new ConsumptionIntelligence();
