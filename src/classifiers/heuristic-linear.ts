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
import { DEFAULT_BOUNDARIES } from '../tier-boundaries.js';
import { confidenceForTier, fitTierReliability } from 'gateswarm-lite';
import { detectIntentMode } from '../v04-config.js';

export const HEURISTIC_TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
export const DEFAULT_HEURISTIC_BOUNDARIES = [...DEFAULT_BOUNDARIES];

export interface ScoredTier {
  score: number;
  tier: EffortLevel;
}

export function scoreToTier(score: number, b: number[]): EffortLevel {
  let i = 0;
  while (i < b.length && score >= b[i]) i++;
  return HEURISTIC_TIERS[i];
}

/**
 * Estimate P(correct | predicted tier) from the training pairs WITHOUT leaking:
 * cut points are refit on inner train folds and reliability is tallied only on
 * the held-out inner fold. Fitting on in-sample predictions would report
 * training accuracy and ship an overconfident table.
 */
export function fitReliabilityOutOfFold(pairs: ScoredTier[], k = 4): Partial<Record<EffortLevel, number>> {
  if (pairs.length < k * 2) return {};
  const folds: number[][] = Array.from({ length: k }, () => []);
  pairs.forEach((_, i) => folds[i % k].push(i));
  const observations: { tier: EffortLevel; correct: boolean }[] = [];
  for (let f = 0; f < k; f++) {
    const held = new Set(folds[f]);
    const cuts = fitMonotonicCutPoints(pairs.filter((_, i) => !held.has(i)));
    for (const i of folds[f]) {
      const predicted = scoreToTier(pairs[i].score, cuts);
      observations.push({ tier: predicted, correct: predicted === pairs[i].tier });
    }
  }
  return fitTierReliability(observations);
}

export function rawHeuristicScore(prompt: string): number {
  const f: FeatureVector = extractFeatures(prompt);
  const wc = prompt.split(/\s+/).filter(Boolean).length;
  return heuristicScoreFromFeatures(f, wc);
}

/**
 * Grid-search 5 monotonic cut-points maximizing exact accuracy on labeled
 * (score, tier) pairs. This is exact over sorted score gaps, with empty bands
 * allowed, so ties at the same score cannot be split by impossible cut points.
 */
export function fitMonotonicCutPoints(pairs: ScoredTier[]): number[] {
  const clean = pairs.filter((p) =>
    Number.isFinite(p.score) && HEURISTIC_TIERS.includes(p.tier),
  );
  if (!clean.length) return [...DEFAULT_HEURISTIC_BOUNDARIES];

  const tierIdx = (t: EffortLevel) => HEURISTIC_TIERS.indexOf(t);
  const uniqueScores = [...new Set(clean.map((p) => p.score))].sort((a, b) => a - b);
  const scoreIndex = new Map(uniqueScores.map((score, i) => [score, i]));
  const groupCounts = uniqueScores.map(() => Array(HEURISTIC_TIERS.length).fill(0) as number[]);
  for (const p of clean) groupCounts[scoreIndex.get(p.score)!][tierIdx(p.tier)]++;

  const g = uniqueScores.length;
  const prefix = Array.from({ length: HEURISTIC_TIERS.length }, () => Array(g + 1).fill(0) as number[]);
  for (let i = 0; i < g; i++) {
    for (let t = 0; t < HEURISTIC_TIERS.length; t++) {
      prefix[t][i + 1] = prefix[t][i] + groupCounts[i][t];
    }
  }
  const correctIn = (from: number, to: number, tier: number) => prefix[tier][to] - prefix[tier][from];

  const representativeCut = (pos: number): number => {
    if (pos <= 0) return uniqueScores[0] / 2;
    if (pos >= g) return (uniqueScores[g - 1] + 1) / 2;
    return (uniqueScores[pos - 1] + uniqueScores[pos]) / 2;
  };

  interface Cell {
    correct: number;
    penalty: number;
    prev: number;
  }

  const better = (a: Cell | null, b: Cell): Cell =>
    !a || b.correct > a.correct || (b.correct === a.correct && b.penalty < a.penalty) ? b : a;

  const dp: Array<Array<Cell | null>> = Array.from({ length: 5 }, () => Array(g + 1).fill(null));
  for (let pos = 0; pos <= g; pos++) {
    dp[0][pos] = {
      correct: correctIn(0, pos, 0),
      penalty: Math.abs(representativeCut(pos) - DEFAULT_HEURISTIC_BOUNDARIES[0]),
      prev: -1,
    };
  }

  for (let boundary = 1; boundary < 5; boundary++) {
    for (let pos = 0; pos <= g; pos++) {
      let best: Cell | null = null;
      for (let prev = 0; prev <= pos; prev++) {
        const prior = dp[boundary - 1][prev];
        if (!prior) continue;
        best = better(best, {
          correct: prior.correct + correctIn(prev, pos, boundary),
          penalty: prior.penalty + Math.abs(representativeCut(pos) - DEFAULT_HEURISTIC_BOUNDARIES[boundary]),
          prev,
        });
      }
      dp[boundary][pos] = best;
    }
  }

  let end: Cell | null = null;
  let endPos = 0;
  for (let pos = 0; pos <= g; pos++) {
    const prior = dp[4][pos];
    if (!prior) continue;
    const candidate = {
      correct: prior.correct + correctIn(pos, g, 5),
      penalty: prior.penalty,
      prev: prior.prev,
    };
    const chosen = better(end, candidate);
    if (chosen === candidate) {
      end = candidate;
      endPos = pos;
    }
  }

  const positions = Array(5).fill(0) as number[];
  let pos = endPos;
  for (let boundary = 4; boundary >= 0; boundary--) {
    positions[boundary] = pos;
    pos = dp[boundary][pos]?.prev ?? 0;
  }
  return materializeCutPositions(uniqueScores, positions);
}

