/**
 * GateSwarm MoA Router v0.4 — Configuration Manager
 *
 * Centralized config for ensemble weights, tier models,
 * reasoning toggles, feedback loop, and RAG settings.
 * User-configurable via /gateswarm CLI commands.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { EffortLevel } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, '../v04_config.json');

// ─── Types ───────────────────────────────────────────────

export interface FallbackModel {
  model: string;
  provider: string;
}

export interface TierModelConfig {
  model: string;
  provider: string;
  max_tokens: number;
  enable_thinking: boolean;
  fallback_models?: FallbackModel[];  // Ordered fallback chain when primary is rate-limited
}

export interface EnsembleWeightsConfig {
  heuristic: number;
  cascade: number;
  ragSignal: number;
  historyBias: number;
}

export interface FeedbackLoopConfig {
  retrainAfterInteractions: number;  // default 500
  minSamplesPerTier: number;
  maxWeightChangePct: number;
  llmJudgeModel: string;
  llmJudgeSamplingRate: number;
  cascadeRetraining: boolean;
  cascadeRetrainingSource: 'real_feedback_labels' | 'formula_labels';
  abTestHoldoutPct: number;
}

export interface RagConfig {
  inMemory: boolean;
  sqlite: boolean;
  maxEntries: number;
  ttlMs: number;
  queryMaxResults: number;
}

export interface V04Config {
  version: string;
  trained: string;
  method: string;
  ensemble: {
    weights: EnsembleWeightsConfig;
    confidenceThresholds: { high: number; low: number };
    lowConfidenceAction: string;
  };
  scoring: {
    formula: string;
    signal_types: number;
    feature_count: number;
    signals: string[];
  };
  tier_boundaries: Record<EffortLevel, [number, number]>;
  tier_models: Record<EffortLevel, TierModelConfig>;
  feedback_loop: FeedbackLoopConfig;
  rag: RagConfig;
}

// ─── Default Config ──────────────────────────────────────

export const DEFAULT_V04_CONFIG: V04Config = {
  version: 'v0.4.4-context-aware',
  trained: new Date().toISOString(),
  method: 'ensemble-voter-with-feedback-loop',
  ensemble: {
    weights: { heuristic: 0.55, cascade: 0.00, ragSignal: 0.25, historyBias: 0.20 },
    confidenceThresholds: { high: 0.8, low: 0.5 },
    lowConfidenceAction: 'escalateOneTier',
  },
  scoring: {
    formula: 'signals * 0.15 + log1p(word_count) * 0.08 + has_context * 0.1',
    signal_types: 9,
    feature_count: 25,
    signals: [
      'question mark', 'code keywords', 'imperative verbs',
      'arithmetic operators', 'sequential markers', 'constraint words',
      'context markers', 'architecture keywords', 'design keywords',
    ],
  },
  tier_boundaries: {
    trivial: [0.00, 0.1557],
    light: [0.1557, 0.1842],
    moderate: [0.1842, 0.2788],
    heavy: [0.2788, 0.3488],
    intensive: [0.3488, 0.4611],
    extreme: [0.4611, 1.00],
  },
  tier_models: {
    trivial:   { model: 'glm-4.5-air',    provider: 'zai',     max_tokens: 256,  enable_thinking: false,
                 fallback_models: [{ model: 'glm-4.7-flash', provider: 'zai' }, { model: 'glm-4.7', provider: 'zai' }, { model: 'kimi-k2.5', provider: 'bailian' }] },
    light:     { model: 'glm-4.7-flash',   provider: 'zai',     max_tokens: 512,  enable_thinking: false,
                 fallback_models: [{ model: 'glm-4.7', provider: 'zai' }, { model: 'glm-4.5-air', provider: 'zai' }, { model: 'MiniMax-M2.5', provider: 'bailian' }] },
    moderate:  { model: 'MiniMax-M2.5',    provider: 'bailian', max_tokens: 2048, enable_thinking: false,
                 fallback_models: [{ model: 'qwen3.5-plus', provider: 'bailian' }, { model: 'kimi-k2.5', provider: 'bailian' }, { model: 'glm-4.7-flash', provider: 'zai' }] },
    heavy:     { model: 'qwen3.5-plus',    provider: 'bailian', max_tokens: 4096, enable_thinking: true,
                 fallback_models: [{ model: 'qwen3.6-plus', provider: 'bailian' }, { model: 'MiniMax-M2.5', provider: 'bailian' }, { model: 'glm-4.7-flash', provider: 'zai' }, { model: 'glm-4.7', provider: 'zai' }] },
    intensive: { model: 'qwen3.5-plus',    provider: 'bailian', max_tokens: 4096, enable_thinking: true,
                 fallback_models: [{ model: 'qwen3.6-plus', provider: 'bailian' }, { model: 'kimi-k2.5', provider: 'bailian' }, { model: 'MiniMax-M2.5', provider: 'bailian' }] },
    extreme:   { model: 'qwen3.6-plus',    provider: 'bailian', max_tokens: 8192, enable_thinking: true,
                 fallback_models: [{ model: 'qwen3.6-max-preview', provider: 'bailian' }, { model: 'qwen3.5-plus', provider: 'bailian' }, { model: 'kimi-k2.5', provider: 'bailian' }] },
  },
  feedback_loop: {
    retrainAfterInteractions: 500,
    minSamplesPerTier: 50,
    maxWeightChangePct: 0.20,
    llmJudgeModel: 'bailian/qwen3.5-plus',
    llmJudgeSamplingRate: 0.10,
    cascadeRetraining: true,
    cascadeRetrainingSource: 'real_feedback_labels',
    abTestHoldoutPct: 0.10,
  },
  rag: {
    inMemory: true,
    sqlite: true,
    maxEntries: 10000,
    ttlMs: 86400000,
    queryMaxResults: 3,
  },
};

// ─── Singleton ───────────────────────────────────────────

let _config: V04Config | null = null;
let _configLoadedAt = 0;
const CONFIG_RELOAD_MS = 5000; // Hot-reload every 5s

export async function loadConfig(): Promise<V04Config> {
  const now = Date.now();
  if (_config && (now - _configLoadedAt) < CONFIG_RELOAD_MS) return _config;
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    _config = JSON.parse(raw) as V04Config;
    _configLoadedAt = now;
  } catch {
    if (!_config) _config = DEFAULT_V04_CONFIG;
    _configLoadedAt = now;
  }
  return _config;
}

export function getConfig(): V04Config {
  // Trigger async reload if stale (non-blocking; returns current)
  if (!_config || (Date.now() - _configLoadedAt) >= CONFIG_RELOAD_MS) {
    loadConfig().catch(() => {});
  }
  if (!_config) return DEFAULT_V04_CONFIG;
  return _config;
}

export async function saveConfig(config?: V04Config): Promise<void> {
  if (config) _config = config;
  await fs.writeFile(CONFIG_FILE, JSON.stringify(getConfig(), null, 2), 'utf-8');
}

// ─── Tier Model Commands ─────────────────────────────────

export function setTierModel(tier: EffortLevel, model: string, provider: string): void {
  const cfg = getConfig();
  if (cfg.tier_models[tier]) {
    cfg.tier_models[tier].model = model;
    cfg.tier_models[tier].provider = provider;
  }
}

export function setTierThinking(tier: EffortLevel, enabled: boolean): void {
  const cfg = getConfig();
  if (cfg.tier_models[tier]) {
    cfg.tier_models[tier].enable_thinking = enabled;
  }
}

export function setRetrainFrequency(interactions: number): void {
  const cfg = getConfig();
  cfg.feedback_loop.retrainAfterInteractions = Math.max(50, interactions);
}

export function setEnsembleWeights(weights: Partial<EnsembleWeightsConfig>): void {
  const cfg = getConfig();
  cfg.ensemble.weights = { ...cfg.ensemble.weights, ...weights };
}

export function getTierModel(tier: EffortLevel): TierModelConfig | null {
  return getConfig().tier_models[tier] ?? null;
}

export function getAllTierModels(): Record<EffortLevel, TierModelConfig> {
  return getConfig().tier_models;
}

export function getReasoningStatus(): Record<EffortLevel, boolean> {
  const cfg = getConfig();
  const result = {} as Record<EffortLevel, boolean>;
  for (const tier of Object.keys(cfg.tier_models) as EffortLevel[]) {
    result[tier] = cfg.tier_models[tier].enable_thinking;
  }
  return result;
}
