/**
 * GateSwarm MoA Router v0.4 — Label Combiner
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

// ─── Combine Labels ───────────────────────────────────────

/**
 * Combine labels from available sources.
 * Returns the weighted majority tier with confidence.
 */
export function combineLabels(sources: LabelSource[]): CombinedLabel | null {
  if (sources.length === 0) return null;

  // If gold exists, it always wins (100% truth)
  const gold = sources.find(s => s.source === 'gold');
  if (gold) {
    return {
      tier: gold.tier,
      confidence: 1.0,
      totalWeight: goldWeight,
      sources: [gold],
    };
  }

  // Weighted vote among silver + bronze
  const tierWeights: Record<string, number> = {};
  for (const src of sources) {
    let w = src.weight;
    if (src.source === 'silver') w *= getSilverWeight();
    else if (src.source === 'bronze') w *= getBronzeWeight();
    tierWeights[src.tier] = (tierWeights[src.tier] || 0) + w;
  }

  // Find majority tier
  let bestTier: EffortLevel = sources[0].tier;
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
    sources,
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
}

/**
 * Record a comparison between gold vote and silver (RAG consensus) label.
 * Called after 100+ manual votes to calibrate silver weight.
 */
export function calibrateSilver(agrees: boolean): void {
  silverTotalCompared++;
  if (agrees) silverAgreementCount++;

  // After 10+ comparisons, adjust weight
  if (silverTotalCompared >= 10) {
    const agreementRate = silverAgreementCount / silverTotalCompared;
    // Weight = default × agreement rate (clamped 0.1–0.9)
    const calibrated = Math.max(0.1, Math.min(0.9, DEFAULT_SILVER_WEIGHT * agreementRate));
    // Only increase from bootstrap low weight if validated
    if (agreementRate > 0.7) {
      silverWeight = calibrated;
    }
  }
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
  if (totalInteractions >= 50 && ragPhase === 'disabled') {
    ragPhase = 'low';
    console.log(`🔄 RAG bootstrap: Phase 2 (low weight) at ${totalInteractions} interactions`);
  }
  if (totalInteractions >= 200 && ragPhase === 'low') {
    // Only transition to full if silver has been calibrated and validated
    if (silverWeight >= DEFAULT_SILVER_WEIGHT * 0.5) {
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

export function resetCalibration(): void {
  goldWeight = DEFAULT_GOLD_WEIGHT;
  silverWeight = DEFAULT_SILVER_WEIGHT;
  bronzeWeight = DEFAULT_BRONZE_WEIGHT;
  bronzeAgreementCount = 0;
  bronzeTotalCompared = 0;
  silverAgreementCount = 0;
  silverTotalCompared = 0;
  totalInteractions = 0;
  ragPhase = 'disabled';
}