function materializeCutPositions(uniqueScores: number[], positions: number[]): number[] {
  const g = uniqueScores.length;
  const out: number[] = [];
  for (let i = 0; i < positions.length;) {
    const pos = positions[i];
    let j = i + 1;
    while (j < positions.length && positions[j] === pos) j++;
    const n = j - i;
    const lower = pos <= 0 ? 0 : uniqueScores[pos - 1];
    const upper = pos >= g ? 1 : uniqueScores[pos];
    for (let k = 0; k < n; k++) out.push(lower + ((upper - lower) * (k + 1)) / (n + 1));
    i = j;
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(0.000001, Math.min(0.999999, out[i]));
    if (i > 0 && out[i] <= out[i - 1]) out[i] = Math.min(0.999999, out[i - 1] + 0.000001);
  }
  return out;
}

export class HeuristicLinearClassifier implements TierClassifier {
  id = 'heuristic-linear';
  kind = 'rule' as const;
  version = 'v0.5.2';
  requiresTraining = true; // fits boundaries; still runs without (defaults)
  private boundaries = [...DEFAULT_HEURISTIC_BOUNDARIES];
  private reliability: Partial<Record<EffortLevel, number>> = {};

  fit(train: LabeledPrompt[]): void {
    const pairs = train
      .filter((t) => t.tier)
      .map((t) => ({ score: rawHeuristicScore(t.prompt), tier: t.tier! }));
    this.boundaries = fitMonotonicCutPoints(pairs);
    this.reliability = fitReliabilityOutOfFold(pairs);
  }

  predictEffort(prompt: string): TierPrediction {
    const start = performance.now();
    const score = rawHeuristicScore(prompt);
    const tier = scoreToTier(score, this.boundaries);
    // Calibrated P(correct | predicted tier) — the same source ensemble-voter
    // uses, so eval confidence and runtime confidence cannot drift apart.
    // Boundary margin was measured to carry no signal about correctness.
    const confidence = this.reliability[tier] ?? confidenceForTier(tier);
    return { tier, score, confidence, latencyMs: performance.now() - start };
  }

  predictMode(prompt: string): ModePrediction {
    const start = performance.now();
    const r = detectIntentMode(prompt);
    return { mode: r.mode, confidence: r.confidence, latencyMs: performance.now() - start };
  }
}
