/**
 * OpenRouter Pricing — Single Source of Truth for Cost Evaluation
 *
 * GateSwarm executes across many providers (Z.AI, Bailian, OpenCodeGo, Ollama,
 * and the official CLIs). Their real billing models differ wildly: some are free
 * tiers, some are flat subscriptions (the CLI agents), some are per-token. To
 * compare routing decisions on a single, honest yardstick we price every request
 * at OpenRouter list prices for the *equivalent* model — regardless of which
 * provider actually served it.
 *
 * This module is the one place that knows:
 *   1. OpenRouter list prices (per 1M tokens, USD) — OPENROUTER_PRICING.
 *   2. How each routable provider/model maps to its OpenRouter equivalent —
 *      PROVIDER_MODEL_EQUIVALENTS.
 *
 * Everything that needs a cost number (benchmark logger, model matrix) resolves
 * through here so there is a single, auditable pricing authority.
 *
 * NOTE: execution still happens on the multi-provider stack; OpenRouter is the
 * cost reference, not the dispatch path.
 */

export interface TokenPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

/**
 * OpenRouter list prices, USD per 1M tokens, keyed by OpenRouter model ID.
 *
 * The `:free` and `owl-alpha` rows, and the bare (un-prefixed) provider IDs
 * below them, are the historical benchmark-logger keys — kept verbatim so logs
 * that record OpenRouter IDs directly continue to price identically.
 */
export const OPENROUTER_PRICING: Record<string, TokenPrice> = {
  // ── Free tier ──
  'openrouter/owl-alpha': { input: 0, output: 0 },
  'minimax/minimax-m2.5:free': { input: 0, output: 0 },
  'qwen/qwen3-coder:free': { input: 0, output: 0 },
  'z-ai/glm-4.5-air:free': { input: 0, output: 0 },
  'meta-llama/llama-3.3-70b-instruct:free': { input: 0, output: 0 },

  // ── Light / flash ──
  'z-ai/glm-4.5-air': { input: 0.05, output: 0.30 },
  'z-ai/glm-4.7-flash': { input: 0.06, output: 0.40 },
  'z-ai/glm-4.7': { input: 0.10, output: 0.55 },
  'google/gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'google/gemma-3-12b': { input: 0.05, output: 0.10 },
  'deepseek/deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'xiaomi/mimo-v2.5': { input: 0.10, output: 0.40 },

  // ── Standard ──
  'qwen/qwen-plus': { input: 0.26, output: 0.78 },
  'qwen/qwen3.5-plus-02-15': { input: 0.26, output: 1.56 },
  'qwen/qwen3-coder': { input: 0.30, output: 1.20 },
  'qwen/qwen-vl-max': { input: 0.30, output: 1.20 },
  'minimax/minimax-m2.5': { input: 0.15, output: 1.15 },
  'minimax/minimax-m3': { input: 0.30, output: 1.50 },
  'moonshotai/kimi-k2.5': { input: 0.30, output: 1.20 },
  'moonshotai/kimi-k2.6': { input: 0.40, output: 1.60 },
  'z-ai/glm-5-turbo': { input: 0.20, output: 0.90 },
  'z-ai/glm-5': { input: 0.30, output: 1.20 },
  'google/gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'xiaomi/mimo-v2.5-pro': { input: 0.20, output: 0.80 },

  // ── Quality ──
  'z-ai/glm-5.1': { input: 0.40, output: 1.60 },
  'deepseek/deepseek-v4-pro': { input: 0.50, output: 2.00 },
  'qwen/qwen-max': { input: 1.60, output: 6.40 },
  'anthropic/claude-haiku-4.5': { input: 1.00, output: 5.00 },
  'openai/o4-mini': { input: 1.10, output: 4.40 },
  'openai/gpt-4.1': { input: 2.00, output: 8.00 },
  'anthropic/claude-sonnet-4.6': { input: 3.00, output: 15.00 },
  'openai/gpt-5.3': { input: 3.00, output: 18.00 },

  // ── Elite ──
  'openai/gpt-5.4': { input: 4.00, output: 24.00 },
  'openai/gpt-5.5': { input: 5.00, output: 30.00 },
  'anthropic/claude-opus-4.6': { input: 5.00, output: 25.00 },
  'anthropic/claude-opus-4.7': { input: 5.00, output: 25.00 },
  'anthropic/claude-opus-4.8': { input: 5.00, output: 25.00 },
};

/**
 * Maps a normalized GateSwarm model token to its OpenRouter equivalent ID.
 * Keyed by the bare model name (lowercased, with CLI/provider prefixes stripped
 * by normalizeModelToken). Where GateSwarm routes to a model OpenRouter doesn't
 * list 1:1, we point at the nearest equivalent (documented inline).
 */
