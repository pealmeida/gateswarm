import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, handleMessage, type ServerState } from 'gateswarm-mcp';

/**
 * The quality-vote loop over MCP: route → submit_outcome → recalibrate_matrix.
 * submit_outcome judges the OUTPUT; submit_feedback judges the TIER. These must
 * stay separate, so the tests assert they write different records.
 */

let envDir: string;
const originalEnv = process.env.GATESWARM_TELEMETRY_DIR;
const PROJECT = 'outcome-test';

beforeAll(() => {
  envDir = mkdtempSync(join(tmpdir(), 'gateswarm-outcome-'));
  process.env.GATESWARM_TELEMETRY_DIR = envDir;
});
afterAll(() => {
  if (originalEnv === undefined) delete process.env.GATESWARM_TELEMETRY_DIR;
  else process.env.GATESWARM_TELEMETRY_DIR = originalEnv;
  rmSync(envDir, { recursive: true, force: true });
});

let state: ServerState;
let id = 0;
function call(name: string, args: Record<string, unknown>) {
  const line = handleMessage(state, JSON.stringify({
    jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args },
  }));
  return JSON.parse(line!) as { result: { content: { text: string }[]; isError?: boolean } };
}
function routeOnce(prompt: string): string {
  const r = call('route_prompt', { prompt, project: PROJECT });
  return (JSON.parse(r.result.content[1].text) as { eventId: string }).eventId;
}

beforeAll(() => { state = createState(); });

describe('submit_outcome', () => {
  it('is advertised with the four verdicts', () => {
    const listed = JSON.parse(handleMessage(state, JSON.stringify({
      jsonrpc: '2.0', id: 900, method: 'tools/list',
    }))!) as { result: { tools: { name: string; inputSchema: any }[] } };
    const names = listed.result.tools.map((t) => t.name);
    expect(names).toContain('submit_outcome');
    expect(names).toContain('recalibrate_matrix');
    expect(names).toContain('cost_report');
    const schema = listed.result.tools.find((t) => t.name === 'submit_outcome')!.inputSchema;
    expect(schema.properties.verdict.enum).toEqual(['accurate', 'partial', 'inaccurate', 'failed']);
  });

  it('infers model, provider and tier from the routing eventId', () => {
    const eventId = routeOnce('Rewrite this sentence to be more formal: we gotta ship it asap');
    const res = call('submit_outcome', { eventId, verdict: 'accurate', project: PROJECT });
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toMatch(/Quality vote recorded: accurate \(1\.00\)/);
  });

  it('rejects an unknown eventId and an invalid verdict', () => {
    expect(call('submit_outcome', { eventId: 'nope', verdict: 'accurate', project: PROJECT }).result.isError).toBe(true);
    const eventId = routeOnce('hello there');
    expect(call('submit_outcome', { eventId, verdict: 'excellent', project: PROJECT }).result.isError).toBe(true);
  });

  it('requires modelId and tier when no eventId is supplied', () => {
    expect(call('submit_outcome', { verdict: 'accurate', project: PROJECT }).result.isError).toBe(true);
    expect(call('submit_outcome', {
      verdict: 'accurate', modelId: 'gemini-flash-lite', tier: 'light', project: PROJECT,
    }).result.isError).toBeFalsy();
  });

  it('lets an explicit quality override the verdict mapping', () => {
    const eventId = routeOnce('Summarize the differences between TCP and UDP in one paragraph.');
    const res = call('submit_outcome', { eventId, verdict: 'partial', quality: 0.75, project: PROJECT });
    expect(res.result.content[0].text).toMatch(/\(0\.75\)/);
  });

  it('surfaces per-model quality in telemetry_summary', () => {
    const summary = JSON.parse(call('telemetry_summary', { project: PROJECT }).result.content[0].text);
    expect(summary.outcomes).toBeGreaterThan(0);
    expect(Object.keys(summary.qualityByModel).length).toBeGreaterThan(0);
  });
});

describe('recalibrate_matrix', () => {
  it('refuses to invent a calibration with no votes', () => {
    const res = call('recalibrate_matrix', { project: 'project-with-no-votes' });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/no quality votes recorded/);
  });

  it('demotes a model that repeatedly underdelivers at its ceiling tier', () => {
    const proj = 'recal-demote';
    for (let i = 0; i < 8; i++) {
      call('submit_outcome', {
        verdict: 'inaccurate', modelId: 'deepseek-chat', provider: 'deepseek', tier: 'heavy', project: proj,
      });
    }
    const res = call('recalibrate_matrix', { project: proj });
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toMatch(/maxEffort heavy → moderate/);
    const payload = JSON.parse(res.result.content[1].text) as { matrix: { id: string; maxEffort: string }[] };
    expect(payload.matrix.find((m) => m.id === 'deepseek-chat')!.maxEffort).toBe('moderate');
  });
});

describe('the two votes stay separate', () => {
  it('submit_feedback writes a tier verdict, submit_outcome writes a quality verdict', () => {
    const proj = 'separation';
    const r = call('route_prompt', { prompt: 'Explain async/await', project: proj });
    const eventId = (JSON.parse(r.result.content[1].text) as { eventId: string }).eventId;

    const fb = call('submit_feedback', { eventId, verdict: 'wrong', correctTier: 'moderate', project: proj });
    expect(fb.result.content[0].text).toMatch(/Verdict recorded/);
    const oc = call('submit_outcome', { eventId, verdict: 'inaccurate', project: proj });
    expect(oc.result.content[0].text).toMatch(/Quality vote recorded/);

    const summary = JSON.parse(call('telemetry_summary', { project: proj }).result.content[0].text);
    // One of each — a quality complaint must not be counted as a tier verdict.
    expect(summary.feedback).toBe(1);
    expect(summary.outcomes).toBe(1);
    expect(summary.verdicts.wrong).toBe(1);
  });
});
