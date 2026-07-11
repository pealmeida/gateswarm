import { describe, expect, it } from 'vitest';
import { loadEffort } from '../eval/lib/dataset.js';
import {
  createWarmSeedPlan,
  selectWarmAblationExamples,
} from '../eval/lib/hybrid-warm-fixtures.js';

describe('hybrid warm fixtures', () => {
  it('builds a deterministic seed plan', () => {
    const scored = selectWarmAblationExamples(loadEffort());
    const a = createWarmSeedPlan(scored);
    const b = createWarmSeedPlan(scored);

    expect(a).toEqual(b);
    expect(a.ragEntries.length).toBeGreaterThan(0);
    expect(a.feedbackEntries.length).toBeGreaterThan(0);
    expect(a.historyEntries.length).toBeGreaterThan(0);
  });

  it('does not seed from prompt ids being scored', () => {
    const scored = selectWarmAblationExamples(loadEffort());
    const plan = createWarmSeedPlan(scored);
    const scoredIds = new Set(scored.map((ex) => ex.id));

    for (const id of plan.seedIds) {
      expect(scoredIds.has(id)).toBe(false);
    }
    for (const entry of plan.ragEntries) {
      const sourceId = entry.id.replace(/^warm-rag-/, '').replace(/-/g, ':');
      expect(scoredIds.has(sourceId)).toBe(false);
    }
    expect(new Set(plan.seedIds).size).toBe(plan.seedIds.length);
  });
});
