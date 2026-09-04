/**
 * Cost-efficiency and accuracy indices over time.
 *
 * Design rule, and the reason this file is careful rather than short: a savings
 * number without its counterfactual is marketing, not measurement. Every figure
 * here names what it is measured against, reports the sample it rests on, and
 * refuses to print a rate that the sample cannot support. An index nobody can
 * challenge is an index nobody should believe.
 */
import type { EffortLevel } from 'gateswarm-lite';
import { blendedCost, selectModel, type ModelSpec } from 'gateswarm-router';
import type { DecisionRecord, FeedbackRecord, OutcomeRecord, TelemetryRecord } from './store.js';

const TIERS: readonly EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
/** Below this, a rate is noise; report the count and withhold the rate. */
export const MIN_SAMPLE_FOR_RATE = 10;

export interface WindowIndices {
  label: string;
  from: number;
  to: number;
  decisions: number;
  /** Blended $/1M if every prompt had gone to the baseline model. */
  baselineCost: number;
  /** The model the baseline is measured against, so the figure can be checked. */
  baselineModelId: string;
  /** Decisions naming a model absent from the current matrix — priced by estimate. */
  unpricedDecisions: number;
  /** Blended $/1M at the tiers actually chosen. */
  routedCost: number;
  /**
   * 1 - routed/baseline. 1 = free, 0 = no better than the no-router baseline,
   * and NEGATIVE when routing spent more than the baseline would have — which
   * is a real outcome worth seeing, not an error to clamp away.
   */
  costEfficiencyIndex: number | null;
  /** Realized token spend, when outcomes carried token counts. */
  tokensIn: number;
  tokensOut: number;
  tokenSampleCount: number;
  byTier: Record<string, number>;
  /** Share of tier verdicts that said the tier was right. */
  accuracyIndex: number | null;
  accuracyN: number;
  accuracyMargin: number | null;
  /** Mean judged output quality. */
  qualityIndex: number | null;
  qualityN: number;
  qualityHumanN: number;
}

export interface IndexReport {
  project: string;
  windows: WindowIndices[];
  overall: WindowIndices;
  /** Reasons a figure is missing or provisional — always surfaced, never hidden. */
  caveats: string[];
}

/** Wilson half-width at 95%; honest small-sample error bars, unlike +-1.96*sqrt(p(1-p)/n). */
function wilsonMargin(hits: number, n: number): number | null {
  if (n < MIN_SAMPLE_FOR_RATE) return null;
  const z = 1.96;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return half;
}

function emptyWindow(label: string, from: number, to: number): WindowIndices {
  const byTier: Record<string, number> = {};
  for (const t of TIERS) byTier[t] = 0;
  return {
    label, from, to, decisions: 0, baselineCost: 0, baselineModelId: '', unpricedDecisions: 0,
    routedCost: 0, costEfficiencyIndex: null,
    tokensIn: 0, tokensOut: 0, tokenSampleCount: 0, byTier,
    accuracyIndex: null, accuracyN: 0, accuracyMargin: null,
    qualityIndex: null, qualityN: 0, qualityHumanN: 0,
  };
}

