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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadEffort, type EffortExample } from './lib/dataset.js';
import { OrdinalLogisticClassifier } from '../src/classifiers/ordinal-logistic.js';
import type { EffortLevel } from '../src/types.js';
import type { LabeledPrompt } from '../src/classifiers/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOLDOUT_PATH = join(__dirname, 'splits', 'holdout.v1.json');
const ORGANIC_PATH = join(ROOT, 'data', 'organic', 'labeled.jsonl');
const WEIGHTS_PATH = join(ROOT, 'v05_ordinal_weights.json');
const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

interface Holdout {
  effort: { train: string[]; test: string[] };
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
    if (row.source !== 'gold_vote' && row.label_source !== 'gold_vote' && row.gold_source !== 'gold_vote') {
      continue;
    }
    const prompt = pickPrompt(row);
    const tier = pickTier(row);
    if (prompt && tier) out.push({ id: `organic:gold_vote:${i}`, prompt, tier });
  }
  return out;
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
  const frozen = loadFrozenTrain();
  const organic = loadOrganicGoldVotes();
  const rows = [...frozen, ...organic];
  if (!rows.length) throw new Error('no training rows found');

  const model = new OrdinalLogisticClassifier();
  model.fit(rows);
  const state = model.toJSON();
  writeFileSync(WEIGHTS_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');

  console.log(`trained ordinal-logistic on ${rows.length} rows (${frozen.length} frozen + ${organic.length} organic gold_vote)`);
  console.log(`wrote ${WEIGHTS_PATH}`);
  console.log(`train exact ${(trainAccuracy(model, rows) * 100).toFixed(1)}%`);
  console.log('gate check: npm run eval:cv -- ordinal-logistic');
  console.log('required: exact >= heuristic-linear +3pp, adjacent >=90%, heavy recall >=30%, ECE <=0.10');
  console.log('production gate: keep feedback_loop.cascadeRetraining=false or omit v05_ordinal_weights.json if the gate fails');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
