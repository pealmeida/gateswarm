import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelMatrix } from '../src/model-matrix.js';
import { providerQuota } from '../src/provider-quota.js';
import {
  CLIENT_PROVIDER_ERROR,
  CLIENT_RATE_LIMIT_ERROR,
  CLIENT_TIMEOUT_ERROR,
  clientHttpResponseForUpstreamFailure,
  createGatewayHttpServer,
  DEFAULT_RETRY_AFTER_SECONDS,
  initializeGatewayForTests,
  MAX_RETRY_AFTER_SECONDS,
  resolveRetryAfterSeconds,
  gatewayVoteRequestForClient,
  sanitizeClientChatCompletionPayload,
  sanitizeClientLogprobs,
  sanitizeClientVoteRequestField,
  shouldRecordProviderQuotaThrottle,
} from '../src/moma-gateway.js';
import type { VoteRequest } from '../src/training-mode.js';

const originalZaiKey = process.env.ZAI_KEY;

function registerToolCapableZaiModel(): void {
  modelMatrix.upsertModel({
    id: 'glm-5.3',
    provider: 'zai',
    name: 'glm-5.3',
    supportsTools: true,
  });
}

function postJson(port: number, body: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('clientHttpResponseForUpstreamFailure', () => {
  it('maps upstream 504 to client timeout error', () => {
    expect(clientHttpResponseForUpstreamFailure(504)).toEqual({
      httpStatus: 504,
      error: CLIENT_TIMEOUT_ERROR,
    });
  });

  it('maps upstream 429 to client rate limit error', () => {
    expect(clientHttpResponseForUpstreamFailure(429)).toEqual({
      httpStatus: 429,
      error: CLIENT_RATE_LIMIT_ERROR,
    });
  });

  it('maps other upstream failures to generic provider error', () => {
    for (const status of [400, 500, 502]) {
      expect(clientHttpResponseForUpstreamFailure(status)).toEqual({
        httpStatus: 502,
        error: CLIENT_PROVIDER_ERROR,
      });
    }
  });
});

describe('sanitizeClientChatCompletionPayload', () => {
  it('returns only allowlisted chat completion fields and drops upstream error metadata', () => {
    const sanitized = sanitizeClientChatCompletionPayload({
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      created: 123,
      model: 'evil-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      error: { message: 'UPSTREAM_SECRET_DETAIL' },
      provider: 'evil-provider',
    }, 'zai/glm-5.3');

    expect(sanitized).toEqual({
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      created: 123,
      model: 'evil-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(JSON.stringify(sanitized)).not.toContain('UPSTREAM_SECRET_DETAIL');
    expect(sanitized).not.toHaveProperty('error');
    expect(sanitized).not.toHaveProperty('provider');
  });

  it('preserves reasoning-only completions and optional OpenAI metadata fields', () => {
    const sanitized = sanitizeClientChatCompletionPayload({
      id: 'chatcmpl-reasoning',
      object: 'chat.completion',
      created: 456,
      model: 'reasoning-model',
      system_fingerprint: 'fp_abc123',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'internal chain of thought',
          refusal: 'none',
        },
        finish_reason: 'length',
        logprobs: { content: [{ token: 'a', logprob: -0.1 }] },
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 18, accepted_prediction_tokens: 0 },
        prompt_tokens_details: { cached_tokens: 2 },
        evil_field: 'drop-me',
      },
      provider: 'evil',
    });

    expect(sanitized.system_fingerprint).toBe('fp_abc123');
    const choice = (sanitized.choices as any[])[0];
    expect(choice.message.reasoning_content).toBe('internal chain of thought');
    expect(choice.message.refusal).toBe('none');
    expect(choice.message.content).toBe('');
    expect(choice.finish_reason).toBe('length');
    expect(choice.logprobs).toEqual({ content: [{ token: 'a', logprob: -0.1, top_logprobs: [] }] });
    expect(sanitized.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 18, accepted_prediction_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 2 },
    });
    expect(sanitized.usage).not.toHaveProperty('evil_field');
  });

  it('drops upstream _voteRequest metadata from sanitized payloads', () => {
    const sanitized = sanitizeClientChatCompletionPayload({
      id: 'chatcmpl-vote',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      _voteRequest: {
        id: 'v000000000001',
        prompt: 'evil upstream vote',
        predictedTier: 'light',
        confidence: 0.8,
      },
    });
    expect(sanitized).not.toHaveProperty('_voteRequest');
  });

  it('sanitizes logprobs and rejects probe fields', () => {
    expect(sanitizeClientLogprobs({
      error: { message: 'UPSTREAM_SECRET_DETAIL' },
      content: [{
        token: 'ok',
        logprob: -0.2,
        bytes: [111, 107],
        top_logprobs: [{ token: 'ok', logprob: -0.2, bytes: null }],
      }],
    })).toEqual({
      content: [{
        token: 'ok',
        logprob: -0.2,
        bytes: [111, 107],
        top_logprobs: [{ token: 'ok', logprob: -0.2, bytes: null }],
      }],
    });
    expect(sanitizeClientLogprobs({ error: { message: 'UPSTREAM_SECRET_DETAIL' } })).toBeUndefined();
  });

  it('validates gateway vote metadata and rejects invalid fields', () => {
    const vote: VoteRequest = {
      id: 'vabcdefabcdef',
      agentId: 'default',
      prompt: 'hello',
      predictedTier: 'light',
      confidence: 0.75,
      timestamp: Date.now(),
      voted: false,
      userAgreed: null,
      userCorrectTier: null,
    };
    const gatewayVote = gatewayVoteRequestForClient(vote);
    expect(gatewayVote).toMatchObject({
      id: 'vabcdefabcdef',
      predictedTier: 'light',
      confidence: 0.75,
    });
    expect(sanitizeClientVoteRequestField({
      id: 'not-a-vote-id',
      prompt: 'x',
      predictedTier: 'light',
      confidence: 0.5,
    })).toBeUndefined();
    expect(sanitizeClientVoteRequestField({
      id: 'vabcdefabcdef',
      prompt: 'x',
      predictedTier: 'not-a-tier',
      confidence: 0.5,
    })).toBeUndefined();
    expect(sanitizeClientVoteRequestField({
      id: 'vabcdefabcdef',
      prompt: 'x',
      predictedTier: 'light',
      confidence: 1.5,
    })).toBeUndefined();
  });

  it('sanitizes message content parts and filters unknown usage detail keys', () => {
    const sanitized = sanitizeClientChatCompletionPayload({
      id: 'parts',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{
        index: 0,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
        completion_tokens_details: { reasoning_tokens: 1, evil_tokens: 99 },
        evil_tokens_details: { cached_tokens: 1 },
      },
    });
    const message = (sanitized.choices as any[])[0].message;
    expect(message.role).toBe('assistant');
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect((sanitized.usage as any).completion_tokens_details).toEqual({ reasoning_tokens: 1 });
    expect((sanitized.usage as any).completion_tokens_details).not.toHaveProperty('evil_tokens');
    expect(sanitized.usage).not.toHaveProperty('evil_tokens_details');
  });

  it('enforces choice text, finish_reason allowlist, and metadata string limits (B7/B9)', () => {
    const long = 'x'.repeat(300);
    const sanitized = sanitizeClientChatCompletionPayload({
      id: long,
      model: long,
      system_fingerprint: long,
      object: 'chat.completion',
      created: 1,
      choices: [{
        index: 0,
        text: 12345,
        finish_reason: 'evil_reason',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }, 'fallback/model');
    expect(sanitized.id).toMatch(/^chatcmpl-/);
    expect(sanitized.model).toBe('fallback/model');
    expect(sanitized).not.toHaveProperty('system_fingerprint');
    const choice = (sanitized.choices as any[])[0];
    expect(choice.message.content).toBeNull();
    expect(choice.finish_reason).toBeNull();
  });

  it('drops image_url parts and caps text part count (B8)', () => {
    const manyTextParts = Array.from({ length: 300 }, (_, i) => ({ type: 'text', text: `p${i}` }));
    const sanitized = sanitizeClientChatCompletionPayload({
      id: 'cap',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: manyTextParts },
        finish_reason: 'length',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    const parts = (sanitized.choices as any[])[0].message.content as Array<{ text: string }>;
    expect(parts).toHaveLength(256);
    expect(parts[0].text).toBe('p0');
    expect(parts[255].text).toBe('p255');
  });

  it('enforces logprobs size limits and byte constraints (B9)', () => {
    const hugeToken = 't'.repeat(2000);
    const invalidBytes = Array.from({ length: 10 }, () => 300);
    expect(sanitizeClientLogprobs({
      content: [{
        token: hugeToken,
        logprob: -1,
        top_logprobs: [],
      }],
    })).toBeUndefined();

    const capped = sanitizeClientLogprobs({
      content: Array.from({ length: 5000 }, (_, i) => ({
        token: `t${i}`,
        logprob: -0.1,
        bytes: [i % 256],
        top_logprobs: Array.from({ length: 30 }, (__, j) => ({ token: `u${j}`, logprob: -0.2, bytes: null })),
      })),
    })!;
    expect(capped.content).toHaveLength(4096);
    expect((capped.content as any[])[0].top_logprobs).toHaveLength(20);
    expect(sanitizeClientLogprobs({
      content: [{ token: 'ok', logprob: -1, bytes: invalidBytes, top_logprobs: [] }],
    })).toBeUndefined();
  });
});

describe('resolveRetryAfterSeconds', () => {
  const headers = (retryAfter: string) => ({ get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) });
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);

  it('rejects scientific notation, hex, and other non-decimal delay values', () => {
    expect(resolveRetryAfterSeconds(headers('1e20'), DEFAULT_RETRY_AFTER_SECONDS, now)).toBe(String(DEFAULT_RETRY_AFTER_SECONDS));
    expect(resolveRetryAfterSeconds(headers('0x10'), DEFAULT_RETRY_AFTER_SECONDS, now)).toBe(String(DEFAULT_RETRY_AFTER_SECONDS));
    expect(resolveRetryAfterSeconds(headers('not-a-date'), DEFAULT_RETRY_AFTER_SECONDS, now)).toBe(String(DEFAULT_RETRY_AFTER_SECONDS));
  });

  it('caps plain decimal delay-seconds at 300', () => {
    expect(resolveRetryAfterSeconds(headers('42'), DEFAULT_RETRY_AFTER_SECONDS, now)).toBe('42');
    expect(resolveRetryAfterSeconds(headers('9999'), DEFAULT_RETRY_AFTER_SECONDS, now)).toBe(String(MAX_RETRY_AFTER_SECONDS));
  });

  it('parses HTTP-date Retry-After as seconds until that time (clamped)', () => {
    const future = new Date(now + 90_000).toUTCString();
    expect(resolveRetryAfterSeconds(headers(future), DEFAULT_RETRY_AFTER_SECONDS, now)).toBe('90');
  });

  it('clamps past HTTP-date values to zero', () => {
    const past = new Date(now - 60_000).toUTCString();
    expect(resolveRetryAfterSeconds(headers(past), DEFAULT_RETRY_AFTER_SECONDS, now)).toBe('0');
  });
});

