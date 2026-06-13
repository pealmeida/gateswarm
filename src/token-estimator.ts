/**
 * GateSwarm MoMA Router v0.5 — Token Estimator
 *
 * CLI agents don't report token counts, so we estimate using tiktoken.
 * Accuracy: ±5-10% vs actual counts.
 *
 * Used by: feedback store, RAG index, benchmark logging,
 *          self-eval, TurboQuant compression ratio display.
 */

let _encoding: any = null;

function getEncoding(): any {
  if (!_encoding) {
    // Lazy-load tiktoken. cl100k_base covers GPT-4, Claude Sonnet/Opus,
    // and most modern models.
    try {
      const tiktoken = require('tiktoken');
      _encoding = tiktoken.get_encoding('cl100k_base');
    } catch {
      // tiktoken not available — will use fallback heuristic
      _encoding = null;
    }
  }
  return _encoding;
}

/**
 * Estimate token count for a text string.
 * Uses tiktoken when available; falls back to ~4 chars/token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    const enc = getEncoding();
    if (enc) return enc.encode(text).length;
  } catch { /* fall through */ }
  // Fallback: ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a message array.
 * Each message adds ~4 tokens of framing overhead (OpenAI formula).
 */
export function estimateMessageTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  let total = 0;
  for (const msg of messages) {
    total += 4 + estimateTokens(msg.role) + estimateTokens(msg.content);
  }
  total += 2; // assistant reply prefix
  return total;
}

/** Dispose the encoding instance (call on shutdown). */
export function dispose(): void {
  if (_encoding) {
    try { _encoding.free(); } catch { /* ignore */ }
    _encoding = null;
  }
}
