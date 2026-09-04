import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Deep end-to-end suite — runs the REAL built artifacts (dist/) the way
 * users and agents do:
 *
 *   A. gateswarm-lite CLI across realistic prompts (argv, stdin, empty, help)
 *   B. gateswarm-route CLI (strategies, custom matrix files, error paths)
 *   C. one persistent gateswarm-mcp agent session: initialize → route →
 *      verdicts → corrected-tier rerouting → telemetry summary, with JSONL
 *      verified on disk afterwards
 *   D. cross-surface consistency: the same prompt must produce the exact same
 *      score/tier through every surface (lite CLI, router CLI, MCP payload)
 */

const ROOT = process.cwd();
const LITE_CLI = join(ROOT, 'packages', 'gateswarm-lite', 'dist', 'cli.js');
const ROUTER_CLI = join(ROOT, 'packages', 'gateswarm-router', 'dist', 'cli.js');
const MCP_CLI = join(ROOT, 'packages', 'gateswarm-mcp', 'dist', 'cli.js');

let telemetryDir: string;
let matrixFile: string;

beforeAll(() => {
  if (!existsSync(LITE_CLI) || !existsSync(ROUTER_CLI) || !existsSync(MCP_CLI)) {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe', timeout: 900_000 });
  }
  telemetryDir = mkdtempSync(join(tmpdir(), 'gateswarm-e2e-'));
  matrixFile = join(telemetryDir, 'matrix.json');
  writeFileSync(
    matrixFile,
    JSON.stringify([
      { id: 'only', provider: 'x', maxEffort: 'extreme', costPer1MInput: 1, costPer1MOutput: 2, quality: 0.9 },
    ]),
  );
}, 900_000);

function node(script: string, args: string[], opts: { input?: string } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf-8',
    input: opts.input ?? '',
    timeout: 120_000,
    env: { ...process.env, GATESWARM_TELEMETRY_DIR: telemetryDir },
  });
}

const REAL_PROMPTS = [
  'hey! did the deploy finish?',
  'What is the capital of France?',
  'Write a Python function that parses a CSV file and returns the top 5 rows sorted by revenue, with unit tests.',
  "Our p99 latency jumped from 120ms to 800ms after the last deploy. Figure out which change caused it and propose a rollback plan.",
  'Design a microservices architecture for a real-time trading platform, including failure modes and a migration plan.',
  '用Python写一个快速排序函数，并解释时间复杂度。',
];

