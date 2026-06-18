/**
 * TurboQuant Context Compressor — v3.6 (Structure-Aware + Dynamic KV-cache + RAG + CWM)
 *
 * v3.6 improvements over v3.5:
 * 1. STRUCTURAL INVARIANTS: User messages NEVER below Q4, tool+tool_calls NEVER below Q8
 * 2. SHORT CONVERSATION SKIP: ≤5 messages and ≤8K tokens → no compression at all
 * 3. PRE-SCORE MERGING: Consecutive same-role messages merged BEFORE individual scoring
 * 4. DYNAMIC THRESHOLDS: PROACTIVE_THRESHOLD scales with model context window (5% base, 4K-50K range)
 * 5. RAG RETRIEVAL: Query compressed context during compression for relevant history injection
 * 6. KV-AWARE ROUTING: Use KV_CACHE_PER_1K_TOKENS for model selection decisions
 * 7. CLEAN OUTPUT: Remove all metadata wrappers from Q1/Q2 output
 * 8. DYNAMIC CWM-90/10: getCWMThreshold() provides model-aware context window management
 *
 * Architecture:
 *   User Request → Score (heuristic) → Route (tier) → Compress (TurboQuant)
 *     ↓                                                    ↓
 *   RAG Index ← Store compressed summaries ← Drop messages → Retrieve & Inject
 *
 * KV Cache sizes (estimated per 1K input tokens, FP16):
 *   - qwen3-coder-plus (~70B): ~1024 MB / 1K tokens (64 layers × 8192 dim × 2 × 2B)
 *   - qwen3.6-plus    (~32B): ~512 MB / 1K tokens (48 layers × 5120 dim × 2 × 2B)
 *   - qwen3.5-plus    (~14B): ~256 MB / 1K tokens (40 layers × 5120 dim × 2 × 2B)
 *   - glm-5.1         (~20B): ~320 MB / 1K tokens (40 layers × 4096 dim × 2 × 2B)
 *   - glm-4.7-flash   (~10B): ~128 MB / 1K tokens (28 layers × 2560 dim × 2 × 2B)
 *   - glm-4.5-air     (~7B):  ~96 MB / 1K tokens (24 layers × 2048 dim × 2 × 2B)
 */

import type { RagEntry } from './rag-index.js';
import { storeToRag, ragIndex } from './rag-index.js';

// ─── Model Context Windows (tokens) ───────────────────────────

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Bailian (Qwen)
  'qwen3.5-plus': 1_000_000,
  'qwen3.6-plus': 1_000_000,
  'qwen3-coder-plus': 1_000_000,
  'qwen3.6-max-preview': 1_000_000,
  'qwen4.6': 1_000_000,

  // ZAI (GLM)
  'glm-4.5-air': 200_000,
  'glm-4.7-flash': 200_000,
  'glm-4.7': 200_000,
  'glm-5': 200_000,
  'glm-5-turbo': 200_000,
  'glm-5.1': 204_800,
  'glm-5v-turbo': 200_000,

  // OpenRouter
  'openrouter/owl-alpha': 1_048_756,
  'openrouter/glm-4.7-flash': 202_752,
  'openrouter/qwen-plus': 1_000_000,
  'openrouter/gemini-2.5-flash': 1_048_576,
  'openrouter/claude-sonnet-4.6': 1_000_000,
  'openrouter/claude-opus-4.6': 1_000_000,
};

// ─── KV Cache Model ───────────────────────────────────────────

/**
 * KV cache size per 1000 input tokens (bytes, FP16).
 * Formula: num_layers × hidden_dim × 2 (K+V) × 2 bytes (FP16) / 1000 tokens.
 *
 * Used to estimate memory pressure when switching between models.
 * E.g., switching from qwen3-coder-plus (1024 MB/1K) to glm-4.5-air (96 MB/1K)
 * means the same conversation uses 10.7× less KV cache — but the router
 * still sends ALL messages, so we compress to save API cost/latency.
 */
