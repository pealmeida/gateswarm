import { describe, it, expect } from 'vitest';
import { loadEffort } from '../eval/lib/dataset.js';
import { samplePerTier } from '../eval/lib/hybrid-sample.js';

describe('samplePerTier', () => {
  it('returns exactly 5 prompts per tier with seed 42, deterministic', () => {
    const all = loadEffort();
    const a = samplePerTier(all, 5, 42);
    const b = samplePerTier(all, 5, 42);
    expect(a).toHaveLength(30);
    expect(b.map((x) => x.id)).toEqual(a.map((x) => x.id));
    const tiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    for (const t of tiers) {
      expect(a.filter((x) => x.tier === t)).toHaveLength(5);
    }
  });
});
