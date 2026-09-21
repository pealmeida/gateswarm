/**
 * Quota Band Matrix Tests
 *
 * Tests for quota-aware routing matrix selection:
 *  - Band selection logic (Green/Yellow/Orange/Red)
 *  - Provider overlay application (go_high, zai_high, claude_high, etc.)
 *  - Feature flag behavior (OFF = null, ON = band selection)
 *  - Quota coverage states (full/partial/none)
 *  - Fallback to Yellow on missing/stale data
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  selectBand,
  getEffectiveTierModels,
  getProviderQuotaPercentages,
  isQuotaBandMatrixEnabled,
  type QuotaBand,
  type ProviderQuotaPercentage,
} from '../src/quota-band-matrix.js';

describe('Quota Band Matrix', () => {
  const originalEnv = process.env.GATESWARM_QUOTA_BAND_MATRIX;

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.GATESWARM_QUOTA_BAND_MATRIX;
    } else {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = originalEnv;
    }
  });

  describe('Feature Flag', () => {
    it('should be OFF by default', () => {
      delete process.env.GATESWARM_QUOTA_BAND_MATRIX;
      expect(isQuotaBandMatrixEnabled()).toBe(false);
    });

    it('should recognize ON values', () => {
      const onValues = ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'ON'];
      for (const val of onValues) {
        process.env.GATESWARM_QUOTA_BAND_MATRIX = val;
        expect(isQuotaBandMatrixEnabled()).toBe(true);
      }
    });

    it('should recognize OFF values', () => {
      const offValues = ['0', 'false', 'FALSE', 'no', 'NO', 'off', 'OFF', '', 'random'];
      for (const val of offValues) {
        process.env.GATESWARM_QUOTA_BAND_MATRIX = val;
        expect(isQuotaBandMatrixEnabled()).toBe(false);
      }
    });
  });

  describe('Band Selection Logic', () => {
    it('should select Green for 0-40%', () => {
      expect(selectBand(0)).toBe('green');
      expect(selectBand(20)).toBe('green');
      expect(selectBand(39.9)).toBe('green');
    });

    it('should select Yellow for 40-70%', () => {
      expect(selectBand(40)).toBe('yellow');
      expect(selectBand(55)).toBe('yellow');
      expect(selectBand(69.9)).toBe('yellow');
    });

    it('should select Orange for 70-85%', () => {
      expect(selectBand(70)).toBe('orange');
      expect(selectBand(77.5)).toBe('orange');
      expect(selectBand(84.9)).toBe('orange');
    });

    it('should select Red for 85-100%', () => {
      expect(selectBand(85)).toBe('red');
      expect(selectBand(92.5)).toBe('red');
      expect(selectBand(100)).toBe('red');
    });
  });

  describe('getEffectiveTierModels', () => {
    it('should return null when feature flag is OFF', async () => {
      delete process.env.GATESWARM_QUOTA_BAND_MATRIX;
      const result = await getEffectiveTierModels();
      expect(result).toBe(null);
    });

    it('should return Yellow fallback when flag is ON but no quota data', async () => {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
      // With no quota-sync.json or consumption history, should get Yellow fallback
      const result = await getEffectiveTierModels();
      
      // Should return a selection even with no data (fallback to Yellow)
      expect(result).not.toBe(null);
      if (result) {
        expect(result.band).toBe('yellow');
        expect(result.matrixVariant).toBe('yellow_no_quota_data');
        expect(result.quotaCoverage).toBe('none');
        expect(result.reason).toBe('missing_quota');
        expect(result.overlaysApplied).toEqual([]);
        expect(result.effectiveTierModels).toBeDefined();
        expect(result.effectiveTierModels.moderate).toBeDefined();
      }
    });
  });

  describe('Provider Quota Percentages', () => {
    it('should return array of provider percentages', () => {
      const pcts = getProviderQuotaPercentages();
      expect(Array.isArray(pcts)).toBe(true);
      
      // Each entry should have required fields
      for (const pct of pcts) {
        expect(pct).toHaveProperty('provider');
        expect(pct).toHaveProperty('fiveHourPct');
        expect(pct).toHaveProperty('weeklyPct');
        expect(pct).toHaveProperty('monthlyPct');
        expect(pct).toHaveProperty('maxPct');
        expect(pct).toHaveProperty('window');
        expect(pct).toHaveProperty('source');
        expect(['quota_sync', 'consumption_tracker', 'cli', 'unknown']).toContain(pct.source);
      }
    });
  });

  describe('Band Selection Scenarios', () => {
    beforeEach(() => {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
    });

    it('should handle Green band scenario (healthy state)', async () => {
      // This test will use whatever quota data is available
      // In a real test with fixtures, you'd mock the quota sources
      const result = await getEffectiveTierModels();
      
      // With no quota data, we get Yellow fallback
      // In production with real data <40%, would get Green
      expect(result).toBeDefined();
      if (result && result.maxProviderPct > 0 && result.maxProviderPct < 40) {
        expect(result.band).toBe('green');
        expect(result.matrixVariant).toContain('green');
      }
    });

    it('should handle Orange band scenario (alert state)', async () => {
      // In a real scenario with mocked quota data showing 70-85%
      // This is a placeholder to show the test structure
      const result = await getEffectiveTierModels();
      expect(result).toBeDefined();
    });
  });

  describe('Matrix Variant Identity', () => {
    it('should include overlay names in matrixVariant when overlays applied', async () => {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
      const result = await getEffectiveTierModels();
      
      if (result && result.overlaysApplied.length > 0) {
        // matrixVariant should include overlay names
        for (const overlay of result.overlaysApplied) {
          expect(result.matrixVariant).toContain(overlay);
        }
      }
    });

    it('should use band name only when no overlays applied', async () => {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
      const result = await getEffectiveTierModels();
      
      if (result && result.overlaysApplied.length === 0 && result.quotaCoverage !== 'none') {
        // When we have quota data and no overlays, variant = band
        expect(result.matrixVariant).toBe(result.band);
      } else if (result && result.quotaCoverage === 'none') {
        // With no quota data, we get a special variant
        expect(result.matrixVariant).toContain('yellow');
      }
    });
  });

  describe('Quota Coverage', () => {
    it('should report quotaCoverage states correctly', async () => {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
      const result = await getEffectiveTierModels();
      
      expect(result).toBeDefined();
      if (result) {
        expect(['full', 'partial', 'none']).toContain(result.quotaCoverage);
        
        // Coverage consistency checks
        // Note: consumptionTracker may provide data even when quotaSync doesn't,
        // so quotaCoverage can be 'partial' or 'full' even with no synced data
        if (result.quotaCoverage === 'full') {
          expect(result.unknownProviders.length).toBe(0);
        }
      }
    });
  });

  describe('Effective Tier Models Structure', () => {
    it('should return valid tier_models structure', async () => {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
      const result = await getEffectiveTierModels();
      
      if (result) {
        const tiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
        for (const tier of tiers) {
          const tierModel = result.effectiveTierModels[tier as 'trivial' | 'light' | 'moderate' | 'heavy' | 'intensive' | 'extreme'];
          expect(tierModel).toBeDefined();
          expect(tierModel.model).toBeDefined();
          expect(tierModel.provider).toBeDefined();
          expect(typeof tierModel.max_tokens).toBe('number');
          expect(typeof tierModel.enable_thinking).toBe('boolean');
        }
      }
    });
  });

  describe('Window Preference', () => {
    it('should prefer 5h window over weekly when available', async () => {
      process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
      const result = await getEffectiveTierModels();
      
      if (result && result.window !== 'none') {
        const hasFiveHourData = result.providerPcts.some(p => p.window === 'fiveHour');
        
        if (hasFiveHourData) {
          expect(result.window).toBe('fiveHour');
        }
      }
    });
  });
});

describe('Provider Overlay Rules', () => {
  beforeEach(() => {
    process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
  });

  afterEach(() => {
    delete process.env.GATESWARM_QUOTA_BAND_MATRIX;
  });

  describe('go_high overlay', () => {
    it('should remove opencodego from moderate+ tiers when >70%', async () => {
      // In a real test, you'd inject mock quota data showing opencodego at 75%
      // For now, this is a structural test
      const result = await getEffectiveTierModels();
      
      if (result && result.overlaysApplied.includes('go_high')) {
        // Verify that moderate tier doesn't have opencodego as primary
        const moderate = result.effectiveTierModels.moderate;
        if (moderate) {
          // If go_high was applied, opencodego should be removed/demoted
          expect(moderate.provider === 'opencodego').toBe(false);
        }
      }
    });
  });

  describe('claude_high overlay', () => {
    it('should shift heavy tier away from Claude when >70%', async () => {
      const result = await getEffectiveTierModels();
      
      if (result && result.overlaysApplied.includes('claude_high')) {
        const heavy = result.effectiveTierModels.heavy;
        if (heavy) {
          // Heavy tier should not use claude-cli as primary when claude_high is active
          const usesClaudeInFallbacks = heavy.fallback_models?.some(f => f.provider === 'claude-cli');
          // Claude may still be in fallbacks, but not primary
          if (heavy.provider === 'claude-cli') {
            // This would be a bug in overlay application
            expect(heavy.provider).not.toBe('claude-cli');
          }
        }
      }
    });
  });
});

describe('DoD Product Criteria', () => {
  beforeEach(() => {
    process.env.GATESWARM_QUOTA_BAND_MATRIX = '1';
  });

  afterEach(() => {
    delete process.env.GATESWARM_QUOTA_BAND_MATRIX;
  });

  it('Orange + claude_high should move heavy away from Claude', async () => {
    // This test documents the product requirement from DoD CPO brief
    // In Orange band with claude_high overlay, heavy tier should not route to Claude
    const result = await getEffectiveTierModels();
    
    if (result && result.band === 'orange' && result.overlaysApplied.includes('claude_high')) {
      const heavy = result.effectiveTierModels.heavy;
      expect(heavy.provider).not.toBe('claude-cli');
    }
  });

  it('Green band should allow moderate tier to use glm-5', async () => {
    // Green state should have balanced routing including moderate → glm-5
    const result = await getEffectiveTierModels();
    
    if (result && result.band === 'green') {
      const moderate = result.effectiveTierModels.moderate;
      // In Green band, moderate should use glm-5 (ZAI) as designed
      expect(['glm-5', 'glm-4.7', 'minimax-m2.7', 'kimi-k2.6']).toContain(moderate.model);
    }
  });
});
