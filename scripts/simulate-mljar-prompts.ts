/**
 * MLJAR prompts simulation — runs the full external corpus through the
 * GateSwarm scorer (gateswarm-lite) and advisory router (gateswarm-router),
 * reporting tier distribution, latency, capability violations, and strategy
 * disagreement. This is a read-only observation tool: it never changes
 * boundaries or matrix data.
 *
 * Usage:
 *   npm run simulate:prompts                          # report to stdout
 *   npm run simulate:prompts -- --write-snapshot      # also freeze {id -> score,tier}
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { scoreComplexity } from 'gateswarm-lite';
import { DEFAULT_MATRIX, EFFORT_RANK, route } from 'gateswarm-router';

const fixture = JSON.parse(
  readFileSync(new URL('../tests/fixtures/mljar-prompts.json', import.meta.url), 'utf-8'),
) as { count: number; prompts: Array<{ id: string; role_slug: string; level: string; prompt: string }> };

const TIERS = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;
const pct = (n: number) => `${((n / fixture.count) * 100).toFixed(1)}%`;

const latencies: number[] = [];
const tierCounts: Record<string, number> = {};
const byLevel: Record<string, Record<string, number>> = {};
let capabilityViolations = 0;
let fallbacks = 0;
let strategyDisagreements = 0;
const scores: Record<string, { score: number; tier: string }> = {};

for (const { id, level, prompt } of fixture.prompts) {
  const r = scoreComplexity(prompt);
  latencies.push(r.latencyMs);
  tierCounts[r.tier] = (tierCounts[r.tier] ?? 0) + 1;
  byLevel[level] ??= {};
  byLevel[level][r.tier] = (byLevel[level][r.tier] ?? 0) + 1;

  const cheapest = route(prompt, { matrix: DEFAULT_MATRIX });
  const bestValue = route(prompt, { matrix: DEFAULT_MATRIX, strategy: 'best-value' });
  if (EFFORT_RANK[cheapest.model.maxEffort] < EFFORT_RANK[r.tier] && !cheapest.reason.includes('falling back')) {
    capabilityViolations++;
  }
  if (cheapest.reason.includes('falling back')) fallbacks++;
  if (cheapest.model.id !== bestValue.model.id) strategyDisagreements++;
  scores[id] = { score: r.score, tier: r.tier };
}

latencies.sort((a, b) => a - b);
const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;

console.log(`MLJAR corpus simulation — ${fixture.count} prompts (source: mljar.com/ai-prompts)\n`);
console.log('Tier distribution:');
for (const t of TIERS) {
  const n = tierCounts[t] ?? 0;
  console.log(`  ${t.padEnd(10)} ${String(n).padStart(4)}  ${pct(n)} ${'#'.repeat(Math.round((n / fixture.count) * 60))}`);
}
console.log('\nTier by declared prompt level:');
for (const level of ['Beginner', 'Intermediate', 'Advanced']) {
  const dist = byLevel[level] ?? {};
  console.log(`  ${level.padEnd(13)} ${TIERS.map((t) => `${t[0]}:${dist[t] ?? 0}`).join('  ')}`);
}
console.log(`\nLatency (ms): mean ${mean.toFixed(3)} | p50 ${latencies[~~(latencies.length / 2)].toFixed(3)} | p95 ${latencies[~~(latencies.length * 0.95)].toFixed(3)} | max ${latencies[latencies.length - 1].toFixed(3)}`);
const rawScores = Object.values(scores).map((s) => s.score).sort((a, b) => a - b);
console.log(`Raw scores: min ${rawScores[0].toFixed(4)} | p10 ${rawScores[~~(rawScores.length * 0.10)].toFixed(4)} | p50 ${rawScores[~~(rawScores.length / 2)].toFixed(4)} | p90 ${rawScores[~~(rawScores.length * 0.90)].toFixed(4)} | max ${rawScores[rawScores.length - 1].toFixed(4)}`);
console.log(`Capability violations (model below tier without explicit fallback): ${capabilityViolations}`);
console.log(`Fallback decisions: ${fallbacks}`);
console.log(`cheapest-capable vs best-value disagreement: ${strategyDisagreements} (${pct(strategyDisagreements)})`);

if (process.argv.includes('--write-snapshot')) {
  const out = new URL('../tests/fixtures/mljar-score-snapshot.json', import.meta.url);
  writeFileSync(out, JSON.stringify({ count: fixture.count, scores }, null, 1) + '\n');
  console.log(`\nsnapshot written: tests/fixtures/mljar-score-snapshot.json`);
}
