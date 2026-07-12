/**
 * GateSwarm MoMA Router v0.5.1 — CLI Provider Adapter
 *
 * Spawns official CLI agents as subprocesses, captures output,
 * and returns OpenAI-compatible responses.
 *
 * Uses the OFFICIAL CLI binary for each agent (Claude Code, Codex, etc.)
 * to respect OAuth authentication and provider policies.
 * NOT a wrapper around raw API calls.
 */

import { spawn } from 'child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export type CliInputFormat = 'stdin' | 'arg';
export type CliOutputFormat = 'stdout-text' | 'stdout-json';
export type CliQuotaType = 'subscription' | 'unlimited' | 'token-bucket';

export interface SubscriptionWindow {
  name: string;       // '5-hour' | 'weekly'
  durationMs: number; // 18_000_000 | 604_800_000
  limit: number;      // 0 = track-only (no enforcement)
  lastReset: number;  // timestamp (ms)
  used: number;       // request count
}

export interface CliProviderConfig {
  command: string;             // e.g., 'claude', 'codex', 'node'
  argsTemplate: string[];      // ['--print', '--model', '{model}', '-p', '{prompt}']
  modelFlag: string;           // '--model'
  inputFormat: CliInputFormat;
  outputFormat: CliOutputFormat;
  timeoutMs: number;
  maxTokens: number;
  env?: Record<string, string>;
  workingDir?: string;
  maxConcurrent: number;       // 1 = serial queue, 0 = unlimited
  modelAlias?: Record<string, string>;  // GateSwarm name → CLI agent name
  healthCheck?: { command: string; expectedExitCode: number };
  quota?: { type: CliQuotaType; windows?: SubscriptionWindow[] };
  contextWindow?: number;      // tokens, for TurboQuant (0 = let gateway use default)
}

export interface CliProviderResult {
  content: string;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
}


function cliContentToText(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);

  if (Array.isArray(content)) {
    return content
      .map((part) => cliContentToText(part))
      .filter((text) => text.trim().length > 0)
      .join('\n');
  }

  if (typeof content === 'object') {
    const record = content as Record<string, any>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.input_text === 'string') return record.input_text;
    if (typeof record.output_text === 'string') return record.output_text;
    if (record.content !== undefined) return cliContentToText(record.content);
    if (record.message !== undefined) return cliContentToText(record.message);
    if (record.prompt !== undefined) return cliContentToText(record.prompt);
    if (record.value !== undefined) return cliContentToText(record.value);
    return JSON.stringify(record);
  }

  return String(content);
}

// ─── Concurrency Limiter ────────────────────────────────

class ConcurrencyLimiter {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.max <= 0 || this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise((resolve) => { this.queue.push(resolve); });
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!();
    } else {
      this.running--;
    }
  }
}

// ─── CLI Provider Adapter ───────────────────────────────

export class CliProviderAdapter {
  private limiter: ConcurrencyLimiter;
  private _lastHealthCheck = 0;
  private _healthOk: boolean | null = null;

  constructor(private cfg: CliProviderConfig) {
    this.limiter = new ConcurrencyLimiter(cfg.maxConcurrent ?? 1);
  }

  /** Check if CLI is available (command exists + quota OK). */
  async isAvailable(): Promise<{ ok: boolean; reason?: string }> {
    // Quota check
    if (this.cfg.quota && this.cfg.quota.type !== 'unlimited') {
      const q = this.checkQuota();
      if (!q.ok) return q;
    }

    // Health check (cached 30s)
    if (this._healthOk !== null && Date.now() - this._lastHealthCheck < 30_000) {
      return this._healthOk ? { ok: true } : { ok: false, reason: 'CLI command not found (cached)' };
    }

    if (this.cfg.healthCheck) {
      try {
        const { execSync } = await import('child_process');
        execSync(this.cfg.healthCheck.command, { timeout: 10_000, stdio: 'ignore' });
        this._healthOk = true;
      } catch {
        this._healthOk = false;
        this._lastHealthCheck = Date.now();
        return { ok: false, reason: `Command "${this.cfg.healthCheck.command}" not found` };
      }
    }

    this._healthOk = true;
    this._lastHealthCheck = Date.now();
    return { ok: true };
  }

