/**
 * Quota analysis layer (report + proposed tier_models diff — NEVER applied automatically).
 *
 * Reads quota-sync.json, provider-quota.json, consumption-history.json and provider-health.json
 * (plain files, no singletons), computes per provider usage / headroom / pace for the 5h, 7d and
 * monthly windows plus 429 / error rates, then proposes how to redistribute tiers between providers
 * to use idle quota (e.g. Bailian monthly credits) and protect scarce quota (Claude / Codex / Z.AI).
 *
 * Decision model:
 *  - The LOCAL rule always decides first and always produces a complete result.
 *  - Jev (GATESWARM_JEV_DECISIONS=advise|enforce, with GATESWARM_JEV_MODE=shadow) is asked about aggregated,
 *    metadata-only features (percentages, pace, rates, band, provider class). It may only HARDEN:
 *      * provider stance: increase_load -> hold -> reduce_load (never softer than local)
 *      * move review: veto a local move (keep the status quo).
 *    The report carries both `diffLocal` and `diffJev`; neither is applied by this module.
 *  - No prompt text, keys or hosts are ever sent or logged. Any Jev failure => local result only.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JEV_PRICE_USD_PER_MTOK_INPUT } from './questions.js';
import { createJevChoiceFn, getJevDecisionsMode, type JevChoiceFn, type JevDecisionsMode } from './quota-advisor.js';

// ─── Types ───────────────────────────────────────────────
export type Stance = 'increase_load' | 'hold' | 'reduce_load';
export type ProviderClass = 'abundant_credit' | 'scarce_window' | 'scarce_subscription' | 'free_local' | 'unknown';
export type QuotaBandName = 'green' | 'yellow' | 'orange' | 'red';

export interface TierFallback { provider: string; model: string }
export interface TierRowCfg {
  provider: string; model: string; fallback_models?: TierFallback[];
  plan_provider?: string; plan_model?: string; [k: string]: unknown;
}
export type TierModels = Record<string, TierRowCfg>;

export interface HourBucket { hourStart: number; requests: number; tokensIn: number; tokensOut: number; cost?: number; latencySum?: number; latencyCount?: number; errors: number }
export interface QuotaAnalysisInput {
  now: number;
  tierModels: TierModels;
  quotaSync?: { snapshots?: Record<string, { windows?: Record<string, { usedPct: number | null; usedTokens?: number; limitTokens?: number }> }> } | null;
  providerQuota?: { quotas?: Record<string, { rateLimitHits?: number; requestsToday?: number; totalRequests?: number; healthScore?: number; breakerUntil?: number; throttled?: boolean }> } | null;
  history?: { providers?: Record<string, { buckets?: Record<string, HourBucket> }> } | null;
  health?: { cooldowns?: Array<{ providerId?: string; provider?: string; unhealthyUntil?: number }> } | null;
  /** Optional plan limits per provider/window (tokens). Never committed; supplied via file/env. */
  limits?: Record<string, Partial<Record<'5h' | '7d' | '30d', number>>> | null;
  classes?: Record<string, ProviderClass>;
  cycleStartDay?: number;
}

export interface WindowStat { tokens: number; requests: number; errors: number; usedPct: number | null; pctSource: 'quota_sync' | 'limits' | 'unknown' }
export interface ProviderAnalysis {
  provider: string;
  class: ProviderClass;
  w5h: WindowStat; w7d: WindowStat; w30d: WindowStat;
  maxPct: number | null;
  band: QuotaBandName | 'unknown';
  tokenShare7dPct: number;
  /** tokens/h over the last 5h divided by tokens/h over the observed 7d span; null when too little history. */
  paceRatio: number | null;
  monthlyPace: number | null;
  errorRate7dPct: number;
  rateLimitHits: number;
  avgLatencyMs: number | null;
  successRate7dPct: number | null;
  healthScore: number | null;
  breakerOpen: boolean;
  unhealthy: boolean;
  historyHours: number;
  idleInferred: boolean;
  headroom: 'ample' | 'ok' | 'tight' | 'none' | 'unknown';
  localStance: Stance;
  localReasons: string[];
  jevStance: Stance | null;
  stance: Stance; // hardened (max of local, jev)
  jevStatus: 'off' | 'skipped' | 'ok';
}

