import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { providerHealth } from '../src/adapters/provider-health.js';
import { consumptionIntelligence } from '../src/consumption-intelligence.js';
import { modelMatrix } from '../src/model-matrix.js';
import { providerQuota } from '../src/provider-quota.js';
import {
  CLIENT_PROVIDER_CHAIN_EXHAUSTED,
  CLIENT_RATE_LIMIT_ERROR,
  createGatewayHttpServer,
  initializeGatewayForTests,
} from '../src/moma-gateway.js';

const originalBailianKey = process.env.BAILIAN_KEY;
const originalZaiKey = process.env.ZAI_KEY;

function postJson(port: number, body: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function routedRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gateswarm-router',
    effort_override: 'light',
    stream: false,
    messages: [{ role: 'user', content: 'Explain consensus algorithms in distributed systems with detail.' }],
    ...overrides,
  };
}

function registerLightTierModels(): void {
  modelMatrix.upsertModel({ id: 'qwen3.8-flash', provider: 'bailian', name: 'qwen3.8-flash' });
  modelMatrix.upsertModel({ id: 'glm-4.7-flash', provider: 'zai', name: 'glm-4.7-flash', supportsTools: true });
}

function mockStaticLightRouting(): void {
  vi.spyOn(consumptionIntelligence, 'selectModel').mockResolvedValue({
    provider: 'bailian',
    model: 'qwen3.8-flash',
    tier: 'light',
    reason: 'static_fallback',
    estimatedTokens: 32,
    estimatedCost: 0,
    confidence: 1,
    alternatives: [],
    source: 'request',
    timestamp: Date.now(),
  });
  vi.spyOn(consumptionIntelligence, 'getFallback').mockResolvedValue(null);
}

describe('MoMA routed forward chain', () => {
  let server: ReturnType<typeof createGatewayHttpServer>;
  let port = 0;

  beforeAll(async () => {
    process.env.BAILIAN_KEY = 'test-bailian-key';
    process.env.ZAI_KEY = 'test-zai-key';
    await initializeGatewayForTests();
    await providerQuota.initialize();
    registerLightTierModels();
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
    if (originalBailianKey === undefined) delete process.env.BAILIAN_KEY;
    else process.env.BAILIAN_KEY = originalBailianKey;
    if (originalZaiKey === undefined) delete process.env.ZAI_KEY;
    else process.env.ZAI_KEY = originalZaiKey;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mockHealthyProviders(): void {
    vi.spyOn(providerHealth, 'getSkipReason').mockReturnValue(null);
  }

  it('returns sanitized chain exhaustion when the last provider answers 200 with an error body', async () => {
    mockStaticLightRouting();
    mockHealthyProviders();
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'UPSTREAM_SECRET_DETAIL', code: 'invalid_api_key' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    const response = await postJson(port, routedRequest());
    expect(response.status).toBe(502);
    const parsed = JSON.parse(response.body);
    expect(parsed.error).toEqual(CLIENT_PROVIDER_CHAIN_EXHAUSTED);
    expect(response.body).not.toContain('UPSTREAM_SECRET_DETAIL');
  });

  it('falls back after a 200 error body and does not leak the first provider payload', async () => {
    mockStaticLightRouting();
    mockHealthyProviders();
    vi.spyOn(consumptionIntelligence, 'getFallback').mockResolvedValue({
      provider: 'zai',
      model: 'glm-4.7-flash',
      tier: 'light',
      reason: 'static_fallback',
      estimatedTokens: 32,
      estimatedCost: 0,
      confidence: 1,
      alternatives: [],
      source: 'request',
      timestamp: Date.now(),
    });
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
    const recordSuccess = vi.spyOn(providerQuota, 'recordSuccess');

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'UPSTREAM_SECRET_DETAIL', code: 'invalid_api_key' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl-ok',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'fallback ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const response = await postJson(port, routedRequest());
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('UPSTREAM_SECRET_DETAIL');
    const parsed = JSON.parse(response.body);
    expect(parsed.choices?.[0]?.message?.content).toBe('fallback ok');
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(recordSuccess).toHaveBeenCalledWith('zai');
  });

  it('does not mark models unavailable after three consecutive 1305 overload responses', async () => {
    mockStaticLightRouting();
    mockHealthyProviders();
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
    const recordError = vi.spyOn(modelMatrix, 'recordError');
    modelMatrix.upsertModel({ id: 'qwen3.8-flash', provider: 'bailian', name: 'qwen3.8-flash', available: true });

    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 1305, message: 'overload' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 3; i += 1) {
      await postJson(port, routedRequest());
    }

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(recordError).not.toHaveBeenCalled();
    const entry = modelMatrix.getModel('bailian', 'qwen3.8-flash');
    expect(entry?.available).not.toBe(false);
    expect(entry?.consecutiveFailures ?? 0).toBeLessThan(3);
  });
});
