# GateSwarm MoMA Router v0.5 — Deep Implementation Plan

> **Date:** 2026-05-17  
> **Status:** Design — ready for implementation  
> **Reference:** [9router](https://github.com/decolua/9router) — CLI-to-OpenAI proxy pattern

---

## 0. 9router Architecture vs GateSwarm Reality

**9router is an HTTP proxy server** (Next.js app on `localhost:20128`). CLI tools (Claude Code, Codex, Cursor) point their API endpoint to 9router:

```
Claude Code ──HTTP──► 9router (proxy + format translation + quota tracking)
                          ├─► Kiro API (free Claude)
                          ├─► OpenCode Free (passthrough)
                          ├─► GLM API (cheap)
                          └─► Anthropic API (subscription via OAuth)
```

9router does NOT spawn Claude Code or Codex as subprocesses. It authenticates to provider APIs (via OAuth tokens, API keys) and serves as a unified OpenAI-compatible endpoint.

**GateSwarm IS the router.** When it needs to route to a CLI agent like Claude Code, it must:
1. **Spawn the CLI as a subprocess** (official CLI, respecting OAuth/policies)
2. **Capture stdout** and parse the response
3. **Wrap into OpenAI format** and return to the caller

This is the **inverse** of 9router's flow. GateSwarm's CLI provider is a **subprocess dispatcher**, not an API proxy.

```
Client ──HTTP──► GateSwarm (classifier + ensemble + TurboQuant)
                     ├─► HTTP providers (bailian, zai, openrouter) — fetch()
                     └─► CLI providers (claude, codex, pi) — spawn()
```

---

## 1. Core Design: The CLI Provider Subprocess Model

### 1.1 Provider Type System

```typescript
// types.ts — additions

export type ProviderType = 'http-api' | 'cli-agent';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  // HTTP providers (existing fields)
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  // CLI providers (NEW)
  cliConfig?: CliProviderConfig;
  // Both types
  maxTokensPerRequest?: number;
}

export interface CliProviderConfig {
  command: string;            // e.g., 'claude', 'codex', 'node'
  argsTemplate: string[];     // args with {model} and {prompt} placeholders
  modelFlag: string;          // flag name for model selection: '--model'
  inputFormat: 'stdin' | 'arg';  // how prompt is delivered
  outputFormat: 'stdout-text' | 'stdout-json';  // how to parse response
  timeoutMs: number;
  maxTokens: number;
  env?: Record<string, string>;  // extra env vars (e.g., ANTHROPIC_API_KEY)
  workingDir?: string;         // cwd for the subprocess
  // Quota tracking
  quota?: SubscriptionQuota;
  // Concurrency
  maxConcurrent: number;       // 1 = serial, 0 = unlimited
  // Model aliases (GateSwarm name → CLI agent name)
  modelAlias?: Record<string, string>;
  // Health check
  healthCheck?: {
    command: string;           // e.g., 'claude --version'
    expectedExitCode: number;
  };
}

export interface SubscriptionQuota {
  type: 'subscription' | 'unlimited' | 'token-bucket';
  // For subscription: tracked windows (5-hour + weekly for Claude Code/Codex)
  windows?: SubscriptionWindow[];
  // For token-bucket: rate limit
  tokensPerWindow?: number;
  windowMs?: number;
  // Current usage (mutable, reset on window expiry)
  used?: number;
  limit?: number;
  lastReset?: number;
}

export interface SubscriptionWindow {
  name: string;          // e.g., '5-hour', 'weekly'
  durationMs: number;    // 5h = 18000000, weekly = 604800000
  limit: number;         // max requests/tokens in this window
  lastReset: number;     // timestamp of last reset
  used: number;          // current usage count
}
```

### 1.2 Model Alias Convention (9router Prefix Notation)

Follow 9router's prefix naming in tier config and `/v1/models`:

| Prefix | Agent | Example Model ID |
|--------|-------|-----------------|
| `cc/` | Claude Code | `cc/claude-sonnet-4-6` |
| `cx/` | Codex | `cx/gpt-5.3-codex` |
| `pi/` | Pi Agent | `pi/qwen3.5-plus` |
| `hm/` | Hermes | `hm/glm-4.7` |
| `oc/` | OpenClaw | `oc/bailian/qwen3.5-plus` |

The prefix is part of the model name as seen by GateSwarm. The `modelAlias` map resolves it:

```json
{
  "modelAlias": {
    "cc/claude-sonnet-4-6": "claude-sonnet-4-6-20250514",
    "cc/claude-opus-4-6": "claude-opus-4-6-20250514",
    "cx/gpt-5.3-codex": "o3",
    "pi/qwen3.5-plus": "qwen3.5-plus"
  }
}
```

---

## 2. Subprocess Dispatch Engine

### 2.1 New File: `src/adapters/cli-provider.ts`

```typescript
/**
 * CLI Provider Adapter — Spawns official CLI agents as subprocesses,
 * captures output, and returns OpenAI-compatible responses.
 *
 * Uses the OFFICIAL CLI binary for each agent (Claude Code, Codex, etc.)
 * to respect OAuth authentication and provider policies.
 * NOT a wrapper around raw API calls.
 */

import { spawn } from 'child_process';
import type { CliProviderConfig, SubscriptionQuota, SubscriptionWindow } from '../types.js';
import { estimateTokens } from '../token-estimator.js';  // NEW: tiktoken wrapper

export interface CliProviderResult {
  content: string;
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
}

// ─── Concurrency Control ──────────────────────────────────

class ConcurrencyLimiter {
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private running = 0;

  constructor(private maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.maxConcurrent <= 0 || this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
    } else {
      this.running--;
    }
  }
}

// ─── Main Adapter ─────────────────────────────────────────

export class CliProviderAdapter {
  private limiter: ConcurrencyLimiter;
  private lastQuotaCheck = 0;

  constructor(private config: CliProviderConfig) {
    this.limiter = new ConcurrencyLimiter(config.maxConcurrent ?? 1);
  }

  /**
   * Check if this CLI provider is available and has quota remaining.
   */
  async isAvailable(): Promise<{ ok: boolean; reason?: string }> {
    // Check quota first
    if (this.config.quota) {
      const quotaOk = this.checkQuota();
      if (!quotaOk.ok) return quotaOk;
    }

    // Check command availability
    if (this.config.healthCheck) {
      const hc = this.config.healthCheck;
      try {
        const { execSync } = await import('child_process');
        execSync(`${hc.command} 2>/dev/null`, { timeout: 10000, stdio: 'ignore' });
      } catch {
        return { ok: false, reason: `Command "${hc.command}" not found` };
      }
    }

    return { ok: true };
  }

  /**
   * Execute a chat completion through the CLI agent subprocess.
   *
   * Flow:
   *   1. Acquire concurrency slot (serial per CLI by default)
   *   2. Resolve model alias
   *   3. Build subprocess command
   *   4. Spawn + capture stdout
   *   5. Parse response based on outputFormat
   *   6. Estimate tokens via tiktoken
   *   7. Update quota tracking
   *   8. Return OpenAI-format result
   */
  async chatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<CliProviderResult> {
    const startTime = Date.now();

    // Step 1: Acquire concurrency slot
    await this.limiter.acquire();

    try {
      // Step 2: Resolve model name
      const resolvedModel = this.config.modelAlias?.[model] ?? model;

      // Step 3: Build prompt text
      const promptText = this.buildPrompt(messages);

      // Step 4: Build subprocess command
      const args = this.buildArgs(promptText, resolvedModel, options);

      // Step 5: Spawn subprocess
      const result = await this.exec(args, promptText);

      // Step 6: Token estimation (tiktoken)
      const promptTokens = estimateTokens(promptText);
      const completionTokens = estimateTokens(result.content);

      // Step 7: Update quota
      this.recordUsage(promptTokens + completionTokens);

      const latencyMs = Date.now() - startTime;

      return {
        content: result.content.trim(),
        model: resolvedModel,
        finishReason: result.exitCode === 0 ? 'stop' : 'error',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        latencyMs,
      };
    } finally {
      this.limiter.release();
    }
  }

  // ─── Prompt Building ────────────────────────────────────

  private buildPrompt(messages: Array<{ role: string; content: string }>): string {
    // For CLI agents, flatten into a readable conversation format.
    // Most CLI agents don't understand multi-turn message arrays — they get
    // a single prompt string. We preserve the conversation structure textually.

    let prompt = '';
    for (const msg of messages) {
      switch (msg.role) {
        case 'system':
          prompt += `[System]\n${msg.content}\n\n`;
          break;
        case 'user':
          prompt += `[User]\n${msg.content}\n\n`;
          break;
        case 'assistant':
          prompt += `[Assistant]\n${msg.content}\n\n`;
          break;
        default:
          prompt += `[${msg.role}]\n${msg.content}\n\n`;
      }
    }
    return prompt.trim();
  }

  // ─── Argument Building ──────────────────────────────────

  private buildArgs(prompt: string, model: string, options?: any): string[] {
    return this.config.argsTemplate.map(arg =>
      arg
        .replace('{model}', model)
        .replace('{prompt}', prompt)
        .replace('{temperature}', String(options?.temperature ?? 0.7))
        .replace('{max_tokens}', String(options?.maxTokens ?? this.config.maxTokens))
    );
  }

  // ─── Subprocess Execution ───────────────────────────────

  private exec(
    args: string[],
    prompt: string
  ): Promise<{ content: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        timeout: this.config.timeoutMs,
        env: { ...process.env, ...this.config.env },
        cwd: this.config.workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      // If input is stdin, write prompt and close
      if (this.config.inputFormat === 'stdin') {
        child.stdin?.write(prompt);
        child.stdin?.end();
      }

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        const exitCode = code ?? 1;

        if (this.config.outputFormat === 'stdout-json') {
          // Try to parse JSON from stdout
          try {
            const json = JSON.parse(stdout.trim());
            resolve({ content: json.content || json.response || json.text || stdout, exitCode });
          } catch {
            // JSON parse failed — return raw stdout
            resolve({ content: stdout.trim(), exitCode });
          }
        } else {
          // Raw text output — strip common CLI noise
          const cleaned = this.cleanStdout(stdout);
          resolve({ content: cleaned, exitCode });
        }
      });

      child.on('error', (err) => {
        reject(new Error(`CLI process error: ${err.message}`));
      });
    });
  }

  // ─── Output Cleaning ────────────────────────────────────

  private cleanStdout(raw: string): string {
    let text = raw;

    // Strip ANSI escape codes
    text = text.replace(/\x1B\[[0-9;]*[mGKH]/g, '');

    // Strip progress indicators (common in Claude Code/Codex)
    text = text.replace(/\r[^\n]*\r/g, '\n');  // carriage return lines

    // Strip common CLI footer noise
    // Claude Code: "Tokens: 1234 → 567"
    // Codex: session metadata lines
    text = text.replace(/^\s*(Tokens|Session|Cost|Time):.*$/gm, '');

    // Collapse multiple blank lines
    text = text.replace(/\n{3,}/g, '\n\n');

    return text.trim();
  }

  // ─── Quota Tracking ─────────────────────────────────────

  private checkQuota(): { ok: boolean; reason?: string } {
    const quota = this.config.quota;
    if (!quota || quota.type === 'unlimited') return { ok: true };

    const now = Date.now();

    // Check each subscription window
    for (const window of quota.windows ?? []) {
      // Reset if window expired
      if (now - window.lastReset > window.durationMs) {
        window.lastReset = now;
        window.used = 0;
      }

      if (window.used >= window.limit) {
        const remaining = window.durationMs - (now - window.lastReset);
        const remainingMin = Math.ceil(remaining / 60000);
        return {
          ok: false,
          reason: `Quota exhausted for "${window.name}" window. Resets in ${remainingMin}min.`,
        };
      }
    }

    return { ok: true };
  }

  private recordUsage(tokens: number): void {
    const quota = this.config.quota;
    if (!quota || quota.type === 'unlimited') return;

    const now = Date.now();

    for (const window of quota.windows ?? []) {
      if (now - window.lastReset > window.durationMs) {
        window.lastReset = now;
        window.used = 0;
      }
      window.used += 1;  // Count requests, not tokens (subscription-based)
    }

    quota.used = (quota.used ?? 0) + 1;
  }

  // ─── Quota Status (for /health and /metrics) ───────────

  getQuotaStatus(): Record<string, { used: number; limit: number; resetsIn: string }> {
    const quota = this.config.quota;
    if (!quota || quota.type === 'unlimited') return {};

    const now = Date.now();
    const result: Record<string, any> = {};

    for (const window of quota.windows ?? []) {
      const expired = now - window.lastReset > window.durationMs;
      const remaining = expired ? window.durationMs : window.durationMs - (now - window.lastReset);
      const resetsIn = expired ? 'now' : `${Math.ceil(remaining / 60000)}min`;

      result[window.name] = {
        used: expired ? 0 : window.used,
        limit: window.limit,
        resetsIn,
      };
    }

    return result;
  }
}
```

### 2.2 Token Estimator: `src/token-estimator.ts`

```typescript
/**
 * Token Estimator — tiktoken wrapper for CLI providers.
 *
 * CLI agents don't report token counts, so we estimate using
 * OpenAI's tiktoken library. Accuracy: ±5-10% vs actual counts.
 *
 * Used by: feedback store, RAG index, benchmark logging,
 *          self-eval, TurboQuant compression ratio display.
 */

let _encoding: any = null;

function getEncoding(): any {
  if (!_encoding) {
    // Lazy-load tiktoken to avoid startup cost
    // Use cl100k_base (GPT-4/Claude tokenizer) — closest match
    // across all major models
    const tiktoken = require('tiktoken');
    _encoding = tiktoken.get_encoding('cl100k_base');
  }
  return _encoding;
}

/**
 * Estimate token count for a text string.
 * Returns approximate token count using cl100k_base encoding.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    const enc = getEncoding();
    return enc.encode(text).length;
  } catch {
    // Fallback: rough estimate (~4 chars per token for English)
    return Math.ceil(text.length / 4);
  }
}

/**
 * Estimate tokens for a message array.
 */
export function estimateMessageTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const msg of messages) {
    // +4 per message (OpenAI overhead)
    total += 4 + estimateTokens(msg.role) + estimateTokens(msg.content);
  }
  // +2 for the assistant reply placeholder
  total += 2;
  return total;
}

/**
 * Dispose the encoding instance (call on shutdown).
 */
export function dispose(): void {
  if (_encoding) {
    try { _encoding.free(); } catch {}
    _encoding = null;
  }
}
```

**Dependencies:** Add `tiktoken` to `package.json`:
```json
"tiktoken": "^1.0.20"
```

---

## 3. Gateway Integration

### 3.1 Dispatch Layer Update: `moma-gateway.ts`

The key change is in `handleChatCompletion()`. Currently it has two code paths:
- **Non-streaming** (`!body.stream`): `fetch()` → parse JSON → extract `data.usage`
- **Streaming** (`body.stream`): `forwardToProvider()` → SSE proxy

For CLI providers, the flow is:

```
handleChatCompletion()
  │
  ├─ isCliProvider(providerId)?
  │   ├─ YES → handleCliProvider()
  │   │   ├─ Spawn CLI subprocess
  │   │   ├─ Capture stdout
  │   │   ├─ Estimate tokens (tiktoken)
  │   │   ├─ Build OpenAI-format response
  │   │   └─ Run feedback/self-eval/RAG pipeline (same as HTTP)
  │   │
  │   └─ NO → existing HTTP fetch() flow
```

#### 3.1.1 New Function: `handleCliProvider()`

```typescript
async function handleCliProvider(
  providerId: string,
  model: string,
  agent: AgentConfig,
  body: any,
  res: ServerResponse,
  effort: EffortLevel,
  v04Score: any,
  compressionResult: any,
  promptText: string
): Promise<void> {
  const cliConfig = agentRegistry.getCliProviderConfig(providerId);
  if (!cliConfig) {
    return jsonResponse(res, 503, {
      error: { message: `CLI provider ${providerId} not configured`, type: 'provider_unavailable' },
    });
  }

  const adapter = agentRegistry.getCliAdapter(providerId);
  const startTime = Date.now();

  try {
    // Check availability (quota + command)
    const avail = await adapter.isAvailable();
    if (!avail.ok) {
      console.log(`⚠️  [${agent.name}] CLI provider ${providerId} unavailable: ${avail.reason}`);
      // Try fallback models
      const fallbackResult = await tryCliFallbacks(providerId, model, agent, body, effort, promptText, compressionResult, res);
      if (fallbackResult) return;
      return jsonResponse(res, 503, {
        error: { message: `CLI provider ${providerId} unavailable: ${avail.reason}`, type: 'provider_unavailable' },
      });
    }

    // Execute CLI
    const result = await adapter.chatCompletion(
      compressionResult.messages,
      model,
      { temperature: body.temperature, maxTokens: body.max_tokens }
    );

    const latency = Date.now() - startTime;
    const tokensIn = result.usage?.promptTokens ?? compressionResult.compressedTokens;
    const tokensOut = result.usage?.completionTokens ?? estimateTokens(result.content);

    // Build OpenAI-format response
    const openaiResponse = {
      id: `chatcmpl-cli-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `${providerId}/${result.model}`,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: result.finishReason,
      }],
      usage: {
        prompt_tokens: tokensIn,
        completion_tokens: tokensOut,
        total_tokens: tokensIn + tokensOut,
      },
    };

    // ─── Run the SAME feedback/self-eval/RAG pipeline as HTTP providers ───

    // Update agent usage
    await agentRegistry.updateUsage(agent.id, tokensIn, tokensOut);

    // Record feedback
    const feedbackId = `${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    recordFeedback({
      prompt: promptText,
      predictedTier: effort,
      actualTier: null,
      modelUsed: `${providerId}/${result.model}`,
      responseTokens: tokensOut,
      adequacyScore: null,
      escalated: false,
      userSatisfaction: null,
    });

    // Self-eval (non-blocking)
    selfEvaluate({
      prompt: promptText,
      response: result.content,
      predictedTier: effort,
      tokensIn,
      tokensOut,
      latencyMs: latency,
    }).then(evalResult => {
      if (evalResult.llmScore !== null && evalResult.predictedCorrectTier) {
        updateAdequacy(feedbackId, evalResult.llmScore, evalResult.predictedCorrectTier);
        calibrateBronze(evalResult.predictedCorrectTier === effort);
      }
    }).catch(() => {});

    // RAG index
    const keywords = promptText.toLowerCase().split(/\s+/)
      .filter((w: string) => w.length > 4);
    addRagEntry({
      keywords: [...new Set(keywords)].slice(0, 10),
      tier: effort,
      modelUsed: `${providerId}/${result.model}`,
      adequacyScore: 1,
      summary: result.content.slice(0, 200),
      originalTokens: tokensIn,
      compressedTokens: compressionResult.compressedTokens,
    });

    // Benchmark logging
    if (agent.benchmarkEnabled) {
      await benchmarkLogger.log({
        prompt: promptText.slice(0, 500),
        prompt_length: promptText.length,
        tier: effort,
        routed_model: `${providerId}/${result.model}`,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        latency_ms: latency,
        provider: providerId,
        status: 'success',
      });
    }

    return jsonResponse(res, 200, openaiResponse);
  } catch (err: any) {
    console.error(`❌ CLI provider error: ${err.message}`);
    return jsonResponse(res, 502, {
      error: { message: `CLI provider error: ${err.message}`, type: 'cli_error' },
    });
  }
}

async function tryCliFallbacks(
  providerId: string,
  model: string,
  agent: AgentConfig,
  body: any,
  effort: EffortLevel,
  promptText: string,
  compressionResult: any,
  res: ServerResponse
): Promise<boolean> {
  const tierCfg = getTierModel(effort);
  const fbModels = (tierCfg as any).fallback_models as Array<{model: string; provider: string}> | undefined;
  if (!fbModels) return false;

  for (const fb of fbModels) {
    if (fb.provider === providerId && fb.model === model) continue;
    const fbCliConfig = agentRegistry.getCliProviderConfig(fb.provider);
    if (!fbCliConfig) {
      // Try HTTP fallback for this provider
      continue;
    }
    const fbAdapter = agentRegistry.getCliAdapter(fb.provider);
    const avail = await fbAdapter.isAvailable();
    if (!avail.ok) continue;

    // Execute fallback
    console.log(`⚠️  [${agent.name}] Fallback to CLI: ${fb.provider}/${fb.model}`);
    return false;  // Let the main handler retry with this provider
  }
  return false;
}
```

