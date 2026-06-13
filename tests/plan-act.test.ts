/**
 * GateSwarm v0.5.2 — Plan/Act Router Mode Tests
 *
 * Tests for detectIntentMode() and getTierModelForMode()
 * covering all 6 effort tiers and the three IntentMode values.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { detectIntentMode, getTierModelForMode, loadConfig } from '../src/v04-config.js';

// ─── detectIntentMode ────────────────────────────────────────────────────────

describe('detectIntentMode', () => {
  beforeAll(() => loadConfig());

  it('detects "plan" mode for "draft a roadmap"', () => {
    const result = detectIntentMode('draft a roadmap');
    expect(result.mode).toBe('plan');
    expect(result.planScore).toBeGreaterThanOrEqual(2);
  });

  it('detects "plan" mode for "outline the approach"', () => {
    const result = detectIntentMode('outline the approach');
    expect(result.mode).toBe('plan');
    expect(result.planScore).toBeGreaterThan(0);
  });

  it('detects "act" mode for "implement the feature"', () => {
    const result = detectIntentMode('implement the feature');
    expect(result.mode).toBe('act');
    expect(result.actScore).toBeGreaterThan(0);
  });

  it('detects "act" mode for "fix the bug and deploy"', () => {
    const result = detectIntentMode('fix the bug and deploy');
    expect(result.mode).toBe('act');
    expect(result.actScore).toBeGreaterThan(0);
  });

  it('returns mode "auto" with confidence 0 for "hello world"', () => {
    const result = detectIntentMode('hello world');
    expect(result.mode).toBe('auto');
    expect(result.confidence).toBe(0);
  });

  it('returns positive confidence for a mixed plan+act prompt', () => {
    const result = detectIntentMode('draft a roadmap, then implement the feature and deploy it');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.planScore).toBeGreaterThan(0);
    expect(result.actScore).toBeGreaterThan(0);
  });

  it('returns mode "auto" with confidence 0 for an empty string', () => {
    const result = detectIntentMode('');
    expect(result.mode).toBe('auto');
    expect(result.confidence).toBe(0);
    expect(result.planScore).toBe(0);
    expect(result.actScore).toBe(0);
  });

  it('is case-insensitive: "IMPLEMENT NOW" resolves to mode "act"', () => {
    const result = detectIntentMode('IMPLEMENT NOW');
    expect(result.mode).toBe('act');
    expect(result.actScore).toBeGreaterThan(0);
  });
});

// ─── getTierModelForMode ─────────────────────────────────────────────────────

describe('getTierModelForMode', () => {
  beforeAll(() => loadConfig());

  it('mode "act" on any tier returns the default (non-plan) model', () => {
    const tiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;
    for (const tier of tiers) {
      const actResult = getTierModelForMode(tier, 'act');
      const defaultResult = getTierModelForMode(tier, 'auto');
      expect(actResult).not.toBeNull();
      expect(defaultResult).not.toBeNull();
      // act mode and auto mode should both return the default tier model (same model field)
      expect(actResult!.model).toBe(defaultResult!.model);
    }
  });

  it('mode "plan" on heavy returns plan_model "cx/gpt-5.5-codex" and plan_enable_thinking false', () => {
    const result = getTierModelForMode('heavy', 'plan');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('cx/gpt-5.5-codex');
    expect(result!.enable_thinking).toBe(false);
  });

  it('mode "plan" on extreme returns plan_model and plan_enable_thinking true', () => {
    const result = getTierModelForMode('extreme', 'plan');
    expect(result).not.toBeNull();
    expect(result!.model).toBeTruthy();
    expect(result!.enable_thinking).toBe(true);
  });

  it('mode "auto" falls back to the default (act) model', () => {
    const tiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;
    for (const tier of tiers) {
      const autoResult = getTierModelForMode(tier, 'auto');
      const actResult = getTierModelForMode(tier, 'act');
      expect(autoResult).not.toBeNull();
      expect(actResult).not.toBeNull();
      expect(autoResult!.model).toBe(actResult!.model);
      expect(autoResult!.max_tokens).toBe(actResult!.max_tokens);
    }
  });

  it('plan model max_tokens <= act model max_tokens for trivial, light, moderate, and heavy', () => {
    const tiers = ['trivial', 'light', 'moderate', 'heavy'] as const;
    for (const tier of tiers) {
      const planResult = getTierModelForMode(tier, 'plan');
      const actResult = getTierModelForMode(tier, 'act');
      expect(planResult).not.toBeNull();
      expect(actResult).not.toBeNull();
      expect(planResult!.max_tokens).toBeLessThanOrEqual(actResult!.max_tokens);
    }
  });

  it('plan_enable_thinking is false for trivial through intensive tiers', () => {
    const tiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive'] as const;
    for (const tier of tiers) {
      const result = getTierModelForMode(tier, 'plan');
      expect(result).not.toBeNull();
      expect(result!.enable_thinking).toBe(false);
    }
  });

  it('invalid tier returns null', () => {
    const result = getTierModelForMode('nonexistent' as any, 'act');
    expect(result).toBeNull();
  });

  it('plan_provider is set for all tiers that have plan_model', () => {
    const tiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;
    for (const tier of tiers) {
      const result = getTierModelForMode(tier, 'plan');
      // Every tier in the loaded config has a plan_model, so provider must be defined and non-empty
      expect(result).not.toBeNull();
      expect(result!.provider).toBeTruthy();
    }
  });
});
