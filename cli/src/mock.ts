/**
 * GateSwarm v0.5.4 — Mock data for testing without a running server
 * Mirrors the shape of real /v05/intel/* responses
 */

import type {
  ConsumptionReport,
  IntelReport,
  QuotaResponse,
  ProviderConsumptionReport,
} from './types.js';

export const mockConsumption: ConsumptionReport = {
  generatedAt: Date.now(),
  totalProviders: 4,
  totalFiveHour: {
    requests: 29,
    tokensIn: 1_412,
    tokensOut: 6_145,
    totalTokens: 7_557,
    cost: 0,
    errors: 1,
    avgLatencyMs: 7_903,
    windowMs: 18_000_000,
    windowStart: Date.now() - 18_000_000,
    windowEnd: Date.now(),
    hoursCovered: 5,
  },
  totalWeekly: {
    requests: 29,
    tokensIn: 1_412,
    tokensOut: 6_145,
    totalTokens: 7_557,
    cost: 0,
    errors: 1,
    avgLatencyMs: 7_903,
    windowMs: 604_800_000,
    windowStart: Date.now() - 604_800_000,
    windowEnd: Date.now(),
    hoursCovered: 5,
  },
  totalMonthly: {
    requests: 29,
    tokensIn: 1_412,
    tokensOut: 6_145,
    totalTokens: 7_557,
    cost: 0,
    errors: 1,
    avgLatencyMs: 7_903,
    windowMs: 2_592_000_000,
    windowStart: Date.now() - 2_592_000_000,
    windowEnd: Date.now(),
    hoursCovered: 5,
  },
  providers: [
    {
      provider: 'ollama-cloud',
      fiveHour: {
        requests: 13, tokensIn: 487, tokensOut: 2_864, totalTokens: 3_351,
        cost: 0, errors: 0, avgLatencyMs: 15_886, windowMs: 18_000_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      weekly: {
        requests: 13, tokensIn: 487, tokensOut: 2_864, totalTokens: 3_351,
        cost: 0, errors: 0, avgLatencyMs: 15_886, windowMs: 604_800_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      monthly: {
        requests: 13, tokensIn: 487, tokensOut: 2_864, totalTokens: 3_351,
        cost: 0, errors: 0, avgLatencyMs: 15_886, windowMs: 2_592_000_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      allTime: {
        requests: 13, tokensIn: 487, tokensOut: 2_864, totalTokens: 3_351,
        cost: 0, errors: 0, avgLatencyMs: 15_886, windowMs: 0,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      ageInDays: 0.05,
      dailyAverage: { requests: 13, tokens: 3_351, cost: 0 },
      trend: { fiveHourVsPrevious: 100, weeklyVsPrevious: 100 },
      quota: {
        fiveHour: {
          usedRequests: 13, limitRequests: 500, remainingRequests: 487,
          usedPctRequests: 2.6, usedTokens: 3_351, limitTokens: 200_000,
          remainingTokens: 196_649, usedPctTokens: 1.7,
          resetAt: '00:00 UTC', resetType: 'rolling', etaExhaustion: null,
        },
        weekly: {
          usedRequests: 13, limitRequests: 50_000, remainingRequests: 49_987,
          usedPctRequests: 0, usedTokens: 3_351, limitTokens: null,
          remainingTokens: null, usedPctTokens: null,
          resetAt: 'Monday 00:00 UTC', resetType: 'fixed', etaExhaustion: null,
        },
        monthly: {
          usedRequests: 13, limitRequests: null, remainingRequests: null,
          usedPctRequests: null, usedTokens: 3_351, limitTokens: null,
          remainingTokens: null, usedPctTokens: null,
          resetAt: 'never', resetType: 'rolling', etaExhaustion: null,
        },
      },
    },
    {
      provider: 'ollama',
      fiveHour: {
        requests: 13, tokensIn: 487, tokensOut: 1_392, totalTokens: 1_879,
        cost: 0, errors: 0, avgLatencyMs: 3_481, windowMs: 18_000_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 2,
      },
      weekly: {
        requests: 13, tokensIn: 487, tokensOut: 1_392, totalTokens: 1_879,
        cost: 0, errors: 0, avgLatencyMs: 3_481, windowMs: 604_800_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 2,
      },
      monthly: {
        requests: 13, tokensIn: 487, tokensOut: 1_392, totalTokens: 1_879,
        cost: 0, errors: 0, avgLatencyMs: 3_481, windowMs: 2_592_000_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 2,
      },
      allTime: {
        requests: 13, tokensIn: 487, tokensOut: 1_392, totalTokens: 1_879,
        cost: 0, errors: 0, avgLatencyMs: 3_481, windowMs: 0,
        windowStart: 0, windowEnd: 0, hoursCovered: 2,
      },
      ageInDays: 0.05,
      dailyAverage: { requests: 13, tokens: 1_879, cost: 0 },
      trend: { fiveHourVsPrevious: 100, weeklyVsPrevious: 100 },
      quota: {
        fiveHour: {
          usedRequests: 13, limitRequests: null, remainingRequests: null,
          usedPctRequests: null, usedTokens: 1_879, limitTokens: null,
          remainingTokens: null, usedPctTokens: null,
          resetAt: 'never', resetType: 'rolling', etaExhaustion: null,
        },
        weekly: {
          usedRequests: 13, limitRequests: null, remainingRequests: null,
          usedPctRequests: null, usedTokens: 1_879, limitTokens: null,
          remainingTokens: null, usedPctTokens: null,
          resetAt: 'never', resetType: 'rolling', etaExhaustion: null,
        },
        monthly: {
          usedRequests: 13, limitRequests: null, remainingRequests: null,
          usedPctRequests: null, usedTokens: 1_879, limitTokens: null,
          remainingTokens: null, usedPctTokens: null,
          resetAt: 'never', resetType: 'rolling', etaExhaustion: null,
        },
      },
    },
    {
      provider: 'opencodego',
      fiveHour: {
        requests: 2, tokensIn: 233, tokensOut: 1_299, totalTokens: 1_532,
        cost: 0, errors: 0, avgLatencyMs: 8_751, windowMs: 18_000_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      weekly: {
        requests: 2, tokensIn: 233, tokensOut: 1_299, totalTokens: 1_532,
        cost: 0, errors: 0, avgLatencyMs: 8_751, windowMs: 604_800_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      monthly: {
        requests: 2, tokensIn: 233, tokensOut: 1_299, totalTokens: 1_532,
        cost: 0, errors: 0, avgLatencyMs: 8_751, windowMs: 2_592_000_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      allTime: {
        requests: 2, tokensIn: 233, tokensOut: 1_299, totalTokens: 1_532,
        cost: 0, errors: 0, avgLatencyMs: 8_751, windowMs: 0,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      ageInDays: 0.05,
      dailyAverage: { requests: 2, tokens: 1_532, cost: 0 },
      trend: { fiveHourVsPrevious: 100, weeklyVsPrevious: 100 },
      quota: {
        fiveHour: {
          usedRequests: 2, limitRequests: 250, remainingRequests: 248,
          usedPctRequests: 0.8, usedTokens: 1_532, limitTokens: 100_000,
          remainingTokens: 98_468, usedPctTokens: 1.5,
          resetAt: '00:00 UTC', resetType: 'rolling', etaExhaustion: null,
        },
        weekly: {
          usedRequests: 2, limitRequests: 25_000, remainingRequests: 24_998,
          usedPctRequests: 0, usedTokens: 1_532, limitTokens: null,
          remainingTokens: null, usedPctTokens: null,
          resetAt: 'Monday 00:00 UTC', resetType: 'fixed', etaExhaustion: null,
        },
        monthly: {
          usedRequests: 2, limitRequests: null, remainingRequests: null,
          usedPctRequests: null, usedTokens: 1_532, limitTokens: null,
          remainingTokens: null, usedPctTokens: null,
          resetAt: 'never', resetType: 'rolling', etaExhaustion: null,
        },
      },
    },
    {
      provider: 'zai',
      fiveHour: {
        requests: 1, tokensIn: 205, tokensOut: 590, totalTokens: 795,
        cost: 0, errors: 0, avgLatencyMs: 12_151, windowMs: 18_000_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      weekly: {
        requests: 1, tokensIn: 205, tokensOut: 590, totalTokens: 795,
        cost: 0, errors: 0, avgLatencyMs: 12_151, windowMs: 604_800_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      monthly: {
        requests: 1, tokensIn: 205, tokensOut: 590, totalTokens: 795,
        cost: 0, errors: 0, avgLatencyMs: 12_151, windowMs: 2_592_000_000,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      allTime: {
        requests: 1, tokensIn: 205, tokensOut: 590, totalTokens: 795,
        cost: 0, errors: 0, avgLatencyMs: 12_151, windowMs: 0,
        windowStart: 0, windowEnd: 0, hoursCovered: 1,
      },
      ageInDays: 0.05,
      dailyAverage: { requests: 1, tokens: 795, cost: 0 },
      trend: { fiveHourVsPrevious: 100, weeklyVsPrevious: 100 },
      quota: {
        fiveHour: {
          usedRequests: 1, limitRequests: 150, remainingRequests: 149,
          usedPctRequests: 0.7, usedTokens: 795, limitTokens: 80_000,
          remainingTokens: 79_205, usedPctTokens: 1.0,
          resetAt: '00:00 UTC', resetType: 'rolling', etaExhaustion: null,
        },
        weekly: {
          usedRequests: 1, limitRequests: 15_000, remainingRequests: 14_999,
          usedPctRequests: 0, usedTokens: 795, limitTokens: null,
          remainingTokens: null, usedPctTokens: null,
          resetAt: 'Monday 00:00 UTC', resetType: 'fixed', etaExhaustion: null,
        },
        monthly: {
          usedRequests: 1, limitRequests: null, remainingRequests: null,
          usedPctRequests: null, usedTokens: 795, limitTokens: null,
          remainingTokens: null, usedPctTokens: null,
          resetAt: 'never', resetType: 'rolling', etaExhaustion: null,
        },
      },
    },
  ],
};

export const mockIntel: IntelReport = {
  version: '0.5.3',
  stats: {
    totalModels: 412,
    availableModels: 412,
    unhealthyModels: 0,
    totalRequests: 138,
    totalErrors: 1,
    errorRate: 0.0072,
    totalTokensIn: 24_701,
    totalTokensOut: 7_684,
    estimatedCost: 0,
    providers: [
      { provider: 'bailian', name: 'Bailian', totalModels: 5, availableModels: 5, totalTokensIn: 0, totalTokensOut: 0, totalRequests: 0, totalErrors: 0, avgLatencyMs: 0, rateLimitHits: 0 },
      { provider: 'ollama', name: 'Ollama', totalModels: 2, availableModels: 2, totalTokensIn: 487, totalTokensOut: 1392, totalRequests: 13, totalErrors: 0, avgLatencyMs: 3481, rateLimitHits: 0 },
      { provider: 'openrouter', name: 'OpenRouter', totalModels: 337, availableModels: 337, totalTokensIn: 0, totalTokensOut: 0, totalRequests: 0, totalErrors: 0, avgLatencyMs: 0, rateLimitHits: 0 },
      { provider: 'ollama-cloud', name: 'Ollama Cloud', totalModels: 42, availableModels: 42, totalTokensIn: 487, totalTokensOut: 2864, totalRequests: 13, totalErrors: 0, avgLatencyMs: 15886, rateLimitHits: 0 },
      { provider: 'opencodego', name: 'OpenCode Go', totalModels: 19, availableModels: 19, totalTokensIn: 233, totalTokensOut: 1299, totalRequests: 2, totalErrors: 0, avgLatencyMs: 8751, rateLimitHits: 0 },
      { provider: 'zai', name: 'ZAI', totalModels: 7, availableModels: 7, totalTokensIn: 205, totalTokensOut: 590, totalRequests: 1, totalErrors: 0, avgLatencyMs: 12151, rateLimitHits: 0 },
    ],
    tierDistribution: { trivial: 3, light: 5, moderate: 125, heavy: 87, intensive: 119, extreme: 73 },
    modelCount: 412,
  },
  recommendations: {
    trivial: { provider: 'ollama', model: 'qwen2.5:0.5b', tier: 'trivial', reason: 'static_fallback', estimatedTokens: 500, estimatedCost: 0, confidence: 0.3, alternatives: [] },
    light: { provider: 'ollama-cloud', model: 'kimi-k2-thinking', tier: 'light', reason: 'cheapest_available', estimatedTokens: 500, estimatedCost: 0, confidence: 0.78, alternatives: [] },
    moderate: { provider: 'ollama-cloud', model: 'kimi-k2-thinking', tier: 'moderate', reason: 'cheapest_available', estimatedTokens: 500, estimatedCost: 0, confidence: 0.93, alternatives: [] },
    heavy: { provider: 'ollama-cloud', model: 'kimi-k2.7-code', tier: 'heavy', reason: 'cheapest_available', estimatedTokens: 500, estimatedCost: 0, confidence: 0.91, alternatives: [] },
    intensive: { provider: 'ollama-cloud', model: 'nemotron-3-super', tier: 'intensive', reason: 'cheapest_available', estimatedTokens: 500, estimatedCost: 0, confidence: 0.85, alternatives: [] },
    extreme: { provider: 'ollama-cloud', model: 'kimi-k2:1t', tier: 'extreme', reason: 'cheapest_available', estimatedTokens: 500, estimatedCost: 0, confidence: 0.86, alternatives: [] },
  },
  recentDecisions: [
    { provider: 'ollama-cloud', model: 'kimi-k2:1t', tier: 'extreme', reason: 'cheapest_available', estimatedTokens: 500, estimatedCost: 0, confidence: 0.86, alternatives: [] },
    { provider: 'ollama-cloud', model: 'nemotron-3-super', tier: 'intensive', reason: 'cheapest_available', estimatedTokens: 500, estimatedCost: 0, confidence: 0.85, alternatives: [] },
  ],
};

export const mockQuota: QuotaResponse = {
  quotas: [
    { provider: 'ollama', name: 'Ollama (Local)', health: 100, rpm: '∞/∞', rpd: '∞/∞', tokens: '∞', requestsToday: 13, tokensToday: 1879, throttled: false, throttledUntil: null, totalAllTime: 1879 },
    { provider: 'ollama-cloud', name: 'Ollama Cloud', health: 100, rpm: '98/100 RPM', rpd: '9991/10000 RPD', tokens: '482K/500K', requestsToday: 13, tokensToday: 18040, throttled: false, throttledUntil: null, totalAllTime: 18040 },
    { provider: 'opencodego', name: 'OpenCode Go', health: 100, rpm: '49/50 RPM', rpd: '4999/5000 RPD', tokens: '298K/300K', requestsToday: 2, tokensToday: 2018, throttled: false, throttledUntil: null, totalAllTime: 2018 },
    { provider: 'zai', name: 'ZAI', health: 100, rpm: '30/30 RPM', rpd: '3000/3000 RPD', tokens: '200K/200K', requestsToday: 1, tokensToday: 795, throttled: false, throttledUntil: null, totalAllTime: 795 },
  ],
};
