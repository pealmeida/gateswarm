/**
 * Real (leak-free) cross-validated baseline for one classifier.
 * Run: npx tsx eval/cv.ts            (defaults to heuristic-linear)
 *
 * This replaces the old single-set number in ASSESSMENT.md, which was reported
 * on the same prompts the boundaries were fit on (optimistic). Here boundaries
 * are fit per-fold on train only.
 */
import { runCv } from './lib/runner.js';
import { pct } from './lib/metrics.js';
import { TIERS } from './lib/dataset.js';
import { HeuristicLinearClassifier } from '../src/classifiers/heuristic-linear.js';

async function main() {
  const model = new HeuristicLinearClassifier();
  const r = await runCv(model);

  console.log(`\n=== CV baseline: ${r.id} (${model.kind}, ${model.version}) ===`);
  console.log(`Effort exact:    ${pct(r.effort.exact.mean)} ± ${pct(r.effort.exact.std)}`);
  console.log(`Effort adjacent: ${pct(r.effort.adjacent.mean)} ± ${pct(r.effort.adjacent.std)}`);
  console.log(`Signed bias:     ${r.effort.signedBias >= 0 ? '+' : ''}${r.effort.signedBias.toFixed(2)}`);
  console.log(`Mean |dist|:     ${r.effort.meanDist.toFixed(2)}`);
  console.log(`ECE:             ${r.effort.ece.toFixed(3)}`);
  console.log(`Per-tier recall: ${TIERS.map((t) => `${t.slice(0, 4)} ${pct(r.effort.recall[t] ?? NaN)}`).join('  ')}`);
  if (r.mode) {
    console.log(`Mode macro-F1:   ${pct(r.mode.macroF1)}  (plan recall ${pct(r.mode.planRecall)}, act recall ${pct(r.mode.actRecall)}, ambiguous→auto ${pct(r.mode.ambiguousAuto)})`);
  }
  console.log(`Mean latency:    ${r.latencyMs.toFixed(3)} ms  | total cost: $${r.costUsd.toFixed(4)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