export interface Move { tier: string; field: 'primary' | 'plan'; from: TierFallback; to: TierFallback; reason: 'protect_scarce' | 'use_idle' ; jevVerdict: 'accept' | 'reject' | null; fromLocal: boolean }
export interface QuotaAnalysisReport {
  schema_version: 'quota-analysis.v1';
  generatedAt: string;
  mode: JevDecisionsMode;
  providers: ProviderAnalysis[];
  movesLocal: Move[];
  movesJev: Move[]; // local moves minus Jev vetoes
  diffLocal: string;
  diffJev: string;
  proposedTierModelsLocal: TierModels;
  proposedTierModelsJev: TierModels;
  jev: { calls: number; ok: number; failed: number; agree: number; diverge: number; latencyMsTotal: number; tokensIn: number; costUsd: number };
  notes: string[];
  applied: false;
}

// ─── Constants ───────────────────────────────────────────
const H = 3600_000;
const STANCE_RANK: Record<Stance, number> = { increase_load: 0, hold: 1, reduce_load: 2 };
/** Default provider classes; override with `classes` (generic, not account specific). */
export const DEFAULT_CLASSES: Record<string, ProviderClass> = {
  bailian: 'abundant_credit',
  zai: 'scarce_window',
  'claude-cli': 'scarce_subscription',
  'codex-cli': 'scarce_subscription',
  ollama: 'free_local',
};
const LOW_TIERS = new Set(['trivial', 'light', 'moderate']);
const TOKENS_IDLE_SHARE_PCT = 25;

const maxOf = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? Math.max(...v) : null;
};
const bandOf = (pct: number | null): QuotaBandName | 'unknown' => (pct === null ? 'unknown' : pct < 40 ? 'green' : pct < 70 ? 'yellow' : pct < 85 ? 'orange' : 'red');
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function sumWindow(buckets: HourBucket[], from: number): { tokens: number; requests: number; errors: number; latSum: number; latCnt: number } {
  let tokens = 0, requests = 0, errors = 0, latSum = 0, latCnt = 0;
  for (const b of buckets) if (b.hourStart + H > from) { tokens += (b.tokensIn || 0) + (b.tokensOut || 0); requests += b.requests || 0; errors += b.errors || 0; latSum += b.latencySum || 0; latCnt += b.latencyCount || 0; }
  return { tokens, requests, errors, latSum, latCnt };
}

// ─── Local analysis ──────────────────────────────────────
export function monthlyPace(usedPct: number | null, now: number, cycleStartDay?: number): number | null {
  if (usedPct === null || !cycleStartDay || cycleStartDay < 1 || cycleStartDay > 28) return null;
  const d = new Date(now);
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), cycleStartDay);
  if (start > now) start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, cycleStartDay);
  const elapsedPct = ((now - start) / (30 * 24 * H)) * 100;
  return elapsedPct < 5 ? null : usedPct / Math.min(elapsedPct, 100);
}

