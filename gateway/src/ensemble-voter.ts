/**
 * GateSwarm MoA Router v0.4.4 — Ensemble Voter
 *
 * Combines scoring methods into a weighted ensemble:
 *   - Heuristic (55%): v3.3 9-signal formula (boosted from cascade redistribution)
 *   - Cascade (0%):  DISABLED — no trained cascade weights (was 30%, dead code)
 *   - RAG signal (25%): prior context complexity (was 15%)
 *   - History bias (20%): user interaction patterns (was 15%)
 *
 * v0.4.4: History bias wired from persistent feedback store (was inert).
 * v3.6: Cascade weight redistributed because cascade weights were NEVER loaded
 * in any version. Declared 40/30/15/15 but cascade was always -1 (unavailable),
 * so effective weights were heuristic 70% + RAG 30%. Now weights are honest.
 *
 * Confidence-based routing:
 *   - confidence > 0.8 → route to predicted tier
 *   - confidence 0.5–0.8 → escalate one tier (safety margin)
 *   - confidence < 0.5 → route to intensive (safe default)
 */

import type { EffortLevel } from './types.js';
import { getRecentEntries } from './feedback-store.js';

export interface EnsembleVote {
  finalScore: number;
  tier: EffortLevel;
  confidence: number;
  components: {
    heuristicScore: number;    // 0.0–1.0
    cascadeScore: number;      // 0.0–1.0 (if available, else 0)
    ragSignal: number;         // 0.0–1.0
    historyBias: number;       // -0.1 to +0.1
  };
  method: 'ensemble-v0.4' | 'heuristic-fallback';
  escalated: boolean;
}

// ─── Configurable Weights ───────────────────────────────

let weights = {
  heuristic: 0.55,
  cascade: 0.00,  // v3.6: cascade disabled — no trained weights available
  ragSignal: 0.25,
  historyBias: 0.20,
};

export function setEnsembleWeights(w: Partial<typeof weights>): void {
  weights = { ...weights, ...w };
  // Normalize to sum=1
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (const k of Object.keys(weights) as (keyof typeof weights)[]) {
      weights[k] /= total;
    }
  }
}

export function getEnsembleWeights(): typeof weights {
  return { ...weights };
}

// ─── Cascade Score ──────────────────────────────────────

// Placeholder: cascade scores loaded from v3.2 weights file
let cascadeWeights: number[] = [];
let cascadeThresholds: number[] = [0.08, 0.18, 0.32, 0.52, 0.72];

export function loadCascadeWeights(weightsArr: number[], thresholds: number[]): void {
  cascadeWeights = weightsArr;
  cascadeThresholds = thresholds;
}

function cascadeScore(prompt: string): number {
  if (cascadeWeights.length === 0) return -1; // not loaded
  // Simplified: use heuristic-derived features and cascade weights
  // Full implementation: load trained logistic regression weights
  const features = extractCascadeFeatures(prompt);
  let score = 0;
  for (let i = 0; i < Math.min(features.length, cascadeWeights.length); i++) {
    score += features[i] * cascadeWeights[i];
  }
  return 1 / (1 + Math.exp(-score)); // sigmoid
}

function extractCascadeFeatures(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const wc = words.length;
  const sc = sentences.length;
  const avgWl = wc > 0 ? words.reduce((s, w) => s + w.length, 0) / wc : 0;
  const hasQ = text.includes('?');
  const hasCode = /def |function |class |import |const |let |var /.test(text);
  const hasArch = /architecture|system design|microservice|distributed/.test(text);
  const hasTechDesign = /implementation|deployment|pipeline|schema/.test(text);
  const hasImperative = /^(write|create|build|implement|generate|fix|debug|analyze)/.test(text.trim().toLowerCase());
  const techTerms = words.filter(w => /^(api|http|rest|docker|kubernetes|database|algorithm|security|async|await|error|type)$/.test(w)).length;
  const multiStep = /(first|then|next|finally|step\s*\d+)/.test(text.toLowerCase());
  const needsContext = /(the file|this project|my code|our system|given that|consider)/.test(text.toLowerCase());
  const ambiguity = /^(help|what|how|why|do|can|is|are)/.test(text.trim().toLowerCase()) ? 1 : 0;
  const domainSpec = /(finance|legal|medical|engineering|compliance|gdpr|hipaa|wacc|ebitda)/.test(text.toLowerCase()) ? 1 : 0;

  return [
    sc / 10,          // sentence_count (normalized)
    avgWl / 10,       // avg_word_length (normalized)
    hasQ ? 1 : 0,
    (hasQ && techTerms > 0) ? 1 : 0,
    hasTechDesign ? 1 : 0,
    hasCode ? 1 : 0,
    hasArch ? 1 : 0,
    wc / 100,         // word_count (normalized)
    (sc > 4) ? 1 : 0, // four_plus sentences
    hasImperative ? 1 : 0,
    techTerms / 5,    // technical_terms (normalized)
    multiStep ? 1 : 0,
    needsContext ? 1 : 0,
    domainSpec,
    ambiguity,
  ];
}

// ─── RAG Signal ─────────────────────────────────────────

export interface RagSignalInput {
  retrievedEntries: Array<{
    tier: EffortLevel;
    complexityAvg: number;
    escalationHistory: boolean;
  }>;
}

const tierComplexityMap: Record<EffortLevel, number> = {
  trivial: 0.05,
  light: 0.15,
  moderate: 0.30,
  heavy: 0.50,
  intensive: 0.70,
  extreme: 0.90,
};

export function calcRagSignal(input: RagSignalInput): number {
  if (input.retrievedEntries.length === 0) return 0.5; // neutral
  const tiers = input.retrievedEntries.map(e => tierComplexityMap[e.tier] ?? 0.5);
  const avg = tiers.reduce((a, b) => a + b, 0) / tiers.length;
  const escalationBonus = input.retrievedEntries.filter(e => e.escalationHistory).length > 0 ? 0.1 : 0;
  return Math.min(1, avg + escalationBonus);
}

