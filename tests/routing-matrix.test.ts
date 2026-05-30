import { describe, it, expect } from 'vitest';
import {
  scoreToEffort,
  classifyDevice,
  lookupMatrix,
  getMatrixGrid,
  estimateSessionCost,
  EFFORT_RANGES,
  MODEL_INVENTORY,
  ROUTING_MATRIX,
} from '../src/routing-matrix.js';
import type { EffortLevel, DeviceProfileName } from '../src/routing-matrix.js';

describe('Routing Matrix', () => {
  // ─── scoreToEffort ──────────────────────────────────

  describe('scoreToEffort', () => {
    it('maps 0.0 → trivial', () => {
      expect(scoreToEffort(0.0)).toBe('trivial');
    });

    it('maps 0.05 → trivial', () => {
      expect(scoreToEffort(0.05)).toBe('trivial');
    });

    it('maps 0.25 → moderate', () => {
      expect(scoreToEffort(0.25)).toBe('moderate');
    });

    it('maps 0.40 → intensive', () => {
      expect(scoreToEffort(0.40)).toBe('intensive');
    });

    it('maps 0.60 → extreme', () => {
      expect(scoreToEffort(0.60)).toBe('extreme');
    });

    it('maps 0.80 → extreme', () => {
      expect(scoreToEffort(0.80)).toBe('extreme');
    });

    it('maps 1.0 → extreme', () => {
      expect(scoreToEffort(1.0)).toBe('extreme');
    });

    it('maps boundary values correctly', () => {
      // v3.6: updated for unified tier boundaries from v04_config.json
      expect(scoreToEffort(0.15)).toBe('trivial');   // < 0.1557
      expect(scoreToEffort(0.16)).toBe('light');     // 0.1557 ≤ x < 0.1842
      expect(scoreToEffort(0.20)).toBe('moderate');  // 0.1842 ≤ x < 0.2788
      expect(scoreToEffort(0.30)).toBe('heavy');     // 0.2788 ≤ x < 0.3488
      expect(scoreToEffort(0.40)).toBe('intensive'); // 0.3488 ≤ x < 0.4611
      expect(scoreToEffort(0.50)).toBe('extreme');   // ≥ 0.4611
    });
  });

  // ─── classifyDevice ─────────────────────────────────

  describe('classifyDevice', () => {
    it('classifies high-end desktop', () => {
      expect(classifyDevice('webgpu', 16, false)).toBe('desktop-high');
    });

    it('classifies mid-range desktop', () => {
      expect(classifyDevice('webgpu', 6, false)).toBe('desktop-mid');
    });

    it('classifies high-end mobile', () => {
      expect(classifyDevice('webgpu', 6, true)).toBe('mobile-high');
    });

    it('classifies low-end mobile', () => {
      expect(classifyDevice('wasm', 2, true)).toBe('mobile-low');
    });

    it('classifies low-end device', () => {
      expect(classifyDevice('wasm', 1, true)).toBe('lowend');
    });

    it('classifies WASM desktop as desktop-mid if enough RAM', () => {
      expect(classifyDevice('wasm', 8, false)).toBe('desktop-mid');
    });
  });

  // ─── lookupMatrix ───────────────────────────────────

  describe('lookupMatrix', () => {
    it('returns a cell for every effort × device combo', () => {
      const efforts: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
      const devices: DeviceProfileName[] = ['desktop-high', 'desktop-mid', 'mobile-high', 'mobile-low', 'lowend'];

      for (const effort of efforts) {
        for (const device of devices) {
          const cell = lookupMatrix(effort, device);
          expect(cell).toBeDefined();
          expect(cell.primaryModel).toBeTruthy();
          expect(cell.effort).toBe(effort);
          expect(cell.deviceProfile).toBe(device);
        }
      }
    });

    it('routes trivial desktop-high to local model', () => {
      const cell = lookupMatrix('trivial', 'desktop-high');
      expect(cell.cloudOverride).toBe(false);
      expect(cell.estimatedCostCents).toBe(0);
    });

    it('routes extreme to cloud on all devices', () => {
      const devices: DeviceProfileName[] = ['desktop-high', 'desktop-mid', 'mobile-high', 'mobile-low', 'lowend'];
      for (const device of devices) {
        const cell = lookupMatrix('extreme', device);
        expect(cell.cloudOverride).toBe(true);
        expect(cell.estimatedCostCents).toBeGreaterThan(0);
      }
    });

    it('lowend always uses cloud override', () => {
      const efforts: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
      for (const effort of efforts) {
        const cell = lookupMatrix(effort, 'lowend');
        expect(cell.cloudOverride).toBe(true);
      }
    });

    it('quality scores are between 0 and 1', () => {
      const grid = getMatrixGrid();
      for (const effort of Object.values(grid)) {
        for (const cell of Object.values(effort)) {
          expect(cell.qualityScore).toBeGreaterThan(0);
          expect(cell.qualityScore).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  // ─── Matrix Completeness ────────────────────────────

  describe('Matrix completeness', () => {
    it('has all 30 cells (6 efforts × 5 devices)', () => {
    expect(ROUTING_MATRIX.length).toBe(30);
  });

  it('every primary model exists in inventory', () => {
    for (const cell of ROUTING_MATRIX) {
      expect(MODEL_INVENTORY[cell.primaryModel]).toBeDefined();
    }
  });

  it('every fallback model exists in inventory', () => {
    for (const cell of ROUTING_MATRIX) {
      expect(MODEL_INVENTORY[cell.fallbackModel]).toBeDefined();
    }
  });
  });

  // ─── Cost Estimation ────────────────────────────────

  describe('estimateSessionCost', () => {
    it('estimates zero cost for all-local session', () => {
      const result = estimateSessionCost([
        { effort: 'trivial', deviceProfile: 'desktop-high', tokens: 500 },
        { effort: 'light', deviceProfile: 'desktop-high', tokens: 300 },
      ]);
      expect(result.totalCostCents).toBe(0);
      expect(result.localPct).toBe(100);
      expect(result.cloudPct).toBe(0);
    });

    it('estimates cost for mixed session', () => {
      const result = estimateSessionCost([
        { effort: 'trivial', deviceProfile: 'desktop-high', tokens: 500 },
        { effort: 'heavy', deviceProfile: 'desktop-high', tokens: 1000 },
        { effort: 'extreme', deviceProfile: 'desktop-high', tokens: 2000 },
      ]);
      expect(result.totalCostCents).toBeGreaterThan(0);
      expect(result.localPct).toBeGreaterThan(0);
      expect(result.cloudPct).toBeGreaterThan(0);
      expect(result.localPct + result.cloudPct).toBe(100);
    });
  });

  // ─── Matrix Visualization ───────────────────────────

  describe('getMatrixGrid', () => {
    it('returns 6 efforts × 5 devices', () => {
      const grid = getMatrixGrid();
      expect(Object.keys(grid).length).toBe(6);
      for (const effort of Object.values(grid)) {
        expect(Object.keys(effort).length).toBe(5);
      }
    });
  });
});
