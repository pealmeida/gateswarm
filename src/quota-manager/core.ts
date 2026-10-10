/**
 * Quota manager — pure logic (no IO). Turns quota-sync snapshots into per-provider states
 * (band, reset, headroom, projection, method + confidence), runs battery pre-checks and estimates calibration cost.
 *
 * Rules: stale (> maxAgeMin) or unmeasured data is "unknown", NEVER 0. No account identifiers are kept.
 */

export type MgrBand = 'green' | 'yellow' | 'orange' | 'red' | 'unknown';
export type WindowName = '5h' | '7d' | '30d';
/** measured = provider-reported % (CodexBar/CLI/API); estimated = gateway consumption vs configured limit; unknown = neither. */
export type Confidence = 'measured' | 'estimated' | 'unknown';

export interface SyncWindow { usedPct?: number | null; resetAt?: string | null; windowMinutes?: number | null; usedTokens?: number; usedRequests?: number; limitTokens?: number | null }
export interface SyncSnapshot { provider?: string; syncedAt?: string; source?: string; plan?: string | null; note?: string; error?: string; unmetered?: boolean; windows?: Record<string, SyncWindow> }
export interface SyncFile { snapshots?: Record<string, SyncSnapshot> }

export interface WindowState {
  name: WindowName;
  usedPct: number | null;
  resetAt: string | null;
  windowMinutes: number | null;
  minutesToReset: number | null;
  /** Linear projection of usedPct at reset. >100 means it will run out first. */
  projectedPctAtReset: number | null;
  headroomPct: number | null;
}

export interface ProviderState {
  provider: string;
  plan: string | null;
  /** how the number was obtained, e.g. codexbar-cli, codexbar-api, consumption-history, local-unmetered, none */
  method: string;
  confidence: Confidence;
  syncedAt: string | null;
  ageMin: number | null;
  stale: boolean;
  band: MgrBand;
  maxUsedPct: number | null;
  limitingWindow: WindowName | null;
  headroomPct: number | null;
  willExhaustBeforeReset: boolean;
  windows: WindowState[];
  /** what is needed to measure this provider properly (empty when measured) */
  missing: string[];
  note: string | null;
}

/** [yellow, orange, red] lower bounds in % — mirrors the per-provider bands of the quota-band matrix. */
export const DEFAULT_THRESHOLDS: Record<string, [number, number, number]> = {
  'claude-cli': [40, 60, 80],
  'codex-cli': [50, 70, 85],
  zai: [50, 70, 85],
  bailian: [60, 80, 90],
};
export const FALLBACK_THRESHOLDS: [number, number, number] = [40, 70, 85];
export const KNOWN_PROVIDERS = ['claude-cli', 'codex-cli', 'zai', 'bailian', 'ollama'];
/** Where to move load when a provider is tight (generic, no accounts). */
export const ALTERNATIVES: Record<string, string[]> = {
  'claude-cli': ['codex-cli', 'bailian'],
  'codex-cli': ['claude-cli', 'bailian'],
  zai: ['bailian'],
  bailian: ['zai'],
  ollama: [],
};
export const DEFAULT_MAX_AGE_MIN = 15;

/** What each provider needs for a *measured* reading. */
const MISSING_HINTS: Record<string, string> = {
  'claude-cli': 'CodexBar binary (scripts/install-codexbar.sh + GATESWARM_CODEXBAR_BIN) and a logged-in Claude CLI',
  'codex-cli': 'CodexBar binary (scripts/install-codexbar.sh + GATESWARM_CODEXBAR_BIN) and a logged-in Codex CLI',
  zai: 'Z_AI_API_KEY in the collector environment (CodexBar api source) — or set GATESWARM_QUOTA_ZAI_5H_TOKENS/_7D_TOKENS for an estimate',
  bailian: 'logged-in `bl` CLI + GATESWARM_CODEXBAR_BAILIAN=1 — or set GATESWARM_QUOTA_BAILIAN_30D_TOKENS (+ GATESWARM_BAILIAN_CYCLE_START_DAY) for an estimate',
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function bandFor(provider: string, maxPct: number | null, thresholds = DEFAULT_THRESHOLDS): MgrBand {
  if (maxPct === null) return 'unknown';
  const [y, o, r] = thresholds[provider] ?? FALLBACK_THRESHOLDS;
  return maxPct >= r ? 'red' : maxPct >= o ? 'orange' : maxPct >= y ? 'yellow' : 'green';
}

export function parseTime(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s.replace('+00:00Z', 'Z')); // tolerate the legacy malformed "+00:00Z"
  return Number.isNaN(t) ? null : t;
}

