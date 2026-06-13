/**
 * Adapter Registry — Manages all model adapters (local, cloud, CLI)
 * Lazy-loads adapters on first use, tracks usage stats.
 */

import type { ModelAdapter, AdapterConfig, AdapterEntry, GenerateRequest, GenerateChunk } from './types.js';
import { LocalAdapter } from './local-adapter.js';
import { CloudApiAdapter } from './cloud-api-adapter.js';
import { CliAdapter } from './cli-adapter.js';

export class AdapterRegistry {
  private adapters = new Map<string, AdapterEntry>();

  /** Register a local model adapter */
  registerLocal(id: string, config: any): void {
    const adapter = new LocalAdapter(config);
    this.adapters.set(id, {
      adapter,
      config: {
        id,
        backend: config.backend,
        modelId: config.modelId,
        displayName: config.displayName,
        maxTokens: config.maxTokens,
        supportsStreaming: true,
        costPer1kTokens: 0,
      },
      loaded: false,
      lastUsed: 0,
      totalRequests: 0,
      totalTokens: 0,
      totalErrors: 0,
      avgLatencyMs: 0,
    });
  }

  /** Register a cloud API adapter */
  registerCloudApi(id: string, config: any): void {
    const adapter = new CloudApiAdapter(config);
    this.adapters.set(id, {
      adapter,
      config: {
        id,
        backend: 'cloud-api',
        modelId: config.modelId,
        displayName: config.displayName,
        maxTokens: config.maxTokens,
        supportsStreaming: true,
        costPer1kTokens: config.costPer1kTokens,
      },
      loaded: true, // cloud is always "loaded"
      lastUsed: 0,
      totalRequests: 0,
      totalTokens: 0,
      totalErrors: 0,
      avgLatencyMs: 0,
    });
  }

  /** Register a CLI adapter (Node.js/Electron only) */
  registerCli(id: string, config: any): void {
    const adapter = new CliAdapter(config);
    this.adapters.set(id, {
      adapter,
      config: {
        id,
        backend: 'cloud-cli',
        modelId: config.modelId,
        displayName: config.displayName,
        maxTokens: config.maxTokens,
        supportsStreaming: true,
        costPer1kTokens: config.costPer1kTokens ?? 0,
      },
      loaded: false,
      lastUsed: 0,
      totalRequests: 0,
      totalTokens: 0,
      totalErrors: 0,
      avgLatencyMs: 0,
    });
  }

  /** Get an adapter entry by ID */
  get(id: string): AdapterEntry | undefined {
    return this.adapters.get(id);
  }

  /** Ensure an adapter is initialized (lazy-load) */
  async ensureLoaded(id: string): Promise<ModelAdapter> {
    const entry = this.adapters.get(id);
    if (!entry) throw new Error(`[Registry] Adapter "${id}" not found`);

    if (!entry.loaded) {
      await entry.adapter.initialize();
      entry.loaded = true;
    }
    return entry.adapter;
  }

  /** Generate through an adapter, tracking usage stats */
  async *generate(id: string, request: GenerateRequest): AsyncGenerator<GenerateChunk> {
    const entry = this.adapters.get(id);
    if (!entry) throw new Error(`[Registry] Adapter "${id}" not found`);

    const start = performance.now();
    let tokens = 0;

    try {
      const adapter = await this.ensureLoaded(id);
      for await (const chunk of adapter.generate(request)) {
        if (chunk.token) tokens++;
        yield chunk;
      }
    } catch (err) {
      entry.totalErrors++;
      throw err;
    } finally {
      const latency = performance.now() - start;
      entry.totalRequests++;
      entry.totalTokens += tokens;
      entry.lastUsed = Date.now();
      // Running average latency
      entry.avgLatencyMs = entry.totalRequests === 1
        ? latency
        : (entry.avgLatencyMs * (entry.totalRequests - 1) + latency) / entry.totalRequests;
    }
  }

  /** List all registered adapters with stats */
  list(): Array<AdapterConfig & { loaded: boolean; stats: { requests: number; tokens: number; errors: number; avgLatencyMs: number } }> {
    return Array.from(this.adapters.values()).map((entry) => ({
      ...entry.config,
      loaded: entry.loaded,
      stats: {
        requests: entry.totalRequests,
        tokens: entry.totalTokens,
        errors: entry.totalErrors,
        avgLatencyMs: Math.round(entry.avgLatencyMs),
      },
    }));
  }

  /** Dispose all adapters */
  async disposeAll(): Promise<void> {
    for (const entry of this.adapters.values()) {
      if (entry.loaded) await entry.adapter.dispose();
    }
    this.adapters.clear();
  }
}
