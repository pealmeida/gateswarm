import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelMatrix } from '../src/model-matrix.js';
import {
  buildDirectHttpProviderRequest,
  CLIENT_GATEWAY_ERROR,
  CLIENT_PROVIDER_ERROR,
  DEFAULT_MAX_BODY_BYTES,
  handleUnhandledRejection,
  initializeGatewayForTests,
  logGatewayFailure,
  MAX_BODY_BYTES_UPPER_BOUND,
  resolveMaxBodyBytes,
  validateToolCallingConversation,
} from '../src/moma-gateway.js';

const originalMaxBody = process.env.MOMA_MAX_BODY_BYTES;

afterEach(() => {
  if (originalMaxBody === undefined) delete process.env.MOMA_MAX_BODY_BYTES;
  else process.env.MOMA_MAX_BODY_BYTES = originalMaxBody;
  vi.restoreAllMocks();
});

describe('MOMA_MAX_BODY_BYTES resolution', () => {
  it('uses the default when unset', () => {
    expect(resolveMaxBodyBytes({})).toBe(DEFAULT_MAX_BODY_BYTES);
  });

  it('accepts a valid configured value', () => {
    expect(resolveMaxBodyBytes({ MOMA_MAX_BODY_BYTES: '2048' })).toBe(2048);
  });

  it('falls back to the default for invalid values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveMaxBodyBytes({ MOMA_MAX_BODY_BYTES: 'not-a-number' })).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(warn).toHaveBeenCalled();
  });

  it('caps values above the upper bound', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const over = String(MAX_BODY_BYTES_UPPER_BOUND + 1);
    expect(resolveMaxBodyBytes({ MOMA_MAX_BODY_BYTES: over })).toBe(MAX_BODY_BYTES_UPPER_BOUND);
    expect(warn).toHaveBeenCalled();
  });
});

describe('unhandled rejection guard', () => {
  it('exits the process for non-RequestBodyError rejections after logging', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const internal = new Error('sensitive-internal-detail');

    handleUnhandledRejection(internal);

    expect(errLog.mock.calls.join(' ')).toContain('Unhandled rejection');
    expect(errLog.mock.calls.join(' ')).toContain('sensitive-internal-detail');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('client-facing gateway errors', () => {
  it('does not leak internal exception text in generic client error messages', () => {
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const internal = new Error('Connection refused: secret-internal-service:5432');
    logGatewayFailure('provider forward', internal);

    expect(CLIENT_GATEWAY_ERROR.message).not.toContain('secret-internal-service');
    expect(CLIENT_PROVIDER_ERROR.message).not.toContain('secret-internal-service');
    expect(errLog.mock.calls.flat().join(' ')).toContain('secret-internal-service');
  });
});

describe('direct route tool policy', () => {
  beforeAll(async () => {
    await initializeGatewayForTests();
  });

  const toolBody = {
    tools: [{ type: 'function', function: { name: 'echo', parameters: {} } }],
  };

  const validConversation = [
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

  it('returns 400 tools_not_supported when the model is not tool-capable', () => {
    modelMatrix.upsertModel({
      id: 'no-tools',
      provider: 'mockprov',
      name: 'no-tools',
      supportsTools: false,
    });

    const result = buildDirectHttpProviderRequest(toolBody, validConversation, 'mockprov', 'no-tools');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error.type).toBe('tools_not_supported');
  });

  it('rejects more than 64 tool_calls on an assistant message', () => {
    modelMatrix.upsertModel({
      id: 'with-tools',
      provider: 'mockprov',
      name: 'with-tools',
      supportsTools: true,
    });
    const tooMany = Array.from({ length: 65 }, (_, index) => ({
      id: `call_${index}`,
      type: 'function',
      function: { name: 'echo', arguments: '{}' },
    }));
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: tooMany },
    ];
    const result = buildDirectHttpProviderRequest(toolBody, messages, 'mockprov', 'with-tools');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('invalid_tool_calls');
  });

  it('returns 400 invalid_tool_calls for malformed tool_calls', () => {
    modelMatrix.upsertModel({
      id: 'with-tools',
      provider: 'mockprov',
      name: 'with-tools',
      supportsTools: true,
    });

    const malformed = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ type: 'function', function: { name: 'echo' } }],
      },
    ];

    const validation = validateToolCallingConversation(malformed);
    expect(validation.ok).toBe(false);

    const result = buildDirectHttpProviderRequest(toolBody, malformed, 'mockprov', 'with-tools');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error.type).toBe('invalid_tool_calls');
  });
});
