/**
 * Token Economy v0.6 — Unit Tests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordTokenEconomy, getTokenEconomyStats, getAgentTokenStats, formatTokens, resetTokenEconomy, initTokenEconomy } from '../src/token-economy.js';

describe('Token Economy', () => {
  beforeEach(async () => {
    await initTokenEconomy();
    await resetTokenEconomy();
  });

  it('records a token event and updates stats', async () => {
    await recordTokenEconomy('test-agent', 'moderate', 500, 1000, 300, 'deduplication');
    const stats = getTokenEconomyStats();

    expect(stats.globalTotal.rawIn).toBe(500);
    expect(stats.globalTotal.rawOut).toBe(1000);
    expect(stats.globalTotal.filtered).toBe(300);
    expect(stats.globalTotal.saved).toBe(700);

    const agent = getAgentTokenStats('test-agent');
    expect(agent).not.toBeNull();
    expect(agent!.totalRawIn).toBe(500);
    expect(agent!.totalRawOut).toBe(1000);
    expect(agent!.totalSaved).toBe(700);
    expect(agent!.requestCount).toBe(1);
    expect(agent!.filterHitCount).toBe(1); // 700 > 0, so it counts as a hit
    expect(agent!.strategyBreakdown['deduplication']).toBe(1);
  });

  it('tracks tier breakdown correctly', async () => {
    await recordTokenEconomy('test-agent', 'trivial', 100, 200, 150, 'none');
    await recordTokenEconomy('test-agent', 'heavy', 300, 800, 200, 'failure-focus');

    const agent = getAgentTokenStats('test-agent');
    expect(agent!.tierBreakdown['trivial']).toBeDefined();
    expect(agent!.tierBreakdown['heavy']).toBeDefined();
    expect(agent!.tierBreakdown['trivial'].requestCount).toBe(1);
    expect(agent!.tierBreakdown['heavy'].requestCount).toBe(1);
    expect(agent!.tierBreakdown['heavy'].savedTokens).toBe(600);
  });

  it('aggregates multiple agents', async () => {
    await recordTokenEconomy('agent-a', 'moderate', 500, 1000, 500, 'code-filter');
    await recordTokenEconomy('agent-b', 'heavy', 1000, 2000, 800, 'stats-extraction');

    const stats = getTokenEconomyStats();
    expect(stats.globalTotal.rawIn).toBe(1500);
    expect(stats.globalTotal.rawOut).toBe(3000);
    expect(stats.globalTotal.saved).toBe(1700);
    expect(Object.keys(stats.agents).length).toBe(2);
  });

  it('formatTokens formats correctly', () => {
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(5300000)).toBe('5.3M');
    expect(formatTokens(0)).toBe('0');
  });

  it('resets all stats', async () => {
    await recordTokenEconomy('test-agent', 'moderate', 500, 1000, 300, 'deduplication');
    await resetTokenEconomy();

    const stats = getTokenEconomyStats();
    expect(stats.globalTotal.rawIn).toBe(0);
    expect(stats.globalTotal.rawOut).toBe(0);
    expect(stats.globalTotal.saved).toBe(0);
    expect(Object.keys(stats.agents).length).toBe(0);
  });

  it('saves output > raw input records as saved', async () => {
    // Edge case: filtered output is larger than raw output (rare but possible)
    await recordTokenEconomy('test-agent', 'trivial', 100, 50, 200, 'none');
    const stats = getTokenEconomyStats();
    // saved = rawOut - filtered = 50 - 200 = -150
    expect(stats.globalTotal.saved).toBe(-150);
  });

  it('strategy breakdown accumulates correctly', async () => {
    await recordTokenEconomy('test-agent', 'moderate', 500, 1000, 500, 'failure-focus');
    await recordTokenEconomy('test-agent', 'moderate', 500, 1000, 500, 'failure-focus');
    await recordTokenEconomy('test-agent', 'heavy', 800, 2000, 800, 'code-filter');

    const agent = getAgentTokenStats('test-agent');
    expect(agent!.strategyBreakdown['failure-focus']).toBe(2);
    expect(agent!.strategyBreakdown['code-filter']).toBe(1);
  });
});
