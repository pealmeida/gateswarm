/**
 * Ablation modes for hybrid routing eval.
 *
 * Isolates heuristic / RAG / history contributions using production scoring
 * primitives. Warm mode seeds deterministic train-side RAG/history fixtures
 * before scoring and restores the stores afterward.
 */
import { extractFeatures, heuristicScoreFromFeatures } from '../../src/feature-extractor-v04.js';
import { calcRagSignal, ensembleVote } from '../../src/ensemble-voter.js';
import { scoreToEffort } from '../../src/intent-engine.js';
import { getRagSignalEntries } from '../../src/rag-index.js';
import type { EffortLevel } from '../../src/types.js';
import type { EffortExample } from './dataset.js';
import { TIERS } from './dataset.js';
import { effortMetrics } from './metrics.js';
import { keywordsForPrompt, seedWarmStores } from './hybrid-warm-fixtures.js';

export type AblationMode = 'heuristic' | 'heuristic+rag' | 'heuristic+history' | 'full';

export interface AblationRunOptions {
  warm?: boolean;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

function ragSignalForPrompt(prompt: string): number | undefined {
  const retrievedEntries = getRagSignalEntries(keywordsForPrompt(prompt))
    .filter((entry) => (TIERS as string[]).includes(entry.tier))
    .map((entry) => ({
      tier: entry.tier as EffortLevel,
      complexityAvg: entry.compressedTokens,
      escalationHistory: entry.escalationHistory,
    }));

  if (!retrievedEntries.length) return undefined;
  return calcRagSignal({ retrievedEntries });
}

export function scoreAblation(prompt: string, mode: AblationMode): { score: number; tier: EffortLevel } {
  const features = extractFeatures(prompt);
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  const heuristic = heuristicScoreFromFeatures(features, wordCount);
  const ragSignal = mode === 'heuristic+rag' || mode === 'full'
    ? ragSignalForPrompt(prompt)
    : undefined;

  if (mode === 'heuristic') {
    return { score: heuristic, tier: scoreToEffort(heuristic) };
  }

  if (mode === 'heuristic+rag') {
    if (typeof ragSignal !== 'number') {
      return { score: heuristic, tier: scoreToEffort(heuristic) };
    }
    // Mirror the production fallback blend while keeping this mode isolated
    // from history bias, which ensembleVote always applies when history is warm.
    const score = clampScore(heuristic * 0.8 + ragSignal * 0.2);
    return { score, tier: scoreToEffort(score) };
  }

  if (mode === 'heuristic+history') {
    const vote = ensembleVote({ prompt, heuristicScore: heuristic, enableCascade: false });
    return { score: vote.finalScore, tier: vote.tier };
  }

  const vote = ensembleVote({ prompt, heuristicScore: heuristic, ragSignal, enableCascade: false });
  return { score: vote.finalScore, tier: vote.tier };
}

export function runAblation(
  examples: EffortExample[],
  options: AblationRunOptions = {},
): Record<AblationMode, ReturnType<typeof effortMetrics>> {
  const warm = options.warm === true ? seedWarmStores(examples) : null;
  try {
    const modes: AblationMode[] = ['heuristic', 'heuristic+rag', 'heuristic+history', 'full'];
    const out = {} as Record<AblationMode, ReturnType<typeof effortMetrics>>;
    for (const mode of modes) {
      const rows = examples.map((e) => {
        const r = scoreAblation(e.prompt, mode);
        return { expected: e.tier, predicted: r.tier };
      });
      out[mode] = effortMetrics(rows);
    }
    return out;
  } finally {
    warm?.cleanup();
  }
}