/** Pure local stance rule. Scarce providers are never asked to take more load. */
export function localStance(p: Omit<ProviderAnalysis, 'localStance' | 'localReasons' | 'jevStance' | 'stance' | 'jevStatus'>): { stance: Stance; reasons: string[] } {
  const r: string[] = [];
  const scarce = p.class === 'scarce_window' || p.class === 'scarce_subscription';
  if (p.breakerOpen) r.push('breaker_open');
  if (p.unhealthy) r.push('in_health_cooldown');
  if (p.maxPct !== null && p.maxPct >= 70) r.push(`pct_${Math.round(p.maxPct)}>=70`);
  if (p.monthlyPace !== null && p.monthlyPace >= 1.2) r.push('monthly_pace>=1.2');
  if (scarce && p.paceRatio !== null && p.paceRatio >= 2 && p.w5h.requests >= 10) r.push('pace_5h>=2x');
  if (p.rateLimitHits >= 3) r.push(`rate_limit_hits_${p.rateLimitHits}`);
  if (scarce && p.maxPct === null && p.tokenShare7dPct >= 70 && p.w7d.requests >= 50) r.push('concentrated_load_unknown_limit');
  if (p.errorRate7dPct >= 10 && p.w7d.requests >= 10) r.push(`error_rate_${p.errorRate7dPct}%`);
  if (r.length) return { stance: 'reduce_load', reasons: r };
  if (scarce) {
    if (p.maxPct !== null && p.maxPct >= 40) return { stance: 'hold', reasons: ['scarce_provider_yellow'] };
    return { stance: 'hold', reasons: ['scarce_provider_protected'] };
  }
  if (p.class === 'free_local') return { stance: 'hold', reasons: ['local_cpu_limited'] };
  if (p.class === 'abundant_credit') {
    if (p.maxPct !== null && p.maxPct < 40 && p.successRate7dPct !== null && p.successRate7dPct >= 90) return { stance: 'increase_load', reasons: [`pct_${Math.round(p.maxPct)}<40`, 'healthy'] };
    if (p.maxPct === null && p.idleInferred) return { stance: 'increase_load', reasons: ['idle_inferred(limit_unknown)', 'healthy'] };
    return { stance: 'hold', reasons: ['no_headroom_evidence'] };
  }
  return { stance: 'hold', reasons: ['unknown_class'] };
}

