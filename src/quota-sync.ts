/**
 * Quota Sync Service v0.1.0
 *
 * Scrapes real quota data from provider dashboards using browser automation,
 * then feeds the values into the consumption tracker.
 *
 * Supported providers:
 *   - ZAI (z.ai dashboard)
 *
 * Approach: Same as CodexBar — read the real provider dashboard values.
 * Runs as a periodic cron job (every 5 minutes).
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNC_FILE = join(__dirname, '../data/quota-sync.json');

// ─── Types ───────────────────────────────────────────────

export interface ProviderQuotaSnapshot {
  provider: string;
  /** ISO timestamp of last successful sync */
  syncedAt: string;
  /** Source URL */
  source: string;
  /** Windows */
  windows: {
    [windowName: string]: {
      usedPct: number | null; // 0-100; null = plan limit unknown
      usedTokens?: number;   // if available
      limitTokens?: number;  // if available
      resetAt?: string;      // human-readable
      extra?: Record<string, string>;  // provider-specific (deficit, reserve, etc.)
    };
  };
  /** Raw scrape data for debugging */
  raw?: Record<string, any>;
}

export interface QuotaSyncState {
  version: string;
  updatedAt: string;
  snapshots: Record<string, ProviderQuotaSnapshot>;
}

// ─── State ───────────────────────────────────────────────

class QuotaSyncManager {
  private state: QuotaSyncState;

  constructor() {
    this.state = { version: '0.1.0', updatedAt: new Date().toISOString(), snapshots: {} };
  }

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(SYNC_FILE, 'utf-8');
      this.state = JSON.parse(raw);
      console.log(`🔄 Quota Sync: loaded ${Object.keys(this.state.snapshots).length} snapshots`);
    } catch {
      console.log('🔄 Quota Sync: starting fresh');
    }
  }

  /** Re-read the sync file written by the external cron; returns true when it changed. */
  async reload(): Promise<boolean> {
    try {
      const raw = await fs.readFile(SYNC_FILE, 'utf-8');
      const next = JSON.parse(raw) as QuotaSyncState;
      if (next.updatedAt === this.state.updatedAt && Object.keys(next.snapshots || {}).length === Object.keys(this.state.snapshots).length) return false;
      this.state = next;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update a provider's quota snapshot.
   * Called by the browser scraper.
   */
  updateSnapshot(snapshot: ProviderQuotaSnapshot): void {
    this.state.snapshots[snapshot.provider] = snapshot;
    this.state.updatedAt = new Date().toISOString();
    this.persist();
  }

  getSnapshot(provider: string): ProviderQuotaSnapshot | undefined {
    return this.state.snapshots[provider];
  }

  getAllSnapshots(): ProviderQuotaSnapshot[] {
    return Object.values(this.state.snapshots);
  }

  /**
   * Get merged quota data for the consumption report.
   * Returns real dashboard percentages that override GateSwarm's internal tracking.
   */
  getRealQuotaData(): Record<string, {
    fiveHourUsedPct: number | null;
    weeklyUsedPct: number | null;
    monthlyUsedPct: number | null;
    fiveHourResetAt?: string;
    weeklyResetAt?: string;
    monthlyResetAt?: string;
    extra?: Record<string, string>;
    syncedAt: string;
  }> {
    const result: Record<string, any> = {};

    // Data older than GATESWARM_QUOTA_MAX_AGE_MIN (default 15) is "unknown" (null), never 0 / never trusted.
    const maxAgeMs = (Number(process.env.GATESWARM_QUOTA_MAX_AGE_MIN) > 0 ? Number(process.env.GATESWARM_QUOTA_MAX_AGE_MIN) : 15) * 60_000;
    for (const snapshot of Object.values(this.state.snapshots)) {
      const t = Date.parse(String(snapshot.syncedAt ?? '').replace('+00:00Z', 'Z'));
      if (Number.isNaN(t) || Date.now() - t > maxAgeMs) continue;
      const w = snapshot.windows;
      result[snapshot.provider] = {
        fiveHourUsedPct: w['5h']?.usedPct ?? w['session']?.usedPct ?? null,
        weeklyUsedPct: w['weekly']?.usedPct ?? w['7d']?.usedPct ?? null,
        monthlyUsedPct: w['monthly']?.usedPct ?? w['30d']?.usedPct ?? null,
        fiveHourResetAt: w['5h']?.resetAt ?? w['session']?.resetAt,
        weeklyResetAt: w['weekly']?.resetAt ?? w['7d']?.resetAt,
        monthlyResetAt: w['monthly']?.resetAt ?? w['30d']?.resetAt,
        extra: {
          ...(w['5h']?.extra || {}),
          ...(w['session']?.extra || {}),
          ...(w['weekly']?.extra || {}),
          ...(w['monthly']?.extra || {}),
        },
        syncedAt: snapshot.syncedAt,
      };
    }

    return result;
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(dirname(SYNC_FILE), { recursive: true });
      await fs.writeFile(SYNC_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.error('❌ [QuotaSync] Failed to persist:', (err as Error).message);
    }
  }
}

export const quotaSync = new QuotaSyncManager();

// ─── Browser Scraper Instructions ────────────────────────

/**
 * Each provider has a scrape config that describes how to extract quota data
 * from its dashboard. The actual scraping is done by the OpenClaw browser tool
 * (via a cron job), not by this module directly.
 *
 * The cron job reads these configs and uses browser automation to visit each
 * dashboard, extract the values, and call quotaSync.updateSnapshot().
 */
export const SCRAPE_CONFIGS = {
  zai: {
    name: 'ZAI',
    url: 'https://z.ai/dashboard',
    loginRequired: true,
    selectors: {
      tokens: {
        barSelector: '[data-quota="tokens"], .quota-section:first-child',
        textSelector: '[data-quota="tokens-percentage"]',
      },
      '5h': {
        barSelector: '[data-quota="5h"], .quota-section:nth-child(2)',
        textSelector: '[data-quota="5h-percentage"]',
      },
    },
  },
} as const;
