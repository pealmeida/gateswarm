/**
 * GateSwarm MoMA Router v0.4 — Feedback Store (PERSISTENT)
 *
 * v0.4.4: JSON-file persistence — survives gateway restarts.
 * Every interaction is logged. When enough data accumulates,
 * the ensemble weights are retrained and hot-swapped.
 *
 * Schema:
 *   feedback (id, timestamp, prompt_hash, predicted_tier,
 *             actual_tier, model_used, response_tokens,
 *             adequacy_score, escalated, user_satisfaction)
 */

import { randomBytes, createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { redactSensitive } from './redact.js';

export interface FeedbackEntry {
  id: string;
  timestamp: number;
  promptHash: string;
  predictedTier: string;
  actualTier: string | null;       // LLM-judged ground truth
  modelUsed: string;
  responseTokens: number;
  adequacyScore: number | null;    // 0.0–1.0, null = not judged yet
  escalated: boolean;
  userSatisfaction: number | null; // 1-5, null = not rated
  score?: number;                  // v0.5.2: routing complexity score (enables boundary recalibration)
  promptSnippet?: string;          // v0.5.7: organic gold-vote audit trail
  source?: string;                 // e.g. gold_vote
  agentId?: string;
  /** Binds a gold label to the exact vote/request that produced it. */
  voteId?: string;
}

// ─── Persistence Layer ──────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MOMA_FEEDBACK_DATA_DIR ?? join(__dirname, '../data/feedback');
const FEEDBACK_FILE = join(DATA_DIR, 'entries.json');
const FEEDBACK_JOURNAL_FILE = join(DATA_DIR, 'entries.journal.jsonl');
const MAX_ENTRIES = 10000;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadFeedbackEntries(): FeedbackEntry[] {
  ensureDataDir();
  if (!existsSync(FEEDBACK_FILE)) return [];
  try {
    const raw = readFileSync(FEEDBACK_FILE, 'utf-8');
    return JSON.parse(raw) as FeedbackEntry[];
  } catch {
    return [];
  }
}

function saveFeedbackEntries(entries: FeedbackEntry[]): void {
  ensureDataDir();
  const tempPath = `${FEEDBACK_FILE}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(entries, null, 2), 'utf-8');
  renameSync(tempPath, FEEDBACK_FILE);
}

// ─── In-Memory Store ─────────────────────────────────────────────

const entries: FeedbackEntry[] = [];
let _totalInteractions = 0;
let _initialized = false;

type FeedbackMutation = { type: 'upsert'; entry: FeedbackEntry } | { type: 'replace'; entries: FeedbackEntry[] };

function applyFeedbackMutation(mutation: FeedbackMutation): void {
  if (mutation.type === 'replace') {
    entries.splice(0, entries.length, ...mutation.entries);
    return;
  }
  const index = entries.findIndex(entry => entry.id === mutation.entry.id);
  if (index >= 0) entries[index] = mutation.entry;
  else entries.push(mutation.entry);
}

/** A synchronous write-ahead journal keeps request-path mutations durable. */
function appendFeedbackMutation(mutation: FeedbackMutation): void {
  ensureDataDir();
  writeFileSync(FEEDBACK_JOURNAL_FILE, `${JSON.stringify(mutation)}\n`, { encoding: 'utf-8', flag: 'a' });
}

function replayFeedbackJournal(): void {
  if (!existsSync(FEEDBACK_JOURNAL_FILE)) return;
  for (const line of readFileSync(FEEDBACK_JOURNAL_FILE, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const mutation = JSON.parse(line) as FeedbackMutation;
      if (mutation.type === 'upsert' && mutation.entry && typeof mutation.entry.id === 'string') {
        applyFeedbackMutation(mutation);
      } else if (mutation.type === 'replace' && Array.isArray(mutation.entries)) {
        applyFeedbackMutation(mutation);
      } else {
        console.error('\u26a0\ufe0f\u26a0\ufe0f [feedback-store] Ignoring malformed journal mutation');
      }
    } catch (error) {
      console.error('\u26a0\ufe0f\u26a0\ufe0f [feedback-store] Ignoring malformed journal line', error);
    }
  }
}

function journalMutation(mutation: FeedbackMutation): void {
  appendFeedbackMutation(mutation);
}

/**
 * Initialize the feedback store from disk. Call once at gateway startup.
 */
export function initFeedbackStore(): void {
  if (_initialized) return;
  const loaded = loadFeedbackEntries();
  entries.push(...loaded);
  replayFeedbackJournal();
  _totalInteractions = loaded.length;
  _totalInteractions += entries.filter(entry => !loaded.some(saved => saved.id === entry.id)).length;
  _initialized = true;
  console.log(`📋 Feedback store loaded: ${_totalInteractions} entries from disk`);
}

/**
 * Flush the in-memory store to disk.
 */
export function flushFeedbackStore(): void {
  if (!_initialized) return;
  saveFeedbackEntries(entries.slice(-MAX_ENTRIES));
  writeFileSync(FEEDBACK_JOURNAL_FILE, '', 'utf-8');
}

// Auto-flush every 60 seconds
let _flushInterval: ReturnType<typeof setInterval> | null = null;
export function startFeedbackAutoFlush(intervalMs = 60000): void {
  if (_flushInterval) return;
  _flushInterval = setInterval(flushFeedbackStore, intervalMs);
}

export function recordFeedback(entry: Omit<FeedbackEntry, 'id' | 'timestamp' | 'promptHash' | 'promptSnippet'> & { prompt: string }): void {
  if (!_initialized) initFeedbackStore();

  const id = randomBytes(8).toString('hex');
  const timestamp = Date.now();
  const promptHash = createHash('sha256').update(entry.prompt).digest('hex').slice(0, 16);

  const stored: FeedbackEntry = {
    id, timestamp, promptHash,
    predictedTier: entry.predictedTier,
    actualTier: entry.actualTier,
    modelUsed: entry.modelUsed,
    responseTokens: entry.responseTokens,
    adequacyScore: entry.adequacyScore,
    escalated: entry.escalated,
    userSatisfaction: entry.userSatisfaction,
    score: entry.score,
    promptSnippet: redactSensitive(entry.prompt).slice(0, 100),
    source: entry.source,
    agentId: entry.agentId,
    voteId: entry.voteId,
  };
  entries.push(stored);

  _totalInteractions++;

  // Keep last 10K entries in memory
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
    journalMutation({ type: 'replace', entries: [...entries] });
  } else {
    journalMutation({ type: 'upsert', entry: stored });
  }
}

export function getInteractionCount(): number {
  if (!_initialized) initFeedbackStore();
  return _totalInteractions;
}

export function getFeedbackEntries(): FeedbackEntry[] {
  if (!_initialized) initFeedbackStore();
  return [...entries];
}

export function recordGoldVoteFeedback(label: {
  voteId?: string;
  agentId: string;
  promptHash: string;
  promptSnippet: string;
  predictedTier: string;
  actualTier: string;
  score?: number;
}): FeedbackEntry {
  if (!_initialized) initFeedbackStore();

  const reversed = [...entries].reverse();
  const existing = (label.voteId === undefined ? undefined : reversed.find(e => e.voteId === label.voteId))
    ?? reversed.find(e => e.promptHash === label.promptHash && e.agentId === label.agentId);
  if (existing) {
    existing.actualTier = label.actualTier;
    existing.source = 'gold_vote';
    existing.agentId = label.agentId;
    existing.promptSnippet = existing.promptSnippet ?? redactSensitive(label.promptSnippet).slice(0, 100);
    existing.voteId = label.voteId ?? existing.voteId;
    if (typeof label.score === 'number') existing.score = label.score;
    journalMutation({ type: 'upsert', entry: existing });
    return existing;
  }

  const entry: FeedbackEntry = {
    id: randomBytes(8).toString('hex'),
    timestamp: Date.now(),
    promptHash: label.promptHash,
    predictedTier: label.predictedTier,
    actualTier: label.actualTier,
    modelUsed: 'gold_vote',
    responseTokens: 0,
    adequacyScore: null,
    escalated: false,
    userSatisfaction: null,
    score: label.score,
    promptSnippet: redactSensitive(label.promptSnippet).slice(0, 100),
    source: 'gold_vote',
    agentId: label.agentId,
    voteId: label.voteId,
  };

  entries.push(entry);
  _totalInteractions++;

  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
    journalMutation({ type: 'replace', entries: [...entries] });
  } else {
    journalMutation({ type: 'upsert', entry });
  }

  return entry;
}

export function getRecentEntries(limit = 100): FeedbackEntry[] {
  if (!_initialized) initFeedbackStore();
  return entries.slice(-limit);
}

/**
 * Get entries that need LLM judging (adequacyScore is null)
 * and are due for sampling.
 */
export function getUnjudgedEntries(samplingRate = 0.10): FeedbackEntry[] {
  if (!_initialized) initFeedbackStore();
  const unjudged = entries.filter(e => e.adequacyScore === null && e.source !== 'gold_vote');
  return unjudged.filter(() => Math.random() < samplingRate);
}

/**
 * Update an entry with LLM-judged adequacy score.
 */
export function updateAdequacy(id: string, adequacyScore: number, actualTier: string): void {
  if (!_initialized) initFeedbackStore();

  const entry = entries.find(e => e.id === id);
  if (entry) {
    entry.adequacyScore = adequacyScore;
    if (entry.source !== 'gold_vote') entry.actualTier = actualTier;
    journalMutation({ type: 'upsert', entry });
  }
}

/**
 * Get per-tier accuracy statistics.
 */
export function getTierAccuracy(): Record<string, { total: number; correct: number; accuracy: number }> {
  if (!_initialized) initFeedbackStore();

  const judged = entries.filter(e => e.actualTier !== null);
  const stats: Record<string, { total: number; correct: number }> = {};

  for (const entry of judged) {
    if (!stats[entry.predictedTier]) stats[entry.predictedTier] = { total: 0, correct: 0 };
    stats[entry.predictedTier].total++;
    if (entry.predictedTier === entry.actualTier) stats[entry.predictedTier].correct++;
  }

  return Object.fromEntries(
    Object.entries(stats).map(([tier, s]) => [
      tier,
      { total: s.total, correct: s.correct, accuracy: s.total > 0 ? s.correct / s.total : 0 },
    ])
  );
}

/**
 * Get entries suitable for cascade retraining (real feedback labels).
 */
export function getCascadeRetrainingData(): Array<{ prompt_hash: string; actualTier: string }> {
  if (!_initialized) initFeedbackStore();

  return entries
    .filter(e => e.actualTier !== null)
    .map(e => ({ prompt_hash: e.promptHash, actualTier: e.actualTier! }));
}

/**
 * Check if retraining should be triggered.
 */
export function shouldRetrain(retrainAfterInteractions = 500): boolean {
  if (!_initialized) initFeedbackStore();
  return _totalInteractions > 0 && _totalInteractions % retrainAfterInteractions === 0;
}

/**
 * Get entries with LLM-judged adequacy (for label combining).
 */
export function getJudgedEntries(): FeedbackEntry[] {
  if (!_initialized) initFeedbackStore();
  return entries.filter(e => e.adequacyScore !== null && e.actualTier !== null);
}
