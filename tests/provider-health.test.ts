import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCliStdoutBodyFailure,
  getUnusableContentReason,
  getUnusableProviderBodyReason,
  normalizeZaiChatCompletionBody,
  prepareProviderChatCompletionBody,
  ProviderHealthTracker,
  providerFailureKindForHttp,
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

  it('prefers structured provider codes and requires error-shaped free text', () => {
    expect(getUnusableProviderBodyReason({
      error: { code: 1305, message: 'quota exhausted' },
    })).toMatchObject({ reason: 'provider_rate_limit_body', kind: 'rate_limit' });
    expect(providerFailureKindForHttp(400, JSON.stringify({ error: { code: 1308 } }))).toBe('rate_limit');
    expect(getUnusableProviderBodyReason({ error: { message: 'Invalid API key' } })?.kind).toBe('auth');
    expect(getUnusableContentReason('API Error: 1305')?.kind).toBe('rate_limit');
    expect(getUnusableContentReason('This guide explains why an invalid API key should be rotated.')).toBeNull();
  });

  it('accepts terminal tool and content-filter completions without text', () => {
    for (const choice of [
      { message: { content: null, tool_calls: [{ id: 'call_1' }] }, finish_reason: 'tool_calls' },
      { message: { content: null, function_call: { name: 'search' } }, finish_reason: 'stop' },
      { message: { content: null }, finish_reason: 'content_filter' },
    ]) {
      expect(getUnusableProviderBodyReason({ choices: [choice] })).toBeNull();
    }
  });

  it('never flags a normal completion shape because its content resembles an error', () => {
    expect(getUnusableProviderBodyReason({
      choices: [{
        message: { role: 'assistant', content: 'Failed to authenticate? Check the API key configuration.' },
        finish_reason: 'stop',
      }],
    })).toBeNull();
  });

  it('detects CLI stdout rate-limit text even when shaped like a completion', () => {
    const text = 'Rate limit exceeded. Please try again later.';
    expect(getCliStdoutBodyFailure(text)).toMatchObject({ kind: 'rate_limit' });
    expect(getUnusableProviderBodyReason({
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    })).toBeNull();
  });

  it('matches anchored CLI failure signatures (R7-N1) without prose heuristics', () => {
    expect(getCliStdoutBodyFailure('Too many requests')).toMatchObject({ kind: 'rate_limit' });
    expect(getCliStdoutBodyFailure('Claude AI usage limit reached|1234567890')).toMatchObject({ kind: 'rate_limit' });
    expect(getCliStdoutBodyFailure('5-hour limit reached ∙ resets 3am')).toMatchObject({ kind: 'rate_limit' });
    expect(getCliStdoutBodyFailure('API Error: 429 quota')).toMatchObject({ kind: 'rate_limit' });
    expect(getCliStdoutBodyFailure('API Error: 1305 system overloaded')).toMatchObject({ kind: 'rate_limit' });
  });

  it('does not flag legitimate short answers that mention errors or rate limits (R7-B1 negatives)', () => {
    const negatives = [
      'Error: rate limit handling is missing here. Wrap the call in a retry with backoff.',
      'Failed requests caused by rate limits should be retried with exponential backoff.',
      'Invalid — rate limits apply per API key, not per IP.',
      'API error 500 usually indicates a server bug; check the logs.',
      'Unauthorized (401) means your token is missing.',
    ];
    for (const text of negatives) {
      expect(getCliStdoutBodyFailure(text)).toBeNull();
    }
  });

  it('maps Z.AI finish_reason values and treats network_error as failure (R6-F1)', () => {
    const sensitive = normalizeZaiChatCompletionBody({
      choices: [{ message: { content: 'ok' }, finish_reason: 'sensitive' }],
    });
    expect(sensitive.failure).toBeNull();
    expect(sensitive.data.choices[0].finish_reason).toBe('content_filter');

    const length = normalizeZaiChatCompletionBody({
      choices: [{ message: { content: '' }, finish_reason: 'model_context_window_exceeded' }],
    });
    expect(length.data.choices[0].finish_reason).toBe('length');

    const network = prepareProviderChatCompletionBody({
      choices: [{ message: { content: 'partial' }, finish_reason: 'network_error' }],
    }, 'zai');
    expect(network.bodyFailure).toMatchObject({ kind: 'server_error', reason: 'zai_network_error_finish' });
  });

  it('does not put Z.AI in hard cooldown after two network_error finish_reason failures (R7-N5)', () => {
    const health = new ProviderHealthTracker(() => Date.now(), () => {});
    for (let i = 0; i < 2; i += 1) {
      const attempt = health.beginAttempt('zai');
      health.recordFailure('zai', 'server_error', 'zai/glm-test', 'network_error finish', attempt);
    }
    expect(health.getSkipReason('zai')).toBeNull();
  });

  it('treats top-level error fields as failure even with terminal empty choices', () => {
    const failure = getUnusableProviderBodyReason({
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      error: { message: 'UPSTREAM_SECRET_DETAIL', code: 'invalid_api_key' },
    });
    expect(failure?.kind).toBe('auth');
    expect(getUnusableProviderBodyReason({
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      error: { code: 1305, message: 'overload' },
    })).toMatchObject({ kind: 'rate_limit' });
  });
});

