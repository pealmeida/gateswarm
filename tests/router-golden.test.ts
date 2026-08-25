import { describe, expect, it } from 'vitest';
import { scoreComplexity } from 'gateswarm-lite';
import type { EffortLevel } from 'gateswarm-lite';
import type { ModelSpec } from 'gateswarm-router';
import { route, selectModel, valueScore } from 'gateswarm-router';

const GOLDEN_MATRIX: ModelSpec[] = [
  { id: 'nano',  provider: 'x', maxEffort: 'light',    costPer1MInput: 0.10, costPer1MOutput: 0.40,  quality: 0.50 },
  { id: 'small', provider: 'x', maxEffort: 'moderate', costPer1MInput: 0.40, costPer1MOutput: 1.60,  quality: 0.70 },
  { id: 'mid',   provider: 'x', maxEffort: 'heavy',    costPer1MInput: 0.80, costPer1MOutput: 3.20,  quality: 0.80 },
  { id: 'big',   provider: 'x', maxEffort: 'extreme',  costPer1MInput: 5.00, costPer1MOutput: 20.00, quality: 0.95 },
];

const EXPECTED_CHEAPEST: Record<EffortLevel, string> = {
  trivial: 'nano',
  light: 'nano',
  moderate: 'small',
  heavy: 'mid',
  intensive: 'big',
  extreme: 'big',
};

describe('golden addressing table', () => {
  it.each(Object.entries(EXPECTED_CHEAPEST))(
    'cheapest-capable at %s picks %s',
    (tier, id) => {
      const { model } = selectModel(tier as EffortLevel, GOLDEN_MATRIX);
      expect(model.id).toBe(id);
    },
  );

  it('best-value at extreme still picks big (only capable)', () => {
    const { model } = selectModel('extreme', GOLDEN_MATRIX, { strategy: 'best-value' });
    expect(model.id).toBe('big');
  });

  it('best-value at trivial maximizes valueScore (derived from the fixture, not guessed)', () => {
    const expectedId = [...GOLDEN_MATRIX].sort((a, b) => valueScore(b) - valueScore(a))[0].id;
    const { model } = selectModel('trivial', GOLDEN_MATRIX, { strategy: 'best-value' });
    expect(model.id).toBe(expectedId);
    expect(model.id).toBe('nano');
  });

  it('route() selection matches selectModel(scoreComplexity(prompt).tier)', () => {
    const prompts = [
      'hi',
      'What is the capital of France?',
      'Rewrite this sentence to be more formal: we gotta ship it asap',
      'Summarize the differences between TCP and UDP in one paragraph.',
      'Write a Python function that parses a CSV file and returns the top 5 rows sorted by revenue, with unit tests.',
      'Design a microservices architecture for a real-time trading platform, including failure modes, data consistency strategy, and a migration plan from the current monolith.',
      'Explain async/await',
    ];
    for (const prompt of prompts) {
      const decision = route(prompt, { matrix: GOLDEN_MATRIX });
      const expected = selectModel(scoreComplexity(prompt).tier, GOLDEN_MATRIX);
      expect(decision.model.id).toBe(expected.model.id);
    }
  });
});
