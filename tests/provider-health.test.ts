import { describe, expect, it } from 'vitest';
import {
  getUnusableContentReason,
  getUnusableProviderBodyReason,
  ProviderHealthTracker,
  runProviderFallbackChain,
} from '../src/adapters/provider-health.js';

describe('provider response usability', () => {
  it('detects empty assistant bodies', () => {
    const failure = getUnusableProviderBodyReason({
      choices: [{ message: { role: 'assistant', content: '   \n\t' } }],
    });

    expect(failure?.reason).toBe('empty_body');
    expect(failure?.kind).toBe('unusable_body');
  });

  it('detects provider auth strings returned as assistant content', () => {
    const failure = getUnusableContentReason(
      'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    );

    expect(failure?.reason).toBe('provider_auth_error_body');
    expect(failure?.kind).toBe('auth');
  });

  it('does not flag ordinary explanatory content mentioning rate limits', () => {
    const failure = getUnusableContentReason(
      'When you design an API client, handle rate limits with exponential backoff and request jitter.',
    );

    expect(failure).toBeNull();
  });
});

describe('provider fallback traversal', () => {
  it('advances to the next fallback after an unusable provider body', async () => {
    let now = 0;
    const health = new ProviderHealthTracker(() => now, () => {});
    const attempts: string[] = [];

    const result = await runProviderFallbackChain(
      [
        { providerId: 'bad', model: 'm1', label: 'bad/m1' },
        { providerId: 'good', model: 'm2', label: 'good/m2' },
      ],
      async (target) => {
        attempts.push(target.label);
        if (target.providerId === 'bad') {
          return { ok: false, kind: 'auth', message: 'Failed to authenticate. API Error: 401' };
        }
        return { ok: true, data: { content: 'ok' } };
      },
      { health },
    );

    now += 1;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.label).toBe('good/m2');
    expect(attempts).toEqual(['bad/m1', 'good/m2']);
  });

  it('returns a 502 JSON error when the chain is exhausted', async () => {
    const health = new ProviderHealthTracker(() => 0, () => {});

    const result = await runProviderFallbackChain(
      [
        { providerId: 'one', model: 'm1', label: 'one/m1' },
        { providerId: 'two', model: 'm2', label: 'two/m2' },
      ],
      async () => ({ ok: false, kind: 'unusable_body', message: 'empty response body' }),
      { health },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error.type).toBe('provider_chain_exhausted');
      expect(result.error.message).toContain('one/m1');
      expect(result.error.message).toContain('two/m2');
    }
  });

  it('skips an unhealthy provider during cooldown', async () => {
    let now = 1000;
    const logs: string[] = [];
    const health = new ProviderHealthTracker(() => now, (line) => logs.push(line));
    health.recordFailure('bad', 'auth', 'bad/m1', '401');
    health.recordFailure('bad', 'transport', 'bad/m1', 'connection reset');

    const attempts: string[] = [];
    const result = await runProviderFallbackChain(
      [
        { providerId: 'bad', model: 'm1', label: 'bad/m1' },
        { providerId: 'good', model: 'm2', label: 'good/m2' },
      ],
      async (target) => {
        attempts.push(target.label);
        return { ok: true, data: { content: target.label } };
      },
      { health },
    );

    expect(logs.some(line => line.includes('bad marked unhealthy for 300s'))).toBe(true);
    expect(attempts).toEqual(['good/m2']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.providerId).toBe('good');
  });
});
