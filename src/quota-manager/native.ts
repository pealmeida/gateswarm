/**
 * Native quota router runtime — lives INSIDE the gateway process (no external process required).
 *
 *  - holds quota-manager state in memory, refreshed on an internal unref'd timer (fail-open: errors keep the last good state);
 *  - records per-provider outcomes (errors/latency/requests) for routing;
 *  - learns %-of-quota per request live (per provider/window/tier) and appends 'live' calibration records;
 *  - decides the per-request chain (GATESWARM_DYNAMIC_ROUTING=off|shadow|on) via the pure router;
 *  - periodically proposes a tier_models diff (never applied).
 * Logs contain tier/provider/model/reasons only — never prompt text.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeStates, estimateCostPerRequest, parseTime, sameReset, type CalibrationRecord, type ProviderState, type WindowName } from './core.js';
import { loadConfig, paths, pythonCollector, readCalibration, readSync, tick, type ManagerStateFile, type Paths } from './runtime.js';
import { candKey, getDynamicRoutingMode, reasonHeader, routeDynamic, type Cand, type ProviderStats, type RouteResult, type RoutingMode } from './dynamic-router.js';

const WINDOW_5H = 5 * 3600_000;
interface Ev { t: number; ok: boolean; latencyMs: number | null }
interface Acc { pct0: number; resetAt: string | null; reqs: number; tokens: number; tiers: Set<string> }

export interface DecideArgs {
  tier: string; primary: Cand; fallbacks: Cand[]; highRisk: boolean; mode?: RoutingMode;
  breakerOpen: (provider: string) => boolean; now?: number;
}
export interface DecideOut { mode: RoutingMode; applied: boolean; result: RouteResult | null; primary: Cand; fallbacks: Cand[]; header: string; latencyUs: number; staleState: boolean }

export class NativeQuotaRuntime {
  private p: Paths;
  private states: Record<string, ProviderState> = {};
  private calibration: CalibrationRecord[] = [];
  private managerState: ManagerStateFile | null = null;
  private events = new Map<string, Ev[]>();
  private acc = new Map<string, Acc>(); // key provider|window
  private pendingTiers = new Map<string, Map<string, number>>(); // provider -> tier -> requests since last refresh
  private prev = new Map<string, { primary: string; at: number }>();
  private tick_ = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private lastRefreshAt = 0;
  private lastRefreshError: string | null = null;
  private lastOptimizerAt = 0;
  private optimizerProposal: unknown = null;
  private decisions = { total: 0, changed: 0, primaryChanged: 0, explored: 0, appliedChanged: 0, latencyUsSum: 0, latencyUsMax: 0 };
  private logPath: string;
  private tierChains: () => Record<string, { primary: Cand; fallbacks: Cand[] }> = () => ({});

  constructor(private env: NodeJS.ProcessEnv = process.env, root?: string) {
    this.p = paths(root ?? env.GATESWARM_ROOT);
    this.logPath = join(this.p.data, 'dynamic-routing.jsonl');
  }

  get mode(): RoutingMode { return getDynamicRoutingMode(this.env); }
  setTierChains(fn: () => Record<string, { primary: Cand; fallbacks: Cand[] }>): void { this.tierChains = fn; }

  // ─── lifecycle ────────────────────────────────────────
  async start(): Promise<void> {
    await this.refresh();
    const every = Number(this.env.GATESWARM_QUOTA_REFRESH_MS ?? 60_000);
    if (every > 0) this.timers.push(setInterval(() => { void this.refresh(); }, every).unref());
    // Optional in-process collection (CodexBar via scripts/quota-sync.py). Off by default: the standalone supervisor does it.
    if (String(this.env.GATESWARM_QUOTA_COLLECT ?? 'off').toLowerCase() === 'on') {
      const cfg = loadConfig(this.env); const deps = { now: () => Date.now(), collect: pythonCollector(this.p.root, this.env) };
      const run = () => { void tick(this.p, deps, cfg).catch(() => undefined); };
      this.timers.push(setInterval(run, cfg.idleIntervalSec * 1000).unref());
    }
    const optEvery = Number(this.env.GATESWARM_OPTIMIZER_MS ?? 1_800_000);
    if (optEvery > 0) this.timers.push(setInterval(() => { void this.optimize(); }, optEvery).unref());
  }
  stop(): void { for (const t of this.timers) clearInterval(t); this.timers = []; }

  /** Reads sync + calibration + manager state. Never throws; keeps last good state on failure. */
  async refresh(now = Date.now()): Promise<void> {
    try {
      const cfg = loadConfig(this.env);
      const prevStates = this.states;
      const sync = await readSync(this.p);
      const list = computeStates(sync, now, { maxAgeMin: cfg.maxAgeMin });
      this.states = Object.fromEntries(list.map((s) => [s.provider, s]));
      this.calibration = await readCalibration(this.p);
      try { this.managerState = JSON.parse(await fs.readFile(this.p.state, 'utf8')) as ManagerStateFile; } catch { /* optional */ }
      await this.learn(prevStates, this.states, now);
      this.lastRefreshAt = now; this.lastRefreshError = null;
    } catch (e) { this.lastRefreshError = (e as Error).message?.slice(0, 120) ?? 'refresh failed'; }
  }

  // ─── observations ─────────────────────────────────────
  observe(provider: string, ok: boolean, latencyMs?: number | null, tier?: string): void {
    const now = Date.now();
    const arr = this.events.get(provider) ?? []; arr.push({ t: now, ok, latencyMs: latencyMs ?? null });
    const cut = now - WINDOW_5H; while (arr.length && arr[0].t < cut) arr.shift(); if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    this.events.set(provider, arr);
    if (ok && tier) { const m = this.pendingTiers.get(provider) ?? new Map<string, number>(); m.set(tier, (m.get(tier) ?? 0) + 1); this.pendingTiers.set(provider, m); }
  }
  statsOf = (provider: string): ProviderStats | null => {
    const arr = this.events.get(provider); if (!arr?.length) return null;
    const cut = Date.now() - WINDOW_5H; const live = arr.filter((e) => e.t >= cut);
    if (!live.length) return null;
    const lat = live.filter((e) => e.ok && e.latencyMs != null).map((e) => e.latencyMs as number).sort((a, b) => a - b);
    return { samples: live.length, errorRate: live.filter((e) => !e.ok).length / live.length, p50LatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null, requests5h: live.length };
  };

  /** Live calibration: accumulate requests between refreshes; emit a record when the provider's % moved >= 2 pts (whole-percent resolution). */
  private async learn(prev: Record<string, ProviderState>, cur: Record<string, ProviderState>, now: number): Promise<void> {
    const out: CalibrationRecord[] = [];
    for (const [prov, st] of Object.entries(cur)) {
      const pend = this.pendingTiers.get(prov);
      const reqsNow = pend ? [...pend.values()].reduce((a, b) => a + b, 0) : 0;
      for (const w of st.windows) {
        if (w.usedPct == null || st.confidence === 'unknown') continue;
        const key = `${prov}|${w.name}`;
        let a = this.acc.get(key);
        if (a && !sameReset(a.resetAt, w.resetAt)) a = undefined; // window rolled over
        if (!a) { a = { pct0: w.usedPct, resetAt: w.resetAt, reqs: 0, tokens: 0, tiers: new Set() }; this.acc.set(key, a); }
        a.reqs += reqsNow; if (pend) for (const t of pend.keys()) a.tiers.add(t);
        const d = Math.round((w.usedPct - a.pct0) * 10) / 10;
        if (d < 0) { this.acc.delete(key); continue; }
        if (d >= 2 && a.reqs > 0) {
          out.push({ schema_version: 'quota-calibration.v1', ts: new Date(now).toISOString(), source: 'live', provider: prov, window: w.name as WindowName, tiers: [...a.tiers], requests: a.reqs, tokens: a.tokens, deltaPct: d, pctPerRequest: Math.round((d / a.reqs) * 1000) / 1000, pctPer1kTokens: null, lowResolution: d < 2, confidence: st.confidence });
          this.acc.set(key, { pct0: w.usedPct, resetAt: w.resetAt, reqs: 0, tokens: 0, tiers: new Set() });
        } else if (d >= 2) this.acc.set(key, { pct0: w.usedPct, resetAt: w.resetAt, reqs: 0, tokens: 0, tiers: new Set() }); // moved by other consumers: not attributable
      }
    }
    this.pendingTiers.clear();
    void prev;
    if (out.length) {
      try { await fs.mkdir(this.p.data, { recursive: true }); await fs.appendFile(this.p.calibration, out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'); this.calibration.push(...out); } catch { /* fail-open */ }
    }
  }

  bandOf = (provider: string) => this.states[provider]?.band ?? 'unknown';

  costOf = (provider: string, tier: string): number | null => {
    const st = this.states[provider];
    const lw = (st?.limitingWindow ?? '7d') as WindowName;
    const e = estimateCostPerRequest(this.calibration, provider, lw, tier) ?? estimateCostPerRequest(this.calibration, provider, lw);
    return e && e.requests >= 3 && e.pctPerRequest > 0 ? e.pctPerRequest : null;
  };

  private jevRelieve = (provider: string): boolean => {
    const row = this.managerState?.lastSurvey?.analysis?.providers?.find((p) => p.provider === provider);
    return row?.jevStance === 'reduce_load';
  };

  // ─── decision ─────────────────────────────────────────
  decide(a: DecideArgs): DecideOut {
    const mode = a.mode ?? this.mode;
    const t0 = process.hrtime.bigint();
    const now = a.now ?? Date.now();
    const empty: DecideOut = { mode, applied: false, result: null, primary: a.primary, fallbacks: a.fallbacks, header: '', latencyUs: 0, staleState: false };
    if (mode === 'off') return empty;
    try {
      const n = (this.tick_.get(a.tier) ?? 0) + 1; this.tick_.set(a.tier, n);
      const prev = this.prev.get(a.tier) ?? null;
      const stale = !this.lastRefreshAt || now - this.lastRefreshAt > 5 * 60_000;
      const r = routeDynamic({
        tier: a.tier, chain: [a.primary, ...a.fallbacks], states: this.states, statsOf: this.statsOf, costOf: this.costOf,
        breakerOpen: a.breakerOpen, jevRelieve: this.jevRelieve, highRisk: a.highRisk, now, prev, exploreTick: n, env: this.env,
      });
      const applied = mode === 'on';
      const newPrimary = r.chain[0];
      if (!prev || prev.primary !== candKey(newPrimary)) this.prev.set(a.tier, { primary: candKey(newPrimary), at: now });
      const latencyUs = Number((process.hrtime.bigint() - t0) / 1000n);
      this.decisions.total++; this.decisions.latencyUsSum += latencyUs; this.decisions.latencyUsMax = Math.max(this.decisions.latencyUsMax, latencyUs);
      if (r.changed) this.decisions.changed++; if (r.primaryChanged) this.decisions.primaryChanged++; if (r.explored) this.decisions.explored++;
      if (applied && r.changed) this.decisions.appliedChanged++;
      const header = reasonHeader(r);
      if (r.changed || this.decisions.total % 20 === 1) this.log({ ts: new Date(now).toISOString(), mode, tier: a.tier, highRisk: a.highRisk, static: [a.primary, ...a.fallbacks].map(candKey), dynamic: r.chain.map(candKey), changed: r.changed, primaryChanged: r.primaryChanged, explored: r.explored, forced: r.forced, reasons: r.reasons, latencyUs, staleState: stale });
      return { mode, applied, result: r, primary: applied ? r.chain[0] : a.primary, fallbacks: applied ? r.chain.slice(1) : a.fallbacks, header, latencyUs, staleState: stale };
    } catch { return empty; } // fail-open: static chain
  }

  private log(row: Record<string, unknown>): void {
    void fs.mkdir(dirname(this.logPath), { recursive: true }).then(() => fs.appendFile(this.logPath, JSON.stringify(row) + '\n', 'utf8')).catch(() => undefined);
  }

  // ─── optimizer: proposes tier_models diff, never applied ──
  async optimize(now = Date.now()): Promise<unknown> {
    try {
      const chains = this.tierChains(); const lines: string[] = []; const tiers: Record<string, unknown> = {};
      for (const [tier, c] of Object.entries(chains)) {
        const r = routeDynamic({ tier, chain: [c.primary, ...c.fallbacks], states: this.states, statsOf: this.statsOf, costOf: this.costOf, breakerOpen: () => false, jevRelieve: this.jevRelieve, highRisk: false, now, prev: null, exploreTick: 0, env: this.env });
        tiers[tier] = { static: [c.primary, ...c.fallbacks].map(candKey), proposed: r.chain.map(candKey), changed: r.changed, reasons: r.reasons };
        if (r.changed) { lines.push(`--- tier_models.${tier}`, `-  ${[c.primary, ...c.fallbacks].map(candKey).join(' > ')}`, `+  ${r.chain.map(candKey).join(' > ')}`, `#  ${r.reasons.join(' | ')}`); }
      }
      this.optimizerProposal = { generatedAt: new Date(now).toISOString(), applied: false, note: 'proposal only; never applied automatically', tiers, diff: lines.join('\n') };
      this.lastOptimizerAt = now;
      await fs.mkdir(join(this.p.data, 'quota-manager'), { recursive: true });
      await fs.writeFile(join(this.p.data, 'quota-manager', 'optimizer-proposal.json'), JSON.stringify(this.optimizerProposal, null, 2), 'utf8');
    } catch { /* fail-open */ }
    return this.optimizerProposal;
  }

  // ─── exposure ─────────────────────────────────────────
  snapshot() {
    const d = this.decisions;
    return {
      mode: this.mode, lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null, lastRefreshError: this.lastRefreshError,
      ageSec: this.lastRefreshAt ? Math.round((Date.now() - this.lastRefreshAt) / 1000) : null,
      providers: Object.values(this.states).map((s) => ({ provider: s.provider, band: s.band, maxUsedPct: s.maxUsedPct, confidence: s.confidence, method: s.method, headroomPct: s.headroomPct, willExhaustBeforeReset: s.willExhaustBeforeReset, stale: s.stale })),
      decisions: { ...d, avgLatencyUs: d.total ? Math.round(d.latencyUsSum / d.total) : 0 },
      calibrationRecords: this.calibration.length, optimizerAt: this.lastOptimizerAt ? new Date(this.lastOptimizerAt).toISOString() : null,
    };
  }
  getOptimizerProposal(): unknown { return this.optimizerProposal; }
  /** test helper */
  _setState(states: ProviderState[], calibration: CalibrationRecord[] = []): void { this.states = Object.fromEntries(states.map((s) => [s.provider, s])); this.calibration = calibration; this.lastRefreshAt = Date.now(); }
}

export const nativeQuota = new NativeQuotaRuntime();
void parseTime;
