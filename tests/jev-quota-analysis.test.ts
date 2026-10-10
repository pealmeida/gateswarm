import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeProviders, analyzeQuota, applyMoves, proposeMoves, renderDiff, renderReportText, loadAnalysisInput, monthlyPace, type QuotaAnalysisInput, type TierModels } from '../src/jev/quota-analysis.js';
import type { JevChoiceFn } from '../src/jev/quota-advisor.js';
import { quotaAdvisorObserveRequest, quotaAdvisorObserveFailure } from '../src/jev/quota-advisor-hooks.js';

const H = 3600_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const env = (m?: string): NodeJS.ProcessEnv => ({ GATESWARM_JEV_MODE: 'shadow', ...(m ? { GATESWARM_JEV_DECISIONS: m } : {}) });
const mkLog = () => { const recs: Record<string, unknown>[] = []; return { recs, writeRecord: (r: Record<string, unknown>) => void recs.push(r) }; };

const tiers = (): TierModels => ({
  trivial: { provider: 'zai', model: 'glm-5.3-flash', fallback_models: [{ provider: 'bailian', model: 'qwen3.8-flash' }, { provider: 'ollama', model: 'q' }] },
  moderate: { provider: 'bailian', model: 'glm-5.3', fallback_models: [{ provider: 'zai', model: 'glm-5.3' }] },
  heavy: { provider: 'claude-cli', model: 'cc/claude-sonnet-5-5', fallback_models: [{ provider: 'bailian', model: 'qwen3.8-max' }], plan_provider: 'zai', plan_model: 'glm-5.3' },
});
const bucket = (hoursAgo: number, tokens: number, requests = 10, errors = 0) => { const h = Math.floor((NOW - hoursAgo * H) / H) * H; return [String(h), { hourStart: h, requests, tokensIn: tokens / 2, tokensOut: tokens / 2, errors, latencySum: requests * 1000, latencyCount: requests }] as const; };
const hist = (m: Record<string, Array<ReturnType<typeof bucket>>>) => ({ providers: Object.fromEntries(Object.entries(m).map(([p, b]) => [p, { buckets: Object.fromEntries(b) }])) });
const input = (over: Partial<QuotaAnalysisInput> = {}): QuotaAnalysisInput => ({
  now: NOW, tierModels: tiers(),
  history: hist({ zai: [bucket(30, 1000, 50), bucket(2, 1000, 50)], bailian: [bucket(30, 100, 5), bucket(1, 50, 3)], 'claude-cli': [bucket(1, 10, 2)] }),
  ...over,
});
const jev = (map: Record<string, string>): JevChoiceFn => async (q) => ({ choice: map[q.id] ?? Object.keys(q.criteria)[0]!, latencyMs: 7, tokensIn: 400 });

describe('local analysis', () => {
  it('computes windows, shares and classes', () => {
    const a = analyzeProviders(input({ quotaSync: { snapshots: { zai: { windows: { '5h': { usedPct: 91 } } } } } }));
    const z = a.find((p) => p.provider === 'zai')!;
    expect(z.class).toBe('scarce_window'); expect(z.w5h.usedPct).toBe(91); expect(z.band).toBe('red'); expect(z.localStance).toBe('reduce_load');
    expect(z.tokenShare7dPct).toBeGreaterThan(80);
    const b = a.find((p) => p.provider === 'bailian')!;
    expect(b.idleInferred).toBe(true); expect(b.localStance).toBe('increase_load'); expect(b.headroom).toBe('ample');
  });
  it('scarce providers are never asked to take more load; limits file gives pct', () => {
    const a = analyzeProviders(input({ limits: { 'claude-cli': { '5h': 1000 } } }));
    const c = a.find((p) => p.provider === 'claude-cli')!;
    expect(c.w5h.pctSource).toBe('limits'); expect(c.localStance).toBe('hold');
  });
  it('breaker / rate limit / pace / concentration harden to reduce_load', () => {
    const a = analyzeProviders(input({ providerQuota: { quotas: { bailian: { breakerUntil: NOW + H }, 'claude-cli': { rateLimitHits: 5 } } } }));
    expect(a.find((p) => p.provider === 'bailian')!.localStance).toBe('reduce_load');
    expect(a.find((p) => p.provider === 'claude-cli')!.localReasons).toContain('rate_limit_hits_5');
    expect(a.find((p) => p.provider === 'zai')!.localReasons).toContain('concentrated_load_unknown_limit');
  });
  it('monthly pace', () => {
    expect(monthlyPace(50, NOW, undefined)).toBeNull();
    expect(monthlyPace(50, Date.UTC(2026, 9, 16), 1)).toBeCloseTo(50 / 50, 0);
  });
});