export function computeProviderState(provider: string, snap: SyncSnapshot | undefined, now: number, opts: { maxAgeMin?: number; thresholds?: typeof DEFAULT_THRESHOLDS } = {}): ProviderState {
  const maxAge = opts.maxAgeMin ?? DEFAULT_MAX_AGE_MIN;
  const syncedMs = parseTime(snap?.syncedAt);
  const ageMin = syncedMs === null ? null : Math.max(0, r1((now - syncedMs) / 60_000));
  const stale = !snap || ageMin === null || ageMin > maxAge;
  const unmetered = provider === 'ollama' || snap?.unmetered === true;
  const windows: WindowState[] = [];
  for (const name of ['5h', '7d', '30d'] as WindowName[]) {
    const w = snap?.windows?.[name];
    if (!w) continue;
    const resetMs = parseTime(w.resetAt);
    const resetPassed = resetMs !== null && resetMs < now;
    const used = !stale && !resetPassed && finite(w.usedPct) ? r1(w.usedPct) : null; // stale / past-reset => unknown, not 0
    const wm = finite(w.windowMinutes) && w.windowMinutes > 0 ? w.windowMinutes : null;
    const mtr = resetMs !== null && !resetPassed ? Math.round((resetMs - now) / 60_000) : null;
    let projected: number | null = null;
    if (used !== null && wm !== null && mtr !== null) {
      const elapsed = Math.min(wm, Math.max(0, wm - mtr));
      if (elapsed >= Math.max(15, wm * 0.1)) projected = r1((used * wm) / elapsed); // too early => noise
    }
    windows.push({ name, usedPct: used, resetAt: resetMs !== null ? new Date(resetMs).toISOString() : null, windowMinutes: wm, minutesToReset: mtr, projectedPctAtReset: projected, headroomPct: used === null ? null : r1(Math.max(0, 100 - used)) });
  }
  const measuredW = windows.filter((w) => w.usedPct !== null);
  let limiting: WindowState | null = null;
  for (const w of measuredW) if (!limiting || (w.usedPct as number) > (limiting.usedPct as number)) limiting = w;
  const maxUsed = limiting ? (limiting.usedPct as number) : null;
  const method = unmetered ? 'local-unmetered' : snap?.source ?? 'none';
  let confidence: Confidence = 'unknown';
  if (unmetered) confidence = 'measured';
  else if (maxUsed !== null) confidence = method.startsWith('codexbar') ? 'measured' : 'estimated';
  let note = snap?.note ?? (snap?.error ? `last collection failed (${snap.error})` : null);
  if (unmetered) note = 'local model: no quota (requests counted by the gateway only)';
  else if (!snap) note = 'no snapshot';
  else if (stale && ageMin !== null) note = `stale (${ageMin} min > ${maxAge})${note ? '; ' + note : ''}`;
  return {
    provider, plan: snap?.plan ?? null, method, confidence, syncedAt: syncedMs === null ? null : new Date(syncedMs).toISOString(),
    ageMin, stale, band: unmetered ? 'green' : bandFor(provider, maxUsed, opts.thresholds), maxUsedPct: maxUsed, limitingWindow: limiting?.name ?? null,
    headroomPct: unmetered ? null : maxUsed === null ? null : r1(Math.max(0, 100 - maxUsed)),
    willExhaustBeforeReset: measuredW.some((w) => (w.projectedPctAtReset ?? 0) > 100), windows,
    missing: confidence === 'measured' ? [] : [MISSING_HINTS[provider] ?? 'a usage source'], note,
  };
}

export function computeStates(sync: SyncFile | null | undefined, now: number, opts: { maxAgeMin?: number; providers?: string[] } = {}): ProviderState[] {
  const names = new Set([...(opts.providers ?? KNOWN_PROVIDERS), ...Object.keys(sync?.snapshots ?? {})]);
  return [...names].map((p) => computeProviderState(p, sync?.snapshots?.[p], now, opts));
}

// ─── Calibration ─────────────────────────────────────────

export interface CalibrationRecord {
  schema_version: 'quota-calibration.v1';
  ts: string;
  source: 'battery' | 'survey';
  battery?: string;
  provider: string;
  window: WindowName;
  tiers: string[];
  requests: number;
  tokens: number;
  deltaPct: number;
  pctPerRequest: number;
  pctPer1kTokens: number | null;
  /** deltaPct < 2: providers report whole percents, so the ratio is coarse. */
  lowResolution: boolean;
  confidence: Confidence;
}

