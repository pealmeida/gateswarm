/**
 * Model Discovery Service v0.5.4
 *
 * Polls all configured providers for their live model catalogs.
 * Populates the Model Matrix with discovered models and their metadata.
 * Runs on startup and periodically (default: every 15 minutes).
 */

import { modelMatrix, ModelEntry, EffortLevel, scoreModelForTier } from './model-matrix.js';
import { agentRegistry } from './agent-registry.js';

// ─── Types ───────────────────────────────────────────────

interface ProviderEndpoint {
  id: string;
  name: string;
  modelsUrl: string;
  authHeader: string;
}

interface OllamaModelInfo {
  id: string;
  name: string;
  size?: number;
  digest?: string;
  modified_at?: string;
}

interface OpenAIModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

// ─── Model metadata heuristics ──────────────────────────

interface ModelHeuristics {
  contextWindow: number;
  maxTokens: number;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  recommendedTier: EffortLevel;
  costPer1kInput: number;
  costPer1kOutput: number;
}

function getModelHeuristics(providerId: string, modelId: string): ModelHeuristics {
  const id = modelId.toLowerCase();

  // ─── Context window estimation by model family ──────────
  let contextWindow = 128000; // default
  let maxTokens = 4096;
  let supportsReasoning = false;
  let supportsVision = false;
  let supportsTools = false;
  let costPer1kInput = 0;
  let costPer1kOutput = 0;

  // Ollama Cloud pricing (free tier)
  if (providerId === 'ollama-cloud') {
    costPer1kInput = 0;
    costPer1kOutput = 0;
  }
  // OpenCode Go pricing
  if (providerId === 'opencodego') {
    costPer1kInput = 0;
    costPer1kOutput = 0;
  }
  // ZAI costs
  if (providerId === 'zai') {
    costPer1kInput = 0; // coding lite plan — free
    costPer1kOutput = 0;
  }
  // Bailian costs
  if (providerId === 'bailian') {
    costPer1kInput = 0.001;
    costPer1kOutput = 0.002;
  }

  // Context window detection
  if (id.includes('671b') || id.includes('1t') || id.includes('1.2t')) contextWindow = 1048576;
  else if (id.includes('405b') || id.includes('550b') || id.includes('480b')) contextWindow = 1000000;
  else if (id.includes('235b') || id.includes('397b') || id.includes('123b')) contextWindow = 1000000;
  else if (id.includes('120b') || id.includes('70b')) contextWindow = 200000;
  else if (id.includes('30b') || id.includes('31b') || id.includes('80b')) contextWindow = 200000;
  else if (id.includes('24b') || id.includes('27b') || id.includes('20b')) contextWindow = 131072;
  else if (id.includes('14b') || id.includes('12b') || id.includes('8b')) contextWindow = 131072;
  else if (id.includes('3b') || id.includes('4b') || id.includes('1b')) contextWindow = 32768;
  else if (id.includes('0.5b')) contextWindow = 32768;

  // Per-model overrides
  if (id.includes('kimi-k2.5') || id.includes('kimi-k2.6')) contextWindow = 262144;
  if (id.includes('kimi-k2.7')) contextWindow = 262144;
  if (id.includes('glm-5.1')) contextWindow = 204800;
  if (id.includes('glm-5') && !id.includes('glm-5.')) contextWindow = 200000;
  if (id.includes('deepseek-v4')) contextWindow = 1048576;
  if (id.includes('deepseek-v3')) contextWindow = 1000000;
  if (id.includes('qwen3.5') || id.includes('qwen3.6') || id.includes('qwen3.7')) contextWindow = 1000000;
  if (id.includes('qwen4')) contextWindow = 1000000;
  if (id.includes('gemma3:4b') || id.includes('gemma3:12b') || id.includes('gemma3:27b')) contextWindow = 128000;
  if (id.includes('gemma4:31b')) contextWindow = 131072;
  if (id.includes('minimax-m3')) contextWindow = 1000000;
  if (id.includes('minimax-m2.7') || id.includes('minimax-m2.5')) contextWindow = 204800;
  if (id.includes('ministral-3')) contextWindow = 131072;
  if (id.includes('mistral-large-3')) contextWindow = 1048576;
  if (id.includes('nemotron-3-ultra')) contextWindow = 1000000;
  if (id.includes('nemotron-3-super')) contextWindow = 1000000;
  if (id.includes('nemotron-3-nano')) contextWindow = 128000;
  if (id.includes('mimo-v2-pro') || id.includes('mimo-v2-omni')) contextWindow = 262144;
  if (id.includes('mimo-v2.6') || id.includes('mimo-v2.5')) contextWindow = 262144;
  if (id.includes('hy3-preview') || id.includes('cogito')) contextWindow = 200000;

  // Max tokens
  if (id.includes('kimi-k2.6') || id.includes('kimi-k2.7')) maxTokens = 65536;
  else if (id.includes('kimi-k2.5')) maxTokens = 65536;
  else if (id.includes('glm-5.1') || id.includes('glm-5')) maxTokens = 131072;
  else if (id.includes('deepseek-v4')) maxTokens = 8192;
  else if (id.includes('deepseek-v3')) maxTokens = 65536;
  else if (id.includes('qwen3.7') || id.includes('qwen3.6')) maxTokens = 65536;
  else if (id.includes('qwen3.5')) maxTokens = 65536;
  else if (id.includes('qwen4')) maxTokens = 65536;
  else if (id.includes('minimax-m3')) maxTokens = 131072;
  else if (id.includes('minimax-m2')) maxTokens = 65536;
  else if (id.includes('mimo-v2')) maxTokens = 131072;
  else if (contextWindow >= 1000000) maxTokens = 65536;
  else if (contextWindow >= 200000) maxTokens = 32768;
  else maxTokens = 8192;

  // Reasoning support
  supportsReasoning = id.includes('kimi-k2') || id.includes('thinking') ||
    id.includes('glm-5') || id.includes('deepseek-v4-pro') ||
    id.includes('qwen3.7') || id.includes('minimax-m3') ||
    id.includes('minimax-m2.7') || id.includes('nemotron-3-super') ||
    id.includes('mimo-v2.5-pro') || id.includes('hy3-preview') ||
    id.includes('cogito');

  // Vision support (MoMA: cover common vision model families)
  supportsVision = id.includes('vl') || id.includes('gemini') ||
    id.includes('gemma4') || id.includes('mimo-v2-omni') ||
    id.includes('qwen3-vl') || id.includes('omni') ||
    id.includes('llava') || id.includes('vision') ||
    id.includes('moondream') || id.includes('pixtral') ||
    id.includes('gemma3') || /glm-\d(\.\d)?v\b/.test(id);

  // Tools support — most modern models support this
  supportsTools = contextWindow >= 32000;

  // Tier assignment
  const { tier } = scoreModelForTier({
    id: modelId, provider: providerId, name: modelId,
    contextWindow, maxTokens, inputModalities: ['text'],
    supportsReasoning, supportsVision, supportsTools,
    available: true, lastChecked: 0, latencyMs: 0, avgLatencyMs: 0,
    costPer1kInput, costPer1kOutput,
    totalTokensIn: 0, totalTokensOut: 0, totalRequests: 0,
    errorCount: 0, consecutiveFailures: 0, lastError: null,
    recommendedTier: 'light', updatedAt: 0,
  });

  return { contextWindow, maxTokens, supportsReasoning, supportsVision, supportsTools, recommendedTier: tier, costPer1kInput, costPer1kOutput };
}

