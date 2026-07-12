import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  boundaries: [0.91, 0.93, 0.95, 0.97, 0.99] as [number, number, number, number, number],
  entries: [] as Array<any>,
}));

vi.mock('../src/v04-config.js', () => ({
  getConfig: () => ({
    ensemble: { weights: { heuristic: 1, cascade: 0, ragSignal: 0, historyBias: 0 } },
    feedback_loop: { minSamplesPerTier: 1 },
  }),
}));
vi.mock('../src/feedback-store.js', () => ({ getFeedbackEntries: () => state.entries }));
vi.mock('../src/tier-boundaries.js', () => ({ getTierBoundaries: () => [...state.boundaries] }));

let dataDirectory: string | undefined;

afterEach(() => {
  delete process.env.MOMA_TRAINING_DATA_DIR;
  vi.resetModules();
  state.entries = [];
  state.boundaries = [0.91, 0.93, 0.95, 0.97, 0.99];
  if (dataDirectory) rmSync(dataDirectory, { recursive: true, force: true });
  dataDirectory = undefined;
});

function bruteAccuracy(data: Array<{ score: number; tier: number }>, bounds: number[]): number {
  return data.filter(row => {
    let prediction = 0;
    while (prediction < bounds.length && row.score >= bounds[prediction]) prediction++;
    return prediction === row.tier;
  }).length / data.length;
}

describe('boundary retraining proposals', () => {
  it('matches brute-force accuracy on a tiny candidate grid', async () => {
    const retraining = await import('../src/retraining.js');
    const data = [0, 1, 0, 1, 2, 3, 4, 5, 4, 5].map((tier, index) => ({ score: 0.05 + index * 0.09, tier }));
    const optimized = retraining.optimizeBoundaries(data);
    expect(optimized).not.toBeNull();

    const candidates = data.slice(0, -1).map((row, index) =>
      row.tier !== data[index + 1].tier ? (row.score + data[index + 1].score) / 2 : null,
    ).filter((value): value is number => value !== null);
    let bruteBest = 0;
    for (let a = 0; a < candidates.length; a++)
      for (let b = a + 1; b < candidates.length; b++)
        for (let c = b + 1; c < candidates.length; c++)
          for (let d = c + 1; d < candidates.length; d++)
            for (let e = d + 1; e < candidates.length; e++)
              bruteBest = Math.max(bruteBest, bruteAccuracy(data, [candidates[a], candidates[b], candidates[c], candidates[d], candidates[e]]));

    expect(optimized?.accuracy).toBe(bruteBest);
  });

  it('writes an accepted proposal without mutating live boundaries', async () => {
    dataDirectory = mkdtempSync(join(tmpdir(), 'gateswarm-proposal-'));
    process.env.MOMA_TRAINING_DATA_DIR = dataDirectory;
    for (let tier = 0; tier < 6; tier++) {
      for (let index = 0; index < 40; index++) {
        state.entries.push({
          id: `entry-${tier}-${index}`,
          promptHash: `prompt-${tier}-${index}`,
          score: 0.04 + tier * 0.15 + index / 100_000,
          actualTier: ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'][tier],
        });
      }
    }

    const retraining = await import('../src/retraining.js');
    const before = [...state.boundaries];
    const result = await retraining.retrainIfNeeded();

    expect(result.retrained).toBe(false);
    expect(result.proposal).toBeDefined();
    expect(state.boundaries).toEqual(before);
    const proposalPath = join(dataDirectory, 'boundary-proposal.json');
    expect(existsSync(proposalPath)).toBe(true);
    expect(JSON.parse(readFileSync(proposalPath, 'utf-8'))).toMatchObject({ n: 240, accuracyAfter: expect.any(Number) });
  });
});