describe('moves and diff', () => {
  it('protects a pressured primary and uses idle quota for low tiers', () => {
    const st = (p: string) => (p === 'zai' ? 'reduce_load' : p === 'bailian' ? 'increase_load' : 'hold') as 'hold';
    const moves = proposeMoves(tiers(), st);
    expect(moves.map((m) => `${m.tier}:${m.field}:${m.to.provider}`)).toEqual(['trivial:primary:bailian', 'heavy:plan:bailian']);
    const after = applyMoves(tiers(), moves);
    expect(after.trivial!.provider).toBe('bailian'); expect(after.trivial!.fallback_models!.at(-1)).toMatchObject({ provider: 'zai' });
    expect(after.heavy!.plan_provider).toBe('bailian'); expect(after.heavy!.provider).toBe('claude-cli');
    const d = renderDiff(tiers(), after);
    expect(d).toContain('@@ tier_models.trivial @@'); expect(d).toContain('+  primary: bailian/qwen3.8-flash'); expect(d).not.toContain('moderate');
  });
  it('does not duplicate the demoted primary in fallbacks', () => {
    const t = tiers(); t.trivial!.fallback_models!.push({ provider: 'zai', model: 'glm-5.3-flash' });
    const after = applyMoves(t, proposeMoves(t, (p) => (p === 'zai' ? 'reduce_load' : p === 'bailian' ? 'increase_load' : 'hold')));
    expect(after.trivial!.fallback_models!.filter((f) => f.provider === 'zai' && f.model === 'glm-5.3-flash').length).toBe(1);
  });
  it('heavy+ primaries are not moved to use idle quota', () => {
    const moves = proposeMoves(tiers(), (p) => (p === 'bailian' ? 'increase_load' : 'hold'));
    expect(moves.find((m) => m.tier === 'heavy')).toBeUndefined();
  });
  it('applyMoves never mutates the input', () => {
    const t = tiers(); const snap = JSON.stringify(t);
    applyMoves(t, proposeMoves(t, (p) => (p === 'zai' ? 'reduce_load' : 'hold')));
    expect(JSON.stringify(t)).toBe(snap);
  });
});