export function analyzeProviders(input: QuotaAnalysisInput): Omit<ProviderAnalysis, 'jevStance' | 'stance' | 'jevStatus'>[] {
  const classes = { ...DEFAULT_CLASSES, ...(input.classes ?? {}) };
  const now = input.now;
  const names = new Set<string>();
  const chainProviders = (t: TierRowCfg) => [t.provider, ...(t.fallback_models ?? []).map((f) => f.provider), ...(t.plan_provider ? [t.plan_provider] : [])];
  for (const t of Object.values(input.tierModels)) chainProviders(t).forEach((p) => names.add(p));
  const allBuckets: Record<string, HourBucket[]> = {};
  for (const [p, c] of Object.entries(input.history?.providers ?? {})) { if (names.has(p)) allBuckets[p] = Object.values(c.buckets ?? {}); }
  const tok7d: Record<string, number> = {};
  for (const n of names) tok7d[n] = sumWindow(allBuckets[n] ?? [], now - 168 * H).tokens;
  const totalTok7d = Object.values(tok7d).reduce((a, b) => a + b, 0);
  const cooldowns = input.health?.cooldowns ?? [];

  return [...names].sort().map((provider) => {
    const buckets = allBuckets[provider] ?? [];
    const w = { '5h': sumWindow(buckets, now - 5 * H), '7d': sumWindow(buckets, now - 168 * H), '30d': sumWindow(buckets, now - 720 * H) };
    const snap = input.quotaSync?.snapshots?.[provider]?.windows ?? {};
    const lim = input.limits?.[provider] ?? {};
    const stat = (k: '5h' | '7d' | '30d'): WindowStat => {
      const s = snap[k];
      let usedPct: number | null = null; let src: WindowStat['pctSource'] = 'unknown';
      if (s && typeof s.usedPct === 'number') { usedPct = s.usedPct; src = 'quota_sync'; }
      else if (typeof lim[k] === 'number' && lim[k]! > 0) { usedPct = round((w[k].tokens / lim[k]!) * 100); src = 'limits'; }
      return { tokens: w[k].tokens, requests: w[k].requests, errors: w[k].errors, usedPct, pctSource: src };
    };
    const w5h = stat('5h'), w7d = stat('7d'), w30d = stat('30d');
    const maxPct = maxOf([w5h.usedPct, w7d.usedPct, w30d.usedPct]);
    const first = buckets.length ? Math.min(...buckets.map((b) => b.hourStart)) : now;
    const historyHours = Math.max(0, Math.min(168, Math.round((now - first) / H)));
    const rate5 = w['5h'].tokens / 5;
    const rate7 = historyHours >= 12 ? w['7d'].tokens / Math.max(historyHours, 5) : 0;
    const paceRatio = rate7 > 0 ? round(rate5 / rate7, 2) : null;
    const pq = input.providerQuota?.quotas?.[provider];
    const breakerOpen = (pq?.breakerUntil ?? 0) > now;
    const unhealthy = cooldowns.some((c) => (c.providerId ?? c.provider) === provider && (c.unhealthyUntil ?? 0) > now);
    const req7 = w['7d'].requests;
    const errRate = req7 ? round((w['7d'].errors / req7) * 100) : 0;
    const share = totalTok7d ? round((tok7d[provider]! / totalTok7d) * 100) : 0;
    const cls = classes[provider] ?? 'unknown';
    const base = {
      provider, class: cls, w5h, w7d, w30d, maxPct, band: bandOf(maxPct), tokenShare7dPct: share, paceRatio,
      monthlyPace: monthlyPace(w30d.usedPct, now, input.cycleStartDay),
      errorRate7dPct: errRate, rateLimitHits: pq?.rateLimitHits ?? 0,
      avgLatencyMs: w['7d'].latCnt ? Math.round(w['7d'].latSum / w['7d'].latCnt) : null,
      successRate7dPct: req7 ? round(100 - errRate) : null,
      healthScore: pq?.healthScore ?? null, breakerOpen, unhealthy, historyHours,
      idleInferred: share < TOKENS_IDLE_SHARE_PCT && errRate < 5 && !breakerOpen && !unhealthy,
      headroom: 'unknown' as ProviderAnalysis['headroom'],
    };
    base.headroom = maxPct === null ? (base.idleInferred && cls === 'abundant_credit' ? 'ample' : 'unknown') : maxPct < 40 ? 'ample' : maxPct < 70 ? 'ok' : maxPct < 85 ? 'tight' : 'none';
    const ls = localStance(base as never);
    return { ...base, localStance: ls.stance, localReasons: ls.reasons };
  });
}

// ─── Moves (local rule) ──────────────────────────────────
const sameTarget = (a: TierFallback, b: TierFallback) => a.provider === b.provider && a.model === b.model;

/** Compute local moves from effective stances. `stanceOf` lets us recompute with Jev-hardened stances. */
export function proposeMoves(tierModels: TierModels, stanceOf: (provider: string) => Stance): Move[] {
  const moves: Move[] = [];
  for (const [tier, row] of Object.entries(tierModels)) {
    const primary: TierFallback = { provider: row.provider, model: row.model };
    const chain = (row.fallback_models ?? []);
    const pStance = stanceOf(primary.provider);
    let chosen: Move | null = null;
    if (pStance === 'reduce_load') {
      const t = chain.find((f) => stanceOf(f.provider) !== 'reduce_load' && f.provider !== primary.provider);
      if (t) chosen = { tier, field: 'primary', from: primary, to: t, reason: 'protect_scarce', jevVerdict: null, fromLocal: true };
    } else if (LOW_TIERS.has(tier) && pStance !== 'increase_load') {
      const t = chain.find((f) => stanceOf(f.provider) === 'increase_load');
      if (t) chosen = { tier, field: 'primary', from: primary, to: t, reason: 'use_idle', jevVerdict: null, fromLocal: true };
    }
    if (chosen) moves.push(chosen);
    // plan model: protect only
    if (row.plan_provider && row.plan_model && stanceOf(row.plan_provider) === 'reduce_load') {
      const t = chain.find((f) => stanceOf(f.provider) === 'increase_load') ?? chain.find((f) => stanceOf(f.provider) !== 'reduce_load' && f.provider !== row.plan_provider);
      if (t) moves.push({ tier, field: 'plan', from: { provider: row.plan_provider, model: row.plan_model }, to: t, reason: 'protect_scarce', jevVerdict: null, fromLocal: true });
    }
  }
  return moves;
}

