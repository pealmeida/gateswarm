import { describe, it, expect, vi } from 'vitest';
import { adviseDowngrade, classifyProviderError, reviewTierRow, getJevDecisionsMode, createJevChoiceFn, localDowngrade, errorCodeToken, type JevChoiceFn } from '../src/jev/quota-advisor.js';
import { JEV_MODEL } from '../src/jev/questions.js';

const env = (m?: string): NodeJS.ProcessEnv => ({ GATESWARM_JEV_MODE: 'shadow', ...(m ? { GATESWARM_JEV_DECISIONS: m } : {}) });
const mk = () => { const recs: Record<string, unknown>[] = []; return { recs, writeRecord: (r: Record<string, unknown>) => void recs.push(r) }; };
const jevSays = (c: string): JevChoiceFn => async () => ({ choice: c, latencyMs: 5, tokensIn: 100 });
const base = { tier: 'extreme', provider: 'claude-cli', premium: true, band: 'yellow' as const, riskFlags: [] as string[] };

describe('mode flag', () => {
  it('defaults to off and requires shadow', () => {
    expect(getJevDecisionsMode({})).toBe('off');
    expect(getJevDecisionsMode({ GATESWARM_JEV_DECISIONS: 'enforce' })).toBe('off');
    expect(getJevDecisionsMode(env('advise'))).toBe('advise');
    expect(getJevDecisionsMode(env('enforce'))).toBe('enforce');
    expect(getJevDecisionsMode(env('on'))).toBe('off');
  });
  it('off never calls Jev', async () => {
    const jev = vi.fn(); const m = mk();
    const r = await adviseDowngrade({ ...base, band: 'red' }, { env: env(), jev, writeRecord: m.writeRecord });
    expect(jev).not.toHaveBeenCalled();
    expect(r.effective).toBe('downgrade'); expect(r.status).toBe('off');
  });
});

describe('downgrade', () => {
  it('local rule', () => {
    expect(localDowngrade({ ...base, band: 'green' })).toBe('keep');
    expect(localDowngrade({ ...base, band: 'yellow' })).toBe('downgrade');
    expect(localDowngrade({ ...base, band: 'yellow', premium: false })).toBe('keep');
    expect(localDowngrade({ ...base, band: 'orange', riskFlags: ['auth_session'] })).toBe('keep');
    expect(localDowngrade({ ...base, band: 'red', riskFlags: ['auth_session'] })).toBe('downgrade');
  });
  it('advise: logs divergence but effective stays local', async () => {
    const m = mk();
    const r = await adviseDowngrade({ ...base, premium: false }, { env: env('advise'), jev: jevSays('downgrade'), writeRecord: m.writeRecord });
    expect(r.local).toBe('keep'); expect(r.proposed).toBe('downgrade'); expect(r.effective).toBe('keep'); expect(r.diverged).toBe(true);
    expect(m.recs[0]).toMatchObject({ kind: 'downgrade', local: 'keep', jev: 'downgrade', effective: 'keep', diverged: true });
  });
  it('enforce: Jev hardens, targetTier steps down', async () => {
    const r = await adviseDowngrade({ ...base, premium: false }, { env: env('enforce'), jev: jevSays('downgrade'), ...mk() });
    expect(r.effective).toBe('downgrade'); expect(r.targetTier).toBe('intensive');
  });
  it('Jev cannot soften and cannot downgrade high-risk tasks outside red', async () => {
    const soft = await adviseDowngrade({ ...base, band: 'red' }, { env: env('enforce'), jev: jevSays('keep'), ...mk() });
    expect(soft.effective).toBe('downgrade');
    const risky = await adviseDowngrade({ ...base, band: 'orange', riskFlags: ['secrets'] }, { env: env('enforce'), jev: jevSays('downgrade'), ...mk() });
    expect(risky.effective).toBe('keep');
  });
  it('fail-open when Jev fails; no prompt text in records', async () => {
    const m = mk();
    const r = await adviseDowngrade(base, { env: env('enforce'), jev: async () => null, writeRecord: m.writeRecord });
    expect(r.status).toBe('skipped'); expect(r.effective).toBe(r.local);
    const thrower: JevChoiceFn = async () => { throw new Error('boom'); };
    expect((await adviseDowngrade(base, { env: env('enforce'), jev: thrower, ...mk() })).effective).toBe('downgrade');
    expect(JSON.stringify(m.recs)).not.toMatch(/prompt|task_text|Bearer/);
  });
});

