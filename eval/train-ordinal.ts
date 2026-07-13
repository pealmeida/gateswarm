/**
 * Train the v0.5 ordinal cascade model on the frozen train split plus optional
 * organic gold-vote rows.
 *
 * Run:
 *   npm run eval:train-ordinal
 *
 * Writes:
 *   v05_ordinal_weights.json
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadEffort, type EffortExample } from './lib/dataset.js';
import { effortMetrics, ece, pct } from './lib/metrics.js';
import { OrdinalLogisticClassifier } from '../src/classifiers/ordinal-logistic.js';
import { HeuristicLinearClassifier } from '../src/classifiers/heuristic-linear.js';
import type { EffortLevel } from '../src/types.js';
import type { LabeledPrompt } from '../src/classifiers/types.js';
import type { TierClassifier } from '../src/classifiers/types.js';
import { decodeOrganicLabel } from '../src/organic-labels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOLDOUT_PATH = join(__dirname, 'splits', 'holdout.v1.json');
const ORGANIC_PATH = join(ROOT, 'data', 'organic', 'labeled.jsonl');
const WEIGHTS_PATH = join(ROOT, 'v05_ordinal_weights.json');
const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

interface Holdout {
  effort: { train: string[]; test: string[] };
}
interface CorpusRow { id: string; text: string; source: string; label?: EffortLevel; }

export interface OrdinalGateMetrics {
  bootstrapExactDeltaLower: number;
  ordinalAdjacent: number;
  ordinalRecall: Record<string, number>;
  holdoutSupport: Record<string, number>;
  ordinalEce: number;
}

export interface OrdinalGateResult {
  passed: boolean;
  reasons: string[];
}

function isTier(x: unknown): x is EffortLevel {
  return typeof x === 'string' && (TIERS as string[]).includes(x);
}

function loadFrozenTrain(): LabeledPrompt[] {
  const holdout = JSON.parse(readFileSync(HOLDOUT_PATH, 'utf-8')) as Holdout;
  const trainIds = new Set(holdout.effort.train);
  const rows = new Map(loadEffort().map((e) => [e.id, e] as const));
  const out: LabeledPrompt[] = [];
  for (const id of trainIds) {
    const row = rows.get(id) as EffortExample | undefined;
    if (row) out.push({ id: row.id, prompt: row.prompt, tier: row.tier });
  }
  return out;
}

function loadFrozenTest(): EffortExample[] {
  const holdout = JSON.parse(readFileSync(HOLDOUT_PATH, 'utf-8')) as Holdout;
  const testIds = new Set(holdout.effort.test);
  const rows = new Map(loadEffort().map((e) => [e.id, e] as const));
  const out: EffortExample[] = [];
  for (const id of testIds) {
    const row = rows.get(id) as EffortExample | undefined;
    if (row) out.push(row);
  }
  return out;
}

export function loadOrganicGoldVotes(path = ORGANIC_PATH): LabeledPrompt[] {
  if (!existsSync(path)) return [];
  const out: LabeledPrompt[] = [];
  let legacySnippetOnly = 0;
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      console.error(`organic labels ${path} row ${i + 1}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const decoded = decodeOrganicLabel(row);
    if (!decoded.ok) {
      if (decoded.legacySnippetOnly) {
        legacySnippetOnly++;
        console.error(`organic labels ${path} row ${i + 1}: ${decoded.reason}`);
      } else {
        console.error(`organic labels ${path} row ${i + 1}: ${decoded.reason}`);
      }
      continue;
    }
    out.push({ id: `organic:gold_vote:${i + 1}`, prompt: decoded.row.prompt, tier: decoded.row.actualTier });
  }
  if (legacySnippetOnly) {
    console.error(`organic labels ${path}: skipped ${legacySnippetOnly} legacy snippet-only rows without prompt`);
  }
  return out;
}

export function normalizedPromptHash(prompt: string): string {
  const normalized = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/** Keep the first occurrence so frozen labels take precedence over organic/silver rows. */
