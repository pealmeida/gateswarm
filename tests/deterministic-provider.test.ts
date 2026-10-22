import { describe, expect, it, vi } from 'vitest';
import { createDefaultDeterministicRegistry, DeterministicRegistry, registerDeterministicProvider, type DeterministicProvider } from '../src/deterministic/types.js';
import { createJevDeterministicProvider } from '../src/deterministic/jev-provider.js';
import { createLayaDeterministicProvider } from '../src/deterministic/laya-provider.js';
import { createJevTierClient } from '../src/jev/client.js';

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
    expect(client.askTier).toHaveBeenCalledWith('mock prompt', undefined);
  });

  it('enables configured Laya before Jev and local fallback, and leaves Laya unavailable without an endpoint', () => {
    expect(createLayaDeterministicProvider(undefined)).toBeUndefined();
    const registry = createDefaultDeterministicRegistry({
      enabled: true,
      env: { GATESWARM_LAYA_ENDPOINT: 'https://laya.example', TYPESAFE_API_KEY: 'test-only-placeholder' },
    });
    expect(registry.list().map(({ id }) => id)).toEqual(['local-heuristic', 'laya', 'jev']);
  });

  it('never sends environment credentials to keyless endpoints and validates their transport', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      return Response.json({ model: 'system1-mini', answers: { tier: { choice: 'light' } } });
    });
    const client = createJevTierClient({ endpoint: 'https://laya.example', allowNoKey: true, fetchImpl: fetchImpl as typeof fetch });
    await client.askTier('plain prompt');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(() => createJevTierClient({ endpoint: 'http://remote.example', allowNoKey: true })).toThrow(/HTTPS/);
    expect(() => createJevTierClient({ endpoint: 'http://localhost:1234', allowNoKey: true })).not.toThrow();
  });

  it('rejects invalid successful tiers and retries failures instead of memoizing them', async () => {
    const classify = vi.fn()
      .mockResolvedValueOnce({ ok: true, tier: 'unknown', provider: 'remote' })
      .mockResolvedValueOnce({ ok: false, error: 'temporary', provider: 'remote' })
      .mockResolvedValueOnce({ ok: true, tier: 'light', provider: 'remote' });
    const local = provider('local', async () => ({ ok: false, error: 'local-failed', provider: 'local' }));
    const registry = new DeterministicRegistry({ cooldownMs: 0, localProvider: local });
    registry.register(provider('remote', classify));
    expect((await registry.resolve({ prompt: 'tier test' })).ok).toBe(false);
    // The negative result is not cached and a later attempt can succeed.
    expect((await registry.resolve({ prompt: 'temporary test' })).ok).toBe(false);
    expect((await registry.resolve({ prompt: 'temporary test' })).provider).toBe('remote');
  });

  it('clears memo on registration and rejects duplicate ids unless replacing explicitly', async () => {
    const first = vi.fn(async () => ({ ok: true, tier: 'light', provider: 'same' }));
    const registry = new DeterministicRegistry();
    registry.register(provider('same', first));
    await registry.resolve({ prompt: 'memo' });
    expect(() => registry.register(provider('same', first))).toThrow(/already registered/);
    const second = vi.fn(async () => ({ ok: true, tier: 'heavy', provider: 'same' }));
    registry.register(provider('same', second), { replace: true });
    expect((await registry.resolve({ prompt: 'memo' })).tier).toBe('heavy');
  });

  it('aborts timed out providers and uses cooldowns after consecutive failures', async () => {
    let receivedSignal: AbortSignal | undefined;
    const failing = provider('remote-failing', async ({ signal }) => {
      receivedSignal = signal;
      return new Promise(() => {});
    });
    const registry = new DeterministicRegistry({ timeoutMs: 5, cooldownMs: 10_000 });
    registry.register(failing);
    await registry.resolve({ prompt: 'one' });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
    const before = vi.spyOn(failing, 'classify');
    await registry.resolve({ prompt: 'two' });
    expect(before).not.toHaveBeenCalled();
  });
});
