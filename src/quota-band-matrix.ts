/**
 * Quota Band Matrix Selector v0.7.0
 *
 * Automatically selects routing matrices based on provider quota consumption bands.
 * Bands: Green (0-40%), Yellow (40-70%), Orange (70-85%), Red (85-100%).
 *
 * Feature flag: GATESWARM_QUOTA_BAND_MATRIX (default OFF)
 * When OFF:
 *   - Routing uses current/baseline matrix from v04_config.json (bit-identical to 0.6.x)
 *   - STILL calculates and exports ALL observability data on all surfaces
 *   - matrixVariant = "current", reason = "flag_off", overlaysApplied = []
 * When ON:
 *   - Computes max(%) across providers using 5h window (fallback to weekly)
 *   - Selects band based on max%
 *   - Applies provider-specific overlays when a provider is hot
 *   - Returns effective tier_models for consumption-intelligence.ts
 *
 * Data sources (priority order):
 *   1. quotaSync.getRealQuotaData() — scraped dashboard data (preferred)
 *   2. consumptionTracker — historical usage % (fallback)
 *   3. CLI tools (if available) — for claude-cli/codex-cli
 *
 * Observability: ALWAYS exposes quotaBand, matrixVariant, overlaysApplied, providerPct,
 * window, quotaCoverage in advisory responses (regardless of flag state).
 */

import { promises as fs } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { EffortLevel } from './types.js';
import type { TierModelConfig } from './v04-config.js';
import { getConfig } from './v04-config.js';
import { quotaSync } from './quota-sync.js';
import { consumptionTracker } from './consumption-tracker.js';
import { getMultiWindowQuota } from './provider-quota.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the quota band matrices file path robustly.
 * Tries multiple locations to support both src and dist runtime layouts.
 */
