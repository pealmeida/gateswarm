import type { ComplexityResult, EffortLevel } from 'gateswarm-lite';

export interface ModelSpec {
  /** Model identifier, e.g. "gpt-5-mini". */
  id: string;
  /** Provider identifier, e.g. "openai". */
  provider: string;
  /** Highest effort tier this model handles reliably. */
  maxEffort: EffortLevel;
  /** USD per 1M input tokens. */
  costPer1MInput: number;
  /** USD per 1M output tokens. */
  costPer1MOutput: number;
  /** Relative quality estimate in (0, 1]. */
  quality: number;
  avgLatencyMs?: number;
  tags?: string[];
}

export type RoutingStrategy = 'cheapest-capable' | 'best-value';

export interface RouteOptions {
  /** Default: 'cheapest-capable'. */
  strategy?: RoutingStrategy;
  /** Default: DEFAULT_MATRIX. */
  matrix?: ModelSpec[];
  /** Exclude models below this quality. Default: 0. */
  minQuality?: number;
}

export interface RouteDecision {
  model: ModelSpec;
  /** Up to 3 next-best capable models, ranked. */
  alternatives: ModelSpec[];
  complexity: ComplexityResult;
  strategy: RoutingStrategy;
  reason: string;
}