export function applyMoves(tierModels: TierModels, moves: Move[]): TierModels {
  const out = JSON.parse(JSON.stringify(tierModels)) as TierModels;
  for (const m of moves) {
    const row = out[m.tier]; if (!row) continue;
    if (m.field === 'plan') { row.plan_provider = m.to.provider; row.plan_model = m.to.model; continue; }
    const fb = (row.fallback_models ?? []).filter((f) => !sameTarget(f, m.to));
    row.fallback_models = fb.some((f) => sameTarget(f, m.from)) ? fb : [...fb, m.from]; // promoted target leaves the fallback list; old primary is demoted to the end
    row.provider = m.to.provider; row.model = m.to.model;
  }
  return out;
}

export function renderDiff(before: TierModels, after: TierModels): string {
  const lines: string[] = [];
  const brief = (r: TierRowCfg) => ({ provider: r.provider, model: r.model, fallback_models: (r.fallback_models ?? []).map((f) => `${f.provider}/${f.model}`), plan: r.plan_model ? `${r.plan_provider}/${r.plan_model}` : undefined });
  for (const tier of Object.keys(after)) {
    const a = JSON.stringify(brief(before[tier]!)), b = JSON.stringify(brief(after[tier]!));
    if (a === b) continue;
    const B = brief(before[tier]!), A = brief(after[tier]!);
    lines.push(`@@ tier_models.${tier} @@`);
    if (B.provider !== A.provider || B.model !== A.model) { lines.push(`-  primary: ${B.provider}/${B.model}`); lines.push(`+  primary: ${A.provider}/${A.model}`); }
    if (JSON.stringify(B.fallback_models) !== JSON.stringify(A.fallback_models)) { lines.push(`-  fallbacks: [${B.fallback_models.join(', ')}]`); lines.push(`+  fallbacks: [${A.fallback_models.join(', ')}]`); }
    if (B.plan !== A.plan) { lines.push(`-  plan: ${B.plan}`); lines.push(`+  plan: ${A.plan}`); }
  }
  return lines.length ? lines.join('\n') : '(no changes proposed)';
}

// ─── Jev layer ───────────────────────────────────────────
const ANALYSIS_LOG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'jev-shadow', 'jev-quota-analysis.jsonl');

export interface AnalysisOptions {
  env?: NodeJS.ProcessEnv;
  jev?: JevChoiceFn;
  logPath?: string;
  writeRecord?: (rec: Record<string, unknown>) => void;
  /** USD per million input tokens for the cost estimate (default: questions.ts constant). */
  priceUsdPerMtok?: number;
}

async function logRec(rec: Record<string, unknown>, o: AnalysisOptions, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const full = { schema_version: 'jev-quota-analysis.v1', ts: new Date().toISOString(), ...rec };
    if (o.writeRecord) return void o.writeRecord(full);
    const p = o.logPath ?? env.GATESWARM_JEV_QUOTA_ANALYSIS_LOG ?? ANALYSIS_LOG;
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.appendFile(p, `${JSON.stringify(full)}\n`, 'utf8');
  } catch { /* fail-open */ }
}

const num = (n: number | null): number => (n === null ? -1 : n);

