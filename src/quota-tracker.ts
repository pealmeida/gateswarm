/**
 * Provider Quota Tracker — v0.6.2 Auto-Fallback
 *
 * Retrieves token usage limits and reset times from providers
 * via proactive health probes and response header parsing.
 * Works with ProviderHealthManager to decide when to skip providers.
 */

import { ProviderHealthManager } from './provider-health.js';

interface QuotaWindow {
  limit: number;
  used: number;
  resetAt: number; // timestamp ms
}

export interface QuotaStatus {
  providerId: string;
  isExhausted: boolean;
  remaining: number;
  limit: number;
  resetInMs: number;
  cliWindows?: Record<string, { used: number; limit: number; resetsIn: string }>;
}

interface QuotaEntry {
  windows: Record<string, QuotaWindow>;
  lastProbeAt: number;
  knownExhausted: boolean;
}

export class QuotaTracker {
  private healthManager: ProviderHealthManager;
  private quotaMap = new Map<string, QuotaEntry>();

  constructor(healthManager: ProviderHealthManager) {
    this.healthManager = healthManager;
  }

  shouldSkip(providerId: string): { skip: boolean; reason: string; retryAt: string | null } {
    // Check health manager first
    const healthy = this.healthManager.isHealthy(providerId);
    if (!healthy) {
      const entry = this.healthManager.getEntry(providerId);
      const retryAt = entry.cooldownUntil > 0 ? new Date(entry.cooldownUntil).toISOString() : null;
      return { skip: true, reason: entry.cooldownReason || 'unhealthy', retryAt };
    }

    // Check quota exhaustion
    const quota = this.quotaMap.get(providerId);
    if (quota?.knownExhausted) {
      return { skip: true, reason: 'quota_exhausted', retryAt: null };
    }

    return { skip: false, reason: '', retryAt: null };
  }

  recordRequest(providerId: string, statusCode: number, headers?: Headers) {
    // Record in health manager
    if (statusCode === 429) {
      const retryAfter = headers ? parseInt(headers.get('retry-after') || '60', 10) * 1000 : undefined;
      this.healthManager.record429(providerId, retryAfter);
    } else if (statusCode >= 500) {
      this.healthManager.record5xx(providerId, statusCode);
    } else {
      this.healthManager.recordSuccess(providerId);
    }

    // Parse quota headers if available (RateLimit-*)
    if (headers) {
      const limit = headers.get('ratelimit-limit') || headers.get('x-ratelimit-limit');
      const remaining = headers.get('ratelimit-remaining') || headers.get('x-ratelimit-remaining');
      const reset = headers.get('ratelimit-reset') || headers.get('x-ratelimit-reset');

      if (limit && remaining) {
        this.updateQuota(providerId, {
          limit: parseInt(limit, 10),
          used: parseInt(limit, 10) - parseInt(remaining, 10),
          resetAt: reset ? Date.now() + parseInt(reset, 10) * 1000 : Date.now() + 3600000,
        });
      }
    }
  }

  recordTimeout(providerId: string) {
    this.healthManager.recordTimeout(providerId);
  }

  private updateQuota(providerId: string, window: QuotaWindow) {
    if (!this.quotaMap.has(providerId)) {
      this.quotaMap.set(providerId, {
        windows: {},
        lastProbeAt: 0,
        knownExhausted: false,
      });
    }
    const entry = this.quotaMap.get(providerId)!;
    entry.windows['default'] = window;
    entry.lastProbeAt = Date.now();

    if (window.used >= window.limit) {
      entry.knownExhausted = true;
    } else {
      entry.knownExhausted = false;
    }
  }

  async probeProvider(providerId: string): Promise<QuotaStatus | null> {
    // In a full implementation, this would call the provider's status API
    // For now, return cached data
    const quota = this.quotaMap.get(providerId);
    if (!quota) return null;

    const w = quota.windows['default'];
    if (!w) return null;

    return {
      providerId,
      isExhausted: quota.knownExhausted,
      remaining: Math.max(0, w.limit - w.used),
      limit: w.limit,
      resetInMs: Math.max(0, w.resetAt - Date.now()),
    };
  }

  async getAllQuotaStatuses(): Promise<Record<string, QuotaStatus>> {
    const result: Record<string, QuotaStatus> = {};
    for (const [providerId] of this.quotaMap) {
      const status = await this.probeProvider(providerId);
      if (status) result[providerId] = status;
    }
    return result;
  }

  reset(providerId: string) {
    this.healthManager.reset(providerId);
    this.quotaMap.delete(providerId);
  }
}
