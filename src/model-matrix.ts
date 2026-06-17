/**
 * Model Matrix v0.5.4 — Token Consumption Intelligence
 *
 * Central registry of ALL known models across ALL providers.
 * Acts as the single source of truth for model metadata, availability,
 * token usage, cost estimates, and tier assignments.
 *
 * Persisted to data/model-matrix.json for durability across restarts.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MATRIX_FILE = join(__dirname, '../data/model-matrix.json');

// ─── Types ───────────────────────────────────────────────

export type EffortLevel = 'trivial' | 'light' | 'moderate' | 'heavy' | 'intensive' | 'extreme';

export interface ModelEntry {
  /** Fully qualified model ID (provider-specific) */
  id: string;
  /** Provider ID */
  provider: string;
  /** Human-readable name */
  name: string;
  /** Context window size */
  contextWindow: number;
  /** Maximum output tokens */
  maxTokens: number;
  /** Input modalities supported */
  inputModalities: string[];
  /** Supports reasoning/thinking mode */
  supportsReasoning: boolean;
  /** Supports vision/image input */
  supportsVision: boolean;
  /** Supports tool/function calling */
  supportsTools: boolean;
  /** Current availability status */
  available: boolean;
  /** Timestamp of last availability check */
  lastChecked: number;
  /** Last successful response latency in ms */
  latencyMs: number;
  /** Rolling average latency (weighted) */
  avgLatencyMs: number;
  /** Estimated cost per 1K input tokens (USD) — 0 for free */
  costPer1kInput: number;
  /** Estimated cost per 1K output tokens (USD) */
  costPer1kOutput: number;
  /** Total input tokens consumed */
  totalTokensIn: number;
  /** Total output tokens consumed */
  totalTokensOut: number;
  /** Total successful requests */
  totalRequests: number;
  /** Total errors */
  errorCount: number;
  /** Consecutive failures (resets on success) */
  consecutiveFailures: number;
  /** Last error message */
  lastError: string | null;
  /** Recommended tier based on capability analysis */
  recommendedTier: EffortLevel;
  /** When this entry was last updated */
  updatedAt: number;
}

export interface ProviderSummary {
  provider: string;
  name: string;
  totalModels: number;
  availableModels: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalRequests: number;
  totalErrors: number;
  avgLatencyMs: number;
  rateLimitHits: number;
}

export interface ModelMatrixState {
  version: string;
  updatedAt: number;
  models: Record<string, ModelEntry>;
  providers: Record<string, ProviderSummary>;
}

// ─── Tier scoring ───────────────────────────────────────

const TIER_ORDER: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

/**
 * Score model into an appropriate tier.
 * v0.5.4 tuned: Param-size-based primary scoring with modest bonuses.
 * Target distribution across 412 models: ~15% per tier.
 */
