/**
 * CLI Adapter — Run local CLI inference tools (ollama, llama.cpp, mlx, etc.)
 * Works in Node.js/Electron environments; not available in pure browser.
 */

import type { ModelAdapter, GenerateRequest, GenerateChunk, ExecutionBackend } from './types.js';

export interface CliConfig {
  id: string;
  modelId: string;
  displayName: string;
  command: string;           // e.g., 'ollama run qwen2.5:0.5b'
  argsFormat?: string;       // e.g., '--prompt "{prompt}" --temp {temp}'
  maxTokens: number;
  costPer1kTokens: number;
  timeout: number;           // ms
}

export class CliAdapter implements ModelAdapter {
  private _available = false;
  private isNode: boolean;

  constructor(private config: CliConfig) {
    // CLI adapter only works in Node.js / Electron
    this.isNode = typeof process !== 'undefined' && !!process.versions?.node;
  }

  get id(): string { return this.config.id; }
  get backend(): ExecutionBackend { return 'cloud-cli'; }
  get modelId(): string { return this.config.modelId; }
  get isAvailable(): boolean { return this._available; }

  async initialize(): Promise<void> {
    if (!this.isNode) {
      console.warn('[CliAdapter] Not available in browser environment');
      this._available = false;
      return;
    }

    // Check if command exists
    try {
      const { execSync } = await import('child_process');
      const baseCmd = this.config.command.split(' ')[0];
      execSync(`which ${baseCmd} 2>/dev/null || where ${baseCmd} 2>nul`, { stdio: 'ignore' });
      this._available = true;
    } catch {
      this._available = false;
      console.warn(`[CliAdapter] ${this.config.command} not found`);
    }
  }

  async *generate(request: GenerateRequest): AsyncGenerator<GenerateChunk> {
    if (!this._available || !this.isNode) {
      throw new Error(`[CliAdapter] ${this.config.displayName} not available`);
    }

    const { spawn } = await import('child_process');
    const prompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n${request.prompt}`
      : request.prompt;

    const args = this.buildArgs(prompt, request);
    const cmdParts = this.config.command.split(' ');
    const baseCmd = cmdParts[0];
    const baseArgs = cmdParts.slice(1).concat(args);

    const child = spawn(baseCmd, baseArgs, { timeout: this.config.timeout });

    let buffer = '';
    let resolved = false;

    const stream = new ReadableStream<string>({
      start(controller) {
        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          // Yield line by line for streaming effect
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              controller.enqueue(line);
            }
          }
        });

        child.stderr?.on('data', (data: Buffer) => {
          console.warn(`[CliAdapter] stderr: ${data.toString()}`);
        });

        child.on('close', (code) => {
          if (!resolved) {
            resolved = true;
            controller.close();
          }
        });

        child.on('error', (err) => {
          console.error(`[CliAdapter] Error: ${err.message}`);
          if (!resolved) {
            resolved = true;
            controller.close();
          }
        });
      },
    });

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield { token: value + '\n', done: false };
      }
      yield { token: '', done: true };
    } finally {
      reader.releaseLock();
      if (!child.killed) child.kill();
    }
  }

  private buildArgs(prompt: string, request: GenerateRequest): string[] {
    if (this.config.argsFormat) {
      return [this.config.argsFormat
        .replace('{prompt}', prompt.replace(/"/g, '\\"'))
        .replace('{temp}', String(request.temperature ?? 0.7))
        .replace('{max_tokens}', String(request.maxTokens ?? 256))];
    }
    // Default: pass prompt via stdin (piped), with minimal args
    return [];
  }

  async dispose(): Promise<void> {
    this._available = false;
  }
}