describe('E2E A: gateswarm-lite CLI (built artifact)', () => {
  it.each(REAL_PROMPTS)('scores realistic prompt: %s', (prompt) => {
    const r = node(LITE_CLI, [prompt]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { score: number; tier: string; wordCount: number; latencyMs: number };
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(1);
    expect(['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme']).toContain(out.tier);
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reads prompts from stdin and rejects empties without hanging', () => {
    const piped = node(LITE_CLI, [], { input: 'Summarize TCP vs UDP\n' });
    expect(piped.status).toBe(0);
    expect(JSON.parse(piped.stdout).tier).toBeTypeOf('string');

    const empty = node(LITE_CLI, [], { input: '' });
    expect(empty.status).toBe(1);
    expect(JSON.parse(empty.stderr).error).toContain('empty prompt');
  });

  it('prints usage with --help and exits 0', () => {
    const h = node(LITE_CLI, ['--help']);
    expect(h.status).toBe(0);
    expect(h.stdout).toContain('Usage:');
  });
});

describe('E2E B: gateswarm-route CLI (built artifact)', () => {
  it('returns decisions for every realistic prompt under both strategies', () => {
    for (const strategy of ['cheapest-capable', 'best-value']) {
      for (const prompt of REAL_PROMPTS.slice(0, 4)) {
        const r = node(ROUTER_CLI, [prompt, '--strategy', strategy]);
        expect(r.status).toBe(0);
        const d = JSON.parse(r.stdout);
        expect(d.strategy).toBe(strategy);
        expect(d.model.id).toBeTypeOf('string');
        expect(d.complexity.tier).toBeTypeOf('string');
        expect(d.alternatives.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('honors custom matrix files and fails cleanly on bad input', () => {
    const ok = node(ROUTER_CLI, ['hello', '--matrix', matrixFile]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).model.id).toBe('only');

    expect(node(ROUTER_CLI, ['hi', '--strategy', 'fastest'], { input: '' }).status).toBe(1);
    expect(node(ROUTER_CLI, ['hi', '--matrix', 'Z:/nope.json'], { input: '' }).status).toBe(1);
    expect(node(ROUTER_CLI, [], { input: '' }).status).toBe(1);

    const h = node(ROUTER_CLI, ['--help']);
    expect(h.status).toBe(0);
    expect(h.stdout).toContain('--matrix');
  });
});

interface McpResponse {
  id: number | null;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
}

function mcpPayload(res: McpResponse): Record<string, unknown> {
  const blocks = res.result?.content ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(blocks[i].text) as Record<string, unknown>;
    } catch {
      /* skip non-JSON blocks */
    }
  }
  throw new Error(`no JSON block in ${JSON.stringify(res)}`);
}

describe('E2E C: gateswarm-mcp full agent session (one persistent process)', () => {
  let responses: McpResponse[] = [];
  let eventIds: string[] = [];
  const project = 'e2e-agent';

  beforeAll(() => {
    const phase1: object[] = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ];
    let id = 10;
    for (const prompt of REAL_PROMPTS.slice(0, 2)) {
      phase1.push({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'route_prompt', arguments: { prompt, project } } });
    }
    phase1.push({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'route_session', arguments: { turns: REAL_PROMPTS.slice(3, 5), project } } });

    // The server resolves tool calls sequentially; one spawn carries the whole routing phase.
    const first = spawnSync(process.execPath, [MCP_CLI], {
      encoding: 'utf-8',
      input: phase1.map((m) => JSON.stringify(m)).join('\n') + '\n',
      timeout: 180_000,
      env: { ...process.env, GATESWARM_TELEMETRY_DIR: telemetryDir },
    });
    responses = first.stdout.trim().split('\n').map((l) => JSON.parse(l) as McpResponse);

    for (const res of responses) {
      try {
        const p = mcpPayload(res);
        if (typeof p.eventId === 'string' && typeof p.complexity === 'object') eventIds.push(p.eventId);
      } catch { /* not a decision */ }
    }
    expect(eventIds.length).toBe(3);

    // Phase 2 runs in a FRESH process: verdicts resolve through the on-disk store,
    // proving telemetry persistence across sessions.
    const verdictMessages = [
      { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'submit_feedback', arguments: { eventId: eventIds[0], verdict: 'correct', project } } },
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'submit_feedback', arguments: { eventId: eventIds[2], verdict: 'wrong', correctTier: 'light', notes: 'short follow-up', project } } },
      { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'telemetry_summary', arguments: { project } } },
    ];
    const second = spawnSync(process.execPath, [MCP_CLI], {
      encoding: 'utf-8',
      input: verdictMessages.map((m) => JSON.stringify(m)).join('\n') + '\n',
      timeout: 180_000,
      env: { ...process.env, GATESWARM_TELEMETRY_DIR: telemetryDir },
    });
    responses.push(...(second.stdout.trim().split('\n').map((l) => JSON.parse(l) as McpResponse)));
  }, 600_000);

  it('handshakes and lists the full tool surface', () => {
    const init = responses.find((r) => r.id === 1)!;
    expect((init.result as unknown as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    const tools = responses.find((r) => r.id === 2)!;
    const names = (tools.result as unknown as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual([
      'route_prompt', 'route_session', 'submit_feedback',
      'submit_outcome', 'recalibrate_matrix', 'telemetry_summary',
    ]);
  });

  it('routes single prompts AND sessions with distinct payloads', () => {
    const routed = responses.filter((r) => r.id !== null && r.id >= 10 && r.id <= 12);
    expect(routed.length).toBe(3);
    const single = mcpPayload(routed[0]) as { complexity: { turnsCount?: number } };
    expect(single.complexity.turnsCount).toBeUndefined();
    const sessionPayload = mcpPayload(routed[2]) as { complexity: { turnsCount: number; windowChars: number }; model: { id: string } };
    expect(sessionPayload.complexity.turnsCount).toBe(2);
    expect(sessionPayload.model.id).toBeTypeOf('string');
  });

  it('records verdicts, reroutes corrected tiers, and persists InteractionEvent JSONL', () => {
    const correct = responses.find((r) => r.id === 20)!;
    const correctText = (correct.result!.content![0] as { text: string }).text;
    expect(correctText).toContain('Verdict recorded: correct');

    const wrong = responses.find((r) => r.id === 21)!;
    const wrongText = (wrong.result!.content![0] as { text: string }).text;
    expect(wrongText).toContain('Verdict recorded: wrong');
    expect(wrongText).toContain('would choose: gemini-flash-lite');

    const eventsFile = join(telemetryDir, 'e2e-agent', 'events.jsonl');
    const lines = readFileSync(eventsFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.type === 'decision').length).toBe(3);
    expect(lines.filter((l) => l.type === 'feedback').length).toBe(2);

    const summary = responses.find((r) => r.id === 22)!;
    const s = mcpPayload(summary) as { decisions: number; verdicts: { correct: number; wrong: number } };
    expect(s.decisions).toBe(3);
    expect(s.verdicts).toEqual({ correct: 1, wrong: 1 });
  });
});

describe('E2E D: cross-surface consistency', () => {
  it('lite CLI, router CLI, and MCP agree exactly on score/tier', () => {
    const prompt = REAL_PROMPTS[3];
    const lite = JSON.parse(node(LITE_CLI, [prompt]).stdout) as { score: number; tier: string };

    const routed = JSON.parse(node(ROUTER_CLI, [prompt]).stdout) as { complexity: { score: number; tier: string } };
    expect(routed.complexity.score).toBe(lite.score);
    expect(routed.complexity.tier).toBe(lite.tier);

    const msgs = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'route_prompt', arguments: { prompt, project: 'consistency' } } }),
      '',
    ].join('\n');
    const mcpOut = spawnSync(process.execPath, [MCP_CLI], {
      encoding: 'utf-8',
      input: msgs,
      timeout: 120_000,
      env: { ...process.env, GATESWARM_TELEMETRY_DIR: telemetryDir },
    });
    const payloadLine = mcpOut.stdout.trim().split('\n')[1];
    const payload = JSON.parse(payloadLine) as { result: { content: Array<{ text: string }> } };
    const mcpDecision = JSON.parse(payload.result.content[payload.result.content.length - 1].text) as {
      complexity: { score: number; tier: string };
    };
    expect(mcpDecision.complexity.score).toBe(lite.score);
    expect(mcpDecision.complexity.tier).toBe(lite.tier);
  });
});

afterAll(() => {
  rmSync(telemetryDir, { recursive: true, force: true });
});