export function scoreModelForTier(model: ModelEntry): { tier: EffortLevel; score: number } {
  const id = model.id.toLowerCase();
  let params = 7;

  // ── Explicit size extraction ──
  const bMatch = id.match(/(\d+\.?\d*)b(?:[-_]|\b|$)/);
  if (bMatch) {
    params = parseFloat(bMatch[1]);
  } else {
    const unitMatch = id.match(/(\d+\.?\d*)([bmk])\b/);
    if (unitMatch) {
      const num = parseFloat(unitMatch[1]);
      const unit = unitMatch[2];
      if (unit === 'b') params = num;
      else if (unit === 'm') params = num / 1000;
      else if (unit === 'k') params = num / 1000000;
    }
  }

  // ── Comprehensive model family overrides ──
  // Order matters: more specific first

  // OpenAI
  if (id.includes('gpt-4-turbo')) params = 1760;
  else if (id.includes('gpt-4o')) params = 200;
  else if (id.includes('gpt-5.3-codex')) params = 300;
  else if (id.includes('gpt-5.2-chat')) params = 200;
  else if (id.includes('gpt-5-nano')) params = 8;
  else if (id.includes('gpt-5-micro')) params = 14;
  else if (id.includes('gpt-5-mini')) params = 30;
  else if (id.includes('gpt-5.1')) params = 200;
  else if (id.includes('gpt-5')) params = 200;
  else if (id.includes('gpt-4')) params = 1760;

  // Anthropic
  else if (id.includes('claude-opus')) params = 175;
  else if (id.includes('claude-sonnet')) params = 175;
  else if (id.includes('claude-haiku')) params = 20;
  else if (id.includes('claude-fable')) params = 20;
  else if (id.includes('claude-3.5')) params = 175;
  else if (id.includes('claude-3')) params = 175;

  // Google
  else if (id.includes('gemma-3-4b')) params = 4;
  else if (id.includes('gemma-3-12b')) params = 12;
  else if (id.includes('gemma-3-27b')) params = 27;
  else if (id.includes('gemma-4-26b')) params = 26;
  else if (id.includes('gemma-4-31b')) params = 31;
  else if (id.includes('gemini-1.5-pro')) params = 100;
  else if (id.includes('gemini-1.5-flash')) params = 20;
  else if (id.includes('gemini-2.0-flash')) params = 20;
  else if (id.includes('gemini-3-flash')) params = 12;
  else if (id.includes('gemini-3-pro')) params = 100;
  else if (id.includes('gemini-3.5-pro')) params = 150;
  else if (id.includes('lyria')) params = 12;

  // Meta
  else if (id.includes('llama-3.1-8b')) params = 8;
  else if (id.includes('llama-3.1-70b')) params = 70;
  else if (id.includes('llama-3.1-405b')) params = 405;
  else if (id.includes('llama-3.2-1b')) params = 1;
  else if (id.includes('llama-3.2-3b')) params = 3;
  else if (id.includes('llama-3.3-70b')) params = 70;
  else if (id.includes('llama-4')) params = 400;
  else if (id.includes('llama-guard-4-12b')) params = 12;
  else if (id.includes('llama-guard-3-8b')) params = 8;

  // Mistral
  else if (id.includes('mistral-7b')) params = 7;
  else if (id.includes('mistral-small')) params = 24;
  else if (id.includes('mistral-medium')) params = 70;
  else if (id.includes('mistral-large')) params = 123;
  else if (id.includes('mixtral-8x7b')) params = 56;
  else if (id.includes('mixtral-8x22b')) params = 176;
  else if (id.includes('codestral-22b')) params = 22;
  else if (id.includes('mathstral-7b')) params = 7;
  else if (id.includes('mistral-nemo')) params = 12;

  // Moonshot AI (Kimi) — various naming conventions
  else if (id.includes('kimi-k2.7')) params = 30;
  else if (id.includes('kimi-k2.6')) params = 15;
  else if (id.includes('kimi-k2.5')) params = 15;
  else if (id.includes('kimi-k2:1t')) params = 1000;
  else if (id.includes('kimi-k2-thinking')) params = 15;
  else if (id.includes('kimi-k2')) params = 15;

  // Qwen — handle dot and dash variants
  else if (id.includes('qwen2.5-0.5b')) params = 0.5;
  else if (id.includes('qwen2.5-1.5b')) params = 1.5;
  else if (id.includes('qwen2.5-7b')) params = 7;
  else if (id.includes('qwen2.5-14b')) params = 14;
  else if (id.includes('qwen2.5-32b')) params = 32;
  else if (id.includes('qwen2.5-72b')) params = 72;
  else if (id.includes('qwen3.6-plus')) params = 80;
  else if (id.includes('qwen3.6-max')) params = 80;
  else if (id.includes('qwen3.5')) params = 397;
  else if (id.includes('qwen3.7-plus')) params = 30;
  else if (id.includes('qwen3.7-max')) params = 30;
  else if (id.includes('qwen3-coder')) params = 480;
  else if (id.includes('qwen3-vl')) params = 235;
  else if (id.includes('qwen3-0.6b')) params = 0.6;
  else if (id.includes('qwen3-1.7b')) params = 1.7;
  else if (id.includes('qwen3-4b')) params = 4;
  else if (id.includes('qwen3-8b')) params = 8;
  else if (id.includes('qwen3-14b')) params = 14;
  else if (id.includes('qwen3-30b')) params = 30;
  else if (id.includes('qwen3-32b')) params = 32;
  else if (id.includes('qwen3-235b')) params = 235;
  else if (id.includes('qwen4')) params = 100;

  // GLM (ZAI)
  else if (id.includes('glm-4.6')) params = 9;
  else if (id.includes('glm-4.7')) params = 9;
  else if (id.includes('glm-5.1')) params = 32;
  else if (id.includes('glm-5') && !id.includes('glm-5.')) params = 32;
  else if (id.includes('glm-4') && !id.includes('glm-4.')) params = 9;

  // DeepSeek
  else if (id.includes('deepseek-v3.1')) params = 671;
  else if (id.includes('deepseek-v3.2')) params = 671;
  else if (id.includes('deepseek-v4-flash')) params = 236;
  else if (id.includes('deepseek-v4-pro')) params = 671;
  else if (id.includes('deepseek-r1')) params = 671;
  else if (id.includes('deepseek-chat')) params = 236;
  else if (id.includes('deepseek-coder')) params = 33;

  // Bailian Qwen
  else if (id.includes('qwen-coder')) params = 32;
  else if (id.includes('qwen-math')) params = 72;

  // MiniMax
  else if (id.includes('minimax-m2')) params = 8;
  else if (id.includes('minimax-m2.1')) params = 12;
  else if (id.includes('minimax-m2.5')) params = 24;
  else if (id.includes('minimax-m2.7')) params = 56;
  else if (id.includes('minimax-m3')) params = 32;
  else if (id.includes('minimax-text')) params = 32;

  // NVIDIA Nemotron
  else if (id.includes('nemotron-4')) params = 340;
  else if (id.includes('nemotron-3-ultra')) params = 675;
  else if (id.includes('nemotron-3-super')) params = 120;
  else if (id.includes('nemotron-3-nano')) params = 30;
  else if (id.includes('nemotron-3.5')) params = 675;
  else if (id.includes('nemotron')) params = 70;

  // Devstral
  else if (id.includes('devstral-small-2')) params = 24;
  else if (id.includes('devstral-2')) params = 123;

  // Cogito
  else if (id.includes('cogito-2.1')) params = 671;

  // Apple RNJ
  else if (id.includes('rnj-1')) params = 8;

  // Google Gemma (short form)
  else if (id.includes('gemma3:4b')) params = 4;
  else if (id.includes('gemma3:12b')) params = 12;
  else if (id.includes('gemma3:27b')) params = 27;
  else if (id.includes('gemma4:31b')) params = 31;

  // Ollama Cloud specials
  else if (id.includes('gpt-oss:20b')) params = 20;
  else if (id.includes('gpt-oss:120b')) params = 120;

  // xAI Grok
  else if (id.includes('grok-4')) params = 314; // Grok-4 ≈ 314B
  else if (id.includes('grok-3')) params = 200;
  else if (id.includes('grok-build')) params = 200;
  else if (id.includes('grok')) params = 200;

  // Stepfun
  else if (id.includes('step-3.7')) params = 30;
  else if (id.includes('step-3')) params = 30;


  // Microsoft / WizardLM / Phi
  else if (id.includes('wizardlm-2-8x22b')) params = 176;
  else if (id.includes('wizardlm-2-7b')) params = 7;
  else if (id.includes('phi-3')) params = 4;
  else if (id.includes('phi-4')) params = 14;

  // Cohere
  else if (id.includes('command-r7b')) params = 7;
  else if (id.includes('command-r-plus')) params = 104;
  else if (id.includes('command-r')) params = 35;
  else if (id.includes('command')) params = 35;
  else if (id.includes('aya-23')) params = 35;

  // Stability AI
  else if (id.includes('stablelm')) params = 3;

  // HuggingFace / Community
  else if (id.includes('falcon')) params = 40;
  else if (id.includes('mpt')) params = 7;
  else if (id.includes('dolly')) params = 12;
  else if (id.includes('pythia')) params = 12;
  else if (id.includes('redpajama')) params = 3;

  // Nous / OpenHermes
  else if (id.includes('openhermes')) params = 7;
  else if (id.includes('nous-hermes')) params = 70;

  // LMSYS / Vicuna / Alpaca
  else if (id.includes('vicuna')) params = 33;
  else if (id.includes('alpaca')) params = 7;

  // TII / Falcon
  else if (id.includes('falcon-7b')) params = 7;
  else if (id.includes('falcon-40b')) params = 40;
  else if (id.includes('falcon-180b')) params = 180;

  // Salesforce / CodeGen
  else if (id.includes('codegen')) params = 16;
  else if (id.includes('code_t5')) params = 16;

  // Replit / CodeLLaMA
  else if (id.includes('replit-code')) params = 3;

  // Snowflake / Arctic
  else if (id.includes('arctic')) params = 480;

  // Databricks / DBRX
  else if (id.includes('dbrx')) params = 132;

  // AI21 / Jamba
  else if (id.includes('jamba')) params = 52;
  else if (id.includes('j2')) params = 178;

  // Writer / Palmyra
  else if (id.includes('palmyra')) params = 70;

  // Inflection / Pi
  else if (id.includes('inflection')) params = 70;

  // BigCode / StarCoder
  else if (id.includes('starcoder')) params = 15;

  // EleutherAI / GPT-J / GPT-NeoX
  else if (id.includes('gpt-j')) params = 6;
  else if (id.includes('gpt-neox')) params = 20;

  // Together / RedPajama
  else if (id.includes('redpajama-incite')) params = 3;

  // Berkeley / Koala / Vicuna
  else if (id.includes('koala')) params = 13;

  // LAION / OpenAssistant
  else if (id.includes('oasst')) params = 12;

  // RWKV
  else if (id.includes('rwkv')) params = 14;

  // StripedHyena
  else if (id.includes('stripedhyena')) params = 7;

  // Deci / DeciLM
  else if (id.includes('decilm')) params = 7;

  // Orion / OrionStar
  else if (id.includes('orion')) params = 14;

  // BAAI / Aquila
  else if (id.includes('aquila')) params = 7;

  // 01.AI / Yi
  else if (id.includes('yi-6b')) params = 6;
  else if (id.includes('yi-34b')) params = 34;
  else if (id.includes('yi-9b')) params = 9;
  else if (id.includes('yi')) params = 34;

  // Baichuan
  else if (id.includes('baichuan-7b')) params = 7;
  else if (id.includes('baichuan-13b')) params = 13;

  // InternLM
  else if (id.includes('internlm-7b')) params = 7;
  else if (id.includes('internlm-20b')) params = 20;

  // ChatGLM
  else if (id.includes('chatglm2')) params = 6;
  else if (id.includes('chatglm3')) params = 6;
  else if (id.includes('chatglm')) params = 6;

  // Skywork
  else if (id.includes('skywork')) params = 13;

  // SenseNova
  else if (id.includes('sensenova')) params = 14;

  // OpenBuddy
  else if (id.includes('openbuddy')) params = 7;

  // TigerBot
  else if (id.includes('tigerbot')) params = 13;

  // Phoenix
  else if (id.includes('phoenix')) params = 7;

  // PolyLM
  else if (id.includes('polylm')) params = 13;

  // XGen
  else if (id.includes('xgen')) params = 7;

  // Mamba / State Space Models
  else if (id.includes('mamba')) params = 2;

  // JetMoE
  else if (id.includes('jetmoe')) params = 8;

  // MoE models (without explicit size)
  else if (id.includes('mixtral')) { /* already handled */ }
  else if (id.includes('moe') || id.includes('mixture')) params = 56;

  // OpenRouter specific
  else if (id.includes('fusion')) params = 100;
  else if (id.includes('owl')) params = 70;
  else if (id.includes('perceptron')) params = 7;
  else if (id.includes('ring-2.6')) params = 100;
  else if (id.includes('unslopnemo')) params = 12;
  else if (id.includes('saba')) params = 8;

  // Generic catch-alls for remaining unknown models
  else if (id.includes('latest')) params = 100; // "latest" typically means large
  else if (id.includes('preview')) params = 50; // preview models are usually medium-large
  else if (id.includes('build')) params = 100;

    // Generic size keywords (fallback, least specific)
  else if (id.includes('tiny')) params = 0.5;
  else if (id.includes('nano')) params = 8;
  else if (id.includes('micro')) params = 14;
  else if (id.includes('mini')) params = 30;
  else if (id.includes('small')) params = 7;
  else if (id.includes('medium')) params = 30;
  else if (id.includes('large')) params = 70;
  else if (id.includes('xl')) params = 100;
  else if (id.includes('xxl')) params = 200;

  // ── Direct param bucket assignment ──
  let tier: EffortLevel;
  let score: number;

  if (params <= 1) {
    tier = 'trivial';
    score = 10 + (1 - params) * 5;
  } else if (params <= 3) {
    tier = 'light';
    score = 20 + (3 - params) * 3;
  } else if (params <= 15) {
    tier = 'moderate';
    score = 30 + (15 - params);
  } else if (params <= 50) {
    tier = 'heavy';
    score = 40 + (50 - params) * 0.3;
  } else if (params <= 200) {
    tier = 'intensive';
    score = 50 + (200 - params) * 0.1;
  } else {
    tier = 'extreme';
    score = 65 + (params > 500 ? 10 : 0);
  }

  // ── Capability bonuses (0–8) ──
  if (model.supportsReasoning) score += 3;
  if (model.supportsVision) score += 2;
  if (model.supportsTools) score += 2;
  if (model.costPer1kInput === 0 && model.costPer1kOutput === 0) score += 1;

  // ── Context window promotion: large CW models get tier upgrade ──
  // A 1M CW model is fundamentally more capable than a 200K CW model
  if (model.contextWindow >= 1000000 && tier === 'heavy') tier = 'intensive';
  else if (model.contextWindow >= 500000 && tier === 'moderate') tier = 'heavy';

  // ── Health penalty ──
  if (model.consecutiveFailures >= 3) score -= 5;

  return { tier, score };
}

