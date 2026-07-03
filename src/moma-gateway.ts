#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
import { loadVaultEnv } from './secrets/vault-env.js';
/**
 * GateSwarm MoMA Router v0.5.6 — Multi-Agent API Gateway
 *
 * v0.5.6: Routing Transparency
 *   - Unify scoreToEffort (canonical, config-driven)
 *   - ConsumptionDecision.source field — distinguish real requests from
 *     health/balance/recovery checks
 *   - ActivityPanel TUI filters health checks (shows 'N hidden')
 *   - Response headers: X-Tier, X-Score, X-Routed-Model, X-Routed-Tier,
 *     X-Routing-Method, X-Routing-Reason on /v1/chat/completions
 *
 * v0.5.5: Quota-Aware Routing
 *   - Pre-flight provider health checks
 *   - Greeting fast-path respects client stream flag
 *   - Self-healing tier rebalancing via feedback loop
 *   - Latency thresholds + quota-sync format alignment
 *
 * v0.5.1: Direct Routing Bypass
 *   - Skip complexity scoring and route directly to user-specified provider/model
 *   - Supports: request body (`direct_route`), model override (`provider/model`), headers (`X-Direct-*`)
 *   - CLI: `gateswarm direct <provider> <model> "prompt"`
 *
 * v0.5.0: CLI Provider Support
 *   - Route to CLI agents (Claude Code, Codex, Pi, Hermes, OpenClaw) as providers
 *   - Subprocess dispatch with official CLIs (respects OAuth/policies)
 *   - Token estimation via tiktoken for CLI responses
 *   - 9router-style prefix notation (cc/, cx/, pi/, hm/, oc/)
 *   - Feature toggle: cliProviders.enabled in v04_config.json
 *
 * v0.4.4 improvements:
 *   - RAG + feedback persistence (JSON-file, survives restarts)
 *   - Training mode wired into request pipeline
 *   - Context continuity anchor across model switches
 *   - Self-eval actualTier wired to feedback store
 *   - Fallback chain retries on 5xx errors (not just 429)
 *   - LLM judge uses qwen3.6-plus (anti-circularity)
 *   - enable_thinking ON for heavy/intensive/extreme tiers
 *   - History bias wired from persistent feedback store
 *
 * Any agent can connect by setting:
 *   base_url: http://<host>:8900/v1
 *   api_key:  moma-<agent-key>
 *
 * Usage: npx tsx src/moma-gateway.ts [--port 8900]
 *
 * Endpoints:
 *   POST /v1/chat/completions  — Main completion endpoint
 *   GET  /v1/models            — List available models
 *   GET  /v1/agents            — List registered agents (admin)
 *   POST /v1/agents/register  — Register new agent (admin)
 *   GET  /v1/agents/:id        — Get agent config
 *   PATCH /v1/agents/:id       — Update agent config
 *   GET  /health               — Health check
 *   GET  /metrics              — Benchmark metrics
 *   GET  /metrics/:agentId     — Per-agent metrics
 *   GET  /v04/status           — v0.4 ensemble/feedback/RAG status
 *   POST /v04/retrain          — Trigger manual retraining
 *   GET  /v04/feedback         — Feedback buffer stats
 *   GET  /v05/cli              — CLI provider status (v0.5)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { BenchmarkLogger } from './benchmark-logger.js';
import { heuristicScore, scoreToEffort } from './intent-engine.js';
import { scoreIntent as scoreIntentV04 } from './intent-engine-v04.js';
import { recordFeedback, getInteractionCount, getFeedbackEntries, getTierAccuracy, shouldRetrain, initFeedbackStore, startFeedbackAutoFlush, updateAdequacy } from './feedback-store.js';
import { selfEvaluate } from './self-eval.js';
import { addRagEntry, initRagIndex, startRagAutoFlush } from './rag-index.js';
import { retrainIfNeeded, getActiveWeights } from './retraining.js';
import { getConfig, getTierModel, getAllTierModels, getReasoningStatus, saveConfig, getTierModelForMode, detectIntentMode } from './v04-config.js';
import type { EffortLevel, IntentMode } from './types.js';
import { agentRegistry, AgentConfig } from './agent-registry.js';
import { estimateTokens } from './token-estimator.js';
import { modelMatrix } from './model-matrix.js';
import { modelDiscovery } from './model-discovery.js';
import { consumptionIntelligence, ConsumptionDecision } from './consumption-intelligence.js';
import { providerQuota, getMultiWindowQuota } from './provider-quota.js';
import type { LoadBalanceDecision } from './provider-quota.js';
import { consumptionTracker } from './consumption-tracker.js';
import { quotaSync } from './quota-sync.js';
import { getCliProvidersEnabled } from './v04-config.js';
import { turboQuantCompress, MODEL_CONTEXT_WINDOWS } from './turboquant-compressor.js';
import { ragIndex, queryRag } from './rag-index.js';
import {
  setTrainingMode, isTrainingMode, createVoteRequest, processVoteReply,
  detectVoteReply, inferRagConsensus, shouldRetrain as shouldRetrainTraining,
  getTrainingStats,
} from './training-mode.js';
import { getCalibrationStats, calibrateBronze, calibrateSilver } from './label-combiner.js';
import { join, dirname } from 'path';







const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Configuration ─────────────────────────────────────

const PORT = parseInt(process.argv.find(a => a === '--port') ? process.argv[process.argv.indexOf('--port') + 1] : '8900', 10);

// ─── State ─────────────────────────────────────────────

const benchmarkLogger = new BenchmarkLogger();

type StreamFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';


function messageContentToText(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);

  if (Array.isArray(content)) {
    return content
      .map((part) => messageContentToText(part))
      .filter((text) => text.trim().length > 0)
      .join('\n');
  }

  if (typeof content === 'object') {
    const record = content as Record<string, any>;
    // MoMA: media parts become compact placeholders — never stringify a
    // base64 payload into prompt text (blows up scoring + CLI prompts).
    if (typeof record.type === 'string') {
      if (record.type === 'image_url' || record.type === 'image' || record.type === 'input_image') return '[image]';
      if (record.type === 'input_audio' || record.type === 'audio') return '[audio]';
      if (record.type === 'video_url' || record.type === 'video') return '[video]';
      if (record.type === 'file' || record.type === 'document') return '[file]';
    }
    if (typeof record.text === 'string') return record.text;
    if (typeof record.input_text === 'string') return record.input_text;
    if (typeof record.output_text === 'string') return record.output_text;
    if (record.content !== undefined) return messageContentToText(record.content);
    if (record.message !== undefined) return messageContentToText(record.message);
    if (record.prompt !== undefined) return messageContentToText(record.prompt);
    if (record.value !== undefined) return messageContentToText(record.value);
    return JSON.stringify(record);
  }

  return String(content);
}

function normalizeMessageContent(message: any): any {
  if (!message || typeof message !== 'object' || !('content' in message)) return message;
  return { ...message, content: messageContentToText(message.content) };
}

// ─── MoMA: request modality detection ──────────────────
// A content part is "media" when its type names an image/audio/video/file
// input. Media-bearing messages keep their original content arrays so the
// upstream vision model receives the actual payload; text-only content is
// still flattened to plain strings for maximum provider compatibility.

const MEDIA_PART_TYPES = new Set([
  'image_url', 'image', 'input_image',
  'input_audio', 'audio',
  'video_url', 'video',
  'file', 'document',
]);

function messageHasMediaParts(message: any): boolean {
  const c = message?.content;
  if (!Array.isArray(c)) return false;
  return c.some((part) => part && typeof part === 'object' && MEDIA_PART_TYPES.has(part.type));
}

export interface RequestModalities {
  vision: boolean;
  audio: boolean;
}

function detectRequestModalities(messages: any[]): RequestModalities {
  const result: RequestModalities = { vision: false, audio: false };
  for (const msg of messages) {
    const c = msg?.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      const t = part && typeof part === 'object' ? part.type : undefined;
      if (t === 'image_url' || t === 'image' || t === 'input_image' || t === 'video_url' || t === 'video') result.vision = true;
      else if (t === 'input_audio' || t === 'audio') result.audio = true;
    }
    if (result.vision && result.audio) break;
  }
  return result;
}

function createTerminalStreamChunk(model: string, finishReason: StreamFinishReason): string {
  return JSON.stringify({
    id: `chatcmpl-terminal-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
}

function writeTerminalStream(
  res: ServerResponse,
  model: string,
  finishReason: StreamFinishReason,
  state: { sawFinishReason: boolean; sawDone: boolean },
) {
  if (!state.sawFinishReason) {
    res.write(`data: ${createTerminalStreamChunk(model, finishReason)}\n\n`);
    state.sawFinishReason = true;
  }

  if (!state.sawDone) {
    res.write('data: [DONE]\n\n');
    state.sawDone = true;
  }
}

function parseSseEventData(event: string): string | null {
  const dataLines = event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart());

  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

function streamEventHasFinishReason(data: string): boolean {
  if (!data || data === '[DONE]') return false;

  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed?.choices)
      && parsed.choices.some((choice: any) => choice?.finish_reason != null);
  } catch {
    return false;
  }
}

function writeProviderSseEvent(
  res: ServerResponse,
  event: string,
  model: string,
  state: { sawFinishReason: boolean; sawDone: boolean },
) {
  const data = parseSseEventData(event);

  if (data === '[DONE]') {
    writeTerminalStream(res, model, 'stop', state);
    return;
  }

  if (data && streamEventHasFinishReason(data)) {
    state.sawFinishReason = true;
  }

  res.write(`${event}\n\n`);
}

interface CliStreamState {
  id: string;
  created: number;
  model: string;
  heartbeat: ReturnType<typeof setInterval>;
}

function startCliStream(res: ServerResponse, model: string, prefix = 'chatcmpl-cli'): CliStreamState {
  const state: CliStreamState = {
    id: `${prefix}-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    heartbeat: setInterval(() => {
      if (!res.writableEnded) res.write(`: keepalive ${Date.now()}\n\n`);
    }, 10_000),
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write(`data: ${JSON.stringify({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  })}\n\n`);

  return state;
}

function finishCliStream(
  res: ServerResponse,
  state: CliStreamState,
  content: string,
  finishReason: StreamFinishReason = 'stop',
) {
  clearInterval(state.heartbeat);

  if (content && !res.writableEnded) {
    res.write(`data: ${JSON.stringify({
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`);
  }

  if (!res.writableEnded) {
    res.write(`data: ${createTerminalStreamChunk(state.model, finishReason)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// ─── Direct Routing (v0.5.1) ───────────────────────────
// Bypasses complexity scoring, routes directly to specified provider/model

interface DirectRouteTarget {
  providerId: string;
  model: string;
}

/**
 * Check if request wants direct routing (skip classification).
 * Three methods (priority order):
 *   1. body.direct_route: { provider, model }
 *   2. body.model: "provider/model" (e.g. "claude-cli/cc/claude-sonnet-4-6")
 *   3. Headers: X-Direct-Provider + X-Direct-Model
 */
function resolveDirectRoute(req: IncomingMessage, body: any, agent: AgentConfig): DirectRouteTarget | null {
  // Method 1: direct_route object
  if (body.direct_route && typeof body.direct_route === 'object') {
    const { provider, model } = body.direct_route;
    if (provider && model) {
      return { providerId: provider, model };
    }
  }

  // Method 2: model override with provider/ prefix
  if (body.model && typeof body.model === 'string' && body.model.includes('/')) {
    const parts = body.model.split('/');
    const prefix = parts[0];
    const rest = parts.slice(1).join('/');
    // Check if prefix matches a known provider
    const providerId = resolveProviderId(prefix);
    if (providerId) {
      // Return bare model name (strip prefix) so downstream cleanModel logic
      // doesn't double-strip and produce a malformed model id.
      return { providerId, model: rest };
    }
  }

  // Method 3: X-Direct-* headers
  const hdrProvider = (req.headers['x-direct-provider'] as string)?.trim();
  const hdrModel = (req.headers['x-direct-model'] as string)?.trim();
  if (hdrProvider && hdrModel) {
    return { providerId: hdrProvider, model: hdrModel };
  }

  return null;
}

/** Resolve a provider prefix to a provider ID. */
function resolveProviderId(prefix: string): string | null {
  const prefixMap: Record<string, string> = {
    'cc': 'claude-cli', 'cx': 'codex-cli',
    'pi': 'pi-agent', 'hm': 'hermes-agent', 'oc': 'openclaw-agent',
    'bailian': 'bailian', 'zai': 'zai', 'openrouter': 'openrouter',
    'ollama': 'ollama', 'ollama-cloud': 'ollama-cloud', 'opencodego': 'opencodego',
    'claude-cli': 'claude-cli', 'codex-cli': 'codex-cli',
    'pi-agent': 'pi-agent', 'hermes-agent': 'hermes-agent',
    'openclaw-agent': 'openclaw-agent',
  };
  return prefixMap[prefix] ?? null;
}

