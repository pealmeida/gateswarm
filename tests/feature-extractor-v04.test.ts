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

  it('uses Unicode-aware segmentation for Chinese, emoji-only, and minified code prompts', () => {
    const chinese = extractFeatures('请帮我设计一个可扩展的分布式订单系统，需要处理高并发请求，并且说明如何保证数据一致性、故障恢复和监控告警。');
    const emoji = extractFeatures('😀 🚀 🔧 🧠 ✨');
    const minifiedPrompt = Array(40)
      .fill('const value=Array.from({length:200},(_,i)=>i).map(i=>i*2).filter(i=>i%3===0).join(\',\');')
      .join('');
    const minified = extractFeatures(minifiedPrompt);

    expect(chinese.sentence_count).toBeGreaterThan(0);
    expect(chinese.avg_word_length).toBeGreaterThan(0);
    expect(emoji.avg_word_length).toBeGreaterThan(0);
    expect(minified.avg_word_length).toBeGreaterThan(0);
    expect(minified.has_code).toBe(1);
    expect(minifiedPrompt.length).toBeGreaterThanOrEqual(2000);
  });

  it('deduplicates overlapping scale, list, and keyword evidence', () => {
    const scale = extractFeatures('Handle 100 qps without dropping requests.');
    const list = extractFeatures('1. validate input\n2. emit output');
    const consensus = extractFeatures('consensus');

    expect(scale.scale_quantity_mentions).toBe(1);
    expect(list.requirement_count).toBe(2);
    expect(list.conjunction_enumeration).toBe(2);
    expect(heuristicScoreFromFeatures(consensus, 1)).toBeLessThan(0.264209);
  });

  it('keeps short explain-compound prompts in the light tier', () => {
    const prompt = 'Explain async/await';
    const score = heuristicScoreFromFeatures(extractFeatures(prompt), 2);
    expect(score).toBeGreaterThanOrEqual(0.208938);
    expect(score).toBeLessThan(0.264209);
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
