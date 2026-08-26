import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MATRIX, EFFORT_RANK, route } from 'gateswarm-router';
import { MAX_PROMPT_SIZE, scoreComplexity } from 'gateswarm-lite';
import { scoreIntentSync } from '../src/intent-engine-v04.js';

/**
 * MLJAR corpus simulation (https://mljar.com/ai-prompts/ — 678 real-world,
 * role-organized prompts for data/ML/engineering work). This suite runs the
 * FULL external corpus through scorer + router and locks the contract:
 *
 *  - fixture integrity
 *  - well-formed results for every prompt
 *  - exact parity with the gateway scorer for every prompt
 *  - router capability invariant for every prompt
 *  - frozen score snapshot drift lock (<=1e-12, tier stable)
 *
 * Absolute tiers are calibration output, not a correctness target here
 * (testing spec Section 1): regenerate snapshots ONLY when the extractor or
 * DEFAULT_BOUNDARIES change on purpose:
 *   npm run simulate:prompts -- --write-snapshot
 */

interface CorpusPrompt {
  id: string;
  title: string;
  role_slug: string;
  level: string;
  prompt: string;
}

const corpus: { count: number; prompts: CorpusPrompt[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'mljar-prompts.json'), 'utf-8'),
);

const snapshot: { count: number; scores: Record<string, { score: number; tier: string }> } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'mljar-score-snapshot.json'), 'utf-8'),
);

const TIERS = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;

describe('mljar fixture integrity', () => {
  it('has a consistent, unique, non-empty prompt set', { timeout: 120_000 }, () => {
    expect(corpus.prompts.length).toBe(corpus.count);
    const ids = new Set(corpus.prompts.map((p) => p.id));
    expect(ids.size).toBe(corpus.count);
    for (const p of corpus.prompts) {
      expect(p.prompt.length).toBeGreaterThan(0);
      expect(p.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_SIZE);
      expect(TIERS).toContain(scoreComplexity(p.prompt).tier); // cheap tier validity probe
    }
  });

  it('snapshot covers exactly the corpus ids', () => {
    expect(snapshot.count).toBe(corpus.count);
    expect(Object.keys(snapshot.scores).sort()).toEqual(corpus.prompts.map((p) => p.id).sort());
  });
});

describe('scorer contract across the full mljar corpus', () => {
  it('every prompt scores deterministically with a well-formed result', { timeout: 120_000 }, () => {
    for (const { prompt } of corpus.prompts) {
      const r = scoreComplexity(prompt);
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(TIERS).toContain(r.tier);
      expect(Object.keys(r.features).length).toBe(35);
      const again = scoreComplexity(prompt);
      expect(again.score).toBe(r.score);
      expect(again.tier).toBe(r.tier);
    }
  });

  it('every prompt matches the gateway scorer exactly (parity)', { timeout: 120_000 }, () => {
    for (const { id, prompt } of corpus.prompts) {
      const lite = scoreComplexity(prompt);
      const gateway = scoreIntentSync(prompt);
      if (lite.score !== gateway.value || lite.tier !== gateway.tier) {
        throw new Error(`parity drift at ${id}: lite=${lite.score}/${lite.tier} gateway=${gateway.value}/${gateway.tier}`);
      }
    }
  });
});

describe('router contract across the full mljar corpus', () => {
  it('every decision is advisory-shaped and capability-safe on DEFAULT_MATRIX', { timeout: 120_000 }, () => {
    let fallbacks = 0;
    for (const { id, prompt } of corpus.prompts) {
      const d = route(prompt, { matrix: DEFAULT_MATRIX });
      expect(d.model.id).toBeTypeOf('string');
      expect(d.strategy).toBe('cheapest-capable');
      expect(d.alternatives.length).toBeLessThanOrEqual(3);
      expect(d.reason.length).toBeGreaterThan(0);
      const below = EFFORT_RANK[d.model.maxEffort] < EFFORT_RANK[d.complexity.tier];
      if (below) {
        expect(d.reason).toContain('falling back');
        fallbacks++;
      }
      void id;
    }
    // Observed at freeze time: DEFAULT_MATRIX covers every corpus tier.
    expect(fallbacks).toBe(0);
  });

  it('matches the frozen snapshot for every prompt (score <=1e-12 drift, tier stable)', { timeout: 120_000 }, () => {
    for (const { id, prompt } of corpus.prompts) {
      const frozen = snapshot.scores[id];
      const live = scoreComplexity(prompt);
      try {
        expect(Math.abs(live.score - frozen.score)).toBeLessThanOrEqual(1e-12);
        expect(live.tier).toBe(frozen.tier);
      } catch (err) {
        throw new Error(
          `snapshot drift at ${id} — regenerate ONLY with an intentional scorer change: ` +
            `npm run simulate:prompts -- --write-snapshot`,
          { cause: err },
        );
      }
    }
  });
});