### 3.2 Integration Point in `handleChatCompletion()`

```typescript
// In handleChatCompletion(), after resolving providerId and model:

const provider = agentRegistry.getProvider(providerId);

if (provider?.type === 'cli-agent') {
  return handleCliProvider(providerId, model, agent, body, res, effort, v04Score, compressionResult, promptText);
}

// ─── EXISTING: HTTP provider flow ───
// ... (no changes to existing code)
```

### 3.3 Streaming for CLI Providers

**Decision: NO streaming for CLI providers in v0.5.**

Rationale:
- Official CLI tools (Claude Code, Codex) don't emit OpenAI-compatible SSE
- Building an SSE wrapper around subprocess stdout would be complex and fragile
- Some CLIs print progress indicators, ANSI codes, and other noise to stdout
- Risk of breaking provider policies if we try to intercept streaming tokens

**Implementation:** When a streaming request routes to a CLI provider, GateSwarm:
1. Executes the CLI subprocess synchronously (no streaming)
2. Returns the full response as a non-streaming OpenAI response
3. The client sees a slightly longer wait but gets a complete response

```typescript
// In handleChatCompletion(), before the streaming check:
if (body.stream && provider?.type === 'cli-agent') {
  // Downgrade streaming to non-streaming for CLI providers
  body.stream = false;
  console.log(`📝 [${agent.name}] Streaming disabled for CLI provider ${providerId}`);
}
```

