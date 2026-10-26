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
  initializeGatewayForTests,
  shouldRecordProviderQuotaThrottle,
} from '../src/moma-gateway.js';

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

describe('provider quota throttle recording', () => {
  it('does not record quota throttle for overload-only 1305 responses', () => {
    const body = JSON.stringify({ error: { code: 1305, message: 'system overloaded' } });
    expect(shouldRecordProviderQuotaThrottle(1305, body)).toBe(false);
    expect(shouldRecordProviderQuotaThrottle(429, body)).toBe(false);
    expect(shouldRecordProviderQuotaThrottle(429, JSON.stringify({ error: { code: 'rate_limit_exceeded' } }))).toBe(true);
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
