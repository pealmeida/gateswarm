/**
 * GateSwarm MoMA Router v0.4 — Vote Persistence Layer
 *
 * SQLite persistence for votes, training config, and accuracy cache.
 * Survives gateway restarts.
 */

import { randomBytes, createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import type { EffortLevel } from './types.js';

// ─── Types ────────────────────────────────────────────────

export interface VoteRecord {
  id: string;
  agentId: string;
  promptHash: string;
  /** Full prompt retained for organic gold-label persistence (capped at 32 KiB). */
  prompt: string;
  promptSnippet: string;
  predictedTier: EffortLevel;
  actualTier: EffortLevel | null;
  source: 'gold' | 'silver' | 'bronze';
  weight: number;
  timestamp: number;
  expiresAt: number;
  voted: boolean;
  userAgreed: boolean | null;
  userCorrectTier: EffortLevel | null;
  score?: number;
}

export interface AgentTrainingConfig {
  agentId: string;
  enabled: boolean;
  aleatoryRate: number;
  alwaysAskBelowConfidence: number;
  neverAskTiers: EffortLevel[];
  weightedTiers: EffortLevel[];
  weightedRateMultiplier: number;
  retrainAfterVotes: number;
  voteExpiryMs: number;
}

export interface TierAccuracy {
  agentId: string;
  tier: EffortLevel;
  correct: number;
  total: number;
  updatedAt: number;
}

// ─── JSON File Persistence (lightweight SQLite alternative) ─

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MOMA_TRAINING_DATA_DIR ?? join(__dirname, '../data/training');
const VOTE_WAL_FILE = 'vote-wal.jsonl';
const VOTE_WAL_APPLIED_FILE = 'vote-wal-applied.json';
const RETRAIN_WATERMARK_FILE = 'last-retrain-watermark.json';
const VOTE_JOURNAL_FILE = 'votes.journal.jsonl';
const VOTE_COMPACTION_DELAY_MS = 5000;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadJSON<T>(filename: string, defaultVal: T): T {
  ensureDataDir();
  const path = join(DATA_DIR, filename);
  if (!existsSync(path)) return defaultVal;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (error) {
    const corruptPath = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, corruptPath);
      console.error(`\u26a0\ufe0f\u26a0\ufe0f [vote-persistence] Corrupt ${filename} preserved at ${corruptPath}; using defaults.`, error);
    } catch (renameError) {
      console.error(`\u26a0\ufe0f\u26a0\ufe0f [vote-persistence] Failed to parse ${filename} and preserve the corrupt file; using defaults.`, error, renameError);
    }
    return defaultVal;
  }
}

function saveJSON<T>(filename: string, data: T): void {
  ensureDataDir();
  const path = join(DATA_DIR, filename);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tempPath, path);
}

// ─── Vote Store ───────────────────────────────────────────

const MAX_VOTES = 5000;
type VoteMutation = { type: 'upsert'; vote: VoteRecord } | { type: 'replace'; votes: VoteRecord[] };

function voteList(): VoteRecord[] {
  return [...votes.values()];
}

function appendVoteMutation(mutation: VoteMutation): void {
  ensureDataDir();
  writeFileSync(join(DATA_DIR, VOTE_JOURNAL_FILE), `${JSON.stringify(mutation)}\n`, { encoding: 'utf-8', flag: 'a' });
}

function applyVoteMutation(mutation: VoteMutation): void {
  if (mutation.type === 'upsert') {
    votes.set(mutation.vote.id, mutation.vote);
    return;
  }
  votes = new Map(mutation.votes.map(vote => [vote.id, vote]));
}

function replayVoteJournal(): void {
  const path = join(DATA_DIR, VOTE_JOURNAL_FILE);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const mutation = JSON.parse(line) as VoteMutation;
      if (mutation.type === 'upsert' && mutation.vote && typeof mutation.vote.id === 'string') {
        applyVoteMutation(mutation);
      } else if (mutation.type === 'replace' && Array.isArray(mutation.votes)) {
        applyVoteMutation(mutation);
      } else {
        console.error('\u26a0\ufe0f\u26a0\ufe0f [vote-persistence] Ignoring malformed vote journal mutation');
      }
    } catch (error) {
      console.error('\u26a0\ufe0f\u26a0\ufe0f [vote-persistence] Ignoring malformed vote journal line', error);
    }
  }
}