---

## 4. Agent Registry Extensions

### 4.1 Updated `agent-registry.ts`

```typescript
// New imports
import { CliProviderAdapter } from './adapters/cli-provider.js';
import type { ProviderType, ProviderConfig, CliProviderConfig } from './types.js';

// Extend ProviderConfig interface
export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;  // NEW: 'http-api' | 'cli-agent'
  baseUrl?: string;
  apiKey?: string;
  models: string[];
  cliConfig?: CliProviderConfig;  // NEW
}

// Add CLI adapter registry
const cliAdapters = new Map<string, CliProviderAdapter>();

// New methods on AgentRegistry class
class AgentRegistry {
  // ... existing methods ...

  getCliProviderConfig(providerId: string): CliProviderConfig | null {
    const provider = this.providers[providerId];
    return provider?.type === 'cli-agent' ? provider.cliConfig ?? null : null;
  }

  getCliAdapter(providerId: string): CliProviderAdapter {
    if (!cliAdapters.has(providerId)) {
      const config = this.getCliProviderConfig(providerId);
      if (!config) throw new Error(`CLI provider ${providerId} not configured`);
      cliAdapters.set(providerId, new CliProviderAdapter(config));
    }
    return cliAdapters.get(providerId)!;
  }

  isCliProvider(providerId: string): boolean {
    return this.providers[providerId]?.type === 'cli-agent';
  }

  isHttpProvider(providerId: string): boolean {
    return this.providers[providerId]?.type === 'http-api';
  }

  // Override getProviderBaseUrl — returns null for CLI providers
  getProviderBaseUrl(providerId: string): string | null {
    if (this.isCliProvider(providerId)) return null;
    return this.providers[providerId]?.baseUrl ?? null;
  }

  // Get quota status for CLI providers (for /health)
  getCliProviderQuotaStatus(providerId: string): Record<string, any> {
    const adapter = cliAdapters.get(providerId);
    return adapter?.getQuotaStatus() ?? {};
  }

  // List all models across all provider types
  listAllModels(): Array<{ id: string; provider: string; type: ProviderType }> {
    const result: Array<{ id: string; provider: string; type: ProviderType }> = [];
    for (const [id, provider] of Object.entries(this.providers)) {
      for (const model of provider.models) {
        result.push({ id: model, provider: id, type: provider.type });
      }
    }
    return result;
  }
}
```

