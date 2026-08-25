/**
 * GateSwarm MoMA Router v0.4 — Label Combiner
 *
 * Combines labels from 3 sources with quality-weighted voting:
 *   GOLD:   Manual user votes (weight=1.0, 100% ground truth)
 *   SILVER: RAG contextual consensus (weight=0.3→0.7, pattern-based)
 *   BRONZE: LLM judge async (weight=0.5, calibrated against gold)
 *
 * Quality calibration:
 *   After 50 manual votes: adjust BRONZE weight based on LLM agreement rate
 *   After 100 manual votes: adjust SILVER weight based on RAG agreement rate
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { EffortLevel } from './types.js';

// ─── Types ────────────────────────────────────────────────

export interface LabelSource {
  tier: EffortLevel;
  source: 'gold' | 'silver' | 'bronze';
  weight: number;
  confidence: number;
}

export interface CombinedLabel {
  tier: EffortLevel;
  confidence: number;
  totalWeight: number;
  sources: LabelSource[];
}

// ─── Default Weights ──────────────────────────────────────

const DEFAULT_GOLD_WEIGHT = 1.0;
const DEFAULT_SILVER_WEIGHT = 0.3;  // Low until validated
const DEFAULT_BRONZE_WEIGHT = 0.5;
const FULL_PHASE_MIN_COMPARISONS = 30;
const FULL_PHASE_MIN_AGREEMENT = 0.7;
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CALIBRATION_FILE = join(__dirname, '../data/training/calibration.json');

let goldWeight = DEFAULT_GOLD_WEIGHT;
let silverWeight = DEFAULT_SILVER_WEIGHT;
let bronzeWeight = DEFAULT_BRONZE_WEIGHT;

// Calibration state
let bronzeAgreementCount = 0;
let bronzeTotalCompared = 0;
let silverAgreementCount = 0;
let silverTotalCompared = 0;

// Phase tracking for RAG bootstrap
let totalInteractions = 0;
let ragPhase: 'disabled' | 'low' | 'full' = 'disabled';
let calibrationFile = DEFAULT_CALIBRATION_FILE;

interface CalibrationState {
  bronzeAgreementCount: number;
  bronzeTotalCompared: number;
  silverAgreementCount: number;
  silverTotalCompared: number;
  bronzeWeight: number;
  silverWeight: number;
  totalInteractions: number;
  ragPhase: 'disabled' | 'low' | 'full';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function getCalibrationState(): CalibrationState {
  return {
    bronzeAgreementCount,
    bronzeTotalCompared,
    silverAgreementCount,
    silverTotalCompared,
    bronzeWeight,
    silverWeight,
    totalInteractions,
    ragPhase,
  };
}

function isValidState(value: unknown): value is CalibrationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<CalibrationState>;
  return [
    state.bronzeAgreementCount,
    state.bronzeTotalCompared,
    state.silverAgreementCount,
    state.silverTotalCompared,
    state.bronzeWeight,
    state.silverWeight,
    state.totalInteractions,
  ].every(isFiniteNumber)
    && state.bronzeAgreementCount! >= 0
    && state.bronzeTotalCompared! >= state.bronzeAgreementCount!
    && state.silverAgreementCount! >= 0
    && state.silverTotalCompared! >= state.silverAgreementCount!
    && state.totalInteractions! >= 0
    && state.bronzeWeight! >= 0
    && state.silverWeight! >= 0
    && (state.ragPhase === 'disabled' || state.ragPhase === 'low' || state.ragPhase === 'full');
}

function persistCalibrationState(): void {
  const directory = dirname(calibrationFile);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

  const temporaryFile = `${calibrationFile}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | undefined;
  try {
    writeFileSync(temporaryFile, JSON.stringify(getCalibrationState(), null, 2), 'utf-8');
    descriptor = openSync(temporaryFile, 'r+');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryFile, calibrationFile);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporaryFile); } catch { /* no temporary file to remove */ }
    console.error(`Unable to persist calibration state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Restore durable calibration state. Invalid files leave the safe defaults intact. */
export function loadCalibrationState(): boolean {
  if (!existsSync(calibrationFile)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(calibrationFile, 'utf-8'));
    if (!isValidState(parsed)) return false;
    bronzeAgreementCount = parsed.bronzeAgreementCount;
    bronzeTotalCompared = parsed.bronzeTotalCompared;
    silverAgreementCount = parsed.silverAgreementCount;
    silverTotalCompared = parsed.silverTotalCompared;
    bronzeWeight = parsed.bronzeWeight;
    silverWeight = parsed.silverWeight;
    totalInteractions = parsed.totalInteractions;
    ragPhase = parsed.ragPhase;
    return true;
  } catch (error) {
    console.error(`Unable to restore calibration state: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Test seam for isolating persistence from the application data directory. */
export function setCalibrationStoragePath(path: string): void {
  calibrationFile = path;
}

// ─── Combine Labels ───────────────────────────────────────

/**
 * Combine labels from available sources.
 * Returns the weighted majority tier with confidence.
 */
export function combineLabels(sources: LabelSource[]): CombinedLabel | null {
  const validSources = sources.filter(source =>
    Number.isFinite(source.weight) && Number.isFinite(source.confidence)
  );
  if (validSources.length === 0) return null;

  // If gold exists, it always wins (100% truth)
  const gold = validSources.find(s => s.source === 'gold');
  if (gold) {
    const weight = goldWeight * gold.weight * Math.max(0, Math.min(1, gold.confidence));
    return {
      tier: gold.tier,
      confidence: 1.0,
      totalWeight: weight,
      sources: [gold],
    };
  }

  // Weighted vote among silver + bronze
  const tierWeights: Record<string, number> = {};
  for (const src of validSources) {
    let w = src.weight * Math.max(0, Math.min(1, src.confidence));
    if (src.source === 'silver') w *= getSilverWeight();
    else if (src.source === 'bronze') w *= getBronzeWeight();
    tierWeights[src.tier] = (tierWeights[src.tier] || 0) + w;
  }

  // Find majority tier
  let bestTier: EffortLevel = validSources[0].tier;
  let bestWeight = 0;
  let totalWeight = 0;

  for (const [tier, weight] of Object.entries(tierWeights)) {
    totalWeight += weight;
    if (weight > bestWeight) {
      bestWeight = weight;
      bestTier = tier as EffortLevel;
    }
  }

  const confidence = totalWeight > 0 ? bestWeight / totalWeight : 0;

  return {
    tier: bestTier,
    confidence: Math.min(1, confidence),
    totalWeight,
    sources: validSources,
  };
}

// ─── Weight Getters (with calibration) ───────────────────

export function getGoldWeight(): number {
  return goldWeight;
}

export function getSilverWeight(): number {
  // Phase-based RAG weight
  if (ragPhase === 'disabled') return 0;
  if (ragPhase === 'low') return silverWeight * 0.5;
  return silverWeight;
}

export function getBronzeWeight(): number {
  return bronzeWeight;
}

// ─── Quality Calibration ──────────────────────────────────

/**
 * Record a comparison between gold vote and bronze (LLM judge) label.
 * Called after 50+ manual votes to calibrate bronze weight.
 */
export function calibrateBronze(agrees: boolean): void {
  bronzeTotalCompared++;
  if (agrees) bronzeAgreementCount++;

  // After 10+ comparisons, adjust weight
  if (bronzeTotalCompared >= 10) {
    const agreementRate = bronzeAgreementCount / bronzeTotalCompared;
    // Weight = default × agreement rate (clamped 0.1–0.8)
    bronzeWeight = Math.max(0.1, Math.min(0.8, DEFAULT_BRONZE_WEIGHT * agreementRate));
  }
  persistCalibrationState();
}

/**
 * Record a comparison between gold vote and silver (RAG consensus) label.
 * Called after 100+ manual votes to calibrate silver weight.
 */
export function calibrateSilver(agrees: boolean): void {
  silverTotalCompared++;
  if (agrees) silverAgreementCount++;

  const agreementRate = silverAgreementCount / silverTotalCompared;
  // Preserve evidence from poor agreement rather than retaining the default.
  silverWeight = Math.max(0, Math.min(0.9, DEFAULT_SILVER_WEIGHT * agreementRate));
  updateRagPhase();
  persistCalibrationState();
}

// ─── RAG Bootstrap Phases ────────────────────────────────

/**
 * Track interaction count for RAG phase transitions.
 * Phase 1 (0-50): disabled
 * Phase 2 (50-200): low weight (0.15)
 * Phase 3 (200+): full weight after validation
 */
export function incrementInteractionCount(): void {
  totalInteractions++;
  updateRagPhase();
  persistCalibrationState();
}

function updateRagPhase(): void {
  if (totalInteractions >= 50 && ragPhase === 'disabled') {
    ragPhase = 'low';
    console.log(`🔄 RAG bootstrap: Phase 2 (low weight) at ${totalInteractions} interactions`);
  }
  if (totalInteractions >= 200 && ragPhase === 'low') {
    const agreementRate = silverTotalCompared > 0
      ? silverAgreementCount / silverTotalCompared
      : 0;
    if (silverTotalCompared >= FULL_PHASE_MIN_COMPARISONS && agreementRate >= FULL_PHASE_MIN_AGREEMENT) {
      ragPhase = 'full';
      console.log(`🔄 RAG bootstrap: Phase 3 (full weight) at ${totalInteractions} interactions`);
    }
  }
}

export function getRagPhase(): string {
  return ragPhase;
}

// ─── Calibration Stats ───────────────────────────────────

export function getCalibrationStats(): {
  bronzeAgreementRate: number;
  silverAgreementRate: number;
  bronzeWeight: number;
  silverWeight: number;
  ragPhase: string;
  totalInteractions: number;
} {
  return {
    bronzeAgreementRate: bronzeTotalCompared > 0 ? bronzeAgreementCount / bronzeTotalCompared : -1,
    silverAgreementRate: silverTotalCompared > 0 ? silverAgreementCount / silverTotalCompared : -1,
    bronzeWeight,
    silverWeight,
    ragPhase,
    totalInteractions,
  };
}

export function resetCalibration(options: { persist?: boolean } = {}): void {
  goldWeight = DEFAULT_GOLD_WEIGHT;
  silverWeight = DEFAULT_SILVER_WEIGHT;
  bronzeWeight = DEFAULT_BRONZE_WEIGHT;
  bronzeAgreementCount = 0;
  bronzeTotalCompared = 0;
  silverAgreementCount = 0;
  silverTotalCompared = 0;
  totalInteractions = 0;
  ragPhase = 'disabled';
  if (options.persist !== false) persistCalibrationState();
}

loadCalibrationState();
