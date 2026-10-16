import { describe, expect, it, vi } from 'vitest';
import {
  attemptTimeoutMs,
  FALLBACK_ATTEMPT_TIMEOUT_MS,
  FALLBACK_BUDGET_MAX_MS,
  FALLBACK_BUDGET_MIN_MS,
  FALLBACK_GLOBAL_BUDGET_MS,
  fallbackAttemptTimeoutMs,
  fallbackBudgetMs,
} from '../src/moma-gateway.js';

describe('gateway timeout environment overrides', () => {
  it('uses defaults for absent, invalid, and unsafe values', () => {
    expect(FALLBACK_GLOBAL_BUDGET_MS).toBe(180_000);
    expect(fallbackBudgetMs({})).toBe(FALLBACK_GLOBAL_BUDGET_MS);
    expect(attemptTimeoutMs({})).toBe(FALLBACK_ATTEMPT_TIMEOUT_MS);
    const warn = vi.fn();
    expect(fallbackBudgetMs({ MOMA_FALLBACK_BUDGET_MS: '0' }, warn)).toBe(FALLBACK_GLOBAL_BUDGET_MS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MOMA_FALLBACK_BUDGET_MS'));
    expect(attemptTimeoutMs({ MOMA_ATTEMPT_TIMEOUT_MS: '1.5' })).toBe(FALLBACK_ATTEMPT_TIMEOUT_MS);
    expect(attemptTimeoutMs({ MOMA_ATTEMPT_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER + 1) }))
      .toBe(FALLBACK_ATTEMPT_TIMEOUT_MS);
  });

  it('reads valid overrides and keeps a lone attempt override within budget', () => {
    expect(attemptTimeoutMs({ MOMA_ATTEMPT_TIMEOUT_MS: '90000' })).toBe(90_000);
    expect(fallbackBudgetMs({ MOMA_FALLBACK_BUDGET_MS: '180000' })).toBe(180_000);
    expect(fallbackBudgetMs({ MOMA_ATTEMPT_TIMEOUT_MS: '300000' })).toBe(300_000);
    expect(fallbackBudgetMs({ MOMA_ATTEMPT_TIMEOUT_MS: '90000' })).toBe(FALLBACK_GLOBAL_BUDGET_MS);
    expect(fallbackBudgetMs({ MOMA_ATTEMPT_TIMEOUT_MS: '30000' })).toBe(FALLBACK_GLOBAL_BUDGET_MS);
  });

  it('defaults the fallback budget to 180000', () => {
    expect(FALLBACK_BUDGET_MIN_MS).toBe(5_000);
    expect(FALLBACK_BUDGET_MAX_MS).toBe(900_000);
    expect(fallbackBudgetMs({}, vi.fn())).toBe(180_000);
  });

  it('prefers GATESWARM_FALLBACK_BUDGET_MS over the legacy MOMA variable', () => {
    expect(fallbackBudgetMs({ GATESWARM_FALLBACK_BUDGET_MS: '240000', MOMA_FALLBACK_BUDGET_MS: '300000' }, vi.fn()))
      .toBe(240_000);
    expect(fallbackBudgetMs({ MOMA_FALLBACK_BUDGET_MS: '600000' }, vi.fn())).toBe(600_000);
  });

  it('falls back to a valid legacy value when GATESWARM is invalid', () => {
    const warn = vi.fn();
    expect(fallbackBudgetMs({ GATESWARM_FALLBACK_BUDGET_MS: 'not-a-number', MOMA_FALLBACK_BUDGET_MS: '240000' }, warn))
      .toBe(240_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GATESWARM_FALLBACK_BUDGET_MS'));
  });

  it('rejects below-min, above-max, negative, and garbage values with a warning', () => {
    const cases: Array<Record<string, string>> = [
      { GATESWARM_FALLBACK_BUDGET_MS: '4999' },
      { GATESWARM_FALLBACK_BUDGET_MS: '900001' },
      { GATESWARM_FALLBACK_BUDGET_MS: '-60000' },
      { GATESWARM_FALLBACK_BUDGET_MS: 'garbage' },
      { GATESWARM_FALLBACK_BUDGET_MS: '5000.5' },
    ];
    for (const env of cases) {
      const warn = vi.fn();
      expect(fallbackBudgetMs(env as NodeJS.ProcessEnv, warn)).toBe(FALLBACK_GLOBAL_BUDGET_MS);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain('GATESWARM_FALLBACK_BUDGET_MS');
      expect(message).toContain('180000');
    }
  });

  it('accepts the exact min and max boundary values', () => {
    expect(fallbackBudgetMs({ GATESWARM_FALLBACK_BUDGET_MS: '5000' }, vi.fn())).toBe(FALLBACK_BUDGET_MIN_MS);
    expect(fallbackBudgetMs({ GATESWARM_FALLBACK_BUDGET_MS: '900000' }, vi.fn())).toBe(FALLBACK_BUDGET_MAX_MS);
  });

  it('warns once per distinct (variable, value) pair', () => {
    const warn = vi.fn();
    const env = { MOMA_FALLBACK_BUDGET_MS: 'oops-once' };
    expect(fallbackBudgetMs(env, warn)).toBe(FALLBACK_GLOBAL_BUDGET_MS);
    expect(fallbackBudgetMs(env, warn)).toBe(FALLBACK_GLOBAL_BUDGET_MS);
    expect(warn).toHaveBeenCalledTimes(1);
    fallbackBudgetMs({ MOMA_FALLBACK_BUDGET_MS: 'oops-twice' }, warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps a valid attempt covered when the budget override is invalid', () => {
    const warn = vi.fn();
    expect(fallbackBudgetMs({ GATESWARM_FALLBACK_BUDGET_MS: 'bogus-budget', MOMA_ATTEMPT_TIMEOUT_MS: '300000' }, warn))
      .toBe(300_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fallbackBudgetMs({ GATESWARM_FALLBACK_BUDGET_MS: 'bogus-budget-2', MOMA_ATTEMPT_TIMEOUT_MS: '90000' }, warn))
      .toBe(FALLBACK_GLOBAL_BUDGET_MS);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('caps attempts at the remaining shared budget', () => {
    const now = 1_000;
    expect(fallbackAttemptTimeoutMs(now + 5_000, now, 9_000)).toBe(5_000);
  });
});
