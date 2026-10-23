import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelMatrix } from '../src/model-matrix.js';
import {
  CLIENT_PROVIDER_ERROR,
  CLIENT_TIMEOUT_ERROR,
  clientHttpResponseForUpstreamFailure,
  createGatewayHttpServer,
  initializeGatewayForTests,
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

function postJson(port: number, body: string): Promise<{ status: number; body: string }> {
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
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
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

  it('maps other upstream failures to generic provider error', () => {
    for (const status of [400, 500, 502]) {
      expect(clientHttpResponseForUpstreamFailure(status)).toEqual({
        httpStatus: 502,
        error: CLIENT_PROVIDER_ERROR,
      });
    }
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
