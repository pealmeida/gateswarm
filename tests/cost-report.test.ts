import { describe, expect, it } from 'vitest';
import { DEFAULT_MATRIX } from 'gateswarm-router';
import { MIN_SAMPLE_FOR_RATE, buildIndexReport, formatIndexReport } from 'gateswarm-mcp';
import type { TelemetryRecord } from 'gateswarm-mcp';

const NOW = 1_800_000_000_000;
const decision = (ts: number, tier: any, modelId: string): TelemetryRecord => ({
  type: 'decision', eventId: `e${ts}${modelId}`, ts, project: 'p', promptHash: 'h', promptSnippet: 's',
  score: 0.3, tier, boundariesHash: 'b', strategy: 'cheapest-capable', modelId,
  provider: 'x', alternatives: [], reason: 'r', matrix: DEFAULT_MATRIX,
});
const feedback = (ts: number, verdict: 'correct' | 'wrong'): TelemetryRecord => ({
  type: 'feedback', ts, project: 'p', decisionEventId: 'e', promptHash: 'h', verdict,
  ...(verdict === 'wrong' ? { correctTier: 'light' as const } : {}),
});
const outcome = (ts: number, quality: number, judge: 'human' | 'model' = 'model', tok = false): TelemetryRecord => ({
  type: 'outcome', ts, project: 'p', modelId: 'gemini-flash-lite', provider: 'google',
  tier: 'light', quality, ok: true, judge, ...(tok ? { tokensIn: 100, tokensOut: 50 } : {}),
});

describe('cost-efficiency index', () => {
  it('measures against always-most-capable and reports the saving', () => {
    const recs = Array.from({ length: 20 }, (_, i) => decision(NOW - 1000 * i, 'light', 'gemini-flash-lite'));
    const r = buildIndexReport('p', recs, DEFAULT_MATRIX, { now: NOW });
    expect(r.overall.decisions).toBe(20);
    // gemini-flash-lite $0.325 vs claude-opus (top maxEffort, most capable) baseline
    expect(r.overall.routedCost).toBeLessThan(r.overall.baselineCost);
    expect(r.overall.costEfficiencyIndex).toBeGreaterThan(0.9);
  });

  it('reports an index of exactly 0 when everything routes to the baseline model', () => {
    const recs = Array.from({ length: 12 }, (_, i) => decision(NOW - 1000 * i, 'extreme', 'claude-opus'));
    const r = buildIndexReport('p', recs, DEFAULT_MATRIX, { now: NOW });
    expect(r.overall.baselineModelId).toBe('claude-opus');
    expect(r.overall.costEfficiencyIndex).toBeCloseTo(0, 6);
  });

  it('picks the baseline deterministically when models tie on maxEffort', () => {
    // claude-sonnet and claude-opus both cap at "extreme"; quality breaks the tie.
    // Without an explicit tie-break the baseline was whichever sorted first,
    // which silently made every saving figure arbitrary.
    const r = buildIndexReport('p', [decision(NOW, 'light', 'gemini-flash-lite')], DEFAULT_MATRIX, { now: NOW });
    expect(r.overall.baselineModelId).toBe('claude-opus');
    const reversed = buildIndexReport('p', [decision(NOW, 'light', 'gemini-flash-lite')], [...DEFAULT_MATRIX].reverse(), { now: NOW });
    expect(reversed.overall.baselineModelId).toBe('claude-opus');
  });

  it('surfaces a negative index rather than hiding overspend', () => {
    const odd = [
      { id: 'cheap-strong', provider: 'a', maxEffort: 'extreme' as const, costPer1MInput: 0.1, costPer1MOutput: 0.2, quality: 0.9 },
      { id: 'pricey-weak', provider: 'b', maxEffort: 'light' as const, costPer1MInput: 50, costPer1MOutput: 90, quality: 0.4 },
    ];
    const recs = Array.from({ length: 12 }, (_, i) => decision(NOW - i, 'light', 'pricey-weak'));
    const r = buildIndexReport('p', recs, odd, { now: NOW });
    expect(r.overall.baselineModelId).toBe('cheap-strong');
    expect(r.overall.costEfficiencyIndex).toBeLessThan(0);
  });

  it('flags decisions naming a model the matrix no longer contains', () => {
    const recs = Array.from({ length: 10 }, (_, i) => decision(NOW - i, 'light', 'retired-model-v1'));
    const r = buildIndexReport('p', recs, DEFAULT_MATRIX, { now: NOW });
    expect(r.overall.unpricedDecisions).toBe(10);
    expect(r.caveats.join(' ')).toMatch(/understates the true routed cost/);
  });

  it('has no index at all with no traffic, rather than a flattering zero', () => {
    const r = buildIndexReport('p', [], DEFAULT_MATRIX, { now: NOW });
    expect(r.overall.costEfficiencyIndex).toBeNull();
    expect(r.caveats.join(' ')).toMatch(/no routing decisions/);
  });
});