/**
 * Execute direct route — skip all classification/RAG/fallback logic.
 * Validates provider, dispatches to CLI or HTTP as appropriate.
 */
/** Emit X-Mode / X-Mode-Confidence headers. Reads explicit override from X-Mode request header;
 *  falls back to detectIntentMode on promptText. */
function emitModeHeaders(req: IncomingMessage, res: ServerResponse, promptText: string): void {
  const reqMode = (req.headers['x-mode'] as string | undefined)?.trim().toLowerCase();
  if (reqMode === 'plan' || reqMode === 'act') {
    res.setHeader('X-Mode', reqMode);
    res.setHeader('X-Mode-Confidence', '1.00');
  } else {
    const det = detectIntentMode(promptText);
    res.setHeader('X-Mode', det.mode);
    res.setHeader('X-Mode-Confidence', det.confidence.toFixed(2));
  }
}

async function handleDirectRoute(
  req: IncomingMessage,
  res: ServerResponse,
  agent: AgentConfig,
  messages: any[],
  promptText: string,
  providerId: string,
  model: string,
): Promise<void> {
  // Validate provider exists
  if (!agentRegistry.isCliProvider(providerId) && !agentRegistry.isHttpProvider(providerId)) {
    return jsonResponse(res, 400, {
      error: { message: `Unknown provider: ${providerId}. Use GET /v1/providers for available providers.`, type: 'invalid_provider' },
    });
  }

  // Loop guard for CLI providers
  if (agentRegistry.isCliProvider(providerId) && agent.id === providerId) {
    return jsonResponse(res, 400, {
      error: { message: `Cannot route ${agent.name} to itself (${providerId}).`, type: 'loop_guard' },
    });
  }

  console.log(`📍 [${agent.name}] Direct route → ${providerId}/${model} (classification bypassed)`);

  // Remove direct_route from body to avoid downstream confusion
  const body = req && (req as any)._body ? (req as any)._body : { messages };
  const cleanBody = { ...body };
  delete cleanBody.direct_route;
  delete cleanBody.model; // We set model ourselves

  const sanitizedMessages = sanitizeMessages(messages);

  // CLI provider dispatch
  if (agentRegistry.isCliProvider(providerId)) {
    return handleCliProviderDirect(providerId, model, agent, sanitizedMessages, res, req, promptText);
  }

  // HTTP provider dispatch
  const baseUrl = agentRegistry.getProviderBaseUrl(providerId);
  const apiKey = agentRegistry.getProviderApiKey(providerId);
  if (!baseUrl || !apiKey) {
    return jsonResponse(res, 503, {
      error: { message: `Provider ${providerId} not configured (missing baseUrl or apiKey)`, type: 'provider_unavailable' },
    });
  }

  // Strip provider prefix from model name for HTTP providers
  // e.g. "bailian/qwen3.5-plus" → "qwen3.5-plus"
  const cleanModel = model.includes('/') ? model.split('/').slice(1).join('/') : model;

  const startTime = Date.now();
  // v0.5.6: Respect the client's stream flag — don't force stream:false.
  // Pi (and other clients) expect a true SSE stream when they ask for it.
  // Forcing stream:false broke streaming clients and caused
  // "Stream ended without finish_reason" errors.
  const clientWantsStream = body.stream === true;
  // MoMA: direct-routed image requests to non-vision models get placeholders
  // instead of a provider 400 on the image_url content parts.
  const directModalities = detectRequestModalities(sanitizedMessages);
  const directMessages = directModalities.vision
    && !consumptionIntelligence.modelSupportsVision(providerId, cleanModel)
    ? (() => {
        console.log(`⚠️  [${agent.name}] ${providerId}/${cleanModel} is not vision-capable — sending media parts as placeholders`);
        return sanitizedMessages.map(normalizeMessageContent);
      })()
    : sanitizedMessages;
  const payload: any = { messages: directMessages, model: cleanModel };
  if (clientWantsStream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  } else {
    payload.stream = false;
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // v0.5.5: Record rate-limit errors so provider health degrades
      if (response.status === 429 || response.status === 1305 || response.status === 1308) {
        providerQuota.record429(providerId);
        modelMatrix.recordError(providerId, cleanModel, `rate-limited (${response.status})`);
        console.log(`⚠️  [${agent.name}] Direct route ${providerId}/${cleanModel} rate-limited (${response.status})`);
      }
      const data = await response.json().catch(() => ({}));
      return jsonResponse(res, response.status, {
        error: data.error || { message: `Provider error: ${response.status}`, type: 'provider_error' },
      });
    }

    // v0.5.6: Forward the upstream stream as-is when client wants streaming.
    // This is the only way to make streaming clients (Pi, etc.) happy —
    // they need a real SSE stream with [DONE] markers and finish_reason.
    if (clientWantsStream && response.body) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const reader = response.body.getReader();
      const streamState = { sawFinishReason: false, sawDone: false };
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Forward each complete SSE event as it arrives
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const evt = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (!evt.trim()) continue;
            // Check if this event has finish_reason
            const dataLines = evt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
            for (const d of dataLines) {
              if (d === '[DONE]') {
                streamState.sawDone = true;
              } else if (d) {
                try {
                  const parsed = JSON.parse(d);
                  if (Array.isArray(parsed?.choices)) {
                    for (const c of parsed.choices) {
                      if (c?.finish_reason != null) streamState.sawFinishReason = true;
                    }
                  }
                } catch {}
              }
            }
            res.write(evt + '\n\n');
          }
        }
        // Flush remaining buffer
        if (buffer.trim()) {
          res.write(buffer + '\n\n');
        }
        // If upstream didn't send [DONE] or finish_reason, send a terminal stop
        if (!streamState.sawFinishReason || !streamState.sawDone) {
          if (!streamState.sawFinishReason) {
            res.write(`data: {"id":"chatcmpl-done","object":"chat.completion.chunk","created":${Math.floor(Date.now()/1000)},"model":"${cleanModel}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
          }
          if (!streamState.sawDone) {
            res.write('data: [DONE]\n\n');
          }
        }
        res.end();
      } catch (streamErr: any) {
        console.error(`❌ Direct stream forwarding error: ${streamErr.message}`);
        try {
          if (!streamState.sawDone) res.write('data: [DONE]\n\n');
          res.end();
        } catch {}
      }
      const latency = Date.now() - startTime;
      benchmarkLogger.log({
        prompt: '(direct route)',
        prompt_length: 0,
        tier: 'direct',
        routed_model: `${providerId}/${model}`,
        tokens_in: 0, // not available mid-stream
        tokens_out: 0,
        latency_ms: latency,
        provider: providerId,
        status: 'success',
      });
      return;
    }

    // Non-streaming: parse JSON and return
    const data = await response.json();
    const latency = Date.now() - startTime;

    benchmarkLogger.log({
      prompt: '(direct route)',
      prompt_length: 0,
      tier: 'direct',
      routed_model: `${providerId}/${model}`,
      tokens_in: (data.usage as any)?.prompt_tokens || 0,
      tokens_out: (data.usage as any)?.completion_tokens || 0,
      latency_ms: latency,
      provider: providerId,
      status: 'success',
    });

    // Track consumption for direct route too
    const directTokensIn = (data.usage as any)?.prompt_tokens || 0;
    const directTokensOut = (data.usage as any)?.completion_tokens || 0;
    consumptionTracker.recordUsage(providerId, {
      tokensIn: directTokensIn,
      tokensOut: directTokensOut,
      latencyMs: latency,
      error: false,
    });
    providerQuota.recordRequest(providerId, directTokensIn + directTokensOut);
    providerQuota.recordSuccess(providerId);

    emitModeHeaders(req, res, promptText);
    return jsonResponse(res, 200, data);
  } catch (err: any) {
    console.error(`❌ Direct route error (${providerId}): ${err.message}`);
    return jsonResponse(res, 502, {
      error: { message: `Provider error: ${err.message}`, type: 'provider_error' },
    });
  }
}

/** Execute direct route to CLI provider (subprocess dispatch). */
async function handleCliProviderDirect(
  providerId: string,
  model: string,
  agent: AgentConfig,
  messages: any[],
  res: ServerResponse,
  req?: IncomingMessage,
  promptText?: string,
): Promise<void> {
  const cliConfig = agentRegistry.getCliProviderConfig(providerId);
  if (!cliConfig) {
    return jsonResponse(res, 503, {
      error: { message: `CLI provider ${providerId} not configured`, type: 'provider_unavailable' },
    });
  }

  const adapter = agentRegistry.getCliAdapter(providerId);
  if (!adapter) {
    return jsonResponse(res, 503, {
      error: { message: `CLI provider ${providerId} adapter not initialized`, type: 'provider_unavailable' },
    });
  }

  // Check availability
  const avail = await agentRegistry.checkCliProviderAvailability(providerId);
  if (!avail.ok) {
    return jsonResponse(res, 503, {
      error: { message: `CLI provider ${providerId} unavailable: ${avail.reason}`, type: 'provider_unavailable' },
    });
  }

  const startTime = Date.now();
  const cliMessages = sanitizeForCli(messages);
  const streamResponse = Boolean(req && (req as any)._body?.stream);
  let cliStream: CliStreamState | null = null;

  try {
    if (streamResponse) {
      cliStream = startCliStream(res, providerId + '/' + model, 'chatcmpl-cli-direct');
    }
    const result = await adapter.chatCompletion(cliMessages, model);
    const latency = Date.now() - startTime;

    benchmarkLogger.log({
      prompt: '(direct CLI route)',
      prompt_length: 0,
      tier: 'direct',
      routed_model: `${providerId}/${model}`,
      tokens_in: result.usage?.promptTokens || 0,
      tokens_out: result.usage?.completionTokens || 0,
      latency_ms: latency,
      provider: providerId,
      status: 'success',
    });

    console.log(`🖥️  [${agent.name}] Direct CLI ${providerId}/${model}: ${result.usage?.promptTokens || 0}→${result.usage?.completionTokens || 0}tok, ${latency}ms`);

    const openaiResponse = {
      id: `chatcmpl-cli-direct-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: `${providerId}/${model}`,
      choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: result.finishReason }],
      usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    if (req) emitModeHeaders(req, res, promptText || '');

    if (streamResponse && cliStream) {
      finishCliStream(res, cliStream, result.content, (result.finishReason ?? 'stop') as StreamFinishReason);
      return;
    }

    return jsonResponse(res, 200, openaiResponse);
  } catch (err: any) {
    console.error(`❌ CLI provider error (direct, ${providerId}): ${err.message}`);
    if (streamResponse && cliStream) {
      finishCliStream(res, cliStream, `CLI provider error: ${err.message}`, 'length');
      return;
    }
    return jsonResponse(res, 502, {
      error: { message: `CLI provider error: ${err.message}`, type: 'cli_error' },
    });
  }
}

/** Sanitize messages for OpenAI-compatible providers (remove tool messages, merge same-role). */
function sanitizeMessages(msgs: any[]): any[] {
  if (msgs.length <= 1) return [...msgs];
  // v0.5.2: Strip all tool-related messages — the Gateway is a routing proxy,
  // not a tool-execution engine. Provider-side tool_calls cause errors with
  // strict APIs (DeepSeek, etc.) when tool_call_ids are unmatched.
  const stripped = msgs.filter(m => m.role !== 'tool').map(m => {
    if (m.role === 'assistant' && m.tool_calls) {
      // Keep the message but drop tool_calls array so providers don't
      // expect matching tool responses. If content is null/empty after
      // stripping, replace with a placeholder so strict APIs don't reject.
      const { tool_calls, ...rest } = m;
      if (rest.content === null || rest.content === undefined || (typeof rest.content === 'string' && rest.content.trim() === '')) {
        rest.content = '[tool use]';
      }
      return rest;
    }
    return m;
  });
  if (stripped.length === 0) return [{ role: 'user', content: '(continuation)' }];
  const systemMsgs = stripped.filter(m => m.role === 'system');
  const nonSystemMsgs = stripped.filter(m => m.role !== 'system');
  const merged: any[] = [];
  for (const msg of nonSystemMsgs) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    // MoMA: never merge media-bearing messages — stringifying a content
    // array would inline base64 payloads into text.
    if (prev && prev.role === msg.role && !messageHasMediaParts(prev) && !messageHasMediaParts(msg)) {
      const prevContent = typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content);
      const currContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      prev.content = prevContent + '\n---\n' + currContent;
    } else {
      merged.push({ ...msg });
    }
  }
  // Ensure first non-system message is user
  if (merged.length > 0 && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '(continuation)' });
  }
  return [...systemMsgs, ...merged];
}