let votes = new Map<string, VoteRecord>(loadJSON<VoteRecord[]>('votes.json', []).map(vote => [vote.id, vote]));
replayVoteJournal();
let voteCompactionTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleVoteCompaction(): void {
  if (voteCompactionTimer) clearTimeout(voteCompactionTimer);
  voteCompactionTimer = setTimeout(() => {
    voteCompactionTimer = null;
    saveJSON('votes.json', voteList());
    writeFileSync(join(DATA_DIR, VOTE_JOURNAL_FILE), '', 'utf-8');
  }, VOTE_COMPACTION_DELAY_MS);
}

/** Persist the snapshot and clear an already-applied mutation journal. */
export function compactVotes(): void {
  if (voteCompactionTimer) {
    clearTimeout(voteCompactionTimer);
    voteCompactionTimer = null;
  }
  saveJSON('votes.json', voteList());
  writeFileSync(join(DATA_DIR, VOTE_JOURNAL_FILE), '', 'utf-8');
}

export function saveVote(vote: Omit<VoteRecord, 'id'> & { id?: string }): VoteRecord {
  const id = vote.id ?? randomBytes(8).toString('hex');
  const record: VoteRecord = { ...vote, id };
  votes.set(record.id, record);
  // Trim oldest if over limit
  if (votes.size > MAX_VOTES) {
    const trimmed = voteList().slice(-MAX_VOTES);
    votes = new Map(trimmed.map(entry => [entry.id, entry]));
    appendVoteMutation({ type: 'replace', votes: trimmed });
  } else {
    appendVoteMutation({ type: 'upsert', vote: record });
  }
  scheduleVoteCompaction();
  return record;
}

export function updateVote(id: string, updates: Partial<VoteRecord>): boolean {
  const existing = votes.get(id);
  if (!existing) return false;
  const updated = { ...existing, ...updates };
  votes.set(id, updated);
  appendVoteMutation({ type: 'upsert', vote: updated });
  scheduleVoteCompaction();
  return true;
}

export function getVotes(filters?: { agentId?: string; source?: string; tier?: EffortLevel }): VoteRecord[] {
  let result = voteList();
  if (filters?.agentId) result = result.filter(v => v.agentId === filters.agentId);
  if (filters?.source) result = result.filter(v => v.source === filters.source);
  if (filters?.tier) result = result.filter(v => v.predictedTier === filters.tier);
  return result;
}

export function getLabeledVotes(agentId: string, minWeight = 0): VoteRecord[] {
  const now = Date.now();
  return voteList().filter(v =>
    v.agentId === agentId &&
    v.actualTier !== null &&
    v.timestamp < now &&
    v.weight >= minWeight
  );
}

export interface VoteWalRecord {
  voteId: string;
  actualTier: EffortLevel;
  agreed: boolean;
  ts: number;
}

/** Append before consuming a vote across the independent training stores. */
export function appendVoteWal(record: VoteWalRecord): void {
  ensureDataDir();
  writeFileSync(join(DATA_DIR, VOTE_WAL_FILE), JSON.stringify(record) + '\n', { encoding: 'utf-8', flag: 'a' });
}

export function getUnappliedVoteWal(): VoteWalRecord[] {
  ensureDataDir();
  const path = join(DATA_DIR, VOTE_WAL_FILE);
  if (!existsSync(path)) return [];
  const applied = loadJSON<string[]>(VOTE_WAL_APPLIED_FILE, []);
  const appliedIds = new Set(applied);
  const latest = new Map<string, VoteWalRecord>();
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as VoteWalRecord;
      if (typeof value.voteId === 'string' && typeof value.ts === 'number' && !appliedIds.has(value.voteId)) {
        latest.set(value.voteId, value);
      }
    } catch {
      console.warn('Ignoring malformed vote WAL record');
    }
  }
  return [...latest.values()];
}