describe('honesty guards', () => {
  it('withholds a rate the sample cannot support, and says so', () => {
    const few = [decision(NOW, 'light', 'gemini-flash-lite'), feedback(NOW, 'correct'), feedback(NOW, 'wrong')];
    const r = buildIndexReport('p', few, DEFAULT_MATRIX, { now: NOW });
    expect(r.overall.accuracyN).toBe(2);
    expect(r.overall.accuracyIndex).toBeNull();
    expect(r.caveats.join(' ')).toMatch(/accuracy index withheld/);
    expect(formatIndexReport(r)).toMatch(/n\/a \(2 verdict/);
  });

  it('publishes a rate once the sample is sufficient, with an error bar', () => {
    const recs: TelemetryRecord[] = [decision(NOW, 'light', 'gemini-flash-lite')];
    for (let i = 0; i < MIN_SAMPLE_FOR_RATE; i++) recs.push(feedback(NOW - i, i < 8 ? 'correct' : 'wrong'));
    const r = buildIndexReport('p', recs, DEFAULT_MATRIX, { now: NOW });
    expect(r.overall.accuracyIndex).toBeCloseTo(0.8, 6);
    expect(r.overall.accuracyMargin).toBeGreaterThan(0);
    expect(r.overall.accuracyMargin).toBeLessThan(0.5);
  });

  it('flags a quality index resting only on model self-judgement', () => {
    const recs: TelemetryRecord[] = [decision(NOW, 'light', 'gemini-flash-lite')];
    for (let i = 0; i < 12; i++) recs.push(outcome(NOW - i, 1, 'model'));
    const r = buildIndexReport('p', recs, DEFAULT_MATRIX, { now: NOW });
    expect(r.overall.qualityIndex).toBeCloseTo(1, 6);
    expect(r.caveats.join(' ')).toMatch(/model self-judgement/);
  });

  it('says when the token economy is projected rather than metered', () => {
    const recs = Array.from({ length: 5 }, (_, i) => decision(NOW - i, 'light', 'gemini-flash-lite'));
    expect(buildIndexReport('p', recs, DEFAULT_MATRIX, { now: NOW }).caveats.join(' ')).toMatch(/PROJECTED/);
  });

  it('reports partial token coverage rather than extrapolating', () => {
    const recs: TelemetryRecord[] = Array.from({ length: 10 }, (_, i) => decision(NOW - i, 'light', 'gemini-flash-lite'));
    recs.push(outcome(NOW, 1, 'model', true), outcome(NOW - 1, 1, 'model', true));
    const r = buildIndexReport('p', recs, DEFAULT_MATRIX, { now: NOW });
    expect(r.overall.tokenSampleCount).toBe(2);
    expect(r.overall.tokensIn).toBe(200);
    expect(r.caveats.join(' ')).toMatch(/cover 2\/10 decisions/);
  });
});

describe('trend windows', () => {
  it('buckets by age, newest last, without double-counting', () => {
    const DAY = 86_400_000;
    const recs = [
      ...Array.from({ length: 3 }, (_, i) => decision(NOW - 20 * DAY - i, 'extreme', 'claude-opus')),
      ...Array.from({ length: 5 }, (_, i) => decision(NOW - 2 * DAY - i, 'light', 'gemini-flash-lite')),
    ];
    const r = buildIndexReport('p', recs, DEFAULT_MATRIX, { now: NOW, buckets: 4, bucketDays: 7 });
    expect(r.windows).toHaveLength(4);
    expect(r.windows[r.windows.length - 1].decisions).toBe(5);
    expect(r.windows.reduce((s, w) => s + w.decisions, 0)).toBe(8);
    expect(r.overall.decisions).toBe(8);
  });

  it('renders every figure with its denominator', () => {
    const recs: TelemetryRecord[] = Array.from({ length: 12 }, (_, i) => decision(NOW - i, 'light', 'gemini-flash-lite'));
    for (let i = 0; i < 12; i++) recs.push(feedback(NOW - i, 'correct'), outcome(NOW - i, 0.9, i === 0 ? 'human' : 'model'));
    const text = formatIndexReport(buildIndexReport('p', recs, DEFAULT_MATRIX, { now: NOW }));
    expect(text).toMatch(/Baseline \(no router\)/);
    expect(text).toMatch(/n=12/);
    expect(text).toMatch(/1 human/);
    expect(text).toMatch(/Cost-efficiency index/);
  });
});
