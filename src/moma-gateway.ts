#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });
/**
 * GateSwarm MoMA Router v0.5.1 — Multi-Agent API Gateway
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
import { fileURLToPath } from 'url';







const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Configuration ─────────────────────────────────────

const PORT = parseInt(process.argv.find(a => a === '--port') ? process.argv[process.argv.indexOf('--port') + 1] : '8900', 10);

// ─── State ─────────────────────────────────────────────

const benchmarkLogger = new BenchmarkLogger();

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
      return { providerId, model: body.model };
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
  const payload = { messages: sanitizedMessages, model: cleanModel, stream: false };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    const latency = Date.now() - startTime;

    if (!response.ok) {
      return jsonResponse(res, response.status, {
        error: data.error || { message: `Provider error: ${response.status}`, type: 'provider_error' },
      });
    }

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

  try {
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
    return jsonResponse(res, 200, openaiResponse);
  } catch (err: any) {
    console.error(`❌ CLI provider error (direct, ${providerId}): ${err.message}`);
    return jsonResponse(res, 502, {
      error: { message: `CLI provider error: ${err.message}`, type: 'cli_error' },
    });
  }
}

/** Sanitize messages for OpenAI-compatible providers (remove tool messages, merge same-role). */
function sanitizeMessages(msgs: any[]): any[] {
  if (msgs.length <= 1) return [...msgs];
  const systemMsgs = msgs.filter(m => m.role === 'system');
  const nonSystemMsgs = msgs.filter(m => m.role !== 'system');
  const merged: any[] = [];
  for (const msg of nonSystemMsgs) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;
    if (prev && prev.role === msg.role && msg.role !== 'tool') {
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
      if (!reader) {
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      // v0.4.3: 30s idle timeout between SSE chunks
      const idleTimer = setTimeout(() => {
        console.log(`⏱️  Streaming idle timeout (30s), closing`);
        try { reader.cancel(); } catch {}
        res.end();
      }, 30000);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        idleTimer.refresh(); // reset idle timer on each chunk
        res.write(decoder.decode(value));
      }
      clearTimeout(idleTimer);
      res.end();
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
  const messages = body.messages || [];

  // Extract prompt text for complexity scoring
  const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop();
  let promptText = lastUserMessage?.content || JSON.stringify(messages);
  // Handle content that could be an array of blocks (e.g. [{type:"text",text:"..."}])
  if (typeof promptText !== 'string') {
    if (Array.isArray(promptText)) {
      promptText = promptText.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
    } else {
      promptText = String(promptText);
    }
  }



// Mode override: body.mode or X-Mode header; else auto-detect
  let modeOverride: IntentMode | null = null;
  if (body.mode === 'plan' || body.mode === 'act') modeOverride = body.mode as IntentMode;
  if (!modeOverride && req.headers['x-mode']) {
    const hdr = (req.headers['x-mode'] as string).trim().toLowerCase();
    if (hdr === 'plan' || hdr === 'act') modeOverride = hdr as IntentMode;
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
  // ────────────────────────────────────────────────────────────





  // Score complexity — v0.4 ensemble
  const v04Score = await scoreIntentV04(promptText);
  let score = v04Score.value;
  let effort: EffortLevel = v04Score.tier ?? 'moderate';

  // ─── v0.4.4: Context Continuity Anchor ─────────────────────
  // Extract session ID from request body or generate from agent+prompt hash
  const sessionId = body.session_id
    || body.session
    || `${agent.id}:${promptText.slice(0, 100)}`;

  const modeDetection = detectIntentMode(promptText);
  const activeMode: IntentMode = modeOverride ?? modeDetection.mode;
  const tierModelConfig = getTierModelForMode(effort, activeMode);

  const continuity = getContinuity(sessionId);
  if (continuity && continuity.lastModel !== (tierModelConfig?.model ?? '')) {
    // Model switch detected — inject continuity summary
    console.log(`🔄 [${agent.name}] Model switch: ${continuity.lastModel} → ${tierModelConfig?.model}`);
  }

  const resolved = agentRegistry.resolveModel(agent, effort);
  const providerId = resolved.providerId;
  const model = resolved.model;
  console.log(`🧠 [${agent.name}] Score: ${score.toFixed(3)} → ${effort} → ${providerId}/${model}`);
  const interactionId = `${agent.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ─── TurboQuant Context Compression v3.5 ──────────────────
  // Auto-compact with dynamic thresholds per model context window
  const compressionResult = turboQuantCompress({
    messages,
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
        msg.role !== 'tool'  // Never merge tool messages
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
        // Tool must follow an assistant message
        if (valid.length === 0 || valid[valid.length - 1].role !== 'assistant') continue;
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
    const cliSanitized = sanitizeForCli(compressedMessages);
    compressedMessages.length = 0;
    compressedMessages.push(...cliSanitized);

    return handleCliProvider(
      providerId, model, agent, messages, effort,
      compressionResult, promptText, res,
    );
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
    const tierModel = tierModelConfig ?? getTierModel(effort);
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

    // Build retry chain: primary → fallback_models from v04 config
    const retryTargets: RetryTarget[] = [initial];
    const tierCfg = tierModelConfig ?? getTierModel(effort);
    if (tierCfg) {
      const fbModels = (tierCfg as any).fallback_models as Array<{model: string; provider: string}> | undefined;
      if (fbModels) {
        for (const fb of fbModels) {
          // Skip if same as primary
          if (fb.provider === providerId && fb.model === model) continue;
          // Loop guard: skip if fallback is the same agent (infinite loop prevention)
          if (fb.provider === agent.id) {
            console.log(`🔒 [${agent.name}] Loop guard: skipping fallback to ${fb.provider} (self-reference)`);
            continue;
          }
          const t = buildTarget(fb.provider, fb.model);
          if (t) retryTargets.push(t);
        }
      }
    }

    let data: any = null;
    let latency = 0;
    let actualTarget = initial;

    try {
    for (const target of retryTargets) {
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
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${target.apiKey}`,
          },
          body: JSON.stringify({ ...payload, model: target.model }),
          signal: reqController.signal,
        });
        clearTimeout(reqTimeoutId);

        if (resp.status === 429 || resp.status === 1305 || resp.status === 1308) {
          console.log(`⚠️  [${agent.name}] ${target.label} rate-limited (${resp.status}), trying fallback...`);
          continue;
        }

        if (resp.status >= 500 && resp.status < 600) {
          console.log(`⚠️  [${agent.name}] ${target.label} server error (${resp.status}), trying fallback...`);
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
        } else {
          console.error(`❌ Forward error to ${target.label}: ${err.message}`);
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
        compressionResult, promptText, res,
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

  try {
    // Check availability (quota + command)
    const avail = await adapter.isAvailable();
    if (!avail.ok) {
      console.log(`⚠️  [${agent.name}] CLI provider ${providerId} unavailable: ${avail.reason}`);
      return jsonResponse(res, 503, {
        error: { message: `CLI provider ${providerId} unavailable: ${avail.reason}`, type: 'provider_unavailable' },
      });
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
    return jsonResponse(res, 200, openaiResponse);
  } catch (err: any) {
    console.error(`❌ CLI provider error (${providerId}): ${err.message}`);
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
  await benchmarkLogger.initialize();
  await agentRegistry.initialize();

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

  const agents = agentRegistry.getAgents();
  console.log(`🚀 GateSwarm MoMA Router v0.5.1 (CLI Providers + Direct Routing Bypass) starting on :${PORT}`);
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
          router: 'GateSwarm MoMA Router v0.5.1 (CLI Providers + Direct Routing Bypass)',
          turboquant: 'v3.6',
          ensemble: 'enabled',
          feedback: 'enabled',
          llmJudge: 'bailian/qwen3.5-plus',
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
          accuracy: result.accuracy,
          message: result.retrained
            ? 'Weights retrained and hot-swapped'
            : 'Not enough data for retraining',
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
    console.log(`✅ GateSwarm MoMA Router v0.5.1 (CLI Providers + Direct Routing Bypass) listening on http://localhost:${PORT}`);
    console.log(`📡 Endpoint: http://localhost:${PORT}/v1/chat/completions`);
    console.log(`📊 Metrics: http://localhost:${PORT}/metrics`);
    console.log(`🤖 Agents: http://localhost:${PORT}/v1/agents`);
    console.log(`🎯 Training: http://localhost:${PORT}/v04/training`);

    console.log(`\n🔗 Connection template for any agent:`);
    console.log(`   base_url: http://<host>:${PORT}/v1`);
    console.log(`   api_key:  moma-<agent-key>`);
  });
}

init().catch(console.error);

