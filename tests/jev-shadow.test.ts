import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevTierClient } from '../src/jev/client.js';
import { createJevShadow, getJevMode, type JevShadowRecord } from '../src/jev/shadow.js';
import { scanSecrets } from '../src/jev/secret-scan.js';
import { JEV_MODEL } from '../src/jev/questions.js';

const FAKE_KEY = 'tsk_test_0123456789abcdefghij';
const okBody = (choice = 'heavy') => ({
  model: JEV_MODEL,
  answers: { tier: { type: 'choice', choice, confidence: 0.9 } },
  usage: { input_tokens: 500, output_tokens: 60 },
});
const okFetch = (choice = 'heavy') =>
  vi.fn(async () => new Response(JSON.stringify(okBody(choice)), { status: 200 })) as unknown as typeof fetch;

describe('getJevMode', () => {
  it('defaults to off and only accepts "shadow"', () => {
    expect(getJevMode({})).toBe('off');
    for (const v of ['on', '1', 'true', 'enforce', '', 'off']) expect(getJevMode({ GATESWARM_JEV_MODE: v })).toBe('off');
    expect(getJevMode({ GATESWARM_JEV_MODE: ' Shadow ' })).toBe('shadow');
  });
});

describe('secret-scan', () => {
  it('flags secrets by name only', () => {
    const r = scanSecrets('use sk-abcdefghijklmnop1234 now');
    expect(r.clean).toBe(false);
    expect(JSON.stringify(r)).not.toContain('abcdefghijklmnop');
  });
});

describe('jev tier client', () => {
  it('returns tier, cost, and caches by prompt hash', async () => {
    const f = okFetch('heavy');
    const c = createJevTierClient({ apiKey: FAKE_KEY, fetchImpl: f });
    const a = await c.askTier('write an API endpoint with auth');
    expect(a).toMatchObject({ ok: true, tier: 'heavy', cacheHit: false, tokensIn: 500 });
    expect(a.costUsd).toBeCloseTo((500 * 0.042) / 1e6, 10);
    const b = await c.askTier('write an API endpoint with auth');
    expect(b).toMatchObject({ ok: true, cacheHit: true, latencyMs: null });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('never sends prompts containing secrets (no network call)', async () => {
    const f = okFetch();
    const c = createJevTierClient({ apiKey: FAKE_KEY, fetchImpl: f });
    const r = await c.askTier('debug this: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123');
    expect(r).toMatchObject({ ok: false, error: 'secret_scan_blocked' });
    expect(f).not.toHaveBeenCalled();
  });

  it('maps failures to codes without throwing and without leaking the key', async () => {
    const mk = (fetchImpl: typeof fetch) => createJevTierClient({ apiKey: FAKE_KEY, fetchImpl });
    expect((await createJevTierClient({ fetchImpl: okFetch() }).askTier('hi')).error).toBe('no_key');
    expect((await mk((async () => new Response('x', { status: 500 })) as unknown as typeof fetch).askTier('a1')).error).toBe('http_error');
    expect((await mk((async () => { throw new Error(`boom ${FAKE_KEY}`); }) as unknown as typeof fetch).askTier('a2')).error).toBe('network');
    expect((await mk((async () => new Response('not json', { status: 200 })) as unknown as typeof fetch).askTier('a3')).error).toBe('unparseable');
    const bad = { ...okBody(), model: 'other' };
    expect((await mk((async () => new Response(JSON.stringify(bad), { status: 200 })) as unknown as typeof fetch).askTier('a4')).error).toBe('model_mismatch');
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))) as unknown as typeof fetch;
    const t = await createJevTierClient({ apiKey: FAKE_KEY, fetchImpl: hang, timeoutMs: 30 }).askTier('a5');
    expect(t.error).toBe('timeout');
    expect(JSON.stringify(t)).not.toContain(FAKE_KEY);
  });

  it('sends the key only in the Authorization header', async () => {
    const f = okFetch();
    await createJevTierClient({ apiKey: FAKE_KEY, fetchImpl: f }).askTier('explain this function');
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(String(init.body)).not.toContain(FAKE_KEY);
  });
});

