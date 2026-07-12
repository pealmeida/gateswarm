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
import { extractFeatures, heuristicScoreFromFeatures } from './feature-extractor-v04.js';
import { ensembleVote, type EnsembleVote } from './ensemble-voter.js';
import { queryRag, getRagSignalEntries } from './rag-index.js';
import { getConfig } from './v04-config.js';
import { scoreToEffort, tierMidpoints } from './intent-engine.js';

// ─── v3.3 Fallback ───────────────────────────────────────

function v33Fallback(prompt: string): ComplexityScore {
  const features = extractFeatures(prompt);
  const words = prompt.split(/\s+/).filter(Boolean);
  const score = heuristicScoreFromFeatures(features, words.length);

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

  // Extract features
  const features = extractFeatures(prompt);
  const words = prompt.split(/\s+/).filter(Boolean);
  const heuristicScore = heuristicScoreFromFeatures(features, words.length);

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
      lowConfidence: vote.confidence < 0.5,
      classifierAccuracy: vote.confidence,
    };
  } catch (err) {
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

// Re-export v3.3 for backward compatibility
export { v33Fallback as v33Score };
