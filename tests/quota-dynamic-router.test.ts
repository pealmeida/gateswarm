import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MgrBand, ProviderState } from '../src/quota-manager/core.js';
import { capabilityOf, candKey, getDynamicRoutingMode, MIN_CAPABILITY, routeDynamic, type Cand, type RouteInput } from '../src/quota-manager/dynamic-router.js';
import { NativeQuotaRuntime } from '../src/quota-manager/native.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const st = (provider: string, band: MgrBand, pct: number | null, extra: Partial<ProviderState> = {}): ProviderState => ({
  provider, plan: null, method: 'test', confidence: pct == null ? 'unknown' : 'measured', syncedAt: null, ageMin: 1, stale: false, band,
  maxUsedPct: pct, limitingWindow: pct == null ? null : '7d', headroomPct: pct == null ? null : 100 - pct, willExhaustBeforeReset: false, windows: [], missing: [], note: null, ...extra,
});
const c = (provider: string, model: string): Cand => ({ provider, model });
const CHAINS: Record<string, Cand[]> = {
  moderate: [c('bailian', 'glm-5.3'), c('bailian', 'qwen3.8-flash'), c('zai', 'glm-5.3'), c('bailian', 'qwen3.7-plus')],
  heavy: [c('claude-cli', 'cc/claude-sonnet-5-5'), c('bailian', 'qwen3.8-max'), c('bailian', 'deepseek-v4-pro'), c('codex-cli', 'cx/gpt-6-luna')],
  extreme: [c('claude-cli', 'cc/claude-opus-5-5'), c('codex-cli', 'cx/gpt-6-sol'), c('bailian', 'qwen3.8-max'), c('codex-cli', 'cx/gpt-6-astra')],
};
function input(tier: string, states: ProviderState[], over: Partial<RouteInput> = {}): RouteInput {
  return { tier, chain: CHAINS[tier], states: Object.fromEntries(states.map((s) => [s.provider, s])), statsOf: () => null, costOf: () => null, breakerOpen: () => false, highRisk: false, now: NOW, ...over };
}
const keys = (r: { chain: Cand[] }) => r.chain.map(candKey);
const REAL = [st('claude-cli', 'red', 87), st('codex-cli', 'green', 38), st('zai', 'unknown', null), st('bailian', 'unknown', null)];

describe('capability', () => {
  it('ranks premium > strong > mid > small, with floors per tier', () => {
    expect(capabilityOf('cc/claude-opus-5-5')).toBe(5);
    expect(capabilityOf('cx/gpt-6-sol')).toBe(4);
    expect(capabilityOf('qwen3.8-max')).toBe(4);
    expect(capabilityOf('glm-5.3')).toBe(3);
    expect(capabilityOf('glm-5.3-flash')).toBe(2);
    expect(capabilityOf('deepseek-v4.1-flash')).toBe(2);
    expect(MIN_CAPABILITY.extreme).toBeGreaterThanOrEqual(MIN_CAPABILITY.heavy);
  });
  it('mode flag defaults to off', () => {
    expect(getDynamicRoutingMode({})).toBe('off');
    expect(getDynamicRoutingMode({ GATESWARM_DYNAMIC_ROUTING: 'SHADOW' })).toBe('shadow');
    expect(getDynamicRoutingMode({ GATESWARM_DYNAMIC_ROUTING: 'bogus' })).toBe('off');
  });
});