describe('provider quota throttle recording', () => {
  it('does not record quota throttle for overload-only 1305 responses', () => {
    const body = JSON.stringify({ error: { code: 1305, message: 'system overloaded' } });
    expect(shouldRecordProviderQuotaThrottle(1305, body)).toBe(false);
    expect(shouldRecordProviderQuotaThrottle(429, body)).toBe(false);
    expect(shouldRecordProviderQuotaThrottle(429, JSON.stringify({ error: { code: 'rate_limit_exceeded' } }))).toBe(true);
  });

  it('records throttle for classified rate_limit on non-429 HTTP statuses', () => {
    const rateLimitBody = JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } });
    expect(shouldRecordProviderQuotaThrottle(400, rateLimitBody, { rateLimitClassified: true })).toBe(true);
    expect(shouldRecordProviderQuotaThrottle(400, JSON.stringify({ error: { code: 1305 } }), { rateLimitClassified: true })).toBe(false);
  });

  it('records throttle for rate_limit failures in HTTP 200 bodies', () => {
    const rateLimitBody = { error: { code: 1308, message: 'quota' } };
    expect(shouldRecordProviderQuotaThrottle(200, rateLimitBody, { rateLimitClassified: true })).toBe(true);
    expect(shouldRecordProviderQuotaThrottle(200, { error: { code: 1305 } }, { rateLimitClassified: true })).toBe(false);
    expect(shouldRecordProviderQuotaThrottle(200, rateLimitBody)).toBe(false);
  });
});

