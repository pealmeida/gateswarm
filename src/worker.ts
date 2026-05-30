/**
 * Local Worker — On-device text generation via Transformers.js / WebLLM
 */

import type { GenerateOptions, GenerationChunk } from './types.js';

export class LocalWorker {
  private pipeline: any = null;
  private modelId: string | null = null;
  private loaded = false;
  private loading: Promise<void> | null = null;

  async initialize(modelId: string): Promise<void> {
    if (this.loaded && this.modelId === modelId) return;

    // Prevent concurrent loads
    if (this.loading) {
      await this.loading;
      return;
    }

    this.loading = this.loadModel(modelId);
    await this.loading;
    this.loading = null;
  }

  private async loadModel(modelId: string): Promise<void> {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');

      // Use local cache when available
      env.allowLocalModels = true;

      this.pipeline = await pipeline('text-generation', modelId, {
        quantized: true,
        progress_callback: (progress: any) => {
          if (progress.status === 'progress') {
            console.log(`[LocalWorker] Loading ${modelId}: ${progress.progress}%`);
          }
        },
      } as any);

      this.modelId = modelId;
      this.loaded = true;
      console.log(`[LocalWorker] Loaded: ${modelId}`);
    } catch (err) {
      console.error(`[LocalWorker] Failed to load ${modelId}:`, err);
      throw err;
    }
  }

  async *generate(
    prompt: string,
    options: GenerateOptions = {}
  ): AsyncGenerator<GenerationChunk> {
    if (!this.pipeline || !this.loaded) {
      throw new Error('[LocalWorker] Not initialized. Call initialize() first.');
    }

    const genOptions = {
      max_new_tokens: options.maxTokens ?? 256,
      temperature: options.temperature ?? 0.7,
      top_p: options.topP ?? 0.9,
      do_sample: true,
      streamer: undefined, // will use callback pattern
    };

    try {
      // Attempt streaming generation
      const stream = await this.pipeline(prompt, {
        ...genOptions,
        stream: true,
      });

      let fullText = '';
      for await (const chunk of stream) {
        const token = chunk?.token?.text ?? '';
        if (token) {
          fullText += token;
          yield { token, done: false };
        }
      }

      yield { token: '', done: true };
    } catch (streamErr) {
      // Fallback to non-streaming
      console.warn('[LocalWorker] Streaming failed, falling back to batch:', streamErr);

      const result = await this.pipeline(prompt, genOptions);
      const text = Array.isArray(result) ? result[0]?.generated_text ?? '' : result?.generated_text ?? '';

      // Simulate streaming by yielding chunks
      const tokens = text.split(' ');
      for (let i = 0; i < tokens.length; i++) {
        yield {
          token: i === 0 ? tokens[i] : ' ' + tokens[i],
          done: i === tokens.length - 1,
        };
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.pipeline && typeof this.pipeline.dispose === 'function') {
      await this.pipeline.dispose();
    }
    this.pipeline = null;
    this.modelId = null;
    this.loaded = false;
    this.loading = null;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get currentModel(): string | null {
    return this.modelId;
  }
}
