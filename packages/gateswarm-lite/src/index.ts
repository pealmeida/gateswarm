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
} from './feature-extractor.js';
import { scoreToEffort } from './tier-boundaries.js';
import { MAX_PROMPT_SIZE, type ComplexityResult } from './types.js';

export * from './feature-extractor.js';
export * from './session.js';
export * from './tier-boundaries.js';
export { MAX_PROMPT_SIZE } from './types.js';
export type { ComplexityResult, EffortLevel } from './types.js';

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