export function deduplicateTrainingRows(rows: LabeledPrompt[]): LabeledPrompt[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const hash = normalizedPromptHash(row.prompt);
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

/** Frozen TEST prompts must never be present in any fitted training row. */
export function assertNoFrozenTestPromptCollisions(
  trainingRows: LabeledPrompt[],
  frozenTestRows: Pick<EffortExample, 'id' | 'prompt'>[],
): void {
  const testByHash = new Map(frozenTestRows.map((row) => [normalizedPromptHash(row.prompt), row.id]));
  for (const row of trainingRows) {
    const testId = testByHash.get(normalizedPromptHash(row.prompt));
    if (testId) {
      throw new Error(`training row ${row.id} collides with frozen TEST row ${testId} by normalized prompt hash`);
    }
  }
}

function loadCorpusById(corpusPath: string): Map<string, CorpusRow> {
  const out = new Map<string, CorpusRow>();
  if (!existsSync(corpusPath)) return out;
  for (const line of readFileSync(corpusPath, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CorpusRow;
    if (row.id && row.text) out.set(row.id, row);
  }
  return out;
}

function loadSilverLabels(pathArg: string | undefined): LabeledPrompt[] {
  if (!pathArg) return [];
  const silverPath = resolve(process.cwd(), pathArg);
  const corpusPath = join(dirname(silverPath), 'corpus.jsonl');
  if (!existsSync(silverPath)) throw new Error(`silver labels not found: ${silverPath}`);
  if (!existsSync(corpusPath)) throw new Error(`silver corpus not found next to labels: ${corpusPath}`);
  const corpus = loadCorpusById(corpusPath);
  const out: LabeledPrompt[] = [];
  const seen = new Set<string>();
  const lines = readFileSync(silverPath, 'utf-8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isTier(row.silver_tier)) continue;
    const source = corpus.get(row.id);
    if (!source) continue;
    if (source.source === 'golden' || source.source === 'organic') continue;
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    out.push({
      id: `silver:${source.id}`,
      prompt: source.text,
      tier: row.silver_tier,
      weight: 0.3,
    });
  }
  return out;
}

export interface HoldoutPrediction {
  expected: EffortLevel;
  predicted: EffortLevel;
}

async function evaluateHoldout(model: TierClassifier, rows: EffortExample[]) {
  const effortRows: HoldoutPrediction[] = [];
  const eceRows: { confidence: number; correct: boolean }[] = [];
  for (const row of rows) {
    const p = await model.predictEffort(row.prompt);
    effortRows.push({ expected: row.tier, predicted: p.tier });
    eceRows.push({ confidence: p.confidence, correct: p.tier === row.tier });
  }
  return { effort: effortMetrics(effortRows), ece: ece(eceRows), predictions: effortRows };
}

function printHoldoutLine(name: string, result: Awaited<ReturnType<typeof evaluateHoldout>>): void {
  const heavy = result.effort.recall.heavy;
  console.log(`${name}: exact ${pct(result.effort.exact)} adjacent ${pct(result.effort.adjacent)} mean|dist| ${result.effort.meanDist.toFixed(2)} heavy-recall ${pct(heavy)} ECE ${result.ece.toFixed(3)}`);
}

export interface BootstrapExactDeltaCI {
  lower: number;
  upper: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Deterministic paired bootstrap for holdout exact-accuracy delta. */
export function bootstrapExactDeltaCI(
  heuristic: HoldoutPrediction[],
  ordinal: HoldoutPrediction[],
  seed = 42,
  resamples = 1000,
): BootstrapExactDeltaCI {
  if (!heuristic.length || heuristic.length !== ordinal.length) throw new Error('paired holdout predictions are required');
  if (!Number.isInteger(resamples) || resamples <= 0) throw new Error('resamples must be a positive integer');
  const random = seededRandom(seed);
  const deltas: number[] = [];
  for (let sample = 0; sample < resamples; sample++) {
    let heuristicCorrect = 0;
    let ordinalCorrect = 0;
    for (let i = 0; i < heuristic.length; i++) {
      const index = Math.floor(random() * heuristic.length);
      if (heuristic[index].expected !== ordinal[index].expected) throw new Error('paired holdout gold tiers differ');
      if (heuristic[index].predicted === heuristic[index].expected) heuristicCorrect++;
      if (ordinal[index].predicted === ordinal[index].expected) ordinalCorrect++;
    }
    deltas.push((ordinalCorrect - heuristicCorrect) / heuristic.length);
  }
  deltas.sort((a, b) => a - b);
  return {
    lower: deltas[Math.floor((resamples - 1) * 0.025)],
    upper: deltas[Math.ceil((resamples - 1) * 0.975)],
  };
}

/** Evaluate the release gate before activating an ordinal weights artifact. */
export function evaluateOrdinalGate(metrics: OrdinalGateMetrics): OrdinalGateResult {
  const requirements: Array<[boolean, string]> = [
    [metrics.bootstrapExactDeltaLower > 0, `bootstrap exact-delta CI lower bound ${(metrics.bootstrapExactDeltaLower * 100).toFixed(1)}pp is not above 0.0pp`],
    [metrics.ordinalAdjacent >= 0.90, `adjacent ${(metrics.ordinalAdjacent * 100).toFixed(1)}% is below 90.0%`],
    [metrics.ordinalEce <= 0.10, `ECE ${metrics.ordinalEce.toFixed(3)} exceeds 0.100`],
  ];
  for (const tier of TIERS) {
    const support = metrics.holdoutSupport[tier] ?? 0;
    const recall = metrics.ordinalRecall[tier];
    if (support >= 5) {
      requirements.push([
        recall >= 0.30,
        `recall[${tier}] ${(recall * 100).toFixed(1)}% is below 30.0% with holdout support ${support}`,
      ]);
    }
  }
  return {
    passed: requirements.every(([passed]) => passed),
    reasons: requirements.filter(([passed]) => !passed).map(([, reason]) => reason),
  };
}

function hashTrainingRows(rows: LabeledPrompt[]): string {
  const contents = rows.map(({ id, prompt, tier, weight }) => ({ id, prompt, tier, weight }));
  return createHash('sha256').update(JSON.stringify(contents)).digest('hex');
}

function parseSilverArg(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--silver') return args[i + 1];
  }
  return undefined;
}

function trainAccuracy(model: OrdinalLogisticClassifier, rows: LabeledPrompt[]): number {
  if (!rows.length) return NaN;
  let correct = 0;
  for (const row of rows) {
    if (model.predictEffort(row.prompt).tier === row.tier) correct++;
  }
  return correct / rows.length;
}

async function main() {
  const silverArg = parseSilverArg();
  const frozen = loadFrozenTrain();
  const organic = loadOrganicGoldVotes();
  const silver = loadSilverLabels(silverArg);
  const goldRows = deduplicateTrainingRows([...frozen, ...organic]);
  const rows = deduplicateTrainingRows([...goldRows, ...silver]);
  if (!rows.length) throw new Error('no training rows found');

  const holdout = loadFrozenTest();
  assertNoFrozenTestPromptCollisions(rows, holdout);

  const model = new OrdinalLogisticClassifier();
  model.fit(rows);

  console.log(`trained ordinal-logistic on ${rows.length} rows (${frozen.length} frozen + ${organic.length} organic gold_vote + ${silver.length} silver@0.3)`);
  console.log(`train exact ${(trainAccuracy(model, rows) * 100).toFixed(1)}%`);

  const heuristic = new HeuristicLinearClassifier();
  heuristic.fit(goldRows);
  const goldOnly = new OrdinalLogisticClassifier();
  goldOnly.fit(goldRows);

  const heuristicResult = await evaluateHoldout(heuristic, holdout);
  const goldOnlyResult = await evaluateHoldout(goldOnly, holdout);
  const mixedResult = await evaluateHoldout(model, holdout);

  console.log('\n=== Holdout gate (frozen golden TEST) ===');
  printHoldoutLine('heuristic-linear', heuristicResult);
  printHoldoutLine('ordinal-logistic gold-only', goldOnlyResult);
  printHoldoutLine(silver.length ? 'ordinal-logistic gold+silver' : 'ordinal-logistic current', mixedResult);

  const exactDeltaCI = bootstrapExactDeltaCI(heuristicResult.predictions, mixedResult.predictions);
  const holdoutSupport = Object.fromEntries(TIERS.map((tier) => [
    tier,
    holdout.filter((row) => row.tier === tier).length,
  ]));
  const metrics: OrdinalGateMetrics = {
    bootstrapExactDeltaLower: exactDeltaCI.lower,
    ordinalAdjacent: mixedResult.effort.adjacent,
    ordinalRecall: mixedResult.effort.recall,
    holdoutSupport,
    ordinalEce: mixedResult.ece,
  };
  const gate = evaluateOrdinalGate(metrics);
  const exactDelta = mixedResult.effort.exact - heuristicResult.effort.exact;
  console.log(`gate delta vs heuristic: ${(exactDelta * 100).toFixed(1)}pp`);
  console.log(`bootstrap 95% CI for exact delta: [${(exactDeltaCI.lower * 100).toFixed(1)}, ${(exactDeltaCI.upper * 100).toFixed(1)}]pp`);
  console.log(`gate result: ${gate.passed ? 'PASS' : 'FAIL'} (requires CI lower >0, adjacent >=90%, per-tier recall >=30% where holdout n>=5, ECE <=0.10)`);
  if (silver.length) {
    console.log(`gold+silver vs gold-only exact delta: ${((mixedResult.effort.exact - goldOnlyResult.effort.exact) * 100).toFixed(1)}pp; ECE delta: ${(mixedResult.ece - goldOnlyResult.ece).toFixed(3)}`);
  }
  if (!gate.passed) {
    console.error(`weights artifact unchanged: ${gate.reasons.join('; ')}`);
    console.log('production gate: keep feedback_loop.cascadeRetraining=false or omit v05_ordinal_weights.json if the gate fails');
    process.exit(1);
  }

  const trainedAt = new Date().toISOString();
  const state = {
    ...model.toJSON(),
    gate: {
      passed: true,
      metrics,
      trainedAt,
      dataHash: hashTrainingRows(rows),
    },
  };
  const tempWeightsPath = `${WEIGHTS_PATH}.tmp-${process.pid}`;
  try {
    writeFileSync(tempWeightsPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    renameSync(tempWeightsPath, WEIGHTS_PATH);
    console.log(`activated gate-passed weights at ${WEIGHTS_PATH}`);
  } finally {
    if (existsSync(tempWeightsPath)) unlinkSync(tempWeightsPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
