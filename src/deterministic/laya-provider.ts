import { createJevTierClient, type JevTierClient } from '../jev/client.js';
import type { DeterministicProvider } from './types.js';

/** Returns no provider unless a self-hosted Laya endpoint is explicitly configured. */
export function createLayaDeterministicProvider(
  endpoint = process.env.GATESWARM_LAYA_ENDPOINT,
  client?: JevTierClient,
): DeterministicProvider | undefined {
  if (!endpoint?.trim()) return undefined;
  const id = 'laya';
  const tierClient = client ?? createJevTierClient({ endpoint: endpoint.trim(), allowNoKey: true });
  return {
    id,
    kind: 'deterministic',
    costUsd: 0,
    async classify({ prompt }) {
      const result = await tierClient.askTier(prompt);
      return { ok: result.ok, tier: result.tier, confidence: result.confidence, error: result.error, provider: id };
    },
  };
}
