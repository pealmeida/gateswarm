import { describe, expect, it, beforeEach } from 'vitest';
import { join } from 'path';
import type { FeatureVector } from '../src/feature-extractor-v04.js';
import type { EffortLevel } from '../src/types.js';
import {
  ORDINAL_FEATURE_NAMES,
  OrdinalLogisticClassifier,
  ordinalProbabilities,
  setDefaultOrdinalClassifierForTests,
  type OrdinalModelState,
} from '../src/classifiers/ordinal-logistic.js';
import { ensembleVote, loadCascadeWeights } from '../src/ensemble-voter.js';
import { scoreToEffort } from '../src/intent-engine.js';

const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

function zeroFeatures(): FeatureVector {
  return {
    has_question: 0,
    has_code: 0,
    has_imperative: 0,
    has_arithmetic: 0,
    has_sequential: 0,
    has_constraint: 0,
    has_context: 0,
    has_architecture: 0,
    has_design: 0,
    sentence_count: 0,
    avg_word_length: 0,
    question_technical: 0,
    technical_design: 0,
    technical_terms: 0,
    multi_step: 0,
    has_negation: 0,
    entity_count: 0,
    code_block_size: 0,
    domain_finance: 0,
    domain_legal: 0,
    domain_medical: 0,
    domain_engineering: 0,
    temporal_references: 0,
    output_format_spec: 0,
    prior_context_needed: 0,
    novelty_score: 0,
    multi_domain: 0,
    user_expertise_level: 0,
    compound_tech: 0,
    requirement_count: 0,
    distinct_imperative_verbs: 0,
    question_count: 0,
    conjunction_enumeration: 0,
    scale_quantity_mentions: 0,
    diagnostic_causal_markers: 0,
  };
}

function syntheticRows() {
  const rows = [];
  for (let tier = 0; tier < TIERS.length; tier++) {
    for (let i = 0; i < 8; i++) {
      const f = zeroFeatures();
      f.sentence_count = 1 + tier;
      f.technical_terms = tier;
      f.requirement_count = tier;
      f.scale_quantity_mentions = tier >= 3 ? tier - 2 : 0;
      f.diagnostic_causal_markers = tier >= 4 ? 1 : 0;
      rows.push({
        id: `synthetic:${tier}:${i}`,
        prompt: Array(3 + tier * 3).fill(`tier${tier}`).join(' '),
        tier: TIERS[tier],
        features: f,
      });
    }
  }
  return rows;
}

function manualState(thresholds: number[], heuristicWeight: number): OrdinalModelState {
  const weights = ORDINAL_FEATURE_NAMES.map((name) => name === 'heuristic_score' ? heuristicWeight : 0);
  return {
    version: 'test',
    featureNames: [...ORDINAL_FEATURE_NAMES],
    means: ORDINAL_FEATURE_NAMES.map(() => 0),
    stds: ORDINAL_FEATURE_NAMES.map(() => 1),
    thresholds,
    weights,
    calibration: { a: 1, b: 0 },
    training: {
      trainedAt: new Date(0).toISOString(),
      examples: 0,
      epochs: 0,
      learningRate: 0,
      l2: 0,
    },
  };
}

beforeEach(() => {
  setDefaultOrdinalClassifierForTests(null);
  loadCascadeWeights([], []);
});

describe('ordinal logistic math', () => {
  it('produces monotonic cumulative probabilities', () => {
    const probs = ordinalProbabilities([-2, -1, 0, 1, 2], 0.35);
    expect(probs).toHaveLength(6);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    let cumulative = 0;
    let prev = 0;
    for (const p of probs) {
      expect(p).toBeGreaterThanOrEqual(0);
      cumulative += p;
      expect(cumulative).toBeGreaterThanOrEqual(prev);
      prev = cumulative;
    }
    expect(cumulative).toBeCloseTo(1, 8);
  });

  it('fits deterministically and recovers synthetic ordering', () => {
    const rows = syntheticRows();
    const a = new OrdinalLogisticClassifier();
    const b = new OrdinalLogisticClassifier();
    a.fit(rows, { epochs: 350, learningRate: 0.05, l2: 0.001 });
    b.fit(rows, { epochs: 350, learningRate: 0.05, l2: 0.001 });
    expect(a.toJSON().weights).toEqual(b.toJSON().weights);
    expect(a.toJSON().thresholds).toEqual(b.toJSON().thresholds);

    let previous = -1;
    for (let tier = 0; tier < TIERS.length; tier++) {
      const row = rows.find((r) => r.tier === TIERS[tier])!;
      const pred = a.predictEffort(row.prompt, row.features).tier;
      const idx = TIERS.indexOf(pred);
      expect(idx).toBeGreaterThanOrEqual(previous);
      previous = idx;
    }
    expect(TIERS.indexOf(a.predictEffort(rows[0].prompt, rows[0].features).tier))
      .toBeLessThan(TIERS.indexOf(a.predictEffort(rows[rows.length - 1].prompt, rows[rows.length - 1].features).tier));
  });

  it('falls back to heuristic when persisted weights are missing', () => {
    const model = new OrdinalLogisticClassifier({
      autoLoad: true,
      weightPath: join(process.cwd(), '__missing_v05_ordinal_weights.json'),
    });
    expect(model.isAvailable()).toBe(false);
    const pred = model.predictEffort('hello');
    expect(pred.tier).toBe(scoreToEffort(pred.score ?? 0));
  });
});

describe('ordinal cascade voter integration', () => {
  it('activates the ensemble path when ordinal weights are loaded', () => {
    const model = new OrdinalLogisticClassifier();
    model.loadState(manualState([-3, -1, 1, 3, 5], 8));
    setDefaultOrdinalClassifierForTests(model);

    const vote = ensembleVote({ prompt: 'design a system with 2M events/sec', heuristicScore: 0.5 });
    expect(vote.method).toBe('ensemble-v0.4');
    expect(vote.components.cascadeScore).toBeGreaterThan(0);
    expect(vote.abstained).toBe(false);
  });

  it('abstains on low ordinal margin and falls back to the heuristic tier', () => {
    const model = new OrdinalLogisticClassifier();
    model.loadState(manualState([
      Math.log(1 / 5),
      Math.log(2 / 4),
      0,
      Math.log(4 / 2),
      Math.log(5 / 1),
    ], 0));
    setDefaultOrdinalClassifierForTests(model);

    const vote = ensembleVote({ prompt: 'ambiguous', heuristicScore: 0.30, cascadeAbstainMargin: 0.20 });
    expect(vote.abstained).toBe(true);
    expect(vote.tier).toBe(scoreToEffort(0.30));
    expect(vote.escalated).toBe(false);
  });
});
