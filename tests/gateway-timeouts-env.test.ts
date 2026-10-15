import { describe, expect, it } from 'vitest';
import {
  attemptTimeoutMs,
  FALLBACK_ATTEMPT_TIMEOUT_MS,
  FALLBACK_GLOBAL_BUDGET_MS,
  fallbackAttemptTimeoutMs,
  fallbackBudgetMs,
} from '../src/moma-gateway.js';

describe('gateway timeout environment overrides', () => {
  it('uses defaults for absent, invalid, and unsafe values', () => {
    expect(fallbackBudgetMs({})).toBe(FALLBACK_GLOBAL_BUDGET_MS);
    expect(attemptTimeoutMs({})).toBe(FALLBACK_ATTEMPT_TIMEOUT_MS);
    expect(fallbackBudgetMs({ MOMA_FALLBACK_BUDGET_MS: '0' })).toBe(FALLBACK_GLOBAL_BUDGET_MS);
    expect(attemptTimeoutMs({ MOMA_ATTEMPT_TIMEOUT_MS: '1.5' })).toBe(FALLBACK_ATTEMPT_TIMEOUT_MS);
    expect(attemptTimeoutMs({ MOMA_ATTEMPT_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER + 1) }))
      .toBe(FALLBACK_ATTEMPT_TIMEOUT_MS);
  });

  it('reads valid overrides and keeps a lone attempt override within budget', () => {
    expect(attemptTimeoutMs({ MOMA_ATTEMPT_TIMEOUT_MS: '90000' })).toBe(90_000);
    expect(fallbackBudgetMs({ MOMA_FALLBACK_BUDGET_MS: '180000' })).toBe(180_000);
    expect(fallbackBudgetMs({ MOMA_ATTEMPT_TIMEOUT_MS: '90000' })).toBe(90_000);
    expect(fallbackBudgetMs({ MOMA_ATTEMPT_TIMEOUT_MS: '30000' })).toBe(FALLBACK_GLOBAL_BUDGET_MS);
  });

  it('caps attempts at the remaining shared budget', () => {
    const now = 1_000;
    expect(fallbackAttemptTimeoutMs(now + 5_000, now, 9_000)).toBe(5_000);
  });
});
