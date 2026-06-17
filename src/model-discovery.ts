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
  if (id.includes('mimo-v2.5')) contextWindow = 262144;
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

  // Vision support
  supportsVision = id.includes('vl') || id.includes('gemini') ||
    id.includes('gemma4') || id.includes('mimo-v2-omni') ||
    id.includes('qwen3-vl') || id.includes('omni');

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
    // OpenRouter
    if (providerId === 'openrouter') return `${baseUrl}/models`;
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
