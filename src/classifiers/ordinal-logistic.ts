/**
 * Pure-TS ordinal logistic regression for effort-tier routing.
 *
 * Model: proportional-odds / cumulative-logit
 *   P(Y <= k) = sigmoid(theta[k] - dot(w, x)), k=0..4
 *   P(Y = k)  = P(Y <= k) - P(Y <= k-1)
 *
 * The feature set intentionally excludes the 10 zero-MI compatibility fields
 * called out by ROUTING_IMPROVEMENT_PLAN Phase 2, then appends the current
 * heuristic score as one extra input.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { TierClassifier, TierPrediction, LabeledPrompt } from './types.js';
import type { EffortLevel } from '../types.js';
import {
  extractFeatures,
  heuristicScoreFromFeatures,
  type FeatureVector,
} from '../feature-extractor-v04.js';
import { HeuristicLinearClassifier, HEURISTIC_TIERS } from './heuristic-linear.js';
import { tierMidpoints } from '../tier-boundaries.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ORDINAL_MODEL_VERSION = 'v0.5.7-ordinal-logistic';

export type OrdinalFeatureName = keyof FeatureVector | 'heuristic_score';

export const DEAD_FEATURES: readonly (keyof FeatureVector)[] = [
  'entity_count',
  'code_block_size',
  'domain_legal',
  'domain_medical',
  'domain_engineering',
  'temporal_references',
  'output_format_spec',
  'prior_context_needed',
  'multi_domain',
  'user_expertise_level',
];

export const ORDINAL_FEATURE_NAMES: readonly OrdinalFeatureName[] = [
  'has_question',
  'has_code',
  'has_imperative',
  'has_arithmetic',
  'has_sequential',
  'has_constraint',
  'has_context',
  'has_architecture',
  'has_design',
  'sentence_count',
  'avg_word_length',
  'question_technical',
  'technical_design',
  'technical_terms',
  'multi_step',
  'has_negation',
  'domain_finance',
  'novelty_score',
  'compound_tech',
  'requirement_count',
  'distinct_imperative_verbs',
  'question_count',
  'conjunction_enumeration',
  'scale_quantity_mentions',
  'diagnostic_causal_markers',
  'heuristic_score',
];

export interface PlattCalibration {
  a: number;
  b: number;
}

export interface OrdinalModelState {
  version: string;
  featureNames: OrdinalFeatureName[];
  means: number[];
  stds: number[];
  thresholds: number[];
  weights: number[];
  calibration: PlattCalibration;
  training: {
    trainedAt: string;
    examples: number;
    epochs: number;
    learningRate: number;
    l2: number;
  };
}

export interface OrdinalFitOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
}

export interface OrdinalClassifierOptions {
  weightPath?: string;
  autoLoad?: boolean;
}

const DEFAULT_FIT: Required<OrdinalFitOptions> = {
  epochs: 900,
  learningRate: 0.045,
  l2: 0.001,
};

function defaultWeightPaths(): string[] {
  return [
    join(process.cwd(), 'v05_ordinal_weights.json'),
    join(__dirname, '../../v05_ordinal_weights.json'),
    join(__dirname, '../v05_ordinal_weights.json'),
  ];
}

function countWords(prompt: string): number {
  return prompt.split(/\s+/).filter(Boolean).length;
}

function tierIndex(tier: EffortLevel): number {
  return HEURISTIC_TIERS.indexOf(tier);
}

function clampProb(x: number): number {
  return Math.max(1e-9, Math.min(1 - 1e-9, x));
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function logit(p: number): number {
  const q = clampProb(p);
  return Math.log(q / (1 - q));
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function enforceOrderedThresholds(thresholds: number[]): void {
  thresholds.sort((a, b) => a - b);
  for (let i = 1; i < thresholds.length; i++) {
    if (thresholds[i] <= thresholds[i - 1] + 0.025) {
      thresholds[i] = thresholds[i - 1] + 0.025;
    }
  }
}

export function ordinalProbabilities(thresholds: number[], eta: number): number[] {
  if (thresholds.length !== 5) throw new Error('ordinal model requires 5 thresholds');
  const c = thresholds.map((t) => sigmoid(t - eta));
  const probs = [
    c[0],
    c[1] - c[0],
    c[2] - c[1],
    c[3] - c[2],
    c[4] - c[3],
    1 - c[4],
  ];
  const clipped = probs.map((p) => Math.max(0, p));
  const total = clipped.reduce((a, b) => a + b, 0) || 1;
  return clipped.map((p) => p / total);
}

export function featureVectorForOrdinal(prompt: string, feats = extractFeatures(prompt)): number[] {
  const wc = countWords(prompt);
  const heuristic = heuristicScoreFromFeatures(feats, wc);
  return ORDINAL_FEATURE_NAMES.map((name) =>
    name === 'heuristic_score' ? heuristic : Number(feats[name] ?? 0),
  );
}

function normalize(raw: number[], state: Pick<OrdinalModelState, 'means' | 'stds'>): number[] {
  return raw.map((v, i) => (v - state.means[i]) / (state.stds[i] || 1));
}

function stats(rows: number[][], weights: number[] = []): { means: number[]; stds: number[] } {
  const d = ORDINAL_FEATURE_NAMES.length;
  const means = Array(d).fill(0) as number[];
  const stds = Array(d).fill(1) as number[];
  const total = rows.reduce((sum, _row, i) => sum + (weights[i] ?? 1), 0) || 1;
  for (let i = 0; i < rows.length; i++) {
    const w = weights[i] ?? 1;
    for (let j = 0; j < d; j++) means[j] += rows[i][j] * w;
  }
  for (let j = 0; j < d; j++) means[j] /= total;
  for (let i = 0; i < rows.length; i++) {
    const w = weights[i] ?? 1;
    for (let j = 0; j < d; j++) stds[j] += ((rows[i][j] - means[j]) ** 2) * w;
  }
  for (let j = 0; j < d; j++) {
    stds[j] = Math.sqrt(stds[j] / total);
    if (!Number.isFinite(stds[j]) || stds[j] < 1e-6) stds[j] = 1;
  }
  return { means, stds };
}

function initialThresholds(labels: number[], weights: number[]): number[] {
  const n = weights.reduce((a, b) => a + b, 0) || labels.length || 1;
  const thresholds: number[] = [];
  for (let k = 0; k < 5; k++) {
    const le = labels.reduce((sum, y, i) => sum + (y <= k ? weights[i] ?? 1 : 0), 0);
    thresholds.push(logit((le + 0.5) / (n + 1)));
  }
  enforceOrderedThresholds(thresholds);
  return thresholds;
}

function trainCore(x: number[][], y: number[], opts: Required<OrdinalFitOptions>, sampleWeights: number[] = []): {
  thresholds: number[];
  weights: number[];
} {
  const d = ORDINAL_FEATURE_NAMES.length;
  const weights = Array(d).fill(0) as number[];
  const thresholds = initialThresholds(y, sampleWeights.length ? sampleWeights : Array(y.length).fill(1));
  const n = Math.max(sampleWeights.reduce((a, b) => a + b, 0), x.length, 1);

  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    const gradW = Array(d).fill(0) as number[];
    const gradT = Array(5).fill(0) as number[];

    for (let i = 0; i < x.length; i++) {
      const eta = dot(weights, x[i]);
      const sampleWeight = sampleWeights[i] ?? 1;
      const c = thresholds.map((t) => sigmoid(t - eta));
      const deriv = c.map((v) => v * (1 - v));
      const yi = y[i];
      const upper = yi <= 4 ? c[yi] : 1;
      const lower = yi > 0 ? c[yi - 1] : 0;
      const p = Math.max(upper - lower, 1e-9);
      const dUpper = yi <= 4 ? deriv[yi] : 0;
      const dLower = yi > 0 ? deriv[yi - 1] : 0;

      if (yi <= 4) gradT[yi] += sampleWeight * (-dUpper / p);
      if (yi > 0) gradT[yi - 1] += sampleWeight * (dLower / p);

      const coeff = sampleWeight * ((dUpper - dLower) / p);
      for (let j = 0; j < d; j++) gradW[j] += coeff * x[i][j];
    }

    for (let j = 0; j < d; j++) {
      gradW[j] = gradW[j] / n + opts.l2 * weights[j];
      weights[j] -= opts.learningRate * gradW[j];
    }
    for (let k = 0; k < 5; k++) thresholds[k] -= opts.learningRate * (gradT[k] / n);
    enforceOrderedThresholds(thresholds);
  }

  return { thresholds, weights };
}

function fitCalibration(rawConf: number[], correct: boolean[], weights: number[] = []): PlattCalibration {
  if (!rawConf.length) return { a: 1, b: 0 };
  let a = 1;
  let b = 0;
  const lr = 0.05;
  for (let epoch = 0; epoch < 500; epoch++) {
    let ga = 0;
    let gb = 0;
    let total = 0;
    for (let i = 0; i < rawConf.length; i++) {
      const w = weights[i] ?? 1;
      const x = logit(rawConf[i]);
      const y = correct[i] ? 1 : 0;
      const p = sigmoid(a * x + b);
      ga += w * (p - y) * x;
      gb += w * (p - y);
      total += w;
    }
    a -= lr * (ga / Math.max(total, 1) + 0.001 * (a - 1));
    b -= lr * (gb / Math.max(total, 1));
  }
  return { a, b };
}

function topPrediction(probs: number[]): { index: number; max: number; margin: number } {
  let best = 0;
  let second = -Infinity;
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > probs[best]) {
      second = probs[best];
      best = i;
    } else if (probs[i] > second) {
      second = probs[i];
    }
  }
  if (!Number.isFinite(second)) second = 0;
  return { index: best, max: probs[best], margin: probs[best] - second };
}

function probsRecord(probs: number[]): Partial<Record<EffortLevel, number>> {
  return HEURISTIC_TIERS.reduce((acc, tier, i) => {
    acc[tier] = probs[i];
    return acc;
  }, {} as Partial<Record<EffortLevel, number>>);
}

export function expectedScoreFromProbs(probs: Partial<Record<EffortLevel, number>>): number {
  const mids = tierMidpoints();
  let total = 0;
  let mass = 0;
  for (const tier of HEURISTIC_TIERS) {
    const p = probs[tier] ?? 0;
    total += p * mids[tier];
    mass += p;
  }
  return mass > 0 ? total / mass : mids.moderate;
}

export class OrdinalLogisticClassifier implements TierClassifier {
  id = 'ordinal-logistic';
  kind = 'learned' as const;
  version = ORDINAL_MODEL_VERSION;
  requiresTraining = true;

  private state: OrdinalModelState | null = null;
  private loadAttempted = false;
  private readonly weightPath?: string;
  private readonly autoLoad: boolean;
  private readonly fallback = new HeuristicLinearClassifier();

  constructor(options: OrdinalClassifierOptions = {}) {
    this.weightPath = options.weightPath;
    this.autoLoad = options.autoLoad ?? false;
  }

  fit(train: LabeledPrompt[], options: OrdinalFitOptions = {}): void {
    const opts = { ...DEFAULT_FIT, ...options };
    const clean = train
      .filter((r) => r.tier && tierIndex(r.tier) >= 0)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!clean.length) return;

    const sampleWeights = clean.map((r) => Number.isFinite(r.weight) && (r.weight ?? 0) > 0 ? r.weight! : 1);
    const rawRows = clean.map((r) => featureVectorForOrdinal(r.prompt, r.features));
    const labels = clean.map((r) => tierIndex(r.tier!));
    const { means, stds } = stats(rawRows, sampleWeights);
    const rows = rawRows.map((r) => normalize(r, { means, stds }));

    const useHoldout = clean.length >= 20;
    const trainRows: number[][] = [];
    const trainLabels: number[] = [];
    const trainWeights: number[] = [];
    const valRows: number[][] = [];
    const valLabels: number[] = [];
    const valWeights: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (useHoldout && i % 5 === 0) {
        valRows.push(rows[i]);
        valLabels.push(labels[i]);
        valWeights.push(sampleWeights[i]);
      } else {
        trainRows.push(rows[i]);
        trainLabels.push(labels[i]);
        trainWeights.push(sampleWeights[i]);
      }
    }
    if (!trainRows.length) {
      trainRows.push(...rows);
      trainLabels.push(...labels);
      trainWeights.push(...sampleWeights);
    }

    const fitted = trainCore(trainRows, trainLabels, opts, trainWeights);
    const state: OrdinalModelState = {
      version: ORDINAL_MODEL_VERSION,
      featureNames: [...ORDINAL_FEATURE_NAMES],
      means,
      stds,
      thresholds: fitted.thresholds,
      weights: fitted.weights,
      calibration: { a: 1, b: 0 },
      training: {
        trainedAt: new Date(0).toISOString(),
        examples: clean.length,
        epochs: opts.epochs,
        learningRate: opts.learningRate,
        l2: opts.l2,
      },
    };

    const calibrationRows = valRows.length ? valRows : rows;
    const calibrationLabels = valRows.length ? valLabels : labels;
    const calibrationWeights = valRows.length ? valWeights : sampleWeights;
    const rawConf: number[] = [];
    const correct: boolean[] = [];
    for (let i = 0; i < calibrationRows.length; i++) {
      const probs = ordinalProbabilities(state.thresholds, dot(state.weights, calibrationRows[i]));
      const top = topPrediction(probs);
      rawConf.push(top.max);
      correct.push(top.index === calibrationLabels[i]);
    }
    state.calibration = fitCalibration(rawConf, correct, calibrationWeights);
    state.training.trainedAt = new Date().toISOString();
    this.state = state;
    this.loadAttempted = true;
  }

  loadState(state: OrdinalModelState): void {
    if (state.featureNames.join('\n') !== ORDINAL_FEATURE_NAMES.join('\n')) {
      throw new Error('ordinal weights feature set does not match runtime feature set');
    }
    if (state.thresholds.length !== 5 || state.weights.length !== ORDINAL_FEATURE_NAMES.length) {
      throw new Error('invalid ordinal weights shape');
    }
    enforceOrderedThresholds(state.thresholds);
    this.state = {
      ...state,
      featureNames: [...state.featureNames],
      means: [...state.means],
      stds: [...state.stds],
      thresholds: [...state.thresholds],
      weights: [...state.weights],
      calibration: { ...state.calibration },
      training: { ...state.training },
    };
    this.loadAttempted = true;
  }

  toJSON(): OrdinalModelState {
    if (!this.state) throw new Error('ordinal model is not fitted');
    return {
      ...this.state,
      featureNames: [...this.state.featureNames],
      means: [...this.state.means],
      stds: [...this.state.stds],
      thresholds: [...this.state.thresholds],
      weights: [...this.state.weights],
      calibration: { ...this.state.calibration },
      training: { ...this.state.training },
    };
  }

  isAvailable(): boolean {
    this.ensureLoaded();
    return this.state !== null;
  }

  predictEffort(prompt: string, feats?: FeatureVector): TierPrediction {
    const start = performance.now();
    this.ensureLoaded();
    if (!this.state) return this.fallback.predictEffort(prompt);

    const raw = featureVectorForOrdinal(prompt, feats);
    const x = normalize(raw, this.state);
    const probs = ordinalProbabilities(this.state.thresholds, dot(this.state.weights, x));
    const top = topPrediction(probs);
    const calibrated = sigmoid(this.state.calibration.a * logit(top.max) + this.state.calibration.b);
    return {
      tier: HEURISTIC_TIERS[top.index],
      probs: probsRecord(probs),
      confidence: Math.max(0, Math.min(1, calibrated)),
      margin: top.margin,
      latencyMs: performance.now() - start,
    };
  }

  private ensureLoaded(): void {
    if (this.state || this.loadAttempted || !this.autoLoad) return;
    this.loadAttempted = true;
    const paths = this.weightPath ? [this.weightPath] : defaultWeightPaths();
    const path = paths.find((p) => existsSync(p));
    if (!path) return;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OrdinalModelState;
    this.loadState(parsed);
  }
}

let defaultOrdinal: OrdinalLogisticClassifier | null = null;

export function getDefaultOrdinalClassifier(): OrdinalLogisticClassifier {
  if (!defaultOrdinal) defaultOrdinal = new OrdinalLogisticClassifier({ autoLoad: true });
  return defaultOrdinal;
}

export function ordinalModelAvailable(): boolean {
  return getDefaultOrdinalClassifier().isAvailable();
}

export function setDefaultOrdinalClassifierForTests(model: OrdinalLogisticClassifier | null): void {
  defaultOrdinal = model;
}
