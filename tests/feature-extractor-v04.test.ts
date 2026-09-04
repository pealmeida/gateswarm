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

describe('structure_density — prose must not read as specification', () => {
  it('ignores discourse markers that open a line with a colon', () => {
    // Regression: "However:/Note:/Therefore:/TODO:" scored the same structure as
    // four real input fields, so ordinary prose was rated EASIER than it is.
    const prose = 'However: this is prose.\nNote: another line.\nTherefore: we ship.\nTODO: fix later.';
    expect(extractFeatures(prose).structure_density).toBe(0);
  });

  it('treats a single labelled line as punctuation, not structure', () => {
    const aside = 'Refactor the auth module.\nNote: the tests are flaky.';
    expect(extractFeatures(aside).structure_density).toBe(0);
    const oneField = 'Refactor the auth module.\nSources: the monolith.';
    expect(extractFeatures(oneField).structure_density).toBe(0);
  });

  it('still scores a genuinely specified prompt', () => {
    const structured = [
      'Design a dbt project.',
      'Data sources: Postgres, Stripe',
      'Warehouse: Snowflake',
      'Target audience: analysts',
      'Constraints: no dbt Cloud',
    ].join('\n');
    expect(extractFeatures(structured).structure_density).toBeGreaterThan(10);
  });

  it('drops discourse markers while keeping real fields in the same prompt', () => {
    const mixed = 'Build an ETL job.\nNote: legacy schema.\nSources: S3, Kafka\nSink: Snowflake';
    const withoutAside = 'Build an ETL job.\nSources: S3, Kafka\nSink: Snowflake';
    expect(extractFeatures(mixed).structure_density).toBeCloseTo(
      extractFeatures(withoutAside).structure_density * (withoutAside.split(/\s+/).filter(Boolean).length / mixed.split(/\s+/).filter(Boolean).length),
      5,
    );
  });

  it('leaves bullets alone — a list is unambiguous structure', () => {
    expect(extractFeatures('Build an API.\n- auth\n- rate limits\n- pagination').structure_density).toBeGreaterThan(20);
  });

  it('scores an unstructured hard prompt at zero structure', () => {
    expect(extractFeatures('Design a distributed cache with failover and justify the consistency model you choose.').structure_density).toBe(0);
  });
});

describe('scoring stays linear in prompt length', () => {
  // Regression: question_count used `/[^?]+\?/g`, which backtracks
  // catastrophically on text containing no "?" — `[^?]+` consumes to the end at
  // every start position, then fails. At the 64 KiB prompt cap that one regex
  // took 3.4 SECONDS, on every score, for any prompt without a question mark.
  //
  // Measured in CPU time, not wall clock. The first version of this guard used
  // performance.now() and failed on CI at 3243ms while taking 35ms locally: the
  // runner has two shared cores and vitest runs files in parallel, so wall clock
  // here measures contention from other workers, not this code. process.cpuUsage
  // counts only this worker's own CPU and is unaffected by that.
  const noQuestionMark = 'analyze this system '.repeat(5000).slice(0, 65536);

  /** Milliseconds of CPU actually burned by one extractFeatures call. */
  const cpuMsFor = (text: string): number => {
    extractFeatures(text); // warm: let the JIT settle before measuring
    const before = process.cpuUsage();
    extractFeatures(text);
    const after = process.cpuUsage(before);
    return (after.user + after.system) / 1000;
  };

  it('spends well under a second of CPU on a 64 KiB question-free prompt', () => {
    // Post-fix this is ~96ms of CPU here; pre-fix it was ~3400ms. A 1000ms
    // bound sits an order of magnitude below the regression and well above any
    // plausible slow runner, so it separates the two without being brittle.
    expect(cpuMsFor(noQuestionMark)).toBeLessThan(1000);
  });

  it('stays bounded at every size, so quadratic growth cannot hide', () => {
    // This deliberately replaces a ratio assertion (large/small < 25). The ratio
    // form measured 13x locally and 40x on CI: at these durations the small
    // baseline is a few milliseconds, so GC and JIT noise dominate it and the
    // quotient swings far more than the underlying behaviour does. A ratio that
    // unreliable cannot distinguish a real regression from a noisy runner.
    //
    // Absolute bounds carry the same information stably. Under the quadratic
    // version these were roughly 57ms / 214 / 907 / 3400 — every one of the
    // larger bounds would fail — while the fixed scorer measures about
    // 3 / 5 / 12 / 18 / 73ms of CPU here.
    for (const [chars, budgetMs] of [[8000, 150], [16000, 250], [32000, 500], [64000, 1000]] as [number, number][]) {
      expect(cpuMsFor(noQuestionMark.slice(0, chars)), `${chars} chars`).toBeLessThan(budgetMs);
    }
  });

  it('counts questions the way the replaced regex did', () => {
    for (const [text, expected] of [['', 0], ['?', 0], ['??', 0], ['a?', 1], ['a??b?', 2], ['???a', 0]] as [string, number][]) {
      expect(extractFeatures(text).question_count, JSON.stringify(text)).toBe(expected);
    }
  });
});
