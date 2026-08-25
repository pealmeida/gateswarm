/**
 * Model-complexity fit report — the review instrument for scoreComplexity.
 *
 * Answers, for a real prompt corpus + routing matrix:
 *   1. Where does traffic sit relative to the tier cut points?
 *   2. What does each boundary move cost/save (per-1M blended index)?
 *   3. Which prompts should be human-labeled first for maximum
 *      calibration information per minute of review?
 *
 * Usage:
 *   npm run fit:report                                   # MLJAR corpus, DEFAULT_MATRIX
 *   npm run fit:report -- --fixture path.json [--eps 0.02] [--top 20]
 *
 * The loop this feeds: fit:report → label the queue in Promptly →
 * eval:refit-boundaries → eval:gate → own-PR boundary update → regen snapshots.
 */
import { readFileSync } from 'node:fs';
import { getTierBoundaries, scoreComplexity } from 'gateswarm-lite';
import { DEFAULT_MATRIX } from 'gateswarm-router';
import {
  TIERS,
  boundarySwings,
  buildRows,
  labelingQueue,
  saturation,
  summarize,
} from './lib/fit.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fixturePath = arg('--fixture') ?? new URL('../tests/fixtures/mljar-prompts.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const eps = Number(arg('--eps') ?? 0.02);
const top = Number(arg('--top') ?? 20);

const raw = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  source?: string;
  count?: number;
  prompts: Array<{ id?: string; title?: string; prompt: string }>;
};
const corpus = raw.prompts.map((p, i) => ({ id: p.id ?? p.title ?? `p${i}`, prompt: p.prompt }));
const matrix = DEFAULT_MATRIX;
const boundaries = getTierBoundaries();

console.log(`Model-complexity fit report`);
console.log(`corpus: ${corpus.length} prompts (${raw.source ?? fixturePath}) | eps=${eps} | DEFAULT_MATRIX\n`);

const rows = buildRows(corpus, matrix, scoreComplexity);
const summary = summarize(rows);

console.log('Routing today (cheapest-capable):');
for (const [tier, n] of TIERS.map((t) => [t, summary.perTier[t] ?? 0] as const)) {
  console.log(`  ${tier.padEnd(10)} ${String(n).padStart(4)}  ${((n / rows.length) * 100).toFixed(1)}%`);
}
console.log('\nModel share:');
for (const [id, m] of Object.entries(summary.perModel).sort((a, b) => b[1].costShare - a[1].costShare)) {
  console.log(`  ${id.padEnd(18)} ${String(m.count).padStart(4)} prompts · ${(m.costShare / summary.totalCost * 100).toFixed(1)}% of cost mass`);
}
console.log(`\nCost index: total ${summary.totalCost.toFixed(2)} · mean ${summary.meanCost.toFixed(3)} $/1M blended per prompt`);

const sat = saturation(rows, boundaries);
console.log(`\nSaturation: ${(sat.shareAboveTop * 100).toFixed(1)}% of traffic above top boundary (${boundaries[4]}); median distance-to-top ${sat.medianDistanceToTop.toFixed(3)}`);
if (sat.shareAboveTop > 0.5) {
  console.log(`  ⚠ top band carries >50% of traffic — tiers carry little resolution there.`);
}

const swings = boundarySwings(rows, boundaries, matrix, eps);
console.log(`\nBoundary sensitivity (traffic within ±${eps} of a cut point):`);
let anySwing = false;
for (const s of swings) {
  const label = `b${s.boundaryIndex} (${TIERS[s.boundaryIndex]}|${TIERS[s.boundaryIndex + 1]}) @ ${s.value}`;
  if (s.raise.count === 0 && s.lower.count === 0) {
    console.log(`  ${label.padEnd(42)} no nearby traffic — dead zone (fine, or boundary is misplaced)`);
    continue;
  }
  anySwing = true;
  if (s.raise.count)
    console.log(
      `  ${label.padEnd(42)} RAISE demotes ${String(s.raise.count).padStart(3)} → Δ ${s.raise.costDelta.toFixed(3)} (savings if quality holds)`,
    );
  if (s.lower.count)
    console.log(
      `  ${' '.repeat(42)} LOWER promotes ${String(s.lower.count).padStart(3)} → Δ +${s.lower.costDelta.toFixed(3)} (spend for safety)`,
    );
}
if (!anySwing) {
  console.log('  ⚠ No boundary has nearby traffic: cut points sit OUTSIDE the score distribution.');
  console.log('    A refit on labeled traffic (eval:refit-boundaries) is the lever that matters.');
}

const queue = labelingQueue(swings, top);
if (queue.length) {
  console.log(`\nLabeling priority queue (top ${queue.length} — judge these first):`);
  for (const q of queue) {
    console.log(`  ${q.id.padEnd(40)} score ${q.score.toFixed(4)} · ${q.from}→${q.to} · Δ ${q.costDelta.toFixed(3)}`);
  }
  console.log('\nFeed verdicts into the review dataset, then eval:refit-boundaries → eval:gate.');
}
