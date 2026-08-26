/**
 * Session scoring — the sequence-aware companion to scoreComplexity.
 *
 * Multi-turn conversations grow: by turn N the "prompt" a router should judge
 * is the accumulated context, and it may exceed any sane per-call budget.
 * scoreSession() joins the turns, windows them to maxChars (recency-biased by
 * default — recent turns dominate routing relevance), and scores once, so
 * worst-case work is bounded no matter how long the session runs.
 *
 * The single-prompt parity path (scoreComplexity) is untouched.
 */
import {
  countPromptWords,
  extractFeatures,
  heuristicScoreFromFeatures,
} from './feature-extractor.js';
import { scoreToEffort } from './tier-boundaries.js';
import { MAX_PROMPT_SIZE, type ComplexityResult } from './types.js';

export interface SessionScoreOptions {
  /** Window budget in characters. Default MAX_PROMPT_SIZE (64 KiB). */
  maxChars?: number;
  /** Which side of the joined context survives windowing. Default 'tail'. */
  keep?: 'head' | 'tail';
}

export interface SessionComplexityResult extends ComplexityResult {
  turnsCount: number;
  /** Characters actually scored after windowing. */
  windowChars: number;
  /** True when the joined context exceeded maxChars and was windowed. */
  truncated: boolean;
}

export function scoreSession(turns: string[], opts: SessionScoreOptions = {}): SessionComplexityResult {
  const start = performance.now();
  // Clamp: maxChars <= 0 would make slice(-0) return the FULL string,
  // silently disabling the bounded-work guarantee.
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? MAX_PROMPT_SIZE));
  const keep = opts.keep ?? 'tail';

  const turnsList = (Array.isArray(turns) ? turns : []).map((t) => String(t ?? ''));
  const joined = turnsList.join('\n\n');
  let windowed = joined;
  if (joined.length > maxChars) {
    windowed = keep === 'head' ? joined.slice(0, maxChars) : joined.slice(-maxChars);
  }

  const features = extractFeatures(windowed);
  const wordCount = countPromptWords(windowed);
  const score = heuristicScoreFromFeatures(features, wordCount);

  return {
    score,
    tier: scoreToEffort(score),
    wordCount,
    features,
    latencyMs: performance.now() - start,
    turnsCount: turnsList.length,
    windowChars: windowed.length,
    truncated: joined.length > maxChars,
  };
}
