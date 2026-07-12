import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOUNDARIES, scoreToEffort, setTierBoundaries } from '../src/tier-boundaries.js';

describe('tier boundaries', () => {
  it('rejects non-finite boundaries', () => {
    expect(setTierBoundaries([0.1, 0.2, Number.NaN, 0.4, 0.5])).toBe(false);
    expect(setTierBoundaries([0.1, 0.2, Infinity, 0.4, 0.5])).toBe(false);
    expect(setTierBoundaries([...DEFAULT_BOUNDARIES])).toBe(true);
  });

  it('fails closed to moderate for non-finite scores', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(scoreToEffort(Number.NaN)).toBe('moderate');
    expect(scoreToEffort(Infinity)).toBe('moderate');
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
