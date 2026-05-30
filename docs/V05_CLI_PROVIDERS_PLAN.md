# GateSwarm MoMA Router v0.5 — CLI Agent Providers Plan

> **Date:** 2026-05-17  
> **Status:** Planning  
> **Reference:** [9router](https://github.com/decolua/9router) — proven pattern for wrapping CLI agents as OpenAI-compatible providers

## 1. Problem Statement

GateSwarm v0.4 only routes to **HTTP API providers** (Bailian, ZAI, OpenRouter). It cannot leverage:

- **Claude Code** (`claude` CLI) — access to Claude models via Anthropic CLI
- **Codex** (`openai-codex` / `codex` CLI) — access to GPT models via OpenAI CLI  
- **Pi** (`~/.pi/agent/`) — local agent with its own model routing
- **Hermes** (`/usr/local/lib/hermes-agent/`) — self-improving agent (ZAI/GLM)
- **OpenClaw** (`openclaw agent`) — our own orchestration agent runner

These are all **CLI-based agents** that can run inference locally or via their own provider accounts, but GateSwarm has no way to dispatch to them.

## 2. Inspiration: What 9router Does Right

9router's core innovation is the **CLI-to-OpenAI proxy** pattern:

```
┌─────────────┐
│ Your CLI    │ (Claude Code, Codex, OpenClaw...)
│ Tool        │ sends OpenAI-format requests
└──────┬──────┘
       │ http://localhost:20128/v1
       ↓
┌─────────────────────────────────────────────┐
│ 9Router (Smart Router)                      │
│ • CLI agent wrappers (subprocess/stdio)     │
│ • Format translation (OpenAI ↔ Claude)      │
│ • Quota tracking per subscription           │
│ • Auto-fallback across agent types          │
└──────┬──────────────────────────────────────┘
       │
       ├─→ [Tier 1] Claude Code CLI (subscription)
       ├─→ [Tier 2] Codex CLI (subscription)  
       ├─→ [Tier 3] GLM API (cheap)
       └─→ [Tier 4] Kiro/OpenCode (free)
```

**Key lessons for GateSwarm:**
1. CLI agents are wrapped as **local HTTP endpoints** (stdio → HTTP bridge)
2. Format translation is automatic (OpenAI ↔ Claude ↔ Gemini)
3. Quota/subscription tracking drives fallback decisions
4. The router is **agent-agnostic** — just routes to "providers"

## 3. Architecture: v0.5 CLI Provider Layer

### 3.1 High-Level Design

```
                    ┌─────────────────────────┐
                    │   GateSwarm Gateway      │
                    │   (moma-gateway.ts)       │
                    │                          │
  OpenAI req ──────►│ classify → route ───────►│ dispatch
                    │                          │
                    └─────────┬───────────────┬┘
                              │               │
                    ┌─────────▼──────┐ ┌──────▼──────────┐
                    │ HTTP Provider  │ │ CLI Provider     │
                    │ (existing)     │ │ (NEW v0.5)       │
                    │                │ │                  │
                    │ bailian, zai,  │ │ claude, codex,   │
                    │ openrouter     │ │ pi, hermes,      │
                    │                │ │ openclaw          │
                    │ fetch(url)     │ │ spawn(agent)     │
                    └────────────────┘ └──────┬───────────┘
                                              │
                                    ┌─────────▼──────────┐
                                    │ Agent Process/HTTP │
                                    │                    │
                                    │ claude --print     │
                                    │ codex exec         │
                                    │ Pi agent API       │
                                    │ Hermes agent API   │
                                    │ openclaw agent     │
                                    └────────────────────┘
```

### 3.2 Provider Type Enum

Extend the provider model to distinguish HTTP vs CLI:

```typescript
// types.ts — new provider type
export type ProviderType = 'http-api' | 'cli-agent';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;  // NEW
  // HTTP providers (existing)
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  // CLI providers (NEW)
  cliConfig?: CliProviderConfig;
}

export interface CliProviderConfig {
  command: string;           // e.g., 'claude', 'codex', 'openclaw'
  argsTemplate: string[];    // args template, e.g., ['--print', '--model', '{model}']
  modelFlag: string;         // how to specify model: '--model' | '-m' | etc.
  modelAlias: Record<string, string>;  // moma model name → agent model name
  inputFormat: 'stdin' | 'arg' | 'file';  // how to pass prompt
  outputFormat: 'stdout' | 'json' | 'sse';  // how to parse response
  timeoutMs: number;
  maxTokens: number;
  env?: Record<string, string>;  // extra env vars (API keys, etc.)
  quota?: {
    type: 'subscription' | 'unlimited' | 'token-bucket';
    limit?: number;
    resetMs?: number;
    used?: number;
  };
}
```

### 3.3 CLI Provider Adapter

New file: `src/adapters/cli-provider.ts`

```typescript
/**
 * CLI Provider Adapter — Wraps CLI agents as OpenAI-compatible providers.
 * 
 * Converts OpenAI chat/completions requests into CLI invocations,
 * parses stdout/stderr, and returns OpenAI-format responses.
 */

import { spawn } from 'child_process';
import type { CliProviderConfig } from './types.js';

export interface CliProviderResult {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  finishReason: string;
}

export class CliProviderAdapter {
  constructor(private config: CliProviderConfig) {}

  /**
   * Execute a chat completion through the CLI agent.
   * 
   * Strategy varies by agent type:
   * - Claude Code: `claude --print --model {model} -p "{prompt}"`
   * - Codex: `codex exec --model {model} --prompt "{prompt}"`
   * - OpenClaw: `openclaw agent --agent {id} --message "{prompt}"`
   * - Pi/Hermes: subprocess or HTTP call to their local API
   */
  async chatCompletion(
    messages: Array<{ role: string; content: string }>,
    model: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<CliProviderResult> {
    const resolvedModel = this.config.modelAlias?.[model] ?? model;
    const promptText = this.buildPrompt(messages);

    switch (this.config.outputFormat) {
      case 'stdout':
        return this.execStdout(promptText, resolvedModel, options);
      case 'json':
        return this.execJson(promptText, resolvedModel, options);
      case 'sse':
        return this.execSse(promptText, resolvedModel, options);
      default:
        return this.execStdout(promptText, resolvedModel, options);
    }
  }

  private buildPrompt(messages: Array<{ role: string; content: string }>): string {
    // Flatten messages into a single prompt string
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs = messages.filter(m => m.role === 'user').map(m => m.content);
    
    let prompt = '';
    if (systemMsg) prompt += `[System] ${systemMsg.content}\n\n`;
    prompt += userMsgs.join('\n\n');
    return prompt;
  }

  private execStdout(prompt: string, model: string, options?: any): Promise<CliProviderResult> {
    return new Promise((resolve, reject) => {
      const args = this.config.argsTemplate
        .map(a => a.replace('{model}', model).replace('{prompt}', prompt));
      
      const child = spawn(this.config.command, args, {
        timeout: this.config.timeoutMs,
        env: { ...process.env, ...this.config.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`CLI exited with code ${code}: ${stderr}`));
          return;
        }
        resolve({
          content: stdout.trim(),
          model,
          finishReason: code === 0 ? 'stop' : 'error',
        });
      });

      child.on('error', reject);
    });
  }

  // execJson: for agents that output JSON (e.g., Hermes with --json flag)
  // execSse: for agents that support streaming (--stream flag)
}
```

### 3.4 Dispatch Layer Update

Modify `forwardToProvider()` in `moma-gateway.ts` to detect provider type and dispatch accordingly:

```typescript
// moma-gateway.ts — updated forwardToProvider

async function forwardToProvider(
  providerId: string,
  model: string,
  body: any,
  res: ServerResponse
): Promise<void> {
  const provider = agentRegistry.getProvider(providerId);

  // ─── NEW: CLI provider dispatch ───
  if (provider.type === 'cli-agent') {
    return forwardToCliProvider(provider, model, body, res);
  }

  // ─── EXISTING: HTTP API dispatch ───
  // ... current fetch() logic ...
}

async function forwardToCliProvider(
  provider: ProviderConfig,
  model: string,
  body: any,
  res: ServerResponse
): Promise<void> {
  const adapter = getCliProviderAdapter(provider);
  const startTime = Date.now();

  try {
    const result = await adapter.chatCompletion(body.messages, model, {
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    });

    const latency = Date.now() - startTime;
    const openaiResponse = {
      id: `chatcmpl-cli-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: result.finishReason,
      }],
      usage: result.usage || {
        prompt_tokens: estimateTokens(body.messages),
        completion_tokens: estimateTokens(result.content),
        total_tokens: 0,
      },
    };

    jsonResponse(res, 200, openaiResponse);
  } catch (err: any) {
    jsonResponse(res, 502, {
      error: { message: `CLI provider error: ${err.message}`, type: 'cli_error' },
    });
  }
}
```

## 4. Agent-Specific Wrappers

### 4.1 Claude Code (`claude`)

```typescript
const claudeProvider: CliProviderConfig = {
  command: 'claude',
  argsTemplate: ['--print', '--model', '{model}', '-p', '{prompt}'],
  modelFlag: '--model',
  modelAlias: {
    'claude-sonnet-4-6': 'claude-sonnet-4-6-20250514',
    'claude-opus-4-6': 'claude-opus-4-6-20250514',
  },
  inputFormat: 'arg',
  outputFormat: 'stdout',
  timeoutMs: 300000,  // 5 min for complex coding tasks
  maxTokens: 64000,
  quota: { type: 'subscription', limit: 0, resetMs: 0 },  // track from Claude account
};
```

**How it works:** `claude --print` outputs the final response to stdout without interactive mode. GateSwarm captures stdout and wraps it in OpenAI format.

### 4.2 Codex (`openai-codex`)

```typescript
const codexProvider: CliProviderConfig = {
  command: 'codex',
  argsTemplate: ['exec', '--model', '{model}', '-p', '{prompt}'],
  modelFlag: '--model',
  modelAlias: {
    'gpt-5.3-codex': 'o3',
    'gpt-4.1': 'gpt-4.1',
  },
  inputFormat: 'arg',
  outputFormat: 'stdout',
  timeoutMs: 300000,
  maxTokens: 64000,
  quota: { type: 'subscription' },
};
```

**How it works:** `codex exec` runs non-interactive. Capture stdout for response.

### 4.3 Pi Agent (`~/.pi/agent/`)

Pi has its own local agent runtime. Two integration modes:

**Mode A: Direct subprocess**
```typescript
const piProvider: CliProviderConfig = {
  command: 'node',
  argsTemplate: ['~/.pi/agent/src/index.js', '--model', '{model}', '--prompt', '{prompt}', '--json'],
  modelFlag: '--model',
  modelAlias: {
    'pi-default': 'qwen3.5-plus',  // Pi's configured model
  },
  inputFormat: 'arg',
  outputFormat: 'json',  // Pi outputs JSON when --json flag used
  timeoutMs: 120000,
  maxTokens: 32000,
  quota: { type: 'unlimited' },  // Pi uses free providers internally
};
```

**Mode B: Local HTTP shim** (preferred if Pi has HTTP endpoint)
- Pi can be started as a local HTTP server
- Register as `type: 'http-api'` with `baseUrl: 'http://localhost:7800'`
- GateSwarm routes to it via existing HTTP path (no new code needed)

### 4.4 Hermes Agent (`/usr/local/lib/hermes-agent/`)

Similar to Pi — Hermes is a Node.js agent:

```typescript
const hermesProvider: CliProviderConfig = {
  command: 'node',
  argsTemplate: ['/usr/local/lib/hermes-agent/src/agent.js', '--json', '-p', '{prompt}'],
  modelFlag: '--model',  // if Hermes accepts --model
  modelAlias: {},
  inputFormat: 'arg',
  outputFormat: 'json',
  timeoutMs: 120000,
  maxTokens: 32000,
  quota: { type: 'unlimited' },
};
```

### 4.5 OpenClaw Agent (`openclaw agent`)

OpenClaw already has a CLI for spawning agents:

```typescript
const openclawProvider: CliProviderConfig = {
  command: 'openclaw',
  argsTemplate: ['agent', '--agent', '{agent}', '--message', '{prompt}', '--json'],
  modelFlag: '--model',
  modelAlias: {
    'qwen3.5-plus': 'bailian/qwen3.5-plus',
    'glm-4.7': 'zai/glm-4.7',
  },
  inputFormat: 'arg',
  outputFormat: 'stdout',  // or 'json' if --json supported
  timeoutMs: 180000,
  maxTokens: 32000,
  quota: { type: 'unlimited' },
  env: { OPENCLAW_API_KEY: process.env.OPENCLAW_API_KEY },
};
```

## 5. Local HTTP Shim (Alternative Pattern)

For agents that don't support clean `--print` or `--json` flags, wrap them in a tiny HTTP server:

```typescript
// src/adapters/agent-shim.ts
/**
 * Lightweight HTTP shim for CLI agents.
 * Starts a local Express/Fastify server that wraps the CLI agent.
 * GateSwarm then routes to it via existing HTTP dispatch.
 */

