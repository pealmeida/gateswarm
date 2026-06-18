/**
 * GateSwarm MoA Router v0.4 — Intent Engine
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

// ─── v3.3 Fallback ───────────────────────────────────────

function v33Fallback(prompt: string): ComplexityScore {
  const features = extractFeatures(prompt);
  const words = prompt.split(/\s+/).filter(Boolean);
  const score = heuristicScoreFromFeatures(features, words.length);

  // v3.6: UNIFIED tier boundaries matching v04_config.json / routing-matrix.ts
  let tier: EffortLevel;
  if (score < 0.1557) tier = 'trivial';
  else if (score < 0.1842) tier = 'light';
  else if (score < 0.2788) tier = 'moderate';
  else if (score < 0.3488) tier = 'heavy';
  else if (score < 0.4611) tier = 'intensive';
  else tier = 'extreme';

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

  // RAG signal
  const keywords = prompt.toLowerCase().split(/\s+/)
    .filter(w => w.length > 4 && !/^(the|and|for|with|this|that|from|have|been)/.test(w));
  const ragEntries = getRagSignalEntries(keywords.slice(0, 10));
  const ragSignal = ragEntries.length > 0
    ? ragEntries.reduce((sum, e) => {
        const tierScores: Record<string, number> = {
          trivial: 0.05, light: 0.15, moderate: 0.30,
          heavy: 0.50, intensive: 0.70, extreme: 0.90,
        };
        return sum + (tierScores[e.tier] ?? 0.3);
      }, 0) / ragEntries.length
    : 0.5;

  // Ensemble vote
  try {
    const vote = ensembleVote({
      prompt,
      heuristicScore,
      ragSignal,
      enableCascade: config.feedback_loop.cascadeRetraining,
    });

    const latency = performance.now() - start;

    return {
      value: vote.finalScore,
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