// ─── History Bias ──────────────────────────────────────────────
// v0.4.4: Backed by the persistent feedback store, not a separate in-memory buffer.
// This was the root cause of history bias always being 0.

interface HistoryEntry {
  timestamp: number;
  promptTier: EffortLevel;
  actualTier: EffortLevel | null;
  adequacyScore: number;
}

// In-memory cache of feedback entries for fast history bias calculation
let historyBuffer: HistoryEntry[] = [];
let _historyLoaded = false;

/**
 * Populate the history buffer from the persistent feedback store.
 * Called once at startup or after retraining.
 */
function loadHistoryFromFeedback(): void {
  if (_historyLoaded) return;
  const feedbackEntries = getRecentEntries(500);
  historyBuffer = feedbackEntries.map(e => ({
    timestamp: e.timestamp,
    promptTier: e.predictedTier as EffortLevel,
    actualTier: e.actualTier as EffortLevel | null,
    adequacyScore: e.adequacyScore ?? 0.5,
  }));
  _historyLoaded = true;
}

/**
 * Record a new interaction to the in-memory buffer.
 * Also persisted via feedback-store.ts recordFeedback().
 */
export function recordInteraction(entry: Omit<HistoryEntry, 'timestamp'>): void {
  historyBuffer.push({ ...entry, timestamp: Date.now() });
  if (historyBuffer.length > 500) historyBuffer.shift();
}

/**
 * Reset history cache — forces reload from feedback store on next call.
 * Useful after retraining or manual intervention.
 */
export function resetHistoryCache(): void {
  _historyLoaded = false;
  historyBuffer = [];
}

/**
 * Calculate history bias based on recent interaction patterns.
 * Returns -0.1 to +0.1 adjustment.
 * v0.4.4: Loads from persistent feedback store on first call.
 */
export function calcHistoryBias(recentCount = 50): number {
  if (!_historyLoaded) loadHistoryFromFeedback();
  const recent = historyBuffer.slice(-recentCount);
  if (recent.length < 5) return 0;

  // Check if recent prompts were systematically under/over-classified
  const misclassified = recent.filter(e => e.actualTier !== null && e.promptTier !== e.actualTier);
  if (misclassified.length < 3) return 0;

  let bias = 0;
  for (const e of misclassified) {
    const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    const promptIdx = tiers.indexOf(e.promptTier);
    const actualIdx = tiers.indexOf(e.actualTier!);
    if (actualIdx > promptIdx) bias += 0.02;  // under-classified → bias up
    else bias -= 0.02;                         // over-classified → bias down
  }

  // Also factor in adequacy scores
  const lowAdequacy = recent.filter(e => e.adequacyScore < 0.6).length / recent.length;
  if (lowAdequacy > 0.3) bias += 0.05;  // many low-adequacy → bias up

  return Math.max(-0.1, Math.min(0.1, bias));
}

// ─── Ensemble Vote ──────────────────────────────────────

export interface EnsembleInput {
  prompt: string;
  heuristicScore: number;
  ragSignal?: number;
  enableCascade?: boolean;
}

export function ensembleVote(input: EnsembleInput): EnsembleVote {
  const heuristic = input.heuristicScore;

  // Cascade score (if enabled and weights loaded)
  const casc = (input.enableCascade !== false && cascadeWeights.length > 0)
    ? cascadeScore(input.prompt)
    : -1;

  // RAG signal (default neutral)
  const rag = input.ragSignal ?? 0.5;

  // History bias
  const bias = calcHistoryBias();

  let finalScore: number;
  let confidence: number;
  let method: 'ensemble-v0.4' | 'heuristic-fallback';

  if (casc < 0 || casc === undefined) {
    // Cascade not available → use heuristic + RAG + history (cascade weight already 0 in v3.6)
    method = 'heuristic-fallback';
    // v3.6: weights already sum to 1.0 without cascade, so use them directly
    finalScore = heuristic * weights.heuristic + rag * weights.ragSignal + bias;
    finalScore = Math.max(0, Math.min(1, finalScore));
    confidence = 0.7;
  } else {
    // Full ensemble
    method = 'ensemble-v0.4';
    finalScore =
      heuristic * weights.heuristic +
      casc * weights.cascade +
      rag * weights.ragSignal +
      bias;
    finalScore = Math.max(0, Math.min(1, finalScore));

    // Confidence = agreement between methods
    const methods = [heuristic, casc, rag];
    const mean = methods.reduce((a, b) => a + b, 0) / methods.length;
    const variance = methods.reduce((s, m) => s + (m - mean) ** 2, 0) / methods.length;
    confidence = Math.max(0, 1 - Math.sqrt(variance) * 3);
  }

  // Confidence-based routing
  let escalated = false;
  let tier = scoreToEffort(finalScore);

  if (confidence < 0.5) {
    // Very uncertain → safe default (intensive)
    tier = 'intensive';
    escalated = true;
  } else if (confidence < 0.8) {
    // Moderate uncertainty → escalate one tier
    const tiers: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    const idx = tiers.indexOf(tier);
    if (idx < tiers.length - 1) {
      tier = tiers[idx + 1];
      escalated = true;
    }
  }

  return {
    finalScore,
    tier,
    confidence,
    components: {
      heuristicScore: heuristic,
      cascadeScore: casc < 0 ? 0 : casc,
      ragSignal: rag,
      historyBias: bias,
    },
    method,
    escalated,
  };
}

import { scoreToEffort as _scoreToEffort } from './intent-engine.js';
export const scoreToEffort = _scoreToEffort;
