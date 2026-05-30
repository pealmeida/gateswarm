/**
 * Provider Health Manager — Auto-fallback with circuit breaker
 *
 * Tracks per-provider health status:
 * - 429 rate limits → marks provider as "cooldown" until reset window
 * - 5xx errors → marks provider as "degraded" with backoff
 * - timeouts → marks provider as "degraded" with backoff
 * - success → resets status to "healthy"
 *
 * Providers in cooldown/degraded state are auto-skipped in fallback chains.
 * Status auto-resets when the quota window expires.
 *
 * v0.6.2: Added to GateSwarm MoMA Router
 */

export type ProviderStatus = 'healthy' | 'degraded' | 'cooldown' | 'unavailable';

export interface ProviderHealthEntry {
  status: ProviderStatus;
  lastError: string | null;
  lastErrorAt: number;
  consecutiveErrors: number;
  cooldownUntil: number;
  quotaResetAt: number;
  cooldownReason: string | null;
  totalRequests: number;
  totalErrors: number;
  lastSuccessAt: number;
}

const COOLDOWN_429_MS = 60_000;  // 1 min
const BACKOFF_5XX_MS = 30_000;   // 30s initial
const BACKOFF_TIMEOUT_MS = 15_000; // 15s
const MAX_CONSECUTIVE_ERRORS = 5;

export class ProviderHealthManager {
  private entries = new Map<string, ProviderHealthEntry>();

  constructor() {}

  getEntry(providerId: string): ProviderHealthEntry {
    if (!this.entries.has(providerId)) {
      this.entries.set(providerId, {
        status: 'healthy',
        lastError: null,
        lastErrorAt: 0,
        consecutiveErrors: 0,
        cooldownUntil: 0,
        quotaResetAt: 0,
        cooldownReason: null,
        totalRequests: 0,
        totalErrors: 0,
        lastSuccessAt: 0,
      });
    }
    return this.entries.get(providerId)!;
  }

  recordSuccess(providerId: string) {
    const entry = this.getEntry(providerId);
    entry.status = 'healthy';
    entry.consecutiveErrors = 0;
    entry.lastSuccessAt = Date.now();
    entry.totalRequests++;
  }

  record429(providerId: string, retryAfterMs?: number) {
    const entry = this.getEntry(providerId);
    entry.status = 'cooldown';
    entry.cooldownUntil = Date.now() + (retryAfterMs || COOLDOWN_429_MS);
    entry.cooldownReason = 'rate_limit_429';
    entry.lastErrorAt = Date.now();
    entry.consecutiveErrors++;
    entry.totalErrors++;
    entry.totalRequests++;
  }

  record5xx(providerId: string, statusCode: number) {
    const entry = this.getEntry(providerId);
    entry.status = 'degraded';
    const backoff = Math.min(BACKOFF_5XX_MS * Math.pow(2, entry.consecutiveErrors), 300_000);
    entry.cooldownUntil = Date.now() + backoff;
    entry.cooldownReason = `server_error_${statusCode}`;
    entry.lastErrorAt = Date.now();
    entry.consecutiveErrors++;
    entry.totalErrors++;
    entry.totalRequests++;
  }

  recordTimeout(providerId: string) {
    const entry = this.getEntry(providerId);
    entry.status = 'degraded';
    const backoff = Math.min(BACKOFF_TIMEOUT_MS * Math.pow(2, entry.consecutiveErrors), 120_000);
    entry.cooldownUntil = Date.now() + backoff;
    entry.cooldownReason = 'timeout';
    entry.lastErrorAt = Date.now();
    entry.consecutiveErrors++;
    entry.totalErrors++;
    entry.totalRequests++;
  }

  isHealthy(providerId: string): boolean {
    const entry = this.getEntry(providerId);
    if (entry.status === 'healthy') return true;
    if (entry.cooldownUntil > 0 && Date.now() >= entry.cooldownUntil) {
      // Auto-recover
      entry.status = 'healthy';
      entry.consecutiveErrors = 0;
      return true;
    }
    return false;
  }

  getStatus(providerId: string): ProviderHealthEntry {
    return this.getEntry(providerId);
  }

  getAllStatuses(): Record<string, ProviderHealthEntry> {
    const result: Record<string, ProviderHealthEntry> = {};
    for (const [id, entry] of this.entries) {
      result[id] = { ...entry };
    }
    return result;
  }

  reset(providerId: string) {
    const entry = this.getEntry(providerId);
    entry.status = 'healthy';
    entry.consecutiveErrors = 0;
    entry.cooldownUntil = 0;
    entry.cooldownReason = null;
  }
}
