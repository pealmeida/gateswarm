import { describe, expect, it } from 'vitest';
import { scoreComplexity } from 'gateswarm-lite';
import { scoreIntentSync } from '../src/intent-engine-v04.js';

const FIXTURES = [
  'hi',
  'What is the capital of France?',
  'Rewrite this sentence to be more formal: we gotta ship it asap',
  'Summarize the differences between TCP and UDP in one paragraph.',
  'Write a Python function that parses a CSV file and returns the top 5 rows sorted by revenue, with unit tests.',
  'Design a microservices architecture for a real-time trading platform, including failure modes, data consistency strategy, and a migration plan from the current monolith.',
  'Explain async/await',
  '',
];

describe('gateswarm-lite parity with gateway scorer', () => {
  it.each(FIXTURES)('score and tier match scoreIntentSync for: %s', (prompt) => {
    const lite = scoreComplexity(prompt);
    const gateway = scoreIntentSync(prompt);
    expect(lite.score).toBe(gateway.value);
    expect(lite.tier).toBe(gateway.tier);
  });

  it('returns well-formed results', () => {
    const r = scoreComplexity('Explain quicksort');
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme']).toContain(r.tier);
    expect(r.wordCount).toBeGreaterThan(0);
    expect(r.features).toBeTypeOf('object');
  });

  it('truncates prompts above 64 KiB instead of failing', () => {
    const huge = 'analyze this system '.repeat(5000); // ~100 KB
    const r = scoreComplexity(huge);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});