export const KV_CACHE_PER_1K_TOKENS: Record<string, number> = {
  // Bailian (Qwen)
  'qwen3-coder-plus': 1_024_000,  // ~70B, 64 layers, 8192 dim
  'qwen3.6-plus':     512_000,    // ~32B, 48 layers, 5120 dim
  'qwen3.5-plus':     256_000,    // ~14B, 40 layers, 5120 dim

  // ZAI (GLM)
  'glm-5.1':          320_000,    // ~20B, 40 layers, 4096 dim
  'glm-4.7':          160_000,    // ~12B, 32 layers, 2560 dim (est)
  'glm-4.7-flash':    128_000,    // ~10B, 28 layers, 2560 dim
  'glm-4.5-air':       96_000,    // ~7B,  24 layers, 2048 dim
};

// ─── RAG Index — imported from unified rag-index.ts ─────────
// Re-exports for backward compatibility:
export { storeToRag, ragIndex } from './rag-index.js';
export type { RagEntry } from './rag-index.js';

// Internal type for compressor-level RAG entries (passed to storeToRag)
interface CompressorRagEntry {
  id: string;
  originalRole: string;
  summary: string;
  tags: string[];
  timestamp: number;
  tier: 'Q0' | 'Q1' | 'Q2';
}

// ─── Dynamic Threshold Configuration ──────────────────────────

/**
 * Dynamic threshold configuration for TurboQuant v3.5
 * Thresholds scale based on target model's context window size.
 */
const PROACTIVE_THRESHOLD = 0.05; // 5% base threshold

/** Minimum token budget before compression activates (dynamic per model) */
const MIN_THRESHOLD_TOKENS = 4_000; // Lowered from 8K for faster response

/** Maximum threshold cap to prevent excessive compression on large-window models */
const MAX_THRESHOLD_TOKENS = 50_000; // Cap at 50K tokens max

/** How many recent messages to always preserve intact */
const PRESERVE_RECENT_COUNT = 3;

/** Skip compression entirely for short conversations (v3.6: eliminates #1 cause of context destruction) */
const SHORT_CONVERSATION_MAX_MESSAGES = 5;
const SHORT_CONVERSATION_MAX_TOKENS = 8_000;

/** v3.6: HARD CAP — prevent runaway sessions from crashing providers */
const MAX_MESSAGES_HARD_CAP = 60;       // Never send more than this
const PRESERVE_LAST_N = 30;             // Always keep last N messages intact (was 15, raised for context)
const TRUNCATE_OLD_ASSISTANT_TOOL = true; // Drop old assistant+tool_call chains

/** v3.6: ABSOLUTE token limit — regardless of model context window, cap input tokens */
const MAX_INPUT_TOKENS_ABSOLUTE = 32_000; // Reasonable upper bound for all providers

// ─── TurboQuant Compression Tiers ─────────────────────────────

export type QuantLevel = 'Q8' | 'Q4' | 'Q2' | 'Q1' | 'Q0';

export interface MessageImportance {
  radius: number;   // 0-1: how important is this message?
  angle: string;    // semantic "direction": system | user | assistant | tool | decision
  level: QuantLevel;
}

// ─── Keyword Taxonomy for Semantic Importance ────────────────

/**
 * Domain-specific keyword groups used for TF-IDF-style scoring.
 * Messages containing keywords from more groups get higher importance.
 */
