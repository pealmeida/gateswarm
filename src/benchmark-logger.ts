/**
 * MoMA v2 Benchmark Logger
 * 
 * Tracks per-request cost savings vs baseline (Claude Opus)
 * Logs to data/benchmark-logs/
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { priceUsd, BASELINE_MODEL } from './openrouter-pricing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCHMARK_LOGS_DIR = join(__dirname, '../data/benchmark-logs');

// Cost is evaluated against OpenRouter list prices for the equivalent model —
// the single source of truth lives in openrouter-pricing.ts. The baseline used
// for savings is the most expensive elite model (Claude Opus).

export interface BenchmarkLogEntry {
  timestamp: string;
  request_id: string;
  prompt?: string;
  prompt_hash: string;
  prompt_length: number;
  tier: string;
  routed_model: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  cost_usd: number;
  baseline_cost_usd: number;
  savings_usd: number;
  savings_pct: number;
  provider: string;
  status: 'success' | 'error';
  error_message?: string;
}

export interface DailyBenchmarkSummary {
  date: string;
  total_requests: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  baseline_cost_usd: number;
  total_savings_usd: number;
  savings_pct: number;
  tier_distribution: Record<string, number>;
  model_distribution: Record<string, number>;
}

export class BenchmarkLogger {
  private logFile: string;

  constructor() {
    const today = new Date().toISOString().split('T')[0];
    this.logFile = join(BENCHMARK_LOGS_DIR, `${today}.jsonl`);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(BENCHMARK_LOGS_DIR, { recursive: true });
  }

  private calculateCost(model: string | undefined, provider: string | undefined, tokensIn: number, tokensOut: number): number {
    // Prices every routed model at its OpenRouter equivalent (single source of
    // truth). Models with no OpenRouter equivalent (e.g. tiny local models) are
    // treated as free.
    return priceUsd(model, provider, tokensIn, tokensOut);
  }

  async log(entry: Omit<BenchmarkLogEntry, 'timestamp' | 'request_id' | 'prompt_hash' | 'cost_usd' | 'baseline_cost_usd' | 'savings_usd' | 'savings_pct'>): Promise<BenchmarkLogEntry> {
    const timestamp = new Date().toISOString();
    const request_id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const prompt_hash = `sha256:${createHash('sha256').update(entry.prompt || '').digest('hex').slice(0, 16)}`;
    
    const cost_usd = this.calculateCost(entry.routed_model, entry.provider, entry.tokens_in, entry.tokens_out);
    const baseline_cost_usd = this.calculateCost(BASELINE_MODEL, undefined, entry.tokens_in, entry.tokens_out);
    const savings_usd = baseline_cost_usd - cost_usd;
    const savings_pct = baseline_cost_usd > 0 ? (savings_usd / baseline_cost_usd) * 100 : 0;

    const fullEntry: BenchmarkLogEntry = {
      timestamp,
      request_id,
      prompt_hash,
      prompt_length: entry.prompt_length,
      tier: entry.tier,
      routed_model: entry.routed_model,
      tokens_in: entry.tokens_in,
      tokens_out: entry.tokens_out,
      latency_ms: entry.latency_ms,
      cost_usd,
      baseline_cost_usd,
      savings_usd,
      savings_pct,
      provider: entry.provider,
      status: entry.status,
      error_message: entry.error_message,
    };

    // Append to JSONL file
    await fs.appendFile(this.logFile, JSON.stringify(fullEntry) + '\n');

    return fullEntry;
  }

  async getTodaySummary(): Promise<DailyBenchmarkSummary> {
    try {
      const content = await fs.readFile(this.logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      const entries: BenchmarkLogEntry[] = lines.map(line => JSON.parse(line));

      if (entries.length === 0) {
        return this.emptySummary();
      }

      const today = new Date().toISOString().split('T')[0];
      const total_requests = entries.length;
      const total_tokens_in = entries.reduce((sum, e) => sum + e.tokens_in, 0);
      const total_tokens_out = entries.reduce((sum, e) => sum + e.tokens_out, 0);
      const total_cost_usd = entries.reduce((sum, e) => sum + e.cost_usd, 0);
      const baseline_cost_usd = entries.reduce((sum, e) => sum + e.baseline_cost_usd, 0);
      const total_savings_usd = baseline_cost_usd - total_cost_usd;
      const savings_pct = baseline_cost_usd > 0 ? (total_savings_usd / baseline_cost_usd) * 100 : 0;

      const tier_distribution: Record<string, number> = {};
      const model_distribution: Record<string, number> = {};

      for (const entry of entries) {
        tier_distribution[entry.tier] = (tier_distribution[entry.tier] || 0) + 1;
        model_distribution[entry.routed_model] = (model_distribution[entry.routed_model] || 0) + 1;
      }

      return {
        date: today,
        total_requests,
        total_tokens_in,
        total_tokens_out,
        total_cost_usd,
        baseline_cost_usd,
        total_savings_usd,
        savings_pct,
        tier_distribution,
        model_distribution,
      };
    } catch (error) {
      return this.emptySummary();
    }
  }

  private emptySummary(): DailyBenchmarkSummary {
    const today = new Date().toISOString().split('T')[0];
    return {
      date: today,
      total_requests: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_cost_usd: 0,
      baseline_cost_usd: 0,
      total_savings_usd: 0,
      savings_pct: 0,
      tier_distribution: {},
      model_distribution: {},
    };
  }

  async generateReport(): Promise<string> {
    const summary = await this.getTodaySummary();
    
    return `
# MoMA v2 Benchmark Report — ${summary.date}

## Summary
- **Total Requests:** ${summary.total_requests}
- **Total Tokens:** ${summary.total_tokens_in.toLocaleString()} (in) + ${summary.total_tokens_out.toLocaleString()} (out)
- **Actual Cost:** $${summary.total_cost_usd.toFixed(4)}
- **Baseline Cost (Opus):** $${summary.baseline_cost_usd.toFixed(4)}
- **Total Savings:** $${summary.total_savings_usd.toFixed(4)} (${summary.savings_pct.toFixed(1)}%)

## Tier Distribution
${Object.entries(summary.tier_distribution)
  .map(([tier, count]) => `| ${tier} | ${count} | ${((count / summary.total_requests) * 100).toFixed(1)}% |`)
  .join('\n')}

## Model Distribution
${Object.entries(summary.model_distribution)
  .map(([model, count]) => `| ${model} | ${count} |`)
  .join('\n')}

## Projection (30 days)
${summary.total_requests > 0 ? `
- **Monthly Cost:** $${(summary.total_cost_usd * 30).toFixed(2)}
- **Monthly Savings:** $${(summary.total_savings_usd * 30).toFixed(2)}
- **Annual Savings:** $${(summary.total_savings_usd * 365).toFixed(2)}
` : 'No data yet — start routing requests to generate projections.'}
`.trim();
  }
}

// Singleton instance
export const benchmarkLogger = new BenchmarkLogger();

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await benchmarkLogger.initialize();
    const summary = await benchmarkLogger.getTodaySummary();
    console.log(JSON.stringify(summary, null, 2));
  })();
}