/** Weighted estimate (sum delta / sum requests) per provider + window; optionally only records covering a tier. */
export function estimateCostPerRequest(records: CalibrationRecord[], provider: string, window: WindowName, tier?: string): { pctPerRequest: number; samples: number; requests: number } | null {
  const rs = records.filter((r) => r.provider === provider && r.window === window && r.requests > 0 && (!tier || r.tiers.includes(tier)));
  const req = rs.reduce((a, r) => a + r.requests, 0);
  if (!req) return null;
  const d = rs.reduce((a, r) => a + r.deltaPct, 0);
  return { pctPerRequest: Math.round((d / req) * 1000) / 1000, samples: rs.length, requests: req };
}

// ─── Battery pre-check ───────────────────────────────────

export interface PrecheckInput { states: ProviderState[]; need: string[]; plannedRequests?: Record<string, number>; calibration?: CalibrationRecord[] }
export interface PrecheckWarning { provider: string; level: 'info' | 'warn' | 'critical'; code: 'red' | 'orange' | 'unknown' | 'estimated' | 'will_exhaust' | 'insufficient_headroom' | 'no_estimate'; message: string }
export interface PrecheckResult { ok: boolean; warnings: PrecheckWarning[]; proposals: string[]; estimates: Record<string, { estimatedPct: number | null; headroomPct: number | null; fits: boolean | null }> }

export function precheck(i: PrecheckInput): PrecheckResult {
  const byProv = new Map(i.states.map((s) => [s.provider, s]));
  const warnings: PrecheckWarning[] = [];
  const proposals: string[] = [];
  const estimates: PrecheckResult['estimates'] = {};
  const usable = (p: string) => { const s = byProv.get(p); return !!s && (s.band === 'green' || s.band === 'yellow'); };
  for (const p of i.need) {
    const s = byProv.get(p);
    if (!s || s.band === 'unknown') {
      warnings.push({ provider: p, level: 'warn', code: 'unknown', message: `${p}: no fresh measurement — headroom unknown (not assumed idle)` });
    } else if (s.band === 'red') {
      warnings.push({ provider: p, level: 'critical', code: 'red', message: `${p}: RED (${s.maxUsedPct}% in ${s.limitingWindow}, ${s.confidence})` });
    } else if (s.band === 'orange') {
      warnings.push({ provider: p, level: 'warn', code: 'orange', message: `${p}: ORANGE (${s.maxUsedPct}% in ${s.limitingWindow}, ${s.confidence})` });
    }
    if (s && s.confidence === 'estimated') warnings.push({ provider: p, level: 'info', code: 'estimated', message: `${p}: value is an ESTIMATE from gateway consumption vs configured limits` });
    if (s?.willExhaustBeforeReset) warnings.push({ provider: p, level: 'warn', code: 'will_exhaust', message: `${p}: at the current pace the quota runs out before reset` });
    const reqs = i.plannedRequests?.[p];
    let est: number | null = null; let head = s?.headroomPct ?? null; let fits: boolean | null = null;
    if (reqs && reqs > 0 && s) {
      let any = false;
      for (const w of s.windows) {
        if (w.headroomPct === null) continue;
        const c = estimateCostPerRequest(i.calibration ?? [], p, w.name);
        if (!c) continue;
        any = true;
        const e = Math.round(c.pctPerRequest * reqs * 10) / 10;
        const f = e <= w.headroomPct;
        if (fits === null || (fits && !f) || (f === fits && e / Math.max(w.headroomPct, 0.1) > (est ?? 0) / Math.max(head ?? 0.1, 0.1))) { est = e; head = w.headroomPct; }
        fits = fits === false ? false : f;
        if (!f) warnings.push({ provider: p, level: 'critical', code: 'insufficient_headroom', message: `${p}: estimated cost ${e}% in ${w.name} > headroom ${w.headroomPct}%` });
      }
      if (!any && s.headroomPct !== null) warnings.push({ provider: p, level: 'info', code: 'no_estimate', message: `${p}: no calibration yet for ${reqs} planned requests (this battery will create it)` });
    }
    estimates[p] = { estimatedPct: est, headroomPct: head, fits };
    if (s && (s.band === 'red' || s.band === 'orange' || fits === false)) {
      const alts = (ALTERNATIVES[p] ?? []).filter(usable);
      proposals.push(alts.length ? `reduce load on ${p} (or move its tiers to ${alts.join(' / ')}, which have headroom)` : `reduce load on ${p}; no alternative provider has headroom`);
    }
  }
  return { ok: !warnings.some((w) => w.level === 'critical'), warnings, proposals, estimates };
}

/** Reset timestamps jitter by seconds between collections; a real roll-over moves them by far more. */
export function sameReset(a: string | null, b: string | null, toleranceMin = 10): boolean {
  if (a === b) return true;
  const x = parseTime(a), y = parseTime(b);
  return x !== null && y !== null && Math.abs(x - y) <= toleranceMin * 60_000;
}
