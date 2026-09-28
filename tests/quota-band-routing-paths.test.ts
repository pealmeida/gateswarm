/**
 * PR A: gateway paths use quota-band effective tier config when flag ON,
 * and remain byte-identical to static v04_config when flag OFF.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getEffectiveTierModels,
} from '../src/quota-band-matrix.js';
import { consumptionIntelligence } from '../src/consumption-intelligence.js';
import { quotaSync } from '../src/quota-sync.js';
import {
  consumptionTracker,
  type ConsumptionReport,
  type WindowConsumption,
} from '../src/consumption-tracker.js';
import {
  allowedModelsInTierRow,
  fallbackModelsForTier,
  resolveTierModelForMode,
  tierModelForMode,
} from '../src/routing-tier-config.js';
import { getConfig, getTierModelForMode, loadConfig } from '../src/v04-config.js';
import type { EffortLevel } from '../src/types.js';
import type { QuotaBand } from '../src/quota-band-matrix.js';

const MATRICES = JSON.parse(
  readFileSync(join(process.cwd(), 'calibration/matrix-variants/quota_band_matrices.json'), 'utf-8'),
);

const originalEnv = process.env.GATESWARM_QUOTA_BAND_MATRIX;

function emptyWindowConsumption(): WindowConsumption {
  const now = Date.now();
  return {
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    totalTokens: 0,
    cost: 0,
    errors: 0,
    avgLatencyMs: 0,
    windowMs: 0,
    windowStart: now,
    windowEnd: now,
    hoursCovered: 0,
  };
}

function emptyConsumptionReport(): ConsumptionReport {
  const window = emptyWindowConsumption();
  return {
    generatedAt: Date.now(),
    totalProviders: 0,
    totalFiveHour: window,
    totalWeekly: window,
    totalMonthly: window,
    providers: [],
  };
}

function mockQuotaSyncFixture(maxPct: number): void {
  vi.spyOn(quotaSync, 'getRealQuotaData').mockReturnValue({
    zai: {
      fiveHourUsedPct: maxPct,
      weeklyUsedPct: maxPct,
      monthlyUsedPct: null,
      syncedAt: new Date().toISOString(),
    },
  });
  vi.spyOn(consumptionTracker, 'buildReport').mockReturnValue(emptyConsumptionReport());
}

function bandPct(band: QuotaBand): number {
  switch (band) {
    case 'green':
      return 25;
    case 'yellow':
      return 55;
    case 'orange':
      return 75;
    case 'red':
      return 90;
    default: {
      const _exhaustive: never = band;
      return _exhaustive;
    }
  }
}

describe('quota-band routing paths (routing-tier-config)', () => {
  beforeEach(() => {
    loadConfig();
  });

  afterEach(() => {
    consumptionIntelligence.invalidateQuotaBandCache();
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env.GATESWARM_QUOTA_BAND_MATRIX;
    } else {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = originalEnv;
    }
  });

  describe('flag OFF (regression)', () => {
    beforeEach(() => {
      delete process.env.GATESWARM_QUOTA_BAND_MATRIX;
    });

    it('resolveTierModelForMode matches getTierModelForMode for act and plan', async () => {
      const tiers: EffortLevel[] = ['moderate', 'heavy', 'extreme'];
      for (const tier of tiers) {
        for (const mode of ['act', 'plan', 'auto'] as const) {
          const expected = getTierModelForMode(tier, mode);
          const { resolved, staticResolved } = await resolveTierModelForMode(tier, mode);
          expect(resolved).toEqual(expected);
          expect(staticResolved).toBeNull();
        }
      }
    });

    it('fallbackModelsForTier uses static v04_config fallbacks', () => {
      const cfg = getConfig();
      const fallbacks = fallbackModelsForTier('heavy', cfg.tier_models, null);
      expect(fallbacks).toEqual(cfg.tier_models.heavy.fallback_models);
    });
  });

  describe('flag ON per band', () => {
    beforeEach(() => {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
    });

    for (const band of ['green', 'yellow', 'orange', 'red'] as QuotaBand[]) {
      it(`getEffectiveTierModels selects ${band} matrix for moderate`, async () => {
        mockQuotaSyncFixture(bandPct(band));
        const selection = await getEffectiveTierModels();
        expect(selection).not.toBeNull();
        expect(selection!.band).toBe(band);
        const moderate = selection!.effectiveTierModels.moderate;
        const baseModerate = MATRICES.bands[band].tier_models.moderate;
        if (band === 'orange' && selection!.overlaysApplied.length > 0) {
          // Provider overlays may demote primary away from the raw band matrix row.
          const allowed = allowedModelsInTierRow(moderate);
          expect(allowed.has(`${moderate.provider}/${moderate.model}`)).toBe(true);
        } else {
          expect(moderate.model).toBe(baseModerate.model);
          expect(moderate.provider).toBe(baseModerate.provider);
        }
      });
    }

    it('yellow_no_quota_data when flag ON and no quota readings', async () => {
      vi.spyOn(quotaSync, 'getRealQuotaData').mockReturnValue({});
      vi.spyOn(consumptionTracker, 'buildReport').mockReturnValue(emptyConsumptionReport());
      const selection = await getEffectiveTierModels();
      expect(selection?.matrixVariant).toBe('yellow_no_quota_data');
      expect(selection?.band).toBe('yellow');
      expect(selection?.reason).toBe('missing_quota');
    });

    it('red band plan mode uses effective plan_model', async () => {
      mockQuotaSyncFixture(90);
      consumptionIntelligence.invalidateQuotaBandCache();
      const selection = await getEffectiveTierModels();
      const moderate = selection!.effectiveTierModels.moderate;
      const { resolved, staticResolved } = await resolveTierModelForMode('moderate', 'plan');
      const expectedPlan = tierModelForMode(moderate, 'plan');
      expect(resolved?.model).toBe(expectedPlan.model);
      expect(resolved?.provider).toBe(expectedPlan.provider);
      expect(staticResolved?.model).toBe(getTierModelForMode('moderate', 'plan')?.model);
    });

    it('fallback list only contains models allowed in the effective tier row', async () => {
      mockQuotaSyncFixture(90);
      const selection = await getEffectiveTierModels();
      const heavy = selection!.effectiveTierModels.heavy;
      const allowed = allowedModelsInTierRow(heavy);
      const cfg = getConfig();
      const fallbacks = fallbackModelsForTier('heavy', cfg.tier_models, heavy);
      for (const fb of fallbacks) {
        expect(allowed.has(`${fb.provider}/${fb.model}`)).toBe(true);
      }
      expect(allowed.has(`${heavy.provider}/${heavy.model}`)).toBe(true);
    });
  });
});