import express from 'express';
import { spawn } from 'child_process';

function createAgentShim(port: number, agentCommand: string, agentArgs: string[]) {
  const app = express();
  app.use(express.json());

  app.post('/v1/chat/completions', async (req, res) => {
    const { messages, model, stream } = req.body;
    const prompt = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
    
    // Spawn CLI agent
    const child = spawn(agentCommand, [...agentArgs, '--prompt', prompt], {
      timeout: 120000,
    });

    let output = '';
    child.stdout?.on('data', d => { output += d; });
    child.on('close', () => {
      res.json({
        choices: [{ message: { role: 'assistant', content: output.trim() } }],
      });
    });
  });

  return app.listen(port);
}
```

This is the **9router pattern**: wrap anything in an OpenAI-compatible HTTP endpoint, then route to it like any other provider.

## 6. Provider Registry Updates

### 6.1 Extended `data/agent-registry.json`

```json
{
  "providers": {
    "bailian": {
      "id": "bailian",
      "name": "Alibaba Bailian",
      "type": "http-api",
      "baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1",
      "apiKey": "sk-sp-...",
      "models": ["qwen3.6-plus", "qwen3.5-plus", "qwen3-coder-plus"]
    },
    "claude-cli": {
      "id": "claude-cli",
      "name": "Claude Code CLI",
      "type": "cli-agent",
      "models": ["claude-sonnet-4-6", "claude-opus-4-6"],
      "cliConfig": {
        "command": "claude",
        "argsTemplate": ["--print", "--model", "{model}", "-p", "{prompt}"],
        "modelFlag": "--model",
        "outputFormat": "stdout",
        "timeoutMs": 300000,
        "maxTokens": 64000
      }
    },
    "codex-cli": {
      "id": "codex-cli",
      "name": "OpenAI Codex CLI",
      "type": "cli-agent",
      "models": ["gpt-5.3-codex", "gpt-4.1"],
      "cliConfig": {
        "command": "codex",
        "argsTemplate": ["exec", "--model", "{model}", "-p", "{prompt}"],
        "modelFlag": "--model",
        "outputFormat": "stdout",
        "timeoutMs": 300000,
        "maxTokens": 64000
      }
    },
    "pi-agent": {
      "id": "pi-agent",
      "name": "Pi Agent (local)",
      "type": "cli-agent",
      "models": ["qwen3.5-plus", "glm-4.7-flash"],
      "cliConfig": {
        "command": "node",
        "argsTemplate": ["~/.pi/agent/src/index.js", "--json", "-p", "{prompt}"],
        "outputFormat": "json",
        "timeoutMs": 120000,
        "maxTokens": 32000
      }
    }
  }
}
```

### 6.2 Registry Code Changes

```typescript
// agent-registry.ts — add new methods
export class AgentRegistry {
  // Existing:
  getProviderBaseUrl(providerId: string): string | null
  getProviderApiKey(providerId: string): string | null
  
