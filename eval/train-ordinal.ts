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
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadEffort, type EffortExample } from './lib/dataset.js';
import { effortMetrics, ece, pct } from './lib/metrics.js';
import { OrdinalLogisticClassifier } from '../src/classifiers/ordinal-logistic.js';
import { HeuristicLinearClassifier } from '../src/classifiers/heuristic-linear.js';
import type { EffortLevel } from '../src/types.js';
import type { LabeledPrompt } from '../src/classifiers/types.js';
import type { TierClassifier } from '../src/classifiers/types.js';

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

function pickPrompt(row: any): string | null {
  for (const key of ['prompt', 'text', 'input', 'user_prompt']) {
    if (typeof row?.[key] === 'string' && row[key].trim()) return row[key];
  }
  return null;
}

function pickTier(row: any): EffortLevel | null {
  const direct = row?.gold_vote ?? row?.tier ?? row?.effort ?? row?.label;
  if (isTier(direct)) return direct;
  if (isTier(direct?.tier)) return direct.tier;
  if (isTier(row?.labels?.gold_vote)) return row.labels.gold_vote;
  return null;
}

function loadOrganicGoldVotes(): LabeledPrompt[] {
  if (!existsSync(ORGANIC_PATH)) return [];
  const out: LabeledPrompt[] = [];
  const lines = readFileSync(ORGANIC_PATH, 'utf-8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const prompt = pickPrompt(row);
    const tier = pickTier(row);
    if (prompt && tier) out.push({ id: `organic:gold_vote:${i}`, prompt, tier });
  }
  return out;
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

async function evaluateHoldout(model: TierClassifier, rows: EffortExample[]) {
  const effortRows: { expected: EffortLevel; predicted: EffortLevel }[] = [];
  const eceRows: { confidence: number; correct: boolean }[] = [];
  for (const row of rows) {
    const p = await model.predictEffort(row.prompt);
    effortRows.push({ expected: row.tier, predicted: p.tier });
    eceRows.push({ confidence: p.confidence, correct: p.tier === row.tier });
  }
  return { effort: effortMetrics(effortRows), ece: ece(eceRows) };
}

function printHoldoutLine(name: string, result: Awaited<ReturnType<typeof evaluateHoldout>>): void {
  const heavy = result.effort.recall.heavy;
  console.log(`${name}: exact ${pct(result.effort.exact)} adjacent ${pct(result.effort.adjacent)} mean|dist| ${result.effort.meanDist.toFixed(2)} heavy-recall ${pct(heavy)} ECE ${result.ece.toFixed(3)}`);
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
  const rows = [...frozen, ...organic, ...silver];
  if (!rows.length) throw new Error('no training rows found');

  const model = new OrdinalLogisticClassifier();
  model.fit(rows);
  const state = model.toJSON();
  writeFileSync(WEIGHTS_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');

  console.log(`trained ordinal-logistic on ${rows.length} rows (${frozen.length} frozen + ${organic.length} organic gold_vote + ${silver.length} silver@0.3)`);
  console.log(`wrote ${WEIGHTS_PATH}`);
  console.log(`train exact ${(trainAccuracy(model, rows) * 100).toFixed(1)}%`);

  const holdout = loadFrozenTest();
  const heuristic = new HeuristicLinearClassifier();
  heuristic.fit([...frozen, ...organic]);
  const goldOnly = new OrdinalLogisticClassifier();
  goldOnly.fit([...frozen, ...organic]);

  const heuristicResult = await evaluateHoldout(heuristic, holdout);
  const goldOnlyResult = await evaluateHoldout(goldOnly, holdout);
  const mixedResult = await evaluateHoldout(model, holdout);

  console.log('\n=== Holdout gate (frozen golden TEST) ===');
  printHoldoutLine('heuristic-linear', heuristicResult);
  printHoldoutLine('ordinal-logistic gold-only', goldOnlyResult);
  printHoldoutLine(silver.length ? 'ordinal-logistic gold+silver' : 'ordinal-logistic current', mixedResult);

  const exactDelta = mixedResult.effort.exact - heuristicResult.effort.exact;
  const pass = exactDelta >= 0.03 &&
    mixedResult.effort.adjacent >= 0.90 &&
    (mixedResult.effort.recall.heavy ?? 0) >= 0.30 &&
    mixedResult.ece <= 0.10;
  console.log(`gate delta vs heuristic: ${(exactDelta * 100).toFixed(1)}pp`);
  console.log(`gate result: ${pass ? 'PASS' : 'FAIL'} (requires exact >= heuristic +3pp, adjacent >=90%, heavy recall >=30%, ECE <=0.10)`);
  if (silver.length) {
    console.log(`gold+silver vs gold-only exact delta: ${((mixedResult.effort.exact - goldOnlyResult.effort.exact) * 100).toFixed(1)}pp; ECE delta: ${(mixedResult.ece - goldOnlyResult.ece).toFixed(3)}`);
  }
  console.log('production gate: keep feedback_loop.cascadeRetraining=false or omit v05_ordinal_weights.json if the gate fails');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
