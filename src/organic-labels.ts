/**
 * Versioned on-disk schema for organic gold-vote labels.
 *
 * This is deliberately shared by the writer and training reader so collection
 * and retraining cannot silently drift apart.
 */

import type { EffortLevel } from './types.js';

export const ORGANIC_LABEL_VERSION = 1;
export const MAX_ORGANIC_PROMPT_CHARS = 32_768;

const TIERS: readonly EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];

export interface OrganicLabelRow {
  version: typeof ORGANIC_LABEL_VERSION;
  ts: number;
  promptHash: string;
  prompt: string;
  promptSnippet: string;
  predictedTier: EffortLevel;
  actualTier: EffortLevel;
  agreed: boolean;
  agentId: string;
  voteId?: string;
}

export type OrganicLabelDecodeResult =
  | { ok: true; row: OrganicLabelRow }
  | { ok: false; reason: string; legacySnippetOnly: boolean };

function isTier(value: unknown): value is EffortLevel {
  return typeof value === 'string' && TIERS.includes(value as EffortLevel);
}

/** Serialize a validated organic label row for JSONL persistence. */
export function encodeOrganicLabel(row: OrganicLabelRow): string {
  const decoded = decodeOrganicLabel(row);
  if (!decoded.ok) throw new Error(`cannot encode organic label: ${decoded.reason}`);
  return JSON.stringify(decoded.row);
}

/** Decode and validate one JSONL row without accepting legacy aliases. */
export function decodeOrganicLabel(value: unknown): OrganicLabelDecodeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'row must be an object', legacySnippetOnly: false };
  }

  const row = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(row, 'prompt')) {
    return {
      ok: false,
      reason: 'legacy snippet-only row has no prompt field',
      legacySnippetOnly: typeof row.promptSnippet === 'string',
    };
  }
  if (row.version !== ORGANIC_LABEL_VERSION) {
    return { ok: false, reason: `unsupported version ${String(row.version)}`, legacySnippetOnly: false };
  }
  if (typeof row.ts !== 'number' || !Number.isFinite(row.ts)) {
    return { ok: false, reason: 'ts must be a finite number', legacySnippetOnly: false };
  }
  if (typeof row.promptHash !== 'string' || !row.promptHash) {
    return { ok: false, reason: 'promptHash must be a non-empty string', legacySnippetOnly: false };
  }
  if (typeof row.prompt !== 'string' || !row.prompt) {
    return { ok: false, reason: 'prompt must be a non-empty string', legacySnippetOnly: false };
  }
  if (row.prompt.length > MAX_ORGANIC_PROMPT_CHARS) {
    return { ok: false, reason: `prompt exceeds ${MAX_ORGANIC_PROMPT_CHARS} characters`, legacySnippetOnly: false };
  }
  if (typeof row.promptSnippet !== 'string') {
    return { ok: false, reason: 'promptSnippet must be a string', legacySnippetOnly: false };
  }
  if (!isTier(row.predictedTier)) {
    return { ok: false, reason: 'predictedTier is not a valid tier', legacySnippetOnly: false };
  }
  if (!isTier(row.actualTier)) {
    return { ok: false, reason: 'actualTier is not a valid tier', legacySnippetOnly: false };
  }
  if (typeof row.agreed !== 'boolean') {
    return { ok: false, reason: 'agreed must be a boolean', legacySnippetOnly: false };
  }
  if (typeof row.agentId !== 'string' || !row.agentId) {
    return { ok: false, reason: 'agentId must be a non-empty string', legacySnippetOnly: false };
  }
  if (row.voteId !== undefined && (typeof row.voteId !== 'string' || !row.voteId)) {
    return { ok: false, reason: 'voteId must be a non-empty string when present', legacySnippetOnly: false };
  }

  return {
    ok: true,
    row: {
      version: ORGANIC_LABEL_VERSION,
      ts: row.ts,
      promptHash: row.promptHash,
      prompt: row.prompt,
      promptSnippet: row.promptSnippet,
      predictedTier: row.predictedTier,
      actualTier: row.actualTier,
      agreed: row.agreed,
      agentId: row.agentId,
      voteId: row.voteId as string | undefined,
    },
  };
}
