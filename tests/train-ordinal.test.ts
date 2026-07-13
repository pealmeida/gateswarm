import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertNoFrozenTestPromptCollisions,
  bootstrapExactDeltaCI,
  deduplicateTrainingRows,
  evaluateOrdinalGate,
  loadOrganicGoldVotes,
} from '../eval/train-ordinal.js';
import { encodeOrganicLabel } from '../src/organic-labels.js';

describe('evaluateOrdinalGate', () => {
  it('passes only when every holdout criterion is met', () => {
    expect(evaluateOrdinalGate({
      bootstrapExactDeltaLower: 0.01,
      ordinalAdjacent: 0.90,
      ordinalRecall: { trivial: 0.30, light: 0.30, moderate: 0.30, heavy: 0.30, intensive: 0.30, extreme: 0.30 },
      holdoutSupport: { trivial: 5, light: 5, moderate: 5, heavy: 5, intensive: 5, extreme: 5 },
      ordinalEce: 0.10,
    })).toEqual({ passed: true, reasons: [] });
  });

  it('reports every failed holdout criterion', () => {
    const result = evaluateOrdinalGate({
      bootstrapExactDeltaLower: 0,
      ordinalAdjacent: 0.89,
      ordinalRecall: { trivial: 0.29, light: 0.29, moderate: 0.29, heavy: 0.29, intensive: 0.29, extreme: 0.29 },
      holdoutSupport: { trivial: 5, light: 5, moderate: 5, heavy: 5, intensive: 5, extreme: 5 },
      ordinalEce: 0.11,
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(9);
  });

  it('uses a deterministic paired bootstrap CI for the exact-accuracy delta', () => {
    const heuristic = [
      { expected: 'light' as const, predicted: 'trivial' as const },
      { expected: 'light' as const, predicted: 'trivial' as const },
      { expected: 'light' as const, predicted: 'trivial' as const },
      { expected: 'light' as const, predicted: 'trivial' as const },
    ];
    const ordinal = [
      { expected: 'light' as const, predicted: 'light' as const },
      { expected: 'light' as const, predicted: 'light' as const },
      { expected: 'light' as const, predicted: 'light' as const },
      { expected: 'light' as const, predicted: 'light' as const },
    ];

    expect(bootstrapExactDeltaCI(heuristic, ordinal, 123, 1000)).toEqual(
      bootstrapExactDeltaCI(heuristic, ordinal, 123, 1000),
    );
    expect(bootstrapExactDeltaCI(heuristic, ordinal, 123, 1000).lower).toBeGreaterThan(0);
  });

  it('deduplicates normalized prompts and rejects frozen TEST prompt collisions', () => {
    const rows = deduplicateTrainingRows([
      { id: 'frozen:1', prompt: 'Explain   async/await', tier: 'moderate' },
      { id: 'organic:1', prompt: '  explain async/await ', tier: 'heavy' },
      { id: 'organic:2', prompt: 'Build a durable queue', tier: 'heavy' },
    ]);

    expect(rows.map((row) => row.id)).toEqual(['frozen:1', 'organic:2']);
    expect(() => assertNoFrozenTestPromptCollisions(rows, [
      { id: 'effort:test:1', prompt: 'BUILD a durable   queue' },
    ])).toThrow(/collides with frozen TEST row effort:test:1/);
  });

  it('loads only decodable organic labels and reports malformed and legacy rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateswarm-labels-'));
    const path = join(dir, 'labeled.jsonl');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      writeFileSync(path, [
        JSON.stringify({ promptSnippet: 'legacy row' }),
        '{not json}',
        encodeOrganicLabel({
          version: 1,
          ts: 1,
          promptHash: 'abc123',
          prompt: 'Keep this full prompt',
          promptSnippet: 'Keep this full prompt',
          predictedTier: 'heavy',
          actualTier: 'moderate',
          agreed: false,
          agentId: 'organic-test',
        }),
      ].join('\n') + '\n', 'utf-8');

      expect(loadOrganicGoldVotes(path)).toEqual([
        { id: 'organic:gold_vote:3', prompt: 'Keep this full prompt', tier: 'moderate' },
      ]);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(`organic labels ${path} row 1: legacy snippet-only row has no prompt field`));
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(`organic labels ${path} row 2: invalid JSON`));
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(`organic labels ${path}: skipped 1 legacy snippet-only rows without prompt`));
    } finally {
      errors.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
