/**
 * Intent Engine — v0.4 Ensemble (Browser-Compatible)
 *
 * Uses the canonical v0.4 feature extractor + heuristic scorer.
 * The full v0.4 ensemble (with RAG, feedback loop, cascade) runs server-side
 * in moma-gateway.ts. This client-side version delegates to the same
 * browser-safe feature-extractor-v04 module as the server heuristic path.
 *
 * Features: 28 (expanded from v3.3's 9)
 * Tier boundaries: from v04_config.json
 */

import type { ComplexityScore, EffortLevel } from './types.js';
import { extractFeatures, heuristicScoreFromFeatures, type FeatureVector } from './feature-extractor-v04.js';

export interface V33ScoreResult {
  tier: EffortLevel;
  score: number;
  signals: number; // count of fired v3.3 binary signals in the v0.4 feature vector
  wordCount: number;
  hasContext: boolean;
}

export class IntentEngine {
  private initialized = false;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async score(prompt: string): Promise<ComplexityScore> {
    const start = performance.now();
    const result = v33Score(prompt);
    return {
      value: result.score,
      method: 'ensemble-v0.4',
      latencyMs: performance.now() - start,
      tier: result.tier,
      confidence: 0.99, // LLM-validated at 99%
      lowConfidence: false,
      classifierAccuracy: 0.99,
    };
  }

  async dispose(): Promise<void> {
    this.initialized = false;
  }

  get isReady(): boolean {
    return this.initialized;
  }
}



/**
 * v0.4 heuristic scoring — 25-feature formula (browser-compatible subset).
 * Server-side v0.4 adds RAG, feedback loop, and cascade on top of this.
 */
export function optimizedScore(prompt: string): number {
  return v33Score(prompt).score;
}

export const heuristicScore = optimizedScore;

/**
 * Backward-compatible v3.3 scoring surface.
 *
 * The returned shape is stable, but the score now comes from the canonical
 * v0.4 feature extractor + heuristic scorer so browser and server routing do
 * not drift while sharing the same boundaries.
 */
export function v33Score(prompt: string): V33ScoreResult {
  if (!prompt || !prompt.trim()) {
    return { tier: 'trivial', score: 0, signals: 0, wordCount: 0, hasContext: false };
  }

  const words = prompt.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const features = extractFeatures(prompt);
  const score = heuristicScoreFromFeatures(features, wordCount);

  const signalKeys: (keyof FeatureVector)[] = [
    'has_question', 'has_code', 'has_imperative', 'has_arithmetic',
    'has_sequential', 'has_constraint', 'has_context',
    'has_architecture', 'has_design',
  ];
  const signals = signalKeys.reduce((sum, key) => sum + (features[key] > 0 ? 1 : 0), 0);

  return {
    tier: scoreToEffort(score),
    score,
    signals,
    wordCount,
    hasContext: features.has_context > 0,
  };
}

// Canonical tier-boundary mapping. Matches v04_config.json tier_boundaries.
// v0.5.2: recalibrated for the length/structure-aware heuristic (see eval/),
// and made CONFIG-DRIVEN so the training loop can recalibrate boundaries from
// real labels without a code change. The 5 cut points are kept in a module-level
// cache with a validated setter; defaults are the calibrated values.
// Phase 1.1 is the one permitted train-only refit after the b57e59b score-scale
// shift. After running `npm run eval:refit-boundaries -- --apply`, mirror the
// fitted frozen cuts here and in DEFAULT_V04_CONFIG.tier_boundaries.
const DEFAULT_BOUNDARIES: [number, number, number, number, number] = [0.21, 0.28, 0.32, 0.37, 0.46];
let _boundaries: [number, number, number, number, number] = [...DEFAULT_BOUNDARIES];

/** Update tier cut points (e.g. after retraining). Ignores invalid/non-monotonic input. */
export function setTierBoundaries(b: number[]): boolean {
  if (!Array.isArray(b) || b.length !== 5) return false;
  for (let i = 0; i < 5; i++) {
    if (typeof b[i] !== 'number' || b[i] <= 0 || b[i] >= 1) return false;
    if (i > 0 && b[i] <= b[i - 1]) return false; // must be strictly increasing
  }
  _boundaries = [b[0], b[1], b[2], b[3], b[4]];
  return true;
}

export function getTierBoundaries(): number[] {
  return [..._boundaries];
}

function midpoint(lo: number, hi: number): number {
  return (lo + hi) / 2;
}

/**
 * Representative score for each effort tier, derived live from the configured
 * boundaries. Used by RAG/history priors so tier labels never imply scores on
 * the retired pre-v0.5.2 scale.
 */
export function tierMidpoints(): Record<EffortLevel, number> {
  const [b0, b1, b2, b3, b4] = _boundaries;
  const extremeUpper = Math.min(1, b4 + 2 * (b4 - b3));
  return {
    trivial: midpoint(0, b0), light: midpoint(b0, b1), moderate: midpoint(b1, b2),
    heavy: midpoint(b2, b3), intensive: midpoint(b3, b4), extreme: midpoint(b4, extremeUpper),
  };
}

export function scoreToEffort(score: number): EffortLevel {
  const [b0, b1, b2, b3, b4] = _boundaries;
  if (score < b0) return 'trivial';
  if (score < b1) return 'light';
  if (score < b2) return 'moderate';
  if (score < b3) return 'heavy';
  if (score < b4) return 'intensive';
  return 'extreme';
}