  // NEW:
  getProvider(providerId: string): ProviderConfig | null
  getCliProviderConfig(providerId: string): CliProviderConfig | null
  isCliProvider(providerId: string): boolean
  
  // List all available models across all provider types
  listAllModels(): Array<{ model: string; provider: string; type: ProviderType }>
}
```

## 7. Tier Routing with CLI Providers

The v0.4 tier model config already supports `provider` + `model` pairs. With CLI providers, we can route based on **cost + capability**:

```json
{
  "tier_models": {
    "trivial": {
      "model": "qwen3.5-plus",
      "provider": "bailian",
      "max_tokens": 4096,
      "enable_thinking": false,
      "fallback_models": [
        { "model": "qwen3.5-plus", "provider": "pi-agent" },
        { "model": "glm-4.7-flash", "provider": "zai" }
      ]
    },
    "moderate": {
      "model": "claude-sonnet-4-6",
      "provider": "claude-cli",
      "max_tokens": 32000,
      "enable_thinking": false,
      "fallback_models": [
        { "model": "qwen3-coder-plus", "provider": "bailian" },
        { "model": "glm-4.7", "provider": "zai" }
      ]
    },
    "heavy": {
      "model": "claude-opus-4-6",
      "provider": "claude-cli",
      "max_tokens": 64000,
      "enable_thinking": true,
      "fallback_models": [
        { "model": "qwen3.6-plus", "provider": "bailian" },
        { "model": "glm-5.1", "provider": "zai" }
      ]
    },
    "intensive": {
      "model": "claude-opus-4-6",
      "provider": "claude-cli",
      "max_tokens": 64000,
      "enable_thinking": true,
      "fallback_models": [
        { "model": "gpt-5.3-codex", "provider": "codex-cli" },
        { "model": "qwen3.6-plus", "provider": "bailian" }
      ]
    }
  }
}
```

**Fallback chain example for "heavy" tier:**
1. `claude-cli/claude-opus-4-6` (primary — best quality, subscription)
2. `bailian/qwen3.6-plus` (fallback — API, cheap)
3. `zai/glm-5.1` (fallback — API, cheapest)

## 8. Implementation Phases

### Phase 1: Infrastructure (Week 1)
- [ ] Add `ProviderType` enum and extend `ProviderConfig` type
- [ ] Create `src/adapters/cli-provider.ts` adapter class
- [ ] Extend `agent-registry.ts` with CLI provider support
- [ ] Add `isCliProvider()` / `getCliProviderConfig()` methods
- [ ] Update `v04-config.ts` schema for CLI provider tier mappings
- [ ] Update `data/agent-registry.json` with CLI provider definitions

### Phase 2: Core Dispatch (Week 1-2)
- [ ] Modify `forwardToProvider()` in `moma-gateway.ts` to detect provider type
- [ ] Implement `forwardToCliProvider()` function
- [ ] Add stdout parser for `--print` CLI agents (Claude Code, Codex)
- [ ] Add JSON parser for JSON-output agents (Pi, Hermes)
- [ ] Implement fallback chain support for CLI providers
- [ ] Add token estimation for CLI responses (since CLIs don't report usage)

### Phase 3: Agent Wrappers (Week 2)
- [ ] Claude Code wrapper: `claude --print --model {model} -p {prompt}`
- [ ] Codex wrapper: `codex exec --model {model} -p {prompt}`
- [ ] Pi wrapper: subprocess or HTTP shim
- [ ] Hermes wrapper: subprocess with `--json` flag
- [ ] OpenClaw wrapper: `openclaw agent --message {prompt}`
- [ ] Test each wrapper with GateSwarm routing

### Phase 4: Quota & Health (Week 3)
- [ ] Implement subscription quota tracking for Claude Code/Codex
- [ ] Add CLI health checks (command availability, auth status)
- [ ] Provider availability reporting in `/health` and `/v04/status`
- [ ] CLI provider metrics in `/metrics`
- [ ] Graceful degradation when CLI agents are unavailable

### Phase 5: Advanced Features (Week 3-4)
- [ ] HTTP shim server for agents without clean CLI modes
- [ ] Streaming support for CLI agents that support it
- [ ] Model alias registry (GateSwarm model name → agent-specific model name)
- [ ] Cost tracking across HTTP + CLI providers
- [ ] `gateswarm` CLI commands for managing CLI providers
- [ ] Dashboard integration for CLI provider status

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| CLI agents don't support `--print` mode | Medium | Use HTTP shim pattern (9router approach) |
| Token counting unavailable from CLI | Low | Estimate with tiktoken; flag as approximate |
| CLI process hangs or crashes | Medium | Timeout + fallback chain + process cleanup |
| Model availability differs per CLI agent | Medium | Model alias registry + health checks |
| Concurrent CLI requests (some don't support) | High | Request queue per CLI agent (serial execution) |
| Subscription quota exhaustion | Medium | Track usage, auto-fallback to free providers |

## 10. Success Criteria

1. **Functional:** GateSwarm can route to at least 2 CLI agents (Claude Code + Codex)
2. **Reliable:** CLI fallback works when HTTP providers are rate-limited
3. **Observable:** CLI provider status visible in `/health`, `/metrics`, `/v04/status`
4. **Configurable:** CLI providers configurable via `agent-registry.json` without code changes
5. **Compatible:** Existing HTTP-only routing unchanged (backward compatible)

## 11. Estimated Effort

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| Phase 1: Infrastructure | 2-3 days | None |
| Phase 2: Core Dispatch | 3-4 days | Phase 1 |
| Phase 3: Agent Wrappers | 4-5 days | Phase 2 |
| Phase 4: Quota & Health | 3-4 days | Phase 3 |
| Phase 5: Advanced | 5-7 days | Phase 4 |
| **Total** | **~3 weeks** | |

---

_This plan follows the 9router proven pattern: wrap CLI agents as providers, translate formats automatically, and let the router make intelligent decisions about which agent/model to use for each request._
