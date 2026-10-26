import { createServer, request as httpRequest, type ClientRequest } from 'node:http';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { modelMatrix } from '../src/model-matrix.js';
import {
  buildDirectHttpProviderRequest,
  CLIENT_GATEWAY_ERROR,
  CLIENT_INTERNAL_ERROR,
  createGatewayHttpServer,
  DRAIN_BODY_MAX_MS,
  getMaxBodyBytes,
  resolveBodyReadIdleMs,
  initializeGatewayForTests,
  parseBody,
  RequestBodyError,
  respondRequestBodyError,
  sanitizeMessagesForToolCalling,
} from '../src/moma-gateway.js';

function registerToolCapableZaiModel(): void {
  modelMatrix.upsertModel({
    id: 'glm-5.3',
    provider: 'zai',
    name: 'glm-5.3',
    supportsTools: true,
  });
}

const originalMaxBody = process.env.MOMA_MAX_BODY_BYTES;

function postJson(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
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

/** Stream a large POST body in chunks (closer to real clients than a single write). */
function postJsonChunked(port: number, path: string, body: string, chunkSize = 16 * 1024): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest;
    const start = () => {
      let offset = 0;
      const writeNext = () => {
        if (offset >= body.length) {
          req.end();
          return;
        }
        const slice = body.slice(offset, offset + chunkSize);
        offset += slice.length;
        if (!req.write(slice)) req.once('drain', writeNext);
        else writeNext();
      };
      writeNext();
    };
    req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
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
    start();
  });
}

function getPath(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Chunked POST that exceeds the body limit, then keeps sending chunks without ending
 * (simulates a client that never terminates the upload).
 */
/** Opens a chunked upload, sends one chunk, then stalls (no end, no further chunks). */
function postStalledChunkedUpload(
  port: number,
  path: string,
  firstChunk: string,
): Promise<{ status: number; body: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const writeChunk = (req: ClientRequest, data: string) => {
      const size = Buffer.byteLength(data);
      req.write(`${size.toString(16)}\r\n${data}\r\n`);
    };
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            elapsedMs: Date.now() - started,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    writeChunk(req, firstChunk);
  });
}

function postNeverEndingChunkedUpload(
  port: number,
  path: string,
  oversizePrefix: string,
): Promise<{ status: number; body: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let interval: ReturnType<typeof setInterval> | undefined;
    const writeChunk = (req: ClientRequest, data: string) => {
      const size = Buffer.byteLength(data);
      req.write(`${size.toString(16)}\r\n${data}\r\n`);
    };

    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (interval) clearInterval(interval);
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            elapsedMs: Date.now() - started,
          });
        });
        res.on('error', reject);
      },
    );

    req.on('error', (err) => {
      if (interval) clearInterval(interval);
      reject(err);
    });

    writeChunk(req, oversizePrefix);
    interval = setInterval(() => {
      if (req.destroyed) {
        if (interval) clearInterval(interval);
        return;
      }
      writeChunk(req, 'x'.repeat(512));
    }, 40);
  });
}

