/**
 * v0.5.2 assertiveness regression tests — lock in the classifier + training fixes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { scoreToEffort, setTierBoundaries, getTierBoundaries } from '../src/intent-engine.js';
import { detectIntentMode } from '../src/v04-config.js';
import { scoreIntent } from '../src/intent-engine-v04.js';

describe('config-driven tier boundaries', () => {
  const original = getTierBoundaries();
  afterAll(() => setTierBoundaries(original));

  it('rejects wrong length', () => {
    expect(setTierBoundaries([0.1, 0.2, 0.3])).toBe(false);
  });
  it('rejects non-monotonic', () => {
    expect(setTierBoundaries([0.3, 0.2, 0.4, 0.5, 0.6])).toBe(false);
  });
  it('rejects out-of-range', () => {
    expect(setTierBoundaries([0.1, 0.2, 0.3, 0.4, 1.2])).toBe(false);
  });
  it('accepts valid monotonic boundaries and scoreToEffort reflects them live', () => {
    expect(setTierBoundaries([0.10, 0.20, 0.30, 0.40, 0.50])).toBe(true);
    expect(scoreToEffort(0.05)).toBe('trivial');
    expect(scoreToEffort(0.15)).toBe('light');
    expect(scoreToEffort(0.55)).toBe('extreme');
  });
});

describe('mode detection — natural act/plan intent (no literal keywords)', () => {
  it('detects act from a bug/symptom report', () => {
    expect(detectIntentMode('the login button throws a 500 error').mode).toBe('act');
  });
  it('detects act from a leading imperative', () => {
    expect(detectIntentMode('add a dark mode toggle to the settings page').mode).toBe('act');
  });
  it('detects plan from deliberation phrasing', () => {
    expect(detectIntentMode('not sure how to structure the auth layer, what are the options').mode).toBe('plan');
  });
  it('stays auto on neutral/ambiguous input', () => {
    const r = detectIntentMode('the user model');
    expect(r.mode).toBe('auto');
    expect(r.confidence).toBe(0);
  });
});

describe('effort scoring — ordering + no constant confidence', () => {
  it('orders a trivial prompt below an extreme prompt', async () => {
    const trivial = await scoreIntent('hi there');
    const extreme = await scoreIntent(
      'design a globally distributed ledger with strict serializability across five regions, ' +
      'consensus, sharding, clock-sync, and single-region failover',
    );
    expect(trivial.value).toBeLessThan(extreme.value);
  });
  it('produces non-constant confidence across different prompts', async () => {
    const a = await scoreIntent('hello');
    const b = await scoreIntent('write a function to merge two sorted arrays and explain the complexity');
    expect(a.confidence).not.toBe(b.confidence);
  });
  it('routes a greeting to trivial (free-tier reachable, not force-escalated)', async () => {
    const r = await scoreIntent('good morning');
    expect(r.tier).toBe('trivial');
  });
});
