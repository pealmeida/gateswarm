/**
 * GateSwarm MoMA Router v0.4 — Training Mode Manager
 *
 * Semi-supervised learning with 3 labeling sources:
 *   GOLD:   Manual user votes (aleatory-sampled, persisted)
 *   SILVER: RAG contextual inference (phased bootstrap)
 *   BRONZE: LLM judge async (quality-calibrated)
 *
 * Aleatory sampling protects UX:
 *   - Per-agent config with fatigue decay
 *   - NEVER on trivial/extreme (high-confidence tiers)
 *   - ALWAYS when confidence < alwaysAskThreshold
 *   - 2x rate on moderate/heavy/intensive (accuracy gaps)
 *   - Structured vote protocol: [vote:id] prefix
 */

import { randomBytes, createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { EffortLevel } from './types.js';
import { queryRag } from './rag-index.js';
import { recordGoldVoteFeedback } from './feedback-store.js';
import {
  saveVote, updateVote, getVotes, getLabeledVotes,
  getAgentConfig, updateAgentConfig, setAgentTrainingMode,
  getTierAccuracy, getOverallAccuracy,
  appendVoteWal, getUnappliedVoteWal, markVoteWalApplied, markRetrained,
  recordVoteTierAccuracy, getLastRetrainWatermark,
  parseVoteReply, extractVoteId, isVoteReply,
  type VoteRecord,
} from './vote-persistence.js';
import {
  getCalibrationStats,
  getRagPhase,
  getSilverWeight,
  incrementInteractionCount,
} from './label-combiner.js';
import {
  encodeOrganicLabel,
  MAX_ORGANIC_PROMPT_CHARS,
  ORGANIC_LABEL_VERSION,
} from './organic-labels.js';
import { redactSensitive } from './redact.js';

// ─── Types ───────────────────────────────────────────────

export interface VoteRequest {
  id: string;
  agentId: string;
  prompt: string;
  predictedTier: EffortLevel;
  confidence: number;
  timestamp: number;
  voted: boolean;
  userAgreed: boolean | null;
  userCorrectTier: EffortLevel | null;
  score?: number;
}

export interface TrainingStats {
  enabled: boolean;
  totalVotes: number;
  correctVotes: number;
  totalRequests: number;
  overallAccuracy: number;
  perTierAccuracy: Record<EffortLevel, { correct: number; total: number; accuracy: number }>;
  pendingVotes: number;
  goldLabels: number;
  silverLabels: number;
  bronzeLabels: number;
  fatigueDecay: number;
  ragPhase: string;
}

// ─── State ───────────────────────────────────────────────

// Track vote counts per agent for fatigue decay
const agentVoteCounts = new Map<string, number>();
const __dirname = dirname(fileURLToPath(import.meta.url));
const ORGANIC_DATA_DIR = join(__dirname, '../data/organic');
const ORGANIC_LABELS_FILE = join(ORGANIC_DATA_DIR, 'labeled.jsonl');
export { isVoteReply } from './vote-persistence.js';

/** Restore fatigue state from durable votes so a restart cannot reset sampling pressure. */
function restoreAgentVoteCounts(): void {
  for (const vote of getVotes()) {
    agentVoteCounts.set(vote.agentId, (agentVoteCounts.get(vote.agentId) ?? 0) + 1);
  }
}

restoreAgentVoteCounts();

// ─── Mode Control ────────────────────────────────────────

export function setTrainingMode(agentId: string, enabled: boolean): void {
  setAgentTrainingMode(agentId, enabled);
  console.log(`🎯 [${agentId}] Training mode: ${enabled ? 'ON' : 'OFF'}`);
}

export function isTrainingMode(agentId: string): boolean {
  return getAgentConfig(agentId).enabled;
}

// ─── Aleatory Sampling (with Fatigue Decay) ─────────────

/**
 * Decide whether to ask for a vote on this routing decision.
 * Uses per-agent config with exponential fatigue decay.
 */
export function shouldAskForVote(
  agentId: string,
  tier: EffortLevel,
  confidence: number
): boolean {
  const config = getAgentConfig(agentId);
  if (!config.enabled) return false;

  // Never ask on excluded tiers
  if (config.neverAskTiers.includes(tier)) return false;

  // Always ask when very uncertain
  if (confidence < config.alwaysAskBelowConfidence) return true;

  // Fatigue decay: effective_rate = base_rate × e^(-votes/50)
  const voteCount = agentVoteCounts.get(agentId) || 0;
  const fatigueFactor = Math.exp(-voteCount / 50);
  const effectiveRate = Math.max(0.02, config.aleatoryRate * fatigueFactor);

  // 2x rate for accuracy-gap tiers
  let rate = effectiveRate;
  if (config.weightedTiers.includes(tier)) {
    rate *= config.weightedRateMultiplier;
  }

  // Cap at 50%
  rate = Math.min(rate, 0.50);

  return Math.random() < rate;
}

/**
 * Create a vote request with structured vote ID.
 * Returns null if sampling says don't ask.
 */
export function createVoteRequest(
  agentId: string,
  prompt: string,
  predictedTier: EffortLevel,
  confidence: number,
  score?: number
): VoteRequest | null {
  if (!shouldAskForVote(agentId, predictedTier, confidence)) return null;

  const config = getAgentConfig(agentId);
  const id = 'v' + randomBytes(6).toString('hex');
  const redactedPrompt = redactSensitive(prompt);
  const vote: VoteRequest = {
    id,
    agentId,
    prompt: redactedPrompt.slice(0, 200),
    predictedTier,
    confidence,
    timestamp: Date.now(),
    voted: false,
    userAgreed: null,
    userCorrectTier: null,
    score,
  };

  // Persist to disk
  saveVote({
    id,
    agentId,
    promptHash: hashPrompt(prompt),
    prompt: redactedPrompt.slice(0, MAX_ORGANIC_PROMPT_CHARS),
    promptSnippet: redactedPrompt.slice(0, 100),
    predictedTier,
    actualTier: null,
    source: 'gold',
    weight: 1.0,
    timestamp: Date.now(),
    expiresAt: Date.now() + config.voteExpiryMs,
    voted: false,
    userAgreed: null,
    userCorrectTier: null,
    score,
  });

  // Track for fatigue
  agentVoteCounts.set(agentId, (agentVoteCounts.get(agentId) || 0) + 1);

  return vote;
}

/**
 * Format the vote prompt to append to response text.
 * Format: 🎯 [vote:abc123] Router: heavy (62%). ✅ | ❌ <tier>
 */
export function formatVotePrompt(vote: VoteRequest): string {
  const tiers = 'trivial|light|moderate|heavy|intensive|extreme';
  return `\n\n🎯 [vote:${vote.id}] Router chose: ${vote.predictedTier} (${(vote.confidence * 100).toFixed(0)}% confidence). Reply: ✅ correct | ❌ ${tiers}`;
}

export interface VoteDecoration {
  _voteRequest: {
    id: string;
    prompt: string;
    predictedTier: EffortLevel;
    confidence: number;
  };
}

export function appendVotePromptToCompletion<T extends Record<string, any>>(
  data: T,
  vote: VoteRequest,
): T & VoteDecoration {
  const votePrompt = formatVotePrompt(vote);
  const decorated: any = { ...data };
  const choices = Array.isArray(data?.choices) ? [...data.choices] : [];

  if (choices.length > 0) {
    const idx = choices.length - 1;
    const choice = { ...choices[idx] };
    const message = { ...(choice.message || { role: 'assistant' }) };
    const content = message.content;

    if (typeof content === 'string') {
      message.content = content + votePrompt;
    } else if (Array.isArray(content)) {
      message.content = [...content, { type: 'text', text: votePrompt.trimStart() }];
    } else {
      message.content = votePrompt.trimStart();
    }

    choice.message = message;
    choices[idx] = choice;
    decorated.choices = choices;
  }

  decorated._voteRequest = {
    id: vote.id,
    prompt: votePrompt.trimStart(),
    predictedTier: vote.predictedTier,
    confidence: vote.confidence,
  };

  return decorated;
}

/**
 * Build the delta payload used to append a training vote to an SSE response.
 * Keeping this separate from the HTTP response decorator avoids buffering a
 * streamed completion merely to add the final vote request.
 */
export function appendVotePromptToStream(vote: VoteRequest): { content: string } {
  return { content: formatVotePrompt(vote) };
}

// ─── Vote Recording ──────────────────────────────────────

export interface ProcessedVoteReply {
  voteId: string;
  agentId: string;
  promptHash: string;
  promptSnippet: string;
  predictedTier: EffortLevel;
  actualTier: EffortLevel;
  agreed: boolean;
}

export interface VoteClarification {
  voteId: string;
  agentId: string;
  clarification: string;
}

export type VoteReplyResult = ProcessedVoteReply | VoteClarification;

export function isVoteClarification(result: VoteReplyResult): result is VoteClarification {
  return 'clarification' in result;
}

export function persistOrganicGoldLabel(
  vote: VoteRecord,
  actualTier: EffortLevel,
  agreed: boolean,
  labelsFile = ORGANIC_LABELS_FILE,
): void {
  if (typeof vote.prompt !== 'string' || !vote.prompt) {
    console.error(`organic label skipped for vote ${vote.id}: persisted vote has no full prompt`);
    return;
  }
  const labelsDir = dirname(labelsFile);
  if (!existsSync(labelsDir)) {
    mkdirSync(labelsDir, { recursive: true });
  }

  appendFileSync(labelsFile, encodeOrganicLabel({
    version: ORGANIC_LABEL_VERSION,
    ts: Date.now(),
    promptHash: vote.promptHash,
    prompt: redactSensitive(vote.prompt).slice(0, MAX_ORGANIC_PROMPT_CHARS),
    promptSnippet: redactSensitive(vote.promptSnippet).slice(0, 100),
    predictedTier: vote.predictedTier,
    actualTier,
    agreed,
    agentId: vote.agentId,
    voteId: vote.id,
  }) + '\n', 'utf-8');
}

function organicLabelAlreadyPersisted(voteId: string, labelsFile: string): boolean {
  if (!existsSync(labelsFile)) return false;
  return readFileSync(labelsFile, 'utf-8').split('\n').some(line => {
    try { return JSON.parse(line).voteId === voteId; } catch { return false; }
  });
}

function persistOrganicGoldLabelOnce(vote: VoteRecord, actualTier: EffortLevel, agreed: boolean): void {
  if (!organicLabelAlreadyPersisted(vote.id, ORGANIC_LABELS_FILE)) {
    persistOrganicGoldLabel(vote, actualTier, agreed);
  }
}

function consumeVote(vote: VoteRecord, actualTier: EffortLevel, agreed: boolean): ProcessedVoteReply {
  const isCorrect = actualTier === vote.predictedTier;
  updateVote(vote.id, {
    voted: true,
    userAgreed: agreed,
    userCorrectTier: agreed ? null : actualTier,
    actualTier,
  });
  recordGoldVoteFeedback({
    voteId: vote.id,
    agentId: vote.agentId,
    promptHash: vote.promptHash,
    promptSnippet: vote.promptSnippet,
    predictedTier: vote.predictedTier,
    actualTier,
    score: vote.score,
  });
  persistOrganicGoldLabelOnce(vote, actualTier, agreed);
  recordVoteTierAccuracy(vote.id, vote.agentId, vote.predictedTier, isCorrect);
  markVoteWalApplied(vote.id);

  return {
    voteId: vote.id,
    agentId: vote.agentId,
    promptHash: vote.promptHash,
    promptSnippet: vote.promptSnippet,
    predictedTier: vote.predictedTier,
    actualTier,
    agreed,
  };
}

/** Replay write-ahead vote records left incomplete by a prior process crash. */
export function replayVoteWal(): void {
  for (const record of getUnappliedVoteWal()) {
    const vote = getVotes().find(candidate => candidate.id === record.voteId);
    if (!vote) {
      console.warn(`Vote WAL replay skipped unknown vote ${record.voteId}`);
      continue;
    }
    consumeVote(vote, record.actualTier, record.agreed);
  }
}

export function processVoteReplyDetailed(
  voteId: string,
  agentId: string,
  replyText: string
): VoteReplyResult | null {
  const parsed = parseVoteReply(replyText);
  if (!parsed) return null;

  const explicitVoteId = extractVoteId(replyText);
  if (explicitVoteId && explicitVoteId !== voteId) {
    console.warn(`Ignoring vote reply bound to ${explicitVoteId}; endpoint supplied ${voteId}`);
    return null;
  }

  // Find the pending vote
  const votes = getVotes({ agentId });
  const pendingVote = votes.find(v => v.id === voteId && !v.voted);
  if (!pendingVote) return null;

  if (!parsed.agreed && !parsed.correctTier) {
    return {
      voteId,
      agentId,
      clarification: `Please reply with the corrected tier for vote ${voteId}: trivial, light, moderate, heavy, intensive, or extreme.`,
    };
  }

  const actualTier = parsed.agreed ? pendingVote.predictedTier : parsed.correctTier!;
  const agreed = parsed.agreed;
  appendVoteWal({ voteId: pendingVote.id, actualTier, agreed, ts: Date.now() });
  return consumeVote(pendingVote, actualTier, agreed);
}

/**
 * Process a vote reply from the user.
 * Returns true if vote was recorded.
 */
export function processVoteReply(
  voteId: string,
  agentId: string,
  replyText: string
): boolean {
  const result = processVoteReplyDetailed(voteId, agentId, replyText);
  return result !== null && !isVoteClarification(result);
}

/**
 * Check if a message is a vote reply and extract vote ID.
 * Vote replies contain a vote ID like [vote:abc123] in the conversation.
 * We check the last N messages for vote prompts.
 */
export function detectVoteReply(
  agentId: string,
  messageText: string
): { voteId: string; isVote: boolean } | null {
  // Check if message matches vote pattern
  const parsed = parseVoteReply(messageText);
  if (!parsed || !parsed.isVote) return null;

  const explicitVoteId = extractVoteId(messageText);
  const now = Date.now();
  const votes = getVotes({ agentId });
  const pending = votes
    .filter(v => !v.voted && v.expiresAt > now)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (explicitVoteId) {
    const vote = pending.find(candidate => candidate.id === explicitVoteId);
    if (!vote) {
      console.warn(`Ignoring vote reply for unknown, expired, or foreign vote ${explicitVoteId}`);
      return null;
    }
    return { voteId: vote.id, isVote: true };
  }

  const recent = pending.filter(vote => now - vote.timestamp <= BARE_REPLY_WINDOW_MS);
  if (recent.length !== 1) {
    console.warn(`Ignoring unbound vote reply for ${agentId}: ${recent.length} pending votes in reply window`);
    return null;
  }

  return { voteId: recent[0].id, isVote: true };
}

// An unbound reply can only be associated with a vote during this short window.
const BARE_REPLY_WINDOW_MS = 10 * 60 * 1000;

export function recordDetectedVoteReply(agentId: string, messageText: string): VoteReplyResult | null {
  if (!isTrainingMode(agentId) || !isVoteReply(messageText)) return null;
  const detected = detectVoteReply(agentId, messageText);
  if (!detected) return null;
  return processVoteReplyDetailed(detected.voteId, agentId, messageText);
}

// ─── SILVER Labels (RAG Consensus) ──────────────────────

/**
 * Infer label from RAG-retrieved history.
 * If 3+ retrieved entries agree on tier, use that as SILVER label.
 * Phase-aware: disabled during Phase 1 (0-50 interactions).
 */
export function inferRagConsensus(
  prompt: string,
  minAgreement: number = 3
): EffortLevel | null {
  // Every completed routing interaction advances bootstrap exactly once, even
  // when it has no matching history.
  incrementInteractionCount();

  if (getRagPhase() === 'disabled' || getSilverWeight() <= 0) return null;

  const keywords = prompt.toLowerCase().split(/\s+/)
    .filter(w => w.length > 4 && !/^(the|and|for|with|this|that|from|have|been)/.test(w));

  const effortLevels: readonly EffortLevel[] = [
    'trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme',
  ];
  const entries = queryRag(keywords.slice(0, 10), 10).filter(entry =>
    effortLevels.includes(entry.tier as EffortLevel)
      && (entry.provenance === 'gold' || entry.provenance === 'judged')
  );
  if (entries.length < minAgreement) return null;

  // Count tier agreement
  const tierCounts: Record<string, number> = {};
  for (const entry of entries) {
    tierCounts[entry.tier] = (tierCounts[entry.tier] || 0) + 1;
  }

  // Find majority tier
  let majorityTier: EffortLevel | null = null;
  let maxCount = 0;
  for (const [tier, count] of Object.entries(tierCounts)) {
    if (count > maxCount) {
      maxCount = count;
      majorityTier = tier as EffortLevel;
    }
  }

  // Only return if strong agreement (>60% of retrieved)
  if (maxCount >= minAgreement && maxCount / entries.length > 0.6) {
    return majorityTier;
  }

  return null;
}

// ─── Retraining Trigger ──────────────────────────────────

/**
 * Check if cascade retraining should be triggered.
 * Trigger: ≥ config.retrainAfterVotes gold votes AND ≥ 3 per affected tier
 * OR ≥ 100 total labeled interactions (any source)
 */
export function shouldRetrain(agentId: string): { should: boolean; reason: string } {
  const config = getAgentConfig(agentId);
  const labeledVotes = getLabeledVotes(agentId, 0.5);
  const goldVotes = labeledVotes.filter(v => v.source === 'gold');

  const watermark = getLastRetrainWatermark(agentId);
  const newGoldVotes = goldVotes.slice(watermark);

  if (newGoldVotes.length >= config.retrainAfterVotes) {
    // Check per-tier minimum
    const tierCounts: Record<string, number> = {};
    for (const v of newGoldVotes) {
      if (v.actualTier !== null) tierCounts[v.actualTier] = (tierCounts[v.actualTier] || 0) + 1;
    }
    const tiersWithMin = Object.values(tierCounts).filter(c => c >= 3).length;
    if (tiersWithMin >= 2) {
      return { should: true, reason: `${newGoldVotes.length} new gold votes, ${tiersWithMin} actual tiers with ≥3 votes` };
    }
  }

  return { should: false, reason: `${newGoldVotes.length} new gold votes since watermark ${watermark}, ${labeledVotes.length} total labeled` };
}

export function markTrainingRetrained(agentId?: string): number {
  return markRetrained(agentId);
}

// ─── Stats ───────────────────────────────────────────────

export function getTrainingStats(agentId: string): TrainingStats {
  const config = getAgentConfig(agentId);
  const votes = getVotes({ agentId });
  const labeled = getLabeledVotes(agentId);
  const goldVotes = labeled.filter(v => v.source === 'gold');
  const silverVotes = labeled.filter(v => v.source === 'silver');
  const bronzeVotes = labeled.filter(v => v.source === 'bronze');
  const now = Date.now();
  const pending = votes.filter(v => !v.voted && v.expiresAt > now);
  const voteCount = agentVoteCounts.get(agentId) || 0;
  const fatigueDecay = Math.exp(-voteCount / 50);

  return {
    enabled: config.enabled,
    totalVotes: goldVotes.length,
    correctVotes: goldVotes.filter(v => v.userAgreed === true || (v.userCorrectTier === v.predictedTier)).length,
    totalRequests: votes.length,
    overallAccuracy: getOverallAccuracy(agentId),
    perTierAccuracy: getTierAccuracy(agentId),
    pendingVotes: pending.length,
    goldLabels: goldVotes.length,
    silverLabels: silverVotes.length,
    bronzeLabels: bronzeVotes.length,
    fatigueDecay,
    ragPhase: getCalibrationStats().ragPhase,
  };
}

// ─── Helpers ─────────────────────────────────────────────

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

replayVoteWal();
