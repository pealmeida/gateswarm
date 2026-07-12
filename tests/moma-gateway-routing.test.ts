import { describe, expect, it } from 'vitest';
import {
  buildHttpProviderPayload,
  cliFailureResponse,
  fallbackAttemptTimeoutMs,
  IncrementalSseParser,
  isGreetingFastPathEligible,
  jsonCompletionToSseEvents,
  scoreWithEffortOverride,
} from '../src/moma-gateway.js';

describe('MoMA gateway routing helpers', () => {
  it('uses the greeting fast path only for a single user turn without tools', () => {
    const hello = [{ role: 'user', content: 'hello' }];

    expect(isGreetingFastPathEligible(hello, {})).toBe(true);
    expect(isGreetingFastPathEligible([
      { role: 'system', content: 'Be terse.' },
      ...hello,
    ], {})).toBe(false);
    expect(isGreetingFastPathEligible([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      ...hello,
    ], {})).toBe(false);
    expect(isGreetingFastPathEligible(hello, {
      tools: [{ type: 'function', function: { name: 'lookup' } }],
    })).toBe(false);
  });

  it('bypasses the intent scorer for an effort override', async () => {
    const scorer = async () => {
      throw new Error('intent scorer must not run');
    };

    await expect(scoreWithEffortOverride('hello', 'heavy', scorer)).resolves.toMatchObject({
      tier: 'heavy',
      confidence: 1,
      latencyMs: 0,
    });
  });

  it('passes client HTTP generation fields while stripping gateway controls', () => {
    const payload = buildHttpProviderPayload({
      model: 'client-model',
      direct_route: { provider: 'zai', model: 'glm' },
      effort_override: 'heavy',
      session_id: 'internal-session',
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      tool_choice: 'auto',
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 321,
      response_format: { type: 'json_object' },
      stop: ['END'],
    }, [{ role: 'user', content: 'Hi' }], 'routed-model');

    expect(payload).toMatchObject({
      model: 'routed-model',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      tool_choice: 'auto',
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 321,
      response_format: { type: 'json_object' },
      stop: ['END'],
    });
    expect(payload).not.toHaveProperty('direct_route');
    expect(payload).not.toHaveProperty('effort_override');
    expect(payload).not.toHaveProperty('session_id');
  });

  it('caps each fallback attempt at the remaining global budget', () => {
    const now = 1_000_000;

    expect(fallbackAttemptTimeoutMs(now + 90_000, now, 3_000)).toBe(3_000);
    expect(fallbackAttemptTimeoutMs(now + 4_321, now)).toBe(4_321);
    expect(fallbackAttemptTimeoutMs(now - 1, now)).toBe(0);
  });

  it('incrementally parses LF and CRLF SSE framing across chunks', () => {
    const parser = new IncrementalSseParser();

    expect(parser.push('data: one\r\n\r')).toEqual([]);
    expect(parser.push('\ndata: two\n\n')).toEqual(['data: one', 'data: two']);
    expect(parser.push('data: trailing', true)).toEqual(['data: trailing']);
  });

  it('converts a JSON completion masquerading as a stream into SSE and places the vote before DONE', () => {
    const events = jsonCompletionToSseEvents({
      id: 'chatcmpl-json',
      model: 'provider-model',
      choices: [{ message: { role: 'assistant', content: 'Completed.' }, finish_reason: 'stop' }],
    }, 'routed-model', '\n\n🎯 [vtest] Router chose: heavy');

    expect(events.join('')).toContain('Completed.');
    expect(events.join('')).toContain('[vtest]');
    expect(events.at(-1)).toBe('data: [DONE]\n\n');
    expect(events.findIndex(event => event.includes('[vtest]'))).toBeLessThan(events.length - 1);
  });

  it('reports CLI startup failures as a sanitized error, never assistant text', () => {
    const response = cliFailureResponse();

    expect(response).toEqual({ error: { message: 'CLI provider failed before producing output', type: 'cli_error' } });
    expect(JSON.stringify(response)).not.toContain('stderr');
  });
});
