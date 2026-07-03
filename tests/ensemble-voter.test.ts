/**
 * GateSwarm MoMA Router — Ensemble Voter unit tests
 *
 * Covers the convergence-critical behaviour of ensembleVote() and its helpers:
 *   - fallback path (no trained cascade) is the identity/heuristic-primary path
 *   - rawScore excludes history bias; finalScore includes it
 *   - weight normalization keeps historyBias additive (no score compression)
 *   - confidence tracks distance to the LIVE tier boundaries
 *   - RAG signal is optional (no neutral-0.5 injection when absent)
 *   - history bias is bounded and directionally correct
 *
 * The feedback store is mocked so history starts empty and deterministic;
 * tests that exercise bias push entries through recordInteraction().
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Controllable feedback source. getRecentEntries drives the voter's history
// buffer; default empty → history bias 0 unless a test injects interactions.
let mockRecentEntries: any[] = [];
vi.mock('../src/feedback-store.js', () => ({
  getRecentEntries: () => mockRecentEntries,
}));

import {
  ensembleVote,
  setEnsembleWeights,
  getEnsembleWeights,
  loadCascadeWeights,
  calcRagSignal,
  calcHistoryBias,
  recordInteraction,
  resetHistoryCache,
  cascadeAvailable,
} from '../src/ensemble-voter.js';
import { loadConfig } from '../src/v04-config.js';
import { setTierBoundaries, scoreToEffort } from '../src/intent-engine.js';

const DEFAULT_BOUNDS = [0.21, 0.28, 0.32, 0.37, 0.46];
const DEFAULT_WEIGHTS = { heuristic: 0.55, cascade: 0.0, ragSignal: 0.25, historyBias: 0.2 };

beforeAll(async () => {
  await loadConfig();
});

beforeEach(() => {
  // Restore module-level state so tests don't leak into each other.
  mockRecentEntries = [];
  resetHistoryCache();
  setTierBoundaries([...DEFAULT_BOUNDS]);
  // setEnsembleWeights normalizes; feed defaults so the multiplicative set is clean.
  setEnsembleWeights({ ...DEFAULT_WEIGHTS });
});

// ─── Fallback path (production default: no trained cascade) ──────────────────

describe('ensembleVote — fallback path (no cascade)', () => {
  it('uses heuristic-fallback method when cascade weights are absent', () => {
    const v = ensembleVote({ prompt: 'test', heuristicScore: 0.5 });
    expect(v.method).toBe('heuristic-fallback');
    expect(cascadeAvailable()).toBe(false);
  });

  it('passes the heuristic through unchanged when no RAG and no bias', () => {
    for (const h of [0.05, 0.3, 0.6, 0.9]) {
      const v = ensembleVote({ prompt: 'test', heuristicScore: h });
      expect(v.rawScore).toBeCloseTo(h, 5);
      expect(v.finalScore).toBeCloseTo(h, 5); // bias is 0 with empty history
    }
  });

  it('blends RAG as a 0.2 nudge when RAG context is present', () => {
    const h = 0.4;
    const rag = 0.9;
    const v = ensembleVote({ prompt: 'test', heuristicScore: h, ragSignal: rag });
    expect(v.rawScore).toBeCloseTo(h * 0.8 + rag * 0.2, 5);
  });

  it('does NOT inject a neutral 0.5 when RAG is absent', () => {
    // A bug the fix addressed: absent RAG must not add a flat 0.5 term.
    const v = ensembleVote({ prompt: 'test', heuristicScore: 0.2 });
    expect(v.components.ragSignal).toBe(0);
    expect(v.rawScore).toBeCloseTo(0.2, 5);
  });

  it('clamps scores into [0,1]', () => {
    const lo = ensembleVote({ prompt: 'x', heuristicScore: -5 });
    const hi = ensembleVote({ prompt: 'x', heuristicScore: 5 });
    expect(lo.finalScore).toBeGreaterThanOrEqual(0);
    expect(hi.finalScore).toBeLessThanOrEqual(1);
  });

  it('routes monotonically: higher heuristic never lowers the tier', () => {
    const tierIdx = (t: string) =>
      ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'].indexOf(t);
    let prev = -1;
    for (const h of [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.0]) {
      const idx = tierIdx(ensembleVote({ prompt: 'x', heuristicScore: h }).tier);
      expect(idx).toBeGreaterThanOrEqual(prev);
      prev = idx;
    }
  });

  it('assigns the tier from the calibrated boundaries', () => {
    const v = ensembleVote({ prompt: 'x', heuristicScore: 0.5 });
    expect(v.tier).toBe(scoreToEffort(v.finalScore));
  });

  it('never escalates (escalation removed in v0.5.2)', () => {
    for (const h of [0.22, 0.29, 0.33, 0.38]) {
      expect(ensembleVote({ prompt: 'x', heuristicScore: h }).escalated).toBe(false);
    }
  });
});

// ─── rawScore vs finalScore (feedback-loop decoupling) ───────────────────────

describe('ensembleVote — rawScore excludes history bias', () => {
  it('rawScore equals finalScore when bias is zero', () => {
    const v = ensembleVote({ prompt: 'x', heuristicScore: 0.35 });
    expect(v.rawScore).toBeCloseTo(v.finalScore, 5);
  });

  it('finalScore shifts by bias while rawScore stays put', () => {
    // Prime the buffer empty, then inject a systematically under-classified
    // history so bias goes positive. rawScore must remain the bias-free signal.
    calcHistoryBias();            // triggers empty load
    for (let i = 0; i < 10; i++) {
      recordInteraction({ promptTier: 'light', actualTier: 'heavy', adequacyScore: 0.9 });
    }
    const bias = calcHistoryBias();
    expect(bias).toBeGreaterThan(0);

    const h = 0.3;
    const v = ensembleVote({ prompt: 'x', heuristicScore: h });
    expect(v.rawScore).toBeCloseTo(h, 5);
    expect(v.finalScore).toBeCloseTo(Math.min(1, h + bias), 5);
    expect(v.components.historyBias).toBeCloseTo(bias, 5);
  });
});

// ─── Weight normalization (no score compression) ─────────────────────────────

describe('setEnsembleWeights — additive historyBias is not normalized', () => {
  it('normalizes only heuristic+cascade+ragSignal to sum 1', () => {
    setEnsembleWeights({ heuristic: 0.7, cascade: 0.0, ragSignal: 0.3, historyBias: 0.2 });
    const w = getEnsembleWeights();
    expect(w.heuristic + w.cascade + w.ragSignal).toBeCloseTo(1, 5);
  });

  it('leaves historyBias out of the normalization denominator', () => {
    // Pre-fix bug: including historyBias (0.2) in the sum compressed the
    // multiplicative weights to ~0.8x. Here heuristic alone must land at 1.0.
    setEnsembleWeights({ heuristic: 1.0, cascade: 0.0, ragSignal: 0.0, historyBias: 0.2 });
    const w = getEnsembleWeights();
    expect(w.heuristic).toBeCloseTo(1, 5);
  });

  it('ensemble path preserves full dynamic range (h=1 → score 1)', () => {
    loadCascadeWeights(new Array(15).fill(0.0), [...DEFAULT_BOUNDS]);
    try {
      setEnsembleWeights({ heuristic: 1.0, cascade: 0.0, ragSignal: 0.0, historyBias: 0.2 });
      const v = ensembleVote({ prompt: 'x', heuristicScore: 1.0 });
      expect(v.method).toBe('ensemble-v0.4');
      expect(v.rawScore).toBeCloseTo(1, 5);
    } finally {
      loadCascadeWeights([], [...DEFAULT_BOUNDS]); // unload so other tests keep fallback path
    }
  });
});

// ─── Confidence tracks LIVE boundaries ───────────────────────────────────────

describe('confidence — reads live tier boundaries', () => {
  it('is lower near a boundary than deep inside a band', () => {
    const nearBoundary = ensembleVote({ prompt: 'x', heuristicScore: 0.28 }).confidence; // on b1
    const deepInBand = ensembleVote({ prompt: 'x', heuristicScore: 0.9 }).confidence;
    expect(deepInBand).toBeGreaterThan(nearBoundary);
  });

  it('stays within [0.5, 0.95]', () => {
    for (const h of [0.0, 0.21, 0.28, 0.32, 0.37, 0.46, 0.6, 1.0]) {
      const c = ensembleVote({ prompt: 'x', heuristicScore: h }).confidence;
      expect(c).toBeGreaterThanOrEqual(0.5);
      expect(c).toBeLessThanOrEqual(0.95);
    }
  });

  it('changes for the same score after boundaries are retrained', () => {
    const before = ensembleVote({ prompt: 'x', heuristicScore: 0.3 }).confidence;
    setTierBoundaries([0.1, 0.2, 0.3, 0.4, 0.5]); // 0.3 now sits ON a boundary
    const after = ensembleVote({ prompt: 'x', heuristicScore: 0.3 }).confidence;
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeCloseTo(0.5, 5); // exactly on b2 → minimum confidence
  });
});

// ─── calcRagSignal ───────────────────────────────────────────────────────────

describe('calcRagSignal', () => {
  it('returns neutral 0.5 when no entries were retrieved', () => {
    expect(calcRagSignal({ retrievedEntries: [] })).toBe(0.5);
  });

  it('averages tier-complexity of retrieved entries', () => {
    const sig = calcRagSignal({
      retrievedEntries: [
        { tier: 'trivial', complexityAvg: 0, escalationHistory: false },
        { tier: 'extreme', complexityAvg: 0, escalationHistory: false },
      ],
    });
    expect(sig).toBeCloseTo((0.05 + 0.9) / 2, 5);
  });

  it('adds an escalation bonus when any entry escalated', () => {
    const base = calcRagSignal({
      retrievedEntries: [{ tier: 'moderate', complexityAvg: 0, escalationHistory: false }],
    });
    const bumped = calcRagSignal({
      retrievedEntries: [{ tier: 'moderate', complexityAvg: 0, escalationHistory: true }],
    });
    expect(bumped).toBeGreaterThan(base);
  });

  it('never exceeds 1', () => {
    const sig = calcRagSignal({
      retrievedEntries: [{ tier: 'extreme', complexityAvg: 0, escalationHistory: true }],
    });
    expect(sig).toBeLessThanOrEqual(1);
  });
});

// ─── calcHistoryBias ─────────────────────────────────────────────────────────

describe('calcHistoryBias', () => {
  it('is 0 with an empty history', () => {
    expect(calcHistoryBias()).toBe(0);
  });

  it('is 0 with too few interactions to be meaningful', () => {
    calcHistoryBias(); // load empty
    recordInteraction({ promptTier: 'light', actualTier: 'heavy', adequacyScore: 0.9 });
    recordInteraction({ promptTier: 'light', actualTier: 'heavy', adequacyScore: 0.9 });
    expect(calcHistoryBias()).toBe(0); // < 5 recent
  });

  it('biases UP when prompts are systematically under-classified', () => {
    calcHistoryBias();
    for (let i = 0; i < 10; i++) {
      recordInteraction({ promptTier: 'light', actualTier: 'extreme', adequacyScore: 0.9 });
    }
    expect(calcHistoryBias()).toBeGreaterThan(0);
  });

  it('biases DOWN when prompts are systematically over-classified', () => {
    calcHistoryBias();
    for (let i = 0; i < 10; i++) {
      recordInteraction({ promptTier: 'extreme', actualTier: 'light', adequacyScore: 0.9 });
    }
    expect(calcHistoryBias()).toBeLessThan(0);
  });

  it('is clamped to [-0.1, 0.1]', () => {
    calcHistoryBias();
    for (let i = 0; i < 50; i++) {
      recordInteraction({ promptTier: 'trivial', actualTier: 'extreme', adequacyScore: 0.1 });
    }
    const bias = calcHistoryBias();
    expect(bias).toBeGreaterThanOrEqual(-0.1);
    expect(bias).toBeLessThanOrEqual(0.1);
  });
});