function getHealth(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('MoMA gateway direct route tool calling', () => {
  const toolConversation = [
    { role: 'user', content: 'call echo' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'echo', arguments: '{"text":"hi"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'PONG-7731' },
  ];

  it('drops tool messages without tool_call_id', () => {
    const withOrphanTool = [
      ...toolConversation,
      { role: 'tool', content: 'orphan' },
    ];
    const sanitized = sanitizeMessagesForToolCalling(withOrphanTool);
    expect(sanitized.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(sanitized.find((m) => m.role === 'tool')?.content).toBe('PONG-7731');
  });

  it('preserves assistant tool_calls and matching tool results', () => {
    const sanitized = sanitizeMessagesForToolCalling(toolConversation);
    expect(sanitized.some((m) => m.role === 'tool' && m.content === 'PONG-7731')).toBe(true);
    expect(sanitized.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call_1')).toBe(true);
  });

  it('keeps tool messages with empty string content', () => {
    const withEmptyToolResult = [
      ...toolConversation.slice(0, 2),
      { role: 'tool', tool_call_id: 'call_1', content: '' },
    ];
    const sanitized = sanitizeMessagesForToolCalling(withEmptyToolResult);
    const toolMsg = sanitized.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toBe('');
  });

  it('does not merge consecutive assistant messages when either has tool_calls', () => {
    const consecutiveAssistants = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'first' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'fn', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'ok' },
    ];
    const sanitized = sanitizeMessagesForToolCalling(consecutiveAssistants);
    const assistants = sanitized.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0].content).toBe('first');
    expect(assistants[1].tool_calls?.[0]?.id).toBe('call_a');
  });

  it('removes tool results for dropped ids when parallel tool_calls are incomplete', () => {
    const partialParallel = [
      { role: 'user', content: 'parallel tools' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_keep', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_drop', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_keep', content: 'kept' },
    ];
    const sanitized = sanitizeMessagesForToolCalling(partialParallel);
    expect(sanitized.filter((m) => m.role === 'tool')).toHaveLength(0);
    const assistant = sanitized.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls ?? []).toHaveLength(0);
    expect(assistant?.content).toBe('[tool use]');
  });

  it('includes tool results in the direct HTTP provider payload', () => {
    registerToolCapableZaiModel();
    const body = {
      model: 'zai/glm-5.3',
      tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: {} } } }],
    };
    const built = buildDirectHttpProviderRequest(body, toolConversation, 'zai', 'glm-5.3');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const messages = built.payload.messages as Array<{ role: string; content?: string }>;
    expect(messages.find((m) => m.role === 'tool')?.content).toBe('PONG-7731');
    expect(built.payload.tools).toEqual(body.tools);
  });

  it('mock upstream receives tool results on the direct-route payload', async () => {
    registerToolCapableZaiModel();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const upstreamBody = JSON.parse(String(init?.body));
      const toolMsg = upstreamBody.messages.find((m: { role: string }) => m.role === 'tool');
      expect(toolMsg?.content).toBe('PONG-7731');
      return new Response(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const built = buildDirectHttpProviderRequest(
      {
        model: 'zai/glm-5.3',
        tools: [{ type: 'function', function: { name: 'echo', parameters: {} } }],
      },
      toolConversation,
      'zai',
      'glm-5.3',
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    await fetch('https://mock-provider.example/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(built.payload),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe('MoMA gateway request body limits', () => {
  let server: ReturnType<typeof createGatewayHttpServer>;
  let port = 0;

  beforeAll(async () => {
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
  });

  afterEach(() => {
    if (originalMaxBody === undefined) delete process.env.MOMA_MAX_BODY_BYTES;
    else process.env.MOMA_MAX_BODY_BYTES = originalMaxBody;
  });

  it('times out stalled chunked uploads on body read idle and keeps serving', async () => {
    process.env.MOMA_BODY_READ_IDLE_MS = '600';
    const idleMs = resolveBodyReadIdleMs();
    const first = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

    const stalled = await postStalledChunkedUpload(port, '/v1/chat/completions', first);
    expect(stalled.status).toBe(408);
    expect(stalled.elapsedMs).toBeLessThan(idleMs + 2_500);

    const healthy = await getHealth(port);
    expect(healthy.status).toBe(200);
  }, 15_000);

  it('cuts off a never-ending chunked upload promptly and keeps serving', async () => {
    process.env.MOMA_MAX_BODY_BYTES = '512';
    const limit = getMaxBodyBytes();
    const prefix = JSON.stringify({ messages: [{ role: 'user', content: 'y'.repeat(limit) }] });

    const rejected = await postNeverEndingChunkedUpload(port, '/v1/chat/completions', prefix);
    expect(rejected.status).toBe(413);
    expect(rejected.elapsedMs).toBeLessThan(DRAIN_BODY_MAX_MS + 2_000);

    const healthy = await getHealth(port);
    expect(healthy.status).toBe(200);
  }, 15_000);

  it('returns 413 for bodies over the limit and keeps serving subsequent requests', async () => {
    process.env.MOMA_MAX_BODY_BYTES = String(64 * 1024);
    const limit = getMaxBodyBytes();
    const oversized = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(limit) }] });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(limit);

    const rejected = await postJsonChunked(port, '/v1/chat/completions', oversized);
    expect(rejected.status).toBe(413);
    const rejectedJson = JSON.parse(rejected.body);
    expect(rejectedJson.error.message).toContain(`limit ${limit} bytes`);

    const healthy = await getHealth(port);
    expect(healthy.status).toBe(200);
    expect(JSON.parse(healthy.body).status).toBe('healthy');
  });

  it('does not leak internal details in HTTP 500 and 502 test routes', async () => {
    const internal = await getPath(port, '/__test__/internal-error');
    expect(internal.status).toBe(500);
    expect(internal.body).not.toContain('secret-internal-database-host');
    expect(internal.body).toContain(CLIENT_INTERNAL_ERROR.message);

    const gateway = await getPath(port, '/__test__/bad-gateway');
    expect(gateway.status).toBe(502);
    expect(gateway.body).not.toContain('secret-upstream-detail');
    expect(gateway.body).toContain(CLIENT_GATEWAY_ERROR.message);
  });
});

describe('MoMA gateway body parser error messages', () => {
  afterEach(() => {
    if (originalMaxBody === undefined) delete process.env.MOMA_MAX_BODY_BYTES;
    else process.env.MOMA_MAX_BODY_BYTES = originalMaxBody;
  });

  it('states the configured byte limit on 413', async () => {
    process.env.MOMA_MAX_BODY_BYTES = '1024';
    const server = createServer(async (req, res) => {
      try {
        await parseBody(req);
        res.writeHead(200);
        res.end('ok');
      } catch (err) {
        if (err instanceof RequestBodyError) {
          respondRequestBodyError(req, res, err);
        }
      }
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const body = JSON.stringify({ hello: 'world'.repeat(300) });
    const response = await postJson(port, '/', body);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body).error.message).toBe('request body too large (limit 1024 bytes)');
  });
});
