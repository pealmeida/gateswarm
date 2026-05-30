/**
 * Cloud Client — SSE-based cloud fallback via edge proxy
 */

import type { CloudOptions, GenerationChunk } from './types.js';

export class CloudClient {
  private endpoint: string;
  private provider: string;

  constructor(endpoint: string = '/api/inference', provider: string = 'openai') {
    this.endpoint = endpoint;
    this.provider = provider;
  }

  async *complete(
    prompt: string,
    options: CloudOptions = {}
  ): AsyncGenerator<GenerationChunk> {
    const body = {
      prompt,
      model: options.model ?? this.defaultModel,
      provider: this.provider,
      stream: options.stream ?? true,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.7,
    };

    const response = await this.fetchWithRetry(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`[CloudClient] API error: ${response.status} ${response.statusText}`);
    }

    if (options.stream) {
      yield* this.parseSSE(response);
    } else {
      const data = await response.json();
      yield { token: data.text ?? data.content ?? '', done: true };
    }
  }

  private async *parseSSE(response: Response): AsyncGenerator<GenerationChunk> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('[CloudClient] No response body');

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
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          yield { token: '', done: true };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const token = parsed.token ?? parsed.choices?.[0]?.delta?.content ?? '';
          if (token) {
            yield { token, done: false };
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    yield { token: '', done: true };
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retries = 2
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.ok || response.status < 500) return response;
        lastError = new Error(`Server error: ${response.status}`);
      } catch (err) {
        lastError = err as Error;
      }

      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 500; // 500ms, 1000ms
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error('[CloudClient] All retries failed');
  }

  private get defaultModel(): string {
    switch (this.provider) {
      case 'anthropic':
        return 'claude-sonnet-4-20250514';
      case 'openai':
      default:
        return 'gpt-4.1-mini';
    }
  }
}
