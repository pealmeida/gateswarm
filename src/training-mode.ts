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
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { EffortLevel } from './types.js';
import { queryRag } from './rag-index.js';
import { recordGoldVoteFeedback } from './feedback-store.js';
import {
  saveVote, updateVote, getVotes, getLabeledVotes,
  getAgentConfig, updateAgentConfig, setAgentTrainingMode,
  recordTierAccuracy, getTierAccuracy, getOverallAccuracy,
  parseVoteReply, isVoteReply,
  type VoteRecord,
} from './vote-persistence.js';
import { getCalibrationStats, incrementInteractionCount } from './label-combiner.js';

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
  const vote: VoteRequest = {
    id,
    agentId,
    prompt: prompt.slice(0, 200),
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
    promptSnippet: prompt.slice(0, 100),
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
  return `\n\n🎯 [${vote.id}] Router chose: ${vote.predictedTier} (${(vote.confidence * 100).toFixed(0)}% confidence). Reply: ✅ correct | ❌ ${tiers}`;
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

function persistOrganicGoldLabel(vote: VoteRecord, actualTier: EffortLevel, agreed: boolean): void {
  if (!existsSync(ORGANIC_DATA_DIR)) {
    mkdirSync(ORGANIC_DATA_DIR, { recursive: true });
  }

  appendFileSync(ORGANIC_LABELS_FILE, JSON.stringify({
    ts: Date.now(),
    promptHash: vote.promptHash,
    promptSnippet: vote.promptSnippet,
    predictedTier: vote.predictedTier,
    actualTier,
    agreed,
    agentId: vote.agentId,
  }) + '\n', 'utf-8');
}

export function processVoteReplyDetailed(
  voteId: string,
  agentId: string,
  replyText: string
): ProcessedVoteReply | null {
  const parsed = parseVoteReply(replyText);
  if (!parsed) return null;

  // Find the pending vote
  const votes = getVotes({ agentId });
  const pendingVote = votes.find(v => v.id === voteId && !v.voted);
  if (!pendingVote) return null;

  // Record the vote
  const actualTier = parsed.agreed
    ? pendingVote.predictedTier
    : (parsed.correctTier || pendingVote.predictedTier);

  const isCorrect = parsed.agreed || (parsed.correctTier === pendingVote.predictedTier);
  const agreed = Boolean(isCorrect);

  // Update in-memory state
  pendingVote.voted = true;
  pendingVote.userAgreed = parsed.agreed;
  pendingVote.userCorrectTier = parsed.correctTier;
  pendingVote.actualTier = actualTier;

  // Update in persistence
  updateVote(pendingVote.id, {
    voted: true,
    userAgreed: parsed.agreed,
    userCorrectTier: parsed.correctTier,
    actualTier,
  });

  recordGoldVoteFeedback({
    agentId,
    promptHash: pendingVote.promptHash,
    promptSnippet: pendingVote.promptSnippet,
    predictedTier: pendingVote.predictedTier,
    actualTier,
    score: pendingVote.score,
  });
  persistOrganicGoldLabel(pendingVote, actualTier, agreed);

  // Track per-tier accuracy
  recordTierAccuracy(agentId, pendingVote.predictedTier, isCorrect);

  // Calibrate silver/bronze if we have comparison data
  // (this would be called after LLM judge completes)

  return {
    voteId,
    agentId,
    promptHash: pendingVote.promptHash,
    promptSnippet: pendingVote.promptSnippet,
    predictedTier: pendingVote.predictedTier,
    actualTier,
    agreed,
  };
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
  return processVoteReplyDetailed(voteId, agentId, replyText) !== null;
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

  // Find most recent unvoted request for this agent
  const now = Date.now();
  const votes = getVotes({ agentId });
  const recent = votes
    .filter(v => !v.voted && v.expiresAt > now)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (recent.length === 0) return null;

  return { voteId: recent[0].id, isVote: true };
}

// A bare "yes"/"no"/"correct" hours after the vote prompt is far more likely a
// reply to something else than late router feedback — with the 24h expiry it
// would be swallowed and misrecorded. Only explicit forms (✅/❌/👍 or a tier
// word) count for the full window; bare words count within this grace period.
const BARE_REPLY_WINDOW_MS = 10 * 60 * 1000;
const EXPLICIT_VOTE_RE = /✅|❌|👍|trivial|light|moderate|heavy|intensive|extreme/i;

export function recordDetectedVoteReply(agentId: string, messageText: string): ProcessedVoteReply | null {
  if (!isTrainingMode(agentId) || !isVoteReply(messageText)) return null;
  const detected = detectVoteReply(agentId, messageText);
  if (!detected) return null;
  if (!EXPLICIT_VOTE_RE.test(messageText)) {
    const votes = getVotes({ agentId });
    const vote = votes.find(v => v.id === detected.voteId);
    if (!vote || Date.now() - vote.timestamp > BARE_REPLY_WINDOW_MS) return null;
  }
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
  // Phase check handled by label-combiner (returns null if disabled)
  const keywords = prompt.toLowerCase().split(/\s+/)
    .filter(w => w.length > 4 && !/^(the|and|for|with|this|that|from|have|been)/.test(w));

  const entries = queryRag(keywords.slice(0, 10), 10);
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
    incrementInteractionCount();
    return majorityTier;
  }

  incrementInteractionCount();
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

  if (goldVotes.length >= config.retrainAfterVotes) {
    // Check per-tier minimum
    const tierCounts: Record<string, number> = {};
    for (const v of goldVotes) {
      tierCounts[v.predictedTier] = (tierCounts[v.predictedTier] || 0) + 1;
    }
    const tiersWithMin = Object.values(tierCounts).filter(c => c >= 3).length;
    if (tiersWithMin >= 2) {
      return { should: true, reason: `${goldVotes.length} gold votes, ${tiersWithMin} tiers with ≥3 votes` };
    }
  }

  if (labeledVotes.length >= 100) {
    return { should: true, reason: `${labeledVotes.length} total labeled interactions` };
  }

  return { should: false, reason: `${goldVotes.length} gold votes, ${labeledVotes.length} total labeled` };
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
