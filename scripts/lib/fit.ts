import type { EffortLevel } from 'gateswarm-lite';
import { blendedCost, selectModel } from 'gateswarm-router';
import type { ModelSpec } from 'gateswarm-router';

/**
 * Pure model-complexity fit math used by `npm run fit:report`.
 *
 * Fit = how well tier boundaries split TRAFFIC such that each band routes to
 * the cheapest model that can actually do the work. These helpers quantify
 * boundary sensitivity (what happens to routing cost if a cut point moves)
 * and produce a labeling priority queue (which prompts to judge first for
 * maximum calibration information per labeling minute).
 */

export const TIERS: EffortLevel[] = [
  'trivial',
  'light',
  'moderate',
  'heavy',
  'intensive',
  'extreme',
];

export interface CorpusEntry {
  id: string;
  prompt: string;
}

export interface FitRow {
  id: string;
  score: number;
  tier: EffortLevel;
  modelId: string;
  cost: number;
}

export type TierScorer = (prompt: string) => { score: number; tier: EffortLevel };

/** Route every corpus entry at its scored tier; record blended cost. */
export function buildRows(corpus: CorpusEntry[], matrix: ModelSpec[], score: TierScorer): FitRow[] {
  return corpus.map((c) => {
    const { score: s, tier } = score(c.prompt);
    const { model } = selectModel(tier, matrix);
    return { id: c.id, score: s, tier, modelId: model.id, cost: blendedCost(model) };
  });
}

export interface FitSummary {
  count: number;
  totalCost: number;
  meanCost: number;
  perTier: Record<string, number>;
  perModel: Record<string, { count: number; costShare: number }>;
}

export function summarize(rows: FitRow[]): FitSummary {
  const totalCost = rows.reduce((a, r) => a + r.cost, 0);
  const perTier: Record<string, number> = {};
  const perModel: Record<string, { count: number; costShare: number }> = {};
  for (const r of rows) {
    perTier[r.tier] = (perTier[r.tier] ?? 0) + 1;
    const m = (perModel[r.modelId] ??= { count: 0, costShare: 0 });
    m.count++;
    m.costShare += r.cost;
  }
  return {
    count: rows.length,
    totalCost,
    meanCost: rows.length ? totalCost / rows.length : 0,
    perTier,
    perModel,
  };
}

export interface SwingItem {
  id: string;
  score: number;
  from: EffortLevel;
  to: EffortLevel;
  /** (routing cost after move) − (current). Negative = savings. */
  costDelta: number;
}

export interface SwingSide {
  count: number;
  costDelta: number;
  items: SwingItem[];
}

export interface BoundarySwing {
  /** Index into boundaries/TIERS: boundary j separates TIERS[j] | TIERS[j+1]. */
  boundaryIndex: number;
  value: number;
  /** Raising the cut point demotes these prompts (cheaper, riskier). */
  raise: SwingSide;
  /** Lowering the cut point promotes these prompts (safer, pricier). */
  lower: SwingSide;
}

function side(items: SwingItem[]): SwingSide {
  return {
    count: items.length,
    costDelta: items.reduce((a, i) => a + i.costDelta, 0),
    items,
  };
}

/**
 * For each cut point, find traffic sitting within `eps` of it and price the
 * move in both directions using `matrix` routing at the neighboring tier.
 */
export function boundarySwings(
  rows: FitRow[],
  boundaries: number[],
  matrix: ModelSpec[],
  eps = 0.02,
): BoundarySwing[] {
  return boundaries.map((b, j) => {
    const upper = TIERS[j + 1];
    const lower = TIERS[j];
    if (!upper) throw new Error(`boundary ${j} has no upper tier`);

    const raiseItems: SwingItem[] = [];
    const lowerItems: SwingItem[] = [];

    for (const r of rows) {
      if (r.tier === upper && r.score - b >= 0 && r.score - b <= eps) {
        const demoted = selectModel(lower, matrix).model;
        raiseItems.push({
          id: r.id,
          score: r.score,
          from: upper,
          to: lower,
          costDelta: blendedCost(demoted) - r.cost,
        });
      } else if (r.tier === lower && b - r.score >= 0 && b - r.score <= eps) {
        const promoted = selectModel(upper, matrix).model;
        lowerItems.push({
          id: r.id,
          score: r.score,
          from: lower,
          to: upper,
          costDelta: blendedCost(promoted) - r.cost,
        });
      }
    }

    return { boundaryIndex: j, value: b, raise: side(raiseItems), lower: side(lowerItems) };
  });
}

/**
 * Highest-information prompts to human-label first: flipping their judged tier
 * moves the most routing money. Union of all swing sides, |delta| desc.
 */
export function labelingQueue(swings: BoundarySwing[], n = 20): SwingItem[] {
  const seen = new Set<string>();
  const all: SwingItem[] = [];
  for (const s of swings) {
    for (const item of [...s.raise.items, ...s.lower.items]) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        all.push(item);
      }
    }
  }
  return all.sort((a, b) => Math.abs(b.costDelta) - Math.abs(a.costDelta)).slice(0, n);
}

export interface Saturation {
  /** Share of traffic scoring above the top boundary (no resolution zone). */
  shareAboveTop: number;
  /** Median distance from traffic mass to the top boundary (0 = saturated). */
  medianDistanceToTop: number;
}

export function saturation(rows: FitRow[], boundaries: number[]): Saturation {
  const top = boundaries[boundaries.length - 1];
  const above = rows.filter((r) => r.score > top);
  const dists = rows.map((r) => Math.max(0, r.score - top)).sort((a, b) => a - b);
  return {
    shareAboveTop: rows.length ? above.length / rows.length : 0,
    medianDistanceToTop: dists.length ? dists[~~(dists.length / 2)] : 0,
  };
}