describe('jev shadow observer', () => {
  const run = async (env: NodeJS.ProcessEnv, client: { askTier: (p: string) => Promise<any> }, inputs: any[], extra: any = {}) => {
    const recs: JevShadowRecord[] = [];
    const sh = createJevShadow({ env, client: client as never, writeRecord: (r) => recs.push(r), ...extra });
    for (const i of inputs) sh.observe(i);
    await sh.drain();
    return recs;
  };
  const okClient = (tier: string) => ({
    askTier: vi.fn(async () => ({ ok: true, tier, confidence: 0.8, latencyMs: 120, costUsd: 0.00002, tokensIn: 500, tokensOut: 60, cacheHit: false })),
  });

  it('mode off (default): zero side effects', async () => {
    const c = okClient('heavy');
    const recs = await run({}, c, [{ prompt: 'x', scorerTier: 'light', source: 'score' }]);
    expect(recs).toHaveLength(0);
    expect(c.askTier).not.toHaveBeenCalled();
  });

  it('shadow: logs divergence/latency/cost, no prompt text', async () => {
    const c = okClient('heavy');
    const recs = await run({ GATESWARM_JEV_MODE: 'shadow' }, c, [{ prompt: 'secret-free prompt text', scorerTier: 'light', source: 'route', requestId: 'r1' }]);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ status: 'ok', jev_tier: 'heavy', scorer_tier: 'light', diverged: true, tier_delta: 2, latency_ms: 120, cost_usd: 0.00002, request_id: 'r1' });
    expect(JSON.stringify(recs[0])).not.toContain('prompt text');
    expect(recs[0].prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('private items are never sent', async () => {
    const c = okClient('heavy');
    const recs = await run({ GATESWARM_JEV_MODE: 'shadow' }, c, [{ prompt: 'p', scorerTier: 'light', source: 'score', privacy: 'private' }]);
    expect(c.askTier).not.toHaveBeenCalled();
    expect(recs[0]).toMatchObject({ status: 'skipped', reason: 'private' });
  });

  it('fail-open: client errors/throws never propagate', async () => {
    const thrower = { askTier: vi.fn(async () => { throw new Error('boom'); }) };
    const recs = await run({ GATESWARM_JEV_MODE: 'shadow' }, thrower, [{ prompt: 'p', scorerTier: 'light', source: 'score' }]);
    expect(recs[0]).toMatchObject({ status: 'error' });
    const sh = createJevShadow({ env: { GATESWARM_JEV_MODE: 'shadow' }, client: thrower as never, writeRecord: () => { throw new Error('sink'); } });
    expect(() => sh.observe({ prompt: 'p', scorerTier: 'light', source: 'score' })).not.toThrow();
    await sh.drain();
    expect(() => sh.observe(null as never)).not.toThrow();
  });

  it('observe returns synchronously without waiting for Jev', () => {
    const slow = { askTier: vi.fn(() => new Promise(() => {})) };
    const sh = createJevShadow({ env: { GATESWARM_JEV_MODE: 'shadow' }, client: slow as never, writeRecord: () => {} });
    const t0 = performance.now();
    const r = sh.observe({ prompt: 'p', scorerTier: 'light', source: 'score' });
    expect(r).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(20);
  });

  it('caps in-flight calls (overloaded -> skipped)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const c = { askTier: vi.fn(async () => { await gate; return { ok: true, tier: 'light', latencyMs: 1, costUsd: 0, tokensIn: 1, tokensOut: 1, cacheHit: false }; }) };
    const recs: JevShadowRecord[] = [];
    const sh = createJevShadow({ env: { GATESWARM_JEV_MODE: 'shadow' }, client: c as never, maxInflight: 1, writeRecord: (r) => recs.push(r) });
    sh.observe({ prompt: 'a', scorerTier: 'light', source: 'score' });
    sh.observe({ prompt: 'b', scorerTier: 'light', source: 'score' });
    release();
    await sh.drain();
    expect(recs.map((r) => r.reason)).toEqual(expect.arrayContaining(['overloaded', null]));
    expect(recs).toHaveLength(2);
    expect(c.askTier).toHaveBeenCalledTimes(1);
  });

  it('writes JSONL to GATESWARM_JEV_LOG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-'));
    const log = join(dir, 'sub', 'j.jsonl');
    const sh = createJevShadow({ env: { GATESWARM_JEV_MODE: 'shadow', GATESWARM_JEV_LOG: log }, client: okClient('light') as never });
    sh.observe({ prompt: 'hi', scorerTier: 'light', source: 'score' });
    await sh.drain();
    expect(existsSync(log)).toBe(true);
    const line = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(line).toMatchObject({ schema_version: 'jev-shadow.v1', diverged: false, tier_delta: 0 });
  });
});