describe('direct route upstream error sanitization', () => {
  let server: ReturnType<typeof createGatewayHttpServer>;
  let port = 0;

  beforeAll(async () => {
    process.env.ZAI_KEY = 'test-key';
    await initializeGatewayForTests();
    registerToolCapableZaiModel();
    server = createGatewayHttpServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalZaiKey === undefined) delete process.env.ZAI_KEY;
    else process.env.ZAI_KEY = originalZaiKey;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const leakMarkers = ['UPSTREAM_SECRET_DETAIL', 'evil-provider', 'evil-model-id'];

  it('caps abusive Retry-After delay-seconds on the direct route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'UPSTREAM_SECRET_DETAIL 429' } }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '1e20',
        },
      },
    )));

    const payload = JSON.stringify({
      model: 'zai/glm-5.3',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const response = await postJson(port, payload);
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe(String(DEFAULT_RETRY_AFTER_SECONDS));
  });

  it('returns 429 with Retry-After for upstream rate limits without leaking body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'UPSTREAM_SECRET_DETAIL 429', code: 'rate_limit' } }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '42',
        },
      },
    )));

    const payload = JSON.stringify({
      model: 'zai/glm-5.3',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const response = await postJson(port, payload);
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('42');
    const parsed = JSON.parse(response.body);
    expect(parsed.error).toEqual(CLIENT_RATE_LIMIT_ERROR);
    expect(response.body).not.toContain('UPSTREAM_SECRET_DETAIL');
  });

  it('does not record provider quota throttle on direct-route 1305 overload', async () => {
    const recordSpy = vi.spyOn(providerQuota, 'record429');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 1305, message: 'UPSTREAM_SECRET_DETAIL overload' } }),
      { status: 1305, headers: { 'Content-Type': 'application/json' } },
    )));

    const payload = JSON.stringify({
      model: 'zai/glm-5.3',
      messages: [{ role: 'user', content: 'hello' }],
    });
    await postJson(port, payload);
    expect(recordSpy).not.toHaveBeenCalled();
    recordSpy.mockRestore();
  });

  it.each([
    [400, CLIENT_PROVIDER_ERROR],
    [500, CLIENT_PROVIDER_ERROR],
    [502, CLIENT_PROVIDER_ERROR],
    [504, CLIENT_TIMEOUT_ERROR],
  ])('upstream HTTP %i does not leak provider payload to the client', async (upstreamStatus, expectedError) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({
        error: { message: `UPSTREAM_SECRET_DETAIL ${upstreamStatus}` },
        provider: 'evil-provider',
        model: 'evil-model-id',
      }),
      { status: upstreamStatus, headers: { 'Content-Type': 'application/json' } },
    )));

    const payload = JSON.stringify({
      model: 'zai/glm-5.3',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const response = await postJson(port, payload);
    const expectedHttpStatus = upstreamStatus === 504 ? 504 : 502;
    expect(response.status).toBe(expectedHttpStatus);
    const parsed = JSON.parse(response.body);
    expect(parsed.error).toEqual(expectedError);
    for (const marker of leakMarkers) {
      expect(response.body).not.toContain(marker);
    }
  });
});
