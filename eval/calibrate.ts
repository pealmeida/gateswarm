/**
 * Calibration diagnostic — tests an improved scoring function and derives boundaries.
 * Run: npx tsx eval/calibrate.ts
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractFeatures, type FeatureVector } from '../src/feature-extractor-v04.js';
import type { EffortLevel } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
const dataset = JSON.parse(readFileSync(join(__dirname, 'dataset.json'), 'utf-8'));

// ── Candidate improved scoring function ──────────────────────────────
function scoreV2(prompt: string): number {
  const f: FeatureVector = extractFeatures(prompt);
  const wc = prompt.split(/\s+/).filter(Boolean).length;

  // Length: dominant complexity signal, saturating. log1p(wc)/log1p(45) → 0..1
  const lengthScore = Math.min(Math.log1p(wc) / Math.log1p(45), 1) * 0.34;
  // Structure: multiple sentences/clauses
  const structScore = Math.min(f.sentence_count, 5) / 5 * 0.10;
  // Architecture & design lexicon
  const archScore = Math.min((f.has_architecture + f.has_design) * 0.10, 0.20);
  // Technical terms (saturating)
  const techScore = Math.min(f.technical_terms * 0.025, 0.12);
  // Code presence
  const codeScore = f.has_code * 0.05 + (f.code_block_size > 0 ? 0.05 : 0);
  // Reasoning / constraint signals
  const reasonScore =
    f.has_constraint * 0.04 + f.has_context * 0.03 + f.multi_step * 0.04 +
    f.has_negation * 0.02 + f.has_sequential * 0.02;
  // Domain & expertise
  const domainScore = f.multi_domain * 0.05 + f.user_expertise_level * 0.03 +
    (f.domain_finance + f.domain_legal + f.domain_medical + f.domain_engineering > 0 ? 0.03 : 0);
  // System-design bonus (compound complexity)
  const sysCount = f.has_architecture + f.technical_design + (f.technical_terms > 3 ? 1 : 0) + f.multi_domain;
  const sysBonus = wc >= 12 && sysCount >= 3 ? 0.12 : wc >= 10 && sysCount >= 2 ? 0.06 : 0;

  const score = lengthScore + structScore + archScore + techScore + codeScore +
    reasonScore + domainScore + sysBonus;
  return Math.min(Math.max(score, 0), 1);
}

const scoresByTier: Record<string, number[]> = {};
for (const g of dataset.effort) {
  scoresByTier[g.tier] = g.prompts.map((p: string) => scoreV2(p)).sort((a: number, b: number) => a - b);
}
const median = (a: number[]) => a[Math.floor(a.length / 2)];
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

console.log('scoreV2 distribution per tier:\n');
console.log('tier'.padEnd(11), 'min'.padEnd(7), 'p25'.padEnd(7), 'median'.padEnd(8), 'p75'.padEnd(7), 'max'.padEnd(7), 'mean');
for (const t of TIERS) {
  const s = scoresByTier[t];
  console.log(t.padEnd(11), s[0].toFixed(3).padEnd(7), s[Math.floor(s.length*0.25)].toFixed(3).padEnd(7),
    median(s).toFixed(3).padEnd(8), s[Math.floor(s.length*0.75)].toFixed(3).padEnd(7),
    s[s.length-1].toFixed(3).padEnd(7), mean(s).toFixed(3));
}

const all: { score: number; tier: number }[] = [];
TIERS.forEach((t, i) => scoresByTier[t].forEach(sc => all.push({ score: sc, tier: i })));
function accuracyFor(bounds: number[]): number {
  let correct = 0;
  for (const { score, tier } of all) {
    let pred = 0;
    while (pred < bounds.length && score >= bounds[pred]) pred++;
    if (pred === tier) correct++;
  }
  return correct / all.length;
}
const grid: number[] = [];
for (let v = 0.05; v <= 0.75; v += 0.01) grid.push(Number(v.toFixed(3)));
let best = { acc: 0, bounds: [0.15, 0.25, 0.35, 0.45, 0.55] };
for (const b0 of grid.filter(v => v < 0.25))
  for (const b1 of grid.filter(v => v > b0 && v < 0.4))
    for (const b2 of grid.filter(v => v > b1 && v < 0.5))
      for (const b3 of grid.filter(v => v > b2 && v < 0.6))
        for (const b4 of grid.filter(v => v > b3 && v < 0.75)) {
          const acc = accuracyFor([b0, b1, b2, b3, b4]);
          if (acc > best.acc) best = { acc, bounds: [b0, b1, b2, b3, b4] };
        }
console.log('\nBest-fit boundaries:', JSON.stringify(best.bounds), ' exact acc:', best.acc.toFixed(3));
// adjacent accuracy at best bounds
let adj = 0;
for (const { score, tier } of all) { let p = 0; while (p < best.bounds.length && score >= best.bounds[p]) p++; if (Math.abs(p - tier) <= 1) adj++; }
console.log('Adjacent (±1) acc at best bounds:', (adj / all.length).toFixed(3));

// Evaluate hand-rounded, generalizable boundary candidates
console.log('\nCandidate boundary sets (exact / adjacent):');
const candidates: [string, number[]][] = [
  ['smooth-A', [0.225, 0.285, 0.335, 0.39, 0.45]],
  ['smooth-B', [0.22, 0.29, 0.33, 0.37, 0.45]],
  ['smooth-C', [0.21, 0.28, 0.32, 0.37, 0.46]],
  ['smooth-D', [0.22, 0.30, 0.34, 0.40, 0.47]],
];
for (const [name, b] of candidates) {
  let ex = 0, ad = 0;
  for (const { score, tier } of all) { let p = 0; while (p < b.length && score >= b[p]) p++; if (p===tier) ex++; if (Math.abs(p-tier)<=1) ad++; }
  console.log('  '+name.padEnd(10), JSON.stringify(b), ' exact:', (ex/all.length).toFixed(3), ' adj:', (ad/all.length).toFixed(3));
}