describe('dynamic chain', () => {
  it('Claude red -> heavy migrates off Claude to a capable model, with a reason', () => {
    const r = routeDynamic(input('heavy', REAL));
    expect(r.primaryChanged).toBe(true);
    expect(r.chain[0].provider).not.toBe('claude-cli');
    expect(capabilityOf(r.chain[0].model)).toBeGreaterThanOrEqual(MIN_CAPABILITY.heavy);
    expect(r.reasons[0]).toMatch(/claude-cli red 87%/);
    expect(r.forced).toBe(true);
  });
  it('Claude red -> extreme migrates to a >=4 model; never below the floor', () => {
    const r = routeDynamic(input('extreme', REAL));
    expect(r.chain[0].model).not.toMatch(/opus/);
    for (const x of r.chain) expect(capabilityOf(x.model)).toBeGreaterThanOrEqual(MIN_CAPABILITY.extreme);
  });
  it('capability floor drops weak candidates and keeps the static chain when nothing qualifies', () => {
    const weak = [c('zai', 'glm-5.3-flash'), c('bailian', 'qwen3.8-flash')];
    const r = routeDynamic(input('extreme', REAL, { chain: weak }));
    expect(keys(r)).toEqual(weak.map(candKey)); expect(r.changed).toBe(false);
    const mixed = routeDynamic(input('heavy', REAL, { chain: [c('claude-cli', 'cc/claude-sonnet-5-5'), c('zai', 'glm-5.3-flash')] }));
    expect(keys(mixed)).toEqual(['claude-cli/cc/claude-sonnet-5-5']);
  });
  it('idle Bailian absorbs moderate; scarce Z.AI (orange) goes last', () => {
    const r = routeDynamic(input('moderate', [st('bailian', 'green', 8), st('zai', 'orange', 72), st('codex-cli', 'green', 10)]));
    expect(r.chain[0].provider).toBe('bailian');
    expect(r.chain[r.chain.length - 1].provider).toBe('zai');
  });
  it('idle measured quota is preferred over an equally ranked busier one (heavy: Bailian vs yellow Claude)', () => {
    const r = routeDynamic(input('heavy', [st('claude-cli', 'yellow', 45), st('bailian', 'green', 5), st('codex-cli', 'green', 10)]));
    expect(r.chain[0].provider).not.toBe('claude-cli');
  });
  it('unknown providers are neutral: no throw, static order kept', () => {
    const r = routeDynamic(input('moderate', []));
    expect(keys(r)).toEqual(CHAINS.moderate.map(candKey)); expect(r.changed).toBe(false);
  });
  it('breaker-open provider is moved to the tail', () => {
    const r = routeDynamic(input('moderate', [st('bailian', 'green', 5), st('zai', 'green', 5)], { breakerOpen: (p) => p === 'bailian' }));
    expect(r.chain[0].provider).toBe('zai'); expect(r.chain[r.chain.length - 1].provider).toBe('bailian');
    expect(r.reasons[0]).toMatch(/breaker_open/);
  });
  it('everything breaker-open: order preserved (gateway reports skips)', () => {
    const r = routeDynamic(input('moderate', [], { breakerOpen: () => true }));
    expect(keys(r)).toEqual(CHAINS.moderate.map(candKey));
  });
  it('projected exhaustion and thin headroom (learned cost) demote a provider', () => {
    const exhaust = routeDynamic(input('heavy', [st('claude-cli', 'green', 30, { willExhaustBeforeReset: true }), st('bailian', 'green', 10), st('codex-cli', 'green', 10)]));
    expect(exhaust.chain[0].provider).not.toBe('claude-cli');
    const thin = routeDynamic(input('heavy', [st('claude-cli', 'green', 30, { headroomPct: 5 }), st('bailian', 'green', 30)], { costOf: (p) => (p === 'claude-cli' ? 1 : null) }));
    expect(thin.chain[0].provider).not.toBe('claude-cli');
  });
  it('error rate demotes (needs >=5 samples)', () => {
    const stats = (p: string) => (p === 'bailian' ? { samples: 10, errorRate: 0.7, p50LatencyMs: 1000, requests5h: 10 } : null);
    const r = routeDynamic(input('moderate', [st('bailian', 'green', 20), st('zai', 'green', 20)], { statsOf: stats }));
    expect(r.chain[0].provider).toBe('zai');
    const few = routeDynamic(input('moderate', [st('bailian', 'green', 20), st('zai', 'green', 20)], { statsOf: () => ({ samples: 2, errorRate: 1, p50LatencyMs: null, requests5h: 2 }) }));
    expect(few.chain[0].provider).toBe('bailian');
  });
  it('Jev can only harden', () => {
    const base = routeDynamic(input('heavy', [st('claude-cli', 'green', 10), st('bailian', 'green', 30), st('codex-cli', 'green', 30)]));
    const hard = routeDynamic(input('heavy', [st('claude-cli', 'green', 10), st('bailian', 'green', 30), st('codex-cli', 'green', 30)], { jevRelieve: (p) => p === 'claude-cli' }));
    expect(base.chain[0].provider).toBe('claude-cli');
    expect(hard.chain[0].provider).not.toBe('claude-cli');
    // a relieve vote on a provider never improves its position
    const soft = routeDynamic(input('heavy', [st('claude-cli', 'green', 10), st('bailian', 'green', 30)], { jevRelieve: (p) => p === 'bailian' }));
    expect(soft.chain[0].provider).toBe('claude-cli');
  });
});

