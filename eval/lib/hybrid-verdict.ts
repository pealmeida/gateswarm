import type { EffortLevel } from '../../src/types.js';
import { TIERS } from './dataset.js';

export interface HybridExitVerdictInput {
  offline: { ok: boolean; fails: string[] };
  criticalProbes: Array<{ prompt: string; pass: boolean }>;
  rubricPass: number;
  rubricFloor: number;
  judgeAvailable: number;
  scoredLive: number;
  sampledLive: number;
  judgeMean: number;
  judgeOverallFloor: number;
  judgeByTier: Partial<Record<EffortLevel, { mean: number; n: number }>>;
  judgePerTierFloor: number;
  liveCoverageFloor: number;
  judgeAvailabilityFloor: number;
  offlineInfraFailures: number;
  offlineScored: number;
  offlineInfraFailureCeiling: number;
}

export interface HybridExitVerdict {
  passed: boolean;
  reasons: string[];
}

/** Release verdict: every documented online and offline safety floor must pass. */
export function evaluateHybridExitVerdict(input: HybridExitVerdictInput): HybridExitVerdict {
  const reasons: string[] = [];
  if (!input.offline.ok) reasons.push(...input.offline.fails.map((reason) => `offline: ${reason}`));

  for (const probe of input.criticalProbes) {
    if (!probe.pass) reasons.push(`critical probe failed: ${probe.prompt}`);
  }
  if (input.rubricPass < input.rubricFloor) {
    reasons.push(`rubric ${input.rubricPass}/${input.scoredLive} below floor ${input.rubricFloor}/${input.scoredLive}`);
  }

  const judgeAvailability = input.scoredLive ? input.judgeAvailable / input.scoredLive : 0;
  if (judgeAvailability < input.judgeAvailabilityFloor) {
    reasons.push(`judge availability ${(judgeAvailability * 100).toFixed(1)}% below ${(input.judgeAvailabilityFloor * 100).toFixed(1)}%`);
  }
  if (!Number.isFinite(input.judgeMean) || input.judgeMean < input.judgeOverallFloor) {
    reasons.push(`judge mean ${Number.isFinite(input.judgeMean) ? input.judgeMean.toFixed(2) : 'n/a'} below ${input.judgeOverallFloor.toFixed(2)}`);
  }
  for (const tier of TIERS) {
    const tierJudge = input.judgeByTier[tier];
    if (tierJudge && tierJudge.n > 0 && (!Number.isFinite(tierJudge.mean) || tierJudge.mean < input.judgePerTierFloor)) {
      reasons.push(`judge adequacy[${tier}] ${Number.isFinite(tierJudge.mean) ? tierJudge.mean.toFixed(2) : 'n/a'} below ${input.judgePerTierFloor.toFixed(2)}`);
    }
  }

  const liveCoverage = input.sampledLive ? input.scoredLive / input.sampledLive : 0;
  if (liveCoverage < input.liveCoverageFloor) {
    reasons.push(`live coverage ${(liveCoverage * 100).toFixed(1)}% below ${(input.liveCoverageFloor * 100).toFixed(1)}%`);
  }

  const offlineTotal = input.offlineScored + input.offlineInfraFailures;
  const infraFailureRate = offlineTotal ? input.offlineInfraFailures / offlineTotal : 1;
  if (infraFailureRate > input.offlineInfraFailureCeiling) {
    reasons.push(`offline infrastructure failures ${(infraFailureRate * 100).toFixed(1)}% exceed ${(input.offlineInfraFailureCeiling * 100).toFixed(1)}%`);
  }

  return { passed: reasons.length === 0, reasons };
}
