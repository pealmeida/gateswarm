import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATRIX,
  formatRecalibration,
  recalibrateMatrix,
  selectModel,
  type ModelSpec,
  type OutcomeRecord,
} from 'gateswarm-router';

const rep = (n: number, o: OutcomeRecord): OutcomeRecord[] => Array.from({ length: n }, () => ({ ...o }));

describe('outcome-driven matrix recalibration', () => {
  it('returns a new matrix and never mutates the input', () => {
    const before = JSON.stringify(DEFAULT_MATRIX);
    const r = recalibrateMatrix(DEFAULT_MATRIX, rep(10, { modelId: 'deepseek-chat', tier: 'moderate', quality: 0.2 }));
    expect(JSON.stringify(DEFAULT_MATRIX)).toBe(before);
    expect(r.matrix).not.toBe(DEFAULT_MATRIX);
    expect(r.matrix).toHaveLength(DEFAULT_MATRIX.length);
  });

  it('moves quality toward what a model actually delivered', () => {
    const good = recalibrateMatrix(DEFAULT_MATRIX, rep(20, { modelId: 'gemini-flash-lite', tier: 'light', quality: 1 }));
    const lite = good.calibrations.find((c) => c.modelId === 'gemini-flash-lite')!;
    expect(lite.observedQuality).toBeCloseTo(1, 6);
    expect(lite.calibratedQuality).toBeGreaterThan(lite.priorQuality);
  });

  it('does not let thin evidence overturn a prior', () => {
    const r = recalibrateMatrix(DEFAULT_MATRIX, rep(2, { modelId: 'claude-opus', tier: 'extreme', quality: 0 }));
    const opus = r.calibrations.find((c) => c.modelId === 'claude-opus')!;
    // 2 observations against K=8 pseudo-counts: the prior still dominates.
    expect(opus.shrunkQuality).toBeGreaterThan(0.7);
  });

  it('demotes maxEffort only on sustained failure at the ceiling tier', () => {
    const thin = recalibrateMatrix(DEFAULT_MATRIX, rep(3, { modelId: 'deepseek-chat', tier: 'heavy', quality: 0.1 }));
    expect(thin.calibrations.find((c) => c.modelId === 'deepseek-chat')!.calibratedMaxEffort).toBe('heavy');

    const sustained = recalibrateMatrix(DEFAULT_MATRIX, rep(8, { modelId: 'deepseek-chat', tier: 'heavy', quality: 0.1 }));
    const ds = sustained.calibrations.find((c) => c.modelId === 'deepseek-chat')!;
    expect(ds.calibratedMaxEffort).toBe('moderate');
    expect(ds.notes.join(' ')).toMatch(/maxEffort heavy → moderate/);
  });

  it('changes what the router picks next — the point of the loop', () => {
    expect(selectModel('heavy', DEFAULT_MATRIX).model.id).toBe('deepseek-chat');
    const r = recalibrateMatrix(DEFAULT_MATRIX, rep(8, { modelId: 'deepseek-chat', tier: 'heavy', quality: 0.1 }));
    expect(selectModel('heavy', r.matrix).model.id).not.toBe('deepseek-chat');
  });

  it('excludes transport failures from quality but counts them', () => {
    const r = recalibrateMatrix(DEFAULT_MATRIX, [
      ...rep(4, { modelId: 'gemini-pro', tier: 'intensive', quality: 1 }),
      ...rep(3, { modelId: 'gemini-pro', tier: 'intensive', quality: 0, ok: false }),
    ]);
    const pro = r.calibrations.find((c) => c.modelId === 'gemini-pro')!;
    expect(pro.samples).toBe(4);
    expect(pro.failures).toBe(3);
    expect(pro.observedQuality).toBeCloseTo(1, 6);
  });

  it('weights human verdicts above model ones', () => {
    const modelJudged = recalibrateMatrix(DEFAULT_MATRIX, rep(4, { modelId: 'gpt-5.2', tier: 'intensive', quality: 0 }));
    const humanJudged = recalibrateMatrix(
      DEFAULT_MATRIX,
      rep(4, { modelId: 'gpt-5.2', tier: 'intensive', quality: 0, weight: 2 }),
    );
    const m = modelJudged.calibrations.find((c) => c.modelId === 'gpt-5.2')!.shrunkQuality;
    const h = humanJudged.calibrations.find((c) => c.modelId === 'gpt-5.2')!.shrunkQuality;
    expect(h).toBeLessThan(m);
  });

  it('keeps calibrated qualities within the input matrix span', () => {
    const lo = Math.min(...DEFAULT_MATRIX.map((m) => m.quality));
    const hi = Math.max(...DEFAULT_MATRIX.map((m) => m.quality));
    const r = recalibrateMatrix(DEFAULT_MATRIX, [
      ...rep(20, { modelId: 'gemini-flash-lite', tier: 'light', quality: 1 }),
      ...rep(20, { modelId: 'claude-opus', tier: 'extreme', quality: 0 }),
    ]);
    for (const m of r.matrix) {
      expect(m.quality).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(m.quality).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  it('never moves a model that has no evidence of its own', () => {
    // Regression: an earlier version renormalised every model against the new
    // min/max, so grading one model down promoted six ungraded ones — enough to
    // push one past a minQuality gate on no evidence about itself.
    const r = recalibrateMatrix(DEFAULT_MATRIX, rep(10, { modelId: 'deepseek-chat', tier: 'heavy', quality: 0.1 }));
    for (const c of r.calibrations) {
      if (c.samples === 0) expect(c.calibratedQuality).toBeCloseTo(c.priorQuality, 9);
    }
    // ...while the graded model still moves, and its demotion still reroutes.
    const ds = r.calibrations.find((c) => c.modelId === 'deepseek-chat')!;
    expect(ds.calibratedQuality).toBeLessThan(ds.priorQuality);
    expect(selectModel('heavy', r.matrix).model.id).not.toBe('deepseek-chat');
  });

  it('does not let one model\'s grades change another past a minQuality gate', () => {
    const gate = 0.6;
    const before = DEFAULT_MATRIX.filter((m) => m.quality >= gate).map((m) => m.id).sort();
    const r = recalibrateMatrix(DEFAULT_MATRIX, rep(10, { modelId: 'deepseek-chat', tier: 'heavy', quality: 0.1 }));
    const after = r.matrix.filter((m) => m.quality >= gate && m.id !== 'deepseek-chat').map((m) => m.id).sort();
    expect(after).toEqual(before.filter((id) => id !== 'deepseek-chat'));
  });

  it('reports outcomes referencing models that are not in the matrix', () => {
    const r = recalibrateMatrix(DEFAULT_MATRIX, rep(3, { modelId: 'retired-model-v1', tier: 'heavy', quality: 1 }));
    expect(r.unknownModelIds).toEqual(['retired-model-v1']);
  });

  it('leaves every model alone when there are no outcomes', () => {
    const r = recalibrateMatrix(DEFAULT_MATRIX, []);
    expect(r.matrix).toEqual([...DEFAULT_MATRIX]);
    expect(formatRecalibration(r)).toMatch(/unchanged/);
  });

  it('will not demote below the lowest tier', () => {
    const floorModel: ModelSpec[] = [
      { id: 'tiny', provider: 'x', maxEffort: 'trivial', costPer1MInput: 0.01, costPer1MOutput: 0.02, quality: 0.3 },
    ];
    const r = recalibrateMatrix(floorModel, rep(9, { modelId: 'tiny', tier: 'trivial', quality: 0 }));
    expect(r.matrix[0].maxEffort).toBe('trivial');
    expect(r.calibrations[0].notes.join(' ')).toMatch(/lowest tier/);
  });

  it('rejects an empty matrix', () => {
    expect(() => recalibrateMatrix([], [])).toThrow(/matrix is empty/);
  });
});