describe('high risk', () => {
  it('keeps the strong static primary through yellow/idle pressure', () => {
    const states = [st('claude-cli', 'yellow', 50), st('bailian', 'green', 2), st('codex-cli', 'green', 5)];
    expect(routeDynamic(input('heavy', states)).chain[0].provider).not.toBe('claude-cli');
    const r = routeDynamic(input('heavy', states, { highRisk: true }));
    expect(r.chain[0].provider).toBe('claude-cli'); expect(r.reasons.join()).toMatch(/high_risk/);
  });
  it('still moves off a red or breaker-open primary, and never explores', () => {
    expect(routeDynamic(input('heavy', REAL, { highRisk: true })).chain[0].provider).not.toBe('claude-cli');
    const r = routeDynamic(input('heavy', [st('claude-cli', 'green', 10), st('bailian', 'unknown', null)], { highRisk: true, exploreTick: 25 }));
    expect(r.explored).toBe(false); expect(r.chain[0].provider).toBe('claude-cli');
  });
});

describe('hysteresis + exploration', () => {
  const A = (pct: number) => [st('bailian', 'green', pct), st('zai', 'green', 20)];
  it('does not flap on small score differences', () => {
    let prev = { primary: 'bailian/glm-5.3', at: NOW - 600_000 };
    const seq = [20, 24, 18, 26, 22, 25, 19];
    for (const [i, pct] of seq.entries()) {
      const r = routeDynamic(input('moderate', A(pct), { prev, now: NOW + i * 1000 }));
      expect(r.chain[0].provider).toBe('bailian');
    }
  });
  it('a big sustained shift switches, red switches immediately even inside dwell', () => {
    const prev = { primary: 'bailian/glm-5.3', at: NOW - 1000 };
    const big = routeDynamic(input('moderate', [st('bailian', 'red', 90), st('zai', 'green', 10)], { prev }));
    expect(big.chain[0].provider).toBe('zai');
    const dwell = routeDynamic(input('moderate', [st('bailian', 'yellow', 60), st('zai', 'green', 10)], { prev }));
    expect(dwell.chain[0].provider).toBe('bailian'); expect(dwell.reasons.join()).toMatch(/hysteresis/);
  });
  it('exploration promotes an unmeasured idle candidate every Nth request', () => {
    const states = [st('claude-cli', 'green', 10), st('bailian', 'unknown', null), st('codex-cli', 'green', 10)];
    const off = routeDynamic(input('heavy', states, { exploreTick: 3 }));
    const on = routeDynamic(input('heavy', states, { exploreTick: 25 }));
    expect(off.explored).toBe(false); expect(on.explored).toBe(true);
    expect(on.reasons.join()).toMatch(/explore/);
  });
  it('is deterministic', () => {
    const a = routeDynamic(input('heavy', REAL)); const b = routeDynamic(input('heavy', REAL));
    expect(keys(a)).toEqual(keys(b)); expect(a.reasons).toEqual(b.reasons);
  });
});

