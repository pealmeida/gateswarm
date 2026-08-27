/**
 * Shim — implementation moved to packages/gateswarm-lite (2026-08-25).
 * Named re-exports only: do not `export *` (that would leak scoreComplexity
 * onto this legacy module surface).
 */
export {
  countPromptWords,
  extractFeatures,
  heuristicScoreFromFeatures,
  type FeatureVector,
} from 'gateswarm-lite';
