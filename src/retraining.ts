/**
 * GateSwarm MoMA Router — Boundary retraining proposals
 *
 * Retraining is deliberately advisory: it fits and persists a proposal, but
 * never changes live boundaries or v04_config.json. Applying a proposal is a
 * reviewed source-controlled operation.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { EffortLevel } from './types.js';
import { getConfig, type EnsembleWeightsConfig } from './v04-config.js';
import { getFeedbackEntries } from './feedback-store.js';
import { getTierBoundaries } from './tier-boundaries.js';

const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
const OPTIMIZATION_BUDGET_MS = 2000;
const MIN_VALIDATION_IMPROVEMENT = 0.02;
const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAINING_DATA_DIR = process.env.MOMA_TRAINING_DATA_DIR ?? join(__dirname, '../data/training');
const PROPOSAL_FILE = join(TRAINING_DATA_DIR, 'boundary-proposal.json');

// ─── Weights (kept for API compatibility; weights are no longer a train target) ──

let _activeWeights: EnsembleWeightsConfig | null = null;

export function getActiveWeights(): EnsembleWeightsConfig {
  if (_activeWeights) return _activeWeights;
  return getConfig().ensemble.weights;
}

export function setWeights(weights: EnsembleWeightsConfig): void {
  _activeWeights = weights;
}

// ─── Boundary optimisation ────────────────────────────────────────

export interface LabeledScore {
  score: number;
  tier: number;
  /** Stable source identifier used only for deterministic train/validation splitting. */
  id?: string;
}

export interface BoundaryProposal {
  boundaries: [number, number, number, number, number];
  accuracyBefore: number;
  accuracyAfter: number;
  n: number;
  fittedAt: string;
}

/** Exact tier accuracy of a boundary set against labeled (score → tier) pairs. */
export function accuracyFor(bounds: readonly number[], data: readonly LabeledScore[]): number {
  if (data.length === 0) return 0;
  let correct = 0;
  for (const { score, tier } of data) {
    let predicted = 0;
    while (predicted < bounds.length && score >= bounds[predicted]) predicted++;
    if (predicted === tier) correct++;
  }
  return correct / data.length;
}

function assertWithinBudget(deadline: number): void {
  if (Date.now() > deadline) throw new Error('boundary optimization exceeded its 2s time budget');
}

/**
 * Fit five ordered cuts using dynamic programming.
 *
 * Scores are sorted once. A valid cut can occur only between adjacent samples
 * with different scores and labels; prefix counts reduce each DP transition to
 * O(1), making the fixed-five-cut optimization O(n log n) overall.
 */
export function optimizeBoundaries(
  data: readonly LabeledScore[],
  timeBudgetMs = OPTIMIZATION_BUDGET_MS,
): { bounds: [number, number, number, number, number]; accuracy: number } | null {
  const deadline = Date.now() + timeBudgetMs;
  const sorted = [...data]
    .filter(row => Number.isFinite(row.score) && Number.isInteger(row.tier) && row.tier >= 0 && row.tier < TIERS.length)
    .sort((a, b) => a.score - b.score || a.tier - b.tier);
  assertWithinBudget(deadline);

  if (sorted.length < 6) return null;

  const candidateCuts: number[] = [];
  for (let index = 0; index < sorted.length - 1; index++) {
    if (sorted[index].score !== sorted[index + 1].score && sorted[index].tier !== sorted[index + 1].tier) {
      candidateCuts.push(index + 1);
    }
  }
  if (candidateCuts.length < 5) return null;

  // prefix[tier][i] is the number of labels == tier among sorted[0..i).
  const prefix = TIERS.map(() => new Array<number>(sorted.length + 1).fill(0));
  for (let index = 0; index < sorted.length; index++) {
    for (let tier = 0; tier < TIERS.length; tier++) prefix[tier][index + 1] = prefix[tier][index];
    prefix[sorted[index].tier][index + 1]++;
  }

  // After s segments, DP values end at an allowed cut and classify labels 0..s-1.
  let previous = new Map<number, number>([[0, 0]]);
  const backPointers: Array<Map<number, number>> = Array.from({ length: 6 }, () => new Map());

  for (let segments = 1; segments <= 5; segments++) {
    assertWithinBudget(deadline);
    const tier = segments - 1;
    const current = new Map<number, number>();
    let bestPrevious = previous.has(0) ? (previous.get(0) as number) - prefix[tier][0] : Number.NEGATIVE_INFINITY;
    let bestPosition = previous.has(0) ? 0 : -1;

    for (const position of candidateCuts) {
      if (bestPosition >= 0) {
        current.set(position, bestPrevious + prefix[tier][position]);
        backPointers[segments].set(position, bestPosition);
      }
      // Add this position only after evaluating it, so adjacent segments
      // cannot share a cut and create a zero-width tier.
      const prior = previous.get(position);
      if (prior !== undefined) {
        const candidate = prior - prefix[tier][position];
        if (candidate > bestPrevious) {
          bestPrevious = candidate;
          bestPosition = position;
        }
      }
    }
    previous = current;
  }

  let bestScore = Number.NEGATIVE_INFINITY;
  let finalCut = -1;
  for (const position of candidateCuts) {
    const prior = previous.get(position);
    if (prior === undefined) continue;
    const score = prior + (prefix[5][sorted.length] - prefix[5][position]);
    if (score > bestScore) {
      bestScore = score;
      finalCut = position;
    }
  }
  if (finalCut < 0) return null;

  const cuts = [finalCut];
  let position = finalCut;
  for (let segments = 5; segments > 1; segments--) {
    const prior = backPointers[segments].get(position);
    if (prior === undefined || prior <= 0) return null;
    cuts.push(prior);
    position = prior;
  }
  cuts.reverse();
  if (cuts.length !== 5 || new Set(cuts).size !== 5) return null;

  const bounds = cuts.map(cut => (sorted[cut - 1].score + sorted[cut].score) / 2) as [number, number, number, number, number];
  return { bounds, accuracy: bestScore / sorted.length };
}

