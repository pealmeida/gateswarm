import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('truncates prompts above 64 KiB instead of failing', { timeout: 30_000 }, () => {
    const huge = 'analyze this system '.repeat(5000); // ~100 KB
    const r = scoreComplexity(huge);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});

describe('frozen score snapshot (tests/fixtures/lite-score-snapshot.json)', () => {
  // Regenerate ONLY when feature-extractor.ts or DEFAULT_BOUNDARIES change on
  // purpose, and say so in the PR (testing spec Section 3). The file is written
  // by scoring the same FIXTURES list through scoreComplexity().
  const snapshot = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'lite-score-snapshot.json'), 'utf-8'),
  ) as Record<string, { score: number; tier: string }>;

  it('snapshot covers exactly g1-g9', () => {
    expect(Object.keys(snapshot).sort()).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9']);
  });

  it.each([
    ['g1', 0], ['g2', 1], ['g3', 2], ['g4', 3], ['g5', 4], ['g6', 5], ['g7', 6],
  ])('snapshot %s matches live scorer exactly', (id, fixtureIndex) => {
    const live = scoreComplexity(FIXTURES[fixtureIndex]);
    const frozen = snapshot[id];
    expect(Math.abs(live.score - frozen.score)).toBeLessThanOrEqual(1e-12);
    expect(live.tier).toBe(frozen.tier);
  });

  it('snapshot g8 (empty) and g9 (truncate) stay pinned', () => {
    expect(scoreComplexity('').score).toBe(snapshot.g8.score);
    const huge = 'analyze this system '.repeat(5000);
    const live = scoreComplexity(huge);
    expect(Math.abs(live.score - snapshot.g9.score)).toBeLessThanOrEqual(1e-12);
    expect(live.tier).toBe(snapshot.g9.tier);
  });
});
