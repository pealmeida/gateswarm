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
  //
  // Judged on more than exact accuracy, because exact alone misreads a real case:
  // on dataset v3 the ordinal model TIES the baseline on exact while beating it
  // 87.8% to 63.3% on adjacent and +0.64 to -0.06 on bias. A model that is wrong
  // by one tier where the baseline is wrong by four has clearly earned its keep,
  // and calling that "beaten" would be the wrong lesson.
  const baseline = results.find((r) => r.id === BASELINE_ID);
  if (baseline) {
    const b = baseline.effort;
    console.log(
      `\nBaseline guard — "${BASELINE_ID}" ranks by prompt length alone: ` +
      `${pct(b.exact.mean)} exact, ${pct(b.adjacent.mean)} adjacent, bias ${b.signedBias >= 0 ? '+' : ''}${b.signedBias.toFixed(2)}.`,
    );
    const clears: string[] = [];
    const lost: string[] = [];
    for (const r of results) {
      if (r.id === BASELINE_ID) continue;
      const betterExact = r.effort.exact.mean > b.exact.mean;
      const tiedExact = Math.abs(r.effort.exact.mean - b.exact.mean) < 1e-9;
      const betterAdjacent = r.effort.adjacent.mean > b.adjacent.mean;
      if (betterExact) {
        clears.push(`${r.id} (${pct(r.effort.exact.mean)} exact)`);
      } else if (tiedExact && betterAdjacent) {
        clears.push(`${r.id} (ties on exact, ${pct(r.effort.adjacent.mean)} vs ${pct(b.adjacent.mean)} adjacent)`);
      } else {
        lost.push(`${r.id} (${pct(r.effort.exact.mean)} exact, ${pct(r.effort.adjacent.mean)} adjacent)`);
      }
    }
    if (lost.length) {
      console.log(`  ✗ does not clear the baseline: ${lost.join(', ')}`);
      console.log('    Either the model is not earning its complexity, or this dataset is separable');
      console.log('    by length and cannot measure what it claims to. Check the dataset first.');
    }
    if (clears.length) console.log(`  ✓ clears the baseline: ${clears.join(', ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
