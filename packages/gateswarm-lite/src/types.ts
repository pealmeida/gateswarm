import type { FeatureVector } from './feature-extractor.js';

export type EffortLevel = 'trivial' | 'light' | 'moderate' | 'heavy' | 'intensive' | 'extreme';

export interface ComplexityResult {
  /** Heuristic complexity score in [0, 1]. */
  score: number;
  /** Effort tier derived from the calibrated boundaries. */
  tier: EffortLevel;
  wordCount: number;
  features: FeatureVector;
  latencyMs: number;
}

/** Prompts longer than this are truncated before scoring (same guard as the gateway). */
export const MAX_PROMPT_SIZE = 64 * 1024;