function stanceFeatures(p: Omit<ProviderAnalysis, 'jevStance' | 'stance' | 'jevStatus'>) {
  return {
    provider: p.provider, provider_class: p.class,
    used_pct_5h: num(p.w5h.usedPct), used_pct_7d: num(p.w7d.usedPct), used_pct_30d: num(p.w30d.usedPct),
    quota_band: p.band, pace_ratio_5h_vs_7d: num(p.paceRatio), monthly_pace_ratio: num(p.monthlyPace),
    token_share_7d_pct: p.tokenShare7dPct, error_rate_7d_pct: p.errorRate7dPct, rate_limit_hits: p.rateLimitHits,
    breaker_open: p.breakerOpen, in_health_cooldown: p.unhealthy, idle_inferred: p.idleInferred,
    requests_7d: p.w7d.requests, local_stance: p.localStance,
  };
}

export async function analyzeQuota(input: QuotaAnalysisInput, opts: AnalysisOptions = {}): Promise<QuotaAnalysisReport> {
  const env = opts.env ?? process.env;
  const mode = getJevDecisionsMode(env);
  const base = analyzeProviders(input);
  const jevFn: JevChoiceFn | null = mode === 'off' ? null : (opts.jev ?? createJevChoiceFn({
    apiKey: env.TYPESAFE_API_KEY ?? env.JEV_API_KEY,
    timeoutMs: Number(env.GATESWARM_JEV_TIMEOUT_MS) || 800,
  }));
  const price = opts.priceUsdPerMtok ?? (Number(env.GATESWARM_JEV_PRICE_USD_PER_MTOK) || JEV_PRICE_USD_PER_MTOK_INPUT);
  const stats = { calls: 0, ok: 0, failed: 0, agree: 0, diverge: 0, latencyMsTotal: 0, tokensIn: 0, costUsd: 0 };
  const track = (r: { latencyMs: number; tokensIn: number | null } | null) => {
    stats.calls++;
    if (!r) { stats.failed++; return; }
    stats.ok++; stats.latencyMsTotal += r.latencyMs; stats.tokensIn += r.tokensIn ?? 0;
    stats.costUsd += ((r.tokensIn ?? 0) / 1e6) * price;
  };

  // 1) provider stance (Jev can only harden)
  const providers: ProviderAnalysis[] = [];
  for (const p of base) {
    let jevStance: Stance | null = null; let jevStatus: ProviderAnalysis['jevStatus'] = 'off';
    if (jevFn) {
      try {
        const r = await jevFn({
          id: 'provider_stance',
          instructions: 'Aggregated quota metrics of one AI provider (percent used per window, pace, error and rate-limit rates, band, provider class). Goal: maximize use of idle quota and protect scarce quota, without raising error rates. Decide how much new routing load this provider should take. -1 means unknown. Scarce subscription or window providers should never be asked to take more load.',
          criteria: {
            increase_load: 'Plenty of idle quota and healthy: move more traffic here. Only for credit-style providers with low usage or inferred idle and no errors.',
            hold: 'Keep current share: usage moderate, unknown limits on a scarce provider, or no evidence of idle capacity.',
            reduce_load: 'Protect: high percentage used, fast pace, breaker or cooldown open, rising rate-limit or error rate.',
          },
        }, stanceFeatures(p));
        track(r);
        if (r) { jevStance = r.choice as Stance; jevStatus = 'ok'; } else jevStatus = 'skipped';
        await logRec({ kind: 'provider_stance', provider: p.provider, local: p.localStance, jev: jevStance, status: jevStatus, diverged: jevStance !== null && jevStance !== p.localStance, latency_ms: r?.latencyMs ?? null, tokens_in: r?.tokensIn ?? null, features: stanceFeatures(p) }, opts, env);
        if (r) { if (jevStance === p.localStance) stats.agree++; else stats.diverge++; }
      } catch { jevStatus = 'skipped'; }
    }
    const stance: Stance = jevStance !== null && STANCE_RANK[jevStance] > STANCE_RANK[p.localStance] ? jevStance : p.localStance;
    providers.push({ ...p, jevStance, stance, jevStatus });
  }

  const byName = new Map(providers.map((p) => [p.provider, p]));
  const localOf = (n: string): Stance => byName.get(n)?.localStance ?? 'hold';
  const hardOf = (n: string): Stance => byName.get(n)?.stance ?? 'hold';

  // 2) moves: local first; then recomputed with hardened stances; Jev reviews each remaining move (veto only)
  const movesLocal = proposeMoves(input.tierModels, localOf);
  const hardened = proposeMoves(input.tierModels, hardOf);
  const key = (m: Move) => `${m.tier}|${m.field}|${m.to.provider}/${m.to.model}`;
  const localKeys = new Set(movesLocal.map(key));
  const movesJev: Move[] = [];
  for (const m of hardened) {
    let verdict: 'accept' | 'reject' | null = null;
    if (jevFn) {
      const target = byName.get(m.to.provider); const src = byName.get(m.from.provider);
      try {
        const r = await jevFn({
          id: 'move_review',
          instructions: 'A routing change moves one effort tier from a source provider to a target provider. Only aggregated provider metrics are given. Accept if the target has idle quota and is healthy, or the source is under pressure. Reject if the target is scarce, under pressure, unhealthy, or the move adds load without evidence of idle capacity.',
          criteria: {
            accept: 'Target has headroom (low percent used or inferred idle), is healthy, and the move protects a pressured source or uses idle quota.',
            reject: 'Target is scarce/pressured/unhealthy or there is no evidence the move improves utilization or efficiency.',
          },
        }, { tier: m.tier, move_reason: m.reason, field: m.field, source_provider: m.from.provider, source_class: src?.class ?? 'unknown', source_stance: src?.stance ?? 'hold', source_pct: num(src?.maxPct ?? null), target_provider: m.to.provider, target_class: target?.class ?? 'unknown', target_stance: target?.stance ?? 'hold', target_pct: num(target?.maxPct ?? null), target_error_rate_pct: target?.errorRate7dPct ?? 0, target_success_pct: num(target?.successRate7dPct ?? null), target_breaker_open: target?.breakerOpen ?? false, local_proposed: localKeys.has(key(m)) });
        track(r);
        verdict = r ? (r.choice as 'accept' | 'reject') : null;
        await logRec({ kind: 'move_review', tier: m.tier, reason: m.reason, field: m.field, from_provider: m.from.provider, to_provider: m.to.provider, local: localKeys.has(key(m)) ? 'propose' : 'not_proposed', jev: verdict, diverged: verdict === 'reject', latency_ms: r?.latencyMs ?? null, tokens_in: r?.tokensIn ?? null }, opts, env);
        if (r) { if (verdict === 'accept') stats.agree++; else stats.diverge++; }
      } catch { verdict = null; }
    }
    if (verdict === 'reject') continue; // veto = harden toward status quo
    movesJev.push({ ...m, jevVerdict: verdict, fromLocal: localKeys.has(key(m)) });
  }
  for (const m of movesLocal) m.jevVerdict = movesJev.find((x) => key(x) === key(m))?.jevVerdict ?? (jevFn ? 'reject' : null);

  const proposedLocal = applyMoves(input.tierModels, movesLocal);
  const proposedJev = applyMoves(input.tierModels, movesJev);
  const notes: string[] = [];
  if (providers.some((p) => p.maxPct === null)) notes.push('Plan limits unknown for: ' + providers.filter((p) => p.maxPct === null).map((p) => p.provider).join(', ') + ' — usage percentages unavailable; idle/pressure inferred from token share, pace and error rates. Provide quota-sync percentages or GATESWARM_QUOTA_LIMITS_FILE for precise results.');
  if (providers.some((p) => p.historyHours < 24)) notes.push('Less than 24h of consumption history for some providers; pace ratios are unreliable.');
  if (!input.cycleStartDay) notes.push('GATESWARM_BAILIAN_CYCLE_START_DAY not set: monthly pace unavailable.');
  notes.push('Report only: nothing is applied automatically. Review the diff and open a PR to change tier_models.');
  const rep: QuotaAnalysisReport = {
    schema_version: 'quota-analysis.v1', generatedAt: new Date(input.now).toISOString(), mode, providers,
    movesLocal, movesJev, diffLocal: renderDiff(input.tierModels, proposedLocal), diffJev: renderDiff(input.tierModels, proposedJev),
    proposedTierModelsLocal: proposedLocal, proposedTierModelsJev: proposedJev,
    jev: { ...stats, costUsd: Math.round(stats.costUsd * 1e7) / 1e7 }, notes, applied: false,
  };
  await logRec({ kind: 'summary', mode, providers: providers.map((p) => ({ provider: p.provider, local: p.localStance, jev: p.jevStance, effective: p.stance })), moves_local: movesLocal.length, moves_jev: movesJev.length, jev: rep.jev }, opts, env);
  return rep;
}

