/**
 * GateSwarm MoMA Router v0.6.2 — Configuration Manager
 * MoMA = Mixture of Multimodal Agents
 *
 * Centralized config for ensemble weights, tier models,
 * reasoning toggles, feedback loop, RAG settings, and multimodal data sources.
 * User-configurable via /gateswarm CLI commands.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { EffortLevel, IntentMode } from './types.js';
import type { EffortProfile } from './agent-registry.js';

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
  fallback_models?: FallbackModel[];
  /** v0.6: Plan-mode model (lighter/faster for exploration tasks) */
  plan_model?: string;
  plan_provider?: string;
  plan_max_tokens?: number;
  plan_enable_thinking?: boolean;
  /** v0.6.2: Multimodal data source capabilities per tier */
  data_sources?: {
    supported: ('text' | 'image' | 'video' | 'audio')[];
    max_images?: number;
    max_video_seconds?: number;
    max_audio_seconds?: number;
    can_output_image?: boolean;
  };
}

export interface EnsembleWeightsConfig {
  heuristic: number;
  cascade: number;
  ragSignal: number;
  historyBias: number;
}

export interface FeedbackLoopConfig {
  retrainAfterInteractions: number;
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
  version: 'v0.6.2-auto-fallback',
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
                 fallback_models: [{ model: 'glm-4.7-flash', provider: 'zai' }, { model: 'glm-4.7', provider: 'zai' }, { model: 'kimi-k2.5', provider: 'bailian' }],
                 plan_model: 'glm-4.5-air', plan_provider: 'zai', plan_max_tokens: 128, plan_enable_thinking: false,
                 data_sources: { supported: ['text'] } },
    light:     { model: 'glm-4.7-flash',   provider: 'zai',     max_tokens: 512,  enable_thinking: false,
                 fallback_models: [{ model: 'glm-4.7', provider: 'zai' }, { model: 'glm-4.5-air', provider: 'zai' }, { model: 'MiniMax-M2.5', provider: 'bailian' }],
                 plan_model: 'glm-4.5-air', plan_provider: 'zai', plan_max_tokens: 256, plan_enable_thinking: false,
                 data_sources: { supported: ['text'] } },
    moderate:  { model: 'MiniMax-M2.5',    provider: 'bailian', max_tokens: 2048, enable_thinking: false,
                 fallback_models: [{ model: 'qwen3.5-plus', provider: 'bailian' }, { model: 'kimi-k2.5', provider: 'bailian' }, { model: 'glm-4.7-flash', provider: 'zai' }],
                 plan_model: 'glm-4.7-flash', plan_provider: 'zai', plan_max_tokens: 512, plan_enable_thinking: false,
                 data_sources: { supported: ['text'] } },
    heavy:     { model: 'qwen3.5-plus',    provider: 'bailian', max_tokens: 4096, enable_thinking: true,
                 fallback_models: [{ model: 'qwen3.6-plus', provider: 'bailian' }, { model: 'MiniMax-M2.5', provider: 'bailian' }, { model: 'glm-4.7-flash', provider: 'zai' }, { model: 'glm-4.7', provider: 'zai' }, { model: 'cc/claude-sonnet-4-6', provider: 'claude-cli' }],
                 plan_model: 'MiniMax-M2.5', plan_provider: 'bailian', plan_max_tokens: 1024, plan_enable_thinking: false,
                 data_sources: { supported: ['text', 'image'] } },
    intensive: { model: 'qwen3.5-plus',    provider: 'bailian', max_tokens: 4096, enable_thinking: true,
                 fallback_models: [{ model: 'qwen3.6-plus', provider: 'bailian' }, { model: 'kimi-k2.5', provider: 'bailian' }, { model: 'MiniMax-M2.5', provider: 'bailian' }, { model: 'cc/claude-sonnet-4-6', provider: 'claude-cli' }, { model: 'cx/gpt-5.3-codex', provider: 'codex-cli' }],
                 plan_model: 'MiniMax-M2.5', plan_provider: 'bailian', plan_max_tokens: 1024, plan_enable_thinking: false,
                 data_sources: { supported: ['text', 'image'] } },
    extreme:   { model: 'qwen3.6-plus',    provider: 'bailian', max_tokens: 8192, enable_thinking: true,
                 fallback_models: [{ model: 'qwen3.6-max-preview', provider: 'bailian' }, { model: 'qwen3.5-plus', provider: 'bailian' }, { model: 'kimi-k2.5', provider: 'bailian' }, { model: 'cc/claude-opus-4-7', provider: 'claude-cli' }],
                 plan_model: 'qwen3.5-plus', plan_provider: 'bailian', plan_max_tokens: 2048, plan_enable_thinking: false,
                 data_sources: { supported: ['text', 'image', 'video', 'audio'] } },
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
const CONFIG_RELOAD_MS = 5000;

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