// ─── Context Continuity (v0.4.4) ──────────────────────
// Tracks per-session summaries across model switches so that
// when the router changes models between turns, the new model
// gets a summary of what the previous model discussed.

interface SessionContinuity {
  summary: string;      // LLM-agnostic summary of the conversation
  lastTier: string;     // tier of the last response
  lastModel: string;    // model used for the last response
  keyDecisions: string[];  // important decisions/conclusions
  updatedAt: number;
}

const sessionContinuity = new Map<string, SessionContinuity>();

function getContinuity(sessionId: string): SessionContinuity | null {
  const entry = sessionContinuity.get(sessionId);
  // Expire after 1 hour of inactivity
  if (entry && Date.now() - entry.updatedAt > 3600000) {
    sessionContinuity.delete(sessionId);
    return null;
  }
  return entry ?? null;
}

function updateContinuity(sessionId: string, tier: string, model: string, responseText: string): void {
  const existing = sessionContinuity.get(sessionId);
  const keyDecisions = extractKeyDecisions(responseText);
  sessionContinuity.set(sessionId, {
    summary: existing
      ? `${existing.summary}\n[Turn: ${tier}→${model}] ${responseText.slice(0, 300)}`
      : `[Turn: ${tier}→${model}] ${responseText.slice(0, 300)}`,
    lastTier: tier,
    lastModel: model,
    keyDecisions: existing
      ? [...existing.keyDecisions, ...keyDecisions].slice(-10)
      : keyDecisions,
    updatedAt: Date.now(),
  });
}

function extractKeyDecisions(text: string): string[] {
  const decisions: string[] = [];
  const patterns = [
    /(?:decision|conclusion|therefore|resolved|agreed|final)[:\s]*(.+?)(?:\n|$)/gi,
    /(?:the answer is|key point|important|note that)[:\s]*(.+?)(?:\n|$)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      decisions.push(match[1].trim().slice(0, 150));
    }
  }
  return decisions;
}

// ─── Helpers ───────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function extractApiKey(req: IncomingMessage): string {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  // Also support x-api-key header (simpler for agent clients)
  return (req.headers['x-api-key'] as string) || '';
}