### 4.2 Updated `data/agent-registry.json`

```json
{
  "providers": {
    "bailian": {
      "id": "bailian",
      "name": "Alibaba Bailian (Coding Plan)",
      "type": "http-api",
      "baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1",
      "apiKey": "sk-sp-...",
      "models": ["qwen3.6-plus", "qwen3.5-plus", "qwen3-coder-plus", "qwen3.6-max-preview", "qwen4.6"]
    },
    "zai": {
      "id": "zai",
      "name": "Z.AI (GLM Coding Lite)",
      "type": "http-api",
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "apiKey": "66882e-...",
      "models": ["glm-4.7", "glm-4.7-flash", "glm-5", "glm-5-turbo", "glm-5.1"]
    },
    "openrouter": {
      "id": "openrouter",
      "name": "OpenRouter (Benchmark)",
      "type": "http-api",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "",
      "models": ["owl-alpha", "glm-4.7-flash", "qwen-plus", "gemini-2.5-flash", "claude-sonnet-4.6", "claude-opus-4.6"]
    },

    "claude-cli": {
      "id": "claude-cli",
      "name": "Claude Code CLI",
      "type": "cli-agent",
      "models": ["cc/claude-sonnet-4-6", "cc/claude-opus-4-6", "cc/claude-haiku-4-5"],
      "cliConfig": {
        "command": "claude",
        "argsTemplate": ["--print", "--model", "{model}", "-p", "{prompt}"],
        "modelFlag": "--model",
        "inputFormat": "arg",
        "outputFormat": "stdout-text",
        "timeoutMs": 300000,
        "maxTokens": 64000,
        "maxConcurrent": 1,
        "modelAlias": {
          "cc/claude-sonnet-4-6": "claude-sonnet-4-6-20250514",
          "cc/claude-opus-4-6": "claude-opus-4-6-20250514",
          "cc/claude-haiku-4-5": "claude-haiku-4-5-20251001"
        },
        "healthCheck": { "command": "claude --version", "expectedExitCode": 0 },
        "quota": {
          "type": "subscription",
          "windows": [
            { "name": "5-hour", "durationMs": 18000000, "limit": 0, "lastReset": 0, "used": 0 },
            { "name": "weekly", "durationMs": 604800000, "limit": 0, "lastReset": 0, "used": 0 }
          ]
        }
      }
    },

    "codex-cli": {
      "id": "codex-cli",
      "name": "OpenAI Codex CLI",
      "type": "cli-agent",
      "models": ["cx/gpt-5.3-codex", "cx/gpt-4.1"],
      "cliConfig": {
        "command": "codex",
        "argsTemplate": ["exec", "--model", "{model}", "-p", "{prompt}"],
        "modelFlag": "--model",
        "inputFormat": "arg",
        "outputFormat": "stdout-text",
        "timeoutMs": 300000,
        "maxTokens": 64000,
        "maxConcurrent": 1,
        "modelAlias": {
          "cx/gpt-5.3-codex": "o3",
          "cx/gpt-4.1": "gpt-4.1"
        },
        "healthCheck": { "command": "codex --version", "expectedExitCode": 0 },
        "quota": {
          "type": "subscription",
          "windows": [
            { "name": "5-hour", "durationMs": 18000000, "limit": 0, "lastReset": 0, "used": 0 },
            { "name": "weekly", "durationMs": 604800000, "limit": 0, "lastReset": 0, "used": 0 }
          ]
        }
      }
    },

    "pi-agent": {
      "id": "pi-agent",
      "name": "Pi Agent (local)",
      "type": "cli-agent",
      "models": ["pi/qwen3.5-plus", "pi/glm-4.7-flash"],
      "cliConfig": {
        "command": "node",
        "argsTemplate": ["~/.pi/agent/src/index.js", "--json", "-p", "{prompt}"],
        "modelFlag": "--model",
        "inputFormat": "arg",
        "outputFormat": "stdout-json",
        "timeoutMs": 120000,
        "maxTokens": 32000,
        "maxConcurrent": 2,
        "modelAlias": {
          "pi/qwen3.5-plus": "qwen3.5-plus",
          "pi/glm-4.7-flash": "glm-4.7-flash"
        },
        "healthCheck": { "command": "ls ~/.pi/agent/src/index.js", "expectedExitCode": 0 }
      }
    },

    "hermes-agent": {
      "id": "hermes-agent",
      "name": "Hermes Agent (self-improving)",
      "type": "cli-agent",
      "models": ["hm/glm-4.7", "hm/glm-4.7-flash"],
      "cliConfig": {
        "command": "node",
        "argsTemplate": ["/usr/local/lib/hermes-agent/src/agent.js", "--json", "-p", "{prompt}"],
        "modelFlag": "--model",
        "inputFormat": "arg",
        "outputFormat": "stdout-json",
        "timeoutMs": 120000,
        "maxTokens": 32000,
        "maxConcurrent": 2,
        "modelAlias": {
          "hm/glm-4.7": "glm-4.7",
          "hm/glm-4.7-flash": "glm-4.7-flash"
        },
        "healthCheck": { "command": "ls /usr/local/lib/hermes-agent/src/agent.js", "expectedExitCode": 0 }
      }
    },

    "openclaw-agent": {
      "id": "openclaw-agent",
      "name": "OpenClaw Agent (sessions_spawn)",
      "type": "cli-agent",
      "models": ["oc/bailian/qwen3.5-plus", "oc/zai/glm-4.7-flash"],
      "cliConfig": {
        "command": "openclaw",
        "argsTemplate": ["agent", "--agent", "missionops", "--message", "{prompt}", "--timeout", "120"],
        "modelFlag": "--model",
        "inputFormat": "arg",
        "outputFormat": "stdout-text",
        "timeoutMs": 180000,
        "maxTokens": 32000,
        "maxConcurrent": 3,
        "modelAlias": {
          "oc/bailian/qwen3.5-plus": "bailian/qwen3.5-plus",
          "oc/zai/glm-4.7-flash": "zai/glm-4.7-flash"
        }
      }
    }
  },

  "agents": {
    "default": {
      "id": "default",
      "name": "default",
      "apiKey": "moma-...",
      "provider": "moma",
      "tierConfig": {
        "trivial": "qwen3.5-plus",
        "light": "glm-4.7-flash",
        "moderate": "qwen3-coder-plus",
        "heavy": "cc/claude-sonnet-4-6",
        "intensive": "cc/claude-opus-4-6",
        "extreme": "cc/claude-opus-4-6"
      },
      "benchmarkEnabled": true,
      "maxTokensPerRequest": 65536,
      "createdAt": "2026-05-15T14:56:29.494Z",
      "lastUsed": null,
      "requestCount": 0,
      "totalTokensIn": 72,
      "totalTokensOut": 2079
    },
    "claude-quality": {
      "id": "claude-quality",
      "name": "claude-quality",
      "apiKey": "moma-...",
      "provider": "claude-cli",
      "tierConfig": {
        "trivial": "qwen3.5-plus",
        "light": "glm-4.7-flash",
        "moderate": "cc/claude-sonnet-4-6",
        "heavy": "cc/claude-sonnet-4-6",
        "intensive": "cc/claude-opus-4-6",
        "extreme": "cc/claude-opus-4-6"
      },
      "benchmarkEnabled": true,
      "maxTokensPerRequest": 65536,
      "createdAt": "2026-05-17T20:00:00.000Z",
      "lastUsed": null,
      "requestCount": 0,
      "totalTokensIn": 0,
      "totalTokensOut": 0
    },
    "codex-heavy": {
      "id": "codex-heavy",
      "name": "codex-heavy",
      "apiKey": "moma-...",
      "provider": "codex-cli",
      "tierConfig": {
        "trivial": "qwen3.5-plus",
        "light": "glm-4.7-flash",
        "moderate": "qwen3-coder-plus",
        "heavy": "cx/gpt-5.3-codex",
        "intensive": "cx/gpt-5.3-codex",
        "extreme": "cc/claude-opus-4-6"
      },
      "benchmarkEnabled": true,
      "maxTokensPerRequest": 65536,
      "createdAt": "2026-05-17T20:00:00.000Z",
      "lastUsed": null,
      "requestCount": 0,
      "totalTokensIn": 0,
      "totalTokensOut": 0
    }
  },

  "defaultAgentId": "default"
}
```

