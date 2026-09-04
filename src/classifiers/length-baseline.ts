/**
 * The trivial baseline: rank prompts by raw length, nothing else.
 *
 * This exists to be beaten. Measured on the golden set it reaches 85.6% exact
 * tier accuracy against the 35-feature scorer's 63.3%, because
 * `eval/dataset.json` is length-separated by construction — only 1 of 15 tier
 * pairs has overlapping interquartile character ranges. Every accuracy figure
 * this project has published was measured on a benchmark a one-liner scores
 * 85.6% on, and nothing in the eval said so.
 *
 * So this is a guard, not a candidate: **any model that cannot beat this row is
 * not paying for its complexity**, and any dataset on which this row wins
 * decisively is a dataset that cannot tell complexity from verbosity.
 *
 * It plays by the same rules as every other entry — cut points fitted on the
 * training folds only, confidence calibrated out-of-fold — so the comparison is
 * fair rather than rigged in the baseline's favour.
 *
 * Note on the transform: `fitMonotonicCutPoints` fits arbitrary cut points over
 * the score, and log is monotone, so LOG_CAP cannot change a single tier
 * prediction. It only keeps the score inside [0,1] for display and calibration.
 * Ranking by characters and ranking by words are genuinely different orderings,
 * though — a prompt of long words has more characters but fewer words — and
 * characters is the stronger baseline (85.6% vs 70.0%), so characters is what
 * this guard uses.
 */
import type { TierClassifier, TierPrediction, LabeledPrompt } from './types.js';
import type { EffortLevel } from '../types.js';
import { confidenceForTier } from 'gateswarm-lite';
import {
  DEFAULT_HEURISTIC_BOUNDARIES,
  fitMonotonicCutPoints,
  fitReliabilityOutOfFold,
  scoreToTier,
} from './heuristic-linear.js';

/** Only scales the score into [0,1]; monotone, so tier predictions are unaffected. */
const LOG_CAP = 250;

export function lengthScore(prompt: string): number {
  return Math.min(Math.log1p(prompt.length) / Math.log1p(LOG_CAP), 1);
}

export class LengthBaselineClassifier implements TierClassifier {
  id = 'length-only';
  kind = 'rule' as const;
  version = 'v1-chars';
  requiresTraining = true; // fits cut points, exactly like the models it guards
  private boundaries = [...DEFAULT_HEURISTIC_BOUNDARIES];
  private reliability: Partial<Record<EffortLevel, number>> = {};

  fit(train: LabeledPrompt[]): void {
    const pairs = train
      .filter((t) => t.tier)
      .map((t) => ({ score: lengthScore(t.prompt), tier: t.tier! }));
    this.boundaries = fitMonotonicCutPoints(pairs);
    this.reliability = fitReliabilityOutOfFold(pairs);
  }

  predictEffort(prompt: string): TierPrediction {
    const start = performance.now();
    const score = lengthScore(prompt);
    const tier = scoreToTier(score, this.boundaries);
    return {
      tier,
      score,
      confidence: this.reliability[tier] ?? confidenceForTier(tier),
      latencyMs: performance.now() - start,
    };
  }

  // No predictMode: length cannot distinguish planning from acting, and
  // pretending otherwise would put a fake number in the mode column.
}
