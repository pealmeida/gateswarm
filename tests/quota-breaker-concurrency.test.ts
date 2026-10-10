import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyQuotaExhaustion, providerQuota } from '../src/provider-quota.js';
import { ProviderConcurrency } from '../src/provider-concurrency.js';
import { monthlyPaceRatio } from '../src/quota-band-matrix.js';

describe('classifyQuotaExhaustion', () => {
  const now = Date.UTC(2026, 9, 10, 0, 0, 0);
  it('returns null for an ordinary 429', () => {
    expect(classifyQuotaExhaustion(429, '{"error":{"message":"rate limit, slow down"}}', now)).toBeNull();
    expect(classifyQuotaExhaustion(500, 'boom', now)).toBeNull();
  });
  it('detects Z.AI 1308 and clamps the reset to <= 6h', () => {
    const body = '{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-12 06:40:09"}}';
    const hit = classifyQuotaExhaustion(429, body, now)!;
    expect(hit.kind).toBe('zai_1308');
    expect(hit.until).toBe(now + 6 * 3600_000);
  });
  it('uses the parsed reset time when it is near (interpreted as UTC+8 by default)', () => {
    const body = '{"error":{"code":"1308","message":"5 hour limit, reset at 2026-10-10 05:00:00"}}';
    const hit = classifyQuotaExhaustion(429, body, now)!;
    expect(hit.until).toBe(Date.UTC(2026, 9, 9, 21, 0, 0) > now ? Date.UTC(2026, 9, 9, 21, 0, 0) : now + 60_000);
  });
  it('detects insufficient_quota with a 1h re-probe default', () => {
    const hit = classifyQuotaExhaustion(429, '{"error":{"code":"insufficient_quota"}}', now)!;
    expect(hit.kind).toBe('insufficient_quota');
    expect(hit.until).toBe(now + 3600_000);
  });
});

describe('circuit breaker on providerQuota', () => {
  it('opens on 1308, blocks shouldSwitch, and survives recordSuccess', async () => {
    await providerQuota.initialize();
    expect(providerQuota.isBreakerOpen('zai')).toBe(false);
    const hit = providerQuota.noteUpstreamFailure('zai', 429, '{"error":{"code":"1308","message":"5 hour limit"}}');
    expect(hit?.kind).toBe('zai_1308');
    expect(providerQuota.isBreakerOpen('zai')).toBe(true);
    expect(providerQuota.shouldSwitch('zai').shouldSwitch).toBe(true);
    providerQuota.recordSuccess('zai');
    expect(providerQuota.isBreakerOpen('zai')).toBe(true);
    expect(providerQuota.getOpenBreakers().some(b => b.provider === 'zai')).toBe(true);
    const q = providerQuota.getQuota('zai')!;
    q.breakerUntil = 0; q.throttled = false; q.throttledUntil = 0; // reset shared singleton
    expect(providerQuota.isBreakerOpen('zai')).toBe(false);
  });
  it('ignores non-quota failures', async () => {
    expect(providerQuota.noteUpstreamFailure('bailian', 429, 'too many requests')).toBeNull();
    expect(providerQuota.isBreakerOpen('bailian')).toBe(false);
  });
});

describe('ProviderConcurrency', () => {
  afterEach(() => vi.useRealTimers());
  it('caps in-flight calls and hands the slot to waiters', async () => {
    const c = new ProviderConcurrency(p => (p === 'claude-cli' ? 1 : 0));
    const r1 = await c.acquire('claude-cli', 0);
    expect(r1).not.toBeNull();
    expect(await c.acquire('claude-cli', 0)).toBeNull();
    const waiting = c.acquire('claude-cli', 1000);
    r1!();
    const r2 = await waiting;
    expect(r2).not.toBeNull();
    expect(c.snapshot()['claude-cli'].inFlight).toBe(1);
    r2!(); r2!(); // idempotent
    expect(c.snapshot()['claude-cli'].inFlight).toBe(0);
  });
  it('times out waiters and treats limit 0 as unlimited', async () => {
    const c = new ProviderConcurrency(p => (p === 'codex-cli' ? 1 : 0));
    await c.acquire('codex-cli', 0);
    expect(await c.acquire('codex-cli', 20)).toBeNull();
    for (let i = 0; i < 5; i++) expect(await c.acquire('bailian', 0)).not.toBeNull();
  });
});

describe('monthlyPaceRatio', () => {
  const now = new Date(Date.UTC(2026, 9, 16, 0, 0, 0)); // 15 days after day-1 start => 50% of cycle
  it('is null without a cycle start or usage', () => {
    expect(monthlyPaceRatio(40, now, undefined)).toBeNull();
    expect(monthlyPaceRatio(null, now, 1)).toBeNull();
  });
  it('computes usage vs linear pace', () => {
    expect(monthlyPaceRatio(60, now, 1)!).toBeCloseTo(1.2, 5);
    expect(monthlyPaceRatio(25, now, 1)!).toBeCloseTo(0.5, 5);
  });
  it('is null too early in the cycle', () => {
    expect(monthlyPaceRatio(10, new Date(Date.UTC(2026, 9, 1, 6, 0, 0)), 1)).toBeNull();
  });
});

describe('per-provider overlays (quota_band_matrices.json)', () => {
  it('Claude yellow removes Opus only; Z.AI yellow removes glm-5.3 only', async () => {
    const { readFileSync } = await import('fs');
    const { applyProviderOverlays } = await import('../src/quota-band-matrix.js');
    const m = JSON.parse(readFileSync(new URL('../calibration/matrix-variants/quota_band_matrices.json', import.meta.url), 'utf-8'));
    const base = m.bands.green.tier_models;
    const pct = (provider: string, fiveHourPct: number) => ({ provider, fiveHourPct, weeklyPct: null, monthlyPct: null, maxPct: fiveHourPct, window: 'fiveHour' as const, source: 'quota_sync' as const });

    const c = applyProviderOverlays(base, [pct('claude-cli', 45)], m);
    expect(c.overlaysApplied).toEqual(['claude_yellow']);
    expect(c.effectiveTierModels.extreme.model).toBe('cx/gpt-6-sol');
    expect(c.effectiveTierModels.heavy.model).toBe('cc/claude-sonnet-5-5');

    const z = applyProviderOverlays(base, [pct('zai', 55)], m);
    expect(z.overlaysApplied).toEqual(['zai_high']);
    expect(z.effectiveTierModels.moderate.fallback_models!.some((f: any) => f.provider === 'zai' && f.model === 'glm-5.3')).toBe(false);
    expect(z.effectiveTierModels.light.fallback_models!.some((f: any) => f.model === 'glm-5.3-flash')).toBe(true);

    const x = applyProviderOverlays(base, [pct('codex-cli', 55)], m);
    expect(x.effectiveTierModels.extreme.fallback_models!.some((f: any) => f.model === 'cx/gpt-6-astra')).toBe(false);

    const red = applyProviderOverlays(base, [pct('zai', 90)], m);
    for (const t of Object.values(red.effectiveTierModels) as any[]) {
      expect(t.provider).not.toBe('zai');
      expect((t.fallback_models || []).some((f: any) => f.provider === 'zai')).toBe(false);
    }
  });
});