  /** Execute chat completion through CLI subprocess. */
  async chatCompletion(
    messages: Array<{ role: string; content: any }>,
    model: string,
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<CliProviderResult> {
    const startTime = Date.now();
    await this.limiter.acquire();

    try {
      const resolvedModel = this.cfg.modelAlias?.[model] ?? model;
      const promptText = this.buildPrompt(messages);
      const args = this.buildArgs(promptText, resolvedModel, options);
      const raw = await this.execSubprocess(args, promptText);
      const content = this.cfg.outputFormat === 'stdout-json'
        ? this.parseJson(raw)
        : this.cleanStdout(raw);

      // Token estimation
      const { estimateTokens } = await import('../token-estimator.js');
      const promptTokens = estimateTokens(promptText);
      const completionTokens = estimateTokens(content);

      // Quota tracking
      this.recordUsage();

      return {
        content: content.trim(),
        model: resolvedModel,
        finishReason: 'stop',
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        latencyMs: Date.now() - startTime,
      };
    } finally {
      this.limiter.release();
    }
  }

  /** Get quota status for /health and /metrics. */
  getQuotaStatus(): Record<string, { used: number; limit: number; resetsIn: string }> {
    const quota = this.cfg.quota;
    if (!quota || quota.type === 'unlimited') return {};

    const now = Date.now();
    const result: Record<string, any> = {};
    for (const w of quota.windows ?? []) {
      const expired = now - w.lastReset > w.durationMs;
      const remaining = expired ? w.durationMs : w.durationMs - (now - w.lastReset);
      result[w.name] = {
        used: expired ? 0 : w.used,
        limit: w.limit,
        resetsIn: expired ? 'now' : `${Math.ceil(remaining / 60_000)}min`,
      };
    }
    return result;
  }

  // ─── Private ────────────────────────────────────────────

  private buildPrompt(messages: Array<{ role: string; content: any }>): string {
    let prompt = '';
    for (const msg of messages) {
      const roleLabel = msg.role === 'system' ? 'System'
        : msg.role === 'user' ? 'User'
        : msg.role === 'assistant' ? 'Assistant'
        : msg.role;
      prompt += `[${roleLabel}]\n${cliContentToText(msg.content)}\n\n`;
    }
    return prompt.trim();
  }

  private buildArgs(prompt: string, model: string, options?: any): string[] {
    return this.cfg.argsTemplate.map((a) =>
      a
        .replace('{model}', model)
        .replace('{prompt}', prompt)
        .replace('{temperature}', String(options?.temperature ?? 0.7))
        .replace('{max_tokens}', String(options?.maxTokens ?? this.cfg.maxTokens)),
    );
  }

  private execSubprocess(args: string[], stdinPrompt?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // For arg-based CLIs, inherit stdin (or ignore) to avoid "no stdin data" warnings.
      // For stdin-based CLIs, use pipe so we can feed the prompt.
      const stdinMode = this.cfg.inputFormat === 'stdin' ? 'pipe' : 'ignore';

      // Capturing to descriptors is more reliable than child stdout/stderr pipes
      // in constrained runtimes, and still preserves separate output streams.
      const captureDir = mkdtempSync(join(tmpdir(), 'gateswarm-cli-'));
      const stdoutPath = join(captureDir, 'stdout');
      const stderrPath = join(captureDir, 'stderr');
      const stdoutFd = openSync(stdoutPath, 'w');
      const stderrFd = openSync(stderrPath, 'w');
      let cleanedUp = false;
      let settled = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        closeSync(stdoutFd);
        closeSync(stderrFd);
      };
      const readCapture = (): { stdout: string; stderr: string } => {
        cleanup();
        try {
          return {
            stdout: readFileSync(stdoutPath, 'utf-8'),
            stderr: readFileSync(stderrPath, 'utf-8'),
          };
        } finally {
          rmSync(captureDir, { recursive: true, force: true });
        }
      };

      const child = spawn(this.cfg.command, args, {
        timeout: this.cfg.timeoutMs,
        env: { ...process.env, ...(this.cfg.env ?? {}) },
        cwd: this.cfg.workingDir,
        stdio: [stdinMode, stdoutFd, stderrFd],
      });

      if (stdinPrompt && this.cfg.inputFormat === 'stdin') {
        // Write the prompt to stdin, then close
        child.stdin?.write(stdinPrompt, 'utf-8', () => {
          child.stdin?.end();
        });
      } else if (this.cfg.inputFormat === 'stdin') {
        // No stdin prompt provided — just close stdin
        child.stdin?.end();
      }

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        const { stdout, stderr } = readCapture();
        if (code !== 0 && stderr.trim()) {
          reject(new Error(`CLI exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
        } else {
          resolve(stdout);
        }
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        rmSync(captureDir, { recursive: true, force: true });
        reject(new Error(`CLI process error: ${err.message}`));
      });
    });
  }

  private parseJson(raw: string): string {
    try {
      const json = JSON.parse(raw.trim());
      return json.content ?? json.response ?? json.text ?? raw;
    } catch {
      return raw;
    }
  }

  private cleanStdout(raw: string): string {
    let text = raw;
    // Strip ANSI escape codes
    text = text.replace(/\x1B\[[0-9;]*[mGKH]/g, '');
    // Strip carriage-return lines (progress indicators)
    text = text.replace(/\r[^\n]*\r/g, '\n');
    // Strip CLI footer noise (tokens, session info, etc.)
    text = text.replace(/^\s*(Tokens|Session|Cost|Time|Duration|Usage):.*$/gm, '');
    // Collapse blank lines
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  private checkQuota(): { ok: boolean; reason?: string } {
    const quota = this.cfg.quota;
    if (!quota || quota.type === 'unlimited') return { ok: true };

    const now = Date.now();
    for (const w of quota.windows ?? []) {
      if (now - w.lastReset > w.durationMs) {
        w.lastReset = now;
        w.used = 0;
      }
      if (w.limit > 0 && w.used >= w.limit) {
        const remaining = w.durationMs - (now - w.lastReset);
        return { ok: false, reason: `Quota exhausted for "${w.name}" window. Resets in ${Math.ceil(remaining / 60_000)}min.` };
      }
    }
    return { ok: true };
  }

  private recordUsage(): void {
    const quota = this.cfg.quota;
    if (!quota || quota.type === 'unlimited') return;

    const now = Date.now();
    for (const w of quota.windows ?? []) {
      if (now - w.lastReset > w.durationMs) {
        w.lastReset = now;
        w.used = 0;
      }
      w.used += 1;
    }
  }
}
