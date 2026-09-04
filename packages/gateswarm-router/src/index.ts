/**
 * gateswarm-router — advisory model router (GateSwarm layer 2).
 *
 * Scores prompt complexity via gateswarm-lite, then picks the model with the
 * best cost/benefit for the tier from a data-driven matrix. Advisory only:
 * it returns a decision — the caller executes the request.
 */
import { scoreComplexity, scoreSession } from 'gateswarm-lite';
import type { SessionComplexityResult, SessionScoreOptions } from 'gateswarm-lite';
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
  const tier = opts.tier ?? complexity.tier;
  const { model, alternatives, reason } = selectModel(tier, matrix, opts);
  return { model, alternatives, complexity, strategy, reason };
}

/** Sequence-aware routing: window the accumulated conversation, then select. */
export function routeSession(
  turns: string[],
  opts: RouteOptions & SessionScoreOptions = {},
): RouteDecision & { complexity: SessionComplexityResult } {
  const { maxChars, keep, ...rest } = opts;
  const session = scoreSession(turns, { maxChars, keep });
  const matrix = rest.matrix ?? DEFAULT_MATRIX;
  const strategy = rest.strategy ?? 'cheapest-capable';
  const tier = rest.tier ?? session.tier;
  const { model, alternatives, reason } = selectModel(tier, matrix, rest);
  return { model, alternatives, complexity: session, strategy, reason };
}

export * from './calibrate.js';
