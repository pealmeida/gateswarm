/**
 * Quota-band-aware tier config resolution for gateway paths that previously
 * read only static v04_config.json. When GATESWARM_QUOTA_BAND_MATRIX is OFF,
 * callers must keep using static cfg directly (byte-identical responses).
 */

import type { EffortLevel, IntentMode } from './types.js';
import type { TierModelConfig } from './v04-config.js';
import { getConfig, getTierModelForMode } from './v04-config.js';
import { isQuotaBandMatrixEnabled } from './quota-band-matrix.js';
import { consumptionIntelligence } from './consumption-intelligence.js';

/** Same plan/act shaping as getTierModelForMode, but on an arbitrary tier row. */
export function tierModelForMode(tier: TierModelConfig, mode: IntentMode): TierModelConfig {
  if (mode === 'plan' && tier.plan_model) {
    return {
      model: tier.plan_model,
      provider: tier.plan_provider ?? tier.provider,
      max_tokens: tier.plan_max_tokens ?? tier.max_tokens,
      enable_thinking: tier.plan_enable_thinking ?? false,
      fallback_models: tier.fallback_models,
    };
  }
  return tier;
}

/**
 * Effective tier row for routing when the quota-band flag is ON; null when OFF
 * (caller should use static cfg.tier_models).
 */
export async function getRoutingTierModel(tier: EffortLevel): Promise<TierModelConfig | null> {
  if (!isQuotaBandMatrixEnabled()) {
    return null;
  }
  await consumptionIntelligence.ensureQuotaBandSelection();
  return consumptionIntelligence.getEffectiveTierConfig(tier);
}

export interface ResolvedTierForMode {
  resolved: TierModelConfig | null;
  /** Populated when flag ON — static v04_config model for transparency (CPO). */
  staticResolved: TierModelConfig | null;
}

export async function resolveTierModelForMode(
  tier: EffortLevel,
  mode: IntentMode,
): Promise<ResolvedTierForMode> {
  const staticResolved = getTierModelForMode(tier, mode);
  if (!isQuotaBandMatrixEnabled()) {
    return { resolved: staticResolved, staticResolved: null };
  }
  const effective = await getRoutingTierModel(tier);
  if (!effective) {
    return { resolved: staticResolved, staticResolved };
  }
  return {
    resolved: tierModelForMode(effective, mode),
    staticResolved,
  };
}

/** Fallback list for a tier: static cfg when flag OFF, effective row when ON. */
export function fallbackModelsForTier(
  tier: EffortLevel,
  staticTierModels: Record<EffortLevel, TierModelConfig>,
  effectiveTier: TierModelConfig | null | undefined,
): Array<{ model: string; provider: string }> {
  if (!isQuotaBandMatrixEnabled()) {
    return staticTierModels[tier]?.fallback_models ?? [];
  }
  return effectiveTier?.fallback_models ?? staticTierModels[tier]?.fallback_models ?? [];
}

/** All provider/model pairs allowed in-band for fallback validation. */
export function allowedModelsInTierRow(tier: TierModelConfig): Set<string> {
  const allowed = new Set<string>();
  const add = (provider: string, model: string) => allowed.add(`${provider}/${model}`);
  add(tier.provider, tier.model);
  if (tier.plan_model) {
    add(tier.plan_provider ?? tier.provider, tier.plan_model);
  }
  for (const fb of tier.fallback_models ?? []) {
    add(fb.provider, fb.model);
  }
  return allowed;
}

/** Static baseline row (never band matrix). */
export function getStaticTierModel(tier: EffortLevel): TierModelConfig | null {
  return getConfig().tier_models[tier] ?? null;
}
