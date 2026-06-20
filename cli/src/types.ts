/**
 * GateSwarm v0.5.6 — CLI Types
 * Mirrors the /v05/intel/* endpoint response shapes
 */

export interface WindowConsumption {
  requests: number;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cost: number;
  errors: number;
  avgLatencyMs: number;
  windowMs: number;
  windowStart: number;
  windowEnd: number;
  hoursCovered: number;
}

export interface QuotaWindowStatus {
  usedRequests: number;
  limitRequests: number | null;
  remainingRequests: number | null;
  usedPctRequests: number | null;
  usedTokens: number;
  limitTokens: number | null;
  remainingTokens: number | null;
  usedPctTokens: number | null;
  resetAt: string;
  resetType: 'fixed' | 'rolling';
  etaExhaustion: {
    requests?: number;
    tokens?: number;
  } | null;
}

export interface ProviderQuotaStatus {
  fiveHour: QuotaWindowStatus;
  weekly: QuotaWindowStatus;
  monthly: QuotaWindowStatus;
}

export interface ProviderConsumptionReport {
  provider: string;
  fiveHour: WindowConsumption;
  weekly: WindowConsumption;
  monthly: WindowConsumption;
  allTime: WindowConsumption;
  ageInDays: number;
  dailyAverage: {
    requests: number;
    tokens: number;
    cost: number;
  };
  trend: {
    fiveHourVsPrevious: number;
    weeklyVsPrevious: number;
  };
  quota: ProviderQuotaStatus;
}

export interface ConsumptionReport {
  generatedAt: number;
  totalProviders: number;
  totalFiveHour: WindowConsumption;
  totalWeekly: WindowConsumption;
  totalMonthly: WindowConsumption;
  providers: ProviderConsumptionReport[];
}

export interface ModelEntry {
  id: string;
  provider: string;
  recommendedTier: string;
  contextWindow: number;
  maxTokens: number;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  avgLatencyMs: number;
  errors: number;
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  lastUsedAt: number;
}

export interface IntelStats {
  totalModels: number;
  availableModels: number;
  unhealthyModels: number;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  totalTokensIn: number;
  totalTokensOut: number;
  estimatedCost: number;
  providers: Array<{
    provider: string;
    name: string;
    totalModels: number;
    availableModels: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalRequests: number;
    totalErrors: number;
    avgLatencyMs: number;
    rateLimitHits: number;
  }>;
  tierDistribution: Record<string, number>;
  modelCount: number;
}

export interface TierRecommendation {
  provider: string;
  model: string;
  tier: string;
  reason: string;
  estimatedTokens: number;
  estimatedCost: number;
  confidence: number;
  alternatives: Array<{
    provider: string;
    model: string;
    reason: string;
  }>;
  // v0.5.6: distinguish real request decisions from health/balance checks
  source?: 'request' | 'health-check' | 'balance-check' | 'recovery-check';
  timestamp?: number;
}

export interface IntelReport {
  version: string;
  stats: IntelStats;
  recommendations: Record<string, TierRecommendation>;
  recentDecisions: TierRecommendation[];
}

export interface ProviderQuota {
  provider: string;
  name: string;
  health: number;
  rpm: string;
  rpd: string;
  tokens: string;
  requestsToday: number;
  tokensToday: number;
  throttled: boolean;
  throttledUntil: number | null;
  totalAllTime: number;
}

export interface QuotaResponse {
  quotas: ProviderQuota[];
}

// ─── Real Synced Quota (from provider dashboards/CLIs) ───

export interface SyncedWindowStatus {
  usedTokens: number;
  usedRequests: number;
  limitTokens: number | null;
  limitRequests: number | null;
  usedPctTokens: number | null;
  usedPctRequests: number | null;
  resetAt: string;
  resetType: 'fixed' | 'rolling';
}

export interface SyncedProviderSnapshot {
  provider: string;
  syncedAt: string;
  source: string;
  windows: Record<string, SyncedWindowStatus>;
}

export interface SyncedQuotaReport {
  version: string;
  updatedAt: string;
  snapshots: Record<string, SyncedProviderSnapshot>;
}
