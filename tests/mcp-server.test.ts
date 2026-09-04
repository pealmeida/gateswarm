import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, handleMessage, type ServerState } from 'gateswarm-mcp';
import type { DecisionRecord } from 'gateswarm-mcp';

/**
 * MCP server contract tests: JSON-RPC handling driven directly, then a real
 * end-to-end stdio session (initialize → tools/list → route → feedback) with
 * an isolated telemetry directory.
 */

const TOKEN = 'silvercalibrationuniquetoken'; // unused here; keeps diff noise low if moved
const ARCH_PROMPT =
  'Design a microservices architecture for a real-time trading platform, including failure modes, data consistency strategy, and a migration plan from the current monolith.';

let envDir: string;
const originalEnv = process.env.GATESWARM_TELEMETRY_DIR;

beforeAll(() => {
  envDir = mkdtempSync(join(tmpdir(), 'gateswarm-mcp-test-'));
  process.env.GATESWARM_TELEMETRY_DIR = envDir;
});
afterAll(() => {
  if (originalEnv === undefined) delete process.env.GATESWARM_TELEMETRY_DIR;
  else process.env.GATESWARM_TELEMETRY_DIR = originalEnv;
  rmSync(envDir, { recursive: true, force: true });
});

function call(state: ServerState, method: string, params?: object): Record<string, unknown> {
  const line = handleMessage(
    state,
    JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  );
  expect(line, `expected a response for ${method}`).toBeTruthy();
  return JSON.parse(line as string) as Record<string, unknown>;
}

function callTool(state: ServerState, name: string, args: object) {
  const res = call(state, 'tools/call', { name, arguments: args });
  const result = res.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const blocks = result.content.map((c) => c.text);
  return {
    isError: result.isError === true,
    text: blocks.join('\n'),
    // Machine-parseable payload rides in the last content block when present.
    json: (() => {
      for (let i = blocks.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(blocks[i]) as Record<string, unknown>;
        } catch {
          /* not a JSON block */
        }
      }
      return null;
    })(),
  };
}