// ─── Provider Discovery ─────────────────────────────────

const DISCOVERY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

class ModelDiscoveryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  async start(): Promise<void> {
    console.log('🔍 Model Discovery Service: starting...');
    await this.discoverAll();
    this.timer = setInterval(() => this.discoverAll(), DISCOVERY_INTERVAL_MS);
    console.log(`🔍 Model Discovery Service: polling every ${DISCOVERY_INTERVAL_MS / 60000}min`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async discoverAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const start = Date.now();

    try {
      const providers = agentRegistry.getProviders().filter(p => p.type === 'http-api');
      const discoveries = providers.map(p => this.discoverProvider(p.id, p.name));
      await Promise.allSettled(discoveries);
    } catch (err) {
      console.error('❌ [Discovery] Error during discoverAll:', (err as Error).message);
    }

    this.running = false;
    const elapsed = Date.now() - start;
    console.log(`🔍 [Discovery] Completed in ${elapsed}ms — ${Object.keys(modelMatrix.getAllModels()).length} models indexed`);
  }

  private async discoverProvider(providerId: string, name: string): Promise<void> {
    const baseUrl = agentRegistry.getProviderBaseUrl(providerId);
    const apiKey = agentRegistry.getProviderApiKey(providerId);

    if (!baseUrl) {
      console.log(`🔍 [Discovery] ${providerId}: no base URL — skipped`);
      return;
    }

    const modelsUrl = this.getModelsUrl(providerId, baseUrl);
    if (!modelsUrl) {
      // Some providers don't have a list endpoint; register known models
      console.log(`🔍 [Discovery] ${providerId}: no /models endpoint — using static catalog`);
      await this.discoverStatic(providerId, name);
      return;
    }

    try {
      console.log(`🔍 [Discovery] Polling ${providerId}: ${modelsUrl}`);
      const response = await fetch(modelsUrl, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        console.log(`🔍 [Discovery] ${providerId}: HTTP ${response.status} — using static fallback`);
        await this.discoverStatic(providerId, name);
        return;
      }

      const data = await response.json();
      const models = this.parseModelList(providerId, data);

      for (const modelInfo of models) {
        const heuristics = getModelHeuristics(providerId, modelInfo.id);
        modelMatrix.upsertModel({
          id: modelInfo.id,
          provider: providerId,
          name: modelInfo.name || modelInfo.id,
          contextWindow: heuristics.contextWindow,
          maxTokens: heuristics.maxTokens,
          inputModalities: heuristics.supportsVision ? ['text', 'image'] : ['text'],
          supportsReasoning: heuristics.supportsReasoning,
          supportsVision: heuristics.supportsVision,
          supportsTools: heuristics.supportsTools,
          costPer1kInput: heuristics.costPer1kInput,
          costPer1kOutput: heuristics.costPer1kOutput,
          available: true,
          lastChecked: Date.now(),
          recommendedTier: heuristics.recommendedTier,
        });
      }

      modelMatrix.updateProviderSummary(providerId, name);
      console.log(`🔍 [Discovery] ${providerId}: indexed ${models.length} models`);
    } catch (err) {
      console.log(`🔍 [Discovery] ${providerId}: fetch failed (${(err as Error).message}) — using static`);
      await this.discoverStatic(providerId, name);
    }
  }

