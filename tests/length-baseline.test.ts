import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LengthBaselineClassifier, lengthScore } from '../src/classifiers/length-baseline.js';
import { HeuristicLinearClassifier } from '../src/classifiers/heuristic-linear.js';
import type { EffortLevel } from '../src/types.js';
import type { LabeledPrompt, TierClassifier } from '../src/classifiers/types.js';

const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(readFileSync(join(ROOT, 'eval', 'dataset.json'), 'utf-8')) as {
  effort: { tier: EffortLevel; prompts: string[] }[];
};
const examples: LabeledPrompt[] = golden.effort.flatMap((g, gi) =>
  g.prompts.map((prompt, i) => ({ id: `e${gi}:${i}`, prompt, tier: g.tier })),
);

describe('length-only baseline', () => {
  it('scores inside [0,1] and is monotone in prompt length', () => {
    const grow = ['a', 'a'.repeat(20), 'a'.repeat(200), 'a'.repeat(5000)];
    const scores = grow.map(lengthScore);
    for (const s of scores) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(1); }
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
  });

  it('never assigns a shorter prompt a higher tier than a longer one', () => {
    const m = new LengthBaselineClassifier();
    m.fit(examples);
    const sorted = [...examples].sort((a, b) => a.prompt.length - b.prompt.length);
    let previous = -1;
    for (const e of sorted) {
      const idx = TIERS.indexOf(m.predictEffort(e.prompt).tier);
      expect(idx).toBeGreaterThanOrEqual(previous);
      previous = idx;
    }
  });

  it('produces well-formed predictions with calibrated confidence', () => {
    const m = new LengthBaselineClassifier();
    m.fit(examples);
    const p = m.predictEffort('Design a distributed cache with failover.');
    expect(TIERS).toContain(p.tier);
    expect(p.confidence).toBeGreaterThan(0);
    expect(p.confidence).toBeLessThan(1);
    expect(p.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('declares no mode prediction rather than faking one', () => {
    // Length cannot separate planning from acting; a number here would be noise.
    const asContract: TierClassifier = new LengthBaselineClassifier();
    expect(asContract.predictMode).toBeUndefined();
  });

  it('fits cut points from training data, like the models it guards', () => {
    const m = new LengthBaselineClassifier();
    const trivialOnly = examples.filter((e) => e.tier === 'trivial');
    m.fit(trivialOnly);
    // Fitted on one tier, it must still return a valid tier rather than throw.
    expect(TIERS).toContain(m.predictEffort('hello').tier);
    expect(m.requiresTraining).toBe(true);
  });
});

describe('the guard, as a live assertion', () => {
  const exact = (m: { fit?: (t: LabeledPrompt[]) => void; predictEffort: (p: string) => { tier: EffortLevel } }) => {
    // 5-fold, fit on train folds only — the same protocol the leaderboard uses.
    const folds: LabeledPrompt[][] = Array.from({ length: 5 }, () => []);
    examples.forEach((e, i) => folds[i % 5].push(e));
    let hits = 0;
    for (let k = 0; k < 5; k++) {
      const train = folds.filter((_, i) => i !== k).flat();
      m.fit?.(train);
      for (const e of folds[k]) if (m.predictEffort(e.prompt).tier === e.tier) hits++;
    }
    return hits / examples.length;
  };

  it('records that eval/dataset.json is separable by length alone', () => {
    // NOT a target — a warning. This dataset was written with longer prompts for
    // harder tiers (only 1 of 15 tier pairs has overlapping interquartile
    // character ranges), so ranking by length scores far above chance and every
    // accuracy figure measured on it inherits that.
    //
    // If this assertion FAILS because the number dropped, that is good news: the
    // dataset has been given length-decorrelated examples. Update the bound and
    // re-check the models against the new benchmark.
    const baseline = exact(new LengthBaselineClassifier());
    expect(baseline).toBeGreaterThan(0.80);
  });

  it('records that the shipped scorer does not yet clear the baseline', () => {
    // Also not a target. When this fails because the scorer overtook length,
    // the guard has done its job — delete this test and keep the leaderboard row.
    const baseline = exact(new LengthBaselineClassifier());
    const scorer = exact(new HeuristicLinearClassifier());
    expect(scorer).toBeLessThan(baseline);
  });
});
