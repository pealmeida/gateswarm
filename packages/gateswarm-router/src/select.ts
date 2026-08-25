import type { EffortLevel } from 'gateswarm-lite';
import type { ModelSpec, RouteOptions, RoutingStrategy } from './types.js';

export const EFFORT_RANK: Record<EffortLevel, number> = {
  trivial: 0,
  light: 1,
  moderate: 2,
  heavy: 3,
  intensive: 4,
  extreme: 5,
};

/** Output-weighted blended cost (USD per 1M tokens): chat workloads are output-heavy. */
export function blendedCost(m: ModelSpec): number {
  return m.costPer1MInput * 0.25 + m.costPer1MOutput * 0.75;
}

/** Quality per blended-cost dollar; the +1 keeps near-free models from dividing by ~0. */
export function valueScore(m: ModelSpec): number {
  return m.quality / (1 + blendedCost(m));
}

function compare(strategy: RoutingStrategy, a: ModelSpec, b: ModelSpec): number {
  switch (strategy) {
    case 'cheapest-capable':
      return blendedCost(a) - blendedCost(b) || b.quality - a.quality;
    case 'best-value':
      return valueScore(b) - valueScore(a) || blendedCost(a) - blendedCost(b);
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`gateswarm-router: unknown strategy ${String(_exhaustive)}`);
    }
  }
}

export interface Selection {
  model: ModelSpec;
  alternatives: ModelSpec[];
  reason: string;
}

export function selectModel(tier: EffortLevel, matrix: ModelSpec[], opts: RouteOptions = {}): Selection {
  if (matrix.length === 0) {
    throw new Error('gateswarm-router: matrix is empty');
  }
  const strategy: RoutingStrategy = opts.strategy ?? 'cheapest-capable';
  const minQuality = opts.minQuality ?? 0;

  const capable = matrix.filter(
    (m) => EFFORT_RANK[m.maxEffort] >= EFFORT_RANK[tier] && m.quality >= minQuality,
  );

  if (capable.length === 0) {
    const pool = [...matrix].sort(
      (a, b) => EFFORT_RANK[b.maxEffort] - EFFORT_RANK[a.maxEffort] || b.quality - a.quality,
    );
    return {
      model: pool[0],
      alternatives: pool.slice(1, 4),
      reason: `no model in the matrix is rated for tier "${tier}"; falling back to the most capable model (${pool[0].id})`,
    };
  }

  const ranked = [...capable].sort((a, b) => compare(strategy, a, b));
  const model = ranked[0];
  const reason =
    strategy === 'best-value'
      ? `tier "${tier}": best quality/cost value among ${capable.length} capable model(s) is ${model.id} (value ${valueScore(model).toFixed(3)})`
      : `tier "${tier}": cheapest capable model among ${capable.length} candidate(s) is ${model.id} ($${blendedCost(model).toFixed(2)}/1M blended)`;

  return { model, alternatives: ranked.slice(1, 4), reason };
}
