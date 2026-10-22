import { createJevTierClient, type JevTierClient } from '../jev/client.js';
import type { DeterministicProvider } from './types.js';

export function createJevDeterministicProvider(
  client: JevTierClient = createJevTierClient({}),
  id = 'jev',
): DeterministicProvider {
  return {
    id,
    kind: 'deterministic',
    costUsd: 0,
    async classify({ prompt, signal }) {
      const result = await client.askTier(prompt, signal);
      return {
        ok: result.ok,
        tier: result.tier,
        confidence: result.confidence,
        error: result.error,
        provider: id,
      };
    },
  };
}
