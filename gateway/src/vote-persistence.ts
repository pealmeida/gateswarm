/**
 * GateSwarm MoA Router v0.4 — Vote Persistence Layer
 *
 * SQLite persistence for votes, training config, and accuracy cache.
 * Survives gateway restarts.
 */

import { randomBytes, createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { EffortLevel } from './types.js';

// ─── Types ────────────────────────────────────────────────

export interface VoteRecord {
  id: string;
  agentId: string;
  promptHash: string;
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
const DATA_DIR = join(__dirname, '../data/training');

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
  } catch {
    return defaultVal;
  }
}

function saveJSON<T>(filename: string, data: T): void {
  ensureDataDir();
  writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Vote Store ───────────────────────────────────────────

let votes: VoteRecord[] = loadJSON<VoteRecord[]>('votes.json', []);
const MAX_VOTES = 5000;

export function saveVote(vote: Omit<VoteRecord, 'id'>): VoteRecord {
  const id = randomBytes(8).toString('hex');
  const record: VoteRecord = { ...vote, id };
  votes.push(record);
  // Trim oldest if over limit
  if (votes.length > MAX_VOTES) {
    votes = votes.slice(-MAX_VOTES);
  }
  saveJSON('votes.json', votes);
  return record;
}

export function updateVote(id: string, updates: Partial<VoteRecord>): boolean {
  const idx = votes.findIndex(v => v.id === id);
  if (idx < 0) return false;
  votes[idx] = { ...votes[idx], ...updates };
  saveJSON('votes.json', votes);
  return true;
}

export function getVotes(filters?: { agentId?: string; source?: string; tier?: EffortLevel }): VoteRecord[] {
  let result = votes;
  if (filters?.agentId) result = result.filter(v => v.agentId === filters.agentId);
  if (filters?.source) result = result.filter(v => v.source === filters.source);
  if (filters?.tier) result = result.filter(v => v.predictedTier === filters.tier);
  return result;
}

export function getLabeledVotes(agentId: string, minWeight = 0): VoteRecord[] {
  const now = Date.now();
  return votes.filter(v =>
    v.agentId === agentId &&
    v.actualTier !== null &&
    v.timestamp < now &&
    v.weight >= minWeight
  );
}

export function cleanExpiredVotes(): void {
  const now = Date.now();
  const before = votes.length;
  votes = votes.filter(v => v.expiresAt > now || (v.actualTier !== null));
  if (votes.length !== before) {
    saveJSON('votes.json', votes);
  }
}

// ─── Agent Training Config ───────────────────────────────

const DEFAULT_AGENT_CONFIG: AgentTrainingConfig = {
  agentId: '',
  enabled: false,
  aleatoryRate: 0.10,
  alwaysAskBelowConfidence: 0.5,
  neverAskTiers: ['trivial', 'extreme'],
  weightedTiers: ['moderate', 'heavy', 'intensive'],
  weightedRateMultiplier: 2.0,
  retrainAfterVotes: 10,
};

let agentConfigs = loadJSON<Record<string, AgentTrainingConfig>>('agent-configs.json', {});

export function getAgentConfig(agentId: string): AgentTrainingConfig {
  if (!agentConfigs[agentId]) {
    agentConfigs[agentId] = { ...DEFAULT_AGENT_CONFIG, agentId };
    saveJSON('agent-configs.json', agentConfigs);
  }
  return { ...agentConfigs[agentId] };
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

// ─── Vote Parsing ─────────────────────────────────────────

/**
 * Parse a user message to detect if it's a vote reply.
 * Returns { isVote, agreed, correctTier, voteId } or null if not a vote.
 */
const VOTE_RE = /^(✅|yes|correct|👍|❌|no|wrong|nah)\s*(trivial|light|moderate|heavy|intensive|extreme)?$/i;

export function parseVoteReply(text: string): {
  isVote: boolean;
  agreed: boolean;
  correctTier: EffortLevel | null;
} | null {
  const trimmed = text.trim();
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
