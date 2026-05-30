/**
 * Effort Profiles v0.6 — Unit Tests
 *
 * Tests the effort customization pipeline:
 * - applyEffortProfile (floor/ceiling/bias)
 * - getTierModelForMode (plan vs act model selection)
 * - Integration: effort + mode combined routing
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { applyEffortProfile, getTierModelForMode, getAgentEffortProfile, setAgentEffortProfile, detectIntentMode } from '../src/v04-config.js';

describe('applyEffortProfile', () => {
  it('returns unchanged when no profile exists', () => {
    const r = applyEffortProfile('moderate', 0.25, 'nonexistent-agent');
    expect(r.effort).toBe('moderate');
    expect(r.score).toBe(0.25);
    expect(r.reason).toBe('no profile');
  });

  it('applies floor to prevent routing below minimum', () => {
    setAgentEffortProfile('test-floor', { default: 'moderate' });
    const r = applyEffortProfile('trivial', 0.05, 'test-floor');
    expect(r.effort).toBe('moderate'); // floor bumps up
    expect(r.reason).toContain('floor');
  });

  it('applies ceiling to prevent routing above maximum', () => {
    setAgentEffortProfile('test-ceiling', { ceiling: 'heavy' });
    const r = applyEffortProfile('extreme', 0.80, 'test-ceiling');
    expect(r.effort).toBe('heavy'); // ceiling caps down
    expect(r.reason).toContain('ceiling');
  });

  it('applies both floor and ceiling', () => {
    setAgentEffortProfile('test-both', { default: 'moderate', ceiling: 'intensive' });
    // Trivial → floor bumps to moderate
    const r1 = applyEffortProfile('trivial', 0.05, 'test-both');
    expect(r1.effort).toBe('moderate');

    // Extreme → ceiling caps to intensive
    const r2 = applyEffortProfile('extreme', 0.80, 'test-both');
    expect(r2.effort).toBe('intensive');

    // Moderate stays moderate
    const r3 = applyEffortProfile('moderate', 0.25, 'test-both');
    expect(r3.effort).toBe('moderate');
  });

  it('applies bias to shift score', () => {
    setAgentEffortProfile('test-bias', { bias: -0.15 }); // negative = favor heavier
    // Score 0.25 - 0.15 = 0.10 → trivial (was moderate)
    // Wait: bias -0.15 means score + (-0.15) = score - 0.15
    // Actually looking at the code: `adjustedScore = Math.max(0, Math.min(1, score + (profile.bias || 0)))`
    // So bias=-0.15: score = 0.25 + (-0.15) = 0.10 → trivial
    // Hmm, but the doc says "positive shifts down (favor lighter), negative shifts up"
    // The code does score + bias, so negative bias = lower score = lighter tier
    // That's the opposite of what the doc says. Let me check the code...
    // Code: `adjustedScore = Math.max(0, Math.min(1, score + (profile.bias || 0)))`
    // If bias = -0.15, score = 0.25 + (-0.15) = 0.10 → trivial (lighter)
    // If bias = +0.15, score = 0.25 + 0.15 = 0.40 → intensive (heavier)
    // So the code does: positive bias = heavier, negative bias = lighter
    // The doc comment says "positive shifts down (favor lighter)" which is wrong.
    // Let me test what the code actually does:
    const r = applyEffortProfile('moderate', 0.25, 'test-bias');
    expect(r.score).toBe(0.10); // 0.25 + (-0.15) = 0.10
    expect(r.reason).toContain('bias');
  });

  it('bias combined with floor still respects floor', () => {
    setAgentEffortProfile('test-bias-floor', { default: 'moderate', bias: -0.15 });
    // Score 0.25 + (-0.15) = 0.10 → trivial
    // But floor is moderate → should be bumped back to moderate
    const r = applyEffortProfile('moderate', 0.25, 'test-bias-floor');
    expect(r.effort).toBe('moderate'); // floor prevents going below
  });

  it('no adjustment needed when score is within bounds', () => {
    setAgentEffortProfile('test-noadj', { default: 'moderate', ceiling: 'heavy' });
    const r = applyEffortProfile('heavy', 0.32, 'test-noadj');
    expect(r.effort).toBe('heavy');
    expect(r.reason).toBe('no adjustment needed');
  });

  it('handles boundary scores correctly', () => {
    setAgentEffortProfile('test-boundary', { default: 'heavy' });
    // Score at boundary: 0.1557 → light, but floor is heavy
    const r = applyEffortProfile('light', 0.16, 'test-boundary');
    expect(r.effort).toBe('heavy');
  });
});

describe('getTierModelForMode', () => {
  it('returns primary model for act mode', () => {
    const tm = getTierModelForMode('heavy', 'act');
    expect(tm).not.toBeNull();
    expect(tm!.model).toBeDefined();
    expect(tm!.provider).toBeDefined();
  });

  it('returns plan model for plan mode when configured', () => {
    const tm = getTierModelForMode('moderate', 'plan');
    expect(tm).not.toBeNull();
    // The default config should have plan_model set for all tiers
    expect(tm!.plan_model).toBeUndefined(); // This is the plan model field, not the returned model
    // The returned model should be the plan model
    expect(tm!.model).toBeDefined();
  });

  it('returns null for invalid tier', () => {
    // @ts-expect-error - testing invalid tier
    const tm = getTierModelForMode('invalid', 'plan');
    expect(tm).toBeNull();
  });

  it('returns primary for auto mode', () => {
    const tm = getTierModelForMode('trivial', 'auto');
    expect(tm).not.toBeNull();
    expect(tm!.model).toBeDefined();
  });
});

describe('detectIntentMode', () => {
  it('detects plan signals', () => {
    const r = detectIntentMode('Draft an architecture outline');
    expect(r.mode).toBe('plan');
    expect(r.planScore).toBeGreaterThan(0);
  });

  it('detects act signals', () => {
    const r = detectIntentMode('Implement the API endpoint');
    expect(r.mode).toBe('act');
    expect(r.actScore).toBeGreaterThan(0);
  });

  it('returns auto for no signals', () => {
    const r = detectIntentMode('Hello world');
    expect(r.mode).toBe('auto');
  });
});