---

## 5. Impact on Existing Features

### 5.1 TurboQuant Compression

**No changes needed.** TurboQuant runs BEFORE provider dispatch, on the incoming message array. It compresses regardless of which provider will handle the request. The `compressionResult.messages` is passed to both HTTP and CLI providers identically.

The only addition: CLI models need entries in `MODEL_CONTEXT_WINDOWS` for dynamic threshold calculation:

```typescript
// turboquant-compressor.ts — additions
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // ... existing entries ...

  // CLI providers
  'cc/claude-sonnet-4-6': 200_000,
  'cc/claude-opus-4-6': 200_000,
  'cc/claude-haiku-4-5': 200_000,
  'cx/gpt-5.3-codex': 128_000,
  'cx/gpt-4.1': 1_000_000,
  'pi/qwen3.5-plus': 1_000_000,
  'pi/glm-4.7-flash': 200_000,
  'hm/glm-4.7': 200_000,
  'hm/glm-4.7-flash': 200_000,
  'oc/bailian/qwen3.5-plus': 1_000_000,
  'oc/zai/glm-4.7-flash': 200_000,
};
```

### 5.2 Self-Evaluation & LLM Judge

**Works with estimated tokens.** The `quickEval()` heuristic uses:
- `tokensIn` → tiktoken estimate (accurate enough for heuristic scoring)
- `tokensOut` → tiktoken estimate (same)
- `latencyMs` → actual measurement (more accurate for CLI since we measure the full subprocess)
- `response text` → same

