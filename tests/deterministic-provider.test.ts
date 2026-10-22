import { describe, expect, it, vi } from 'vitest';
import { createDefaultDeterministicRegistry, DeterministicRegistry, registerDeterministicProvider, type DeterministicProvider } from '../src/deterministic/types.js';
import { createJevDeterministicProvider } from '../src/deterministic/jev-provider.js';
import { createLayaDeterministicProvider } from '../src/deterministic/laya-provider.js';

const provider = (id: string, classify: DeterministicProvider['classify']): DeterministicProvider => ({
  id, kind: 'deterministic', costUsd: 0, classify,
});

describe('deterministic providers', () => {
  it('falls back from provider errors and timeouts to the local heuristic', async () => {
    const registry = new DeterministicRegistry({ timeoutMs: 5 });
    registry.register(provider('throws', async () => { throw new Error('failure'); }));
    registry.register(provider('hangs', async () => new Promise(() => {})));
    const result = await registry.resolve({ prompt: 'hello' });
    expect(result).toMatchObject({ ok: true, tier: 'trivial', provider: 'local-heuristic' });
  });

  it('returns the first successful provider and memoizes identical inputs', async () => {
    const classify = vi.fn(async () => ({ ok: true, tier: 'light', provider: 'mock' }));
    const registry = new DeterministicRegistry();
    registry.register(provider('mock', classify));
    const a = await registry.resolve({ prompt: 'same' });
    const b = await registry.resolve({ prompt: 'same' });
    expect(a).toEqual(b);
    expect(a.provider).toBe('mock');
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('registers and retrieves extension providers', () => {
    const extension = provider('future-model', async () => ({ ok: true, provider: 'future-model' }));
    registerDeterministicProvider(extension);
    const registry = new DeterministicRegistry();
    registry.register(extension);
    expect(registry.get('future-model')).toBe(extension);
    expect(registry.list().map((item) => item.id)).toContain('local-heuristic');
  });

  it('adapts Jev results with zero declared cost', async () => {
    const client = { askTier: vi.fn(async () => ({ ok: true, tier: 'heavy', confidence: 0.8 })) };
    const jev = createJevDeterministicProvider(client as never);
    expect(jev.costUsd).toBe(0);
    expect(await jev.classify({ prompt: 'mock prompt' })).toMatchObject({ ok: true, tier: 'heavy', confidence: 0.8, provider: 'jev' });
    expect(client.askTier).toHaveBeenCalledWith('mock prompt');
  });

  it('enables configured Laya before Jev and local fallback, and leaves Laya unavailable without an endpoint', () => {
    expect(createLayaDeterministicProvider(undefined)).toBeUndefined();
    const registry = createDefaultDeterministicRegistry({
      enabled: true,
      env: { GATESWARM_LAYA_ENDPOINT: 'configured-laya-endpoint', TYPESAFE_API_KEY: 'test-only-placeholder' },
    });
    expect(registry.list().map(({ id }) => id)).toEqual(['local-heuristic', 'laya', 'jev']);
  });
});