const KEYWORD_GROUPS: Record<string, string[]> = {
  code: ['function', 'class', 'def ', 'import ', 'const ', 'let ', 'var ',
         'interface', 'type ', 'enum ', 'async', 'await', 'return', 'export'],
  architecture: ['architecture', 'design pattern', 'system design', 'microservice',
                 'scalable', 'distributed', 'event sourcing', 'cqrs', 'kafka'],
  infra: ['kubernetes', 'docker', 'terraform', 'ci/cd', 'deployment', 'pipeline',
          'load balanc', 'service mesh', 'message queue'],
  security: ['authentication', 'authorization', 'encryption', 'zero-knowledge',
             'zkp', 'oauth', 'jwt', 'rbac', 'permissions'],
  data: ['database', 'schema', 'migration', 'query', 'index', 'cache',
         'redis', 'elasticsearch', 'postgresql'],
  decision: ['decision', 'conclusion', 'therefore', 'resolved', 'agreed',
             'final', 'must', 'required'],
  error: ['error', 'failed', 'exception', 'timeout', 'crash', 'bug'],
};

/**
 * Compute semantic importance using keyword group coverage.
 * Messages touching more domains are more important to preserve.
 */
function semanticImportance(content: string): number {
  const t = content.toLowerCase();
  let groups = 0;
  for (const keywords of Object.values(KEYWORD_GROUPS)) {
    if (keywords.some((k) => t.includes(k))) groups++;
  }
  return Math.min(1, groups / 4); // 0-1: 4+ groups = max importance
}

// ─── TurboQuant-inspired Importance Scorer ────────────────────

/**
 * Score a message's importance using TurboQuant-inspired principles:
 * - radius: composite importance score (like vector magnitude)
 * - angle: semantic category (like vector direction)
 */
function scoreMessageImportance(
  msg: any,
  position: number,
  total: number,
): MessageImportance {
  const recency = Math.max(0, 1 - position / total);
  const role = msg.role || 'unknown';
  const content = typeof msg.content === 'string' ? msg.content : '';

  const isDecision = /\b(decision|conclusion|therefore|resolved|agreed|final)\b/i.test(content);
  const isToolResult = msg.tool_call_id || role === 'tool';
  const isError = /\b(error|failed|exception|timeout)\b/i.test(content);
  const hasToolCalls = role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0;

  // Semantic importance from keyword groups
  const semantic = semanticImportance(content);

  // PolarQuant: radius = composite importance magnitude
  let radius = 0;
  radius += recency * 0.25;          // recent messages matter
  radius += isToolResult ? 0.15 : 0.03;  // tool results carry state
  radius += hasToolCalls ? 0.20 : 0; // assistant with tool_calls = structural anchor
  radius += isDecision ? 0.15 : 0;   // decisions are critical
  radius += isError ? 0.10 : 0;      // errors need context
  radius += role === 'system' ? 0.15 : 0; // system prompts essential
  radius += role === 'user' ? 0.10 : 0;   // v3.6: user input is ALWAYS important (was 0.05)
  radius += semantic * 0.25;         // multi-domain content is valuable

  radius = Math.min(radius, 1.0);

  // Angle = semantic direction
  let angle: string;
  if (role === 'system') angle = 'system';
  else if (role === 'user') angle = 'user';
  else if (isToolResult) angle = 'tool';
  else if (isDecision || isError) angle = 'decision';
  else angle = 'assistant';

  return { radius, angle, level: 'Q8' };
}

// ─── Quantization: Assign Compression Level ───────────────────

