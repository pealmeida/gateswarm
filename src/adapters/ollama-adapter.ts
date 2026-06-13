/**
 * Ollama Adapter — Direct HTTP API (works in Node.js and browser via proxy)
 * Ollama exposes a local REST API at http://localhost:11434
 */

import type { ModelAdapter, GenerateRequest, GenerateChunk, ExecutionBackend } from './types.js';

export interface OllamaConfig {
  id: string;
  modelId: string;        // e.g., 'qwen2.5:7b-instruct-q4_K_M'
  displayName: string;
  baseUrl: string;        // e.g., 'http://localhost:11434'
  maxTokens: number;
  costPer1kTokens: number; // always 0 for local
}

export class OllamaAdapter implements ModelAdapter {
  private _available = false;

  constructor(private config: OllamaConfig) {}

  get id(): string { return this.config.id; }
  get backend(): ExecutionBackend { return 'cloud-cli'; }
  get modelId(): string { return this.config.modelId; }
  get isAvailable(): boolean { return this._available; }

  async initialize(): Promise<void> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/tags`);
      if (res.ok) {
        const data = await res.json() as any;
        const models: string[] = (data.models ?? []).map((m: any) => m.name);
        this._available = models.some((m: string) => m === this.config.modelId || m.startsWith(this.config.modelId.split(':')[0]));
        if (this._available) {
          console.log(`[Ollama] Found: ${this.config.modelId}`);
        } else {
          console.warn(`[Ollama] Model ${this.config.modelId} not found. Available: ${models.join(', ')}`);
        }
      }
    } catch (err) {
      console.warn(`[Ollama] Server not reachable at ${this.config.baseUrl}:`, err);
      this._available = false;
    }
  }

  async *generate(request: GenerateRequest): AsyncGenerator<GenerateChunk> {
    if (!this._available) throw new Error(`[Ollama] ${this.config.displayName} not available`);

    const prompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n${request.prompt}`
      : request.prompt;

    const response = await fetch(`${this.config.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.modelId,
        prompt,
        stream: true,
        options: {
          num_predict: request.maxTokens ?? this.config.maxTokens,
          temperature: request.temperature ?? 0.7,
          top_p: request.topP ?? 0.9,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`[Ollama] ${response.status}: ${response.statusText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.response) {
            yield { token: parsed.response, done: false };
          }
          if (parsed.done) {
            yield {
              token: '',
              done: true,
              usage: {
                promptTokens: parsed.prompt_eval_count ?? 0,
                completionTokens: parsed.eval_count ?? 0,
                totalTokens: (parsed.prompt_eval_count ?? 0) + (parsed.eval_count ?? 0),
              },
            };
            return;
          }
        } catch { /* skip malformed */ }
      }
    }
    yield { token: '', done: true };
  }

  async dispose(): Promise<void> {
    this._available = false;
  }
}
