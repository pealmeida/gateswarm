/**
 * GateSwarm MoA Router v0.4 — Feedback Store (PERSISTENT)
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

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
}

// ─── Persistence Layer ──────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data/feedback');
const FEEDBACK_FILE = join(DATA_DIR, 'entries.json');
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
  writeFileSync(FEEDBACK_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

// ─── In-Memory Store ─────────────────────────────────────────────

const entries: FeedbackEntry[] = [];
let _totalInteractions = 0;
let _initialized = false;

/**
 * Initialize the feedback store from disk. Call once at gateway startup.
 */
export function initFeedbackStore(): void {
  if (_initialized) return;
  const loaded = loadFeedbackEntries();
  entries.push(...loaded);
  _totalInteractions = loaded.length;
  _initialized = true;
  console.log(`📋 Feedback store loaded: ${_totalInteractions} entries from disk`);
}

/**
 * Flush the in-memory store to disk.
 */
export function flushFeedbackStore(): void {
  if (!_initialized) return;
  saveFeedbackEntries(entries.slice(-MAX_ENTRIES));
}

// Auto-flush every 60 seconds
let _flushInterval: ReturnType<typeof setInterval> | null = null;
export function startFeedbackAutoFlush(intervalMs = 60000): void {
  if (_flushInterval) return;
  _flushInterval = setInterval(flushFeedbackStore, intervalMs);
}

export function recordFeedback(entry: Omit<FeedbackEntry, 'id' | 'timestamp' | 'promptHash'> & { prompt: string }): void {
  if (!_initialized) initFeedbackStore();

  const id = randomBytes(8).toString('hex');
  const timestamp = Date.now();
  const promptHash = createHash('sha256').update(entry.prompt).digest('hex').slice(0, 16);

  entries.push({
    id, timestamp, promptHash,
    predictedTier: entry.predictedTier,
    actualTier: entry.actualTier,
    modelUsed: entry.modelUsed,
    responseTokens: entry.responseTokens,
    adequacyScore: entry.adequacyScore,
    escalated: entry.escalated,
    userSatisfaction: entry.userSatisfaction,
  });

  _totalInteractions++;

  // Keep last 10K entries in memory
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function getInteractionCount(): number {
  if (!_initialized) initFeedbackStore();
  return _totalInteractions;
}

export function getFeedbackEntries(): FeedbackEntry[] {
  if (!_initialized) initFeedbackStore();
  return [...entries];
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
  const unjudged = entries.filter(e => e.adequacyScore === null);
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
    entry.actualTier = actualTier;
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
