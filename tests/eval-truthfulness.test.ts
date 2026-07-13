import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asEffort } from '../eval/hybrid-routing-eval.js';
import { evaluateHybridExitVerdict } from '../eval/lib/hybrid-verdict.js';
import { assertSplitVersionDoesNotExist } from '../eval/split.js';

describe('hybrid eval truthfulness', () => {
  it('treats an unknown score tier as an infrastructure failure instead of moderate', () => {
    expect(asEffort('heavy')).toBe('heavy');
    expect(asEffort('not-a-tier')).toBeNull();
    expect(asEffort(undefined)).toBeNull();
  });

  it('requires every release floor and emits itemized failures', () => {
    const verdict = evaluateHybridExitVerdict({
      offline: { ok: true, fails: [] },
      criticalProbes: [{ prompt: 'hi', pass: false }],
      rubricPass: 0,
      rubricFloor: 1,
      judgeAvailable: 0,
      scoredLive: 0,
      sampledLive: 10,
      judgeMean: Number.NaN,
      judgeOverallFloor: 3.5,
      judgeByTier: { heavy: { n: 1, mean: 2.5 } },
      judgePerTierFloor: 3,
      liveCoverageFloor: 0.7,
      judgeAvailabilityFloor: 0.8,
      offlineInfraFailures: 2,
      offlineScored: 8,
      offlineInfraFailureCeiling: 0.1,
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('critical probe failed'),
      expect.stringContaining('rubric'),
      expect.stringContaining('judge availability'),
      expect.stringContaining('judge adequacy[heavy]'),
      expect.stringContaining('live coverage'),
      expect.stringContaining('offline infrastructure failures'),
    ]));
  });
});

describe('frozen split generation', () => {
  it('refuses to overwrite any artifact for an existing split version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateswarm-split-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'holdout.v1.json'), '{}');
      expect(() => assertSplitVersionDoesNotExist(dir, 'v1')).toThrow(/Bump VERSION/);
      expect(existsSync(join(dir, 'holdout.v1.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