async function forwardToProvider(
  providerId: string,
  model: string,
  body: any,
  res: ServerResponse
): Promise<void> {
  const baseUrl = agentRegistry.getProviderBaseUrl(providerId);
  const apiKey = agentRegistry.getProviderApiKey(providerId);

  if (!baseUrl || !apiKey) {
    return jsonResponse(res, 503, {
      error: { message: `Provider ${providerId} not configured`, type: 'provider_unavailable' },
    });
  }

  const url = `${baseUrl}/chat/completions`;
  const payload: any = { ...body, model };
  // v0.4.1: Both Bailian (Qwen) and ZAI (GLM) support tool calling — pass tools through

  console.log(`🔀 Routing to ${providerId}/${model}`);

  // v0.4.3: Add 120s timeout to prevent indefinite hangs on upstream providers
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ Provider error: ${response.status} ${error}`);
      jsonResponse(res, response.status, { error: { message: error, type: 'provider_error' } });
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') || body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const reader = response.body?.getReader();
      const streamState = { sawFinishReason: false, sawDone: false };
      let streamClosed = false;

      if (!reader) {
        writeTerminalStream(res, model, 'length', streamState);
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      let sseBuffer = '';
      const flushSseBuffer = (final = false) => {
        while (true) {
          const separatorIndex = sseBuffer.indexOf('\n\n');
          if (separatorIndex === -1) break;
          const event = sseBuffer.slice(0, separatorIndex).trimEnd();
          sseBuffer = sseBuffer.slice(separatorIndex + 2);
          if (event) writeProviderSseEvent(res, event, model, streamState);
        }

        if (final && sseBuffer.trim()) {
          writeProviderSseEvent(res, sseBuffer.trimEnd(), model, streamState);
          sseBuffer = '';
        }
      };

      // v0.5.3: 90s idle timeout — GLM models can have long gaps during thinking
      const idleTimer = setTimeout(() => {
        if (streamClosed) return;
        streamClosed = true;
        console.log(`⏱️  Streaming idle timeout (90s), sending truncation event`);
        try { reader.cancel(); } catch {}
        writeTerminalStream(res, model, 'length', streamState);
        res.end();
      }, 90_000);

      try {
        while (!streamClosed) {
          const { done, value } = await reader.read();
          if (done) break;
          idleTimer.refresh(); // reset idle timer on each chunk
          sseBuffer += decoder.decode(value, { stream: true });
          flushSseBuffer();
        }

        if (!streamClosed) {
          sseBuffer += decoder.decode();
          flushSseBuffer(true);
          writeTerminalStream(res, model, 'stop', streamState);
          res.end();
        }
      } catch (streamErr: any) {
        if (!streamClosed) {
          console.error(`❌ Stream forwarding error: ${streamErr.message}`);
          writeTerminalStream(res, model, 'length', streamState);
          res.end();
        }
      } finally {
        streamClosed = true;
        clearTimeout(idleTimer);
      }
    } else {
      const data = await response.json();
      jsonResponse(res, 200, data);
    }
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`⏱️  Provider ${providerId}/${model} timed out after 120s`);
      jsonResponse(res, 504, { error: { message: `Provider ${providerId}/${model} timed out after 120s`, type: 'timeout' } });
    } else {
      console.error(`❌ Forward error: ${err.message}`);
      jsonResponse(res, 502, { error: { message: `Gateway error: ${err.message}`, type: 'gateway_error' } });
    }
  }
}

// ─── Route Handlers ────────────────────────────────────

async function handleChatCompletion(req: IncomingMessage, res: ServerResponse, agent: AgentConfig): Promise<void> {
  const body = await parseBody(req);
  (req as any)._body = body;
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  // MoMA: media-bearing messages keep their original content arrays (the
  // upstream vision model needs the real payload); everything else is
  // flattened to plain text for provider compatibility.
  const requestModalities = detectRequestModalities(rawMessages);
  const messages = rawMessages.map((m: any) => messageHasMediaParts(m) ? m : normalizeMessageContent(m));

  // Extract prompt text for complexity scoring (media parts become placeholders)
  const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop();
  const promptText = messageContentToText(lastUserMessage?.content) || JSON.stringify(messages.map(normalizeMessageContent));



// Mode override: body.mode or X-Mode header; else auto-detect
  let modeOverride: IntentMode | null = null;
  if (body.mode === 'plan' || body.mode === 'act') modeOverride = body.mode as IntentMode;
  if (!modeOverride && req.headers['x-mode']) {
    const hdr = (req.headers['x-mode'] as string).trim().toLowerCase();
    if (hdr === 'plan' || hdr === 'act') modeOverride = hdr as IntentMode;
  }

// Effort override: body.effort_override or X-Effort-Override header.
// v0.5.7: bypass ensemble scoring; skip straight to the named tier's primary model.
// Useful when the caller knows the request's complexity and wants to skip scoring.
  const VALID_EFFORTS = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;
  type EffortLevel2 = typeof VALID_EFFORTS[number];
  let effortOverride: EffortLevel2 | null = null;
  if (typeof body.effort_override === 'string') {
    const e = body.effort_override.trim().toLowerCase();
    if ((VALID_EFFORTS as readonly string[]).includes(e)) {
      effortOverride = e as EffortLevel2;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `effort_override must be one of: ${VALID_EFFORTS.join(', ')}`, type: 'bad_request' }
      }));
      return;
    }
  }
  if (!effortOverride && req.headers['x-effort-override']) {
    const hdr = (req.headers['x-effort-override'] as string).trim().toLowerCase();
    if ((VALID_EFFORTS as readonly string[]).includes(hdr)) {
      effortOverride = hdr as EffortLevel2;
    }
  }
  if (effortOverride) {
    console.log(`🎯 [${agent.name}] Effort override: ${effortOverride} (bypassing ensemble scoring)`);
  }

// ─── v0.5.1: Direct Routing Bypass ──────────────────────────
  // Users can skip complexity scoring by specifying provider+model directly.
  // Three methods supported (in priority order):
  //   1. body.direct_route: { provider, model }
  //   2. body.model: "provider/model" format (e.g. "claude-cli/cc/claude-sonnet-4-6")
  //   3. Headers: X-Direct-Provider + X-Direct-Model
  const directRoute = resolveDirectRoute(req, body, agent);
  if (directRoute) {
    return handleDirectRoute(req, res, agent, messages, promptText, directRoute.providerId, directRoute.model);
  }

  // ─── v0.5.6: Greeting/Ultra-Short Fast-Path ──────────────
  // For extremely short prompts (greetings, "hi", "ok", single-word Q&A),
  // skip the entire classification cascade and RAG injection — just route
  // straight to the local trivial model. Saves 50-200ms of classification
  // + 1-3s of context processing.
  // v0.5.7: If effort_override is set, skip the greeting fast-path so the
  // caller's chosen tier is honored.
  const GREETING_RE = /^\s*(hi|hello|hey|yo|sup|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|ok(?:ay)?|bye|cya|gm|gn)\s*[.!]?\s*$/i;
  if (!effortOverride && promptText && GREETING_RE.test(promptText) && promptText.length < 30) {
    const trivialCfg = getConfig().tier_models.trivial;
    // v0.5.5: Check provider health before fast-path routing.
    // If the trivial provider is throttled/rate-limited, fall through to
    // normal routing which has the full fallback chain.
    const trivialHealth = providerQuota.shouldSwitch(trivialCfg.provider);
    // Any HTTP provider qualifies — the fast-path is a plain chat-completions
    // POST. Only CLI providers (subprocess dispatch) must fall through to the
    // normal routing path. A hardcoded provider list here silently disabled
    // the fast-path whenever the trivial tier was re-pointed at a new provider.
    if (!trivialHealth.shouldSwitch && trivialCfg && agentRegistry.isHttpProvider(trivialCfg.provider)) {
      console.log(`⚡ [${agent.name}] Greeting fast-path: '${promptText.slice(0,20)}' → ${trivialCfg.provider}/${trivialCfg.model}`);
      // Strip system messages, send only the user message
      const greetingMessages = [messages.filter((m: any) => m.role === 'user').pop()].filter(Boolean);
      // v0.5.5: Respect client's stream flag. If client wants streaming, forward
      // the stream as-is (Pi's OpenAI client needs SSE with [DONE] markers).
      // If client wants non-streaming, collect and return JSON.
      const clientWantsStream = body.stream === true;
      try {
        const baseUrl = agentRegistry.getProviderBaseUrl(trivialCfg.provider);
        const apiKey = agentRegistry.getProviderApiKey(trivialCfg.provider);
        if (baseUrl && apiKey) {
          const cleanModel = trivialCfg.model.includes('/') ? trivialCfg.model.split('/').slice(1).join('/') : trivialCfg.model;
          const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ messages: greetingMessages, model: cleanModel, stream: clientWantsStream }),
            signal: AbortSignal.timeout(10000),
          });
          if (resp.ok) {
            emitModeHeaders(req, res, promptText);
            if (clientWantsStream) {
              // Forward the upstream SSE stream as-is
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
              });
              const reader = resp.body?.getReader();
              if (reader) {
                const streamState = { sawFinishReason: false, sawDone: false };
                const decoder = new TextDecoder();
                let buffer = '';
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let idx;
                    while ((idx = buffer.indexOf('\n\n')) !== -1) {
                      const evt = buffer.slice(0, idx);
                      buffer = buffer.slice(idx + 2);
                      if (!evt.trim()) continue;
                      for (const line of evt.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        const d = line.slice(5).trim();
                        if (d === '[DONE]') streamState.sawDone = true;
                        else if (d) {
                          try {
                            const parsed = JSON.parse(d);
                            if (Array.isArray(parsed?.choices)) {
                              for (const c of parsed.choices) {
                                if (c?.finish_reason != null) streamState.sawFinishReason = true;
                              }
                            }
                          } catch {}
                        }
                      }
                      res.write(evt + '\n\n');
                    }
                  }
                  if (buffer.trim()) res.write(buffer + '\n\n');
                  // Ensure terminal markers
                  if (!streamState.sawFinishReason) {
                    res.write(`data: {"id":"chatcmpl-done","object":"chat.completion.chunk","created":${Math.floor(Date.now()/1000)},"model":"${cleanModel}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`);
                  }
                  if (!streamState.sawDone) {
                    res.write('data: [DONE]\n\n');
                  }
                  res.end();
                } catch (streamErr) {
                  if (!res.writableEnded) res.end();
                }
              } else {
                res.end();
              }
            } else {
              const data = await resp.json();
              return jsonResponse(res, 200, data);
            }
            return;
          }
          if (resp.status === 429 || resp.status === 1305 || resp.status === 1308) {
            providerQuota.record429(trivialCfg.provider);
            // v0.5.5: Feed the greeting-fast-path failure to the intelligence layer
            // so the trivial tier gets rebalanced if ZAI is persistently exhausted
            consumptionIntelligence.recordFallbackOutcome('trivial', trivialCfg.provider, trivialCfg.model, false, '429');
            console.log(`⚡ [${agent.name}] Greeting fast-path failed (429) — falling through to normal routing`);
            // Fall through to normal routing below
          } else {
            const errData = await resp.json().catch(() => ({}));
            return jsonResponse(res, resp.status, { error: errData.error || { message: `Provider error: ${resp.status}`, type: 'provider_error' } });
          }
        }
      } catch {
        console.log(`⚡ [${agent.name}] Greeting fast-path error — falling through to normal routing`);
        // Fall through
      }
    }
    if (trivialHealth.shouldSwitch) {
      console.log(`⚡ [${agent.name}] Greeting fast-path blocked: ${trivialCfg.provider} ${trivialHealth.reason} — using normal routing`);
    }
  }
  // ────────────────────────────────────────────────────────────





  // Score complexity — v0.4 ensemble
  const v04Score = await scoreIntentV04(promptText);
  let score = v04Score.value;
  let effort: EffortLevel = v04Score.tier ?? 'moderate';

  // v0.5.7: effort_override bypasses ensemble scoring; jump straight to the named tier.
  if (effortOverride) {
    score = ({ trivial: 0.05, light: 0.15, moderate: 0.28, heavy: 0.38, intensive: 0.45, extreme: 0.55 } as Record<string, number>)[effortOverride];
    effort = effortOverride as EffortLevel;
  }

  // ─── v0.4.4: Context Continuity Anchor ─────────────────────
  // Extract session ID from request body or generate from agent+prompt hash
  const sessionId = body.session_id
    || body.session
    || `${agent.id}:${promptText.slice(0, 100)}`;

  const modeDetection = detectIntentMode(promptText);
  const activeMode: IntentMode = modeOverride ?? modeDetection.mode;

  // ─── v0.5.6: Token Consumption Intelligence Routing (async with probing) ──────
  // MoMA: estimate over flattened text (media parts count as placeholders);
  // requireVision restricts candidates to vision-capable models.
  const estimatedPromptTokens = estimateTokens(
    messages.map((m: any) => messageContentToText(m?.content)).join('\n'),
  );
  let decision: ConsumptionDecision;
  try {
    decision = await consumptionIntelligence.selectModel(effort, {
      estimatedPromptTokens,
      source: 'request',
      requireVision: requestModalities.vision,
    });
  } catch {
    console.log(`🧠 [${agent.name}] Intelligence engine failed — using static config`);
    const staticCfg = getTierModel(effort);
    decision = {
      provider: staticCfg?.provider || 'zai',
      model: staticCfg?.model || 'glm-4.5-air',
      tier: effort,
      reason: 'static_fallback',
      estimatedTokens: estimatedPromptTokens,
      estimatedCost: 0,
      confidence: 0.1,
      alternatives: [],
      source: 'request',
      timestamp: Date.now(),
    };
  }

  let providerId = decision.provider;
  let model = decision.model;

  const continuity = getContinuity(sessionId);
  if (continuity && continuity.lastModel !== model) {
    console.log(`🔄 [${agent.name}] Model switch: ${continuity.lastModel} → ${model}`);
  }

  // v0.5.3: plan mode override
  const rawTier = getTierModel(effort);
  if (activeMode === 'plan' && rawTier?.plan_model) {
    providerId = rawTier.plan_provider || decision.provider;
    model = rawTier.plan_model;
    console.log(`📋 [${agent.name}] Plan mode override: ${providerId}/${model}`);
  }

  console.log(`🧠 [${agent.name}] Score: ${score.toFixed(3)} → ${effort} (${activeMode}) → ${providerId}/${model} [${decision.reason}, conf=${decision.confidence.toFixed(2)}]`);
  const interactionId = `${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ─── v0.5.6: Trivial Fast-Path ──────────────────────
  // For TRIVIAL-tier requests targeting a TINY local model (qwen2.5:0.5b,
  // qwen2.5:1.5b, gemma2:2b etc), strip the system prompt and RAG context
  // when the user prompt is short. A 0.5B model on CPU takes ~20s to process
  // a 4K-token system prompt for a "hi" — the prompt overhead dwarfs the
  // generation. Stripping it makes trivial responses 5–10× faster.
  //
  // Heuristic: if effort is trivial AND model size < 2B AND user prompt
  // is < 50 chars, send only the last user message — no system, no history.
  const modelSizeB = (() => {
    const m = String(model).match(/(\d+\.?\d*)b(?:[-_]|\b|$)/i);
    return m ? parseFloat(m[1]) : 999;
  })();
  const lastUserMsg = messages.filter((m: any) => m.role === 'user').pop();
  const userPromptLen = messageContentToText(lastUserMsg?.content).length;
  const isTrivialFastPath =
    effort === 'trivial' &&
    modelSizeB <= 2.0 &&
    userPromptLen > 0 &&
    userPromptLen < 60 &&
    providerId === 'ollama';

  let workingMessages = messages;
  if (isTrivialFastPath) {
    workingMessages = [lastUserMsg];
    console.log(`⚡ [${agent.name}] Trivial fast-path: stripped system+RAG (user prompt: ${userPromptLen} chars, model: ${modelSizeB}B)`);
  }

  // ─── TurboQuant Context Compression v3.5 ──────────────────
  // Auto-compact with dynamic thresholds per model context window
  const compressionResult = turboQuantCompress({
    messages: workingMessages,
    targetModel: model,
    // reservedTokens omitted — compressor computes dynamically per model
  });

  // FIX v3.5: compressedMessages declared BEFORE RAG injection (was after → crash)
  const compressedMessages = compressionResult.messages;

  // RAG retrieval: inject relevant compressed context if available
  // v0.4.4: Also inject continuity summary if model switch detected
  // IMPORTANT: Only inject BEFORE the first non-system message to avoid
  // "system message mid-conversation" errors from Bailian (code 1214)
  if (compressionResult.compressionRatio > 1.0 && ragIndex.length > 0) {
    const promptKeywords = promptText.toLowerCase().split(/\s+/)
      .filter((w: string) => w.length > 4 && !/^(the|and|for|with|this|that|from|have|been|were|their|there|about|would|could|should|which|other|these|some|what|when|where|who|will|each|make|just|like|than|them|very|only|after|before|between|under|while|after|through|during)/.test(w));
    const uniqueKeywords = [...new Set(promptKeywords)].slice(0, 10) as string[];

    if (uniqueKeywords.length > 0) {
      const relevantEntries = queryRag(uniqueKeywords, 3);
      if (relevantEntries.length > 0) {
        const ragContext = relevantEntries
          .map(e => `[Retrieved context from ${e.originalRole}: ${e.summary}]`)
          .join('\n');
        // Merge into the first system message instead of inserting a new one mid-conversation
        const firstSystemIdx = compressedMessages.findIndex((m: any) => m.role === 'system');
        if (firstSystemIdx >= 0) {
          const existing = typeof compressedMessages[firstSystemIdx].content === 'string'
            ? compressedMessages[firstSystemIdx].content
            : '';
          compressedMessages[firstSystemIdx].content = existing + '\n\nRelevant prior context (auto-retrieved):\n' + ragContext;
        } else {
          // No system message — insert at the very beginning
          compressedMessages.unshift({
            role: 'system',
            content: `Relevant prior context (auto-retrieved):\n${ragContext}`,
          });
        }
        console.log(`🔍 [${agent.name}] RAG injected ${relevantEntries.length} entries`);
      }
    }
  }

  // v0.4.4: Inject continuity summary if available and model switched
  if (continuity && continuity.keyDecisions.length > 0) {
    const continuitySummary = `\n\nContinuity from previous turn (${continuity.lastTier}→${continuity.lastModel}):\n` +
      continuity.keyDecisions.slice(-3).map(d => `- ${d}`).join('\n');
    const firstSystemIdx = compressedMessages.findIndex((m: any) => m.role === 'system');
    if (firstSystemIdx >= 0) {
      const existing = typeof compressedMessages[firstSystemIdx].content === 'string'
        ? compressedMessages[firstSystemIdx].content
        : '';
      compressedMessages[firstSystemIdx].content = existing + continuitySummary;
    } else {
      compressedMessages.unshift({
        role: 'system',
        content: continuitySummary.trim(),
      });
    }
    console.log(`🔗 [${agent.name}] Continuity: ${continuity.keyDecisions.length} decisions preserved`);
  }

  if (compressionResult.compressionRatio > 1.0) {
    console.log(`📦 [${agent.name}] TurboQuant v3.6: ${compressionResult.originalTokens} → ${compressionResult.compressedTokens} tokens (${compressionResult.compressionRatio.toFixed(1)}x) | KV≈${(compressionResult.kvCacheEstimateBytes / 1024 / 1024).toFixed(1)}MB | Q8:${compressionResult.tierCounts.Q8} Q4:${compressionResult.tierCounts.Q4} Q2:${compressionResult.tierCounts.Q2} Q1:${compressionResult.tierCounts.Q1} Q0:${compressionResult.tierCounts.Q0} | RAG:${compressionResult.ragStored} (index:${ragIndex.length})`);
  }

  // ─── Post-compression: sanitize message sequence ──────────
  // Providers like Bailian reject (code 1214) when:
  //   1. Consecutive messages have the same role
  //   2. System messages appear mid-conversation
  //   3. Tool messages appear without a parent assistant message
  // This pass fixes all three issues.
  // ──────────────────────────────────────────────────────────
  const sanitizeMessages = (msgs: any[]): any[] => {
    if (msgs.length <= 1) return [...msgs];

    // Phase 1: Move all system messages to the front
    const systemMsgs = msgs.filter(m => m.role === 'system');
    const nonSystemMsgs = msgs.filter(m => m.role !== 'system');

    // Phase 2: Merge consecutive same-role messages in non-system msgs
    // BUT skip tool messages — each tool result has its own tool_call_id and
    // may contain structured content (images, file data). Merging would
    // destroy the tool_call_id mapping and stringify content arrays.
    const merged: any[] = [];
    for (const msg of nonSystemMsgs) {
      const prevMsg = merged.length > 0 ? merged[merged.length - 1] : null;
      if (
        prevMsg &&
        prevMsg.role === msg.role &&
        msg.role !== 'tool' &&  // Never merge tool messages
        !messageHasMediaParts(prevMsg) && !messageHasMediaParts(msg)  // MoMA: keep media arrays intact
      ) {
        // Merge content
        const prevContent = typeof prevMsg.content === 'string' ? prevMsg.content : JSON.stringify(prevMsg.content);
        const currContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        prevMsg.content = prevContent + '\n---\n' + currContent;
      } else {
        merged.push({ ...msg });
      }
    }

    // Phase 3: Ensure the sequence starts with 'user' or 'system'
    // If the first non-system message isn't 'user', prepend a placeholder
    const result = [...systemMsgs];
    if (merged.length > 0 && merged[0].role !== 'user') {
      // Try to find the first user message and move it up, otherwise skip assistant messages at start
      const firstUserIdx = merged.findIndex(m => m.role === 'user');
      if (firstUserIdx > 0) {
        // Pull the first user message to the front, drop preceding assistant messages
        result.push(merged[firstUserIdx], ...merged.slice(firstUserIdx + 1));
      }
      // If no user message at all, just use what we have (edge case)
      else {
        result.push(...merged);
      }
    } else {
      result.push(...merged);
    }

    // Phase 5: Remove empty content messages + ensure tool always follows assistant
    const valid: any[] = [];
    const hasToolCallParent = new Set<string>();
    for (const msg of result) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) hasToolCallParent.add(tc.id);
        }
      }
    }
    for (const msg of result) {
      // Skip empty content - BUT preserve assistant messages with tool_calls (they're structural anchors)
      if (!msg.content && !(msg.role === 'assistant' && msg.tool_calls)) continue;
      if (typeof msg.content === 'string' && msg.content.trim() === '' && !(msg.role === 'assistant' && msg.tool_calls)) continue;
      // Skip null content assistant messages WITHOUT tool_calls
      if (msg.role === 'assistant' && msg.content === null && !msg.tool_calls) continue;
      // Skip orphaned tool messages (no parent assistant)
      if (msg.role === 'tool') {
        if (msg.tool_call_id && !hasToolCallParent.has(msg.tool_call_id)) continue;
        // v0.5.2 fix: Tool must follow an assistant or another tool message.
        // Multi-tool returns (tc1, tc2, tc3) are consecutive tool messages —
        // only the first follows an assistant directly; subsequent ones follow
        // the previous tool message. DeepSeek and other strict providers reject
        // tool_calls where any tool_call_id is unmatched.
        const prevRole = valid.length > 0 ? valid[valid.length - 1].role : null;
        if (prevRole !== 'assistant' && prevRole !== 'tool') continue;
      }
      valid.push(msg);
    }

    // Phase 6: Final safety — drop leading non-system/non-user messages
    while (valid.length > 0 && valid[0].role !== 'system' && valid[0].role !== 'user') {
      valid.shift();
    }

    // Phase 7: ZAI/Bailian require at least one user message. If missing after compression,
    // inject a synthetic one right after the system message.
    if (!valid.some(m => m.role === 'user')) {
      const sysEnd = valid.findIndex(m => m.role !== 'system');
      const insertIdx = sysEnd < 0 ? valid.length : sysEnd;
      valid.splice(insertIdx, 0, { role: 'user', content: '[Continuing conversation — please respond]' });
    }

    // Phase 8 (v0.5.2): Safety net — strip orphaned tool_calls from assistants.
    // TurboQuant compression and message dropping can leave assistant messages
    // with tool_calls whose corresponding tool responses were removed. Providers
    // like DeepSeek reject these with "insufficient tool messages following
    // tool_calls message". Rather than fail, drop the tool_calls metadata.
    const validToolIds = new Set<string>();
    for (const msg of valid) {
      if (msg.role === 'tool' && msg.tool_call_id) validToolIds.add(msg.tool_call_id);
    }
    for (const msg of valid) {
      if (msg.role === 'assistant' && msg.tool_calls?.length > 0) {
        const covered = msg.tool_calls.every((tc: any) => validToolIds.has(tc.id));
        if (!covered) {
          delete msg.tool_calls;
          // After stripping tool_calls, content may be null — replace
          // with placeholder to satisfy strict APIs (DeepSeek rejects
          // assistant messages with null content and no tool_calls)
          if (msg.content === null || msg.content === undefined || (typeof msg.content === 'string' && msg.content.trim() === '')) {
            msg.content = '[tool use]';
          }
        }
      }
    }

    return valid;
  };

  const sanitizedMessages = sanitizeMessages(compressedMessages);
  compressedMessages.length = 0;
  compressedMessages.push(...sanitizedMessages);

  // ─── v0.5: CLI Provider Dispatch ──────────────────────────
  // If provider is a CLI agent, use light sanitization + subprocess dispatch.
  // LOOP GUARD: If the authenticated agent IS this CLI provider, routing
  // back to it would create an infinite loop (agent → gateway → agent → …).
  // In that case, fall through to HTTP providers instead.
  const isCli = agentRegistry.isCliProvider(providerId);
  if (isCli && agent.id !== providerId) {
    // Pre-flight the CLI before committing to subprocess dispatch.
    // handleCliProvider has no fallback chain of its own, so an unavailable
    // CLI (binary missing, auth absent, quota window exhausted) must divert
    // to the tier's fallback chain HERE — otherwise a plan-mode request whose
    // plan model is a CLI agent hard-503s while healthy HTTP fallbacks exist.
    const avail = await agentRegistry.checkCliProviderAvailability(providerId);
    if (!avail.ok) {
      console.log(`⚠️  [${agent.name}] CLI ${providerId}/${model} unavailable (${avail.reason}) — diverting to ${effort} fallback chain`);
      const unavailableCli = providerId;
      const fbList = getTierModel(effort)?.fallback_models ?? [];
      for (const fb of fbList) {
        if (fb.provider === unavailableCli) continue;
        if (agentRegistry.isCliProvider(fb.provider)) {
          if (fb.provider === agent.id) continue; // loop guard applies to fallbacks too
          const fbAvail = await agentRegistry.checkCliProviderAvailability(fb.provider);
          if (fbAvail.ok) { providerId = fb.provider; model = fb.model; break; }
        } else if (
          agentRegistry.getProviderBaseUrl(fb.provider) &&
          agentRegistry.getProviderApiKey(fb.provider) &&
          !providerQuota.shouldSwitch(fb.provider).shouldSwitch
        ) {
          providerId = fb.provider; model = fb.model; break;
        }
      }
      if (providerId !== unavailableCli) {
        console.log(`✅ [${agent.name}] Diverted: ${effort} → ${providerId}/${model}`);
      }
    }
    if (agentRegistry.isCliProvider(providerId)) {
      // Healthy CLI (original or fallback) — or nothing usable, in which case
      // handleCliProvider reports the unavailability.
      const cliSanitized = sanitizeForCli(compressedMessages);
      compressedMessages.length = 0;
      compressedMessages.push(...cliSanitized);

      return handleCliProvider(
        providerId, model, agent, messages, effort,
        compressionResult, promptText, res, score, body.stream === true,
      );
    }
    // Diverted to an HTTP provider — fall through to HTTP dispatch below.
  }
  if (isCli && agent.id === providerId) {
    console.log(`🔒 [${agent.name}] Loop guard: skipping CLI dispatch to ${providerId} (self-reference)`);
  }
  // ──────────────────────────────────────────────────────────

  const startTime = Date.now();

  if (!body.stream) {
    const baseUrl = agentRegistry.getProviderBaseUrl(providerId);
    const apiKey = agentRegistry.getProviderApiKey(providerId);

    if (!baseUrl || !apiKey) {
      return jsonResponse(res, 503, {
        error: { message: `Provider ${providerId} not configured`, type: 'provider_unavailable' },
      });
    }

    const url = `${baseUrl}/chat/completions`;
    const tierModel = getTierModel(effort);
    const payload: any = { ...body, model, messages: compressedMessages };
    // v3.6: Only send enable_thinking to ZAI when TRUE — ZAI rejects enable_thinking=false
    if (tierModel?.enable_thinking === true && providerId === 'zai') {
      payload.enable_thinking = true;
    } else if (payload.enable_thinking !== undefined) {
      delete payload.enable_thinking;
    }

    // ─── 429/503 Fallback Chain: try primary then fallback_models from config ───
    // v0.5: Extended to support both HTTP and CLI providers
    interface RetryTarget {
      providerId: string;
      baseUrl?: string;
      apiKey?: string;
      model: string;
      label: string;
      isCli: boolean;
    }
    const buildTarget = (pid: string, mdl: string): RetryTarget | null => {
      // CLI provider
      if (agentRegistry.isCliProvider(pid)) {
        return { providerId: pid, model: mdl, label: `${pid}/${mdl}`, isCli: true };
      }
      // HTTP provider
      const bu = agentRegistry.getProviderBaseUrl(pid);
      const ak = agentRegistry.getProviderApiKey(pid);
      return (bu && ak) ? { providerId: pid, baseUrl: bu, apiKey: ak, model: mdl, label: `${pid}/${mdl}`, isCli: false } : null;
    };
    const initial = buildTarget(providerId, model);
    if (!initial) {
      return jsonResponse(res, 503, { error: { message: `Provider ${providerId} not configured`, type: 'provider_unavailable' } });
    }

    // ─── v0.5.3: Consumption Intelligence Fallback Chain ───
    // Build retry targets using consumption intelligence for smart fallback
    const retryTargets: RetryTarget[] = [initial];

    // Get intelligent fallbacks from consumption engine
    const intelFallback = await consumptionIntelligence.getFallback(effort, providerId, model, 'request', requestModalities.vision);
    if (intelFallback) {
      const ifb = buildTarget(intelFallback.provider, intelFallback.model);
      if (ifb) retryTargets.push(ifb);
    }

    // Supplement with static config fallbacks as backup
    const tierCfg = getTierModel(effort);
    if (tierCfg) {
      const fbModels = (tierCfg as any).fallback_models as Array<{model: string; provider: string}> | undefined;
      if (fbModels) {
        for (const fb of fbModels) {
          if (fb.provider === providerId && fb.model === model) continue;
          if (retryTargets.some(t => t.providerId === fb.provider && t.model === fb.model)) continue;
          const t = buildTarget(fb.provider, fb.model);
          if (t) retryTargets.push(t);
        }
      }
    }

    let data: any = null;
    let latency = 0;
    let actualTarget = initial;

    // v0.5.5: Global retry budget — don't spend more than 60s on fallbacks.
    // If all providers are rate-limited, failing fast is better than a
    // 5-minute cascade of guaranteed 429s.
    const retryDeadline = Date.now() + 60000;

    try {
    for (const target of retryTargets) {
      // ─── v0.5.5: Global budget check ───
      if (Date.now() > retryDeadline) {
        console.log(`⏱️  [${agent.name}] Retry budget exhausted (60s) — giving up`);
        break;
      }

      // ─── v0.5.5: Pre-flight quota check ───
      // Skip providers that are throttled or have critically low health.
      // This prevents the cascade failure where we try 5+ providers that are
      // all rate-limited, wasting 30+ seconds on guaranteed failures.
      if (!target.isCli) {
        const switchCheck = providerQuota.shouldSwitch(target.providerId);
        if (switchCheck.shouldSwitch) {
          console.log(`⏭️  [${agent.name}] Skipping ${target.label}: ${switchCheck.reason}`);
          continue;
        }
      }

      // ─── CLI provider fallback ───
      if (target.isCli) {
        console.log(`🔄 [${agent.name}] Trying CLI fallback: ${target.label}`);
        try {
          const avail = await agentRegistry.checkCliProviderAvailability(target.providerId);
          if (!avail.ok) {
            console.log(`⚠️  [${agent.name}] CLI ${target.label} unavailable: ${avail.reason}`);
            continue;
          }
          const cliResult = await (async () => {
            const adapter = agentRegistry.getCliAdapter(target.providerId)!;
            return adapter.chatCompletion(payload.messages, target.model, {});
          })();

          data = {
            id: `chatcmpl-cli-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: target.label,
            choices: [{ index: 0, message: { role: 'assistant', content: cliResult.content }, finish_reason: cliResult.finishReason }],
            usage: cliResult.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          latency = Date.now() - startTime;
          actualTarget = target;
          break;
        } catch (err: any) {
          console.log(`⚠️  [${agent.name}] CLI ${target.label} failed: ${err.message}`);
          // v0.5.5: Feed CLI failure to intelligence layer
          consumptionIntelligence.recordFallbackOutcome(effort, target.providerId, target.model, false, 'cli_error');
          continue;
        }
      }

      // ─── HTTP provider fallback ───
      let reqTimeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const fBaseUrl = target.baseUrl || '';
        const url = fBaseUrl.endsWith('/v1') || fBaseUrl.endsWith('/v4')
          ? `${fBaseUrl}/chat/completions`
          : fBaseUrl;
        const reqController = new AbortController();
        reqTimeoutId = setTimeout(() => reqController.abort(), 120000);
        // MoMA: non-vision targets reject image_url content parts (e.g. zai
        // error 1210) — flatten media to placeholders for them; vision-capable
        // targets receive the original content arrays.
        const targetPayload = requestModalities.vision
          && !consumptionIntelligence.modelSupportsVision(target.providerId, target.model)
          ? (() => {
              console.log(`⚠️  [${agent.name}] ${target.label} is not vision-capable — sending media parts as placeholders`);
              return { ...payload, messages: payload.messages.map(normalizeMessageContent), model: target.model };
            })()
          : { ...payload, model: target.model };
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${target.apiKey}`,
          },
          body: JSON.stringify(targetPayload),
          signal: reqController.signal,
        });
        clearTimeout(reqTimeoutId);

        if (resp.status === 429 || resp.status === 1305 || resp.status === 1308) {
          console.log(`⚠️  [${agent.name}] ${target.label} rate-limited (${resp.status}), trying fallback...`);
          modelMatrix.recordError(target.providerId, target.model, `rate-limited (${resp.status})`);
          providerQuota.record429(target.providerId);
          consumptionTracker.recordUsage(target.providerId, { tokensIn: 0, tokensOut: 0, latencyMs: 0, error: true });
          // v0.5.5: Feed the failure to the intelligence layer for self-healing
          consumptionIntelligence.recordFallbackOutcome(effort, target.providerId, target.model, false, '429');
          continue;
        }

        if (resp.status >= 500 && resp.status < 600) {
          console.log(`⚠️  [${agent.name}] ${target.label} server error (${resp.status}), trying fallback...`);
          modelMatrix.recordError(target.providerId, target.model, `server error (${resp.status})`);
          consumptionTracker.recordUsage(target.providerId, { tokensIn: 0, tokensOut: 0, latencyMs: 0, error: true });
          continue;
        }

        if (!resp.ok) {
          const error = await resp.text();
          console.error(`❌ Provider error: ${resp.status} ${error}`);
          jsonResponse(res, resp.status, { error: { message: error, type: 'provider_error' } });
          return;
        }

        data = await resp.json();
        latency = Date.now() - startTime;
        actualTarget = target;
        break;
      } catch (err: any) {
        clearTimeout(reqTimeoutId);
        if (err.name === 'AbortError') {
          console.error(`⏱️  ${target.label} timed out after 120s, trying fallback...`);
          modelMatrix.recordError(target.providerId, target.model, 'timeout after 120s');
          consumptionTracker.recordUsage(target.providerId, { tokensIn: 0, tokensOut: 0, latencyMs: 120000, error: true });
        } else {
          console.error(`❌ Forward error to ${target.label}: ${err.message}`);
          consumptionTracker.recordUsage(target.providerId, { tokensIn: 0, tokensOut: 0, latencyMs: 0, error: true });
        }
        continue;
      }
    }

    if (!data) {
      const tried = retryTargets.map(t => t.label).join(' → ');
      jsonResponse(res, 503, { error: { message: `All providers unavailable (tried: ${tried})`, type: 'service_unavailable' } });
      return;
    }
    if (actualTarget.providerId !== providerId) {
      console.log(`✅ Fallback succeeded: ${actualTarget.label}`);
    }

      const tokensIn = data.usage?.prompt_tokens || compressionResult.compressedTokens;
      const tokensOut = data.usage?.completion_tokens || 0;
      const totalTokens = data.usage?.total_tokens || (tokensIn + tokensOut);

      // Update agent usage
      await agentRegistry.updateUsage(agent.id, tokensIn, tokensOut);

      // ─── v0.5.3: Record to Model Matrix ────────────
      modelMatrix.recordUsage(actualTarget.providerId, actualTarget.model, tokensIn, tokensOut);
      const responseLatency = latency || (Date.now() - startTime);
      if (responseLatency > 0) {
        modelMatrix.recordLatency(actualTarget.providerId, actualTarget.model, responseLatency);
      }

      // ─── v0.5.3: Provider Quota tracking ───────────
      providerQuota.recordRequest(actualTarget.providerId, tokensIn + tokensOut);
      providerQuota.recordSuccess(actualTarget.providerId);

      // ─── v0.5.3: Consumption Tracker (5h/weekly/monthly) ───
      const responseLatency2 = latency || (Date.now() - startTime);
      consumptionTracker.recordUsage(actualTarget.providerId, {
        tokensIn,
        tokensOut,
        cost: 0, // Cost calc could go here if pricing model was active
        latencyMs: responseLatency2,
        error: false,
      });

      const responseText = data.choices?.[0]?.message?.content || '';
      const feedbackId = `${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      recordFeedback({
        prompt: promptText,
        predictedTier: effort,
        actualTier: null,
        modelUsed: `${actualTarget.providerId}/${actualTarget.model}`,
        responseTokens: tokensOut,
        adequacyScore: null,
        escalated: false,
        userSatisfaction: null,
        score,
      });

      selfEvaluate({
        prompt: promptText,
        response: responseText,
        predictedTier: effort,
        tokensIn,
        tokensOut,
        latencyMs: latency,
      }).then(evalResult => {
        console.log(`📊 [v0.4.4] Self-eval: adequacy=${evalResult.quickScore.toFixed(2)} escalate=${evalResult.shouldEscalate}`);

        if (evalResult.llmScore !== null && evalResult.predictedCorrectTier) {
          updateAdequacy(feedbackId, evalResult.llmScore, evalResult.predictedCorrectTier);
          console.log(`📊 [v0.4.4] actualTier=${evalResult.predictedCorrectTier} adequacy=${evalResult.llmScore.toFixed(2)}`);
          calibrateBronze(evalResult.predictedCorrectTier === effort);
        }
      }).catch(() => {});

      const silverTier = inferRagConsensus(promptText);
      if (silverTier) {
        console.log(`🥈 [v0.4.4] SILVER label: ${silverTier} (RAG consensus)`);
        calibrateSilver(silverTier === effort);
      }

      const voteRequest = createVoteRequest(agent.id, promptText, effort, v04Score.confidence ?? 0.7);
      if (voteRequest) {
        console.log(`🎯 [${agent.name}] Training vote: ${voteRequest.id} (${effort})`);
        const votePrompt = voteRequest.prompt;
        const responseData = { ...data, _voteRequest: { id: voteRequest.id, prompt: votePrompt } };
        return jsonResponse(res, 200, responseData);
      }

      const keywords: string[] = promptText.toLowerCase().split(/\s+/)
        .filter((w: string) => w.length > 4 && !/^(the|and|for|with|this|that|from|have|been)/.test(w));
      addRagEntry({
        keywords: [...new Set(keywords)].slice(0, 10) as string[],
        tier: effort,
        modelUsed: `${actualTarget.providerId}/${actualTarget.model}`,
        adequacyScore: 1,
        summary: responseText.slice(0, 200),
        originalTokens: tokensIn,
        compressedTokens: compressionResult.compressedTokens,
      });

      updateContinuity(sessionId, effort, `${actualTarget.providerId}/${actualTarget.model}`, responseText);
      // ─────────────────────────────────────────────────────

      // Benchmark logging (if enabled for this agent)
      if (agent.benchmarkEnabled) {
        await benchmarkLogger.log({
          prompt: promptText.slice(0, 500),
          prompt_length: promptText.length,
          tier: effort,
          routed_model: `${actualTarget.providerId}/${actualTarget.model}`,
          tokens_in: typeof tokensIn === 'number' ? tokensIn : 0,
          tokens_out: typeof tokensOut === 'number' ? tokensOut : 0,
          latency_ms: latency,
          provider: actualTarget.providerId,
          status: data ? 'success' : 'error',
        });
      }

      res.setHeader('X-Mode', activeMode);
      res.setHeader('X-Mode-Confidence', modeDetection.confidence.toFixed(2));
      // v0.5.6: debug headers so operators can verify the actual classification
      // and routing decision without tailing server logs.
      res.setHeader('X-Tier', effort);
      res.setHeader('X-Score', score.toFixed(4));
      res.setHeader('X-Routed-Model', `${actualTarget.providerId}/${actualTarget.model}`);
      res.setHeader('X-Routed-Tier', effort);
      res.setHeader('X-Routing-Method', decision.source || 'request');
      if (decision.reason) res.setHeader('X-Routing-Reason', decision.reason);
      // MoMA: expose detected request modalities for transparency
      res.setHeader('X-Modality', requestModalities.vision || requestModalities.audio
        ? ['text', requestModalities.vision ? 'vision' : '', requestModalities.audio ? 'audio' : ''].filter(Boolean).join('+')
        : 'text');
      return jsonResponse(res, 200, data);
    } catch (err: any) {
      console.error(`❌ Provider error: ${err.message}`);
      return jsonResponse(res, 502, { error: { message: err.message, type: 'gateway_error' } });
    }
  } else {
    // ─── v0.5: CLI providers do not support streaming — downgrade to sync
    // LOOP GUARD: same self-reference check as non-streaming path
    if (agentRegistry.isCliProvider(providerId) && agent.id !== providerId) {
      console.log(`📝 [${agent.name}] Streaming disabled for CLI provider ${providerId}, using sync dispatch`);
      return handleCliProvider(
        providerId, model, agent, messages, effort,
        compressionResult, promptText, res, score, true,
      );
    }
    if (agentRegistry.isCliProvider(providerId) && agent.id === providerId) {
      console.log(`🔒 [${agent.name}] Loop guard (stream): skipping CLI dispatch to ${providerId}`);
    }
    // For streaming, compress before forwarding
    const compressedBody: any = { ...body, model, messages: compressedMessages };
    // v0.4.1: Both Bailian and ZAI support tool calling — pass tools through
    await forwardToProvider(providerId, model, compressedBody, res);
  }
}