  private getModelsUrl(providerId: string, baseUrl: string): string | null {
    // Ollama Cloud
    if (providerId === 'ollama-cloud') return 'https://ollama.com/v1/models';
    // ZAI
    if (providerId === 'zai') return `${baseUrl}/models`;
    // OpenCode Go
    if (providerId === 'opencodego') return `${baseUrl}/models`;
    // OpenRouter — removed per user request
    // if (providerId === 'openrouter') return `${baseUrl}/models`;
    // Bailian doesn't have a list endpoint
    if (providerId === 'bailian') return null;
    // Local ollama
    if (providerId === 'ollama') return `${baseUrl}/models`.replace('/v1/models', '/api/tags');
    return null;
  }

  private parseModelList(providerId: string, data: any): Array<{ id: string; name?: string }> {
    // OpenAI format: { data: [{ id: "..." }] }
    if (data?.data && Array.isArray(data.data)) {
      return data.data.map((m: OpenAIModelInfo) => ({ id: m.id, name: m.id }));
    }
    // Ollama format: { models: [{ name: "..." }] }
    if (data?.models && Array.isArray(data.models)) {
      return data.models.map((m: OllamaModelInfo) => ({ id: m.name || m.id, name: m.name }));
    }
    return [];
  }

  private async discoverStatic(providerId: string, name: string): Promise<void> {
    // Register known models from agent registry configs
    const knownModels = agentRegistry.getProviderModels(providerId);
    if (!knownModels || knownModels.length === 0) {
      console.log(`🔍 [Discovery] ${providerId}: no static models available`);
      return;
    }

    for (const modelId of knownModels) {
      const heuristics = getModelHeuristics(providerId, modelId);
      modelMatrix.upsertModel({
        id: modelId,
        provider: providerId,
        name: modelId,
        contextWindow: heuristics.contextWindow,
        maxTokens: heuristics.maxTokens,
        inputModalities: heuristics.supportsVision ? ['text', 'image'] : ['text'],
        supportsReasoning: heuristics.supportsReasoning,
        supportsVision: heuristics.supportsVision,
        supportsTools: heuristics.supportsTools,
        costPer1kInput: heuristics.costPer1kInput,
        costPer1kOutput: heuristics.costPer1kOutput,
        available: true,
        lastChecked: Date.now(),
        recommendedTier: heuristics.recommendedTier,
      });
    }

    modelMatrix.updateProviderSummary(providerId, name);
    console.log(`🔍 [Discovery] ${providerId}: indexed ${knownModels.length} static models`);
  }