function resolveMatricesFile(): string {
  const candidates: string[] = [];
  
  // 1. GATESWARM_ROOT env var (most reliable for production)
  if (process.env.GATESWARM_ROOT) {
    candidates.push(join(process.env.GATESWARM_ROOT, 'calibration/matrix-variants/quota_band_matrices.json'));
  }
  
  // 2. Walk up from __dirname to find package.json (project root)
  let currentDir = __dirname;
  for (let i = 0; i < 5; i++) {
    try {
      const pkgPath = join(currentDir, 'package.json');
      if (require('fs').existsSync(pkgPath)) {
        candidates.push(join(currentDir, 'calibration/matrix-variants/quota_band_matrices.json'));
        break;
      }
    } catch {}
    currentDir = dirname(currentDir);
  }
  
  // 3. process.cwd() (current working directory)
  candidates.push(join(process.cwd(), 'calibration/matrix-variants/quota_band_matrices.json'));
  
  // 4. Relative paths from __dirname (src layout and dist layout)
  candidates.push(join(__dirname, '../calibration/matrix-variants/quota_band_matrices.json')); // src layout
  candidates.push(join(__dirname, '../../calibration/matrix-variants/quota_band_matrices.json')); // dist layout
  
  // Return first candidate that exists
  for (const candidate of candidates) {
    try {
      if (require('fs').existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }
  
  // If none exist, return the first candidate (will fail later with helpful error)
  return candidates[0] || join(__dirname, '../calibration/matrix-variants/quota_band_matrices.json');
}

const MATRICES_FILE = resolveMatricesFile();

// ─── Types ───────────────────────────────────────────────

export type QuotaBand = 'green' | 'yellow' | 'orange' | 'red';

export interface QuotaBandThreshold {
  threshold: [number, number]; // [min%, max%]
  description: string;
  tier_models: Record<EffortLevel, TierModelConfig>;
}

export interface ProviderRuleCondition {
  provider?: string;
  providers?: string[];
  window: 'fiveHour' | 'weekly' | 'monthly';
  threshold: number;
  logic?: 'AND' | 'OR';
}

export interface ProviderRuleAction {
  tier: EffortLevel;
  remove?: Array<{ provider: string }>;
  demote_primary?: boolean;
  promote?: { provider: string; model: string };
}

export interface ProviderRule {
  description: string;
  condition: ProviderRuleCondition;
  actions: ProviderRuleAction[];
}

export interface QuotaBandMatrices {
  version: string;
  description: string;
  bands: Record<QuotaBand, QuotaBandThreshold>;
  provider_rules: Record<string, ProviderRule>;
}

export interface ProviderQuotaPercentage {
  provider: string;
  fiveHourPct: number | null;
  weeklyPct: number | null;
  monthlyPct: number | null;
  maxPct: number | null;
  window: 'fiveHour' | 'weekly' | 'monthly' | 'none';
  syncedAt?: string;
  source: 'quota_sync' | 'consumption_tracker' | 'cli' | 'unknown';
}

export interface QuotaBandSelection {
  band: QuotaBand;
  matrixVariant: string;
  maxProviderPct: number;
  window: 'fiveHour' | 'weekly' | 'none';
  providerPcts: ProviderQuotaPercentage[];
  overlaysApplied: string[];
  quotaCoverage: 'full' | 'partial' | 'none';
  unknownProviders: string[];
  reason: string;
  effectiveTierModels: Record<EffortLevel, TierModelConfig>;
}

// ─── State ───────────────────────────────────────────────

let _matrices: QuotaBandMatrices | null = null;
let _loadedAt = 0;
const RELOAD_INTERVAL_MS = 5 * 60 * 1000; // Reload every 5 minutes

// ─── Configuration ───────────────────────────────────────

export function isQuotaBandMatrixEnabled(): boolean {
  const flag = process.env.GATESWARM_QUOTA_BAND_MATRIX;
  return /^(1|true|yes|on)$/i.test(flag || '');
}

// ─── Matrix Loading ──────────────────────────────────────

async function loadMatrices(): Promise<QuotaBandMatrices> {
  const now = Date.now();
  if (_matrices && (now - _loadedAt) < RELOAD_INTERVAL_MS) {
    return _matrices;
  }

  try {
    const raw = await fs.readFile(MATRICES_FILE, 'utf-8');
    _matrices = JSON.parse(raw) as QuotaBandMatrices;
    _loadedAt = now;
    console.log(`📊 [QuotaBandMatrix] Loaded v${_matrices.version} — ${Object.keys(_matrices.bands).length} bands, ${Object.keys(_matrices.provider_rules).length} rules`);
    return _matrices;
  } catch (err) {
    console.error(`❌ [QuotaBandMatrix] Failed to load matrices:`, (err as Error).message);
    throw new Error(`Failed to load quota band matrices: ${(err as Error).message}`);
  }
}

export function getMatrices(): QuotaBandMatrices | null {
  return _matrices;
}

// ─── Quota Percentage Computation ────────────────────────

/**
 * Unified quota percentage computation across all providers.
 * Priority: quotaSync (real dashboard) > consumptionTracker > CLI tools.
 */
export function getProviderQuotaPercentages(): ProviderQuotaPercentage[] {
  const result: ProviderQuotaPercentage[] = [];
  const seenProviders = new Set<string>();

  // 1. quotaSync — real dashboard data (highest priority)
  const realQuota = quotaSync.getRealQuotaData();
  for (const [provider, data] of Object.entries(realQuota)) {
    seenProviders.add(provider);
    const fiveHourPct = data.fiveHourUsedPct;
    const weeklyPct = data.weeklyUsedPct;
    const monthlyPct = data.monthlyUsedPct;

    let maxPct: number | null = null;
    let window: 'fiveHour' | 'weekly' | 'monthly' | 'none' = 'none';

    // Prefer 5h, fallback to weekly, then monthly
    if (fiveHourPct !== null) {
      maxPct = fiveHourPct;
      window = 'fiveHour';
    } else if (weeklyPct !== null) {
      maxPct = weeklyPct;
      window = 'weekly';
    } else if (monthlyPct !== null) {
      maxPct = monthlyPct;
      window = 'monthly';
    }

    result.push({
      provider,
      fiveHourPct,
      weeklyPct,
      monthlyPct,
      maxPct,
      window,
      syncedAt: data.syncedAt,
      source: 'quota_sync',
    });
  }

  // 2. consumptionTracker — historical usage (fallback for providers not in quotaSync)
  const windowQuotas: Record<string, any> = {};
  const providers = ['ollama', 'ollama-cloud', 'opencodego', 'zai', 'openrouter', 'bailian', 'claude-cli', 'codex-cli'];
  for (const provider of providers) {
    const multiWindow = getMultiWindowQuota(provider);
    if (multiWindow) {
      windowQuotas[provider] = multiWindow;
    }
  }

  const report = consumptionTracker.buildReport({ windowQuotas });
  for (const providerReport of report.providers) {
    const provider = providerReport.provider;
    if (seenProviders.has(provider)) continue; // Already have real data
    seenProviders.add(provider);

    const fiveHour = providerReport.quota.fiveHour;
    const weekly = providerReport.quota.weekly;
    const monthly = providerReport.quota.monthly;

    const fiveHourPct = fiveHour.usedPctTokens;
    const weeklyPct = weekly.usedPctTokens;
    const monthlyPct = monthly.usedPctTokens;

    let maxPct: number | null = null;
    let window: 'fiveHour' | 'weekly' | 'monthly' | 'none' = 'none';

    if (fiveHourPct !== null) {
      maxPct = fiveHourPct;
      window = 'fiveHour';
    } else if (weeklyPct !== null) {
      maxPct = weeklyPct;
      window = 'weekly';
    } else if (monthlyPct !== null) {
      maxPct = monthlyPct;
      window = 'monthly';
    }

    result.push({
      provider,
      fiveHourPct,
      weeklyPct,
      monthlyPct,
      maxPct,
      window,
      source: 'consumption_tracker',
    });
  }

  return result;
}

// ─── Band Selection ───────────────────────────────────────

export function selectBand(maxPct: number): QuotaBand {
  if (maxPct < 40) return 'green';
  if (maxPct < 70) return 'yellow';
  if (maxPct < 85) return 'orange';
  return 'red';
}

// ─── Provider Overlay Application ────────────────────────

function evaluateProviderRuleCondition(
  condition: ProviderRuleCondition,
  providerPcts: ProviderQuotaPercentage[],
): boolean {
  const { provider, providers, window, threshold, logic = 'OR' } = condition;

  if (provider) {
    // Single provider rule
    const prov = providerPcts.find(p => p.provider === provider);
    if (!prov) return false;

    let pct: number | null = null;
    if (window === 'fiveHour') pct = prov.fiveHourPct;
    else if (window === 'weekly') pct = prov.weeklyPct;
    else if (window === 'monthly') pct = prov.monthlyPct;

    return pct !== null && pct >= threshold;
  }

  if (providers) {
    // Multiple providers rule
    const results = providers.map(pid => {
      const prov = providerPcts.find(p => p.provider === pid);
      if (!prov) return false;

      let pct: number | null = null;
      if (window === 'fiveHour') pct = prov.fiveHourPct;
      else if (window === 'weekly') pct = prov.weeklyPct;
      else if (window === 'monthly') pct = prov.monthlyPct;

      return pct !== null && pct >= threshold;
    });

    if (logic === 'AND') return results.every(r => r);
    return results.some(r => r);
  }

  return false;
}

function applyProviderOverlays(
  baseTierModels: Record<EffortLevel, TierModelConfig>,
  providerPcts: ProviderQuotaPercentage[],
  matrices: QuotaBandMatrices,
): { effectiveTierModels: Record<EffortLevel, TierModelConfig>; overlaysApplied: string[] } {
  const effectiveTierModels = JSON.parse(JSON.stringify(baseTierModels)) as Record<EffortLevel, TierModelConfig>;
  const overlaysApplied: string[] = [];

  // Evaluate each provider rule
  for (const [ruleName, rule] of Object.entries(matrices.provider_rules)) {
    if (evaluateProviderRuleCondition(rule.condition, providerPcts)) {
      overlaysApplied.push(ruleName);

      // Apply actions
      for (const action of rule.actions) {
        const tierConfig = effectiveTierModels[action.tier];
        if (!tierConfig) continue;

        // Remove providers
        if (action.remove) {
          for (const { provider } of action.remove) {
            // Remove from primary
            if (tierConfig.provider === provider) {
              // Find first fallback that's not being removed
              const fallback = tierConfig.fallback_models?.find(
                f => !action.remove!.some(r => r.provider === f.provider)
              );
              if (fallback) {
                tierConfig.provider = fallback.provider;
                tierConfig.model = fallback.model;
              }
            }

            // Remove from fallbacks
            if (tierConfig.fallback_models) {
              tierConfig.fallback_models = tierConfig.fallback_models.filter(
                f => f.provider !== provider
              );
            }

            // Remove from plan config
            if (tierConfig.plan_provider === provider) {
              tierConfig.plan_provider = tierConfig.provider;
              tierConfig.plan_model = undefined;
            }
          }
        }

        // Demote primary
        if (action.demote_primary && tierConfig.fallback_models && tierConfig.fallback_models.length > 0) {
          const currentPrimary = { provider: tierConfig.provider, model: tierConfig.model };
          const newPrimary = tierConfig.fallback_models[0];
          tierConfig.provider = newPrimary.provider;
          tierConfig.model = newPrimary.model;
          tierConfig.fallback_models = [
            ...tierConfig.fallback_models.slice(1),
            currentPrimary,
          ];
        }

        // Promote specific provider/model
        if (action.promote) {
          const currentPrimary = { provider: tierConfig.provider, model: tierConfig.model };
          tierConfig.provider = action.promote.provider;
          tierConfig.model = action.promote.model;
          // Add old primary to fallbacks if not already there
          if (tierConfig.fallback_models) {
            const alreadyInFallbacks = tierConfig.fallback_models.some(
              f => f.provider === currentPrimary.provider && f.model === currentPrimary.model
            );
            if (!alreadyInFallbacks) {
              tierConfig.fallback_models.unshift(currentPrimary);
            }
          }
        }
      }
    }
  }

  return { effectiveTierModels, overlaysApplied };
}

// ─── Main Entry Point ─────────────────────────────────────

/**
 * Get the effective tier models based on quota band selection.
 * This is the main function called by consumption-intelligence.ts
 * and the gateway routing logic.
 *
 * When feature flag is OFF:
 *   - ALWAYS calculates and exports observability data (band, matrixVariant, etc.)
 *   - Uses current/baseline matrix from v04_config.json (bit-identical routing to 0.6.x)
 *   - Sets reason = "flag_off", matrixVariant = "current", overlaysApplied = []
 * When feature flag is ON:
 *   - Returns effective matrix based on quota bands + overlays
 *   - Includes observability metadata
 */
export async function getEffectiveTierModels(): Promise<QuotaBandSelection | null> {
  try {
    // Get quota percentages (always, for observability)
    const providerPcts = getProviderQuotaPercentages();

    // Compute max% across all providers
    const validPcts = providerPcts.filter(p => p.maxPct !== null).map(p => p.maxPct!);
    
    // Determine band and window
    let band: QuotaBand;
    let maxPct: number;
    let window: 'fiveHour' | 'weekly' | 'none';
    
    if (validPcts.length === 0) {
      // No quota data available
      band = 'yellow';
      maxPct = 0;
      window = 'none';
    } else {
      maxPct = Math.max(...validPcts);
      band = selectBand(maxPct);
      
      // Determine window preference (5h preferred, weekly fallback)
      const fiveHourProviders = providerPcts.filter(p => p.window === 'fiveHour');
      window = fiveHourProviders.length > 0 ? 'fiveHour' : 'weekly';
    }

    // Determine quota coverage
    const knownProviders = providerPcts.filter(p => p.maxPct !== null);
    const unknownProviders = providerPcts.filter(p => p.maxPct === null).map(p => p.provider);
    const quotaCoverage: 'full' | 'partial' | 'none' =
      unknownProviders.length === 0 ? 'full' :
      knownProviders.length > 0 ? 'partial' : 'none';

    // Feature flag check
    if (!isQuotaBandMatrixEnabled()) {
      // Flag OFF: use current/baseline matrix from v04_config.json
      const baselineConfig = getConfig();
      
      return {
        band,
        matrixVariant: 'current',
        maxProviderPct: maxPct,
        window,
        providerPcts,
        overlaysApplied: [],
        quotaCoverage,
        unknownProviders,
        reason: 'flag_off',
        effectiveTierModels: baselineConfig.tier_models,
      };
    }

    // Flag ON: apply quota-band matrix logic
    const matrices = await loadMatrices();
    
    if (validPcts.length === 0) {
      // No quota data available — use Yellow band as fallback
      const yellowMatrix = matrices.bands.yellow.tier_models;
      return {
        band: 'yellow',
        matrixVariant: 'yellow_no_quota_data',
        maxProviderPct: 0,
        window: 'none',
        providerPcts,
        overlaysApplied: [],
        quotaCoverage: 'none',
        unknownProviders,
        reason: 'missing_quota',
        effectiveTierModels: yellowMatrix,
      };
    }

    // Get base matrix for selected band
    const baseTierModels = matrices.bands[band].tier_models;

    // Apply provider overlays
    const { effectiveTierModels, overlaysApplied } = applyProviderOverlays(
      baseTierModels,
      providerPcts,
      matrices,
    );

    const matrixVariant = overlaysApplied.length > 0
      ? `${band}_${overlaysApplied.join('_')}`
      : band;

    return {
      band,
      matrixVariant,
      maxProviderPct: maxPct,
      window,
      providerPcts,
      overlaysApplied,
      quotaCoverage,
      unknownProviders,
      reason: 'quota_based_selection',
      effectiveTierModels,
    };
  } catch (err) {
    console.error(`❌ [QuotaBandMatrix] Error computing effective tier models:`, (err as Error).message);
    // On error, return null so caller uses default Yellow matrix
    return null;
  }
}

/**
 * Get effective tier model for a specific tier.
 * Convenience function that extracts a single tier from getEffectiveTierModels().
 */
export async function getEffectiveTierModel(tier: EffortLevel): Promise<TierModelConfig | null> {
  const selection = await getEffectiveTierModels();
  if (!selection) return null;
  return selection.effectiveTierModels[tier] || null;
}
