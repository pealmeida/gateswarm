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
  DEFAULT_RETRY_AFTER_SECONDS,
  initializeGatewayForTests,
} from '../src/moma-gateway.js';
import { agentRegistry, DEFAULT_CLI_PROVIDERS } from '../src/agent-registry.js';

function registerClaudeCliForTests(): void {
  if (agentRegistry.isCliProvider('claude-cli')) return;
  agentRegistry.registerCliProvider(DEFAULT_CLI_PROVIDERS['claude-cli']);
}

const originalBailianKey = process.env.BAILIAN_KEY;
const originalZaiKey = process.env.ZAI_KEY;

function postJson(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
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

  it('returns 502 chain exhaustion when later providers are skipped after an earlier rate limit', async () => {
    mockStaticLightRouting();
    vi.spyOn(providerHealth, 'getSkipReason').mockImplementation((providerId) => (
      providerId === 'bailian' ? null : 'cooldown skip'
    ));
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )));

    const response = await postJson(port, routedRequest());
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body).error).toEqual(CLIENT_PROVIDER_CHAIN_EXHAUSTED);
  });

  it('returns 429 with Retry-After when the chain exhausts on rate limits', async () => {
    mockStaticLightRouting();
    mockHealthyProviders();
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
    vi.spyOn(consumptionIntelligence, 'getFallback').mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '15' },
      },
    )));

    const response = await postJson(port, routedRequest());
    expect(response.status).toBe(429);
    expect(JSON.parse(response.body).error).toEqual(CLIENT_RATE_LIMIT_ERROR);
    expect(response.headers['retry-after']).toBe(String(DEFAULT_RETRY_AFTER_SECONDS));
  });

  it('does not record model matrix errors for HTTP 4xx bodies with overload code 1305', async () => {
    mockStaticLightRouting();
    mockHealthyProviders();
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
    vi.spyOn(consumptionIntelligence, 'getFallback').mockResolvedValue(null);
    const recordError = vi.spyOn(modelMatrix, 'recordError');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 1305, message: 'overload' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )));

    await postJson(port, routedRequest());
    expect(recordError).not.toHaveBeenCalled();
  });

  it('does not record model matrix errors for HTTP 200 bodies with overload code 1305', async () => {
    mockStaticLightRouting();
    mockHealthyProviders();
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
    vi.spyOn(consumptionIntelligence, 'getFallback').mockResolvedValue(null);
    const recordError = vi.spyOn(modelMatrix, 'recordError');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        error: { code: 1305, message: 'overload' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await postJson(port, routedRequest());
    expect(recordError).not.toHaveBeenCalled();
  });

  it('succeeds when benchmark logging directory is missing (non-fatal logger)', async () => {
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
    const defaultAgent = agentRegistry.getAgent('default');
    if (defaultAgent) defaultAgent.benchmarkEnabled = true;

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
        provider: 'evil-provider-should-not-appear',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const response = await postJson(port, routedRequest());
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('UPSTREAM_SECRET_DETAIL');
    expect(response.body).not.toContain('evil-provider-should-not-appear');
    expect(JSON.parse(response.body).choices?.[0]?.message?.content).toBe('fallback ok');
  });

  it('falls back when CLI stdout is rate-limit text despite exit 0', async () => {
    registerClaudeCliForTests();
    vi.spyOn(consumptionIntelligence, 'selectModel').mockResolvedValue({
      provider: 'claude-cli',
      model: 'cc/test-model',
      tier: 'heavy',
      reason: 'static_fallback',
      estimatedTokens: 32,
      estimatedCost: 0,
      confidence: 1,
      alternatives: [],
      source: 'request',
      timestamp: Date.now(),
    });
    vi.spyOn(consumptionIntelligence, 'getFallback').mockResolvedValue({
      provider: 'zai',
      model: 'glm-4.7-flash',
      tier: 'heavy',
      reason: 'static_fallback',
      estimatedTokens: 32,
      estimatedCost: 0,
      confidence: 1,
      alternatives: [],
      source: 'request',
      timestamp: Date.now(),
    });
    mockHealthyProviders();
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
    vi.spyOn(agentRegistry, 'checkCliProviderAvailability').mockResolvedValue({ ok: true });
    vi.spyOn(agentRegistry, 'getCliAdapter').mockReturnValue({
      chatCompletion: vi.fn().mockResolvedValue({
        content: 'Rate limit exceeded. Please try again later.',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        model: 'cc/test-model',
      }),
    } as any);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'chatcmpl-ok',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'fallback ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const response = await postJson(port, routedRequest({ effort_override: 'heavy' }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).choices?.[0]?.message?.content).toBe('fallback ok');
    expect(response.body).not.toContain('Rate limit exceeded');
  });

  it('returns 429 when routed forward chain exhausts on CLI rate-limit stdout', async () => {
    registerClaudeCliForTests();
    vi.spyOn(consumptionIntelligence, 'selectModel').mockResolvedValue({
      provider: 'claude-cli',
      model: 'cc/test-model',
      tier: 'heavy',
      reason: 'static_fallback',
      estimatedTokens: 32,
      estimatedCost: 0,
      confidence: 1,
      alternatives: [],
      source: 'request',
      timestamp: Date.now(),
    });
    vi.spyOn(consumptionIntelligence, 'getFallback').mockResolvedValue(null);
    mockHealthyProviders();
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
    vi.spyOn(agentRegistry, 'checkCliProviderAvailability').mockResolvedValue({ ok: true });
    vi.spyOn(agentRegistry, 'getCliAdapter').mockReturnValue({
      chatCompletion: vi.fn().mockResolvedValue({
        content: 'Rate limit exceeded. Please try again later.',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        model: 'cc/test-model',
      }),
    } as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )));

    const response = await postJson(port, routedRequest({ effort_override: 'heavy' }));
    expect(response.status).toBe(429);
    expect(JSON.parse(response.body).error).toEqual(CLIENT_RATE_LIMIT_ERROR);
    expect(response.body).not.toContain('Rate limit exceeded');
    expect(response.headers['retry-after']).toBe(String(DEFAULT_RETRY_AFTER_SECONDS));
  });

  it('does not record model matrix errors for CLI stdout API Error: 1305 (R7-N3)', async () => {
    registerClaudeCliForTests();
    vi.spyOn(consumptionIntelligence, 'selectModel').mockResolvedValue({
      provider: 'claude-cli',
      model: 'cc/test-model',
      tier: 'heavy',
      reason: 'static_fallback',
      estimatedTokens: 32,
      estimatedCost: 0,
      confidence: 1,
      alternatives: [],
      source: 'request',
      timestamp: Date.now(),
    });
    vi.spyOn(consumptionIntelligence, 'getFallback').mockResolvedValue(null);
    mockHealthyProviders();
    vi.spyOn(providerQuota, 'shouldSwitch').mockReturnValue({ shouldSwitch: false, reason: '' });
    const recordError = vi.spyOn(modelMatrix, 'recordError');
    const record429 = vi.spyOn(providerQuota, 'record429');
    vi.spyOn(agentRegistry, 'checkCliProviderAvailability').mockResolvedValue({ ok: true });
    vi.spyOn(agentRegistry, 'getCliAdapter').mockReturnValue({
      chatCompletion: vi.fn().mockResolvedValue({
        content: 'API Error: 1305 system overloaded',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
        model: 'cc/test-model',
      }),
    } as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 1305, message: 'overload' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )));

    await postJson(port, routedRequest({ effort_override: 'heavy' }));
    expect(recordError).not.toHaveBeenCalled();
    expect(record429).not.toHaveBeenCalled();
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
