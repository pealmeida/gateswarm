import { describe, expect, it } from 'vitest';
import {
  extractFeatures,
  heuristicScoreFromFeatures,
  type FeatureVector,
} from '../src/feature-extractor-v04.js';

function blankFeatureVector(): FeatureVector {
  return extractFeatures('');
}

describe('feature-extractor v04 Phase 2 signals', () => {
  it('counts requirements from musts, shoulds, bullets, and numbered items', () => {
    const f = extractFeatures(`
Build the import tool.
- must dedupe users
- should retry failures
1. validate the CSV
2. emit a summary report
`);

    expect(f.requirement_count).toBeGreaterThanOrEqual(6);
  });

  it('counts distinct imperative verbs anywhere in the prompt', () => {
    const f = extractFeatures(
      'Before we ship, compare the options, build the parser, test edge cases, and deploy staging.',
    );

    expect(f.has_imperative).toBe(0);
    expect(f.distinct_imperative_verbs).toBeGreaterThanOrEqual(4);
  });

  it('counts distinct question clauses', () => {
    const f = extractFeatures(
      'Why did latency jump? Which service changed? How should we verify the fix?',
    );

    expect(f.has_question).toBe(1);
    expect(f.question_count).toBe(3);
  });

  it('counts conjunction and enumeration density', () => {
    const f = extractFeatures(
      'Design retries, deduplication, rollback, and metrics, plus alerts as well as a runbook.',
    );

    expect(f.conjunction_enumeration).toBeGreaterThanOrEqual(5);
  });

  it('detects scale and quantity mentions from dataset-style intensive/extreme prompts', () => {
    const f = extractFeatures(
      'Process 2M events/sec with sub-100ms p99 decisions across five regions and 40-billion-row history.',
    );

    expect(f.scale_quantity_mentions).toBeGreaterThanOrEqual(5);
  });

  it('does not treat simple unit-conversion phrasing as a scale marker', () => {
    const f = extractFeatures('Turn 2.5 kilometers into miles for me.');

    expect(f.scale_quantity_mentions).toBe(0);
  });

  it('detects diagnostic and causal markers', () => {
    const f = extractFeatures(
      "Checkout latency spiked from 200ms to 1.4s after the last deploy, and I'm not sure if it is cache or the pool. Figure out why.",
    );

    expect(f.diagnostic_causal_markers).toBeGreaterThanOrEqual(3);
  });

  it('keeps the ten low-MI compatibility fields zero-weighted in the scorer', () => {
    const base = blankFeatureVector();
    const boostedDeadFields: FeatureVector = {
      ...base,
      code_block_size: 80,
      domain_legal: 1,
      domain_medical: 1,
      domain_engineering: 1,
      prior_context_needed: 1,
      multi_domain: 1,
      entity_count: 12,
      temporal_references: 4,
      output_format_spec: 1,
      user_expertise_level: 2,
    };

    expect(heuristicScoreFromFeatures(boostedDeadFields, 20))
      .toBe(heuristicScoreFromFeatures(base, 20));
  });
});
