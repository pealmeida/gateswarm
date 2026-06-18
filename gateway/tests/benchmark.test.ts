/**
 * MoA v2 Benchmark Logger Tests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { BenchmarkLogger } from '../src/benchmark-logger.js';

describe('📊 MoA v2 Benchmark Logger', () => {
  let logger: BenchmarkLogger;

  beforeAll(async () => {
    logger = new BenchmarkLogger();
    await logger.initialize();
  });

  it('logs a trivial request (free tier)', async () => {
    const entry = await logger.log({
      prompt: 'Hello',
      prompt_length: 5,
      tier: 'trivial',
      routed_model: 'openrouter/owl-alpha',
      tokens_in: 64,
      tokens_out: 32,
      latency_ms: 150,
      provider: 'openrouter',
      status: 'success',
    });

    expect(entry.cost_usd).toBe(0);
    expect(entry.savings_pct).toBe(100);
    expect(entry.status).toBe('success');
    console.log(`  ✅ Free tier: $${entry.cost_usd.toFixed(6)} (100% savings)`);
  });

  it('logs a light request (L1 tier)', async () => {
    const entry = await logger.log({
      prompt: 'Summarize this text in 3 sentences...',
      prompt_length: 250,
      tier: 'light',
      routed_model: 'openrouter/z-ai/glm-4.7-flash',
      tokens_in: 512,
      tokens_out: 128,
      latency_ms: 340,
      provider: 'openrouter',
      status: 'success',
    });

    expect(entry.cost_usd).toBeGreaterThan(0);
    expect(entry.cost_usd).toBeLessThan(0.001);
    expect(entry.savings_pct).toBeGreaterThan(95);
    console.log(`  ✅ L1 Light: $${entry.cost_usd.toFixed(6)} (${entry.savings_pct.toFixed(1)}% savings)`);
  });

  it('logs a standard request (L2 tier)', async () => {
    const entry = await logger.log({
      prompt: 'Analyze this code and suggest improvements...',
      prompt_length: 1200,
      tier: 'standard',
      routed_model: 'openrouter/qwen/qwen-plus',
      tokens_in: 2048,
      tokens_out: 512,
      latency_ms: 890,
      provider: 'openrouter',
      status: 'success',
    });

    expect(entry.cost_usd).toBeGreaterThan(0.0005);
    expect(entry.cost_usd).toBeLessThan(0.01);
    expect(entry.savings_pct).toBeGreaterThan(80);
    console.log(`  ✅ L2 Standard: $${entry.cost_usd.toFixed(6)} (${entry.savings_pct.toFixed(1)}% savings)`);
  });

  it('logs a quality request (L3 tier)', async () => {
    const entry = await logger.log({
      prompt: 'Design a microservice architecture for...',
      prompt_length: 3500,
      tier: 'quality',
      routed_model: 'openrouter/anthropic/claude-sonnet-4.6',
      tokens_in: 8192,
      tokens_out: 2048,
      latency_ms: 2340,
      provider: 'openrouter',
      status: 'success',
    });

    expect(entry.cost_usd).toBeGreaterThan(0.05);
    expect(entry.cost_usd).toBeLessThan(1);
    expect(entry.savings_pct).toBeGreaterThanOrEqual(40);
    console.log(`  ✅ L3 Quality: $${entry.cost_usd.toFixed(6)} (${entry.savings_pct.toFixed(1)}% savings)`);
  });

  it('logs an elite request (L4 tier)', async () => {
    const entry = await logger.log({
      prompt: 'Solve this complex reasoning problem with multiple constraints...',
      prompt_length: 5000,
      tier: 'elite',
      routed_model: 'openrouter/anthropic/claude-opus-4.6',
      tokens_in: 16384,
      tokens_out: 4096,
      latency_ms: 5670,
      provider: 'openrouter',
      status: 'success',
    });

    expect(entry.cost_usd).toBeGreaterThan(0.1);
    expect(entry.savings_pct).toBe(0); // Baseline is Opus
    console.log(`  ✅ L4 Elite: $${entry.cost_usd.toFixed(6)} (baseline model)`);
  });

  it('generates comprehensive report', async () => {
    const summary = await logger.getTodaySummary();
    
    expect(summary.total_requests).toBeGreaterThanOrEqual(5);
    expect(summary.tier_distribution).toHaveProperty('trivial');
    expect(summary.tier_distribution).toHaveProperty('light');
    expect(summary.tier_distribution).toHaveProperty('standard');
    expect(summary.tier_distribution).toHaveProperty('quality');
    expect(summary.tier_distribution).toHaveProperty('elite');
    
    console.log('\n  📊 Today\'s Benchmark Summary:');
    console.log(`     Total Requests: ${summary.total_requests}`);
    console.log(`     Total Cost: $${summary.total_cost_usd.toFixed(6)}`);
    console.log(`     Baseline Cost: $${summary.baseline_cost_usd.toFixed(6)}`);
    console.log(`     Total Savings: $${summary.total_savings_usd.toFixed(6)} (${summary.savings_pct.toFixed(1)}%)`);
    console.log('\n     Tier Distribution:');
    for (const [tier, count] of Object.entries(summary.tier_distribution)) {
      console.log(`       ${tier}: ${count}`);
    }
  });

  it('handles error cases', async () => {
    const entry = await logger.log({
      prompt: 'This request will fail',
      prompt_length: 23,
      tier: 'light',
      routed_model: 'openrouter/z-ai/glm-4.7-flash',
      tokens_in: 0,
      tokens_out: 0,
      latency_ms: 1000,
      provider: 'openrouter',
      status: 'error',
      error_message: 'Rate limit exceeded',
    });

    expect(entry.status).toBe('error');
    expect(entry.error_message).toBe('Rate limit exceeded');
    expect(entry.cost_usd).toBe(0); // No cost for failed request
  });
});

describe('💰 Cost Savings Projection', () => {
  it('projects monthly savings at scale', async () => {
    const logger = new BenchmarkLogger();
    const summary = await logger.getTodaySummary();
    
    if (summary.total_requests === 0) {
      console.log('  ⚠️  No benchmark data yet — run other tests first');
      return;
    }

    const dailyCost = summary.total_cost_usd;
    const dailyBaseline = summary.baseline_cost_usd;
    const dailySavings = summary.total_savings_usd;

    console.log('\n  💰 Cost Projection (based on current mix):');
    console.log(`     Daily: $${dailyCost.toFixed(4)} vs $${dailyBaseline.toFixed(4)} baseline`);
    console.log(`     Monthly (10K queries): $${(dailyCost * 30).toFixed(2)} vs $${(dailyBaseline * 30).toFixed(2)}`);
    console.log(`     Monthly Savings: $${(dailySavings * 30).toFixed(2)}`);
    console.log(`     Annual Savings: $${(dailySavings * 365).toFixed(2)}`);
    
    expect(dailySavings).toBeGreaterThan(0);
  });
});