// ─── v0.5: CLI Provider Dispatch ───────────────────────────

/**
 * Handle chat completion through a CLI agent subprocess.
 * Used when the resolved provider is a CLI agent (Claude Code, Codex, etc.)
 */
async function handleCliProvider(
  providerId: string,
  model: string,
  agent: AgentConfig,
  messages: any[],
  effort: EffortLevel,
  compressionResult: any,
  promptText: string,
  res: ServerResponse,
  score: number = 0,
  streamResponse = false,
): Promise<void> {
  const cliConfig = agentRegistry.getCliProviderConfig(providerId);
  if (!cliConfig) {
    return jsonResponse(res, 503, {
      error: { message: `CLI provider ${providerId} not configured`, type: 'provider_unavailable' },
    });
  }

  const adapter = agentRegistry.getCliAdapter(providerId);
  if (!adapter) {
    return jsonResponse(res, 503, {
      error: { message: `CLI provider ${providerId} adapter not initialized`, type: 'provider_unavailable' },
    });
  }

  const startTime = Date.now();
  let cliStream: CliStreamState | null = null;

  try {
    // Check availability (quota + command)
    const avail = await adapter.isAvailable();
    if (!avail.ok) {
      console.log(`⚠️  [${agent.name}] CLI provider ${providerId} unavailable: ${avail.reason}`);
      return jsonResponse(res, 503, {
        error: { message: `CLI provider ${providerId} unavailable: ${avail.reason}`, type: 'provider_unavailable' },
      });
    }

    if (streamResponse) {
      cliStream = startCliStream(res, providerId + '/' + model);
    }

    // Execute CLI
    const result = await adapter.chatCompletion(
      compressionResult.messages,
      model,
      { temperature: undefined, maxTokens: undefined },
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

    // ─── Same feedback/self-eval/RAG pipeline as HTTP providers ───

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
      score,
    });

    // Self-eval (non-blocking)
    selfEvaluate({
      prompt: promptText,
      response: result.content,
      predictedTier: effort,
      tokensIn,
      tokensOut,
      latencyMs: latency,
    }).then((evalResult) => {
      if (evalResult.llmScore !== null && evalResult.predictedCorrectTier) {
        updateAdequacy(feedbackId, evalResult.llmScore, evalResult.predictedCorrectTier);
        calibrateBronze(evalResult.predictedCorrectTier === effort);
      }
    }).catch(() => {});

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

    const sessionId = `${agent.id}:${promptText.slice(0, 100)}`;
    updateContinuity(sessionId, effort, `${providerId}/${result.model}`, result.content);

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

    console.log(`🖥️  [${agent.name}] CLI ${providerId}/${result.model}: ${tokensIn}→${tokensOut}tok, ${latency}ms`);

    if (streamResponse && cliStream) {
      finishCliStream(res, cliStream, result.content, (result.finishReason ?? 'stop') as StreamFinishReason);
      return;
    }

    return jsonResponse(res, 200, openaiResponse);
  } catch (err: any) {
    console.error(`❌ CLI provider error (${providerId}): ${err.message}`);
    if (streamResponse && cliStream) {
      finishCliStream(res, cliStream, `CLI provider error: ${err.message}`, 'length');
      return;
    }
    return jsonResponse(res, 502, {
      error: { message: `CLI provider error: ${err.message}`, type: 'cli_error' },
    });
  }
}