// ─── Model Matrix Class ─────────────────────────────────

class ModelMatrix {
  private state: ModelMatrixState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.state = {
      version: '0.5.4',
      updatedAt: Date.now(),
      models: {},
      providers: {},
    };
  }

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(MATRIX_FILE, 'utf-8');
      const saved = JSON.parse(raw) as ModelMatrixState;
      this.state = { ...this.state, ...saved };
      console.log(`📊 Model Matrix loaded: ${Object.keys(this.state.models).length} models from ${Object.keys(this.state.providers).length} providers`);
    } catch {
      console.log('📊 Model Matrix: starting fresh (no saved state)');
    }
  }

  // ─── Model CRUD ──────────────────────────────────────

  upsertModel(entry: Partial<ModelEntry> & { id: string; provider: string }): ModelEntry {
    const key = `${entry.provider}:${entry.id}`;
    const existing = this.state.models[key];

    const model: ModelEntry = {
      id: entry.id,
      provider: entry.provider,
      name: entry.name || entry.id,
      contextWindow: entry.contextWindow || existing?.contextWindow || 128000,
      maxTokens: entry.maxTokens || existing?.maxTokens || 4096,
      inputModalities: entry.inputModalities || existing?.inputModalities || ['text'],
      supportsReasoning: entry.supportsReasoning ?? existing?.supportsReasoning ?? false,
      supportsVision: entry.supportsVision ?? existing?.supportsVision ?? false,
      supportsTools: entry.supportsTools ?? existing?.supportsTools ?? false,
      available: entry.available ?? existing?.available ?? true,
      lastChecked: entry.lastChecked || Date.now(),
      latencyMs: entry.latencyMs ?? existing?.latencyMs ?? 0,
      avgLatencyMs: existing?.avgLatencyMs
        ? (existing.avgLatencyMs * 0.8 + (entry.latencyMs || existing.avgLatencyMs) * 0.2)
        : (entry.latencyMs || 0),
      costPer1kInput: entry.costPer1kInput ?? existing?.costPer1kInput ?? 0,
      costPer1kOutput: entry.costPer1kOutput ?? existing?.costPer1kOutput ?? 0,
      totalTokensIn: (existing?.totalTokensIn || 0) + (entry.totalTokensIn || 0),
      totalTokensOut: (existing?.totalTokensOut || 0) + (entry.totalTokensOut || 0),
      totalRequests: (existing?.totalRequests || 0) + (entry.totalRequests || 0),
      errorCount: (existing?.errorCount || 0) + (entry.errorCount || 0),
      consecutiveFailures: entry.available === false
        ? (existing?.consecutiveFailures || 0) + 1
        : 0,
      lastError: entry.lastError || existing?.lastError || null,
      recommendedTier: entry.recommendedTier || scoreModelForTier(entry as ModelEntry).tier,
      updatedAt: Date.now(),
    };

    this.state.models[key] = model;
    this.markDirty();
    return model;
  }

  getModel(provider: string, id: string): ModelEntry | undefined {
    return this.state.models[`${provider}:${id}`];
  }

  getAllModels(): ModelEntry[] {
    return Object.values(this.state.models);
  }

  getModelsByProvider(provider: string): ModelEntry[] {
    return Object.values(this.state.models).filter(m => m.provider === provider);
  }

  getAvailableModels(tier?: EffortLevel): ModelEntry[] {
    let models = Object.values(this.state.models).filter(m => m.available && m.consecutiveFailures < 3);
    if (tier) {
      models = models.filter(m => m.recommendedTier === tier);
    }
    return models;
  }

  getModelsForTier(tier: EffortLevel): ModelEntry[] {
    return this.getAvailableModels(tier).sort((a, b) => {
      // Sort by: availability > cost > latency > capability
      if (a.consecutiveFailures !== b.consecutiveFailures)
        return a.consecutiveFailures - b.consecutiveFailures;
      const aCost = a.costPer1kInput + a.costPer1kOutput;
      const bCost = b.costPer1kInput + b.costPer1kOutput;
      if (aCost !== bCost) return aCost - bCost;
      if (a.avgLatencyMs !== b.avgLatencyMs) return a.avgLatencyMs - b.avgLatencyMs;
      return (b.contextWindow + b.maxTokens) - (a.contextWindow + a.maxTokens);
    });
  }

  findBestModel(
    tier: EffortLevel,
    options?: { preferProvider?: string; excludeFailed?: boolean; maxCost?: number }
  ): ModelEntry | null {
    const candidates = this.getModelsForTier(tier).filter(m => {
      if (options?.excludeFailed && m.consecutiveFailures >= 3) return false;
      if (options?.maxCost && (m.costPer1kInput + m.costPer1kOutput) > options.maxCost) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    // Prefer specified provider if available
    if (options?.preferProvider) {
      const preferred = candidates.find(m => m.provider === options.preferProvider);
      if (preferred) return preferred;
    }

    return candidates[0]; // already sorted by cost/latency/capability
  }

  recordUsage(provider: string, modelId: string, tokensIn: number, tokensOut: number): void {
    const key = `${provider}:${modelId}`;
    const model = this.state.models[key];
    if (model) {
      model.totalTokensIn += tokensIn;
      model.totalTokensOut += tokensOut;
      model.totalRequests++;
      model.consecutiveFailures = 0;
      model.available = true;
      model.updatedAt = Date.now();
      this.markDirty();
    }
  }

  recordError(provider: string, modelId: string, error: string): void {
    const key = `${provider}:${modelId}`;
    const model = this.state.models[key];
    if (model) {
      model.errorCount++;
      model.consecutiveFailures++;
      model.lastError = error;
      if (model.consecutiveFailures >= 3) {
        model.available = false;
        console.log(`🚫 [ModelMatrix] ${provider}/${modelId} marked UNAVAILABLE after ${model.consecutiveFailures} failures`);
      }
      model.updatedAt = Date.now();
      this.markDirty();
    }
  }

  recordLatency(provider: string, modelId: string, latencyMs: number): void {
    const key = `${provider}:${modelId}`;
    const model = this.state.models[key];
    if (model) {
      model.latencyMs = latencyMs;
      model.avgLatencyMs = model.avgLatencyMs > 0
        ? model.avgLatencyMs * 0.8 + latencyMs * 0.2
        : latencyMs;
      model.updatedAt = Date.now();
    }
  }

  // ─── Provider summaries ──────────────────────────────

  updateProviderSummary(providerId: string, name: string): void {
    const models = this.getModelsByProvider(providerId);
    this.state.providers[providerId] = {
      provider: providerId,
      name,
      totalModels: models.length,
      availableModels: models.filter(m => m.available).length,
      totalTokensIn: models.reduce((s, m) => s + m.totalTokensIn, 0),
      totalTokensOut: models.reduce((s, m) => s + m.totalTokensOut, 0),
      totalRequests: models.reduce((s, m) => s + m.totalRequests, 0),
      totalErrors: models.reduce((s, m) => s + m.errorCount, 0),
      avgLatencyMs: models.filter(m => m.avgLatencyMs > 0).reduce((s, m, _, a) => s + m.avgLatencyMs / a.length, 0) || 0,
      rateLimitHits: 0,
    };
    this.markDirty();
  }

  getProviderSummary(providerId: string): ProviderSummary | undefined {
    return this.state.providers[providerId];
  }

  getAllProviderSummaries(): ProviderSummary[] {
    return Object.values(this.state.providers);
  }

  // ─── Queries for routing and dashboards ──────────────

  getConsumptionStats() {
    const models = Object.values(this.state.models);
    const totalIn = models.reduce((s, m) => s + m.totalTokensIn, 0);
    const totalOut = models.reduce((s, m) => s + m.totalTokensOut, 0);
    const totalReq = models.reduce((s, m) => s + m.totalRequests, 0);
    const totalErrors = models.reduce((s, m) => s + m.errorCount, 0);
    const estimatedCost = models.reduce((s, m) =>
      s + (m.totalTokensIn * m.costPer1kInput + m.totalTokensOut * m.costPer1kOutput) / 1000, 0
    );

    return {
      totalModels: models.length,
      availableModels: models.filter(m => m.available).length,
      unhealthyModels: models.filter(m => m.consecutiveFailures >= 3).length,
      totalTokensIn: totalIn,
      totalTokensOut: totalOut,
      totalRequests: totalReq,
      totalErrors,
      errorRate: totalReq > 0 ? totalErrors / totalReq : 0,
      estimatedCost,
      providers: this.getAllProviderSummaries(),
    };
  }

  getTierDistribution(): Record<EffortLevel, number> {
    const dist: Record<EffortLevel, number> = {
      trivial: 0, light: 0, moderate: 0, heavy: 0, intensive: 0, extreme: 0,
    };
    for (const m of Object.values(this.state.models)) {
      if (m.available) dist[m.recommendedTier]++;
    }
    return dist;
  }

  // ─── Persistence ─────────────────────────────────────

  private markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 5000);
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.state.updatedAt = Date.now();
    try {
      await fs.mkdir(dirname(MATRIX_FILE), { recursive: true });
      await fs.writeFile(MATRIX_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
      this.dirty = false;
    } catch (err) {
      console.error('❌ [ModelMatrix] Failed to persist:', (err as Error).message);
    }
    this.saveTimer = null;
  }

  getState(): ModelMatrixState {
    return this.state;
  }
}

export const modelMatrix = new ModelMatrix();
