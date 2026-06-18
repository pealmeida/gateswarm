/**
 * GateSwarm MoA Router v0.4 — RAG Index (UNIFIED, PERSISTENT)
 *
 * v0.4.4: JSON-file persistence — survives gateway restarts.
 *
 * Stores:
 *   1. Interaction entries (from gateway after each request)
 *      — keywords, tier, modelUsed, adequacyScore, summary, token counts
 *   2. Compression entries (from turboquant when messages are Q0/Q1/Q2)
 *      — originalRole, tags, quant tier (Q0/Q1/Q2), summary
 *
 * Both entry types share the core fields and coexist in one array,
 * queried together by keyword overlap for retrieval.
 */

import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

export interface RagEntry {
  id: string;
  timestamp: number;
  keywords: string[];           // overlap with tags for compressor entries
  tags: string[];               // semantic tags (from compressor)
  tier: string;                 // effort tier OR Q0/Q1/Q2 for compressor
  modelUsed: string;
  originalRole: string;         // message role (system/user/assistant/tool)
  adequacyScore: number;        // 0.0–1.0; default 1.0 for compressor entries
  summary: string;
  originalTokens: number;
  compressedTokens: number;
}

// ─── Persistence Layer ──────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data/rag');
const RAG_FILE = join(DATA_DIR, 'index.json');
const MAX_ENTRIES = 10000;
const TTL_MS = 86400000; // 24 hours

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadRagIndex(): RagEntry[] {
  ensureDataDir();
  if (!existsSync(RAG_FILE)) return [];
  try {
    const raw = readFileSync(RAG_FILE, 'utf-8');
    return JSON.parse(raw) as RagEntry[];
  } catch {
    return [];
  }
}

function saveRagIndex(entries: RagEntry[]): void {
  ensureDataDir();
  writeFileSync(RAG_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

// ─── In-Memory Index (loaded from disk at init) ─────────────────

let ragIndex: RagEntry[] = [];
let _initialized = false;

/**
 * Initialize the RAG index from disk. Call once at gateway startup.
 */
export function initRagIndex(): RagEntry[] {
  if (_initialized) return ragIndex;
  ragIndex = loadRagIndex();
  _initialized = true;
  console.log(`📚 RAG index loaded: ${ragIndex.length} entries from disk`);
  return ragIndex;
}

/**
 * Flush the in-memory index to disk. Called periodically or on shutdown.
 */
export function flushRagIndex(): void {
  if (!_initialized) return;
  saveRagIndex(ragIndex);
}

// Auto-flush every 60 seconds
let _flushInterval: ReturnType<typeof setInterval> | null = null;
export function startRagAutoFlush(intervalMs = 60000): void {
  if (_flushInterval) return;
  _flushInterval = setInterval(() => {
    clearExpiredEntries();
    flushRagIndex();
  }, intervalMs);
}

// ─── Core Operations ──────────────────────────────────────────────

/**
 * Add a gateway interaction entry (after request completion).
 */
export function addRagEntry(entry: Omit<RagEntry, 'id' | 'timestamp' | 'tags' | 'originalRole'> & { tags?: string[]; originalRole?: string }): string {
  if (!_initialized) initRagIndex();

  const id = createHash('sha256')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 16);

  ragIndex.push({
    ...entry,
    id,
    timestamp: Date.now(),
    tags: entry.tags ?? [],
    originalRole: entry.originalRole ?? '',
  });

  if (ragIndex.length > MAX_ENTRIES) ragIndex.shift();
  return id;
}

/**
 * Add a compressor summary entry (when a message is Q0/Q1/Q2).
 * Called from turboquant-compressor.ts.
 */
export function storeToRag(entry: {
  id: string;
  originalRole: string;
  summary: string;
  tags: string[];
  tier: 'Q0' | 'Q1' | 'Q2';
}): void {
  if (!_initialized) initRagIndex();

  if (ragIndex.length >= MAX_ENTRIES) {
    ragIndex.splice(0, Math.floor(MAX_ENTRIES * 0.3));
  }
  const now = Date.now();
  ragIndex.push({
    id: entry.id,
    timestamp: now,
    keywords: [...entry.tags],  // overlap alias for keyword search
    tags: entry.tags,
    tier: entry.tier,
    modelUsed: '',
    originalRole: entry.originalRole,
    adequacyScore: 1.0,  // compressor entries default to adequate
    summary: entry.summary,
    originalTokens: 0,
    compressedTokens: 0,
  });
}

/**
 * Query the RAG index by keyword/tag overlap.
 * Matches against both `keywords` (gateway entries) and `tags` (compressor entries).
 */
export function queryRag(keywords: string[], maxResults = 3): RagEntry[] {
  if (!_initialized) initRagIndex();

  const now = Date.now();
  const active = ragIndex.filter(e => now - e.timestamp < TTL_MS);

  const scored = active.map(entry => {
    // Search both keywords and tags for overlap
    const searchTerms = [...new Set([...entry.keywords, ...entry.tags])];
    const overlap = keywords.filter(k =>
      searchTerms.some(ek => ek.includes(k) || k.includes(ek))
    ).length;
    return { entry, score: overlap };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.entry);
}

export function getRagSignalEntries(keywords: string[]): Array<{
  tier: RagEntry['tier'];
  compressedTokens: number;
  adequacyScore: number;
  escalationHistory: boolean;
}> {
  const entries = queryRag(keywords, 5);
  return entries.map(e => ({
    tier: e.tier,
    compressedTokens: e.compressedTokens,
    adequacyScore: e.adequacyScore,
    escalationHistory: e.adequacyScore < 0.6,
  }));
}

export function getRagStats(): { total: number; active: number; avgTokens: number } {
  if (!_initialized) initRagIndex();

  const now = Date.now();
  const active = ragIndex.filter(e => now - e.timestamp < TTL_MS);
  const avgTokens = active.length > 0
    ? active.reduce((sum, e) => sum + e.compressedTokens, 0) / active.length
    : 0;

  return {
    total: ragIndex.length,
    active: active.length,
    avgTokens: Math.round(avgTokens),
  };
}

/**
 * Update an entry's adequacyScore after self-evaluation.
 * Returns true if the entry was found and updated.
 */
export function updateRagAdequacy(id: string, adequacyScore: number): boolean {
  if (!_initialized) initRagIndex();

  const entry = ragIndex.find(e => e.id === id);
  if (entry) {
    entry.adequacyScore = adequacyScore;
    return true;
  }
  return false;
}

/**
 * Clear expired entries (TTL-based garbage collection).
 */
export function clearExpiredEntries(): void {
  if (!_initialized) return;

  const now = Date.now();
  const idx = ragIndex.findIndex(e => now - e.timestamp >= TTL_MS);
  if (idx >= 0) ragIndex.splice(0, idx + 1);
}

/**
 * Clear the entire RAG index (testing or memory pressure).
 */
export function clearRag(): void {
  if (!_initialized) initRagIndex();
  ragIndex.length = 0;
  flushRagIndex();
}

export { ragIndex };