/**
 * Light sanitization for CLI provider messages.
 * CLI agents are more lenient than Bailian/ZAI — just merge consecutive same-role messages.
 */
function sanitizeForCli(msgs: any[]): any[] {
  // MoMA: CLI providers are text-only — flatten content arrays up front so
  // media parts become [image]/[audio] placeholders, never raw base64.
  msgs = msgs.map(normalizeMessageContent);
  if (msgs.length <= 1) return [...msgs];
  const systemMsgs = msgs.filter((m) => m.role === 'system');
  const nonSystemMsgs = msgs.filter((m) => m.role !== 'system');
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
}
async function init() {
  // ─── Secrets: Sovereign Vault first, .env fallback ───────
  // Must run before agentRegistry.initialize() — that's where provider
  // API keys are read from process.env. See src/secrets/README.md.
  const secrets = await loadVaultEnv();
  if (secrets.source === 'vault' || secrets.source === 'cache') {
    console.log(`🔐 [Secrets] ${secrets.count} keys from Sovereign Vault (container: ${secrets.container})`);
  } else if (secrets.source === 'env') {
    console.log(`🔐 [Secrets] vault unavailable — ${secrets.count} keys from local .env fallback`);
  } else {
    console.log('🔐 [Secrets] no vault and no .env — providers with missing keys will register unconfigured');
  }

  await benchmarkLogger.initialize();
  await agentRegistry.initialize();
  await modelMatrix.initialize();
  await providerQuota.initialize();
  await consumptionTracker.initialize();
  await quotaSync.initialize();

  // v0.5.5: Feed real dashboard quota data into provider health scoring on startup
  const realQuotaData = quotaSync.getRealQuotaData();
  if (Object.keys(realQuotaData).length > 0) {
    providerQuota.applyRealQuotaData(realQuotaData);
    console.log('📊 [Quota] Applied real dashboard data to health scores');
  }

  // ─── v0.5: Register CLI Providers ─────────────────────
  if (getCliProvidersEnabled()) {
    agentRegistry.registerDefaultCliProviders();
    const cliProvs = agentRegistry.getProviders().filter(p => p.type === 'cli-agent');
    console.log(`🖥️  CLI Providers: ${cliProvs.map(p => p.id).join(', ')} (enabled)`);
  } else {
    console.log(`🖥️  CLI Providers: disabled (set cliProviders.enabled=true in v04_config.json)`);
  }

  // v0.4.4: Initialize persistent stores
  initFeedbackStore();
  initRagIndex();
  startFeedbackAutoFlush();
  startRagAutoFlush();
  console.log('📦 Persistence: feedback + RAG stores initialized');

  // ─── v0.5.3: Token Consumption Intelligence ──────────
  modelDiscovery.start().catch(err =>
    console.error('❌ Model Discovery start failed:', err.message)
  );

  // ─── Provider Quota: Daily reset at midnight ────
  const scheduleDailyReset = () => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();
    setTimeout(() => {
      providerQuota.dailyReset();
      scheduleDailyReset();
    }, msUntilMidnight);
  };
  scheduleDailyReset();

  // v0.5.5: Tier recovery check every 5 minutes
  // Checks if any swapped providers have recovered and restores original defaults
  setInterval(() => {
    consumptionIntelligence.checkRecovery().catch(err =>
      console.error('❌ [Intel] Recovery check failed:', err.message)
    );
  }, 300000);
  console.log('🔄 [Intel] Tier recovery check: every 5min');

  const agents = agentRegistry.getAgents();
  console.log(`🚀 GateSwarm MoMA Router v0.5.6 (Routing Transparency) starting on :${PORT}`);
  console.log(`📊 Providers: ${agentRegistry.getProviders().map(p => p.id).join(', ')}`);
  console.log(`🤖 Registered agents: ${agents.map(a => a.name).join(', ')}`);

  // v0.4.4: Training mode default — off (enable via API)
  for (const agent of agents) {
    setTrainingMode(agent.id, false);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const method = req.method || 'GET';
    const apiKey = extractApiKey(req);

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    try {
      // ─── Health Check ───
      if (url.pathname === '/health' && method === 'GET') {
        const agents = agentRegistry.getAgents();
        return jsonResponse(res, 200, {
          status: 'healthy',
          router: 'GateSwarm MoMA Router v0.5.6 (Routing Transparency)',
          turboquant: 'v3.6',
          ensemble: 'enabled',
          feedback: 'enabled',
          llmJudge: getConfig().feedback_loop.llmJudgeModel,
          capabilities: {
            directRouting: true,
            cliProviders: true,
          },
          timestamp: new Date().toISOString(),
          providers: agentRegistry.getProviders().map(p => {
            const base: any = { id: p.id, name: p.name, type: p.type ?? 'http-api' };
            if (p.type === 'cli-agent') {
              return { ...base, quota: agentRegistry.getCliProviderQuotaStatus(p.id) };
            }
            return base;
          }),
          agents: agents.map(a => ({ id: a.id, name: a.name, provider: a.provider, requests: a.requestCount })),
        });
      }

      // ─── v0.5.3: Token Consumption Intelligence Endpoints ───

      if (url.pathname === '/v05/intel' && method === 'GET') {
        return jsonResponse(res, 200, {
          version: '0.5.7',
          stats: consumptionIntelligence.getStats(),
          recommendations: await consumptionIntelligence.getTierRecommendations(),
          recentDecisions: consumptionIntelligence.getRecentDecisions(20, 'request'),
        });
      }

      if (url.pathname === '/v05/intel/last-decision' && method === 'GET') {
        const recent = consumptionIntelligence.getRecentDecisions(1, 'request');
        if (recent.length === 0) {
          return jsonResponse(res, 404, { error: 'no recent request decisions' });
        }
        return jsonResponse(res, 200, recent[0]);
      }

      if (url.pathname === '/v05/intel/ops-guide' && method === 'GET') {
        const fs = await import('fs/promises');
        const path = await import('path');
        const guidePath = path.join(__dirname, '..', 'docs', 'OPS_GUIDE.md');
        try {
          const content = await fs.readFile(guidePath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          res.end(content);
          return;
        } catch (e: any) {
          return jsonResponse(res, 404, { error: `ops guide not found: ${e.message}` });
        }
      }

      // ─── v0.6: Plan/Act Mode Detection ───────────────────
      // POST /v06/mode/detect — Test mode detection on a prompt
      if (url.pathname === '/v06/mode/detect' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.prompt || typeof body.prompt !== 'string') {
          return jsonResponse(res, 400, { error: { message: 'prompt is required (string)', type: 'bad_request' } });
        }
        const result = detectIntentMode(body.prompt);
        return jsonResponse(res, 200, result);
      }

      // ─── v0.6: Plan/Act Routing Resolution ───────────────
      // POST /v06/resolve — Show what model would be used for a given (tier, mode)
      if (url.pathname === '/v06/resolve' && method === 'POST') {
        const body = await parseBody(req);
        const tier = body.tier as EffortLevel;
        const mode = (body.mode || 'auto') as IntentMode;
        if (!tier || !['trivial','light','moderate','heavy','intensive','extreme'].includes(tier)) {
          return jsonResponse(res, 400, { error: { message: 'tier must be one of: trivial, light, moderate, heavy, intensive, extreme', type: 'bad_request' } });
        }
        const resolved = getTierModelForMode(tier, mode);
        if (!resolved) {
          return jsonResponse(res, 404, { error: { message: `no model configured for tier=${tier}`, type: 'not_found' } });
        }
        return jsonResponse(res, 200, {
          tier,
          mode,
          resolved: {
            model: resolved.model,
            provider: resolved.provider,
            max_tokens: resolved.max_tokens,
            enable_thinking: resolved.enable_thinking,
          },
        });
      }

      if (url.pathname === '/v05/intel/models' && method === 'GET') {
        const models = modelMatrix.getAllModels();
        return jsonResponse(res, 200, {
          total: models.length,
          available: models.filter(m => m.available).length,
          models: models.sort((a, b) => b.totalTokensIn - a.totalTokensIn),
        });
      }

      if (url.pathname === '/v05/intel/providers' && method === 'GET') {
        return jsonResponse(res, 200, {
          providers: modelMatrix.getAllProviderSummaries(),
        });
      }

      if (url.pathname === '/v05/intel/rediscover' && method === 'POST') {
        modelDiscovery.forceRediscover().catch(err =>
          console.error('Force rediscover failed:', err.message)
        );
        return jsonResponse(res, 202, { status: 'rediscovery triggered' });
      }

      // ─── v0.5.3: Provider Quota & Load Balancing Endpoints ───

      if (url.pathname === '/v05/intel/consumption' && method === 'GET') {
        // Per-provider consumption across 5h/weekly/monthly/all-time windows
        // with per-window quota remaining (requests + tokens).
        const windowQuotas: Record<string, any> = {};
        for (const provider of new Set([
          ...Object.keys(providerQuota.getAllQuotas().map(q => q.provider)),
          ...Object.keys(consumptionTracker.getHistory().providers),
        ])) {
          const cfg = getMultiWindowQuota(provider);
          if (cfg) windowQuotas[provider] = cfg;
        }
        const report = consumptionTracker.buildReport({ windowQuotas });
        return jsonResponse(res, 200, report);
      }

      if (url.pathname === '/v05/intel/usage' && method === 'GET') {
        return jsonResponse(res, 200, {
          ...providerQuota.getUsageSummary(),
          timestamp: new Date().toISOString(),
        });
      }

      if (url.pathname === '/v05/intel/balance' && method === 'GET') {
        // Provider ranking for each tier
        const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
        const rankings: Record<string, any> = {};
        for (const tier of tiers) {
          try {
            const allModels = modelMatrix.getAvailableModels();
            const decision = await consumptionIntelligence.selectModel(tier, { source: 'balance-check' });
            rankings[tier] = {
              current: `${decision.provider}/${decision.model}`,
              reason: decision.reason,
              confidence: decision.confidence,
            };
          } catch {
            rankings[tier] = { current: 'unavailable', reason: 'no_candidates' };
          }
        }
        const swaps = consumptionIntelligence.getTierSwaps();
        return jsonResponse(res, 200, { rankings, swaps });
      }

      // v0.5.5: Tier swap observability
      if (url.pathname === '/v05/intel/swaps' && method === 'GET') {
        const swaps = consumptionIntelligence.getTierSwaps();
        const cfg = getConfig();
        const currentTiers: Record<string, string> = {};
        for (const [tier, tcfg] of Object.entries(cfg.tier_models)) {
          currentTiers[tier] = `${tcfg.provider}/${tcfg.model}`;
        }
        return jsonResponse(res, 200, { swaps, currentTiers });
      }

      if (url.pathname === '/v05/intel/sync' && method === 'GET') {
        // Real quota data scraped from provider dashboards/CLIs
        try {
          const syncFile = await import('fs/promises').then(fs => fs.readFile(
            join(__dirname, '../data/quota-sync.json'), 'utf-8'
          ).catch(() => null));
          if (syncFile) {
            const syncData = JSON.parse(syncFile);
            return jsonResponse(res, 200, syncData);
          }
        } catch {}
        return jsonResponse(res, 200, { version: '0.1.0', updatedAt: '', snapshots: {} });
      }

      if (url.pathname === '/v05/intel/quota' && method === 'GET') {
        // v0.5.5: Merge real dashboard data from quota-sync with internal tracking
        const realQuota = quotaSync.getRealQuotaData();
        const quotas = providerQuota.getAllQuotas().map(q => {
          const real = realQuota[q.provider];
          return {
          provider: q.provider,
          name: q.name,
          health: q.healthScore,
          rpm: `${q.rpmRemaining}/${q.rpm}${q.rpm === Infinity ? '' : ' RPM'}`,
          rpd: `${q.rpdRemaining}/${q.rpd}${q.rpd === Infinity ? '' : ' RPD'}`,
          tokens: q.tokensDailyLimit === Infinity ? '∞' : `${Math.round(q.tokensRemaining / 1000)}K/${Math.round(q.tokensDailyLimit / 1000)}K`,
          requestsToday: q.requestsToday,
          tokensToday: q.tokensToday,
          throttled: q.throttled,
          throttledUntil: q.throttledUntil > 0 ? new Date(q.throttledUntil).toISOString() : null,
          totalAllTime: q.totalTokens,
          // v0.5.5: Real dashboard data (from quota-sync scraper)
          realQuota: real ? {
            fiveHourUsedPct: real.fiveHourUsedPct,
            weeklyUsedPct: real.weeklyUsedPct,
            monthlyUsedPct: real.monthlyUsedPct,
            syncedAt: real.syncedAt,
          } : null,
        }; });
        return jsonResponse(res, 200, { quotas });
      }
      // ─── Global Metrics ───
      if (url.pathname === '/metrics' && method === 'GET') {
        const summary = await benchmarkLogger.getTodaySummary();
        return jsonResponse(res, 200, summary);
      }

      // ─── Per-Agent Metrics ───
      if (url.pathname.startsWith('/metrics/') && method === 'GET') {
        const agentId = url.pathname.split('/')[2];
        const agent = agentRegistry.getAgent(agentId);
        if (!agent) {
          return jsonResponse(res, 404, { error: { message: `Agent ${agentId} not found`, type: 'not_found' } });
        }
        return jsonResponse(res, 200, {
          agent: { id: agent.id, name: agent.name },
          usage: {
            requestCount: agent.requestCount,
            totalTokensIn: agent.totalTokensIn,
            totalTokensOut: agent.totalTokensOut,
            lastUsed: agent.lastUsed,
          },
          config: {
            provider: agent.provider,
            benchmarkEnabled: agent.benchmarkEnabled,
            tierConfig: agent.tierConfig,
          },
        });
      }

      // ─── Models List ───
      // ─── Models List ───
      if (url.pathname === '/v1/models' && method === 'GET') {
        const providers = agentRegistry.getProviders();
        const models: any[] = [
          { id: 'moma-router', object: 'model', created: Date.now(), owned_by: 'moma' },
        ];
        for (const provider of providers) {
          for (const model of provider.models) {
            // CLI models already have prefix notation (cc/, cx/, pi/, hm/, oc/)
            const modelId = provider.type === 'cli-agent' ? model : `${provider.id}/${model}`;
            models.push({
              id: modelId,
              object: 'model',
              owned_by: provider.id,
              providerType: provider.type ?? 'http-api',
            });
          }
        }
        return jsonResponse(res, 200, { object: 'list', data: models });
      }

      // ─── v0.5.1: List Providers (with types, health, quota) ───
      if (url.pathname === '/v1/providers' && method === 'GET') {
        const providers = agentRegistry.getProviders();
        const result = providers.map(p => {
          const info: any = {
            id: p.id,
            name: p.name,
            type: p.type ?? 'http-api',
            models: p.models,
          };
          if (p.type === 'cli-agent') {
            info.available = agentRegistry.getCliProviderQuotaStatus(p.id);
            info.healthCheck = p.cliConfig?.healthCheck?.command ?? null;
          } else {
            info.configured = !!(agentRegistry.getProviderBaseUrl(p.id) && agentRegistry.getProviderApiKey(p.id));
          }
          return info;
        });
        return jsonResponse(res, 200, { object: 'list', data: result });
      }

      // ─── v0.5.1: Direct Chat (alternative endpoint) ───
      if (url.pathname === '/v1/direct/chat' && method === 'POST') {
        const body = await parseBody(req);
  (req as any)._body = body;
        let agent: AgentConfig | null = null;
        const apiKey = extractApiKey(req);
        if (apiKey) {
          agent = await agentRegistry.authenticate(apiKey);
        }
        if (!agent) {
          agent = agentRegistry.getAgent('default') ?? null;
        }
        if (!agent) {
          return jsonResponse(res, 503, { error: { message: 'No agent configured', type: 'service_unavailable' } });
        }

        // Direct route must be specified
        const directRoute = body.direct_route;
        if (!directRoute || !directRoute.provider || !directRoute.model) {
          return jsonResponse(res, 400, {
            error: { message: 'direct_route with provider and model is required for /v1/direct/chat', type: 'missing_direct_route' },
          });
        }

        const messages = body.messages || [{ role: 'user', content: body.prompt || body.content || '' }];
        const lastUser = messages.filter((m: any) => m.role === 'user').pop();
        const promptText = lastUser?.content || '';
        return handleDirectRoute(req, res, agent, messages, promptText, directRoute.provider, directRoute.model);
      }

      // ─── List Agents ───
      if (url.pathname === '/v1/agents' && method === 'GET') {
        const agents = agentRegistry.getAgents();
        return jsonResponse(res, 200, {
          agents: agents.map(a => ({
            id: a.id,
            name: a.name,
            provider: a.provider,
            tierProfile: Object.entries(a.tierConfig).map(([tier, model]) => ({ tier, model })),
            benchmarkEnabled: a.benchmarkEnabled,
            requestCount: a.requestCount,
            createdAt: a.createdAt,
          })),
        });
      }

      // ─── Register Agent ───
      if (url.pathname === '/v1/agents/register' && method === 'POST') {
        const body = await parseBody(req);
  (req as any)._body = body;
        if (!body.name) {
          return jsonResponse(res, 400, { error: { message: 'name is required', type: 'bad_request' } });
        }
        const agent = await agentRegistry.registerAgent({
          name: body.name,
          provider: body.provider || 'moma',
          tierProfile: body.tierProfile || 'balanced',
          benchmarkEnabled: body.benchmarkEnabled ?? true,
          maxTokensPerRequest: body.maxTokensPerRequest,
        });
        return jsonResponse(res, 201, {
          message: `Agent ${agent.name} registered`,
          agent: {
            id: agent.id,
            name: agent.name,
            apiKey: agent.apiKey,
            provider: agent.provider,
            tierConfig: agent.tierConfig,
            benchmarkEnabled: agent.benchmarkEnabled,
          },
          connection: {
            base_url: `http://localhost:${PORT}/v1`,
            api_key: agent.apiKey,
          },
        });
      }

      // ─── Get Agent ───
      if (url.pathname.match(/^\/v1\/agents\/[a-z0-9-]+$/) && method === 'GET') {
        const agentId = url.pathname.split('/').pop()!;
        const agent = agentRegistry.getAgent(agentId);
        if (!agent) {
          return jsonResponse(res, 404, { error: { message: `Agent ${agentId} not found`, type: 'not_found' } });
        }
        return jsonResponse(res, 200, { agent });
      }

      // ─── Update Agent ───
      if (url.pathname.match(/^\/v1\/agents\/[a-z0-9-]+$/) && method === 'PATCH') {
        const agentId = url.pathname.split('/').pop()!;
        const agent = agentRegistry.getAgent(agentId);
        if (!agent) {
          return jsonResponse(res, 404, { error: { message: `Agent ${agentId} not found`, type: 'not_found' } });
        }
        const body = await parseBody(req);
  (req as any)._body = body;
        if (body.tierProfile && body.tierProfile in (await import('./agent-registry.js')).DEFAULT_TIER_CONFIGS) {
          const configs = (await import('./agent-registry.js')).DEFAULT_TIER_CONFIGS;
          agent.tierConfig = configs[body.tierProfile];
        }
        if (body.benchmarkEnabled !== undefined) agent.benchmarkEnabled = body.benchmarkEnabled;
        if (body.provider) agent.provider = body.provider;
        return jsonResponse(res, 200, { message: 'Agent updated', agent });
      }

      // ─── Chat Completions ───
      if (url.pathname === '/v1/chat/completions' && method === 'POST') {
        // Authenticate agent
        let agent: AgentConfig | null = null;

        if (apiKey) {
          agent = await agentRegistry.authenticate(apiKey);
        }

        // If no valid agent key, use default
        if (!agent) {
          agent = agentRegistry.getAgent('default') ?? null;
          if (!agent) {
            return jsonResponse(res, 503, {
              error: { message: 'No default agent configured', type: 'service_unavailable' },
            });
          }
          console.log(`⚠️  No API key — using default agent: ${agent.name}`);
        }

        return handleChatCompletion(req, res, agent);
      }

      // ─── v0.4 Status ───
      if (url.pathname === '/v04/status' && method === 'GET') {
        const config = getConfig();
        const interactionCount = getInteractionCount();
        const accuracy = getTierAccuracy();
        const activeWeights = getActiveWeights();
        const reasoningStatus = getReasoningStatus();
        return jsonResponse(res, 200, {
          version: config.version,
          method: config.method,
          interactions: interactionCount,
          ensemble: {
            weights: activeWeights,
            confidenceThresholds: config.ensemble.confidenceThresholds,
          },
          tierModels: config.tier_models,
          reasoning: reasoningStatus,
          feedback: {
            totalInteractions: interactionCount,
            perTierAccuracy: accuracy,
            shouldRetrain: shouldRetrain(config.feedback_loop.retrainAfterInteractions),
            retrainFrequency: config.feedback_loop.retrainAfterInteractions,
          },
          llmJudge: config.feedback_loop.llmJudgeModel,
          timestamp: new Date().toISOString(),
        });
      }

      // ─── v0.4 Feedback Stats ───
      if (url.pathname === '/v04/feedback' && method === 'GET') {
        return jsonResponse(res, 200, {
          totalInteractions: getInteractionCount(),
          recentEntries: getFeedbackEntries().slice(-20),
          perTierAccuracy: getTierAccuracy(),
          shouldRetrain: shouldRetrain(getConfig().feedback_loop.retrainAfterInteractions),
        });
      }

      // ─── v0.4 Trigger Retraining ───
      if (url.pathname === '/v04/retrain' && method === 'POST') {
        const result = await retrainIfNeeded();
        return jsonResponse(res, 200, {
          retrained: result.retrained,
          accuracyBefore: result.accuracyBefore,
          accuracyAfter: result.accuracyAfter,
          boundaries: result.boundaries,
          message: result.retrained
            ? `Tier boundaries recalibrated and applied live (${result.reason})`
            : `No retraining: ${result.reason ?? 'not enough data'}`,
        });
      }

      // ─── v0.4.4 Training Mode Endpoints ───

      // GET /v04/training?agentId=jack — Get training stats
      if (url.pathname === '/v04/training' && method === 'GET') {
        const agentId = url.searchParams.get('agentId') || 'jack';
        const stats = getTrainingStats(agentId);
        const calibration = getCalibrationStats();
        const trainingCheck = shouldRetrainTraining(agentId);
        return jsonResponse(res, 200, {
          agentId,
          stats,
          calibration,
          retraining: trainingCheck,
        });
      }

      // POST /v04/training/enable — Enable/disable training mode
      if (url.pathname === '/v04/training/enable' && method === 'POST') {
        const body = await parseBody(req);
  (req as any)._body = body;
        if (!body.agentId) {
          return jsonResponse(res, 400, { error: { message: 'agentId is required', type: 'bad_request' } });
        }
        setTrainingMode(body.agentId, body.enabled ?? true);
        return jsonResponse(res, 200, {
          agentId: body.agentId,
          enabled: body.enabled ?? true,
          message: `Training mode ${body.enabled !== false ? 'enabled' : 'disabled'} for ${body.agentId}`,
        });
      }

      // POST /v04/training/vote — Record a vote reply
      if (url.pathname === '/v04/training/vote' && method === 'POST') {
        const body = await parseBody(req);
  (req as any)._body = body;
        if (!body.voteId || !body.agentId || !body.reply) {
          return jsonResponse(res, 400, { error: { message: 'voteId, agentId, and reply are required', type: 'bad_request' } });
        }
        const success = processVoteReply(body.voteId, body.agentId, body.reply);
        return jsonResponse(res, 200, {
          success,
          message: success ? 'Vote recorded' : 'Vote not found or invalid reply',
        });
      }

      // POST /v04/training/vote/reply — Check if a message is a vote reply
      if (url.pathname === '/v04/training/vote/reply' && method === 'POST') {
        const body = await parseBody(req);
  (req as any)._body = body;
        if (!body.agentId || !body.message) {
          return jsonResponse(res, 400, { error: { message: 'agentId and message are required', type: 'bad_request' } });
        }
        const result = detectVoteReply(body.agentId, body.message);
        return jsonResponse(res, 200, {
          isVote: result?.isVote ?? false,
          voteId: result?.voteId ?? null,
        });
      }

      // ─── v0.5: CLI Provider Status ───
      if (url.pathname === '/v05/cli' && method === 'GET') {
        const cliProviders = agentRegistry.getProviders().filter(p => p.type === 'cli-agent');
        const status: any[] = [];
        for (const p of cliProviders) {
          const cfg = agentRegistry.getCliProviderConfig(p.id)!;
          const avail = await agentRegistry.checkCliProviderAvailability(p.id);
          status.push({
            id: p.id,
            name: p.name,
            available: avail.ok,
            reason: avail.reason ?? null,
            command: cfg.command,
            maxConcurrent: cfg.maxConcurrent,
            quota: agentRegistry.getCliProviderQuotaStatus(p.id),
            models: p.models,
            contextWindow: cfg.contextWindow ?? 0,
          });
        }
        return jsonResponse(res, 200, {
          enabled: getCliProvidersEnabled(),
          providers: status,
        });
      }



      // ─── 404 ───
      jsonResponse(res, 404, { error: { message: `Not found: ${url.pathname}`, type: 'not_found' } });

    } catch (err: any) {
      console.error(`❌ Server error: ${err.message}`);
      jsonResponse(res, 500, { error: { message: err.message, type: 'internal_error' } });
    }
  });

  server.listen(PORT, () => {
    console.log(`✅ GateSwarm MoMA Router v0.5.6 (Routing Transparency) listening on http://localhost:${PORT}`);
    console.log(`📡 Endpoint: http://localhost:${PORT}/v1/chat/completions`);
    console.log(`📊 Metrics: http://localhost:${PORT}/metrics`);
    console.log(`🤖 Agents: http://localhost:${PORT}/v1/agents`);
    console.log(`🎯 Training: http://localhost:${PORT}/v04/training`);
    console.log(`🧠 Intelligence: http://localhost:${PORT}/v05/intel`);
    console.log(`📊 Quota: http://localhost:${PORT}/v05/intel/quota`);
    console.log(`📈 Consumption: http://localhost:${PORT}/v05/intel/consumption`);
    console.log(`⚖️  Load Balancer: http://localhost:${PORT}/v05/intel/balance`);

    console.log(`\n🔗 Connection template for any agent:`);
    console.log(`   base_url: http://<host>:${PORT}/v1`);
    console.log(`   api_key:  moma-<agent-key>`);
  });
}

init().catch(console.error);

