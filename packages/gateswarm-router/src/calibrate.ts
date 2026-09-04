/**
 * Outcome-driven matrix recalibration.
 *
 * `ModelSpec.quality` starts as a reviewed prior. This module replaces that
 * prior with what a model actually delivered on your traffic, so the next
 * routing decision reflects the last N outcomes rather than a number typed into
 * a table months ago. It closes the policy loop described in
 * docs/superpowers/specs/2026-08-25-dogfood-loop-golden-dataset.md §7.
 *
 * Two invariants, both deliberate:
 *
 *   1. Quality is RELATIVE, not absolute. A win rate is only comparable within
 *      one matrix on one workload, so recalibrated values are renormalised to
 *      preserve the matrix's existing quality span. Otherwise a project whose
 *      raters are generous inflates every model and `minQuality` stops meaning
 *      anything.
 *   2. Evidence gates the move. A model with three observations does not get to
 *      overturn its prior: the estimate is shrunk toward the prior with
 *      pseudo-counts, and `maxEffort` demotion requires a minimum sample. This
 *      mirrors the label-combiner's phase gating — no silent activation on thin
 *      data.
 *
 * Advisory, like the rest of the router: this returns a NEW matrix. Nothing is
 * mutated, nothing is persisted, and no request is executed.
 */
import type { EffortLevel } from 'gateswarm-lite';
import type { ModelSpec } from './types.js';
import { EFFORT_RANK } from './select.js';

const TIER_ORDER: readonly EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

/** One graded delivery: a model answered at a tier, and the result was judged. */
export interface OutcomeRecord {
  modelId: string;
  /** Tier the request was routed at. */
  tier: EffortLevel;
  /**
   * Judged quality of the output in [0,1]. A binary accept/reject is 1 or 0;
   * a rubric score can be fractional. This is the "was the result accurate"
   * vote, not a measure of how hard the task was.
   */
  quality: number;
  /** False for transport/provider failures. Excluded from quality, counted for reliability. */
  ok?: boolean;
  /** Optional weight — e.g. human verdicts outweigh model-judged ones. */
  weight?: number;
}

export interface RecalibrationOptions {
  /**
   * Observations needed before a model's own evidence outweighs its prior.
   * Higher = more conservative. Default 8.
   */
  pseudoCounts?: number;
  /** Minimum graded outcomes at a tier before maxEffort may be demoted. Default 5. */
  minSamplesForDemotion?: number;
  /** Mean quality at a tier below which the model is demoted out of it. Default 0.5. */
  demotionQualityFloor?: number;
  /** Keep the recalibrated values inside the input matrix's quality span. Default true. */
  preserveSpan?: boolean;
}

export interface ModelCalibration {
  modelId: string;
  priorQuality: number;
  observedQuality: number | null;
  /** Prior blended with observation, before renormalisation. */
  shrunkQuality: number;
  /** Final value written to the returned matrix. */
  calibratedQuality: number;
  samples: number;
  failures: number;
  priorMaxEffort: EffortLevel;
  calibratedMaxEffort: EffortLevel;
  /** Human-readable justification for anything that changed. */
  notes: string[];
}

export interface RecalibrationResult {
  matrix: ModelSpec[];
  calibrations: ModelCalibration[];
  /** Models in the outcomes that are not in the matrix — usually a typo or a retired id. */
  unknownModelIds: string[];
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0.01, x));
}

function weightOf(o: OutcomeRecord): number {
  const w = o.weight ?? 1;
  return Number.isFinite(w) && w > 0 ? w : 1;
}

/**
 * Recalibrate `quality` (and, where the evidence supports it, `maxEffort`) from
 * graded outcomes. Returns a new matrix; the input is untouched.
 */
