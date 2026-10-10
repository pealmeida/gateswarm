import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProviderState, computeStates, precheck, estimateCostPerRequest, parseTime, sameReset, type SyncFile, type CalibrationRecord } from '../src/quota-manager/core.js';
import { batteryEnd, batteryStart, getManagerView, loadConfig, paths, survey, tick, readCalibration, activeBattery, type Deps } from '../src/quota-manager/runtime.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const win = (usedPct: number | null, resetInMin: number, windowMinutes: number) => ({ usedPct, resetAt: iso(NOW + resetInMin * 60_000), windowMinutes });
const sync = (over: Partial<Record<string, unknown>> = {}): SyncFile => ({ snapshots: {
  'claude-cli': { provider: 'claude-cli', syncedAt: iso(NOW - 60_000), source: 'codexbar-cli', plan: 'Pro', windows: { '5h': win(29, 150, 300), '7d': win(87, 600, 10080) } },
  'codex-cli': { provider: 'codex-cli', syncedAt: iso(NOW - 60_000), source: 'codexbar-cli', plan: 'Plus', windows: { '5h': win(2, 200, 300), '7d': win(38, 5000, 10080) } },
  zai: { provider: 'zai', syncedAt: iso(NOW - 60_000), source: 'consumption-history', windows: { '5h': { usedPct: null }, '7d': { usedPct: null } } },
  ollama: { provider: 'ollama', syncedAt: iso(NOW - 60_000), source: 'consumption-history', unmetered: true, windows: { '5h': { usedPct: null } } },
  ...over } as SyncFile['snapshots'] });

describe('core states', () => {
  it('bands, method/confidence, projection', () => {
    const st = computeStates(sync(), NOW);
    const c = st.find((s) => s.provider === 'claude-cli')!;
    expect(c.band).toBe('red'); expect(c.confidence).toBe('measured'); expect(c.limitingWindow).toBe('7d');
    expect(c.willExhaustBeforeReset).toBe(false); // 87% after 9480/10080 min elapsed -> ~92.5% at reset
    const fast = computeProviderState('claude-cli', { ...sync().snapshots!['claude-cli'], windows: { '7d': win(60, 5040, 10080) } }, NOW);
    expect(fast.willExhaustBeforeReset).toBe(true); // 60% at half-way -> 120%
  });
  it('projection only flags exhaustion when pace implies >100', () => {
    const s = computeProviderState('claude-cli', sync().snapshots!['claude-cli'], NOW);
    const w7 = s.windows.find((w) => w.name === '7d')!;
    expect(w7.projectedPctAtReset).toBeGreaterThan(87);
    const codex = computeProviderState('codex-cli', sync().snapshots!['codex-cli'], NOW);
    expect(codex.band).toBe('green'); expect(codex.willExhaustBeforeReset).toBe(false);
  });
  it('unmeasured is unknown (never 0) and lists what is missing', () => {
    const z = computeProviderState('zai', sync().snapshots!.zai, NOW);
    expect(z.band).toBe('unknown'); expect(z.maxUsedPct).toBeNull(); expect(z.confidence).toBe('unknown'); expect(z.missing.join()).toMatch(/Z_AI_API_KEY/);
    expect(computeProviderState('bailian', undefined, NOW).missing.join()).toMatch(/bl/);
  });
  it('consumption-history with a configured limit is "estimated"', () => {
    const z = computeProviderState('zai', { ...sync().snapshots!.zai, windows: { '5h': { usedPct: 75 } } }, NOW);
    expect(z.confidence).toBe('estimated'); expect(z.band).toBe('orange'); expect(z.missing.length).toBe(1);
  });
  it('stale (>15 min) data becomes unknown', () => {
    const s = computeProviderState('codex-cli', { ...sync().snapshots!['codex-cli'], syncedAt: iso(NOW - 16 * 60_000) }, NOW);
    expect(s.stale).toBe(true); expect(s.band).toBe('unknown'); expect(s.maxUsedPct).toBeNull(); expect(s.note).toMatch(/stale/);
  });
  it('past-reset window is unknown, ollama is unmetered/green', () => {
    const snap = sync().snapshots!['codex-cli']; snap.windows!['5h'] = { usedPct: 90, resetAt: iso(NOW - 1000), windowMinutes: 300 };
    expect(computeProviderState('codex-cli', snap, NOW).windows.find((w) => w.name === '5h')!.usedPct).toBeNull();
    const o = computeProviderState('ollama', sync().snapshots!.ollama, NOW);
    expect(o.band).toBe('green'); expect(o.method).toBe('local-unmetered'); expect(o.missing).toEqual([]);
  });
  it('parses the legacy malformed timestamp and tolerates reset jitter', () => {
    expect(parseTime('2026-10-10T02:10:02.940698+00:00Z')).not.toBeNull();
    expect(sameReset(iso(NOW), iso(NOW + 30_000))).toBe(true); expect(sameReset(iso(NOW), iso(NOW + 5 * 3600_000))).toBe(false);
  });
});

describe('precheck', () => {
  const cal: CalibrationRecord[] = [{ schema_version: 'quota-calibration.v1', ts: '', source: 'battery', provider: 'codex-cli', window: '5h', tiers: ['intensive'], requests: 10, tokens: 0, deltaPct: 5, pctPerRequest: 0.5, pctPer1kTokens: null, lowResolution: false, confidence: 'measured' }];
  it('warns, proposes alternatives, does not block by default', () => {
    const r = precheck({ states: computeStates(sync(), NOW), need: ['claude-cli', 'zai', 'codex-cli'], plannedRequests: { 'codex-cli': 500 }, calibration: cal });
    expect(r.warnings.some((w) => w.provider === 'claude-cli' && w.code === 'red')).toBe(true);
    expect(r.warnings.some((w) => w.provider === 'zai' && w.code === 'unknown')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'insufficient_headroom')).toBe(true); // 250% > 98%
    expect(r.proposals.join()).toMatch(/claude-cli.*codex-cli/);
    expect(r.ok).toBe(false);
  });
  it('estimateCostPerRequest weights by requests', () => {
    expect(estimateCostPerRequest(cal, 'codex-cli', '5h')!.pctPerRequest).toBe(0.5);
    expect(estimateCostPerRequest(cal, 'zai', '5h')).toBeNull();
  });
});

