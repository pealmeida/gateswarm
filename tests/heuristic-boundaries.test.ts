import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '../src/types.js';
import {
  fitMonotonicCutPoints,
  scoreToTier,
  type ScoredTier,
} from '../src/classifiers/heuristic-linear.js';

function expectStrictlyIncreasing(boundaries: number[]): void {
  expect(boundaries).toHaveLength(5);
  for (let i = 0; i < boundaries.length; i++) {
    expect(boundaries[i]).toBeGreaterThan(0);
    expect(boundaries[i]).toBeLessThan(1);
    if (i > 0) expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1]);
  }
}

function exact(rows: ScoredTier[], boundaries: number[]): number {
  return rows.filter((r) => scoreToTier(r.score, boundaries) === r.tier).length;
}

describe('fitMonotonicCutPoints', () => {
  it('finds separating cuts for ordered synthetic tiers', () => {
    const rows: ScoredTier[] = [
      { score: 0.10, tier: 'trivial' },
      { score: 0.12, tier: 'trivial' },
      { score: 0.20, tier: 'light' },
      { score: 0.22, tier: 'light' },
      { score: 0.34, tier: 'moderate' },
      { score: 0.36, tier: 'moderate' },
      { score: 0.48, tier: 'heavy' },
      { score: 0.50, tier: 'heavy' },
      { score: 0.64, tier: 'intensive' },
      { score: 0.66, tier: 'intensive' },
      { score: 0.84, tier: 'extreme' },
      { score: 0.86, tier: 'extreme' },
    ];

    const boundaries = fitMonotonicCutPoints(rows);

    expectStrictlyIncreasing(boundaries);
    expect(boundaries[0]).toBeGreaterThan(0.12);
    expect(boundaries[0]).toBeLessThan(0.20);
    expect(boundaries[1]).toBeGreaterThan(0.22);
    expect(boundaries[1]).toBeLessThan(0.34);
    expect(boundaries[2]).toBeGreaterThan(0.36);
    expect(boundaries[2]).toBeLessThan(0.48);
    expect(boundaries[3]).toBeGreaterThan(0.50);
    expect(boundaries[3]).toBeLessThan(0.64);
    expect(boundaries[4]).toBeGreaterThan(0.66);
    expect(boundaries[4]).toBeLessThan(0.84);
    expect(exact(rows, boundaries)).toBe(rows.length);
  });

  it('keeps cut points monotonic when an intermediate tier is empty', () => {
    const rows: ScoredTier[] = [
      { score: 0.10, tier: 'trivial' },
      { score: 0.18, tier: 'light' },
      { score: 0.31, tier: 'moderate' },
      { score: 0.45, tier: 'heavy' },
      { score: 0.88, tier: 'extreme' },
    ];

    const boundaries = fitMonotonicCutPoints(rows);

    expectStrictlyIncreasing(boundaries);
    expect(exact(rows, boundaries)).toBe(rows.length);
  });

  it('does not invent impossible separation for tied scores', () => {
    const rows: ScoredTier[] = [
      { score: 0.10, tier: 'trivial' },
      { score: 0.20, tier: 'light' },
      { score: 0.30, tier: 'moderate' },
      { score: 0.40, tier: 'heavy' },
      { score: 0.40, tier: 'intensive' },
      { score: 0.80, tier: 'extreme' },
    ];

    const boundaries = fitMonotonicCutPoints(rows);

    expectStrictlyIncreasing(boundaries);
    expect(scoreToTier(0.40, boundaries)).toBe(scoreToTier(0.40, boundaries));
    expect(exact(rows, boundaries)).toBe(5);
  });
});
