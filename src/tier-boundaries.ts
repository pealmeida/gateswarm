/**
 * Shim — implementation moved to packages/gateswarm-lite (2026-08-25).
 * Re-exports the SAME module instance, so setTierBoundaries() calls from
 * retraining/hot-reload keep affecting every consumer.
 */
export {
  DEFAULT_BOUNDARIES,
  EFFORT_RANGES,
  getEffortRanges,
  getTierBoundaries,
  scoreToEffort,
  setTierBoundaries,
  tierMidpoints,
  type TierBoundaries,
} from 'gateswarm-lite';
