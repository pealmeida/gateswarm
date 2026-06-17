/**
 * GateSwarm v0.5.4 — HTTP API client
 * Fetches data from the running GateSwarm gateway's /v05/intel/* endpoints
 */

import type {
  ConsumptionReport,
  IntelReport,
  QuotaResponse,
  SyncedQuotaReport,
} from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:8900';

export class GateSwarmAPI {
  constructor(private baseUrl: string = DEFAULT_BASE_URL) {}

  private async fetchJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} for ${path}`);
    }
    return (await resp.json()) as T;
  }

  /** Full consumption report (5h/weekly/monthly/all-time per provider) */
  async getConsumption(): Promise<ConsumptionReport> {
    return this.fetchJson<ConsumptionReport>('/v05/intel/consumption');
  }

  /** Tier recommendations + provider stats */
  async getIntel(): Promise<IntelReport> {
    return this.fetchJson<IntelReport>('/v05/intel');
  }

  /** Per-provider quota (RPD/RPM/tokens remaining) */
  async getQuota(): Promise<QuotaResponse> {
    return this.fetchJson<QuotaResponse>('/v05/intel/quota');
  }

  /** Real synced quota from provider dashboards/CLIs */
  async getSyncedQuota(): Promise<SyncedQuotaReport> {
    return this.fetchJson<SyncedQuotaReport>('/v05/intel/sync');
  }

  /** Force rediscovery of models */
  async rediscover(): Promise<{ ok: boolean; modelsIndexed: number }> {
    return this.fetchJson<{ ok: boolean; modelsIndexed: number }>(
      '/v05/intel/rediscover',
      // @ts-expect-error: POST not in fetchJson signature
      { method: 'POST' },
    );
  }

  /** Health check */
  async ping(): Promise<boolean> {
    try {
      await this.fetchJson('/v05/intel');
      return true;
    } catch {
      return false;
    }
  }
}
