import { describe, expect, it } from 'vitest';
import type { ModelSpec } from 'gateswarm-router';
import { DEFAULT_MATRIX, route, selectModel } from 'gateswarm-router';
import { scoreComplexity } from 'gateswarm-lite';

describe('route', () => {
  it('combines complexity scoring with model selection', () => {
    const prompt = 'Design a distributed cache with consistency guarantees and failover, then write the migration plan.';
    const decision = route(prompt);
    const expectedComplexity = scoreComplexity(prompt);
    const expectedSelection = selectModel(expectedComplexity.tier, DEFAULT_MATRIX);

    expect(decision.complexity.score).toBe(expectedComplexity.score);
    expect(decision.complexity.tier).toBe(expectedComplexity.tier);
    expect(decision.model.id).toBe(expectedSelection.model.id);
    expect(decision.strategy).toBe('cheapest-capable');
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('passes strategy and custom matrix through', () => {
    const matrix: ModelSpec[] = [
      { id: 'only', provider: 'x', maxEffort: 'extreme', costPer1MInput: 1, costPer1MOutput: 2, quality: 0.9 },
    ];
    const decision = route('hi', { strategy: 'best-value', matrix });
    expect(decision.strategy).toBe('best-value');
    expect(decision.model.id).toBe('only');
  });
});
