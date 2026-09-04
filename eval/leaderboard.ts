/**
 * Model-agnostic leaderboard (roadmap §11.5).
 * Run: npx tsx eval/leaderboard.ts
 *
 * Registers every candidate classifier, runs each through the SAME frozen folds
 * + battery (hash-asserted), and prints a table sorted by CV exact accuracy with
 * cost + latency so selection is on the accuracy×cost×latency Pareto front, not
 * accuracy alone.
 *
 * Add a model: import it and push into REGISTRY. Nothing else changes.
 */
import { runCv, type CvResult } from './lib/runner.js';
import { pct } from './lib/metrics.js';
import type { TierClassifier } from '../src/classifiers/types.js';
import { HeuristicLinearClassifier } from '../src/classifiers/heuristic-linear.js';
import { OrdinalLogisticClassifier } from '../src/classifiers/ordinal-logistic.js';
import { LengthBaselineClassifier } from '../src/classifiers/length-baseline.js';

// Register candidates here. Future: Gbdt, EmbedKnn, LlmClassifier(provider).
const REGISTRY: TierClassifier[] = [
  new HeuristicLinearClassifier(),
  new OrdinalLogisticClassifier(),
  // The guard. Ranks by prompt length and nothing else; any model that does not
  // beat it is not paying for its complexity. See src/classifiers/length-baseline.ts.
  new LengthBaselineClassifier(),
];

/** id of the trivial baseline every other row is judged against. */
const BASELINE_ID = 'length-only';

function pad(s: string, n: number) { return s.padEnd(n).slice(0, n); }
function rpad(s: string, n: number) { return s.padStart(n); }

async function main() {
  const results: CvResult[] = [];
  for (const model of REGISTRY) {
    process.stderr.write(`running ${model.id}…\n`);
    results.push(await runCv(model));
  }
  results.sort((a, b) => b.effort.exact.mean - a.effort.exact.mean);

  const head = [pad('model', 22), rpad('exact', 9), rpad('±', 7), rpad('adj', 8), rpad('bias', 7), rpad('ECE', 7), rpad('modeF1', 8), rpad('ms', 9), rpad('cost$', 9)].join(' ');
  console.log('\n' + head);
  console.log('-'.repeat(head.length));
  for (const r of results) {
    console.log([
      pad(r.id, 22),
      rpad(pct(r.effort.exact.mean), 9),
      rpad(pct(r.effort.exact.std), 7),
      rpad(pct(r.effort.adjacent.mean), 8),
      rpad((r.effort.signedBias >= 0 ? '+' : '') + r.effort.signedBias.toFixed(2), 7),
      rpad(r.effort.ece.toFixed(3), 7),
      rpad(r.mode ? pct(r.mode.macroF1) : 'n/a', 8),
      rpad(r.latencyMs.toFixed(2), 9),
      rpad(r.costUsd.toFixed(4), 9),
    ].join(' '));
  }
  console.log('\nSelection = Pareto front over (exact, cost, latency), not exact alone.');

  // The guard, stated out loud. A model that loses to ranking by length has not
  // earned its feature set — or the dataset cannot tell complexity from verbosity.
  const baseline = results.find((r) => r.id === BASELINE_ID);
  if (baseline) {
    const beaten = results.filter((r) => r.id !== BASELINE_ID && r.effort.exact.mean > baseline.effort.exact.mean);
    const lost = results.filter((r) => r.id !== BASELINE_ID && r.effort.exact.mean <= baseline.effort.exact.mean);
    console.log(`\nBaseline guard — "${BASELINE_ID}" ranks by prompt length alone: ${pct(baseline.effort.exact.mean)} exact.`);
    if (lost.length) {
      console.log(`  ✗ BEATEN BY THE BASELINE: ${lost.map((r) => `${r.id} (${pct(r.effort.exact.mean)})`).join(', ')}`);
      console.log('    Either the model is not earning its complexity, or this dataset is separable');
      console.log('    by length and cannot measure what it claims to. Check the dataset first.');
    }
    if (beaten.length) {
      console.log(`  ✓ clears the baseline: ${beaten.map((r) => r.id).join(', ')}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