// ─── File loading ────────────────────────────────────────
async function readJson<T>(path: string): Promise<T | null> { try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; } }

export async function loadAnalysisInput(opts: { root?: string; configFile?: string; env?: NodeJS.ProcessEnv; now?: number } = {}): Promise<QuotaAnalysisInput | null> {
  const env = opts.env ?? process.env;
  const root = opts.root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cfgPath = opts.configFile ?? env.GATESWARM_CONFIG_FILE ?? join(root, 'v04_config.json');
  const cfg = await readJson<{ tier_models?: TierModels }>(cfgPath);
  if (!cfg?.tier_models) return null;
  const d = (f: string) => join(root, 'data', f);
  const limitsFile = env.GATESWARM_QUOTA_LIMITS_FILE;
  return {
    now: opts.now ?? Date.now(),
    tierModels: cfg.tier_models,
    quotaSync: await readJson(d('quota-sync.json')),
    providerQuota: await readJson(d('provider-quota.json')),
    history: await readJson(d('consumption-history.json')),
    health: await readJson(d('provider-health.json')),
    limits: limitsFile ? await readJson(limitsFile) : null,
    cycleStartDay: Number(env.GATESWARM_BAILIAN_CYCLE_START_DAY) || undefined,
  };
}

/** Short human-readable summary (no secrets). */
export function renderReportText(r: QuotaAnalysisReport): string {
  const L: string[] = [`Quota analysis ${r.generatedAt} (jev mode: ${r.mode}) — NOT APPLIED`, ''];
  L.push('provider        class                 5h%   7d%   30d%  share7d  pace  err%  band    local→jev→effective');
  for (const p of r.providers) {
    const f = (n: number | null) => (n === null ? ' n/a' : String(Math.round(n)).padStart(4));
    L.push(`${p.provider.padEnd(15)} ${p.class.padEnd(21)} ${f(p.w5h.usedPct)}  ${f(p.w7d.usedPct)}  ${f(p.w30d.usedPct)}  ${String(p.tokenShare7dPct).padStart(6)}%  ${p.paceRatio === null ? ' n/a' : p.paceRatio.toFixed(1).padStart(4)}  ${String(p.errorRate7dPct).padStart(4)}  ${p.band.padEnd(7)} ${p.localStance}→${p.jevStance ?? '-'}→${p.stance}`);
  }
  L.push('', 'Diff (local rule):', r.diffLocal, '', 'Diff (local + Jev hardening):', r.diffJev, '');
  L.push(`Jev: ${r.jev.ok}/${r.jev.calls} ok, agree ${r.jev.agree}, diverge ${r.jev.diverge}, latency total ${r.jev.latencyMsTotal} ms, cost ~US$${r.jev.costUsd}`);
  for (const n of r.notes) L.push(`- ${n}`);
  return L.join('\n');
}