describe('MCP protocol', () => {
  it('initializes and lists tools', () => {
    const state = createState();
    const init = call(state, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {} });
    const initResult = init.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(initResult.protocolVersion).toBe('2025-06-18');
    expect(initResult.serverInfo.name).toBe('gateswarm-mcp');

    // Unsupported version falls back instead of breaking the handshake.
    const legacy = call(createState(), 'initialize', { protocolVersion: '1999-01-01' });
    expect((legacy.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');

    const tools = call(state, 'tools/list');
    const names = ((tools.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(names).toEqual(['route_prompt', 'route_session', 'submit_feedback', 'submit_outcome', 'recalibrate_matrix', 'cost_report', 'telemetry_summary']);

    expect(handleMessage(state, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull();
  });

  it('routes a prompt and returns eventId + decision', () => {
    const state = createState();
    const r = callTool(state, 'route_prompt', { prompt: 'Design a distributed cache with failover', project: 'test-p1' });
    expect(r.isError).toBe(false);
    expect(r.json).toBeTruthy();
    expect(typeof r.json!.eventId).toBe('string');
    const decision = r.json! as unknown as { complexity: { tier: string }; model: { id: string; provider: string }; strategy: string };
    expect(decision.complexity.tier).toBeTypeOf('string');
    expect(decision.model.id).toBeTypeOf('string');
    expect(decision.strategy).toBe('cheapest-capable');
  });

  it('routes multi-turn sessions and links feedback to the session decision', () => {
    const state = createState();
    const turns = ['hey there', ARCH_PROMPT];
    const r = callTool(state, 'route_session', { turns, project: 'test-s1' });
    expect(r.isError).toBe(false);
    const payload = r.json! as { eventId: string; complexity: { turnsCount: number; windowChars: number } };
    expect(payload.complexity.turnsCount).toBe(2);
    expect(payload.complexity.windowChars).toBeGreaterThan(0);

    const bad = callTool(state, 'submit_feedback', {
      eventId: payload.eventId,
      verdict: 'wrong',
      correctTier: 'trivial',
      project: 'test-s1',
    });
    expect(bad.isError).toBe(false);
    expect(bad.text).toContain('would choose: gemini-flash-lite');

    expect(callTool(state, 'route_session', { turns: [], project: 'test-s1' }).isError).toBe(true);
    expect(callTool(state, 'route_session', { turns: ['  ', '  '], project: 'test-s1' }).isError).toBe(true);
  });

  it('rejects empty prompts and unknown eventIds as tool errors', () => {
    const state = createState();
    expect(callTool(state, 'route_prompt', { prompt: '   ' }).isError).toBe(true);
    expect(callTool(state, 'submit_feedback', { eventId: 'nope', verdict: 'correct' }).isError).toBe(true);
  });

  it('rejects path-traversal project names on every tool', () => {
    const state = createState();
    for (const project of ['../../evil', '../escape', 'a/b', 'a\\b', '..', '.', '']) {
      expect(callTool(state, 'route_prompt', { prompt: 'hi', project }).isError).toBe(true);
      expect(callTool(state, 'route_session', { turns: ['hi'], project }).isError).toBe(true);
      expect(callTool(state, 'telemetry_summary', { project }).isError).toBe(true);
    }
    // Nothing may be written outside the telemetry directory.
    const routed = callTool(state, 'route_prompt', { prompt: 'hi', project: '../../evil' });
    expect(routed.text).toContain('invalid project');
    expect(existsSync(join(envDir, '..', 'evil'))).toBe(false);
  });

  it('rejects verdict "wrong" with an invalid correctTier', () => {
    const state = createState();
    const { eventId } = callTool(state, 'route_prompt', { prompt: 'hi', project: 'test-p4' }).json! as { eventId: string };
    const bad = callTool(state, 'submit_feedback', { eventId, verdict: 'wrong', correctTier: 'super-hard', project: 'test-p4' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('requires a valid correctTier');
  });

  it('records correct verdicts and reroutes wrong ones to the corrected tier', () => {
    const state = createState();
    const routed = callTool(state, 'route_prompt', { prompt: 'Write a Python function that parses a CSV file', project: 'test-p3' });
    const { eventId } = routed.json! as { eventId: string };

    const good = callTool(state, 'submit_feedback', { eventId, verdict: 'correct', project: 'test-p3' });
    expect(good.isError).toBe(false);
    expect(good.text).toContain('Verdict recorded: correct');

    const bad = callTool(state, 'submit_feedback', {
      eventId,
      verdict: 'wrong',
      correctTier: 'trivial',
      notes: 'one-liner really',
      project: 'test-p3',
    });
    expect(bad.isError).toBe(false);
    expect(bad.text).toContain('would choose: gemini-flash-lite'); // cheapest trivial-capable

    expect(callTool(state, 'submit_feedback', { eventId, verdict: 'wrong', project: 'test-p3' }).isError).toBe(true);
  });

  it('persists records as InteractionEvent-shaped JSONL', () => {
    const file = join(envDir, 'test-p3', 'events.jsonl');
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const decision = lines.find((l) => l.type === 'decision')!;
    expect(decision).toHaveProperty('promptHash');
    expect(decision).toHaveProperty('boundariesHash');
    expect(decision).toHaveProperty('score');
    const feedback = lines.filter((l) => l.type === 'feedback');
    expect(feedback.length).toBe(2);
    expect(feedback[0]).toMatchObject({ verdict: 'correct', promptHash: decision.promptHash });
  });

  it('telemetry_summary aggregates per project', () => {
    const s = callTool(createState(), 'telemetry_summary', { project: 'test-p3' });
    const summary = s.json! as { decisions: number; feedback: number; verdicts: { correct: number; wrong: number } };
    expect(summary.decisions).toBeGreaterThanOrEqual(1);
    expect(summary.verdicts).toEqual({ correct: 1, wrong: 1 });
  });
});

describe('MCP stdio transport (real agent-style session)', () => {
  it('answers initialize/tools/call over newline-delimited JSON-RPC', () => {
    const script = join('packages', 'gateswarm-mcp', 'src', 'cli.ts');
    const messages = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'route_prompt', arguments: { prompt: 'hi', project: 'stdio-test' } } }),
      '',
    ].join('\n');
    const r = spawnSync(process.execPath, ['--import', 'tsx', script], {
      input: messages,
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env },
    });
    expect(r.status).toBe(0);

    const responses = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id: number });
    expect(responses.map((m) => m.id)).toEqual([1, 2, 3]);
    const toolsMsg = responses[1] as unknown as { result: { tools: unknown[] } };
    expect(toolsMsg.result.tools).toHaveLength(7);
  }, 90_000);
});
