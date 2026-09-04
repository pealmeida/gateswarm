/**
 * GateSwarm MoMA Router v0.4 — Intent Engine
 *
 * Uses ensemble voter for complexity scoring:
 *   - Heuristic (40%): v3.3 9-signal formula
 *   - Cascade (30%): v3.2 binary classifiers (retrained on real feedback)
 *   - RAG signal (15%): prior context complexity
 *   - History bias (15%): user interaction patterns
 *
 * Falls back to v3.3 heuristic if ensemble components unavailable.
 */

import type { ComplexityScore, EffortLevel } from './types.js';
import { countPromptWords, extractFeatures, heuristicScoreFromFeatures } from './feature-extractor-v04.js';
import { ensembleVote, type EnsembleVote } from './ensemble-voter.js';
import { getOrdinalModelHealth } from './classifiers/ordinal-logistic.js';
import { queryRag, getRagSignalEntries } from './rag-index.js';
import { getConfig } from './v04-config.js';
import { scoreToEffort, tierMidpoints } from './intent-engine.js';

/** Kept in step with vote-persistence's alwaysAskBelowConfidence default. */
const LOW_CONFIDENCE_THRESHOLD = 0.30;

// ─── v3.3 Fallback ───────────────────────────────────────

const MAX_PROMPT_SIZE = 64 * 1024;
let lastTruncatedPromptLogAt = 0;
let lastEnsembleFailureLogAt = 0;

function promptForScoring(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_SIZE) return prompt;
  const now = Date.now();
  if (now - lastTruncatedPromptLogAt >= 60_000) {
    lastTruncatedPromptLogAt = now;
    console.error({ event: 'routing.prompt_truncated', originalLength: prompt.length, maxLength: MAX_PROMPT_SIZE });
  }
  return prompt.slice(0, MAX_PROMPT_SIZE);
}

function v33Fallback(prompt: string): ComplexityScore {
  prompt = promptForScoring(prompt);
  const features = extractFeatures(prompt);
  const score = heuristicScoreFromFeatures(features, countPromptWords(prompt));

  // v0.5.2: UNIFIED tier boundaries — uses the canonical scoreToEffort mapping
  // (previously hardcoded divergent boundaries here, causing fallback misrouting).
  const tier: EffortLevel = scoreToEffort(score);

  return {
    value: score,
    method: 'heuristic-fallback',
    latencyMs: 0,
    tier,
    confidence: 0.7,
    lowConfidence: false,
    classifierAccuracy: 0.74,
  };
}

// ─── v0.4 Ensemble Scoring ────────────────────────────────

export async function scoreIntent(prompt: string): Promise<ComplexityScore> {
  const start = performance.now();
  const config = getConfig();
  prompt = promptForScoring(prompt);

  // Extract features
  const features = extractFeatures(prompt);
  const heuristicScore = heuristicScoreFromFeatures(features, countPromptWords(prompt));

  // RAG signal — pass undefined when no prior context exists so the voter does
  // NOT inject a neutral 0.5 floor (the old behaviour added a flat +0.125 to every score).
  //
  // v0.5.6 routing-fix: RagEntry.tier is overloaded — it can be an effort tier
  // (trivial/light/moderate/heavy/intensive/extreme) OR a compressor quality
  // tier (Q0/Q1/Q2). Compressor tiers are about context compression, not
  // complexity — exclude them so they don't pollute the ragSignal.
  const keywords = prompt.toLowerCase().split(/\s+/)
    .filter(w => w.length > 4 && !/^(the|and|for|with|this|that|from|have|been)/.test(w));
  const allRagEntries = getRagSignalEntries(keywords.slice(0, 10));
  const ragEntries = allRagEntries.filter(e => !/^Q[0-9]+$/.test(e.tier));
  const tierScores = tierMidpoints();
  const ragSignal = ragEntries.length > 0
    ? ragEntries.reduce((sum, e) => sum + (tierScores[e.tier as EffortLevel] ?? tierScores.moderate), 0) / ragEntries.length
    : undefined;

  // Ensemble vote
  try {
    const vote = ensembleVote({
      prompt,
      features,
      heuristicScore,
      ragSignal,
      cascadeAbstainMargin: config.ensemble.ordinalAbstainMargin,
      enableCascade: config.feedback_loop.cascadeRetraining,
    });

    const latency = performance.now() - start;

    return {
      value: vote.finalScore,
      rawValue: vote.rawScore,
      method: vote.method,
      latencyMs: latency,
      tier: vote.tier,
      confidence: vote.confidence,
      // Threshold matches getAgentConfig().alwaysAskBelowConfidence, not the
      // old 0.5 margin floor: calibrated confidence runs below 0.5 for four
      // tiers of six, so 0.5 here flagged almost everything as low-confidence.
      lowConfidence: vote.confidence < LOW_CONFIDENCE_THRESHOLD,
      classifierAccuracy: vote.confidence,
    };
  } catch (err) {
    const now = Date.now();
    if (now - lastEnsembleFailureLogAt >= 60_000) {
      lastEnsembleFailureLogAt = now;
      console.error({
        event: 'routing.ensemble_failure',
        error: err instanceof Error ? err.message : 'unknown error',
        fallback: 'heuristic',
      });
    }
    // Fallback to v3.3 heuristic
    const result = v33Fallback(prompt);
    result.latencyMs = performance.now() - start;
    return result;
  }
}

// ─── Backward Compatibility ──────────────────────────────

/**
 * Synchronous heuristic-only scoring (for CLI, non-async contexts).
 */
export function scoreIntentSync(prompt: string): ComplexityScore {
  return v33Fallback(prompt);
}

export function getScorerHealth(): { ordinal: 'active' | 'absent' | 'invalid' } {
  return { ordinal: getOrdinalModelHealth() };
}

// Re-export v3.3 for backward compatibility
export { v33Fallback as v33Score };
