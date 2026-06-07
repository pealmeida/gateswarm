/**
 * Baseline classifier: the current hand-weighted linear scorer
 * (heuristicScoreFromFeatures) wrapped behind the TierClassifier contract.
 *
 * Key honesty fix vs the old eval: boundaries are fit on the TRAIN split only
 * (fit()), then applied to test — no leak. With no training data it falls back
 * to the canonical v0.5.2 boundaries so it still runs zero-shot.
 *
 * Mode prediction delegates to the existing detectIntentMode().
 */
import type { TierClassifier, TierPrediction, ModePrediction, LabeledPrompt } from './types.js';
import type { EffortLevel } from '../types.js';
import { extractFeatures, heuristicScoreFromFeatures, type FeatureVector } from '../feature-extractor-v04.js';
import { detectIntentMode } from '../v04-config.js';

const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
const DEFAULT_BOUNDARIES = [0.21, 0.28, 0.32, 0.37, 0.46];

export function scoreToTier(score: number, b: number[]): EffortLevel {
  let i = 0;
  while (i < b.length && score >= b[i]) i++;
  return TIERS[i];
}

function rawScore(prompt: string): number {
  const f: FeatureVector = extractFeatures(prompt);
  const wc = prompt.split(/\s+/).filter(Boolean).length;
  return heuristicScoreFromFeatures(f, wc);
}

/**
 * Grid-search 5 monotonic cut-points maximizing exact accuracy on labeled
 * (score, tier) pairs. Mirrors retraining.optimizeBoundaries but local to the
 * fold so the eval stays leak-free.
 */
function fitBoundaries(pairs: { score: number; tier: EffortLevel }[]): number[] {
  if (pairs.length < 12) return DEFAULT_BOUNDARIES;
  const tierIdx = (t: EffortLevel) => TIERS.indexOf(t);
  const grid: number[] = [];
  for (let v = 0.05; v <= 0.9; v += 0.01) grid.push(Number(v.toFixed(2)));
  let best = DEFAULT_BOUNDARIES, bestAcc = -1;
  // Coordinate ascent from defaults (full 5-D grid is too large; this is enough
  // for a baseline and keeps runtime sane).
  let cur = DEFAULT_BOUNDARIES.slice();
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 0; k < 5; k++) {
      for (const v of grid) {
        const cand = cur.slice(); cand[k] = v;
        if (cand.some((x, i) => i > 0 && x <= cand[i - 1])) continue; // keep monotonic
        let acc = 0;
        for (const p of pairs) if (scoreToTier(p.score, cand) === p.tier) acc++;
        acc /= pairs.length;
        if (acc > bestAcc) { bestAcc = acc; best = cand.slice(); }
      }
      cur = best.slice();
    }
  }
  return best;
}

export class HeuristicLinearClassifier implements TierClassifier {
  id = 'heuristic-linear';
  kind = 'rule' as const;
  version = 'v0.5.2';
  requiresTraining = true; // fits boundaries; still runs without (defaults)
  private boundaries = DEFAULT_BOUNDARIES;

  fit(train: LabeledPrompt[]): void {
    const pairs = train
      .filter((t) => t.tier)
      .map((t) => ({ score: rawScore(t.prompt), tier: t.tier! }));
    this.boundaries = fitBoundaries(pairs);
  }

  predictEffort(prompt: string): TierPrediction {
    const start = performance.now();
    const score = rawScore(prompt);
    const tier = scoreToTier(score, this.boundaries);
    // Confidence from distance to nearest boundary (matches ensemble-voter logic).
    let d = Math.min(score, 1 - score);
    for (const b of this.boundaries) d = Math.min(d, Math.abs(score - b));
    const confidence = Math.max(0.5, Math.min(0.95, 0.5 + (d / 0.06) * 0.45));
    return { tier, score, confidence, latencyMs: performance.now() - start };
  }

  predictMode(prompt: string): ModePrediction {
    const start = performance.now();
    const r = detectIntentMode(prompt);
    return { mode: r.mode, confidence: r.confidence, latencyMs: performance.now() - start };
  }
}