describe('NativeQuotaRuntime', () => {
  const mk = (mode: string) => { const n = new NativeQuotaRuntime({ GATESWARM_DYNAMIC_ROUTING: mode, GATESWARM_ROOT: join(tmpdir(), `nq-${Math.random().toString(36).slice(2)}`) } as NodeJS.ProcessEnv); n._setState(REAL); return n; };
  const args = (n: NativeQuotaRuntime) => ({ tier: 'heavy', primary: CHAINS.heavy[0], fallbacks: CHAINS.heavy.slice(1), highRisk: false, breakerOpen: () => false, now: NOW });
  it('off: static chain, no work', () => {
    const n = mk('off'); const d = n.decide(args(n));
    expect(d.applied).toBe(false); expect(d.result).toBeNull(); expect(d.primary).toEqual(CHAINS.heavy[0]);
  });
  it('shadow: computes + reports a difference but keeps the static chain', () => {
    const n = mk('shadow'); const d = n.decide(args(n));
    expect(d.applied).toBe(false); expect(d.result?.primaryChanged).toBe(true);
    expect(d.primary).toEqual(CHAINS.heavy[0]); expect(d.fallbacks).toEqual(CHAINS.heavy.slice(1));
    expect(d.header).toMatch(/claude-cli red/);
  });
  it('on: applies the dynamic chain; header has no newline/non-ascii; snapshot counts decisions', () => {
    const n = mk('on'); const d = n.decide(args(n));
    expect(d.applied).toBe(true); expect(d.primary.provider).not.toBe('claude-cli');
    expect(d.header).toMatch(/^[\x20-\x7E]*$/);
    expect(n.snapshot().decisions.appliedChanged).toBe(1);
  });
  it('fail-open: a throwing breaker callback returns the static chain', () => {
    const n = mk('on'); const d = n.decide({ ...args(n), breakerOpen: () => { throw new Error('boom'); } });
    expect(d.applied).toBe(false); expect(d.primary).toEqual(CHAINS.heavy[0]);
  });
  it('decision log holds tier/provider/model/reasons but no prompt text', async () => {
    const root = join(tmpdir(), `nq-log-${Date.now()}`);
    const n = new NativeQuotaRuntime({ GATESWARM_DYNAMIC_ROUTING: 'shadow', GATESWARM_ROOT: root } as NodeJS.ProcessEnv); n._setState(REAL);
    n.decide(args(n)); await new Promise((r) => setTimeout(r, 100));
    const line = (await fs.readFile(join(root, 'data', 'dynamic-routing.jsonl'), 'utf8')).trim().split('\n')[0];
    const row = JSON.parse(line);
    expect(row.tier).toBe('heavy'); expect(row.static.length).toBe(4); expect(Object.keys(row)).not.toContain('prompt');
  });
  it('refresh reads sync file, learns live cost, and survives a missing/corrupt state (fail-open)', async () => {
    const root = join(tmpdir(), `nq-refresh-${Date.now()}`); await fs.mkdir(join(root, 'data'), { recursive: true });
    const n = new NativeQuotaRuntime({ GATESWARM_DYNAMIC_ROUTING: 'shadow', GATESWARM_ROOT: root } as NodeJS.ProcessEnv);
    await n.refresh(NOW); // no files at all
    expect(n.snapshot().lastRefreshError).toBeNull();
    const reset = new Date(NOW + 3600_000).toISOString();
    const write = (pct: number) => fs.writeFile(join(root, 'data', 'quota-sync.json'), JSON.stringify({ snapshots: { 'codex-cli': { provider: 'codex-cli', syncedAt: new Date(NOW).toISOString(), source: 'codexbar-cli', windows: { '5h': { usedPct: pct, resetAt: reset, windowMinutes: 300 } } } } }));
    await write(10); await n.refresh(NOW);
    for (let i = 0; i < 4; i++) n.observe('codex-cli', true, 900, 'intensive');
    await write(14); await n.refresh(NOW + 60_000);
    const cal = (await fs.readFile(join(root, 'data', 'quota-calibration.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(cal[0]).toMatchObject({ source: 'live', provider: 'codex-cli', window: '5h', requests: 4, deltaPct: 4, pctPerRequest: 1, tiers: ['intensive'] });
    expect(n.costOf('codex-cli', 'intensive')).toBe(1);
    await fs.writeFile(join(root, 'data', 'quota-sync.json'), '{not json'); await n.refresh(NOW + 120_000);
    expect(n.snapshot().providers.length).toBeGreaterThan(0);
  });
  it('optimizer proposes a diff, marked as never applied', async () => {
    const n = mk('shadow'); n.setTierChains(() => ({ heavy: { primary: CHAINS.heavy[0], fallbacks: CHAINS.heavy.slice(1) } }));
    const p = await n.optimize(NOW) as { applied: boolean; diff: string };
    expect(p.applied).toBe(false); expect(p.diff).toMatch(/tier_models\.heavy/);
  });
});