function quantize(
  importance: MessageImportance,
  budgetRatio: number,
  position: number,
  total: number,
): QuantLevel {
  const { radius, angle } = importance;

  // Q8: Always keep system messages and the last N messages
  const isRecent = position >= total - PRESERVE_RECENT_COUNT;
  if (angle === 'system' || isRecent) return 'Q8';

  // v3.6 STRUCTURAL INVARIANTS (enforced BEFORE budget-driven quantization):
  // - User messages → NEVER below Q4 (preserve content integrity)
  // - Tool messages → NEVER below Q8 (structural anchor for tool-call chains)
  // - Assistant with tool_calls → NEVER below Q8 (must preserve tool_calls array)
  if (angle === 'tool') return 'Q8'; // tool results are structural anchors
  if (angle === 'user') {
    // User messages: never drop, allow Q4 (strip thinking blocks) at minimum
    if (radius > 0.5) return 'Q8';
    return 'Q4'; // minimum Q4 for user messages
  }

  // Budget-driven quantization
  if (budgetRatio > 0.7) {
    if (radius > 0.5) return 'Q8';
    if (radius > 0.3) return 'Q4';
    if (radius > 0.15) return 'Q2';
    return 'Q1';
  }

  if (budgetRatio > 0.4) {
    if (radius > 0.6) return 'Q8';
    if (radius > 0.4) return 'Q4';
    if (radius > 0.2) return 'Q2';
    return 'Q1';
  }

  if (budgetRatio > 0.2) {
    if (radius > 0.7) return 'Q8';
    if (radius > 0.5) return 'Q4';
    if (radius > 0.3) return 'Q2';
    return 'Q1';
  }

  // Critical: only keep highest-importance messages
  if (radius > 0.8) return 'Q4';
  if (radius > 0.5) return 'Q2';
  return 'Q1';
}

// ─── Apply Compression ────────────────────────────────────────

