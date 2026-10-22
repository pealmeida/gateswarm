import { v33Score } from '../intent-engine.js';
import type { DeterministicProvider } from './types.js';

/** Wraps the router's existing pure, local heuristic scorer. */
export function createLocalHeuristicProvider(): DeterministicProvider {
  return {
    id: 'local-heuristic',
    kind: 'deterministic',
    costUsd: 0,
    async classify({ prompt }) {
      const score = v33Score(prompt);
      return { ok: true, tier: score.tier, confidence: 0.99, provider: 'local-heuristic' };
    },
  };
}