describe('analyzeQuota with Jev', () => {
  const zaiHot = () => input({ quotaSync: { snapshots: { zai: { windows: { '5h': { usedPct: 90 } } } } } });
  it('off: Jev is never called, result is local-only and not applied', async () => {
    const j = vi.fn(); const m = mkLog();
    const r = await analyzeQuota(zaiHot(), { env: env(), jev: j, writeRecord: m.writeRecord });
    expect(j).not.toHaveBeenCalled(); expect(r.applied).toBe(false); expect(r.mode).toBe('off');
    expect(r.diffLocal).toBe(r.diffJev); expect(r.diffLocal).toContain('trivial');
  });
  it('advise: agreement is logged and Jev vetoes only remove moves', async () => {
    const m = mkLog();
    const r = await analyzeQuota(zaiHot(), { env: env('advise'), jev: jev({ provider_stance: 'hold', move_review: 'accept' }), writeRecord: m.writeRecord });
    expect(r.jev.calls).toBeGreaterThan(0); expect(r.jev.ok).toBe(r.jev.calls);
    expect(r.movesJev.length).toBeLessThanOrEqual(r.movesLocal.length);
    const z = r.providers.find((p) => p.provider === 'zai')!;
    expect(z.localStance).toBe('reduce_load'); expect(z.jevStance).toBe('hold'); expect(z.stance).toBe('reduce_load'); // Jev cannot soften
  });
  it('Jev can harden: reduce_load on bailian cancels the use_idle move; reject vetoes a move', async () => {
    const hot = analyzeQuota(input(), { env: env('advise'), jev: jev({ provider_stance: 'reduce_load', move_review: 'accept' }), writeRecord: () => {} });
    const r = await hot;
    expect(r.providers.find((p) => p.provider === 'bailian')!.stance).toBe('reduce_load');
    const veto = await analyzeQuota(zaiHot(), { env: env('advise'), jev: jev({ provider_stance: 'hold', move_review: 'reject' }), writeRecord: () => {} });
    expect(veto.movesLocal.length).toBeGreaterThan(0); expect(veto.movesJev.length).toBe(0); expect(veto.diffJev).toBe('(no changes proposed)');
    expect(veto.movesLocal.every((x) => x.jevVerdict === 'reject')).toBe(true);
  });
  it('fail-open: Jev failures leave the local result', async () => {
    const r = await analyzeQuota(zaiHot(), { env: env('enforce'), jev: async () => null, writeRecord: () => {} });
    expect(r.jev.failed).toBe(r.jev.calls); expect(r.movesJev.length).toBe(r.movesLocal.length);
    const t = await analyzeQuota(zaiHot(), { env: env('advise'), jev: async () => { throw new Error('x'); }, writeRecord: () => {} });
    expect(t.movesLocal.length).toBeGreaterThan(0);
  });
  it('logs carry only aggregates: no prompt text, keys or hosts', async () => {
    const m = mkLog();
    await analyzeQuota(zaiHot(), { env: { ...env('advise'), TYPESAFE_API_KEY: 'FAKE_TEST_VALUE_123' }, jev: jev({}), writeRecord: m.writeRecord });
    const s = JSON.stringify(m.recs);
    expect(s).not.toContain('FAKE_TEST_VALUE'); expect(s).not.toMatch(/https?:\/\//); expect(s).not.toMatch(/prompt/i);
    expect(m.recs.some((x) => x.kind === 'summary')).toBe(true);
  });
  it('renders a text report', async () => {
    const r = await analyzeQuota(zaiHot(), { env: env(), writeRecord: () => {} });
    expect(renderReportText(r)).toContain('NOT APPLIED');
  });
});

describe('loadAnalysisInput', () => {
  it('reads files tolerant of missing ones', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'qa-')); await fs.mkdir(join(root, 'data'));
    await fs.writeFile(join(root, 'cfg.json'), JSON.stringify({ tier_models: tiers() }));
    await fs.writeFile(join(root, 'data', 'consumption-history.json'), JSON.stringify(hist({ zai: [bucket(1, 10)] })));
    const i = await loadAnalysisInput({ root, configFile: join(root, 'cfg.json'), env: {}, now: NOW });
    expect(i?.quotaSync).toBeNull(); expect(i?.history?.providers?.zai).toBeTruthy();
    expect(await loadAnalysisInput({ root, configFile: join(root, 'nope.json'), env: {} })).toBeNull();
  });
});

describe('gateway hooks', () => {
  it('are no-ops when decisions are off and never throw', () => {
    expect(() => quotaAdvisorObserveRequest({ tier: 'heavy', providerId: 'claude-cli', model: 'x', promptText: 'hi', env: env() })).not.toThrow();
    expect(() => quotaAdvisorObserveFailure('zai', 429, 'x', undefined, env())).not.toThrow();
  });
  it('advise: writes an advisor line without prompt text', async () => {
    const p = join(await fs.mkdtemp(join(tmpdir(), 'qh-')), 'a.jsonl');
    const e = { ...env('advise'), GATESWARM_JEV_QUOTA_ADVISOR_LOG: p, TYPESAFE_API_KEY: '' };
    quotaAdvisorObserveRequest({ tier: 'extreme', providerId: 'claude-cli', model: 'cc/claude-opus-5-5', promptText: 'SECRET PROMPT TEXT fix auth session', requestId: 'r1', env: e });
    quotaAdvisorObserveFailure('zai', 429, '{"error":{"code":"1308","message":"PRIVATE BODY"}}', 'r1', e);
    await new Promise((r) => setTimeout(r, 300));
    const txt = await fs.readFile(p, 'utf8');
    expect(txt).toContain('"kind":"downgrade"'); expect(txt).toContain('"kind":"error_class"');
    expect(txt).not.toContain('SECRET PROMPT'); expect(txt).not.toContain('PRIVATE BODY');
  });
});
