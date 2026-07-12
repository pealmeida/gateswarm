import type { EffortLevel } from './types.js';

export type TierBoundaries = [number, number, number, number, number];

// Phase 2 (2026-07-12): one-time sanctioned refit after the mid-band feature
// work (train-only fit; see eval/refit-boundaries.ts). Frozen until the scorer
// changes again. This is the code-level source of truth for cut points.
export const DEFAULT_BOUNDARIES: TierBoundaries = [0.208938, 0.264209, 0.32502, 0.36585, 0.485382];

let _boundaries: TierBoundaries = [...DEFAULT_BOUNDARIES];

/** Update tier cut points (e.g. after retraining). Ignores invalid/non-monotonic input. */
export function setTierBoundaries(b: number[]): boolean {
  if (!Array.isArray(b) || b.length !== 5) return false;
  for (let i = 0; i < 5; i++) {
    if (typeof b[i] !== 'number' || b[i] <= 0 || b[i] >= 1) return false;
    if (i > 0 && b[i] <= b[i - 1]) return false;
  }
  _boundaries = [b[0], b[1], b[2], b[3], b[4]];
  return true;
}

export function getTierBoundaries(): TierBoundaries {
  return [..._boundaries];
}

export function getEffortRanges(
  boundaries: TierBoundaries = _boundaries,
): Record<EffortLevel, [number, number]> {
  const [b0, b1, b2, b3, b4] = boundaries;
  return {
    trivial: [0.00, b0],
    light: [b0, b1],
    moderate: [b1, b2],
    heavy: [b2, b3],
    intensive: [b3, b4],
    extreme: [b4, 1.00],
  };
}

/**
 * Live effort ranges derived from the same mutable boundaries as scoreToEffort().
 * Getter-backed properties keep legacy Object.entries(EFFORT_RANGES) consumers
 * synchronized after config hot-reload or retraining calls setTierBoundaries().
 */
export const EFFORT_RANGES: Record<EffortLevel, [number, number]> = {
  get trivial() {
    return getEffortRanges().trivial;
  },
  get light() {
    return getEffortRanges().light;
  },
  get moderate() {
    return getEffortRanges().moderate;
  },
  get heavy() {
    return getEffortRanges().heavy;
  },
  get intensive() {
    return getEffortRanges().intensive;
  },
  get extreme() {
    return getEffortRanges().extreme;
  },
};

function midpoint(lo: number, hi: number): number {
  return (lo + hi) / 2;
}

/**
 * Representative score for each effort tier, derived live from the configured
 * boundaries. Used by RAG/history priors and manual tier overrides so tier
 * labels never imply scores on retired scales.
 */
export function tierMidpoints(): Record<EffortLevel, number> {
  const [b0, b1, b2, b3, b4] = _boundaries;
  const extremeUpper = Math.min(1, b4 + 2 * (b4 - b3));
  return {
    trivial: midpoint(0, b0),
    light: midpoint(b0, b1),
    moderate: midpoint(b1, b2),
    heavy: midpoint(b2, b3),
    intensive: midpoint(b3, b4),
    extreme: midpoint(b4, extremeUpper),
  };
}

export function scoreToEffort(score: number): EffortLevel {
  const [b0, b1, b2, b3, b4] = _boundaries;
  if (score < b0) return 'trivial';
  if (score < b1) return 'light';
  if (score < b2) return 'moderate';
  if (score < b3) return 'heavy';
  if (score < b4) return 'intensive';
  return 'extreme';
}