The LLM judge (async `selfEvaluate`) calls `bailian/qwen3.6-plus` via HTTP — unaffected.

**Tier expected token ranges** in `self-eval.ts` are model-agnostic and apply to CLI responses the same way.

### 5.3 Feedback Store

**No schema changes.** `FeedbackEntry` already has:
- `predictedTier`: unchanged
- `actualTier`: unchanged (set by LLM judge)
- `modelUsed`: now includes CLI providers like `claude-cli/cc/claude-sonnet-4-6`
- `responseTokens`: estimated via tiktoken (flagged as `~` in any UI)

### 5.4 RAG Index

**No changes.** RAG stores compressed summaries keyed by keywords. The source (HTTP vs CLI) doesn't matter for retrieval. The `originalTokens` field will be estimated for CLI.

### 5.5 Benchmark Logging

**No changes.** The benchmark logger records `tokens_in`, `tokens_out`, `latency_ms`, `provider`, `routed_model`. CLI values are estimated but still useful for trends.

### 5.6 Ensemble Voter

**No changes.** The ensemble voter (heuristic + cascade + RAG + history) classifies prompt complexity independently of provider type. The output is a tier, not a provider. Provider selection happens after classification.

### 5.7 Training Mode

**No changes.** Training mode collects votes on tier classification accuracy. The classifier works the same regardless of which provider handles the request.

### 5.8 Session Continuity

**Works identically.** Continuity tracks `lastModel` and `keyDecisions` per session. CLI model names (e.g., `claude-cli/cc/claude-sonnet-4-6`) are stored the same way as HTTP model names.

