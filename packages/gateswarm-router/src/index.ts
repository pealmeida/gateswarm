/**
 * gateswarm-router — advisory model router (GateSwarm layer 2).
 *
 * Scores prompt complexity via gateswarm-lite, then picks the model with the
 * best cost/benefit for the tier from a data-driven matrix. Advisory only:
 * it returns a decision — the caller executes the request.
 */
import { scoreComplexity } from 'gateswarm-lite';
import { DEFAULT_MATRIX } from './matrix.js';
import { selectModel } from './select.js';
import type { RouteDecision, RouteOptions } from './types.js';

export * from './types.js';
export { DEFAULT_MATRIX } from './matrix.js';
export { blendedCost, EFFORT_RANK, selectModel, valueScore, type Selection } from './select.js';

export function route(prompt: string, opts: RouteOptions = {}): RouteDecision {
  const complexity = scoreComplexity(prompt);
  const matrix = opts.matrix ?? DEFAULT_MATRIX;
  const strategy = opts.strategy ?? 'cheapest-capable';
  const { model, alternatives, reason } = selectModel(complexity.tier, matrix, opts);
  return { model, alternatives, complexity, strategy, reason };
}