export function markVoteWalApplied(voteId: string): void {
  const applied = loadJSON<string[]>(VOTE_WAL_APPLIED_FILE, []);
  if (!applied.includes(voteId)) saveJSON(VOTE_WAL_APPLIED_FILE, [...applied, voteId]);
}

const tierAccuracyVoteIds = loadJSON<string[]>('tier-accuracy-votes.json', []);

export function recordVoteTierAccuracy(voteId: string, agentId: string, tier: EffortLevel, correct: boolean): void {
  if (tierAccuracyVoteIds.includes(voteId)) return;
  recordTierAccuracy(agentId, tier, correct);
  tierAccuracyVoteIds.push(voteId);
  saveJSON('tier-accuracy-votes.json', tierAccuracyVoteIds);
}

export function cleanExpiredVotes(): void {
  const now = Date.now();
  const before = votes.size;
  const remaining = voteList().filter(v => v.expiresAt > now || (v.actualTier !== null));
  if (remaining.length !== before) {
    votes = new Map(remaining.map(vote => [vote.id, vote]));
    appendVoteMutation({ type: 'replace', votes: remaining });
    scheduleVoteCompaction();
  }
}

// ─── Agent Training Config ───────────────────────────────

const DEFAULT_AGENT_CONFIG: AgentTrainingConfig = {
  agentId: '',
  enabled: false,
  aleatoryRate: 0.25,
  // Confidence is now calibrated P(correct | tier), which legitimately runs
  // below 0.5 — heavy sits at 0.256. The old 0.5 was the FLOOR of the previous
  // [0.5, 0.95] margin scale, so carrying it over made "always ask when very
  // uncertain" fire on four tiers of six, swamping the aleatory sampling and
  // fatigue decay it is supposed to sit beside. Re-set below the calibrated
  // spread so it once again marks the genuinely worst cases only.
  alwaysAskBelowConfidence: 0.30,
  neverAskTiers: ['trivial'],
  weightedTiers: ['moderate', 'heavy', 'intensive'],
  weightedRateMultiplier: 2.0,
  retrainAfterVotes: 10,
  voteExpiryMs: 24 * 60 * 60 * 1000,
};

let agentConfigs = loadJSON<Record<string, AgentTrainingConfig>>('agent-configs.json', {});

export function getAgentConfig(agentId: string): AgentTrainingConfig {
  if (!agentConfigs[agentId]) {
    agentConfigs[agentId] = { ...DEFAULT_AGENT_CONFIG, agentId };
    saveJSON('agent-configs.json', agentConfigs);
    return { ...agentConfigs[agentId] };
  }

  const merged = { ...DEFAULT_AGENT_CONFIG, ...agentConfigs[agentId], agentId };
  if (JSON.stringify(merged) !== JSON.stringify(agentConfigs[agentId])) {
    agentConfigs[agentId] = merged;
    saveJSON('agent-configs.json', agentConfigs);
  }

  return { ...merged };
}

export function updateAgentConfig(agentId: string, patch: Partial<AgentTrainingConfig>): AgentTrainingConfig {
  const current = getAgentConfig(agentId);
  agentConfigs[agentId] = { ...current, ...patch, agentId };
  saveJSON('agent-configs.json', agentConfigs);
  return { ...agentConfigs[agentId] };
}

export function setAgentTrainingMode(agentId: string, enabled: boolean): AgentTrainingConfig {
  return updateAgentConfig(agentId, { enabled });
}

// ─── Tier Accuracy Cache ──────────────────────────────────

let tierAccuracy = loadJSON<Record<string, TierAccuracy>>('tier-accuracy.json', {});

