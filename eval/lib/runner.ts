/**
 * Shared CV runner — drives ANY TierClassifier through the frozen folds and
 * applies the uniform battery. Asserts dataset+split hashes first (roadmap §11.2)
 * so "same test set / same dataset" is enforced, not assumed.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadEffort, loadMode, loadRaw, modeTarget, type EffortExample, type ModeExample } from './dataset.js';
import { sha256 } from './split.js';
import { effortMetrics, modeMetrics, ece, meanStd, type EffortMetrics, type ModeMetrics } from './metrics.js';
import type { TierClassifier, LabeledPrompt } from '../../src/classifiers/types.js';
import type { EffortLevel, IntentMode } from '../../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLIT_DIR = join(__dirname, '..', 'splits');

interface Manifest { hashes: Record<string, string>; k: number; }
interface Folds { effort: string[][]; mode: string[][]; }

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(SPLIT_DIR, 'MANIFEST.json'), 'utf-8'));
}

/** Hard-fail if the data/splits drifted from the manifest. */
export function assertHashes(): void {
  const m = loadManifest();
  const { bytes } = loadRaw();
  const got = sha256(bytes);
  if (got !== m.hashes['dataset.json']) {
    throw new Error(`dataset.json hash drift: manifest ${m.hashes['dataset.json'].slice(0, 12)} vs actual ${got.slice(0, 12)}. Re-run eval/split.ts and bump version.`);
  }
  for (const f of ['folds.v1.json', 'holdout.v1.json']) {
    const s = readFileSync(join(SPLIT_DIR, f), 'utf-8');
    if (sha256(s) !== m.hashes[f]) throw new Error(`${f} hash drift vs MANIFEST. Splits were edited by hand.`);
  }
}

function loadFolds(): Folds {
  return JSON.parse(readFileSync(join(SPLIT_DIR, 'folds.v1.json'), 'utf-8'));
}

export interface CvResult {
  id: string;
  effort: { exact: { mean: number; std: number }; adjacent: { mean: number; std: number }; signedBias: number; meanDist: number; recall: Record<string, number>; ece: number };
  mode: { macroF1: number; planRecall: number; actRecall: number; ambiguousAuto: number } | null;
  latencyMs: number; costUsd: number;
}

export async function runCv(model: TierClassifier): Promise<CvResult> {
  assertHashes();
  const folds = loadFolds();
  const effort = new Map(loadEffort().map((e) => [e.id, e]));
  const modeEx = new Map(loadMode().map((m) => [m.id, m]));
  const k = folds.effort.length;

  const exacts: number[] = [], adjs: number[] = [];
  let signedSum = 0, distSum = 0, nAll = 0, totalLatency = 0, totalCost = 0, nPred = 0;
  const recallAcc: Record<string, number[]> = {};
  const eceRows: { confidence: number; correct: boolean }[] = [];
  const allEffortRows: { expected: EffortLevel; predicted: EffortLevel }[] = [];

  for (let f = 0; f < k; f++) {
    const testIds = new Set(folds.effort[f]);
    const trainEx: LabeledPrompt[] = [];
    for (const e of effort.values()) if (!testIds.has(e.id)) trainEx.push({ id: e.id, prompt: e.prompt, tier: e.tier });
    if (model.requiresTraining && model.fit) await model.fit(trainEx);

    const rows: { expected: EffortLevel; predicted: EffortLevel }[] = [];
    for (const id of testIds) {
      const ex = effort.get(id)! as EffortExample;
      const p = await model.predictEffort(ex.prompt);
      rows.push({ expected: ex.tier, predicted: p.tier });
      eceRows.push({ confidence: p.confidence, correct: p.tier === ex.tier });
      totalLatency += p.latencyMs; totalCost += p.costUsd ?? 0; nPred++;
    }
    const m = effortMetrics(rows);
    exacts.push(m.exact); adjs.push(m.adjacent);
    signedSum += m.signedBias * m.n; distSum += m.meanDist * m.n; nAll += m.n;
    for (const [t, r] of Object.entries(m.recall)) if (!isNaN(r)) (recallAcc[t] ??= []).push(r);
    allEffortRows.push(...rows);
  }

  // Mode (zero-shot; rule path has no fold dependence, eval over full set once).
  let mode: CvResult['mode'] = null;
  if (model.predictMode) {
    const rows: { target: IntentMode; predicted: IntentMode }[] = [];
    for (const m of modeEx.values()) {
      const ex = m as ModeExample;
      const p = await model.predictMode(ex.prompt);
      rows.push({ target: modeTarget(ex.label), predicted: p.mode });
    }
    const mm: ModeMetrics = modeMetrics(rows);
    mode = {
      macroF1: mm.macroF1,
      planRecall: mm.perClass.plan.recall,
      actRecall: mm.perClass.act.recall,
      ambiguousAuto: mm.perClass.auto.recall,
    };
  }

  const recall: Record<string, number> = {};
  for (const [t, xs] of Object.entries(recallAcc)) recall[t] = meanStd(xs).mean;

  return {
    id: model.id,
    effort: {
      exact: meanStd(exacts), adjacent: meanStd(adjs),
      signedBias: signedSum / nAll, meanDist: distSum / nAll, recall,
      ece: ece(eceRows),
    },
    mode,
    latencyMs: nPred ? totalLatency / nPred : 0,
    costUsd: totalCost,
  };
}
