/**
 * Phase 1.1 boundary refit.
 *
 * Fits tier cut points on the frozen train split only, reports held-out and
 * 5-fold CV metrics, and writes a reviewable proposal under eval/reports.
 * Applying a boundary change is an intentional reviewed edit to the TS source.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadEffort, loadRaw, TIERS, type EffortExample } from './lib/dataset.js';
import { effortMetrics, meanStd, pct } from './lib/metrics.js';
import { foldsFile, holdoutFile, sha256, trainFile } from './lib/split.js';
import type { EffortLevel } from '../src/types.js';
import {
  DEFAULT_HEURISTIC_BOUNDARIES,
  fitMonotonicCutPoints,
  rawHeuristicScore,
  scoreToTier,
  type ScoredTier,
} from '../src/classifiers/heuristic-linear.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLIT_DIR = join(__dirname, 'splits');
const REPORTS_DIR = join(__dirname, 'reports');

interface Manifest {
  hashes: Record<string, string>;
  k: number;
}

interface Folds {
  effort: string[][];
}

interface TrainTestSplit {
  train: string[];
  test: string[];
}

interface ScoredExample extends ScoredTier {
  id: string;
  prompt: string;
}

interface BoundaryEval {
  exact: number;
  adjacent: number;
  recall: Record<string, number>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(SPLIT_DIR, 'MANIFEST.json'), 'utf-8')) as Manifest;
}

function assertHash(name: string, bytes: string, manifest: Manifest): void {
  const expected = manifest.hashes[name];
  if (!expected) throw new Error(`${name} is not listed in eval/splits/MANIFEST.json`);
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${name} hash drift: manifest ${expected.slice(0, 12)} vs actual ${actual.slice(0, 12)}`);
  }
}

function loadJsonWithHash<T>(name: string, manifest: Manifest): T {
  const bytes = readFileSync(join(SPLIT_DIR, name), 'utf-8');
  assertHash(name, bytes, manifest);
  return JSON.parse(bytes) as T;
}

function assertDatasetHash(manifest: Manifest): void {
  const { bytes } = loadRaw();
  assertHash('dataset.json', bytes, manifest);
}

function chooseTrainSplitFile(manifest: Manifest): string {
  const preferred = trainFile();
  if (manifest.hashes[preferred] || existsSync(join(SPLIT_DIR, preferred))) return preferred;
  return holdoutFile();
}

function parseTrainTestSplit(raw: unknown): TrainTestSplit {
  const r = raw as {
    effort?: { train?: string[]; test?: string[] } | string[];
    train?: string[];
    test?: string[];
  };
  if (r.effort && !Array.isArray(r.effort) && Array.isArray(r.effort.train) && Array.isArray(r.effort.test)) {
    return { train: r.effort.train, test: r.effort.test };
  }
  if (Array.isArray(r.train) && Array.isArray(r.test)) return { train: r.train, test: r.test };
  throw new Error('Expected a frozen split with effort.train and effort.test arrays');
}

function loadFrozen(): { splitName: string; split: TrainTestSplit; folds: Folds } {
  const manifest = readManifest();
  assertDatasetHash(manifest);
  const splitName = chooseTrainSplitFile(manifest);
  const splitRaw = loadJsonWithHash<unknown>(splitName, manifest);
  const folds = loadJsonWithHash<Folds>(foldsFile(), manifest);
  return { splitName, split: parseTrainTestSplit(splitRaw), folds };
}

function scoreExamples(examples: EffortExample[]): ScoredExample[] {
  return examples.map((e) => ({
    id: e.id,
    prompt: e.prompt,
    tier: e.tier,
    score: rawHeuristicScore(e.prompt),
  }));
}

function fit(rows: ScoredExample[]): number[] {
  return fitMonotonicCutPoints(rows.map((r) => ({ score: r.score, tier: r.tier })));
}

function evaluate(rows: ScoredExample[], boundaries: number[]): BoundaryEval {
  const metrics = effortMetrics(rows.map((r) => ({
    expected: r.tier,
    predicted: scoreToTier(r.score, boundaries),
  })));
  return { exact: metrics.exact, adjacent: metrics.adjacent, recall: metrics.recall };
}

function summarizeCv(all: ScoredExample[], folds: Folds, fitted: boolean): {
  exact: { mean: number; std: number };
  adjacent: { mean: number; std: number };
  recall: Record<string, number>;
} {
  const byId = new Map(all.map((e) => [e.id, e]));
  const exact: number[] = [];
  const adjacent: number[] = [];
  const recallAcc: Record<string, number[]> = {};

  for (const valIds of folds.effort) {
    const valSet = new Set(valIds);
    const train = all.filter((e) => !valSet.has(e.id));
    const val = valIds.map((id) => {
      const row = byId.get(id);
      if (!row) throw new Error(`Unknown fold id ${id}`);
      return row;
    });
    const boundaries = fitted ? fit(train) : DEFAULT_HEURISTIC_BOUNDARIES;
    const metrics = evaluate(val, boundaries);
    exact.push(metrics.exact);
    adjacent.push(metrics.adjacent);
    for (const [tier, recall] of Object.entries(metrics.recall)) {
      if (!Number.isNaN(recall)) (recallAcc[tier] ??= []).push(recall);
    }
  }

  const recall: Record<string, number> = {};
  for (const tier of TIERS) recall[tier] = meanStd(recallAcc[tier] ?? [NaN]).mean;
  return { exact: meanStd(exact), adjacent: meanStd(adjacent), recall };
}

function formatBoundaries(boundaries: number[]): string {
  return `[${boundaries.map((b) => Number(b.toFixed(6))).join(', ')}]`;
}

function formatRecall(recall: Record<string, number>): string {
  return TIERS.map((tier) => `${tier.slice(0, 4)} ${pct(recall[tier] ?? NaN)}`).join('  ');
}

function printEval(label: string, metrics: BoundaryEval): void {
  console.log(`${label}: exact ${pct(metrics.exact)}  adjacent ${pct(metrics.adjacent)}  recall ${formatRecall(metrics.recall)}`);
}

function tierBoundaryConfig(boundaries: number[]): Record<EffortLevel, [number, number]> {
  const b = boundaries.map((x) => Number(x.toFixed(6)));
  return {
    trivial: [0, b[0]],
    light: [b[0], b[1]],
    moderate: [b[1], b[2]],
    heavy: [b[2], b[3]],
    intensive: [b[3], b[4]],
    extreme: [b[4], 1],
  };
}

function proposalPath(date = new Date()): string {
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return join(REPORTS_DIR, `boundary-proposal-${stamp}.json`);
}

function writeProposal(boundaries: number[], splitName: string, metrics: {
  trainCurrent: BoundaryEval;
  trainFitted: BoundaryEval;
  testCurrent: BoundaryEval;
  testFitted: BoundaryEval;
}): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = proposalPath();
  const proposal = {
    generatedAt: new Date().toISOString(),
    split: splitName,
    proposedCutPoints: boundaries.map((boundary) => Number(boundary.toFixed(6))),
    proposedTierBoundaries: tierBoundaryConfig(boundaries),
    metrics,
    instructions: [
      'This file is a proposal only; it does not change runtime routing.',
      'Review held-out metrics, then make a reviewed edit to src/tier-boundaries.ts if approved.',
      'Do not write tier boundaries into v04_config.json; config overrides require an explicit boundaries_override key and a loud runtime log.',
    ],
  };
  writeFileSync(path, JSON.stringify(proposal, null, 2) + '\n', 'utf-8');
  return path;
}

function usage(): string {
  return 'Usage: npx tsx eval/refit-boundaries.ts\n\nWrites a proposal under eval/reports; --apply is retired and never modifies v04_config.json.';
}

export function main(argv = process.argv.slice(2)): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  if (argv.includes('--apply')) {
    console.warn('--apply is retired: emitting a proposal only; no configuration file will be modified.');
  }
  const { splitName, split, folds } = loadFrozen();
  const all = scoreExamples(loadEffort());
  const byId = new Map(all.map((e) => [e.id, e]));
  const pick = (ids: string[]) => ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new Error(`Unknown split id ${id}`);
    return row;
  });

  const train = pick(split.train);
  const test = pick(split.test);
  const fittedBoundaries = fit(train);

  const trainCurrent = evaluate(train, DEFAULT_HEURISTIC_BOUNDARIES);
  const trainFitted = evaluate(train, fittedBoundaries);
  const testCurrent = evaluate(test, DEFAULT_HEURISTIC_BOUNDARIES);
  const testFitted = evaluate(test, fittedBoundaries);
  const cvCurrent = summarizeCv(all, folds, false);
  const cvFitted = summarizeCv(all, folds, true);

  console.log('\n=== Phase 1.1 heuristic boundary refit ===');
  console.log(`Split: ${splitName}  train=${train.length}  held_out=${test.length}`);
  console.log(`Current boundaries: ${formatBoundaries(DEFAULT_HEURISTIC_BOUNDARIES)}`);
  console.log(`Fitted boundaries:  ${formatBoundaries(fittedBoundaries)}`);
  printEval('Train current ', trainCurrent);
  printEval('Train fitted  ', trainFitted);
  printEval('Held-out current', testCurrent);
  printEval('Held-out fitted ', testFitted);
  console.log(`5-fold CV current: exact ${pct(cvCurrent.exact.mean)} ± ${pct(cvCurrent.exact.std)}  adjacent ${pct(cvCurrent.adjacent.mean)} ± ${pct(cvCurrent.adjacent.std)}`);
  console.log(`5-fold CV fitted:  exact ${pct(cvFitted.exact.mean)} ± ${pct(cvFitted.exact.std)}  adjacent ${pct(cvFitted.adjacent.mean)} ± ${pct(cvFitted.adjacent.std)}`);
  console.log(`5-fold CV fitted recall: ${formatRecall(cvFitted.recall)}`);

  const proposal = writeProposal(fittedBoundaries, splitName, { trainCurrent, trainFitted, testCurrent, testFitted });
  console.log(`Wrote boundary proposal: ${proposal}`);
  console.log('Review it, then make a reviewed edit to src/tier-boundaries.ts if approved. v04_config.json was not modified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
