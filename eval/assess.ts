/**
 * GateSwarm Router — Prompt Evaluation Assessment Harness
 *
 * Measures classifier "assertiveness" across two dimensions:
 *   1. Effort tier  (scoreIntent → tier)
 *   2. Plan/Act mode (detectIntentMode → mode)
 *
 * Reads a labeled golden dataset (eval/dataset.json) and reports:
 *   - exact + adjacent (±1 tier) accuracy
 *   - per-tier confusion matrix + recall
 *   - escalation rate (final tier vs raw scored tier)
 *   - confidence distribution (flags constant/fake confidence)
 *   - directional bias (over- vs under-classification)
 *   - mode precision/recall + ambiguous→auto rate
 *
 * Run: npx tsx eval/assess.ts
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scoreIntent } from '../src/intent-engine-v04.js';
import { detectIntentMode } from '../src/v04-config.js';
import { scoreToEffort } from '../src/intent-engine.js';
import type { EffortLevel } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
const tierIdx = (t: string) => TIERS.indexOf(t as EffortLevel);

interface Dataset {
  effort: { tier: EffortLevel; prompts: string[] }[];
  mode: { mode: string; prompts: string[] }[];
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : ((100 * n) / d).toFixed(1) + '%';
}

async function assessEffort(dataset: Dataset) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' EFFORT TIER ASSESSMENT');
  console.log('══════════════════════════════════════════════════════════════');

  let total = 0, exact = 0, adjacent = 0, escalated = 0;
  let distSum = 0, signedSum = 0;
  const confidences: number[] = [];
  // confusion[expected][predicted]
  const confusion: Record<string, Record<string, number>> = {};
  for (const t of TIERS) { confusion[t] = {}; for (const p of TIERS) confusion[t][p] = 0; }
  // raw (pre-escalation) accuracy
  let rawExact = 0;

  for (const group of dataset.effort) {
    for (const prompt of group.prompts) {
      const r = await scoreIntent(prompt);
      const expected = group.tier;
      const final = (r.tier || scoreToEffort(r.value)) as EffortLevel;
      const raw = scoreToEffort(r.value);
      total++;
      confidences.push(r.confidence ?? 0);
      confusion[expected][final]++;
      if (final === expected) exact++;
      if (raw === expected) rawExact++;
      const dist = tierIdx(final) - tierIdx(expected);
      if (Math.abs(dist) <= 1) adjacent++;
      distSum += Math.abs(dist);
      signedSum += dist;
      if (raw !== final) escalated++;
    }
  }

  console.log(`\nSamples: ${total}`);
  console.log(`Exact tier accuracy (final):  ${exact}/${total} = ${pct(exact, total)}`);
  console.log(`Raw  tier accuracy (pre-esc): ${rawExact}/${total} = ${pct(rawExact, total)}`);
  console.log(`Adjacent (±1 tier) accuracy:  ${adjacent}/${total} = ${pct(adjacent, total)}`);
  console.log(`Escalation rate (raw→final):  ${escalated}/${total} = ${pct(escalated, total)}`);
  console.log(`Mean |tier distance|:         ${(distSum / total).toFixed(2)}`);
  console.log(`Signed bias (+ = over-route): ${(signedSum / total >= 0 ? '+' : '') + (signedSum / total).toFixed(2)}`);

  // Confidence distribution
  const uniqConf = [...new Set(confidences.map(c => c.toFixed(3)))];
  const meanConf = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  console.log(`\nConfidence: mean=${meanConf.toFixed(3)}, distinct values=${uniqConf.length} ${uniqConf.length <= 1 ? '⚠️  CONSTANT (fake confidence)' : ''}`);
  if (uniqConf.length <= 3) console.log(`  values seen: ${uniqConf.join(', ')}`);

  // Per-tier recall + confusion
  console.log('\nConfusion matrix (rows=expected, cols=predicted final tier):');
  const head = 'expected\\pred'.padEnd(14) + TIERS.map(t => t.slice(0, 5).padStart(7)).join('') + '   recall';
  console.log(head);
  for (const exp of TIERS) {
    const row = confusion[exp];
    const rowTotal = Object.values(row).reduce((a, b) => a + b, 0);
    const correct = row[exp];
    const cells = TIERS.map(p => String(row[p] || '').padStart(7)).join('');
    console.log(exp.padEnd(14) + cells + '   ' + pct(correct, rowTotal).padStart(6));
  }

  return { total, exact, adjacent, escalated, meanConf, distinctConf: uniqConf.length, signedBias: signedSum / total, rawExact };
}

function assessMode(dataset: Dataset) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' PLAN/ACT MODE ASSESSMENT');
  console.log('══════════════════════════════════════════════════════════════');

  // For plan/act: correct = detected matches. For ambiguous: correct = 'auto'.
  const stat: Record<string, { total: number; correct: number; detected: Record<string, number>; conf: number[] }> = {};
  for (const m of ['plan', 'act', 'ambiguous']) stat[m] = { total: 0, correct: 0, detected: {}, conf: [] };

  for (const group of dataset.mode) {
    const label = group.mode;
    for (const prompt of group.prompts) {
      const r = detectIntentMode(prompt);
      const s = stat[label];
      if (!s) continue;
      s.total++;
      s.conf.push(r.confidence);
      s.detected[r.mode] = (s.detected[r.mode] || 0) + 1;
      const correct = label === 'ambiguous' ? r.mode === 'auto' : r.mode === label;
      if (correct) s.correct++;
    }
  }

  for (const label of ['plan', 'act', 'ambiguous']) {
    const s = stat[label];
    if (!s || s.total === 0) continue;
    const meanConf = s.conf.reduce((a, b) => a + b, 0) / s.conf.length;
    const target = label === 'ambiguous' ? 'auto' : label;
    console.log(`\n${label.toUpperCase()} (n=${s.total}) — correct (→${target}): ${s.correct}/${s.total} = ${pct(s.correct, s.total)}, mean conf=${meanConf.toFixed(2)}`);
    console.log(`  detected distribution: ${Object.entries(s.detected).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  }

  // Precision for plan and act
  for (const m of ['plan', 'act']) {
    let tp = 0, fp = 0;
    for (const label of ['plan', 'act', 'ambiguous']) {
      const d = stat[label]?.detected[m] || 0;
      if (label === m) tp += d; else fp += d;
    }
    console.log(`\n${m} precision: ${tp}/${tp + fp} = ${pct(tp, tp + fp)}  (recall: ${pct(stat[m].correct, stat[m].total)})`);
  }

  return stat;
}

async function main() {
  const datasetPath = join(__dirname, 'dataset.json');
  const dataset: Dataset = JSON.parse(readFileSync(datasetPath, 'utf-8'));
  const effortN = dataset.effort.reduce((s, g) => s + g.prompts.length, 0);
  const modeN = dataset.mode.reduce((s, g) => s + g.prompts.length, 0);
  console.log(`Loaded dataset: ${effortN} effort prompts, ${modeN} mode prompts`);

  const effort = await assessEffort(dataset);
  const mode = assessMode(dataset);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`Effort exact: ${pct(effort.exact, effort.total)} | raw: ${pct(effort.rawExact, effort.total)} | ±1: ${pct(effort.adjacent, effort.total)} | escalation: ${pct(effort.escalated, effort.total)} | bias: ${effort.signedBias.toFixed(2)} | confidence distinct: ${effort.distinctConf}`);
  const planR = mode.plan, actR = mode.act, ambR = mode.ambiguous;
  console.log(`Mode plan recall: ${pct(planR.correct, planR.total)} | act recall: ${pct(actR.correct, actR.total)} | ambiguous→auto: ${pct(ambR.correct, ambR.total)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