function summarise(
  label: string, from: number, to: number,
  records: TelemetryRecord[], matrix: ModelSpec[],
): WindowIndices {
  const w = emptyWindow(label, from, to);
  const decisions = records.filter((r): r is DecisionRecord => r.type === 'decision');
  const feedback = records.filter((r): r is FeedbackRecord => r.type === 'feedback');
  const outcomes = records.filter((r): r is OutcomeRecord => r.type === 'outcome');

  // Baseline = what you would pay with no router: the model a cautious user
  // picks for everything. Ties on maxEffort are broken by quality, then by cost
  // descending — without an explicit tie-break the "most capable" model was
  // whichever happened to sort first, which made the whole index arbitrary
  // whenever two models shared a ceiling tier (claude-sonnet vs claude-opus).
  const topModel = [...matrix].sort((a, b) =>
    TIERS.indexOf(b.maxEffort) - TIERS.indexOf(a.maxEffort) ||
    b.quality - a.quality ||
    blendedCost(b) - blendedCost(a),
  )[0];
  const baselineUnit = blendedCost(topModel);
  w.baselineModelId = topModel.id;

  for (const d of decisions) {
    w.decisions++;
    w.byTier[d.tier] = (w.byTier[d.tier] ?? 0) + 1;
    w.baselineCost += baselineUnit;
    const spec = matrix.find((m) => m.id === d.modelId);
    if (spec) {
      w.routedCost += blendedCost(spec);
    } else {
      // The decision names a model this matrix no longer contains (retired id, or
      // a per-project matrix swapped since). Estimating it at today's cheapest
      // capable model UNDERSTATES what was actually spent, so it is counted and
      // surfaced rather than quietly folded into the saving.
      w.unpricedDecisions++;
      w.routedCost += blendedCost(selectModel(d.tier, matrix).model);
    }
  }
  if (w.decisions > 0 && w.baselineCost > 0) {
    w.costEfficiencyIndex = 1 - w.routedCost / w.baselineCost;
  }

  const correct = feedback.filter((f) => f.verdict === 'correct').length;
  w.accuracyN = feedback.length;
  if (feedback.length >= MIN_SAMPLE_FOR_RATE) {
    w.accuracyIndex = correct / feedback.length;
    w.accuracyMargin = wilsonMargin(correct, feedback.length);
  }

  const graded = outcomes.filter((o) => o.ok);
  w.qualityN = graded.length;
  w.qualityHumanN = graded.filter((o) => o.judge === 'human').length;
  if (graded.length >= MIN_SAMPLE_FOR_RATE) {
    w.qualityIndex = graded.reduce((s, o) => s + o.quality, 0) / graded.length;
  }

  for (const o of outcomes) {
    if (typeof o.tokensIn === 'number' || typeof o.tokensOut === 'number') {
      w.tokensIn += o.tokensIn ?? 0;
      w.tokensOut += o.tokensOut ?? 0;
      w.tokenSampleCount++;
    }
  }
  return w;
}

const DAY = 86_400_000;

/** Indices overall and bucketed into recent windows, newest last. */
export function buildIndexReport(
  project: string,
  records: TelemetryRecord[],
  matrix: ModelSpec[],
  options: { buckets?: number; bucketDays?: number; now?: number } = {},
): IndexReport {
  const buckets = options.buckets ?? 4;
  const bucketDays = options.bucketDays ?? 7;
  const now = options.now ?? Date.now();
  const span = bucketDays * DAY;

  const windows: WindowIndices[] = [];
  for (let i = buckets - 1; i >= 0; i--) {
    const to = now - i * span;
    const from = to - span;
    const slice = records.filter((r) => r.ts > from && r.ts <= to);
    windows.push(summarise(`${bucketDays * (i + 1)}d-${bucketDays * i}d ago`, from, to, slice, matrix));
  }
  const overall = summarise('all time', 0, now, records, matrix);

  const caveats: string[] = [];
  if (overall.decisions === 0) caveats.push('no routing decisions recorded yet');
  if (overall.accuracyIndex === null && overall.accuracyN > 0) {
    caveats.push(`accuracy index withheld: ${overall.accuracyN} tier verdict(s), needs ${MIN_SAMPLE_FOR_RATE}`);
  } else if (overall.accuracyN === 0) {
    caveats.push('accuracy index unavailable: no tier verdicts submitted (submit_feedback)');
  }
  if (overall.qualityIndex === null && overall.qualityN === 0) {
    caveats.push('quality index unavailable: no output verdicts submitted (submit_outcome)');
  }
  if (overall.qualityN > 0 && overall.qualityHumanN === 0) {
    caveats.push('quality index rests entirely on model self-judgement — no human verdicts');
  }
  if (overall.unpricedDecisions > 0) {
    caveats.push(
      `${overall.unpricedDecisions}/${overall.decisions} decision(s) name a model absent from this matrix; ` +
      'they are priced at the cheapest capable substitute, which understates the true routed cost',
    );
  }
  if (overall.tokenSampleCount === 0) {
    caveats.push('token economy is PROJECTED from matrix prices; no metered token counts supplied');
  } else if (overall.tokenSampleCount < overall.decisions) {
    caveats.push(`metered tokens cover ${overall.tokenSampleCount}/${overall.decisions} decisions; the rest is projected`);
  }
  return { project, windows, overall, caveats };
}

