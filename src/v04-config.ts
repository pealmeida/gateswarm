/**
 * GateSwarm MoMA Router v0.5.1 — Configuration Manager
 * MoMA = Mixture of Multimodal Agents
 *
 * Centralized config for ensemble weights, tier models,
 * reasoning toggles, feedback loop, and RAG settings.
 * User-configurable via /gateswarm CLI commands.
 */

import { promises as fs } from 'fs';
import { basename, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { EffortLevel, IntentMode } from './types.js';
import { DEFAULT_BOUNDARIES, getEffortRanges, setTierBoundaries } from './tier-boundaries.js';
import { setEnsembleWeights as setVoterWeights, getEnsembleWeights as getVoterWeights } from './ensemble-voter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_FILE = join(__dirname, '../v04_config.json');
const CONFIG_RELOAD_ERROR_THROTTLE_MS = 5 * 60 * 1000;
const TIER_NAMES: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
const BOUNDARY_TIER_NAMES: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive'];

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
  plan_model?: string;
  plan_provider?: string;
  plan_max_tokens?: number;
  plan_enable_thinking?: boolean;
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
    ordinalAbstainMargin: number;
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
  version: 'v0.5.1-cli-providers',
  trained: new Date().toISOString(),
  method: 'ensemble-voter-with-feedback-loop',
  ensemble: {
    // Phase 4 ensemble honesty: warm-store ablation measured RAG/history at
    // exactly 0.0pp contribution — their weights stay 0 (paths kept for
    // re-enable). Phase 3 ordinal cascade FAILED its gate on 2026-07-12
    // (CV 54.4% vs heuristic 61.1%, ECE 0.156, n=60 train — data-starved);
    // cascade stays 0 and v05_ordinal_weights.json is unshipped until an
    // organic-data retrain passes the gate (eval/train-ordinal.ts).
    weights: { heuristic: 1.00, cascade: 0.00, ragSignal: 0.00, historyBias: 0.00 },
    confidenceThresholds: { high: 0.8, low: 0.5 },
    lowConfidenceAction: 'conservativeHeuristicFallback',
    ordinalAbstainMargin: 0.08,
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
  // v0.5.2: unified with v04_config.json + tier-boundaries DEFAULT_BOUNDARIES.
  // Phase 2 (2026-07-12): one-time sanctioned refit after the mid-band feature
  // work changed the score distribution (train-only fit, 5-fold CV 58.9% ± 11.4
  // vs 57.8% at the old cuts). Frozen until the scorer changes again.
  // Derived here so config-load fallback cannot drift from scoreToEffort().
  tier_boundaries: getEffortRanges(DEFAULT_BOUNDARIES),
  // v0.5.7: mirrors the committed v04_config.json (the validated source of truth).
  // A config-load failure must not re-route traffic to providers/models the
  // catalogs don't serve — the old defaults pointed at retired bailian models.
  tier_models: {
    // 2026-07-12: trivial/light moved off local ollama — deployment hosts run
    // no local models, so a local primary 404s and burns the fallback chain.
    trivial:   { model: 'glm-4.7-flash',  provider: 'zai',          max_tokens: 256,  enable_thinking: false,
                 fallback_models: [{ model: 'glm-4.5-air', provider: 'zai' }, { model: 'minimax-m2.7', provider: 'ollama-cloud' }, { model: 'deepseek-v4-flash', provider: 'opencodego' }] },
    light:     { model: 'minimax-m2.7',   provider: 'ollama-cloud', max_tokens: 512,  enable_thinking: false,
                 fallback_models: [{ model: 'glm-4.7', provider: 'zai' }, { model: 'glm-4.5-air', provider: 'zai' }, { model: 'deepseek-v4-flash', provider: 'opencodego' }] },
    moderate:  { model: 'glm-5',          provider: 'zai',          max_tokens: 2048, enable_thinking: false,
                 plan_model: 'glm-4.7-flash', plan_provider: 'zai', plan_max_tokens: 1024, plan_enable_thinking: false,
                 fallback_models: [{ model: 'glm-4.7', provider: 'zai' }, { model: 'minimax-m2.7', provider: 'ollama-cloud' }, { model: 'kimi-k2.6', provider: 'ollama-cloud' }, { model: 'glm-4.7-flash', provider: 'zai' }] },
    heavy:     { model: 'glm-5.1',        provider: 'zai',          max_tokens: 4096, enable_thinking: true,
                 plan_model: 'glm-5', plan_provider: 'zai', plan_max_tokens: 2048, plan_enable_thinking: false,
                 fallback_models: [{ model: 'glm-5', provider: 'zai' }, { model: 'deepseek-v4-pro', provider: 'ollama-cloud' }, { model: 'minimax-m3', provider: 'ollama-cloud' }, { model: 'kimi-k2.7-code', provider: 'ollama-cloud' }, { model: 'cc/claude-sonnet-4-6', provider: 'claude-cli' }] },
    intensive: { model: 'cx/gpt-5.4-codex', provider: 'codex-cli',  max_tokens: 4096, enable_thinking: true,
                 plan_model: 'cc/claude-sonnet-4-6', plan_provider: 'claude-cli', plan_max_tokens: 2048, plan_enable_thinking: true,
                 fallback_models: [{ model: 'cx/gpt-5.5-codex', provider: 'codex-cli' }, { model: 'glm-5', provider: 'zai' }, { model: 'deepseek-v4-pro', provider: 'ollama-cloud' }, { model: 'minimax-m3', provider: 'ollama-cloud' }] },
    extreme:   { model: 'cx/gpt-5.4-codex', provider: 'codex-cli',  max_tokens: 8192, enable_thinking: true,
                 plan_model: 'cc/claude-opus-4-8', plan_provider: 'claude-cli', plan_max_tokens: 4096, plan_enable_thinking: true,
                 fallback_models: [{ model: 'cx/gpt-5.5-codex', provider: 'codex-cli' }, { model: 'glm-5', provider: 'zai' }, { model: 'deepseek-v4-pro', provider: 'ollama-cloud' }, { model: 'minimax-m3', provider: 'ollama-cloud' }] },
  },
  feedback_loop: {
    retrainAfterInteractions: 500,
    minSamplesPerTier: 50,
    maxWeightChangePct: 0.20,
    llmJudgeModel: 'zai/glm-4.7',
    llmJudgeSamplingRate: 0.10,
    cascadeRetraining: false, // ordinal cascade gate-failed 2026-07-12; see ensemble._weights_note
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
let _configReloadCheckedAt = 0;
let _configGeneration = 0;
let _reloadInFlight: Promise<V04Config> | null = null;
let temporaryFileSequence = 0;
const CONFIG_RELOAD_MS = 5000;
let _reloadHealth: ConfigReloadHealth = {
  ok: true,
  lastError: null,
  lastLoadedAt: null,
  source: 'default',
};
const loggedReloadErrors = new Map<string, number>();

export interface ConfigReloadHealth {
  ok: boolean;
  lastError: string | null;
  lastLoadedAt: string | null;
  source: 'file' | 'default';
}

function configFile(): string {
  return process.env.GATESWARM_CONFIG_FILE || DEFAULT_CONFIG_FILE;
}

function configBackupFile(): string {
  return `${configFile()}.bak`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationError(message: string): Error {
  return new Error(`Invalid configuration: ${message}`);
}

/** Validate the fields that can change live routing behavior before applying them. */
function validateConfig(value: unknown): V04Config {
  if (!isRecord(value)) throw validationError('root must be an object');

  if (!isRecord(value.tier_models)) throw validationError('tier_models must be an object');
  for (const tier of TIER_NAMES) {
    const tierConfig = value.tier_models[tier];
    if (!isRecord(tierConfig)) throw validationError(`tier_models.${tier} is required`);
    if (typeof tierConfig.model !== 'string' || tierConfig.model.trim() === '') {
      throw validationError(`tier_models.${tier}.model must be a non-empty string`);
    }
    if (typeof tierConfig.provider !== 'string' || tierConfig.provider.trim() === '') {
      throw validationError(`tier_models.${tier}.provider must be a non-empty string`);
    }
  }

  if (!isRecord(value.ensemble) || !isRecord(value.ensemble.weights)) {
    throw validationError('ensemble.weights must be an object');
  }
  for (const key of ['heuristic', 'cascade', 'ragSignal', 'historyBias']) {
    const weight = value.ensemble.weights[key];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw validationError(`ensemble.weights.${key} must be a finite non-negative number`);
    }
  }

  if (value.tier_boundaries !== undefined) {
    if (!isRecord(value.tier_boundaries)) throw validationError('tier_boundaries must be an object');
    let previous = -Infinity;
    for (const tier of BOUNDARY_TIER_NAMES) {
      const range = value.tier_boundaries[tier];
      if (!Array.isArray(range) || typeof range[1] !== 'number') {
        throw validationError(`tier_boundaries.${tier}[1] must be a number`);
      }
      const upper = range[1];
      if (!Number.isFinite(upper) || upper <= 0 || upper >= 1 || upper <= previous) {
        throw validationError('tier_boundaries must contain five finite, ascending upper cuts in (0, 1)');
      }
      previous = upper;
    }
  }

  return value as unknown as V04Config;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordReloadError(error: unknown): void {
  const message = errorMessage(error);
  _reloadHealth = { ..._reloadHealth, ok: false, lastError: message };

  const now = Date.now();
  const lastLoggedAt = loggedReloadErrors.get(message) ?? 0;
  if (now - lastLoggedAt >= CONFIG_RELOAD_ERROR_THROTTLE_MS) {
    loggedReloadErrors.set(message, now);
    console.error(JSON.stringify({ event: 'config_reload_failed', error: message, source: configFile() }));
  }
}

function applyConfig(config: V04Config, source: ConfigReloadHealth['source']): V04Config {
  _config = config;
  const loadedAt = Date.now();
  _configReloadCheckedAt = loadedAt;
  _configGeneration++;
  _reloadHealth = {
    ok: true,
    lastError: null,
    lastLoadedAt: new Date(loadedAt).toISOString(),
    source,
  };
  syncTierBoundaries(config);
  syncVoterWeights(config);
  return config;
}

export async function loadConfig(force = false): Promise<V04Config> {
  const now = Date.now();
  if (!force && _config && (now - _configReloadCheckedAt) < CONFIG_RELOAD_MS) return _config;
  if (_reloadInFlight) return _reloadInFlight;

  const reloadGeneration = _configGeneration;
  const reload = (async (): Promise<V04Config> => {
    try {
      const raw = await fs.readFile(configFile(), 'utf-8');
      const parsed = validateConfig(JSON.parse(raw));
      _configReloadCheckedAt = Date.now();
      if (reloadGeneration !== _configGeneration) return _config ?? DEFAULT_V04_CONFIG;
      return applyConfig(parsed, 'file');
    } catch (error) {
      if (reloadGeneration !== _configGeneration) return _config ?? DEFAULT_V04_CONFIG;
      _configReloadCheckedAt = Date.now();
      if (_config) {
        recordReloadError(error);
        return _config;
      }
      const fallback = applyConfig(DEFAULT_V04_CONFIG, 'default');
      recordReloadError(error);
      return fallback;
    }
  })();
  _reloadInFlight = reload;
  try {
    return await reload;
  } finally {
    if (_reloadInFlight === reload) _reloadInFlight = null;
  }
}

export function getConfigReloadHealth(): ConfigReloadHealth {
  return { ..._reloadHealth };
}

export function getConfig(): V04Config {
  if (!_config || (Date.now() - _configReloadCheckedAt) >= CONFIG_RELOAD_MS) {
    void loadConfig();
  }
  return _config ?? DEFAULT_V04_CONFIG;
}

/**
 * Push the config's tier_boundaries into the scoreToEffort() cut-point cache.
 * The 5 cut points are the upper edges of trivial..intensive. This is what makes
 * boundary retraining take effect live (config hot-reloads every 5s).
 */
function syncTierBoundaries(cfg: V04Config): void {
  const tb = cfg.tier_boundaries;
  if (!tb) return;
  const cuts = [tb.trivial?.[1], tb.light?.[1], tb.moderate?.[1], tb.heavy?.[1], tb.intensive?.[1]];
  if (cuts.every(c => typeof c === 'number' && Number.isFinite(c))) {
    setTierBoundaries(cuts as number[]);
  }
}

/** Push a complete, valid config weight set into the live ensemble voter. */
function syncVoterWeights(cfg: V04Config): void {
  const weights = cfg.ensemble?.weights;
  if (!weights) return;
  const values = [weights.heuristic, weights.cascade, weights.ragSignal, weights.historyBias];
  if (values.every(value => Number.isFinite(value) && value >= 0)) {
    setVoterWeights(weights);
  }
}

export async function saveConfig(config?: V04Config): Promise<void> {
  const candidate = config ?? getConfig();
  const validConfig = validateConfig(candidate);

  const target = configFile();
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.${++temporaryFileSequence}.tmp`);
  const contents = JSON.stringify(validConfig, null, 2);
  let temporaryHandle: fs.FileHandle | null = null;
  try {
    temporaryHandle = await fs.open(temporary, 'w', 0o600);
    await temporaryHandle.writeFile(contents, 'utf-8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;

    try {
      await fs.copyFile(target, configBackupFile());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rename(temporary, target);
    applyConfig(validConfig, 'file');
  } catch (error) {
    if (temporaryHandle) await temporaryHandle.close();
    await fs.rm(temporary, { force: true });
    throw error;
  }
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
  // Propagate to the live voter — config weights were previously write-only
  // (the voter kept its own module-level copy that nothing ever updated).
  setVoterWeights(weights);
  cfg.ensemble.weights = { ...cfg.ensemble.weights, ...getVoterWeights() };
}

export function getTierModel(tier: EffortLevel): TierModelConfig | null {
  return getConfig().tier_models[tier] ?? null;
}

export function getTierModelForMode(effort: EffortLevel, mode: IntentMode): TierModelConfig | null {
  const tier = getConfig().tier_models[effort];
  if (!tier) return null;
  if (mode === 'plan' && tier.plan_model) {
    return {
      model: tier.plan_model,
      provider: tier.plan_provider ?? tier.provider,
      max_tokens: tier.plan_max_tokens ?? tier.max_tokens,
      enable_thinking: tier.plan_enable_thinking ?? false,
      fallback_models: tier.fallback_models,
    };
  }
  return tier;
}

// Plan/act lexicon + patterns. v0.5.2: expanded beyond literal keywords because
// real users express act-intent through symptoms ("the login button throws a 500")
// and plan-intent through deliberation ("not sure how to structure this") without
// ever typing "implement" or "brainstorm". Keyword hits + pattern hits both score.
const PLAN_KEYWORDS = ['draft', 'outline', 'brainstorm', 'sketch', 'explore',
  'what if', 'options', 'approach', 'consider', 'tradeoff', 'trade-off', 'strategy',
  'roadmap', 'plan', 'design', 'compare', 'pros and cons', 'high-level', 'evaluate',
  'recommend', 'weigh', 'alternatives', 'thoughts on', 'thinking about'];
const ACT_KEYWORDS = ['implement', 'build', 'deploy', 'apply', 'merge',
  'write the code', 'create the file', 'refactor', 'rename', 'install', 'configure',
  'patch', 'rewrite', 'generate', 'set up', 'debug', 'optimize'];

// Plan = deliberation / decision-seeking phrasing.
const PLAN_PATTERNS = [
  /\bhow (should|would|do|can) (i|we|you)\b/,
  /\bshould (i|we)\b/,
  /\bwhat'?s the best way\b/,
  /\bwhich .*(better|approach|option)\b/,
  /\bnot sure (how|whether|if|which|what)\b/,
  /\bhelp me (decide|choose|think|figure)\b/,
  /\bwalk me through (the )?(options|possibilities|tradeoffs|approaches)\b/,
  /\bwhether to\b/,
  /\bbefore (i|we) (write|code|build|implement|start|begin)\b/,
  /\bwhere would (the|you|i|we)\b/,
  /\bmap out\b/,
];
// Act = imperative command or bug/symptom report (implicitly "make it work").
// v0.5.2: broadened verb list + symptom phrasing — real act requests are often
// imperatives ("Replace…", "Spin up…") or bug reports ("it shows $0", "stopped
// firing", "can't upload") that never contain a literal act keyword.
const ACT_PATTERNS = [
  /^(write|create|build|implement|fix|add|remove|update|change|make|generate|refactor|rename|install|configure|deploy|redeploy|run|delete|convert|set ?up|patch|rewrite|debug|optimize|replace|migrate|spin ?up|bump|swap|enable|disable|upgrade|downgrade|revert|roll ?back|wire|hook ?up|point|move|extract|split|merge|integrate|connect|expose|seed|backfill|provision|scaffold)\b/,
  /\b(throws?|throwing|returns?|returning|raises?) (an? )?(error|500|404|exception|null|undefined|nan|wrong|empty)\b/,
  /\b(stack trace|traceback|null pointer|segfault|call stack|memory leak)\b/,
  /\b(is|are|was|were|keeps?|looks?|shows?|appears?|stays?|goes?) (broken|crashing|failing|not working|blank|empty|null|undefined|grey|gray|frozen|stuck)\b/,
  /\b(doesn'?t|does not|won'?t|wont|can'?t|cannot|unable to|fails? to|stopped|stops) (work|compile|build|run|load|render|upload|download|save|submit|open|fire|firing|respond|responding|connect|start|update)\b/,
  /\bsilently\b/,
  /\bshows? \$?0\b/,
];

// Stem-friendly word-boundary keyword matcher: anchors at a word start and allows
// inflectional suffixes (\w*), so "weigh"→"weighing" and "consider"→"considering"
// match, but interior hits like "ex<plan>ation" or "<code>base" do not.
function keywordHits(lower: string, keywords: string[]): number {
  let n = 0;
  for (const kw of keywords) {
    const re = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*');
    if (re.test(lower)) n++;
  }
  return n;
}

export function detectIntentMode(promptText: string): {
  mode: IntentMode;
  confidence: number;
  planScore: number;
  actScore: number;
} {
  const lower = promptText.toLowerCase().trim();
  if (!lower) return { mode: 'auto', confidence: 0, planScore: 0, actScore: 0 };

  let planScore = keywordHits(lower, PLAN_KEYWORDS);
  let actScore = keywordHits(lower, ACT_KEYWORDS);
  for (const re of PLAN_PATTERNS) { if (re.test(lower)) planScore++; }
  for (const re of ACT_PATTERNS) { if (re.test(lower)) actScore++; }

  const maxScore = Math.max(planScore, actScore);
  if (maxScore === 0) return { mode: 'auto', confidence: 0, planScore: 0, actScore: 0 };
  const confidence = Math.min(maxScore / 3, 1);
  const mode: IntentMode = planScore > actScore ? 'plan' : actScore > planScore ? 'act' : 'auto';
  return { mode, confidence, planScore, actScore };
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