### 5.9 Message Sanitization

**Light sanitization for CLI providers only.**

The current `sanitizeMessages()` has 7 phases specifically for Bailian/ZAI quirks. For CLI providers:

```typescript
const sanitizeForCli = (msgs: any[]): any[] => {
  if (msgs.length <= 1) return [...msgs];

  // Phase 1: Move system messages to front
  const systemMsgs = msgs.filter(m => m.role === 'system');
  const nonSystemMsgs = msgs.filter(m => m.role !== 'system');

  // Phase 2: Merge consecutive same-role messages
  // (CLI agents handle multi-turn better than Bailian/ZAI)
  const merged: any[] = [];
  for (const msg of nonSystemMsgs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role && msg.role !== 'tool') {
      const prevContent = typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content);
      const currContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      prev.content = prevContent + '\n---\n' + currContent;
    } else {
      merged.push({ ...msg });
    }
  }

  return [...systemMsgs, ...merged];
};
```

Key differences from full sanitization:
- **No Phase 3-7**: No need to ensure user-first, no orphaned tool removal, no empty content filtering
- **CLI agents are more lenient** with message sequences
- **Tool messages preserved as-is** (Claude Code supports tool calling natively)

---

## 6. Quota Tracking Implementation

### 6.1 Subscription Window Model

Claude Code and Codex use **rolling windows**:
- 5-hour window: resets every 5 hours from first usage
- Weekly window: resets every 7 days

```typescript
interface SubscriptionWindow {
  name: string;        // '5-hour' | 'weekly'
  durationMs: number;  // 18_000_000 | 604_800_000
  limit: number;       // 0 = auto-detect from CLI output, or set manually
  lastReset: number;   // timestamp
  used: number;        // request count
}
```

**Limit auto-detection**: Since subscription limits vary by plan (Free/Pro/Max/Plus), the default `limit: 0` means "track usage but don't enforce." Users can set explicit limits in the config:

```json
"quota": {
  "type": "subscription",
  "windows": [
    { "name": "5-hour", "durationMs": 18000000, "limit": 50, "lastReset": 0, "used": 0 },
    { "name": "weekly", "durationMs": 604800000, "limit": 500, "lastReset": 0, "used": 0 }
  ]
}
```

### 6.2 Quota Status Endpoint

Extend `/health` and `/metrics` to include CLI provider quota info:

```typescript
// In /health handler:
{
  providers: agentRegistry.getProviders().map(p => {
    const base = { id: p.id, name: p.name, type: p.type };
    if (p.type === 'cli-agent') {
      return { ...base, quota: agentRegistry.getCliProviderQuotaStatus(p.id) };
    }
    return base;
  }),
}
```

---

## 7. Health & Metrics Updates

### 7.1 `/health` Response

```json
{
  "status": "healthy",
  "router": "GateSwarm MoMA Router v0.5.0",
  "providers": [
    { "id": "bailian", "name": "Alibaba Bailian", "type": "http-api" },
    { "id": "claude-cli", "name": "Claude Code CLI", "type": "cli-agent",
      "quota": { "5-hour": { "used": 12, "limit": 50, "resetsIn": "3h 22m" }, "weekly": { "used": 87, "limit": 500, "resetsIn": "2d 14h" } } },
    { "id": "codex-cli", "name": "Codex CLI", "type": "cli-agent",
      "quota": { "5-hour": { "used": 0, "limit": 0, "resetsIn": "now" } } }
  ],
  "cliProviders": [
    { "id": "claude-cli", "available": true, "command": "claude", "maxConcurrent": 1 },
    { "id": "codex-cli", "available": false, "reason": "Command 'codex' not found" }
  ]
}
```

### 7.2 `/v1/models` Response

Extended to include CLI provider models with prefix notation:

```json
{
  "object": "list",
  "data": [
    { "id": "moma-router", "owned_by": "moma" },
    { "id": "bailian/qwen3.6-plus", "owned_by": "bailian" },
    { "id": "cc/claude-sonnet-4-6", "owned_by": "claude-cli" },
    { "id": "cc/claude-opus-4-6", "owned_by": "claude-cli" },
    { "id": "cx/gpt-5.3-codex", "owned_by": "codex-cli" },
    { "id": "pi/qwen3.5-plus", "owned_by": "pi-agent" },
    { "id": "hm/glm-4.7", "owned_by": "hermes-agent" },
    { "id": "oc/bailian/qwen3.5-plus", "owned_by": "openclaw-agent" }
  ]
}
```

---

## 8. Context Windows for CLI Models

**Rule:** When adding a new CLI provider, the context window must be known before use. Options:
1. **Lookup from official docs** (Claude: 200K, GPT-4.1: 1M, etc.)
2. **User-provided** via `gateswarm` CLI command: `gateswarm provider add claude-cli --context-window 200000`
3. **Default fallback**: 32K if unknown

Add to `MODEL_CONTEXT_WINDOWS` at registration time, not hardcoded:

```typescript
// In agent-registry.ts, when loading CLI provider config:
function registerCliProvider(config: ProviderConfig): void {
  const cliConfig = config.cliConfig!;
  for (const model of config.models) {
    // Register context window if not already known
    if (!MODEL_CONTEXT_WINDOWS[model]) {
      MODEL_CONTEXT_WINDOWS[model] = cliConfig.contextWindow ?? 32_000;
    }
  }
}
```

---

## 9. enable_thinking / Reasoning for CLI Providers

**Decision: Drop reasoning for CLI providers.** They use the model's default behavior.

In the dispatch layer:

```typescript
// In handleChatCompletion(), when building the payload for CLI:
// Do NOT pass enable_thinking to CLI providers — they use model defaults
if (provider?.type === 'cli-agent') {
  delete body.enable_thinking;
  delete body.thinking;
}
```

