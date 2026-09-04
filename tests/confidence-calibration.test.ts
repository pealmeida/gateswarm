import { describe, expect, it, afterEach } from 'vitest';
import {
  DEFAULT_TIER_RELIABILITY,
  confidenceForTier,
  fitTierReliability,
  getTierReliability,
  resetTierReliability,
  setTierReliability,
} from 'gateswarm-lite';
import type { EffortLevel } from 'gateswarm-lite';

const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

afterEach(() => resetTierReliability());

describe('calibrated tier confidence', () => {
  it('ships a probability for every tier', () => {
    for (const tier of TIERS) {
      const p = DEFAULT_TIER_RELIABILITY[tier];
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('is lowest on the tiers the scorer actually confuses', () => {
    // heavy/intensive are the measured weak band; trivial/light are reliable.
    expect(DEFAULT_TIER_RELIABILITY.intensive).toBeLessThan(DEFAULT_TIER_RELIABILITY.trivial);
    expect(DEFAULT_TIER_RELIABILITY.heavy).toBeLessThan(DEFAULT_TIER_RELIABILITY.light);
  });

  it('never claims the near-certainty the old margin formula asserted', () => {
    // The replaced formula returned 0.95 at wide margins where measured
    // accuracy was 42%. Nothing calibrated should reach that.
    for (const tier of TIERS) expect(confidenceForTier(tier)).toBeLessThan(0.95);
  });

  it('setTierReliability installs a refit table and rejects invalid probabilities', () => {
    setTierReliability({ heavy: 0.42 });
    expect(getTierReliability().heavy).toBeCloseTo(0.42, 6);
    expect(confidenceForTier('heavy')).toBeCloseTo(0.42, 6);
    // untouched tiers keep their value
    expect(getTierReliability().trivial).toBeCloseTo(DEFAULT_TIER_RELIABILITY.trivial, 6);

    for (const bad of [0, -0.1, 1.5, Number.NaN]) {
      expect(() => setTierReliability({ heavy: bad })).toThrow(/invalid reliability/);
    }
  });

  it('fits toward observed accuracy while shrinking thin evidence toward the prior', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      tier: 'heavy' as EffortLevel,
      correct: i < 20, // 10% observed
    }));
    const fitted = fitTierReliability(many);
    expect(fitted.heavy).toBeGreaterThan(0.05);
    expect(fitted.heavy).toBeLessThan(0.20);

    // Two observations must not overturn the prior.
    const thin = fitTierReliability(
      [{ tier: 'heavy', correct: false }, { tier: 'heavy', correct: false }],
      { prior: 0.6, pseudoCounts: 8 },
    );
    expect(thin.heavy).toBeGreaterThan(0.4);
  });

  it('never returns 0 or 1 — no finite sample justifies certainty', () => {
    const allRight = fitTierReliability(
      Array.from({ length: 50 }, () => ({ tier: 'trivial' as EffortLevel, correct: true })),
    );
    const allWrong = fitTierReliability(
      Array.from({ length: 50 }, () => ({ tier: 'extreme' as EffortLevel, correct: false })),
    );
    expect(allRight.trivial).toBeLessThanOrEqual(0.99);
    expect(allWrong.extreme).toBeGreaterThanOrEqual(0.01);
  });

  it('falls back to the defaults when given nothing to fit', () => {
    expect(fitTierReliability([])).toEqual(DEFAULT_TIER_RELIABILITY);
  });
});
