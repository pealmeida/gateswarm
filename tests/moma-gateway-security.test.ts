import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentListItem,
  hasAdminAccess,
  shouldRefuseUnauthenticatedAdmin,
  parseBody,
  redactAgentForResponse,
  upstreamFailureMetadata,
} from '../src/moma-gateway.js';
import type { AgentConfig } from '../src/agent-registry.js';

const originalAdminToken = process.env.MOMA_ADMIN_TOKEN;
const originalMaxBodyBytes = process.env.MOMA_MAX_BODY_BYTES;

afterEach(() => {
  if (originalAdminToken === undefined) delete process.env.MOMA_ADMIN_TOKEN;
  else process.env.MOMA_ADMIN_TOKEN = originalAdminToken;
  if (originalMaxBodyBytes === undefined) delete process.env.MOMA_MAX_BODY_BYTES;
  else process.env.MOMA_MAX_BODY_BYTES = originalMaxBodyBytes;
});

function bodyRequest(body: string) {
  const request = new PassThrough();
  const parsed = parseBody(request as unknown as IncomingMessage);
  request.end(body);
  return { request, parsed };
}

const agent: AgentConfig = {
  id: 'test-agent',
  name: 'Test Agent',
  apiKey: 'moma-registered-secret-9abc',
  provider: 'moma',
  tierConfig: {
    trivial: 'zai/glm-4.5-air',
    light: 'zai/glm-4.5-air',
    moderate: 'zai/glm-4.5-air',
    heavy: 'zai/glm-4.5-air',
    intensive: 'zai/glm-4.5-air',
    extreme: 'zai/glm-4.5-air',
  },
  benchmarkEnabled: true,
  maxTokensPerRequest: 4096,
  createdAt: '2026-07-12T00:00:00.000Z',
  lastUsed: null,
  requestCount: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
};

describe('MoMA gateway security helpers', () => {
  it('requires the configured admin token and accepts either supported header', () => {
    process.env.MOMA_ADMIN_TOKEN = 'admin-token';

    expect(hasAdminAccess({})).toBe(false);
    expect(hasAdminAccess({ 'x-admin-token': 'wrong-token' })).toBe(false);
    expect(hasAdminAccess({ 'x-admin-token': 'admin-token' })).toBe(true);
    expect(hasAdminAccess({ authorization: 'Bearer admin-token' })).toBe(true);
  });

  it('fails closed for non-loopback bindings without an admin token', () => {
    expect(shouldRefuseUnauthenticatedAdmin('0.0.0.0', '', '')).toBe(true);
    expect(shouldRefuseUnauthenticatedAdmin('192.0.2.10', '', '')).toBe(true);
    expect(shouldRefuseUnauthenticatedAdmin('127.0.0.1', '', '')).toBe(false);
    expect(shouldRefuseUnauthenticatedAdmin('::1', '', '')).toBe(false);
    expect(shouldRefuseUnauthenticatedAdmin('0.0.0.0', 'admin-token', '')).toBe(false);
    expect(shouldRefuseUnauthenticatedAdmin('0.0.0.0', '', 'true')).toBe(false);
  });

  it('enforces the configured request body cap with a 413 error', async () => {
    process.env.MOMA_MAX_BODY_BYTES = '4';
    const { request, parsed } = bodyRequest('12345');

    await expect(parsed).rejects.toMatchObject({
      status: 413,
      message: 'request body too large',
    });
    expect(request.isPaused()).toBe(true);
  });

  it('rejects malformed JSON with a 400 error instead of treating it as an empty body', async () => {
    const { parsed } = bodyRequest('{invalid-json');

    await expect(parsed).rejects.toMatchObject({
      status: 400,
      message: 'invalid JSON body',
    });
  });

  it('redacts API keys in both list and single-agent response views', () => {
    const listResponse = agentListItem(agent);
    const getResponse = redactAgentForResponse(agent);

    expect(listResponse.apiKey).toBe('***9abc');
    expect(getResponse.apiKey).toBe('***9abc');
    expect(JSON.stringify([listResponse, getResponse])).not.toContain(agent.apiKey);
  });

  it('bounds and redacts upstream error metadata', () => {
    const metadata = upstreamFailureMetadata(
      'example-provider',
      401,
      JSON.stringify({ error: { code: 'invalid_api_key', message: 'token=sk-supersecretkey123456' } }),
    );

    expect(metadata).toMatchObject({ provider: 'example-provider', status: 401, code: 'invalid_api_key' });
    expect(metadata.bodyPrefix).toContain('[REDACTED_API_KEY]');
    expect(metadata.bodyPrefix).not.toContain('sk-supersecretkey123456');
    expect(metadata.bodyPrefix.length).toBeLessThanOrEqual(200);
  });
});