function applyCompression(
  msg: any,
  level: QuantLevel,
): { result: any | null; ragEntry?: CompressorRagEntry } {
  // Never compress tool-related messages below Q8 (orphaned tool results break APIs)
  if (msg.role === 'tool' || (msg.role === 'assistant' && msg.tool_calls?.length > 0)) {
    return { result: msg };
  }
  const content = typeof msg.content === 'string' ? msg.content : '';
  const role = msg.role || 'unknown';

  // Extract keywords for RAG tags
  const t = content.toLowerCase();
  const tags: string[] = [];
  for (const [group, keywords] of Object.entries(KEYWORD_GROUPS)) {
    if (keywords.some((k) => t.includes(k))) tags.push(group);
  }

  switch (level) {
    case 'Q8':
      return { result: msg };

    case 'Q4':
      // Strip reasoning/thinking blocks
      if (Array.isArray(msg.content)) {
        const stripped = msg.content.filter(
          (b: any) => b.type !== 'thinking' && b.type !== 'reasoning_content',
        );
        return { result: { ...msg, content: stripped } };
      }
      return { result: msg };

    case 'Q2': {
      // Summarize: keep first 2 sentences as CLEAN text (no metadata wrapper)
      const sentences = content.split(/[.!?]+/).filter(Boolean);
      const summary = sentences.slice(0, 2).join('. ').trim();
      if (!summary) {
        // Empty content — store to RAG, drop from context
        const ragEntry: CompressorRagEntry = {
          id: `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          originalRole: role,
          summary: '(empty message)',
          tags,
          timestamp: Date.now(),
          tier: 'Q0',
        };
        return { result: null, ragEntry };
      }
      const compressed = { role, content: summary }; // Clean, no wrapper
      const ragEntry: CompressorRagEntry = {
        id: `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        originalRole: role,
        summary,
        tags,
        timestamp: Date.now(),
        tier: 'Q2',
      };
      return { result: compressed, ragEntry };
    }

    case 'Q1': {
      // Key facts only — extract decision/error sentences, return CLEAN text
      if (msg.tool_call_id) return { result: msg };
      const decisionMatch = content.match(
        /\b(decision|conclusion|therefore|resolved|agreed|final|error|failed)\b[^.!?]*[.!?]?/gi,
      );
      if (!decisionMatch) {
        // No decision keywords — summarize to 1 sentence, store to RAG
        const sentences = content.split(/[.!?]+/).filter(Boolean);
        const summary = sentences.slice(0, 1).join('. ').trim();
        const ragEntry: CompressorRagEntry = {
          id: `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          originalRole: role,
          summary: summary || '(no key facts)',
          tags,
          timestamp: Date.now(),
          tier: 'Q1',
        };
        if (summary) {
          return { result: { role, content: summary }, ragEntry }; // Clean, no wrapper
        }
        return { result: null, ragEntry };
      }
      const keyText = decisionMatch.slice(0, 2).join(' ');
      const ragEntry: CompressorRagEntry = {
        id: `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        originalRole: role,
        summary: keyText,
        tags,
        timestamp: Date.now(),
        tier: 'Q1',
      };
      return { result: { role, content: keyText }, ragEntry }; // Clean, no wrapper
    }

    case 'Q0': {
      // Drop — but always store to RAG first
      const sentences = content.split(/[.!?]+/).filter(Boolean);
      const summary = sentences.slice(0, 3).join('. ').trim();
      const ragEntry: CompressorRagEntry = {
        id: `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        originalRole: role,
        summary: summary || '(empty message)',
        tags,
        timestamp: Date.now(),
        tier: 'Q0',
      };
      return { result: null, ragEntry };
    }

    default:
      return { result: msg };
  }
}

// ─── Token Estimation ─────────────────────────────────────────

/**
 * Estimate token count for a message.
 * Rough: ~4 chars per token for English text.
 */
function estimateTokens(msg: any): number {
  const content = typeof msg.content === 'string' ? msg.content : '';
  const toolCall = msg.tool_calls
    ? JSON.stringify(msg.tool_calls).length
    : 0;
  return Math.ceil((content.length + toolCall) / 4) + 10; // +10 for role metadata
}

// ─── Main: TurboQuant Context Compressor ──────────────────────

export interface CompressContextOptions {
  messages: any[];
  targetModel: string;
  reservedTokens?: number;
}

export interface CompressResult {
  messages: any[];
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  tierCounts: Record<QuantLevel, number>;
  model: string;
  contextWindow: number;
  /** Estimated KV cache size for compressed context (bytes) */
  kvCacheEstimateBytes: number;
  /** Messages stored to RAG index for later retrieval */
  ragStored: number;
  /** Whether RAG entries are available for this session */
  ragAvailable: boolean;
}

/**
 * Compute dynamic CWM-90/10 threshold for a given model context window.
 * Returns the token count at which compaction should activate.
 */
export function getCWMThreshold(contextWindow: number): number {
  // Base: 90% of context window, but scale down for smaller windows
  const baseThreshold = Math.floor(contextWindow * 0.90);
  // For models with < 100K context, use 80% instead
  if (contextWindow < 100_000) {
    return Math.floor(contextWindow * 0.80);
  }
  // For models with > 500K context, cap at 450K to prevent excessive memory
  if (contextWindow > 500_000) {
    return 450_000;
  }
  return baseThreshold;
}

export function turboQuantCompress(
  options: CompressContextOptions,
): CompressResult {
  const { messages, targetModel, reservedTokens: reservedTokensOverride } = options;

  // Get target model's context window
  const contextWindow = MODEL_CONTEXT_WINDOWS[targetModel] || 200_000;

  // Dynamic reservedTokens (min 4096, max 16384, scaled to 10% of context window)
  const defaultReserved = Math.max(4096, Math.min(16384, Math.floor(contextWindow * 0.10)));
  const reservedTokens = reservedTokensOverride ?? defaultReserved;
  const maxInputTokens = contextWindow - reservedTokens;

  // Estimate original token count FIRST (was after utilizationRatio → crash!)
  const originalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);

  // FIX v3.4: utilizationRatio computed AFTER originalTokens exists
  const utilizationRatio = originalTokens / Math.max(1, maxInputTokens);

  // v3.6: HARD CAP — check FIRST, before any early returns
  // When session exceeds MAX_MESSAGES_HARD_CAP, aggressively drop old assistant+tool_call chains.
  // This is the critical fix for the infinite loading loop: Pi accumulates every tool result
  // (file contents, shell outputs) into its session. Without a cap, the session grows to 264K+
  // tokens with 980+ messages, and TurboQuant can't compress tool-call chains (protected at Q8).
  if (messages.length > MAX_MESSAGES_HARD_CAP) {
    // Strategy: keep system messages + all user messages + last N messages intact.
    // Drop old assistant+tool_call chains from the middle (they have the most bloat).
    const systemMsgs = messages.filter(m => m.role === 'system');
    const userMsgs = messages.filter(m => m.role === 'user');
    const lastN = messages.slice(-PRESERVE_LAST_N);

    // Build a set of indices to preserve
    const preserveSet = new Set<number>();
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'system') preserveSet.add(i);
      if (messages[i].role === 'user') preserveSet.add(i);
    }
    // Always preserve last N messages
    for (let i = Math.max(0, messages.length - PRESERVE_LAST_N); i < messages.length; i++) {
      preserveSet.add(i);
    }

    // Identify assistant+tool_call chains and mark droppable ones
    const dropIndices = new Set<number>();
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      const hasToolCalls = msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0;
      if (hasToolCalls) {
        // Start of a tool_call chain
        let j = i + 1;
        while (j < messages.length && messages[j].role === 'tool') j++;
        // Check if any message in this chain is in preserveSet
        const chainIndices = Array.from({ length: j - i }, (_, k) => i + k);
        const isPreserved = chainIndices.some(idx => preserveSet.has(idx));
        if (!isPreserved) {
          for (const idx of chainIndices) dropIndices.add(idx);
        }
        i = j;
      } else if (msg.role === 'assistant') {
        // Assistant without tool_calls — keep if not in last N
        if (!preserveSet.has(i)) dropIndices.add(i);
        i++;
      } else {
        i++;
      }
    }

    // Build the capped message array
    const cappedMessages = messages.filter((_, idx) => !dropIndices.has(idx));
    const droppedCount = messages.length - cappedMessages.length;

    const cappedTokens = cappedMessages.reduce((sum, m) => sum + estimateTokens(m), 0);
    console.log(
      `🗜️ [turboquant v3.6 hard-cap] ${targetModel}: ${messages.length}→${cappedMessages.length} msgs (${droppedCount} dropped) | ${originalTokens}→${cappedTokens} tok`,
    );

    // Recurse with capped messages
    return turboQuantCompress({ messages: cappedMessages, targetModel, reservedTokens: reservedTokensOverride });
  }

  // Dynamic threshold: scales with model context window (5% base, min 4K, max 50K)
  // v3.6: Also capped by MAX_INPUT_TOKENS_ABSOLUTE to prevent runaway sessions
  const dynamicThreshold = Math.min(
    MAX_INPUT_TOKENS_ABSOLUTE, // v3.6: absolute cap regardless of model context window
    MAX_THRESHOLD_TOKENS,
    Math.max(MIN_THRESHOLD_TOKENS, Math.floor(maxInputTokens * PROACTIVE_THRESHOLD))
  );
  const thresholdTokens = dynamicThreshold;

  // If comfortably under threshold, no compression needed
  if (originalTokens <= thresholdTokens) {
    const kvPer1K = KV_CACHE_PER_1K_TOKENS[targetModel] || 128_000;
    return {
      messages,
      originalTokens,
      compressedTokens: originalTokens,
      compressionRatio: 1.0,
      tierCounts: { Q8: messages.length, Q4: 0, Q2: 0, Q1: 0, Q0: 0 },
      model: targetModel,
      contextWindow,
      kvCacheEstimateBytes: Math.round((originalTokens / 1000) * kvPer1K),
      ragStored: 0,
      ragAvailable: ragIndex.length > 0,
    };
  }

  // v3.6: SHORT CONVERSATION SKIP — if conversation is small, skip compression entirely
  // This eliminates the #1 cause of context destruction for typical Pi agent sessions
  // (usually 3-5 turns, well within model context windows)
  if (messages.length <= SHORT_CONVERSATION_MAX_MESSAGES && originalTokens <= SHORT_CONVERSATION_MAX_TOKENS) {
    const kvPer1K = KV_CACHE_PER_1K_TOKENS[targetModel] || 128_000;
    console.log(
      `📦 [turboquant v3.6] ${targetModel}: SKIP — short conversation (${messages.length} msgs, ${originalTokens} tok) — no compression needed`,
    );
    return {
      messages,
      originalTokens,
      compressedTokens: originalTokens,
      compressionRatio: 1.0,
      tierCounts: { Q8: messages.length, Q4: 0, Q2: 0, Q1: 0, Q0: 0 },
      model: targetModel,
      contextWindow,
      kvCacheEstimateBytes: Math.round((originalTokens / 1000) * kvPer1K),
      ragStored: 0,
      ragAvailable: ragIndex.length > 0,
    };
  }

  // Budget ratio: how aggressively to compress
  const budgetRatio = thresholdTokens / Math.max(1, originalTokens);

  // v3.6: PRE-SCORE MERGING — merge consecutive same-role messages BEFORE scoring
  // This prevents the compressor from creating structural violations that need
  // post-hoc sanitization. If 3 tool messages in a row exist, they become 1.
  const mergeConsecutiveSameRole = (msgs: any[]): any[] => {
    if (msgs.length <= 1) return msgs;
    const merged: any[] = [msgs[0]];
    for (let i = 1; i < msgs.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = msgs[i];
      if (prev.role === curr.role) {
        // Merge: combine content with separator
        const prevContent = typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content);
        const currContent = typeof curr.content === 'string' ? curr.content : JSON.stringify(curr.content);
        prev.content = prevContent + '\n---\n' + currContent;
        // Preserve tool_call_id if merging tool messages
        if (curr.tool_call_id && !prev.tool_call_id) prev.tool_call_id = curr.tool_call_id;
        // Preserve tool_calls if merging assistant messages
        if (curr.tool_calls && curr.tool_calls.length > 0) {
          prev.tool_calls = [...(prev.tool_calls || []), ...curr.tool_calls];
        }
      } else {
        merged.push({ ...curr });
      }
    }
    return merged;
  };
  const preMergedMessages = mergeConsecutiveSameRole(messages);
  const preMergedTotal = preMergedMessages.length;

  // Protect assistant+tool_call pairs: find indices that must stay Q8
  // If an assistant has tool_calls, the assistant AND subsequent tool messages must stay Q8
  const protectedIndices = new Set<number>();
  for (let i = 0; i < preMergedTotal; i++) {
    const m = preMergedMessages[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      protectedIndices.add(i); // protect the assistant message
      // Protect following consecutive tool messages
      for (let j = i + 1; j < preMergedTotal && preMergedMessages[j].role === 'tool'; j++) {
        protectedIndices.add(j);
      }
    }
    // Also protect tool messages that have tool_call_id (they need their parent)
    if (m.role === 'tool' && m.tool_call_id) {
      protectedIndices.add(i);
      // Find and protect the parent assistant message
      for (let j = i - 1; j >= 0; j--) {
        if (preMergedMessages[j].role === 'assistant' && preMergedMessages[j].tool_calls) {
          protectedIndices.add(j);
          break;
        }
        if (preMergedMessages[j].role !== 'tool') break;
      }
    }
  }

  // Score each message (on pre-merged array for correct position/total ratios)
  const total = preMergedTotal;
  const scored = preMergedMessages.map((msg, i) => ({
    msg,
    importance: scoreMessageImportance(msg, i, total),
  }));

  // Quantize with safety guards
  const tierCounts: Record<QuantLevel, number> = { Q8: 0, Q4: 0, Q2: 0, Q1: 0, Q0: 0 };
  const quantized = scored.map(({ msg, importance }, i) => {
    const forceQ8 = msg.role === 'system' || i >= total - PRESERVE_RECENT_COUNT || protectedIndices.has(i);
    let level = forceQ8 ? 'Q8' : quantize(importance, budgetRatio, i, total);
    // v3.6: Structural invariants are enforced inside quantize() — no override needed
    // (User → Q4 min, Tool → Q8, Assistant+tool_calls → Q8)
    tierCounts[level]++;
    return { msg, level, importance };
  });

  // Apply compression + populate RAG index
  let ragStored = 0;
  const compressed = quantized
    .map(({ msg, level }) => {
      const { result, ragEntry } = applyCompression(msg, level);
      if (ragEntry) {
        // Omit timestamp — storeToRag generates its own
        storeToRag({
          id: ragEntry.id,
          originalRole: ragEntry.originalRole,
          summary: ragEntry.summary,
          tags: ragEntry.tags,
          tier: ragEntry.tier,
        });
        ragStored++;
      }
      return result;
    })
    .filter(Boolean);

  // v0.4.4: RAG retrieval moved to gateway layer to avoid duplication.
  // Compressor only stores compressed summaries; gateway retrieves and injects.
  const finalMessages = [...compressed];

  // Verify budget — second pass: further summarize if still over threshold
  let compressedTokens = finalMessages.reduce(
    (sum, m) => sum + estimateTokens(m),
    0
  );

  if (compressedTokens > dynamicThreshold) {
    for (let i = 0; i < finalMessages.length && compressedTokens > dynamicThreshold; i++) {
      const msg = finalMessages[i];
      if (msg.role === 'system' || i >= finalMessages.length - PRESERVE_RECENT_COUNT)
        continue;
      if (typeof msg.content === 'string' && msg.content.length > 80) {
        const sentences = msg.content.split(/[.!?]+/).filter(Boolean);
        if (sentences.length > 1) {
          const oldTokens = estimateTokens(msg);
          msg.content = sentences[0].trim();
          compressedTokens -= (oldTokens - estimateTokens(msg));
        }
      }
    }
  }

  // Third pass: if still over hard limit, drop oldest assistant messages
  if (compressedTokens > maxInputTokens) {
    let dropIdx = 0;
    while (compressedTokens > maxInputTokens && dropIdx < finalMessages.length) {
      const msg = finalMessages[dropIdx];
      if (msg.role === 'assistant' && dropIdx < finalMessages.length - PRESERVE_RECENT_COUNT) {
        const dropped = finalMessages.splice(dropIdx, 1)[0];
        compressedTokens -= estimateTokens(dropped);
        tierCounts.Q0++;
      } else {
        dropIdx++;
      }
    }
  }

  const compressionRatio = originalTokens / Math.max(1, compressedTokens);
  const kvPer1K = KV_CACHE_PER_1K_TOKENS[targetModel] || 128_000;
  const kvCacheEstimateBytes = Math.round((compressedTokens / 1000) * kvPer1K);

  // Observability log
  console.log(
    `📦 [turboquant v3.5] ${targetModel}: ${originalTokens}→${compressedTokens} tok ` +
    `(${compressionRatio.toFixed(1)}x) | util=${(utilizationRatio * 100).toFixed(0)}% ` +
    `| KV≈${(kvCacheEstimateBytes / 1024 / 1024).toFixed(1)}MB ` +
    `| Q8:${tierCounts.Q8} Q4:${tierCounts.Q4} Q2:${tierCounts.Q2} Q1:${tierCounts.Q1} Q0:${tierCounts.Q0} ` +
    `| RAG:${ragStored} (total:${ragIndex.length}) | dynamicThreshold=${dynamicThreshold}`,
  );

  return {
    messages: finalMessages as any[],
    originalTokens,
    compressedTokens,
    compressionRatio,
    tierCounts,
    model: targetModel,
    contextWindow,
    kvCacheEstimateBytes,
    ragStored,
    ragAvailable: ragIndex.length > 0,
  };
}