export function recordTierAccuracy(agentId: string, tier: EffortLevel, correct: boolean): void {
  const key = `${agentId}:${tier}`;
  if (!tierAccuracy[key]) {
    tierAccuracy[key] = { agentId, tier, correct: 0, total: 0, updatedAt: 0 };
  }
  tierAccuracy[key].total++;
  if (correct) tierAccuracy[key].correct++;
  tierAccuracy[key].updatedAt = Date.now();
  saveJSON('tier-accuracy.json', tierAccuracy);
}

export function getTierAccuracy(agentId: string): Record<EffortLevel, { correct: number; total: number; accuracy: number }> {
  const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
  const result = {} as Record<EffortLevel, { correct: number; total: number; accuracy: number }>;
  for (const tier of tiers) {
    const key = `${agentId}:${tier}`;
    const entry = tierAccuracy[key] || { correct: 0, total: 0 };
    result[tier] = {
      correct: entry.correct,
      total: entry.total,
      accuracy: entry.total > 0 ? entry.correct / entry.total : -1,
    };
  }
  return result;
}

export function getOverallAccuracy(agentId: string): number {
  const perTier = getTierAccuracy(agentId);
  let totalCorrect = 0;
  let total = 0;
  for (const [, stats] of Object.entries(perTier)) {
    totalCorrect += stats.correct;
    total += stats.total;
  }
  return total > 0 ? totalCorrect / total : -1;
}

type RetrainWatermarks = Record<string, number>;

function goldLabelCount(agentId: string): number {
  return getLabeledVotes(agentId, 0).filter(v => v.source === 'gold').length;
}

export function getLastRetrainWatermark(agentId: string): number {
  return loadJSON<RetrainWatermarks>(RETRAIN_WATERMARK_FILE, {})[agentId] ?? 0;
}

/** Mark all current gold labels for an agent as consumed by a completed retrain. */
export function markRetrained(agentId?: string): number {
  const watermarks = loadJSON<RetrainWatermarks>(RETRAIN_WATERMARK_FILE, {});
  const agentIds = agentId ? [agentId] : [...new Set(voteList().filter(v => v.source === 'gold').map(v => v.agentId))];
  let consumed = 0;
  for (const id of agentIds) {
    const count = goldLabelCount(id);
    watermarks[id] = count;
    consumed += count;
  }
  saveJSON(RETRAIN_WATERMARK_FILE, watermarks);
  return consumed;
}

// ─── Vote Parsing ─────────────────────────────────────────

/**
 * Parse a user message to detect if it's a vote reply.
 * Returns { isVote, agreed, correctTier, voteId } or null if not a vote.
 */
const VOTE_ID_RE = /\[\s*(?:vote\s*:\s*)?([A-Za-z0-9_-]+)\s*\]/i;
const VOTE_RE = /^(✅|yes|correct|👍|❌|no|wrong|nah)\s*(trivial|light|moderate|heavy|intensive|extreme)?$/i;

/** Extract the structured ID embedded by formatVotePrompt (legacy [id] accepted). */
export function extractVoteId(text: string): string | null {
  return text.match(VOTE_ID_RE)?.[1] ?? null;
}

export function parseVoteReply(text: string): {
  isVote: boolean;
  agreed: boolean;
  correctTier: EffortLevel | null;
} | null {
  const trimmed = text.replace(VOTE_ID_RE, '').trim();
  const match = trimmed.match(VOTE_RE);
  if (!match) return null;

  const positive = ['✅', 'yes', 'correct', '👍'].some(v => match[1].toLowerCase().includes(v.toLowerCase()));
  const correctTier = match[2] ? (match[2].toLowerCase() as EffortLevel) : null;

  return {
    isVote: true,
    agreed: positive && !correctTier,
    correctTier,
  };
}

/**
 * Check if a message looks like a vote reply (for intercepting).
 */
export function isVoteReply(text: string): boolean {
  return parseVoteReply(text) !== null;
}

// ─── Scheduled Cleanup ────────────────────────────────────

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startCleanup(intervalMs = 60000): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(cleanExpiredVotes, intervalMs);
}

export function stopCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