describe('error classification', () => {
  it('local classes and token whitelist', async () => {
    expect((await classifyProviderError({ provider: 'zai', status: 429, body: '{"code":1308,"message":"5 hour limit"}' }, { env: env(), ...mk() })).local).toBe('quota_exhausted');
    expect((await classifyProviderError({ provider: 'x', status: 401, body: 'MissingSession' }, { env: env(), ...mk() })).local).toBe('auth');
    expect((await classifyProviderError({ provider: 'x', status: 503, body: '' }, { env: env(), ...mk() })).local).toBe('transient');
    expect(errorCodeToken(429, { error: { code: 'insufficient_quota', message: 'secret text' } })).toBe('insufficient_quota');
    expect(errorCodeToken(400, 'random free text')).toBe('none');
  });
  it('Jev hardens transient to quota_exhausted only in enforce', async () => {
    const adv = await classifyProviderError({ provider: 'x', status: 429, body: 'slow down' }, { env: env('advise'), jev: jevSays('quota_exhausted'), ...mk() });
    expect(adv.effective).toBe('transient'); expect(adv.proposed).toBe('quota_exhausted'); expect(adv.diverged).toBe(true);
    const enf = await classifyProviderError({ provider: 'x', status: 429, body: 'slow down' }, { env: env('enforce'), jev: jevSays('quota_exhausted'), ...mk() });
    expect(enf.effective).toBe('quota_exhausted');
    const soft = await classifyProviderError({ provider: 'zai', status: 429, body: '{"code":1308}' }, { env: env('enforce'), jev: jevSays('transient'), ...mk() });
    expect(soft.effective).toBe('quota_exhausted');
  });
  it('log record holds only the code token, not the body', async () => {
    const m = mk();
    await classifyProviderError({ provider: 'x', status: 429, body: 'insufficient_quota SECRET-BODY-TEXT' }, { env: env('advise'), jev: jevSays('quota_exhausted'), writeRecord: m.writeRecord });
    expect(JSON.stringify(m.recs)).not.toContain('SECRET-BODY-TEXT');
  });
});

describe('row review', () => {
  const good = { tier: 'heavy', provider: 'claude-cli', model: 'm', fallbacks: [{ provider: 'bailian', model: 'a' }, { provider: 'bailian', model: 'b' }, { provider: 'codex-cli', model: 'c' }] };
  const bad = { tier: 'x', provider: 'bailian', model: 'm', fallbacks: [{ provider: 'bailian', model: 'a' }] };
  it('local verdicts and Jev hardening', async () => {
    expect((await reviewTierRow(good, { env: env('advise'), jev: jevSays('accept'), ...mk() })).local).toBe('accept');
    const b = await reviewTierRow(bad, { env: env('advise'), jev: jevSays('accept'), ...mk() });
    expect(b.local).toBe('harden'); expect(b.reasons).toContain('no_cross_provider_fallback');
    const g = await reviewTierRow(good, { env: env('enforce'), jev: jevSays('harden'), ...mk() });
    expect(g.effective).toBe('harden'); expect(g.diverged).toBe(true);
    expect((await reviewTierRow(good, { env: env('advise'), jev: jevSays('harden'), ...mk() })).effective).toBe('accept');
  });
});

describe('createJevChoiceFn', () => {
  it('returns choice, null on http error / wrong model / unknown choice / no key', async () => {
    const q = { id: 'downgrade', instructions: 'i', criteria: { keep: 'k', downgrade: 'd' } };
    const ok = (choice: string, model = JEV_MODEL) => (async () => ({ ok: true, json: async () => ({ model, answers: { downgrade: { choice } }, usage: { input_tokens: 50 } }) })) as unknown as typeof fetch;
    expect((await createJevChoiceFn({ apiKey: 'k', fetchImpl: ok('keep') })(q, { a: 1 }))?.choice).toBe('keep');
    expect(await createJevChoiceFn({ apiKey: 'k', fetchImpl: ok('keep', 'other') })(q, {})).toBeNull();
    expect(await createJevChoiceFn({ apiKey: 'k', fetchImpl: ok('weird') })(q, {})).toBeNull();
    expect(await createJevChoiceFn({ apiKey: 'k', fetchImpl: (async () => ({ ok: false })) as unknown as typeof fetch })(q, {})).toBeNull();
    expect(await createJevChoiceFn({ fetchImpl: ok('keep') })(q, {})).toBeNull();
    const body = vi.fn(async (_u: unknown, init: RequestInit) => ({ ok: true, json: async () => ({ model: JEV_MODEL, answers: { downgrade: { choice: 'keep' } } }), _b: init.body }));
    await createJevChoiceFn({ apiKey: 'k', fetchImpl: body as unknown as typeof fetch })(q, { tier: 'heavy' });
    expect(String((body.mock.calls[0]![1] as RequestInit).body)).toContain('"tier":"heavy"');
  });
});