export function recalibrateMatrix(
  matrix: readonly ModelSpec[],
  outcomes: readonly OutcomeRecord[],
  options: RecalibrationOptions = {},
): RecalibrationResult {
  if (matrix.length === 0) throw new Error('gateswarm-router: matrix is empty');
  const K = options.pseudoCounts ?? 8;
  const minDemotion = options.minSamplesForDemotion ?? 5;
  const floor = options.demotionQualityFloor ?? 0.5;
  const preserveSpan = options.preserveSpan !== false;

  const known = new Set(matrix.map((m) => m.id));
  const unknownModelIds = [...new Set(outcomes.map((o) => o.modelId).filter((id) => !known.has(id)))];

  const graded = outcomes.filter(
    (o) => o.ok !== false && Number.isFinite(o.quality) && o.quality >= 0 && o.quality <= 1,
  );

  const calibrations: ModelCalibration[] = matrix.map((spec) => {
    const mine = graded.filter((o) => o.modelId === spec.id);
    const failures = outcomes.filter((o) => o.modelId === spec.id && o.ok === false).length;
    const notes: string[] = [];

    let observedQuality: number | null = null;
    let shrunk = spec.quality;
    if (mine.length) {
      const w = mine.reduce((s, o) => s + weightOf(o), 0);
      observedQuality = mine.reduce((s, o) => s + o.quality * weightOf(o), 0) / w;
      // Shrink toward the prior: thin evidence barely moves the number.
      shrunk = clamp01((observedQuality * w + spec.quality * K) / (w + K));
      notes.push(
        `quality ${spec.quality.toFixed(3)} → ${shrunk.toFixed(3)} from ${mine.length} graded outcome(s) (observed ${observedQuality.toFixed(3)}, K=${K})`,
      );
    } else {
      notes.push('no graded outcomes; prior quality kept');
    }
    if (failures) notes.push(`${failures} transport/provider failure(s) excluded from quality`);

    // maxEffort demotion: sustained poor results AT the model's ceiling tier.
    let calibratedMaxEffort = spec.maxEffort;
    const atCeiling = graded.filter((o) => o.modelId === spec.id && o.tier === spec.maxEffort);
    if (atCeiling.length >= minDemotion) {
      const meanAtCeiling = atCeiling.reduce((s, o) => s + o.quality * weightOf(o), 0) /
        atCeiling.reduce((s, o) => s + weightOf(o), 0);
      if (meanAtCeiling < floor) {
        const rank = EFFORT_RANK[spec.maxEffort];
        if (rank > 0) {
          calibratedMaxEffort = TIER_ORDER[rank - 1];
          notes.push(
            `maxEffort ${spec.maxEffort} → ${calibratedMaxEffort}: mean quality ${meanAtCeiling.toFixed(3)} over ${atCeiling.length} outcome(s) at its ceiling is below the ${floor} floor`,
          );
        } else {
          notes.push(`quality at ceiling is below the floor but "${spec.maxEffort}" is the lowest tier; not demoted`);
        }
      }
    }

    return {
      modelId: spec.id,
      priorQuality: spec.quality,
      observedQuality,
      shrunkQuality: shrunk,
      calibratedQuality: shrunk,
      samples: mine.length,
      failures,
      priorMaxEffort: spec.maxEffort,
      calibratedMaxEffort,
      notes,
    };
  });

  // Keep values inside the input matrix's quality span, so `minQuality`
  // thresholds chosen against the original matrix still mean what they meant.
  //
  // This CLAMPS rather than linearly remapping the whole set. An earlier
  // remapping version rescaled every model against the new min/max, which meant
  // grading one model down silently promoted six ungraded ones — enough, in
  // testing, to push a model past a `minQuality` gate on no evidence of its own.
  // Evidence about one model must never move another. A model with no
  // observations therefore keeps its prior exactly: its shrunk value equals its
  // prior, so the clamp is a no-op for it.
  if (preserveSpan) {
    const priorLo = Math.min(...matrix.map((m) => m.quality));
    const priorHi = Math.max(...matrix.map((m) => m.quality));
    for (const c of calibrations) {
      c.calibratedQuality = clamp01(Math.min(priorHi, Math.max(priorLo, c.shrunkQuality)));
    }
  }

  const byId = new Map(calibrations.map((c) => [c.modelId, c]));
  const next = matrix.map((spec) => {
    const c = byId.get(spec.id)!;
    return { ...spec, quality: c.calibratedQuality, maxEffort: c.calibratedMaxEffort };
  });

  return { matrix: next, calibrations, unknownModelIds };
}

/** One-line-per-model summary of what a recalibration would change. */
export function formatRecalibration(result: RecalibrationResult): string {
  const lines = ['Matrix recalibration from graded outcomes:'];
  for (const c of result.calibrations) {
    const q = Math.abs(c.calibratedQuality - c.priorQuality) >= 0.005
      ? `${c.priorQuality.toFixed(3)} → ${c.calibratedQuality.toFixed(3)}`
      : `${c.priorQuality.toFixed(3)} (unchanged)`;
    const eff = c.calibratedMaxEffort !== c.priorMaxEffort
      ? `  maxEffort ${c.priorMaxEffort} → ${c.calibratedMaxEffort}`
      : '';
    lines.push(`  ${c.modelId.padEnd(20)} quality ${q}  n=${c.samples}${eff}`);
  }
  if (result.unknownModelIds.length) {
    lines.push(`  ⚠ outcomes reference unknown model id(s): ${result.unknownModelIds.join(', ')}`);
  }
  return lines.join('\n');
}