  /** Force immediate rediscovery of all providers */
  async forceRediscover(): Promise<void> {
    console.log('🔍 [Discovery] Force rediscovery triggered');
    await this.discoverAll();
  }

  /** Discover a single provider */
  async discoverSingle(providerId: string): Promise<void> {
    const provider = agentRegistry.getProviders().find(p => p.id === providerId);
    if (!provider) {
      console.log(`🔍 [Discovery] Unknown provider: ${providerId}`);
      return;
    }
    await this.discoverProvider(providerId, provider.name);
  }
}

export const modelDiscovery = new ModelDiscoveryService();

// ─── Pluggable per-provider model listing (v0.8.0 slice 2) ───────────

export type ModelSource = 'static' | 'discovered' | 'both';

export interface ListedModel { id: string; source: ModelSource }

export interface ProviderModelListing {
  provider: string;
  supported: boolean;
  cached: boolean;
  fetchedAt: number;
  models: ListedModel[];
  error?: string;
}

/** Minimal description of a provider needed for listing (decoupled from the registry for testability). */
export interface ListerProvider {
  id: string;
  type: 'http-api' | 'cli-agent';
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
}

export interface ListerFs {
  readFile(path: string): Promise<string>;
  homedir(): string;
}

export interface ListerDeps {
  fetch?: typeof fetch;
  exec?: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
  fs?: ListerFs;
  now?: () => number;
  provider?: ListerProvider;
  timeoutMs?: number;
}

const DEFAULT_LISTER_TTL_MS = 15 * 60 * 1000;
const LISTER_TIMEOUT_MS = 10000;
const MAX_LISTER_BYTES = 1024 * 1024;
const MAX_LISTED_MODELS = 5000;
const MAX_MODEL_ID_LENGTH = 512;

function listerTtlMs(): number {
  const raw = process.env.GATESWARM_DISCOVERY_TTL_MS;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LISTER_TTL_MS;
}

const listerCache = new Map<string, { at: number; ids: string[]; identity: string }>();

export function clearModelListingCache(): void {
  listerCache.clear();
}

async function defaultExec(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)));
  });
}

async function defaultFs(): Promise<ListerFs> {
  const [{ readFile }, { homedir }] = await Promise.all([import('node:fs/promises'), import('node:os')]);
  return { readFile: p => readFile(p, 'utf8'), homedir };
}

function cleanIds(ids: unknown[]): string[] {
  return [...new Set(ids.filter((x): x is string => typeof x === 'string')
    .map(s => s.trim()).filter(s => s.length > 0 && s.length <= MAX_MODEL_ID_LENGTH))]
    .slice(0, MAX_LISTED_MODELS);
}

async function getJson(f: typeof fetch, url: string, headers: Record<string, string>, timeoutMs: number): Promise<any> {
  const res = await f(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_LISTER_BYTES) throw new Error('Response too large');
  return JSON.parse(body);
}

function isAnthropic(p: ListerProvider): boolean {
  return p.id === 'anthropic' || /(^|\/\/|\.)anthropic\.com/.test(p.baseUrl || '');
}

function isLocalOllama(p: ListerProvider): boolean {
  return p.id === 'ollama' || /:11434\b/.test(p.baseUrl || '');
}

async function listViaApi(p: ListerProvider, f: typeof fetch, timeoutMs: number): Promise<string[]> {
  const base = (p.baseUrl || '').replace(/\/+$/, '');
  if (isAnthropic(p)) {
    const root = base.replace(/\/v1$/, '');
    const data = await getJson(f, `${root}/v1/models`, {
      'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01',
    }, timeoutMs);
    return cleanIds((data?.data ?? []).map((m: any) => m?.id));
  }
  if (isLocalOllama(p)) {
    const root = base.replace(/\/v1$/, '');
    const data = await getJson(f, `${root}/api/tags`, {}, timeoutMs);
    return cleanIds((data?.models ?? []).map((m: any) => m?.name ?? m?.model ?? m?.id));
  }
  const data = await getJson(f, `${base}/models`, p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}, timeoutMs);
  if (Array.isArray(data?.data)) return cleanIds(data.data.map((m: any) => m?.id));
  if (Array.isArray(data?.models)) return cleanIds(data.models.map((m: any) => m?.id ?? m?.name));
  return [];
}

const CLI_LIST_COMMANDS: Record<string, { executable: string; args: string[] }> = {
  opencode: { executable: 'opencode', args: ['models'] },
};
const CLI_CONFIG_FILES: Record<string, string[]> = {
  codex: ['.codex/config.toml'],
  claude: ['.claude/settings.json'],
  opencode: ['.config/opencode/opencode.json'],
};

