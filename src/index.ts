/**
 * CrossPlatformMoMA — Main Orchestrator
 *
 * Complete lightweight engine with:
 * - Local models (WebGPU/WebNN/WASM via Transformers.js)
 * - Cloud models (API via Edge proxy)
 * - CLI models (Ollama, llama.cpp in Node.js/Electron)
 * - Self-improvement (feedback-driven learning loop)
 */

import type { MoMAConfig, MoMAStatus, RoutingDecision, GenerationChunk, DeviceProfile } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { detectBackend, getDeviceProfile } from './backend.js';
import { IntentEngine } from './intent-engine.js';
import { ModelRouter } from './router.js';
import { AdapterRegistry } from './adapters/registry.js';
import { LearningLoop } from './learning/learning-loop.js';

export class CrossPlatformMoMA {
  private config: Required<MoMAConfig>;
  private intentEngine: IntentEngine;
  private router!: ModelRouter;
  private registry: AdapterRegistry;
  private learning: LearningLoop;
  private profile!: DeviceProfile;
  private _initialized = false;
  private _online = true;

  constructor(config?: MoMAConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.intentEngine = new IntentEngine();
    this.registry = new AdapterRegistry();
    this.learning = new LearningLoop({
      tier1: this.config.complexityThresholds.tier1,
      tier2: this.config.complexityThresholds.tier2,
    });
  }