function splitDeterministically(data: readonly LabeledScore[]): { train: LabeledScore[]; validation: LabeledScore[] } {
  const train: LabeledScore[] = [];
  const validation: LabeledScore[] = [];
  for (const row of data) {
    const id = row.id ?? `${row.score}:${row.tier}`;
    const bucket = createHash('sha256').update(id).digest().readUInt32BE(0) / 0x1_0000_0000;
    (bucket < 0.8 ? train : validation).push(row);
  }
  return { train, validation };
}

function writeProposal(proposal: BoundaryProposal): void {
  if (!existsSync(TRAINING_DATA_DIR)) mkdirSync(TRAINING_DATA_DIR, { recursive: true });
  const tempPath = `${PROPOSAL_FILE}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(proposal, null, 2), 'utf-8');
  renameSync(tempPath, PROPOSAL_FILE);
}

// ─── Retraining trigger ───────────────────────────────────────────

export interface RetrainResult {
  retrained: false;
  reason?: string;
  proposal?: BoundaryProposal;
}

/**
 * Fit a validation-gated boundary proposal. This function never mutates live
 * boundaries, config, or ensemble state.
 */
export async function retrainIfNeeded(): Promise<RetrainResult> {
  const config = getConfig();
  const minSamples = config.feedback_loop.minSamplesPerTier;
  const data: LabeledScore[] = getFeedbackEntries()
    .filter(entry => entry.actualTier !== null && typeof entry.score === 'number' && Number.isFinite(entry.score) && entry.score >= 0 && entry.score <= 1)
    .map(entry => ({
      score: entry.score as number,
      tier: TIERS.indexOf(entry.actualTier as EffortLevel),
      id: entry.voteId ?? entry.promptHash ?? entry.id,
    }))
    .filter(row => row.tier >= 0);

  const underrepresented = TIERS.map((tier, index) => ({ tier, count: data.filter(row => row.tier === index).length }))
    .filter(({ count }) => count < minSamples);
  if (underrepresented.length > 0) {
    return {
      retrained: false,
      reason: `insufficient labeled+scored feedback for actual tiers: ${underrepresented.map(({ tier, count }) => `${tier}=${count}`).join(', ')}`,
    };
  }

  const { train, validation } = splitDeterministically(data);
  if (train.length < 6 || validation.length === 0) {
    return { retrained: false, reason: 'insufficient deterministic train/validation split' };
  }

  let optimized: ReturnType<typeof optimizeBoundaries>;
  try {
    optimized = optimizeBoundaries(train);
  } catch (error) {
    return { retrained: false, reason: error instanceof Error ? error.message : 'boundary optimization failed' };
  }
  if (!optimized) return { retrained: false, reason: 'insufficient distinct tier transitions to fit five boundaries' };

  const accuracyBefore = accuracyFor(getTierBoundaries(), validation);
  const accuracyAfter = accuracyFor(optimized.bounds, validation);
  if (accuracyAfter < accuracyBefore + MIN_VALIDATION_IMPROVEMENT) {
    return { retrained: false, reason: 'validation improvement below 2 percentage points' };
  }

  const proposal: BoundaryProposal = {
    boundaries: optimized.bounds,
    accuracyBefore,
    accuracyAfter,
    n: data.length,
    fittedAt: new Date().toISOString(),
  };
  writeProposal(proposal);
  return { retrained: false, proposal, reason: 'boundary proposal written; review required before applying' };
}
