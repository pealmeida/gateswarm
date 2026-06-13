/**
 * GateSwarm MoMA Router — Retraining Pipeline (v0.5.2 rewrite)
 *
 * The previous pipeline tried to grid-search ENSEMBLE WEIGHTS, but:
 *   - simulateAccuracy() ignored the candidate weights entirely (it just counted
 *     predicted===actual), so the search was a no-op that returned the first
 *     candidate after a stable sort;
 *   - the feedback store never persisted the prompt or component scores, so
 *     re-running the ensemble under different weights was impossible; and
 *   - cascade is permanently disabled, so perturbing its weight only corrupted
 *     the saved config.
 *
 * What we CAN learn from real feedback is the right place to put the TIER
 * BOUNDARIES: each judged interaction gives us (routing score, LLM-judged
 * actual tier). Recalibrating the 5 cut points against those pairs is a genuine,
 * data-driven self-improvement — exactly the manual calibration in eval/, run
 * continuously. Boundaries are config-driven (see v04-config.syncTierBoundaries),
 * so an update takes effect live.
 */

import type { EffortLevel } from './types.js';
import { getConfig, saveConfig, type EnsembleWeightsConfig } from './v04-config.js';
import { getFeedbackEntries } from './feedback-store.js';
import { setTierBoundaries, getTierBoundaries } from './intent-engine.js';

const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

// ─── Weights (kept for API compatibility; weights are no longer the train target) ──

let _activeWeights: EnsembleWeightsConfig | null = null;

export function getActiveWeights(): EnsembleWeightsConfig {
  if (_activeWeights) return _activeWeights;
  return getConfig().ensemble.weights;
}

export function setWeights(weights: EnsembleWeightsConfig): void {
  _activeWeights = weights;
}

// ─── Boundary optimisation ────────────────────────────────────────

interface LabeledScore { score: number; tier: number; }

/** Exact tier accuracy of a boundary set against labeled (score → tier) pairs. */
function accuracyFor(bounds: number[], data: LabeledScore[]): number {
  if (data.length === 0) return 0;
  let correct = 0;
  for (const { score, tier } of data) {
    let pred = 0;
    while (pred < bounds.length && score >= bounds[pred]) pred++;
    if (pred === tier) correct++;
  }
  return correct / data.length;
}

/**
 * Grid-search 5 strictly-increasing cut points maximising exact accuracy.
 * Coarse grid (0.01 step) — fast and enough given score granularity.
 */
function optimizeBoundaries(data: LabeledScore[]): { bounds: number[]; accuracy: number } {
  const grid: number[] = [];
  for (let v = 0.08; v <= 0.7; v += 0.01) grid.push(Number(v.toFixed(3)));
  let best = { bounds: getTierBoundaries(), accuracy: accuracyFor(getTierBoundaries(), data) };
  for (const b0 of grid.filter(v => v < 0.3))
    for (const b1 of grid.filter(v => v > b0 && v < 0.4))
      for (const b2 of grid.filter(v => v > b1 && v < 0.5))
        for (const b3 of grid.filter(v => v > b2 && v < 0.6))
          for (const b4 of grid.filter(v => v > b3 && v < 0.7)) {
            const acc = accuracyFor([b0, b1, b2, b3, b4], data);
            if (acc > best.accuracy) best = { bounds: [b0, b1, b2, b3, b4], accuracy: acc };
          }
  return best;
}

// ─── Retraining trigger ───────────────────────────────────────────

export interface RetrainResult {
  retrained: boolean;
  reason?: string;
  accuracyBefore?: number;
  accuracyAfter?: number;
  boundaries?: number[];
}

/**
 * Recalibrate tier boundaries if there is enough judged feedback with scores.
 * Only applies the new boundaries when they beat the current ones by a margin
 * (guards against noise / overfitting to a small sample).
 */
export async function retrainIfNeeded(): Promise<RetrainResult> {
  const config = getConfig();
  const minSamples = config.feedback_loop.minSamplesPerTier;

  // Need judged entries that carry BOTH a routing score and an actual tier.
  const data: LabeledScore[] = getFeedbackEntries()
    .filter(e => e.actualTier !== null && typeof e.score === 'number')
    .map(e => ({ score: e.score as number, tier: TIERS.indexOf(e.actualTier as EffortLevel) }))
    .filter(d => d.tier >= 0);

  // Require a reasonable global sample before touching boundaries.
  if (data.length < Math.max(30, minSamples * 3)) {
    return { retrained: false, reason: `insufficient labeled+scored feedback (${data.length})` };
  }

  const current = getTierBoundaries();
  const accuracyBefore = accuracyFor(current, data);
  const best = optimizeBoundaries(data);

  // Apply only on a meaningful improvement (≥2 percentage points).
  if (best.accuracy < accuracyBefore + 0.02) {
    return { retrained: false, reason: 'no significant improvement', accuracyBefore, accuracyAfter: best.accuracy };
  }

  if (!setTierBoundaries(best.bounds)) {
    return { retrained: false, reason: 'optimizer produced invalid boundaries' };
  }

  // Persist to config so it survives restarts and stays the canonical source.
  const cfg = getConfig();
  cfg.tier_boundaries = {
    trivial:   [0, best.bounds[0]],
    light:     [best.bounds[0], best.bounds[1]],
    moderate:  [best.bounds[1], best.bounds[2]],
    heavy:     [best.bounds[2], best.bounds[3]],
    intensive: [best.bounds[3], best.bounds[4]],
    extreme:   [best.bounds[4], 1],
  };
  await saveConfig(cfg);

  return {
    retrained: true,
    reason: `recalibrated boundaries on ${data.length} labeled samples`,
    accuracyBefore,
    accuracyAfter: best.accuracy,
    boundaries: best.bounds,
  };
}