describe('runtime lifecycle', () => {
  async function setup() {
    const root = await fs.mkdtemp(join(tmpdir(), 'qm-'));
    const p = paths(root);
    await fs.mkdir(p.data, { recursive: true });
    let now = NOW; let codexPct = 2; let reqs = 100;
    const writeAll = async () => {
      const s = sync({ 'codex-cli': { provider: 'codex-cli', syncedAt: iso(now - 1000), source: 'codexbar-cli', plan: 'Plus', windows: { '5h': win(codexPct, 200, 300), '7d': win(38, 5000, 10080) } } });
      for (const sn of Object.values(s.snapshots!)) sn.syncedAt = iso(now - 1000);
      await fs.writeFile(p.sync, JSON.stringify(s));
      await fs.writeFile(p.history, JSON.stringify({ providers: { 'codex-cli': { totalRequests: reqs, totalTokensIn: reqs * 10, totalTokensOut: 0, totalErrors: 0 } } }));
    };
    const calls: Array<string[] | undefined> = [];
    const deps: Deps = { now: () => now, collect: async (only) => { calls.push(only); await writeAll(); }, tiersOf: async (pr) => (pr === 'codex-cli' ? ['intensive'] : []) };
    return { p, deps, cfg: loadConfig({}), calls, bump: (pct: number, r: number) => { codexPct = pct; reqs += r; now += 60_000; } };
  }
  it('battery start/tick/end writes report + calibration, no secrets/emails', async () => {
    const t = await setup();
    const st = await batteryStart(t.p, t.deps, t.cfg, { name: 'unit', need: ['codex-cli', 'zai'], plannedRequests: { 'codex-cli': 10 } });
    expect(st.started).toBe(true); expect(st.precheck.warnings.some((w) => w.provider === 'zai')).toBe(true);
    expect(await fs.readFile(t.p.interval, 'utf8')).toBe('180');
    const again = await batteryStart(t.p, t.deps, t.cfg, { name: 'other' });
    expect(again.started).toBe(false);
    t.bump(6, 20);
    await tick(t.p, t.deps, t.cfg);
    expect((await activeBattery(t.p))!.samples.length).toBe(1);
    t.bump(10, 20);
    const end = await batteryEnd(t.p, t.deps, t.cfg);
    const cx = end!.report.providers.find((x) => x.provider === 'codex-cli')!;
    expect(cx.requests).toBe(40); expect(cx.windows.find((w) => w.window === '5h')!.deltaPct).toBe(8);
    expect(cx.pctPerRequest).toBe(0.2); expect(cx.batteriesLeft).toBe(Math.floor(90 / 8));
    const cal = await readCalibration(t.p);
    expect(cal.find((c) => c.provider === 'codex-cli' && c.window === '5h')!.tiers).toEqual(['intensive']);
    expect(await activeBattery(t.p)).toBeNull(); expect(await fs.readFile(t.p.interval, 'utf8')).toBe('600');
    const all = (await fs.readFile(end!.files.md, 'utf8')) + (await fs.readFile(end!.files.json, 'utf8')) + (await fs.readFile(t.p.state, 'utf8'));
    expect(all).not.toMatch(/@|sk-|Bearer/);
    expect(end!.report.missing.zai).toBeTruthy();
  });
  it('strict mode refuses on critical pre-check; default does not block', async () => {
    const t = await setup();
    const r = await batteryStart(t.p, t.deps, t.cfg, { name: 'x', need: ['claude-cli'], strict: true });
    expect(r.started).toBe(false); expect(await activeBattery(t.p)).toBeNull();
    expect((await batteryStart(t.p, t.deps, t.cfg, { name: 'x', need: ['claude-cli'] })).started).toBe(true);
  });
  it('tick throttles Claude collection; survey sets baseline and records calibration without double counting', async () => {
    const t = await setup();
    await batteryStart(t.p, t.deps, t.cfg, { name: 'b' });
    t.calls.length = 0; t.bump(3, 1);
    await tick(t.p, t.deps, t.cfg);
    expect(t.calls[0]).not.toContain('claude-cli'); // claude synced < 6 min ago
    await batteryEnd(t.p, t.deps, t.cfg);
    t.bump(5, 10);
    const s = await survey(t.p, t.deps, t.cfg, { analyze: false });
    expect(s.lastSurvey).not.toBeNull();
    const cal = await readCalibration(t.p);
    expect(cal.filter((c) => c.source === 'survey' && c.provider === 'codex-cli' && c.window === '5h')[0].deltaPct).toBe(2);
  });
  it('live view needs no collector and marks stale data unknown', async () => {
    const t = await setup(); await t.deps.collect();
    const fresh = await getManagerView(t.p, NOW, t.cfg);
    expect(fresh.providers.find((x) => x.provider === 'codex-cli')!.band).toBe('green');
    const old = await getManagerView(t.p, NOW + 3600_000, t.cfg);
    expect(old.providers.find((x) => x.provider === 'codex-cli')!.band).toBe('unknown');
  });
});