export const PROVIDER_MODEL_EQUIVALENTS: Record<string, string> = {
  // Z.AI GLM family
  'glm-4.5-air': 'z-ai/glm-4.5-air',
  'glm-4.7': 'z-ai/glm-4.7',
  'glm-4.7-flash': 'z-ai/glm-4.7-flash',
  'glm-5': 'z-ai/glm-5',
  'glm-5-turbo': 'z-ai/glm-5-turbo',
  'glm-5.1': 'z-ai/glm-5.1',

  // Alibaba Qwen (Bailian / OpenCodeGo)
  'qwen3.5-plus': 'qwen/qwen3.5-plus-02-15',
  'qwen3.6-plus': 'qwen/qwen-plus',
  'qwen3.7-plus': 'qwen/qwen-plus',
  'qwen3-coder-plus': 'qwen/qwen3-coder',
  'qwen3.6-max-preview': 'qwen/qwen-max',
  'qwen3.7-max': 'qwen/qwen-max',
  'qwen4.6': 'qwen/qwen-max',
  'qwen3-vl:235b': 'qwen/qwen-vl-max',

  // MiniMax — OpenRouter lists m2.5; m2.7 priced at its nearest neighbour.
  'minimax-m2.5': 'minimax/minimax-m2.5',
  'minimax-m2.7': 'minimax/minimax-m2.5',
  'minimax-m3': 'minimax/minimax-m3',

  // Moonshot Kimi
  'kimi-k2.5': 'moonshotai/kimi-k2.5',
  'kimi-k2.6': 'moonshotai/kimi-k2.6',

  // DeepSeek
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',

  // Google Gemma
  'gemma3:12b': 'google/gemma-3-12b',

  // Xiaomi MiMo
  'mimo-v2.5': 'xiaomi/mimo-v2.5',
  'mimo-v2.5-pro': 'xiaomi/mimo-v2.5-pro',

  // Anthropic (Claude Code CLI) — cc/ models alias to OpenRouter anthropic IDs.
  'claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6',
  'claude-haiku-4-5': 'anthropic/claude-haiku-4.5',
  'claude-opus-4-7': 'anthropic/claude-opus-4.7',
  'claude-opus-4-8': 'anthropic/claude-opus-4.8',

  // OpenAI (Codex CLI) — cx/ models alias to OpenRouter openai IDs.
  'gpt-5.5-codex': 'openai/gpt-5.5',
  'gpt-5.4-codex': 'openai/gpt-5.4',
  'gpt-5.3-codex': 'openai/gpt-5.3',
  'gpt-4.1': 'openai/gpt-4.1',

  // OpenRouter house model
  'owl-alpha': 'openrouter/owl-alpha',
};

/** Baseline model for savings comparison (most expensive elite tier). */
export const BASELINE_MODEL = 'anthropic/claude-opus-4.6';

/**
 * Reduce a routed model string to a bare, comparable token: lowercase, with
 * CLI-agent prefixes (cc/, cx/, pi/, hm/, oc/) and provider prefixes
 * (openrouter/, bailian/, zai/, …) removed. "cc/claude-opus-4-8" → "claude-opus-4-8".
 */
export function normalizeModelToken(model: string): string {
  let m = model.toLowerCase().trim();
  m = m.replace(/^(cc|cx|pi|hm|oc)\//, '');
  // strip up to two provider prefixes (handles oc/bailian/<model> style)
  m = m.replace(/^(openrouter|bailian|zai|opencodego|ollama-cloud|ollama)\//, '');
  m = m.replace(/^(openrouter|bailian|zai|opencodego|ollama-cloud|ollama)\//, '');
  return m;
}

/**
 * Resolve a routed (model, provider) to a canonical OpenRouter pricing key, or
 * null when there is no equivalent (e.g. tiny local-only models that incur no
 * OpenRouter-comparable cost).
 */
export function resolveOpenRouterId(model: string | undefined, _provider?: string): string | null {
  if (!model) return null;

  // 1. Already a known OpenRouter ID.
  if (OPENROUTER_PRICING[model]) return model;

  // 2. benchmark-logger style: "openrouter/<id>" or a bare id that gains the prefix.
  if (model.startsWith('openrouter/')) {
    const stripped = model.slice('openrouter/'.length);
    if (OPENROUTER_PRICING[stripped]) return stripped;
  } else if (OPENROUTER_PRICING['openrouter/' + model]) {
    return 'openrouter/' + model;
  }

  // 3. Equivalence by normalized model token.
  const token = normalizeModelToken(model);
  if (OPENROUTER_PRICING[token]) return token;
  const eq = PROVIDER_MODEL_EQUIVALENTS[token];
  if (eq) return eq;

  return null;
}

/** Look up OpenRouter list price (per 1M tokens) for an OpenRouter ID. */
export function getOpenRouterPricing(orId: string): TokenPrice | null {
  return OPENROUTER_PRICING[orId] ?? null;
}

/**
 * Cost in USD of a request at OpenRouter rates for the equivalent model.
 * Returns 0 when the model has no OpenRouter equivalent (treated as free).
 */
export function priceUsd(
  model: string | undefined,
  provider: string | undefined,
  tokensIn: number,
  tokensOut: number,
): number {
  const orId = resolveOpenRouterId(model, provider);
  if (!orId) return 0;
  const p = OPENROUTER_PRICING[orId];
  if (!p) return 0;
  return (tokensIn / 1_000_000) * p.input + (tokensOut / 1_000_000) * p.output;
}

/**
 * Per-1K-token USD cost for a routed (model, provider), in the shape the Model
 * Matrix stores (costPer1kInput / costPer1kOutput). Zero when no equivalent.
 */
export function costPer1kUsd(
  model: string | undefined,
  provider?: string,
): { input: number; output: number } {
  const orId = resolveOpenRouterId(model, provider);
  const p = orId ? OPENROUTER_PRICING[orId] : null;
  if (!p) return { input: 0, output: 0 };
  return { input: p.input / 1000, output: p.output / 1000 };
}