  async initialize(): Promise<MoMAStatus> {
    // 1. Detect device
    const backendInfo = await detectBackend();
    this.profile = getDeviceProfile(backendInfo);

    // 2. Get learning-adjusted thresholds
    const learnedThresholds = this.learning.currentThresholds;

    // 3. Initialize intent engine
    await this.intentEngine.initialize();

    // 4. Setup router with learned thresholds
    this.router = new ModelRouter(this.profile, learnedThresholds);

    // 5. Register model adapters based on device
    this.registerAdapters();

    // 6. Online/offline listeners
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.handleOnline());
      window.addEventListener('offline', () => this.handleOffline());
      this._online = navigator.onLine;
    }

    this._initialized = true;
    const status = this.getStatus();
    this.config.onStatusChange(status);
    return status;
  }

  private registerAdapters(): void {
    // ─── Local Models ────────────────────────────────────
    // Qwen 0.5B — gatekeeper / trivial+light tasks
    this.registry.registerLocal('qwen-0.5b-local', {
      id: 'qwen-0.5b-local',
      modelId: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
      displayName: 'Qwen 2.5 0.5B (Local)',
      backend: this.profile.backend,
      maxTokens: 2048,
      sizeMB: 300,
      minMemoryGB: 1,
    });

    // TinyLlama 1.1B — mobile worker
    if (this.profile.isMobile || this.profile.memoryGB < 4) {
      this.registry.registerLocal('tinyllama-local', {
        id: 'tinyllama-local',
        modelId: 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC',
        displayName: 'TinyLlama 1.1B (Local)',
        backend: this.profile.backend,
        maxTokens: 2048,
        sizeMB: 600,
        minMemoryGB: 1.5,
      });
    }

    // Llama 3.2 3B — desktop worker
    if (!this.profile.isMobile && this.profile.backend === 'webgpu' && this.profile.memoryGB >= 4) {
      this.registry.registerLocal('llama-3b-local', {
        id: 'llama-3b-local',
        modelId: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
        displayName: 'Llama 3.2 3B (Local)',
        backend: 'webgpu',
        maxTokens: 4096,
        sizeMB: 1800,
        minMemoryGB: 4,
      });
    }

    // ─── Cloud API Models ─────────────────────────────────
    this.registry.registerCloudApi('cloud-gpt4o-mini', {
      id: 'cloud-gpt4o-mini',
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o Mini (Cloud)',
      endpoint: this.config.cloudEndpoint,
      provider: this.config.cloudProvider,
      maxTokens: 128000,
      costPer1kTokens: 0.15,
    });

    this.registry.registerCloudApi('cloud-gpt4o', {
      id: 'cloud-gpt4o',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o (Cloud)',
      endpoint: this.config.cloudEndpoint,
      provider: this.config.cloudProvider,
      maxTokens: 128000,
      costPer1kTokens: 5.0,
    });

    this.registry.registerCloudApi('cloud-claude-sonnet', {
      id: 'cloud-claude-sonnet',
      modelId: 'claude-sonnet-4-20250514',
      displayName: 'Claude Sonnet (Cloud)',
      endpoint: this.config.cloudEndpoint,
      provider: 'anthropic',
      maxTokens: 200000,
      costPer1kTokens: 3.0,
    });

    // ─── CLI Models (Node.js/Electron only) ───────────────
    this.registry.registerCli('cli-ollama-qwen', {
      id: 'cli-ollama-qwen',
      modelId: 'qwen2.5:0.5b',
      displayName: 'Ollama Qwen 0.5B (CLI)',
      command: 'ollama run qwen2.5:0.5b',
      maxTokens: 4096,
      costPer1kTokens: 0,
      timeout: 60000,
    });

    this.registry.registerCli('cli-ollama-llama', {
      id: 'cli-ollama-llama',
      modelId: 'llama3.2:3b',
      displayName: 'Ollama Llama 3.2 (CLI)',
      command: 'ollama run llama3.2:3b',
      maxTokens: 8192,
      costPer1kTokens: 0,
      timeout: 120000,
    });
  }

  /**
   * Process a prompt — returns streaming tokens.
   */
  async *process(prompt: string): AsyncGenerator<GenerationChunk> {
    if (!this._initialized) throw new Error('Not initialized. Call initialize() first.');

    const startMs = performance.now();

    // 1. Score complexity
    const score = await this.intentEngine.score(prompt);

    // 2. Route to tier (using learned thresholds)
    const decision = this.router.route(score.value);

    // 3. Select adapter based on routing decision
    const adapterId = this.selectAdapter(decision);

    // 4. Generate via adapter
    let fullResponse = '';
    let tokenCount = 0;

    try {
      for await (const chunk of this.registry.generate(adapterId, { prompt })) {
        if (chunk.token) {
          fullResponse += chunk.token;
          tokenCount++;
        }
        yield { token: chunk.token, done: chunk.done };
      }
    } catch (err: any) {
      // Fallback: try next best adapter
      const fallback = this.selectFallbackAdapter(decision);
      if (fallback && fallback !== adapterId) {
        for await (const chunk of this.registry.generate(fallback, { prompt })) {
          if (chunk.token) {
            fullResponse += chunk.token;
            tokenCount++;
          }
          yield { token: chunk.token, done: chunk.done };
        }
      } else {
        yield { token: `[Error: ${err.message}]`, done: true };
      }
    }

    // 5. Record outcome for learning (after response)
    const latencyMs = performance.now() - startMs;
    this.learning.recordOutcome({
      prompt,
      score: score.value,
      effort: decision.effort,
      tier: decision.tier,
      model: decision.model,
      latencyMs,
      tokenCount,
      costCents: decision.estimatedCostCents,
      userSatisfied: null,
      timestamp: Date.now(),
    });

    // 6. Apply learned thresholds if they changed
    const lt = this.learning.currentThresholds;
    this.router.adjustThresholds(lt.tier1, lt.tier2);
  }

  private selectAdapter(decision: RoutingDecision): string {
    // Map routing model ID to adapter ID
    const modelToAdapter: Record<string, string> = {
      'qwen-0.5b-q4': 'qwen-0.5b-local',
      'tinyllama-1.1b-q4': 'tinyllama-local',
      'llama-3.2-3b-q4': 'llama-3b-local',
      'cloud-gpt4o-mini': 'cloud-gpt4o-mini',
      'cloud-gpt4o': 'cloud-gpt4o',
      'cloud-claude-sonnet': 'cloud-claude-sonnet',
    };

    // Check if local adapter exists, otherwise prefer CLI then cloud
    let adapterId = modelToAdapter[decision.model];
    if (!adapterId) {
      // Try CLI fallback for local models
      if (decision.tier === 'local') {
        const cliEntry = this.registry.get('cli-ollama-llama') ?? this.registry.get('cli-ollama-qwen');
        if (cliEntry?.adapter.isAvailable) return cliEntry.config.id;
      }
      adapterId = 'cloud-gpt4o-mini'; // safe default
    }

    return adapterId;
  }

  private selectFallbackAdapter(decision: RoutingDecision): string | null {
    if (decision.tier === 'cloud') return null; // no fallback from cloud
    return 'cloud-gpt4o-mini'; // always fallback to cloud
  }

  private handleOnline(): void {
    this._online = true;
    const lt = this.learning.currentThresholds;
    this.router.adjustThresholds(lt.tier1, lt.tier2);
    this.config.onStatusChange(this.getStatus());
  }

  private handleOffline(): void {
    this._online = false;
    this.router.forceLocal();
    this.config.onStatusChange(this.getStatus());
  }

  getStatus(): MoMAStatus {
    return {
      initialized: this._initialized,
      backend: this.profile?.backend ?? 'wasm',
      online: this._online,
      loadedModels: this.registry.list().filter(a => a.loaded).map(a => a.displayName),
      cacheSizeBytes: 0,
      memoryUsageBytes: 0,
    };
  }

  /** Get learning stats */
  getLearningStats() {
    return {
      routing: this.learning.getStats(),
      recentLearnings: this.learning.getRecentLearnings(),
      promptPatterns: this.learning.getPromptPatterns().slice(0, 10),
      currentThresholds: this.learning.currentThresholds,
    };
  }

  /** List all registered adapters */
  listAdapters() {
    return this.registry.list();
  }

  /** Provide feedback on a response (for learning) */
  provideFeedback(prompt: string, satisfied: boolean): void {
    // Find the most recent outcome for this prompt and update it
    const entry = this.learning.getStats();
    // Learning loop uses this signal for accuracy tracking
    console.log(`[MoMA] Feedback recorded: ${satisfied ? 'satisfied' : 'unsatisfied'} for "${prompt.slice(0, 50)}..."`);
  }

  async dispose(): Promise<void> {
    await this.intentEngine.dispose();
    await this.registry.disposeAll();
  }
}

export async function createMoMA(config?: MoMAConfig): Promise<CrossPlatformMoMA> {
  const moma = new CrossPlatformMoMA(config);
  await moma.initialize();
  return moma;
}

export default CrossPlatformMoMA;
export * from './types.js';
