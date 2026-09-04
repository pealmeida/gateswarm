/**
 * Calibrated routing confidence.
 *
 * The previous confidence was derived from distance to the nearest tier
 * boundary: ~0.06 margin → 0.95, at the boundary → 0.5. Measured out-of-fold on
 * the golden set, that mapping is not merely miscalibrated, it is inverted —
 * accuracy at near-zero margin is 75% while accuracy in the widest margin band
 * is 42%. Boundary distance carries no information about whether the tier is
 * right, so asserting 0.95 there produced ECE 0.205.
 *
 * What does predict correctness is the predicted tier itself: the scorer is
 * reliable on `trivial`/`light` and close to a coin flip on `heavy`/`intensive`.
 * Confidence is therefore P(correct | predicted tier), estimated out-of-fold and
 * Laplace-smoothed toward the overall accuracy prior so a thin tier cannot claim
 * certainty. That reaches ECE 0.093, inside the ≤0.10 calibration gate, and stays
 * informative — unlike a constant, which is trivially calibrated and useless.
 *
 * Like tier boundaries, the table is data and hot-reloadable: refit it from real
 * verdicts and install it with setTierReliability().
 */
import type { EffortLevel } from './types.js';

export type TierReliability = Record<EffortLevel, number>;

const TIERS: readonly EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

/**
 * Fitted on eval/dataset.json with 5-fold out-of-fold prediction (boundaries fit
 * on train folds only), K=6 pseudo-counts toward the 0.6333 accuracy prior.
 * Regenerate whenever the scorer or DEFAULT_BOUNDARIES change on purpose.
 */
export const DEFAULT_TIER_RELIABILITY: TierReliability = {
  trivial: 0.7520,
  light: 0.7867,
  moderate: 0.6167,
  heavy: 0.5500,
  intensive: 0.4909,
  extreme: 0.6167,
};

let _reliability: TierReliability = { ...DEFAULT_TIER_RELIABILITY };

export function getTierReliability(): TierReliability {
  return { ..._reliability };
}

/** Install a refitted table. Values must be finite probabilities in (0,1]. */
export function setTierReliability(next: Partial<TierReliability>): void {
  const merged = { ..._reliability, ...next };
  for (const tier of TIERS) {
    const v = merged[tier];
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      throw new Error(`invalid reliability for "${tier}": ${String(v)} (expected a probability in (0,1])`);
    }
  }
  _reliability = merged;
}

export function resetTierReliability(): void {
  _reliability = { ...DEFAULT_TIER_RELIABILITY };
}

/** Calibrated confidence that `tier` is the correct label for this prompt. */
export function confidenceForTier(tier: EffortLevel): number {
  return _reliability[tier] ?? DEFAULT_TIER_RELIABILITY.moderate;
}

/**
 * Refit the table from observed (predicted tier, was-correct) outcomes.
 *
 * Callers MUST pass out-of-fold or genuinely held-out observations: fitting on
 * the same predictions used to choose the boundaries reports training accuracy
 * and yields an overconfident table. `prior` defaults to the pooled accuracy.
 */
export function fitTierReliability(
  observations: readonly { tier: EffortLevel; correct: boolean }[],
  options: { pseudoCounts?: number; prior?: number } = {},
): TierReliability {
  const K = options.pseudoCounts ?? 6;
  const usable = observations.filter((o) => TIERS.includes(o.tier));
  if (!usable.length) return { ...DEFAULT_TIER_RELIABILITY };
  const prior = options.prior ?? usable.filter((o) => o.correct).length / usable.length;

  const out = {} as TierReliability;
  for (const tier of TIERS) {
    const rows = usable.filter((o) => o.tier === tier);
    const hits = rows.filter((o) => o.correct).length;
    // Clamped away from 0 and 1: no finite sample justifies certainty either way.
    out[tier] = Math.min(0.99, Math.max(0.01, (hits + K * prior) / (rows.length + K)));
  }
  return out;
}
