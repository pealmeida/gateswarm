/**
 * Deterministic warm-store fixtures for hybrid ablation.
 *
 * Seeds are derived only from train-side examples. The examples passed to
 * runAblation() are treated as the scoring set and are excluded from all warm
 * fixtures to avoid RAG/history leakage.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EffortLevel } from '../../src/types.js';
import {
  flushRagIndex,
  initRagIndex,
  ragIndex,
} from '../../src/rag-index.js';
import type { RagEntry } from '../../src/rag-index.js';
import {
  recordInteraction,
  resetHistoryCache,
} from '../../src/ensemble-voter.js';
import { loadEffort, TIERS } from './dataset.js';
import type { EffortExample } from './dataset.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPLIT_DIR = join(__dirname, '..', 'splits');
const TRAIN_SPLIT_PATH = join(SPLIT_DIR, 'train.v1.json');
const HOLDOUT_SPLIT_PATH = join(SPLIT_DIR, 'holdout.v1.json');
const RAG_FILE = join(__dirname, '..', '..', 'data', 'rag', 'index.json');
const FEEDBACK_FILE = join(__dirname, '..', '..', 'data', 'feedback', 'entries.json');
const WARM_TIMESTAMP = 1_700_000_000_000;

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'and',
  'are',
  'can',
  'for',
  'from',
  'get',
  'has',
  'have',
  'how',
  'into',
  'need',
  'our',
  'that',
  'the',
  'then',
  'this',
  'through',
  'under',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'without',
  'would',
  'you',
]);

export interface WarmHistoryEntry {
  promptTier: EffortLevel;
  actualTier: EffortLevel | null;
  adequacyScore: number;
}

export interface WarmFeedbackEntry {
  id: string;
  timestamp: number;
  promptHash: string;
  predictedTier: string;
  actualTier: string | null;
  modelUsed: string;
  responseTokens: number;
  adequacyScore: number | null;
  escalated: boolean;
  userSatisfaction: number | null;
  score?: number;
}

export interface WarmSeedPlan {
  seedIds: string[];
  scoredIds: string[];
  ragEntries: RagEntry[];
  feedbackEntries: WarmFeedbackEntry[];
  historyEntries: WarmHistoryEntry[];
}

export interface WarmSeedHandle {
  plan: WarmSeedPlan;
  cleanup: () => void;
}

interface FileSnapshot {
  existed: boolean;
  bytes: string;
}

function safeId(id: string): string {
  return id.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
}

function fileSnapshot(path: string): FileSnapshot {
  return existsSync(path)
    ? { existed: true, bytes: readFileSync(path, 'utf-8') }
    : { existed: false, bytes: '' };
}

function restoreFile(path: string, snapshot: FileSnapshot): void {
  if (snapshot.existed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, snapshot.bytes, 'utf-8');
    return;
  }
  if (existsSync(path)) unlinkSync(path);
}

function readJsonIfExists(path: string): unknown | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function idsFromTrainShape(value: unknown): string[] | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string');
  if (Array.isArray(obj.train)) return obj.train.filter((id): id is string => typeof id === 'string');
  const effort = obj.effort as unknown;
  if (Array.isArray(effort)) return effort.filter((id): id is string => typeof id === 'string');
  if (effort && typeof effort === 'object') {
    const train = (effort as Record<string, unknown>).train;
    if (Array.isArray(train)) return train.filter((id): id is string => typeof id === 'string');
  }
  return null;
}

function holdoutIds(kind: 'train' | 'test'): string[] | null {
  const parsed = readJsonIfExists(HOLDOUT_SPLIT_PATH);
  if (!parsed || typeof parsed !== 'object') return null;
  const effort = (parsed as Record<string, unknown>).effort;
  if (!effort || typeof effort !== 'object') return null;
  const ids = (effort as Record<string, unknown>)[kind];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : null;
}

function trainIds(): string[] | null {
  const explicit = idsFromTrainShape(readJsonIfExists(TRAIN_SPLIT_PATH));
  if (explicit?.length) return explicit.filter((id) => id.startsWith('effort:'));
  const holdoutTrain = holdoutIds('train');
  return holdoutTrain?.length ? holdoutTrain : null;
}

function byId(examples: EffortExample[]): Map<string, EffortExample> {
  return new Map(examples.map((e) => [e.id, e]));
}

function groupByTier(examples: EffortExample[]): Map<EffortLevel, EffortExample[]> {
  const groups = new Map<EffortLevel, EffortExample[]>();
  for (const tier of TIERS) groups.set(tier, []);
  for (const ex of examples) groups.get(ex.tier)?.push(ex);
  for (const group of groups.values()) group.sort((a, b) => a.id.localeCompare(b.id));
  return groups;
}

function deterministicSeedSubset(all: EffortExample[], scoredIds: Set<string>): EffortExample[] {
  const groups = groupByTier(all.filter((ex) => !scoredIds.has(ex.id)));
  return TIERS.flatMap((tier) => groups.get(tier)!.slice(0, 10));
}

function deterministicScoringSubset(all: EffortExample[]): EffortExample[] {
  const groups = groupByTier(all);
  return TIERS.flatMap((tier) => groups.get(tier)!.slice(-5));
}

export function selectWarmAblationExamples(all: EffortExample[] = loadEffort()): EffortExample[] {
  const testIds = holdoutIds('test');
  if (testIds?.length) {
    const lookup = byId(all);
    return testIds.map((id) => lookup.get(id)).filter((ex): ex is EffortExample => Boolean(ex));
  }
  return deterministicScoringSubset(all);
}

export function keywordsForPrompt(prompt: string, limit = 12): string[] {
  const seen = new Set<string>();
  for (const raw of prompt.toLowerCase().split(/\s+/)) {
    const word = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (word.length < 3 || STOP_WORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

function tierShift(tier: EffortLevel, delta: number): EffortLevel {
  const idx = TIERS.indexOf(tier);
  const next = Math.max(0, Math.min(TIERS.length - 1, idx + delta));
  return TIERS[next];
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function ragTierForSeed(tier: EffortLevel): EffortLevel {
  // T5 will fix tierComplexityMap, where heavy/intensive/extreme currently sit
  // above the live extreme boundary. Keep stratified gold-tier seeds here
  // instead of high-tier-only anchors so the 0.2 RAG blend remains interpretable.
  return tier;
}

function ragEntryForExample(ex: EffortExample, i: number): RagEntry {
  const words = ex.prompt.split(/\s+/).filter(Boolean).length;
  const keywords = keywordsForPrompt(ex.prompt);
  return {
    id: `warm-rag-${safeId(ex.id)}`,
    timestamp: WARM_TIMESTAMP + i,
    keywords,
    tags: [ex.tier, ...keywords.slice(0, 5)],
    tier: ragTierForSeed(ex.tier),
    modelUsed: `warm-fixture/${ex.tier}`,
    originalRole: 'user',
    adequacyScore: i % 7 === 0 ? 0.58 : i % 5 === 0 ? 0.72 : 0.9,
    summary: `Warm routing fixture for ${ex.tier}: ${keywords.slice(0, 8).join(' ')}`,
    originalTokens: words,
    compressedTokens: Math.max(1, Math.round(words * 0.6)),
  };
}

function historyForExample(ex: EffortExample, i: number): WarmHistoryEntry {
  const predicted =
    i % 6 === 0 ? tierShift(ex.tier, -1) :
    i % 6 === 3 ? tierShift(ex.tier, 1) :
    ex.tier;
  return {
    promptTier: predicted,
    actualTier: ex.tier,
    adequacyScore: predicted === ex.tier ? 0.88 : i % 2 === 0 ? 0.52 : 0.68,
  };
}

function feedbackForExample(ex: EffortExample, history: WarmHistoryEntry, i: number): WarmFeedbackEntry {
  return {
    id: `warm-feedback-${safeId(ex.id)}`,
    timestamp: WARM_TIMESTAMP + i,
    promptHash: hashPrompt(ex.prompt),
    predictedTier: history.promptTier,
    actualTier: history.actualTier,
    modelUsed: `warm-fixture/${history.promptTier}`,
    responseTokens: Math.max(16, ex.prompt.split(/\s+/).length * 8),
    adequacyScore: history.adequacyScore,
    escalated: TIERS.indexOf(history.promptTier) < TIERS.indexOf(ex.tier),
    userSatisfaction: history.adequacyScore >= 0.8 ? 5 : history.adequacyScore >= 0.6 ? 3 : 2,
  };
}

export function createWarmSeedPlan(scoredExamples: EffortExample[]): WarmSeedPlan {
  const all = loadEffort();
  const lookup = byId(all);
  const scoredIds = new Set(scoredExamples.map((ex) => ex.id));
  const splitIds = trainIds();
  const seedPool = splitIds?.length
    ? splitIds.map((id) => lookup.get(id)).filter((ex): ex is EffortExample => ex !== undefined && !scoredIds.has(ex.id))
    : deterministicSeedSubset(all, scoredIds);

  if (seedPool.length < 6) {
    throw new Error('warm seed set is empty or too small after excluding scored prompt ids');
  }

  const historySource = seedPool.slice(0, Math.min(24, seedPool.length));
  const historyEntries = historySource.map(historyForExample);
  return {
    seedIds: seedPool.map((ex) => ex.id),
    scoredIds: scoredExamples.map((ex) => ex.id),
    ragEntries: seedPool.map(ragEntryForExample),
    historyEntries,
    feedbackEntries: historySource.map((ex, i) => feedbackForExample(ex, historyEntries[i], i)),
  };
}

export function seedWarmStores(scoredExamples: EffortExample[]): WarmSeedHandle {
  const plan = createWarmSeedPlan(scoredExamples);
  const ragFile = fileSnapshot(RAG_FILE);
  const feedbackFile = fileSnapshot(FEEDBACK_FILE);
  initRagIndex();
  const previousRag = ragIndex.slice();

  let restored = false;
  const cleanup = () => {
    if (restored) return;
    restored = true;
    ragIndex.splice(0, ragIndex.length, ...previousRag);
    flushRagIndex();
    restoreFile(RAG_FILE, ragFile);
    restoreFile(FEEDBACK_FILE, feedbackFile);
    resetHistoryCache();
  };

  try {
    ragIndex.splice(0, ragIndex.length, ...plan.ragEntries);
    flushRagIndex();

    mkdirSync(dirname(FEEDBACK_FILE), { recursive: true });
    writeFileSync(FEEDBACK_FILE, JSON.stringify(plan.feedbackEntries, null, 2), 'utf-8');

    resetHistoryCache();
    for (const entry of plan.historyEntries) recordInteraction(entry);
    return { plan, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}
