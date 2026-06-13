/**
 * Cloud API Adapter — OpenAI / Anthropic / any OpenAI-compatible API
 * Streams via SSE through edge proxy.
 */

import type { ModelAdapter, GenerateRequest, GenerateChunk, ExecutionBackend } from './types.js';

export interface CloudApiConfig {
  id: string;
  modelId: string;
  displayName: string;
  endpoint: string;         // e.g., '/api/inference'
  provider: 'openai' | 'anthropic' | 'custom';
  maxTokens: number;
  costPer1kTokens: number;
  apiKeyEnvVar?: string;    // only for direct calls (not proxy)
}

export class CloudApiAdapter implements ModelAdapter {
  private _available = false;

  constructor(private config: CloudApiConfig) {}

  get id(): string { return this.config.id; }
  get backend(): ExecutionBackend { return 'cloud-api'; }
  get modelId(): string { return this.config.modelId; }
  get isAvailable(): boolean { return this._available; }

  async initialize(): Promise<void> {
    // Cloud API is always "available" if we're online
    this._available = typeof navigator === 'undefined' || navigator.onLine;
  }

  async *generate(request: GenerateRequest): AsyncGenerator<GenerateChunk> {
    const body = {
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      model: this.config.modelId,
      provider: this.config.provider,
      stream: true,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.7,
    };

    const response = await this.fetchWithRetry(this.config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`[CloudApi] ${response.status}: ${response.statusText}`);
    }

    yield* this.parseSSE(response);
  }

  private async *parseSSE(response: Response): AsyncGenerator<GenerateChunk> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('[CloudApi] No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') { yield { token: '', done: true }; return; }

        try {
          const parsed = JSON.parse(data);
          const token = parsed.token ?? parsed.choices?.[0]?.delta?.content ?? '';
          if (token) yield { token, done: false };
        } catch { /* skip malformed */ }
      }
    }
    yield { token: '', done: true };
  }

  private async fetchWithRetry(url: string, init: RequestInit, retries = 2): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.ok || response.status < 500) return response;
        lastError = new Error(`Server: ${response.status}`);
      } catch (err) { lastError = err as Error; }
      if (attempt < retries) await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
    }
    throw lastError ?? new Error('All retries failed');
  }

  async dispose(): Promise<void> {
    this._available = false;
  }
}
