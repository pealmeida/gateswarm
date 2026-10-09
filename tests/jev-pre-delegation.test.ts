import { describe, it, expect, vi } from 'vitest';
import { preDelegationCheck, assessLocally, createJevRiskFn, detectFlags } from '../src/jev/pre-delegation.js';
import { JEV_MODEL } from '../src/jev/questions.js';

const shadow = { GATESWARM_JEV_MODE: 'shadow' } as NodeJS.ProcessEnv;
const mk = () => { const recs: Record<string, unknown>[] = []; return { recs, writeRecord: (r: Record<string, unknown>) => void recs.push(r) }; };

describe('local rules', () => {
  it('flags areas', () => {
    expect(detectFlags('fix login session refresh')).toContain('auth_session');
    expect(detectFlags('add migration with RLS policy')).toContain('migration_rls');
    expect(detectFlags('deploy to production')).toEqual(expect.arrayContaining(['deploy', 'production']));
    expect(detectFlags('rotate the API key')).toContain('secrets');
    expect(detectFlags('npm install lodash')).toContain('dependencies');
    expect(detectFlags('fix typo in README')).toEqual([]);
  });
  it('recommends by risk', () => {
    const a = assessLocally({ task: 'change login session handling' });
    expect(a.localRisk).toBe('high');
    expect(a.recommend).toMatchObject({ humanReview: true, mandatoryTests: true });
    const b = assessLocally({ task: 'fix typo' });
    expect(b.recommend).toEqual({ humanReview: false, mandatoryTests: false, splitTask: false });
  });
  it('suggests split for large tasks', () => {
    expect(assessLocally({ task: 'x', filesTouched: 25 }).recommend.splitTask).toBe(true);
    expect(assessLocally({ task: 'y'.repeat(2000) }).recommend.splitTask).toBe(true);
  });
});

describe('preDelegationCheck', () => {
  it('off by default: never calls Jev', async () => {
    const jev = vi.fn(); const m = mk();
    const r = await preDelegationCheck({ task: 'fix typo' }, { env: {}, jevRisk: jev, writeRecord: m.writeRecord });
    expect(jev).not.toHaveBeenCalled();
    expect(r.jevStatus).toBe('off');
    expect(m.recs).toHaveLength(1);
  });
  it('Jev can harden but not soften', async () => {
    const up = await preDelegationCheck({ task: 'fix typo' }, { env: shadow, jevRisk: async () => 'high', ...mk() });
    expect(up.finalRisk).toBe('high'); expect(up.hardenedByJev).toBe(true); expect(up.recommend.humanReview).toBe(true);
    const down = await preDelegationCheck({ task: 'change login' }, { env: shadow, jevRisk: async () => 'low', ...mk() });
    expect(down.finalRisk).toBe('high'); expect(down.hardenedByJev).toBe(false); expect(down.recommend.humanReview).toBe(true);
  });
  it('fail-open on null/throw', async () => {
    const a = await preDelegationCheck({ task: 'deploy' }, { env: shadow, jevRisk: async () => null, ...mk() });
    expect(a.jevStatus).toBe('skipped');
    const b = await preDelegationCheck({ task: 'deploy' }, { env: shadow, jevRisk: async () => { throw new Error('x'); }, ...mk() });
    expect(b.jevStatus).toBe('error'); expect(b.finalRisk).toBe(b.localRisk);
  });
  it('private tasks are never sent', async () => {
    const jev = vi.fn(); const m = mk();
    const r = await preDelegationCheck({ task: 'login secret', privacy: 'private' }, { env: shadow, jevRisk: jev, writeRecord: m.writeRecord });
    expect(jev).not.toHaveBeenCalled(); expect(r.jevStatus).toBe('private'); expect(m.recs[0].task_sha256).toBeNull();
  });
  it('log has no task text; note present', async () => {
    const m = mk();
    const r = await preDelegationCheck({ task: 'UNIQUE-MARKER login change' }, { env: {}, ...m });
    expect(JSON.stringify(m.recs)).not.toContain('UNIQUE-MARKER');
    expect(r.note).toContain('jev-pre-delegation');
  });
});

describe('createJevRiskFn', () => {
  it('sends flags only, with bearer, parses choice', async () => {
    let body = '';
    const f = vi.fn(async (_u: string, init: RequestInit) => { body = String(init.body); return new Response(JSON.stringify({ model: JEV_MODEL, answers: { risk: { choice: 'medium' } } })); }) as unknown as typeof fetch;
    const out = await createJevRiskFn({ apiKey: 'k', fetchImpl: f })(['auth_session'], { large: false });
    expect(out).toBe('medium');
    expect(body).toContain('auth_session'); expect(body).not.toContain('"task"');
  });
  it('null without key, on http error, on timeout', async () => {
    expect(await createJevRiskFn({})(['deploy'], { large: false })).toBeNull();
    const bad = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect(await createJevRiskFn({ apiKey: 'k', fetchImpl: bad })([], { large: false })).toBeNull();
    const slow = ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('a', 'AbortError'))))) as unknown as typeof fetch;
    expect(await createJevRiskFn({ apiKey: 'k', fetchImpl: slow, timeoutMs: 20 })([], { large: false })).toBeNull();
  });
});

describe('preDelegationObserve (delegation hook)', () => {
  it('is a no-op when mode is off', async () => {
    const { preDelegationObserve } = await import('../src/jev/pre-delegation.js');
    const m = mk(); const jev = vi.fn();
    preDelegationObserve({ task: 'change login session' }, { env: {}, jevRisk: jev, writeRecord: m.writeRecord });
    await new Promise((r) => setTimeout(r, 20));
    expect(jev).not.toHaveBeenCalled(); expect(m.recs).toHaveLength(0);
  });
  it('logs asynchronously in shadow mode and never throws', async () => {
    const { preDelegationObserve } = await import('../src/jev/pre-delegation.js');
    const m = mk(); const notes: string[] = [];
    preDelegationObserve({ task: 'change login session' }, { env: shadow, jevRisk: async () => { throw new Error('boom'); }, writeRecord: m.writeRecord, onNote: (n) => notes.push(n) });
    await new Promise((r) => setTimeout(r, 30));
    expect(m.recs).toHaveLength(1); expect(m.recs[0]).not.toHaveProperty('task');
    expect(notes[0]).toContain('jev-pre-delegation');
  });
  it('real API response shape parses (answers.risk.choice)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ model: JEV_MODEL, answers: { risk: { type: 'choice', choice: 'high', confidence: 1, probabilities: { low: 0, medium: 0, high: 1 } } }, usage: { input_tokens: 398, output_tokens: 38 } }), { status: 200 })) as unknown as typeof fetch;
    const fn = createJevRiskFn({ apiKey: 'k', fetchImpl });
    expect(await fn(['auth_session'], { large: false })).toBe('high');
  });
});