describe('provider health state', () => {
  it('keeps hard-failure streaks through non-hard failures and cools repeated server errors', () => {
    let now = 10_000;
    const health = new ProviderHealthTracker(() => now, () => {});
    health.recordFailure('hard', 'auth');
    health.recordFailure('hard', 'provider_error');
    health.recordFailure('hard', 'transport');
    expect(health.getSkipReason('hard')).toContain('unhealthy cooldown');

    health.recordFailure('server', 'server_error');
    now += 1;
    health.recordFailure('server', 'server_error');
    now += 1;
    health.recordFailure('server', 'server_error');
    expect(health.getSkipReason('server')).toContain('unhealthy cooldown');
  });

  it('persists only active cooldowns and restores them on boot', () => {
    let now = 25_000;
    const directory = mkdtempSync(join(tmpdir(), 'provider-health-'));
    const file = join(directory, 'provider-health.json');
    try {
      const health = new ProviderHealthTracker(() => now, () => {}, file);
      health.recordFailure('persisted', 'auth');
      health.recordFailure('persisted', 'transport');
      expect(JSON.parse(readFileSync(file, 'utf8')).cooldowns).toHaveLength(1);

      const restored = new ProviderHealthTracker(() => now, () => {}, file);
      expect(restored.getSkipReason('persisted')).toContain('unhealthy cooldown');

      now += 5 * 60 * 1000 + 1;
      const expired = new ProviderHealthTracker(() => now, () => {}, file);
      expect(expired.getSkipReason('persisted')).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not let an older success clear a newer failure cooldown', () => {
    let now = 50_000;
    const health = new ProviderHealthTracker(() => now, () => {});
    const oldSuccess = health.beginAttempt('ordered');
    now += 1;
    const firstFailure = health.beginAttempt('ordered');
    health.recordFailure('ordered', 'auth', 'ordered', '', firstFailure);
    now += 1;
    const secondFailure = health.beginAttempt('ordered');
    health.recordFailure('ordered', 'transport', 'ordered', '', secondFailure);

    health.recordSuccess('ordered', oldSuccess);
    expect(health.getSkipReason('ordered')).toContain('unhealthy cooldown');
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

  it('records rejected attempts as transport failures and continues the chain', async () => {
    const health = new ProviderHealthTracker(() => 0, () => {});
    const failures: string[] = [];
    const result = await runProviderFallbackChain(
      [
        { providerId: 'rejecting', model: 'm1', label: 'rejecting/m1' },
        { providerId: 'working', model: 'm2', label: 'working/m2' },
      ],
      async (target) => {
        if (target.providerId === 'rejecting') throw new Error('socket closed');
        return { ok: true as const, data: 'ok' };
      },
      {
        health,
        onFailure: (_target, failure) => failures.push(failure.kind),
      },
    );

    expect(failures).toEqual(['transport']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tried).toEqual(['rejecting/m1', 'working/m2']);
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
