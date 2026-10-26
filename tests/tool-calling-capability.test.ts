import { beforeAll, describe, expect, it, vi } from 'vitest';
import { modelMatrix } from '../src/model-matrix.js';
import {
  evaluateToolCallingCapability,
  normalizeUpstreamModelId,
  TOOL_CAPABLE_HTTP_PROVIDER_IDS,
} from '../src/tool-calling-capability.js';
import { buildDirectHttpProviderRequest, initializeGatewayForTests } from '../src/moma-gateway.js';

describe('normalizeUpstreamModelId', () => {
  it('preserves multi-segment upstream model ids', () => {
    expect(normalizeUpstreamModelId('openrouter', 'z-ai/glm-5.3')).toBe('z-ai/glm-5.3');
    expect(normalizeUpstreamModelId('openrouter', 'openrouter/z-ai/glm-5.3')).toBe('z-ai/glm-5.3');
  });

  it('strips only the provider prefix for simple ids', () => {
    expect(normalizeUpstreamModelId('zai', 'glm-5.3')).toBe('glm-5.3');
    expect(normalizeUpstreamModelId('zai', 'zai/glm-5.3')).toBe('glm-5.3');
  });
});

describe('evaluateToolCallingCapability', () => {
  beforeAll(async () => {
    await initializeGatewayForTests();
  });

  it('allows unknown models on allowlisted providers without a matrix entry', () => {
    expect(TOOL_CAPABLE_HTTP_PROVIDER_IDS.has('zai')).toBe(true);
    const verdict = evaluateToolCallingCapability('zai', 'glm-unknown-new');
    expect(verdict.allowed).toBe(true);
    expect(verdict.source === 'allowlist' || verdict.source === 'unknown').toBe(true);
  });

  it('blocks models explicitly marked as not tool-capable in the matrix', () => {
    modelMatrix.upsertModel({
      id: 'text-only',
      provider: 'mockprov',
      name: 'text-only',
      supportsTools: false,
    });
    const verdict = evaluateToolCallingCapability('mockprov', 'text-only');
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.source).toBe('matrix');
  });

  it('warns and allows unknown models on non-allowlisted providers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const verdict = evaluateToolCallingCapability('custom-http', 'some-model');
    expect(verdict.allowed).toBe(true);
    expect(verdict.source).toBe('unknown');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('buildDirectHttpProviderRequest upstream model id', () => {
  const toolBody = {
    tools: [{ type: 'function', function: { name: 'echo', parameters: {} } }],
  };
  const messages = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'echo', arguments: '{}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ];

  it('forwards multi-segment model ids to the provider payload', () => {
    const built = buildDirectHttpProviderRequest(toolBody, messages, 'openrouter', 'z-ai/glm-5.3');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.cleanModel).toBe('z-ai/glm-5.3');
    expect(built.payload.model).toBe('z-ai/glm-5.3');
  });
});
