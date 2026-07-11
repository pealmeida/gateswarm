import type { EffortExample } from './dataset.js';
import { TIERS } from './dataset.js';
import { mulberry32, seededShuffle } from './split.js';

/** Stratified sample: `n` examples per effort tier, deterministic for seed. */
export function samplePerTier(all: EffortExample[], n: number, seed: number): EffortExample[] {
  const rand = mulberry32(seed);
  const out: EffortExample[] = [];
  for (const tier of TIERS) {
    const pool = seededShuffle(all.filter((e) => e.tier === tier), rand);
    if (pool.length < n) {
      throw new Error(`tier ${tier} has only ${pool.length} prompts; need ${n}`);
    }
    out.push(...pool.slice(0, n));
  }
  return out;
}