This is consistent with 9router's approach: the model's default reasoning behavior applies. Users who want thinking mode should configure their CLI agent directly (e.g., Claude Code's `--beta-thinking` flag in their local config).

---

## 10. Fallback Chains with Mixed HTTP + CLI Providers

The fallback chain logic in v0.4.4 already supports multiple providers. With CLI providers, we extend it to handle mixed chains:

```json
{
  "tier_models": {
    "heavy": {
      "model": "qwen3.6-plus",
      "provider": "bailian",
      "max_tokens": 64000,
      "fallback_models": [
        { "model": "cc/claude-sonnet-4-6", "provider": "claude-cli" },
        { "model": "cx/gpt-5.3-codex", "provider": "codex-cli" },
        { "model": "glm-5.1", "provider": "zai" }
      ]
    }
  }
}
```

The fallback resolver checks each provider type:

```typescript
async function tryFallbackChain(
  primaryProviderId: string,
  fallbackModels: Array<{ model: string; provider: string }>,
  ...args
): Promise<any> {
  // Try primary first (existing HTTP flow)
  // Then iterate fallbacks:
  for (const fb of fallbackModels) {
    const provider = agentRegistry.getProvider(fb.provider);
    if (provider?.type === 'cli-agent') {
      // Check CLI availability
      const adapter = agentRegistry.getCliAdapter(fb.provider);
      const avail = await adapter.isAvailable();
      if (!avail.ok) {
        console.log(`⚠️  Fallback ${fb.provider}/${fb.model} unavailable: ${avail.reason}`);
        continue;
      }
      // Execute CLI fallback
      return handleCliProvider(fb.provider, fb.model, ...args);
    } else {
      // HTTP fallback (existing flow)
      const result = await forwardToProvider(fb.provider, fb.model, ...args);
      if (result) return result;
    }
  }
  return null; // All fallbacks exhausted
}
```

---

## 11. Implementation Phases (Updated)

### Phase 1: Infrastructure (2-3 days)
- [ ] Add `ProviderType`, `CliProviderConfig`, `SubscriptionQuota` types to `types.ts`
- [ ] Create `src/token-estimator.ts` (tiktoken wrapper)
- [ ] Create `src/adapters/cli-provider.ts` (subprocess dispatcher)
- [ ] Extend `agent-registry.ts` with CLI methods (`getCliProviderConfig`, `getCliAdapter`, `isCliProvider`, quota tracking)
- [ ] Add CLI provider entries to `data/agent-registry.json`
- [ ] Add CLI models to `MODEL_CONTEXT_WINDOWS`

### Phase 2: Gateway Integration (3-4 days)
- [ ] Add `handleCliProvider()` function to `moma-gateway.ts`
- [ ] Wire dispatch: `if (provider.type === 'cli-agent') → handleCliProvider()`
- [ ] Implement light sanitization for CLI providers
- [ ] Disable streaming for CLI providers (downgrade to non-streaming)
- [ ] Implement fallback chain with mixed HTTP + CLI providers
- [ ] Token estimation in all downstream pipelines (feedback, self-eval, RAG, benchmark)

### Phase 3: CLI Agent Wrappers (4-5 days)
- [ ] Claude Code wrapper: test `claude --print` in our environment
- [ ] Codex wrapper: test `codex exec` in our environment
- [ ] Pi wrapper: subprocess with `--json` flag
- [ ] Hermes wrapper: subprocess with `--json` flag
- [ ] OpenClaw wrapper: `openclaw agent` command
- [ ] Test each wrapper with GateSwarm routing end-to-end

### Phase 4: Quota, Health & Agent Profiles (3-4 days)
- [ ] Subscription quota tracking with window auto-reset
- [ ] CLI provider health checks in `/health`
- [ ] CLI quota status in `/metrics`
- [ ] New agent profiles (`claude-quality`, `codex-heavy`) with CLI-first tier configs
- [ ] `/v1/models` extended with CLI provider models (prefix notation)
- [ ] `gateswarm` CLI commands for managing CLI providers

### Phase 5: Hardening (3-4 days)
- [ ] Concurrency limiter stress testing (serial vs parallel CLI invocations)
- [ ] stdout noise cleaning (ANSI codes, progress indicators)
- [ ] Timeout handling and graceful process cleanup
- [ ] Error categorization (command not found, auth error, quota exhausted, process crash)
- [ ] Documentation and setup guide

---

## 12. Limitations & Known Trade-offs

| Limitation | Impact | Mitigation |
|-----------|--------|-----------|
| No streaming for CLI providers | Longer latency perception for large responses | Set appropriate client timeouts; CLI responses are typically fast |
| Token estimation (±5-10%) | Feedback/self-eval metrics are approximate | Flag as estimated in UI; use for trends, not precise accounting |
| Serial execution per CLI agent | Throughput limited to 1 request at a time per CLI | Configure `maxConcurrent: 2` for Pi/Hermes (can handle parallel) |
| stdout noise | Response may contain CLI progress text | `cleanStdout()` strips ANSI codes, CR lines, footers |
| No `enable_thinking` for CLI | Models use default reasoning behavior | Configure thinking in the agent's own config files |
| Quota tracking is request-based | Doesn't track token-level subscription usage | Set manual limits; refine later with CLI output parsing |
| Context windows must be manually configured | New CLI models need context window entries | `gateswarm provider add` command requires `--context-window` flag |
| Process isolation | Each CLI invocation starts fresh (no conversation context beyond what's passed) | GateSwarm passes full message history as prompt text |

---

## 13. Success Criteria

1. **Functional:** GateSwarm routes to at least 2 CLI agents with correct OpenAI-format responses
2. **Fallback:** Mixed HTTP + CLI fallback chains work (e.g., bailian → claude-cli → zai)
3. **Observable:** CLI provider status, quota, and health visible in `/health` and `/metrics`
4. **Compatible:** Existing HTTP-only routing, TurboQuant, feedback, RAG, self-eval all work with CLI providers
5. **Safe:** CLI subprocesses are properly cleaned up on timeout/error; no zombie processes
6. **Accurate:** Token estimates within ±10% of actual counts (validated on at least 10 requests)
