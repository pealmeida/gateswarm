import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  calibrateSilver,
  combineLabels,
  getCalibrationStats,
  getRagPhase,
  incrementInteractionCount,
  loadCalibrationState,
  resetCalibration,
  setCalibrationStoragePath,
} from '../src/label-combiner.js';
import { ragIndex, addRagEntry } from '../src/rag-index.js';
import { inferRagConsensus } from '../src/training-mode.js';

const TOKEN = 'silvercalibrationuniquetoken';
let temporaryDirectory: string | undefined;

function useTemporaryCalibrationStorage(): void {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'gateswarm-calibration-'));
  setCalibrationStoragePath(join(temporaryDirectory, 'calibration.json'));
  resetCalibration({ persist: false });
}

function addEntry(tier: string, provenance: 'routing' | 'gold' | 'judged'): void {
  addRagEntry({
    keywords: [TOKEN],
    tier,
    modelUsed: 'test/model',
    adequacyScore: 1,
    summary: 'calibration test entry',
    originalTokens: 1,
    compressedTokens: 1,
    provenance,
  });
}

function advanceToLowPhase(): void {
  for (let index = 0; index < 50; index++) incrementInteractionCount();
  expect(getRagPhase()).toBe('low');
}

afterEach(() => {
  for (let index = ragIndex.length - 1; index >= 0; index--) {
    if (ragIndex[index].keywords.includes(TOKEN)) ragIndex.splice(index, 1);
  }
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe('silver RAG calibration', () => {
  it('gates consensus during bootstrap while counting the eligible interaction once', () => {
    useTemporaryCalibrationStorage();
    addEntry('heavy', 'gold');
    addEntry('heavy', 'gold');
    addEntry('heavy', 'gold');

    expect(inferRagConsensus(TOKEN)).toBeNull();
    expect(getCalibrationStats().totalInteractions).toBe(1);
  });

  it('counts only canonical effort tiers with gold or judged provenance', () => {
    useTemporaryCalibrationStorage();
    advanceToLowPhase();
    addEntry('Q0', 'gold');
    addEntry('Q1', 'gold');
    addEntry('not-a-tier', 'judged');
    addEntry('heavy', 'routing');
    addEntry('heavy', 'routing');
    addEntry('heavy', 'routing');

    expect(inferRagConsensus(TOKEN)).toBeNull();

    addEntry('heavy', 'judged');
    addEntry('heavy', 'gold');
    addEntry('heavy', 'gold');
    expect(inferRagConsensus(TOKEN)).toBe('heavy');
  });

  it('multiplies source weight by clamped confidence and rejects non-finite labels', () => {
    useTemporaryCalibrationStorage();
    const combined = combineLabels([
      { tier: 'light', source: 'bronze', weight: 1, confidence: 0.2 },
      { tier: 'heavy', source: 'bronze', weight: 1, confidence: 0.8 },
    ]);

    expect(combined).toMatchObject({ tier: 'heavy', totalWeight: 0.5, confidence: 0.8 });
    expect(combineLabels([
      { tier: 'heavy', source: 'bronze', weight: 1, confidence: 4 },
    ])).toMatchObject({ totalWeight: 0.5 });
    expect(combineLabels([
      { tier: 'light', source: 'bronze', weight: 1, confidence: Number.NaN },
    ])).toBeNull();
  });

  it('persists and restores calibration counts, weights, interactions, and phase', () => {
    useTemporaryCalibrationStorage();
    for (let index = 0; index < 30; index++) calibrateSilver(index < 24);
    for (let index = 0; index < 200; index++) incrementInteractionCount();

    const before = getCalibrationStats();
    const file = join(temporaryDirectory!, 'calibration.json');
    const persisted = JSON.parse(readFileSync(file, 'utf-8'));
    expect(persisted).toMatchObject({
      silverAgreementCount: 24,
      silverTotalCompared: 30,
      totalInteractions: 200,
      ragPhase: 'full',
    });

    resetCalibration({ persist: false });
    expect(loadCalibrationState()).toBe(true);
    expect(getCalibrationStats()).toEqual(before);
  });
});
