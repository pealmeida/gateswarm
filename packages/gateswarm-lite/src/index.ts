/**
 * gateswarm-lite — zero-dependency prompt complexity scorer.
 *
 * Layer 1 of the GateSwarm split: scores a prompt 0-1 with the production
 * heuristic (35 features, hand-tuned weights) and maps it to one of six
 * effort tiers via calibrated cut points.
 */
import {
  countPromptWords,
  extractFeatures,
  heuristicScoreFromFeatures,
  type FeatureVector,
} from './feature-extractor.js';
import { scoreToEffort } from './tier-boundaries.js';
import type { EffortLevel } from './types.js';

export * from './feature-extractor.js';
export * from './tier-boundaries.js';
export type { EffortLevel } from './types.js';

/** Prompts longer than this are truncated before scoring (same guard as the gateway). */
export const MAX_PROMPT_SIZE = 64 * 1024;

export interface ComplexityResult {
  /** Heuristic complexity score in [0, 1]. */
  score: number;
  /** Effort tier derived from the calibrated boundaries. */
  tier: EffortLevel;
  wordCount: number;
  features: FeatureVector;
  latencyMs: number;
}

export function scoreComplexity(prompt: string): ComplexityResult {
  const start = performance.now();
  const p = prompt.length > MAX_PROMPT_SIZE ? prompt.slice(0, MAX_PROMPT_SIZE) : prompt;
  const features = extractFeatures(p);
  const wordCount = countPromptWords(p);
  const score = heuristicScoreFromFeatures(features, wordCount);
  return {
    score,
    tier: scoreToEffort(score),
    wordCount,
    features,
    latencyMs: performance.now() - start,
  };
}
