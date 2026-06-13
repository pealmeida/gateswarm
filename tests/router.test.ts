import { describe, it, expect } from 'vitest';
import { ModelRouter } from '../src/router.js';
import type { DeviceProfile } from '../src/types.js';

const desktopProfile: DeviceProfile = {
  backend: 'webgpu',
  memoryGB: 8,
  isMobile: false,
  cores: 8,
  tier1Limit: 0.3,
  tier2Limit: 0.6,
  recommendedModels: {
    worker: 'Llama-3.2-3B-q4',
    gatekeeper: 'Qwen2.5-0.5B-q4',
  },
};

const mobileWasmProfile: DeviceProfile = {
  backend: 'wasm',
  memoryGB: 2,
  isMobile: true,
  cores: 4,
  tier1Limit: 0.15,
  tier2Limit: 0.35,
  recommendedModels: {
    worker: 'TinyLlama-1.1B-q4',
    gatekeeper: 'Qwen2.5-0.5B-q4',
  },
};

const lowEndProfile: DeviceProfile = {
  backend: 'wasm',
  memoryGB: 1,
  isMobile: true,
  cores: 2,
  tier1Limit: 0.1,
  tier2Limit: 0.2,
  recommendedModels: {
    worker: 'TinyLlama-1.1B-q4',
    gatekeeper: 'Qwen2.5-0.5B-q4',
  },
};

describe('ModelRouter (matrix-based)', () => {
  it('classifies desktop-high device', () => {
    const router = new ModelRouter(desktopProfile);
    expect(router.deviceClass).toBe('desktop-high');
  });

  it('classifies mobile-low device', () => {
    const router = new ModelRouter(mobileWasmProfile);
    expect(router.deviceClass).toBe('mobile-low');
  });

  it('classifies lowend device', () => {
    const router = new ModelRouter(lowEndProfile);
    expect(router.deviceClass).toBe('lowend');
  });

  it('routes trivial prompts to local model on desktop-high', () => {
    const router = new ModelRouter(desktopProfile);
    const decision = router.route(0.05);
    expect(decision.effort).toBe('trivial');
    expect(decision.deviceClass).toBe('desktop-high');
    expect(decision.estimatedCostCents).toBe(0); // local = free
  });

  it('routes heavy prompts correctly', () => {
    const router = new ModelRouter(desktopProfile);
    const decision = router.route(0.30);
    expect(decision.effort).toBe('heavy');
    expect(decision.score).toBe(0.30);
  });

  it('routes extreme to cloud on all devices', () => {
    const router = new ModelRouter(lowEndProfile);
    const decision = router.route(0.95);
    expect(decision.effort).toBe('extreme');
    expect(decision.estimatedCostCents).toBeGreaterThan(0);
  });

  it('lowend always routes to cloud', () => {
    const router = new ModelRouter(lowEndProfile);
    const trivial = router.route(0.05);
    const extreme = router.route(0.6);
    // lowend has cloudOverride=true for all efforts
    expect(trivial.estimatedCostCents).toBeGreaterThan(0);
    expect(extreme.estimatedCostCents).toBeGreaterThan(0);
  });

  it('includes effort level in decision', () => {
    const router = new ModelRouter(desktopProfile);
    expect(router.route(0.05).effort).toBe('trivial');
    expect(router.route(0.16).effort).toBe('light');
    expect(router.route(0.25).effort).toBe('moderate');
    expect(router.route(0.30).effort).toBe('heavy');
    expect(router.route(0.40).effort).toBe('intensive');
    expect(router.route(0.80).effort).toBe('extreme');
  });

  it('includes cost estimate in decision', () => {
    const router = new ModelRouter(desktopProfile);
    const local = router.route(0.1);
    const cloud = router.route(0.9);
    // Local should be free, cloud should cost
    expect(local.estimatedCostCents).toBe(0);
    expect(cloud.estimatedCostCents).toBeGreaterThan(0);
  });

  it('includes quality score in decision', () => {
    const router = new ModelRouter(desktopProfile);
    const decision = router.route(0.5);
    expect(decision.qualityScore).toBeGreaterThan(0);
    expect(decision.qualityScore).toBeLessThanOrEqual(1);
  });

  it('builds informative reason string', () => {
    const router = new ModelRouter(desktopProfile);
    const decision = router.route(0.25);
    expect(decision.reason).toContain('moderate');
    expect(decision.reason).toContain('desktop-high');
  });

  it('forceLocal sets all thresholds to 1.0', () => {
    const router = new ModelRouter(desktopProfile);
    router.forceLocal();
    expect(router.currentThresholds.tier1).toBe(1.0);
    expect(router.currentThresholds.tier2).toBe(1.0);
  });

  it('disableLocal sets thresholds to 0', () => {
    const router = new ModelRouter(desktopProfile);
    router.disableLocal();
    expect(router.currentThresholds.tier1).toBe(0);
    expect(router.currentThresholds.tier2).toBe(0);
  });

  it('allows threshold overrides', () => {
    const router = new ModelRouter(desktopProfile, { tier1: 0.5, tier2: 0.8 });
    expect(router.currentThresholds.tier1).toBe(0.5);
    expect(router.currentThresholds.tier2).toBe(0.8);
  });
});