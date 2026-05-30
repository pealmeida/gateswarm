/**
 * Local Model Adapter — WebGPU / WebNN / WASM via Transformers.js
 */

import type { ModelAdapter, GenerateRequest, GenerateChunk, ExecutionBackend } from './types.js';

export interface LocalAdapterConfig {
  id: string;
  modelId: string;
  displayName: string;
  backend: ExecutionBackend;
  maxTokens: number;
  sizeMB: number;
  minMemoryGB: number;
}

export class LocalAdapter implements ModelAdapter {
  private pipeline: any = null;
  private _available = false;
  private _loading: Promise<void> | null = null;

  constructor(private config: LocalAdapterConfig) {}

  get id(): string { return this.config.id; }
  get backend(): ExecutionBackend { return this.config.backend; }
  get modelId(): string { return this.config.modelId; }
  get isAvailable(): boolean { return this._available; }

  async initialize(): Promise<void> {
    if (this._available) return;
    if (this._loading) { await this._loading; return; }

    this._loading = this.loadModel();
    await this._loading;
    this._loading = null;
  }

  private async loadModel(): Promise<void> {
    try {
      const { pipeline } = await import('@huggingface/transformers');

      this.pipeline = await pipeline('text-generation', this.config.modelId, {
        quantized: true,
        progress_callback: (progress: any) => {
          if (progress.status === 'progress') {
            console.log(`[LocalAdapter] ${this.config.displayName}: ${progress.progress}%`);
          }
        },
      } as any); // quantized is a valid option in @huggingface/transformers

      this._available = true;
      console.log(`[LocalAdapter] Loaded: ${this.config.displayName} (${this.config.backend})`);
    } catch (err) {
      console.error(`[LocalAdapter] Failed to load ${this.config.modelId}:`, err);
      this._available = false;
      throw err;
    }
  }

  async *generate(request: GenerateRequest): AsyncGenerator<GenerateChunk> {
    if (!this.pipeline || !this._available) {
      throw new Error(`[LocalAdapter] ${this.config.displayName} not initialized`);
    }

    const options: Record<string, any> = {
      max_new_tokens: request.maxTokens ?? 256,
      temperature: request.temperature ?? 0.7,
      top_p: request.topP ?? 0.9,
      do_sample: true,
    };

    const prompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n${request.prompt}`
      : request.prompt;

    try {
      // Try streaming
      const stream = await this.pipeline(prompt, { ...options, stream: true });
      for await (const chunk of stream) {
        const token = chunk?.token?.text ?? '';
        if (token) yield { token, done: false };
      }
      yield { token: '', done: true };
    } catch {
      // Fallback: batch generation
      const result = await this.pipeline(prompt, options);
      const text = Array.isArray(result) ? result[0]?.generated_text ?? '' : result?.generated_text ?? '';
      const tokens = text.split(' ');
      for (let i = 0; i < tokens.length; i++) {
        yield { token: i === 0 ? tokens[i] : ' ' + tokens[i], done: i === tokens.length - 1 };
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.pipeline?.dispose) await this.pipeline.dispose();
    this.pipeline = null;
    this._available = false;
  }
}
