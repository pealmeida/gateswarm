import { describe, expect, it } from 'vitest';
import type { ModelSpec } from 'gateswarm-router';
import { blendedCost, DEFAULT_MATRIX, EFFORT_RANK, selectModel, valueScore } from 'gateswarm-router';

const M = (over: Partial<ModelSpec>): ModelSpec => ({
  id: 'm',
  provider: 'p',
  maxEffort: 'moderate',
  costPer1MInput: 1,
  costPer1MOutput: 4,
  quality: 0.7,
  ...over,
});

const FIXTURE: ModelSpec[] = [
  M({ id: 'cheap-weak', maxEffort: 'light', costPer1MInput: 0.1, costPer1MOutput: 0.4, quality: 0.5 }),
  M({ id: 'mid', maxEffort: 'heavy', costPer1MInput: 0.5, costPer1MOutput: 2.0, quality: 0.75 }),
  M({ id: 'strong', maxEffort: 'extreme', costPer1MInput: 3.0, costPer1MOutput: 15.0, quality: 0.92 }),
  M({ id: 'premium', maxEffort: 'extreme', costPer1MInput: 15.0, costPer1MOutput: 75.0, quality: 0.97 }),
];

describe('selectModel', () => {
  it('throws on an empty matrix', () => {
    expect(() => selectModel('trivial', [])).toThrow('matrix is empty');
  });

  it('cheapest-capable picks the cheapest model rated for the tier', () => {
    const { model } = selectModel('light', FIXTURE);
    expect(model.id).toBe('cheap-weak');
  });

  it('excludes models below the required tier', () => {
    const { model } = selectModel('heavy', FIXTURE);
    expect(model.id).toBe('mid'); // cheap-weak is capped at light
  });

  it('breaks cost ties by higher quality', () => {
    const tied: ModelSpec[] = [
      M({ id: 'a', quality: 0.6 }),
      M({ id: 'b', quality: 0.9 }),
    ];
    const { model } = selectModel('moderate', tied);
    expect(model.id).toBe('b');
  });

  it('best-value maximizes quality per blended cost dollar', () => {
    const { model } = selectModel('extreme', FIXTURE, { strategy: 'best-value' });
    // strong: 0.92 / (1 + 12) ≈ 0.0708 · premium: 0.97 / (1 + 60) ≈ 0.0159
    expect(model.id).toBe('strong');
  });

  it('respects minQuality', () => {
    const { model } = selectModel('light', FIXTURE, { minQuality: 0.7 });
    expect(model.id).toBe('mid');
  });

  it('falls back to the most capable model when nothing is rated for the tier', () => {
    const weak: ModelSpec[] = [
      M({ id: 'only-light', maxEffort: 'light', quality: 0.5 }),
      M({ id: 'only-heavy', maxEffort: 'heavy', quality: 0.8 }),
    ];
    const { model, reason } = selectModel('extreme', weak);
    expect(model.id).toBe('only-heavy');
    expect(reason).toContain('falling back');
  });

  it('returns up to 3 ranked alternatives', () => {
    const { alternatives } = selectModel('trivial', FIXTURE);
    expect(alternatives.length).toBeLessThanOrEqual(3);
    expect(alternatives.map((m) => m.id)).not.toContain(selectModel('trivial', FIXTURE).model.id);
  });
});

describe('cost helpers', () => {
  it('blendedCost is output-weighted 25/75', () => {
    expect(blendedCost(M({ costPer1MInput: 4, costPer1MOutput: 8 }))).toBe(4 * 0.25 + 8 * 0.75);
  });

  it('valueScore is quality / (1 + blendedCost)', () => {
    const m = M({ costPer1MInput: 4, costPer1MOutput: 8, quality: 0.8 });
    expect(valueScore(m)).toBeCloseTo(0.8 / (1 + 7), 10);
  });
});

describe('DEFAULT_MATRIX', () => {
  it('entries are well-formed', () => {
    for (const m of DEFAULT_MATRIX) {
      expect(m.id.length).toBeGreaterThan(0);
      expect(EFFORT_RANK[m.maxEffort]).toBeGreaterThanOrEqual(0);
      expect(m.costPer1MInput).toBeGreaterThan(0);
      expect(m.costPer1MOutput).toBeGreaterThan(0);
      expect(m.quality).toBeGreaterThan(0);
      expect(m.quality).toBeLessThanOrEqual(1);
    }
  });

  it('has at least one capable model for every tier', () => {
    const tiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;
    for (const tier of tiers) {
      const { reason } = selectModel(tier, DEFAULT_MATRIX);
      expect(reason).not.toContain('falling back');
    }
  });
});
