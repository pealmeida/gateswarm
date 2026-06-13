/**
 * Shared eval battery — applied uniformly to every classifier (roadmap §7.1).
 * Effort: exact, adjacent ±1, per-tier recall, signed bias, mean |dist|, confusion.
 * Mode: per-class precision/recall/F1, ambiguous→auto.
 * Confidence: ECE (expected calibration error).
 */
import type { EffortLevel, IntentMode } from '../../src/types.js';
import { TIERS, tierIdx } from './dataset.js';

export interface EffortMetrics {
  n: number;
  exact: number;        // 0..1
  adjacent: number;     // 0..1
  signedBias: number;   // + = over-route
  meanDist: number;
  recall: Record<string, number>;
  confusion: Record<string, Record<string, number>>;
}

export function effortMetrics(rows: { expected: EffortLevel; predicted: EffortLevel }[]): EffortMetrics {
  const confusion: Record<string, Record<string, number>> = {};
  for (const t of TIERS) { confusion[t] = {}; for (const p of TIERS) confusion[t][p] = 0; }
  let exact = 0, adjacent = 0, signed = 0, dist = 0;
  for (const r of rows) {
    confusion[r.expected][r.predicted]++;
    const d = tierIdx(r.predicted) - tierIdx(r.expected);
    if (d === 0) exact++;
    if (Math.abs(d) <= 1) adjacent++;
    signed += d; dist += Math.abs(d);
  }
  const recall: Record<string, number> = {};
  for (const t of TIERS) {
    const tot = Object.values(confusion[t]).reduce((a, b) => a + b, 0);
    recall[t] = tot ? confusion[t][t] / tot : NaN;
  }
  const n = rows.length || 1;
  return { n: rows.length, exact: exact / n, adjacent: adjacent / n, signedBias: signed / n, meanDist: dist / n, recall, confusion };
}

export interface ModeMetrics {
  n: number;
  perClass: Record<string, { precision: number; recall: number; f1: number; support: number }>;
  macroF1: number;
}

/** target is the detection target (ambiguous→auto); predicted is detectIntentMode().mode. */
export function modeMetrics(rows: { target: IntentMode; predicted: IntentMode }[]): ModeMetrics {
  const classes: IntentMode[] = ['plan', 'act', 'auto'];
  const perClass: ModeMetrics['perClass'] = {};
  let macro = 0;
  for (const c of classes) {
    let tp = 0, fp = 0, fn = 0, support = 0;
    for (const r of rows) {
      if (r.target === c) support++;
      if (r.predicted === c && r.target === c) tp++;
      if (r.predicted === c && r.target !== c) fp++;
      if (r.predicted !== c && r.target === c) fn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[c] = { precision, recall, f1, support };
    macro += f1;
  }
  return { n: rows.length, perClass, macroF1: macro / classes.length };
}

/** Expected Calibration Error over confidence in [0,1], 10 bins. */
export function ece(rows: { confidence: number; correct: boolean }[], bins = 10): number {
  if (!rows.length) return NaN;
  const bucket = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const r of rows) {
    const b = Math.min(bins - 1, Math.floor(r.confidence * bins));
    bucket[b].n++; bucket[b].conf += r.confidence; bucket[b].acc += r.correct ? 1 : 0;
  }
  let e = 0;
  for (const b of bucket) {
    if (!b.n) continue;
    e += (b.n / rows.length) * Math.abs(b.acc / b.n - b.conf / b.n);
  }
  return e;
}

export const pct = (x: number) => (isNaN(x) ? ' n/a ' : (100 * x).toFixed(1) + '%');
export function meanStd(xs: number[]): { mean: number; std: number } {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return { mean: m, std: Math.sqrt(v) };
}