// ─── v0.5: CLI Providers Feature Toggle ─────────────────────

export interface CliProvidersConfig {
  enabled: boolean;
  activeProviders?: string[];
}

export function getCliProvidersEnabled(): boolean {
  const cfg = getConfig() as any;
  if (cfg.cliProviders) {
    return cfg.cliProviders.enabled !== false;
  }
  return true;
}

export function getCliProvidersConfig(): CliProvidersConfig {
  const cfg = getConfig() as any;
  return cfg.cliProviders ?? { enabled: true };
}

// ─── v0.6: Plan/Act Mode Config ─────────────────────

export function getTierModelForMode(effort: EffortLevel, mode: IntentMode): TierModelConfig | null {
  const cfg = getConfig();
  const tier = cfg.tier_models[effort];
  if (!tier) return null;
  if (mode === 'plan' && tier.plan_model) {
    return {
      model: tier.plan_model,
      provider: tier.plan_provider || tier.provider,
      max_tokens: tier.plan_max_tokens || tier.max_tokens,
      enable_thinking: tier.plan_enable_thinking ?? false,
      fallback_models: tier.fallback_models,
      data_sources: tier.data_sources,
    };
  }
  return tier;
}

/** Detect plan vs act mode from prompt text */
export function detectIntentMode(promptText: string): { mode: IntentMode; confidence: number; planScore: number; actScore: number } {
  const planKeywords = ['draft', 'outline', 'brainstorm', 'sketch', 'explore', 'what if', 'options', 'approach', 'consider', 'tradeoff', 'strategy', 'roadmap', 'plan', 'design', 'compare', 'pros and cons'];
  const actKeywords = ['implement', 'build', 'code', 'fix', 'deploy', 'run', 'test', 'apply', 'merge', 'write the code', 'create the file'];
  const lower = promptText.toLowerCase();
  let planScore = 0, actScore = 0;
  for (const kw of planKeywords) { if (lower.includes(kw)) planScore++; }
  for (const kw of actKeywords) { if (lower.includes(kw)) actScore++; }
  const maxScore = Math.max(planScore, actScore);
  if (maxScore === 0) return { mode: 'auto', confidence: 0, planScore: 0, actScore: 0 };
  const confidence = Math.min(maxScore / 3, 1);
  return { mode: planScore > actScore ? 'plan' : actScore > planScore ? 'act' : 'auto', confidence, planScore, actScore };
}

// ─── v0.6: Effort Profile Commands ─────────────────────

export function setAgentEffortProfile(agentId: string, profile: EffortProfile): void {
  const cfg = getConfig() as any;
  if (!cfg.agentEffortProfiles) cfg.agentEffortProfiles = {};
  cfg.agentEffortProfiles[agentId] = profile;
}

export function getAgentEffortProfile(agentId: string): EffortProfile | null {
  const cfg = getConfig() as any;
  return cfg.agentEffortProfiles?.[agentId] ?? null;
}

export function getAllEffortProfiles(): Record<string, EffortProfile> {
  const cfg = getConfig() as any;
  return cfg.agentEffortProfiles ?? {};
}

function scoreToEffortLevel(score: number): EffortLevel {
  const cfg = getConfig();
  for (const [tier, [low, high]] of Object.entries(cfg.tier_boundaries)) {
    if (score >= low && score < high) return tier as EffortLevel;
  }
  return 'extreme';
}

export function applyEffortProfile(effort: EffortLevel, score: number, agentId: string): { effort: EffortLevel; score: number; reason: string } {
  const profile = getAgentEffortProfile(agentId);
  if (!profile) return { effort, score, reason: 'no profile' };

  let adjustedScore = score;
  const reasons: string[] = [];

  if (profile.bias && profile.bias !== 0) {
    adjustedScore = Math.max(0, Math.min(1, score + (profile.bias || 0)));
    reasons.push(`bias ${profile.bias > 0 ? '-' : '+'}${Math.abs(profile.bias * 100).toFixed(0)}`);
  }

  let adjustedEffort = scoreToEffortLevel(adjustedScore);

  if (profile.default) {
    const tierOrder: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    const floorIdx = tierOrder.indexOf(profile.default);
    const effortIdx = tierOrder.indexOf(adjustedEffort);
    if (floorIdx > effortIdx) {
      adjustedEffort = profile.default;
      reasons.push(`floor→${profile.default}`);
    }
  }

  if (profile.ceiling) {
    const tierOrder: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    const ceilIdx = tierOrder.indexOf(profile.ceiling);
    const effortIdx = tierOrder.indexOf(adjustedEffort);
    if (ceilIdx < effortIdx) {
      adjustedEffort = profile.ceiling;
      reasons.push(`ceiling→${profile.ceiling}`);
    }
  }

  return { effort: adjustedEffort, score: adjustedScore, reason: reasons.join(', ') || 'no adjustment needed' };
}