const bar = (share: number, width = 12) =>
  '█'.repeat(Math.round(share * width)).padEnd(width, '·');
const pctOrDash = (x: number | null) => (x === null ? '  n/a ' : `${(100 * x).toFixed(1)}%`);

/** Terminal-friendly rendering. Every figure carries its denominator. */
export function formatIndexReport(r: IndexReport): string {
  const o = r.overall;
  const L: string[] = [];
  L.push(`GateSwarm token economy — project "${r.project}"`);
  L.push('');
  L.push(`  Routed                ${o.decisions} prompts`);
  L.push(`  Baseline (no router)  ${o.baselineCost.toFixed(2)} blended $/1M  — every prompt at ${o.baselineModelId || 'the most capable model'}`);
  L.push(`  Routed                ${o.routedCost.toFixed(2)} blended $/1M`);
  if (o.costEfficiencyIndex !== null) {
    L.push(`  Saved                 ${(o.baselineCost - o.routedCost).toFixed(2)}  (${pctOrDash(o.costEfficiencyIndex)})`);
    L.push(`  Cost-efficiency index ${o.costEfficiencyIndex.toFixed(3)}   (1 = free, 0 = no better than the baseline, negative = worse)`);
  }
  if (o.tokenSampleCount > 0) {
    L.push(`  Metered tokens        in ${o.tokensIn.toLocaleString()} / out ${o.tokensOut.toLocaleString()} over ${o.tokenSampleCount} call(s)`);
  }
  L.push('');
  L.push('  Tier mix');
  for (const t of TIERS) {
    const n = o.byTier[t] ?? 0;
    const share = o.decisions ? n / o.decisions : 0;
    L.push(`    ${t.padEnd(10)} ${bar(share)} ${String(n).padStart(5)}  ${(100 * share).toFixed(1)}%`);
  }
  L.push('');
  const acc = o.accuracyIndex === null
    ? `n/a (${o.accuracyN} verdict(s), needs ${MIN_SAMPLE_FOR_RATE})`
    : `${pctOrDash(o.accuracyIndex)}${o.accuracyMargin !== null ? ` ±${(100 * o.accuracyMargin).toFixed(1)}pp` : ''}  (n=${o.accuracyN})`;
  const qual = o.qualityIndex === null
    ? `n/a (${o.qualityN} verdict(s), needs ${MIN_SAMPLE_FOR_RATE})`
    : `${pctOrDash(o.qualityIndex)}  (n=${o.qualityN}, ${o.qualityHumanN} human)`;
  L.push(`  Accuracy index (was the TIER right?)     ${acc}`);
  L.push(`  Quality index  (was the OUTPUT good?)    ${qual}`);
  L.push('');
  L.push('  Trend (oldest → newest)');
  L.push(`    window        prompts   saving   accuracy   quality`);
  for (const w of r.windows) {
    L.push(`    ${w.label.padEnd(13)} ${String(w.decisions).padStart(6)}   ${pctOrDash(w.costEfficiencyIndex).padStart(6)}   ${pctOrDash(w.accuracyIndex).padStart(7)}   ${pctOrDash(w.qualityIndex).padStart(7)}`);
  }
  if (r.caveats.length) {
    L.push('');
    L.push('  Read this before quoting any number above:');
    for (const c of r.caveats) L.push(`    · ${c}`);
  }
  return L.join('\n');
}
