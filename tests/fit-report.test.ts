import { describe, expect, it } from 'vitest';
import type { EffortLevel } from 'gateswarm-lite';
import type { ModelSpec } from 'gateswarm-router';
import {
  TIERS,
  boundarySwings,
  buildRows,
  labelingQueue,
  saturation,
  summarize,
} from '../scripts/lib/fit.js';

const MATRIX: ModelSpec[] = [
  { id: 'nano', provider: 'x', maxEffort: 'trivial', costPer1MInput: 0.5, costPer1MOutput: 0.5, quality: 0.4 },
  { id: 'cheap', provider: 'x', maxEffort: 'light', costPer1MInput: 1, costPer1MOutput: 1, quality: 0.6 },
  { id: 'mid', provider: 'x', maxEffort: 'heavy', costPer1MInput: 4, costPer1MOutput: 4, quality: 0.8 },
  { id: 'top', provider: 'x', maxEffort: 'extreme', costPer1MInput: 12, costPer1MOutput: 12, quality: 0.95 },
];

const BOUNDARIES = [0.2, 0.3, 0.4, 0.5, 0.6];

// Deterministic fake scorer: "p<score>" prompts score <score>.
const scoreOf = (prompt: string): { score: number; tier: EffortLevel } => {
  const s = Number(prompt.slice(1));
  let tier: EffortLevel = 'trivial';
  for (let j = 0; j < BOUNDARIES.length; j++) if (s >= BOUNDARIES[j]) tier = TIERS[j + 1];
  return { score: s, tier };
};

const CORPUS = [
  { id: 'a', prompt: 'p0.19' }, // trivial
  { id: 'b', prompt: 'p0.21' }, // light, just above b0 → raise swing
  { id: 'c', prompt: 'p0.29' }, // light, just below b1 → lower swing
  { id: 'd', prompt: 'p0.31' }, // moderate, just above b1 → raise swing
  { id: 'e', prompt: 'p0.55' }, // intensive, far from every boundary
  { id: 'f', prompt: 'p0.59' }, // intensive, just below b4 → lower swing
  { id: 'g', prompt: 'p0.61' }, // extreme, just above b4 → raise swing
];

describe('fit math', () => {
  const rows = buildRows(CORPUS, MATRIX, scoreOf);

  it('buildRows routes each entry at its scored tier with blended cost', () => {
    expect(rows.find((r) => r.id === 'a')).toMatchObject({ tier: 'trivial', modelId: 'nano', cost: 0.5 });
    expect(rows.find((r) => r.id === 'd')).toMatchObject({ tier: 'moderate', modelId: 'mid', cost: 4 });
    // heavy-capped 'mid' cannot serve intensive — those escalate to 'top'.
    expect(rows.find((r) => r.id === 'e')).toMatchObject({ tier: 'intensive', modelId: 'top', cost: 12 });
    expect(rows.find((r) => r.id === 'g')).toMatchObject({ tier: 'extreme', modelId: 'top', cost: 12 });
  });

  it('summarize aggregates tiers and model cost shares', () => {
    const s = summarize(rows);
    expect(s.count).toBe(7);
    expect(s.totalCost).toBeCloseTo(0.5 + 1 + 1 + 4 + 12 + 12 + 12, 10);
    expect(s.perTier.extreme).toBe(1);
    expect(s.perModel.mid.costShare).toBeCloseTo(4, 10);
  });

  it('boundarySwings finds exactly the near-boundary prompts and prices both directions', () => {
    const swings = boundarySwings(rows, BOUNDARIES, MATRIX, 0.02);

    const b0 = swings[0];
    expect(b0.raise.items).toHaveLength(1);
    expect(b0.raise.items[0]).toMatchObject({ id: 'b', from: 'light', to: 'trivial', costDelta: -0.5 });
    // 'a' sits just below b0 too: lowering b0 would promote it.
    expect(b0.lower.items[0]).toMatchObject({ id: 'a', from: 'trivial', to: 'light', costDelta: 0.5 });

    const b1 = swings[1];
    expect(b1.lower.items[0]).toMatchObject({ id: 'c', to: 'moderate', costDelta: 3 });
    expect(b1.raise.items[0]).toMatchObject({ id: 'd', to: 'light', costDelta: -3 });

    // With this matrix, intensive and extreme both route to 'top': moving b4 is free.
    const b4 = swings[4];
    expect(b4.lower.items[0]).toMatchObject({ id: 'f', to: 'extreme', costDelta: 0 });
    expect(b4.raise.items[0]).toMatchObject({ id: 'g', to: 'intensive', costDelta: 0 });

    // Far-from-boundary traffic never appears.
    const ids = swings.flatMap((s) => [...s.raise.items, ...s.lower.items].map((i) => i.id));
    expect(ids).not.toContain('e');
  });

  it('labelingQueue ranks by |cost delta| and keeps entries unique', () => {
    const queue = labelingQueue(boundarySwings(rows, BOUNDARIES, MATRIX, 0.02), 10);
    expect(queue.map((q) => q.id)).toEqual(['d', 'c', 'b', 'a', 'g', 'f']);
    expect(new Set(queue.map((q) => q.id)).size).toBe(queue.length);
  });

  it('saturation reports unresolved mass above the top boundary', () => {
    const s = saturation(rows, BOUNDARIES);
    expect(s.shareAboveTop).toBeCloseTo(1 / 7, 10);
    expect(s.medianDistanceToTop).toBe(0); // most traffic sits below the top cut
  });
});
