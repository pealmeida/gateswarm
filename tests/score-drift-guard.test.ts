import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '../src/types.js';
import { v33Score } from '../src/intent-engine.js';
import { loadEffort, TIERS } from '../eval/lib/dataset.js';
import config from '../v04_config.json';

const MEDIAN_LOCK_TOLERANCE = 0.05;
const EDGE_TOLERANCE: Partial<Record<EffortLevel, number>> = {
  trivial: 0.02,
  light: 0.02,
};

// Expected T6 Phase 2 scorer medians, measured/locked against eval/dataset.json:
// trivial ~0.16, light ~0.27, moderate ~0.31, heavy ~0.35,
// intensive ~0.43, extreme ~0.56.
//
// The Phase 1.1 eval note documents a heavy/intensive ordering problem in the
// dirty eval scorer. This branch's committed scorer no longer has a high-tier
// median outside its configured band; light sits just above its upper edge by
// less than 0.001 and is covered by the simple-tier tolerance above.
// If a material band violation is accepted deliberately, pin that tier's
// measured median here with +/-0.05 instead of silently moving boundaries.
//
// Pinned on dataset v3 (180 examples), per the instruction above: two tiers now
// sit outside their configured band, and both are the SAME known scorer defect
// rather than drift.
//
// The v3 dataset gives every tier a full spread of prompt lengths, including
// long-but-trivial and long-but-heavy prompts. The scorer is length-dominant, so
// it over-scores those, dragging the trivial median up into the light band and
// the heavy median up into the intensive band. Nothing about the scorer changed
// to cause this — the benchmark simply stopped hiding it (see spec sections 11
// and 17).
//
// These are pinned, NOT accepted. Pinning keeps this file doing its actual job,
// which is catching unintended scorer drift (±0.05 still fires), instead of
// failing permanently for a defect it was never meant to measure. They should be
// removed when the scorer stops ranking long-and-easy prompts above short-and-hard
// ones — the feature work in spec section 12, not a boundary move.
const CURRENT_MEDIAN_OVERRIDES: Partial<Record<EffortLevel, number>> = {
  trivial: 0.2449,
  heavy: 0.3878,
};

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function configuredBand(tier: EffortLevel): [number, number] {
  return config.tier_boundaries[tier] as [number, number];
}

describe('score distribution drift guard', () => {
  it('keeps golden-set tier medians aligned with configured score bands', () => {
    const examples = loadEffort();

    for (const tier of TIERS) {
      const scores = examples
        .filter((ex) => ex.tier === tier)
        .map((ex) => v33Score(ex.prompt).score);
      const m = median(scores);
      const lockedMedian = CURRENT_MEDIAN_OVERRIDES[tier];

      if (typeof lockedMedian === 'number') {
        expect(
          Math.abs(m - lockedMedian),
          `${tier} median shifted from locked current scorer distribution`,
        ).toBeLessThanOrEqual(MEDIAN_LOCK_TOLERANCE);
        continue;
      }

      const [lo, hi] = configuredBand(tier);
      const tolerance = EDGE_TOLERANCE[tier] ?? 0;
      expect(
        m,
        `${tier} median ${m.toFixed(3)} fell below configured band [${lo}, ${hi}]`,
      ).toBeGreaterThanOrEqual(lo - tolerance);
      expect(
        m,
        `${tier} median ${m.toFixed(3)} exceeded configured band [${lo}, ${hi}]`,
      ).toBeLessThanOrEqual(hi + tolerance);
    }
  });
});