function collectJsonModels(node: any, out: string[], depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 6) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'model' && typeof v === 'string') out.push(v);
    else if (k === 'models' && Array.isArray(v)) out.push(...v.filter(x => typeof x === 'string'));
    else if (k === 'models' && v && typeof v === 'object') out.push(...Object.keys(v));
    else collectJsonModels(v, out, depth + 1);
  }
}

export function parseCliConfigModels(text: string): string[] {
  if (text.length > MAX_LISTER_BYTES) return [];
  const out: string[] = [];
  try {
    collectJsonModels(JSON.parse(text), out);
  } catch {
    for (const m of text.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm)) out.push(m[1]);
  }
  return cleanIds(out);
}

async function listViaCli(p: ListerProvider, deps: ListerDeps, timeoutMs: number): Promise<string[]> {
  const cmd = CLI_LIST_COMMANDS[p.id];
  if (cmd) {
    try {
      const out = await (deps.exec ?? defaultExec)(cmd.executable, cmd.args, timeoutMs);
      if (out.length > MAX_LISTER_BYTES) throw new Error('CLI output too large');
      const ids = cleanIds(out.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/\s/.test(l)));
      if (ids.length) return ids;
    } catch { /* fall through to config files */ }
  }
  const ids: string[] = [];
  try {
    const fs = deps.fs ?? await defaultFs();
    for (const rel of CLI_CONFIG_FILES[p.id] ?? []) {
      try {
        const text = await fs.readFile(`${fs.homedir()}/${rel}`);
        if (text.length <= MAX_LISTER_BYTES) ids.push(...parseCliConfigModels(text));
      } catch { /* missing file */ }
    }
  } catch { /* no fs */ }
  return cleanIds(ids);
}

function mergeModels(staticIds: string[], discovered: string[]): ListedModel[] {
  const map = new Map<string, ModelSource>();
  for (const id of staticIds) map.set(id, 'static');
  for (const id of discovered) map.set(id, map.get(id) === 'static' ? 'both' : 'discovered');
  return [...map].map(([id, source]) => ({ id, source }));
}

function resolveProvider(providerId: string): ListerProvider | undefined {
  const p = agentRegistry.getProvider(providerId);
  if (!p) return undefined;
  return {
    id: p.id,
    type: p.type === 'cli-agent' ? 'cli-agent' : 'http-api',
    baseUrl: agentRegistry.getProviderBaseUrl(providerId),
    apiKey: agentRegistry.getProviderApiKey(providerId),
    models: agentRegistry.getProviderModels(providerId),
  };
}

export async function listProviderModels(
  providerId: string,
  opts: { refresh?: boolean } & ListerDeps = {},
): Promise<ProviderModelListing> {
  const now = opts.now ?? Date.now;
  const p = opts.provider ?? resolveProvider(providerId);
  if (!p) return { provider: providerId, supported: false, cached: false, fetchedAt: now(), models: [], error: 'unknown provider' };

  const staticIds = p.models ?? [];
  const isCli = p.type === 'cli-agent';
  if (!isCli && !p.baseUrl) {
    return { provider: providerId, supported: false, cached: false, fetchedAt: now(), models: mergeModels(staticIds, []) };
  }

  const identity = `${p.type}\0${p.baseUrl ?? ''}`;
  const hit = listerCache.get(providerId);
  if (!opts.refresh && hit && hit.identity === identity && now() >= hit.at && now() - hit.at < listerTtlMs()) {
    return { provider: providerId, supported: true, cached: true, fetchedAt: hit.at, models: mergeModels(staticIds, hit.ids) };
  }

  const timeoutMs = opts.timeoutMs ?? LISTER_TIMEOUT_MS;
  try {
    const ids = isCli
      ? await listViaCli(p, opts, timeoutMs)
      : await listViaApi(p, opts.fetch ?? fetch, timeoutMs);
    const at = now();
    listerCache.set(providerId, { at, ids, identity });
    return { provider: providerId, supported: true, cached: false, fetchedAt: at, models: mergeModels(staticIds, ids) };
  } catch (err) {
    // Do not surface arbitrary fetch/exec errors: they may contain URLs, headers, or credentials.
    const message = err instanceof Error && /^HTTP \d{3}$/.test(err.message) ? err.message : 'Model listing failed';
    return { provider: providerId, supported: true, cached: false, fetchedAt: now(), models: mergeModels(staticIds, []), error: message };
  }
}
