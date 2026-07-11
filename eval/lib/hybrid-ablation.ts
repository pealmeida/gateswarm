/**
 * Ablation modes for hybrid routing eval.
 *
 * Isolates heuristic / RAG / history contributions using production scoring
 * primitives. Cold RAG (no store) and cold history (empty feedback) make
 * several modes numerically identical — see scoreAblation comments.
 */
import { extractFeatures, heuristicScoreFromFeatures } from '../../src/feature-extractor-v04.js';
import { ensembleVote } from '../../src/ensemble-voter.js';
import { scoreToEffort } from '../../src/intent-engine.js';
import type { EffortLevel } from '../../src/types.js';
import type { EffortExample } from './dataset.js';
import { effortMetrics } from './metrics.js';

export type AblationMode = 'heuristic' | 'heuristic+rag' | 'heuristic+history' | 'full';

export function scoreAblation(prompt: string, mode: AblationMode): { score: number; tier: EffortLevel } {
  const features = extractFeatures(prompt);
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  const heuristic = heuristicScoreFromFeatures(features, wordCount);

  if (mode === 'heuristic') {
    return { score: heuristic, tier: scoreToEffort(heuristic) };
  }

  if (mode === 'heuristic+rag') {
    // Cold eval: ragSignal undefined is a documented no-op (rawScore === heuristic)
    // unless a warm RAG store supplies a numeric signal.
    const vote = ensembleVote({
      prompt,
      heuristicScore: heuristic,
      ragSignal: undefined,
      enableCascade: false,
    });
    return { score: vote.rawScore, tier: scoreToEffort(vote.rawScore) };
  }

  if (mode === 'heuristic+history') {
    const vote = ensembleVote({ prompt, heuristicScore: heuristic, enableCascade: false });
    return { score: vote.finalScore, tier: vote.tier };
  }

  // full — same call shape as heuristic+history until a warm RAG path is wired
  const vote = ensembleVote({ prompt, heuristicScore: heuristic, enableCascade: false });
  return { score: vote.finalScore, tier: vote.tier };
}

export function runAblation(examples: EffortExample[]): Record<AblationMode, ReturnType<typeof effortMetrics>> {
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
}
