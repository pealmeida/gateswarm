/**
 * Dynamic routing core (pure, deterministic, no I/O).
 *
 * Given a tier's static chain (primary + fallbacks) and the live quota picture, returns a re-ordered /
 * filtered chain that uses idle quota first and protects scarce quota. Every re-ordering carries a reason.
 *
 * Guarantees (enforced here, covered by tests):
 *  - never serves a tier below its minimum capability (candidates under the floor are dropped; if that would
 *    leave nothing, the static chain is returned untouched);
 *  - high-risk requests keep the static (strong) primary unless it is breaker-open or in the red band;
 *  - Jev can only HARDEN (add a penalty to a provider it wants to relieve), never soften;
 *  - hysteresis: the previous primary is kept unless a rival wins by HYSTERESIS_MARGIN (or a forced event);
 *  - exploration floor: every Nth request per tier an idle/unmeasured candidate is promoted so its
 *    measurements stay fresh (counter based, not random → deterministic).
 */
import type { MgrBand, ProviderState } from './core.js';

export type RoutingMode = 'off' | 'shadow' | 'on';
export function getDynamicRoutingMode(env: NodeJS.ProcessEnv = process.env): RoutingMode {
  const v = String(env.GATESWARM_DYNAMIC_ROUTING ?? 'off').trim().toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
}

export interface Cand { provider: string; model: string }
export const candKey = (c: Cand): string => `${c.provider}/${c.model}`;

// ─── capability ──────────────────────────────────────────

/** Minimum capability (1..5) a model must have to serve the tier. */
export const MIN_CAPABILITY: Record<string, number> = { trivial: 1, light: 1, moderate: 2, heavy: 3, intensive: 4, extreme: 4 };

/** Ordered: first match wins. Overridable with GATESWARM_MODEL_CAPABILITY (JSON {"<regex>": n}). */
const CAPABILITY_RULES: Array<[RegExp, number]> = [
  [/opus|astra/i, 5],
  [/gpt-6-sol|sonnet-5|qwen3\.8-max|deepseek-v4-pro/i, 4],
  [/gpt-6-luna|glm-5\.[23](?!-flash)|qwen3\.7-plus|deepseek-v4(?!\.1-flash|-flash)/i, 3],
  [/flash|mini|haiku|qwen2\.5|gemma|llama/i, 2],
];
export function capabilityOf(model: string, env: NodeJS.ProcessEnv = process.env): number {
  try {
    if (env.GATESWARM_MODEL_CAPABILITY) {
      for (const [re, n] of Object.entries(JSON.parse(env.GATESWARM_MODEL_CAPABILITY) as Record<string, number>)) if (new RegExp(re, 'i').test(model)) return n;
    }
  } catch { /* ignore bad override */ }
  for (const [re, n] of CAPABILITY_RULES) if (re.test(model)) return n;
  return 3; // unknown models are assumed mid-capability, never top
}

// ─── scoring ─────────────────────────────────────────────

export interface ProviderStats { samples: number; errorRate: number; p50LatencyMs: number | null; requests5h: number }
export interface RouterTuning {
  hysteresisMargin: number; minDwellMs: number; exploreEvery: number; staticStep: number;
  bandPenalty: Record<MgrBand, number>;
}
export const DEFAULT_TUNING: RouterTuning = {
  hysteresisMargin: 15, minDwellMs: 120_000, exploreEvery: 25, staticStep: 10,
  bandPenalty: { green: 0, yellow: 18, orange: 45, red: 120, unknown: 6 },
};

export interface PrevDecision { primary: string; at: number }
export interface RouteInput {
  tier: string;
  chain: Cand[]; // static order: [primary, ...fallbacks]
  states: Record<string, ProviderState | undefined>;
  statsOf: (provider: string) => ProviderStats | null;
  /** learned quota % consumed per request for provider/tier (null = unknown) */
  costOf: (provider: string, tier: string) => number | null;
  breakerOpen: (provider: string) => boolean;
  /** providers Jev asked to relieve (stance reduce_load) — hardening only */
  jevRelieve?: (provider: string) => boolean;
  highRisk: boolean;
  now: number;
  prev?: PrevDecision | null;
  /** per-tier request counter used for the exploration floor (caller increments) */
  exploreTick?: number;
  tuning?: Partial<RouterTuning>;
  env?: NodeJS.ProcessEnv;
}
export interface Scored { cand: Cand; score: number; excluded: string | null; notes: string[]; capability: number }
export interface RouteResult {
  chain: Cand[]; changed: boolean; primaryChanged: boolean; reasons: string[]; scored: Scored[];
  /** the new primary was forced by an event (breaker/red/exhaustion), not by preference */
  forced: boolean; explored: boolean;
}

const pctText = (s: ProviderState | undefined): string => s && s.maxUsedPct != null ? `${Math.round(s.maxUsedPct)}%${s.limitingWindow ? ' ' + s.limitingWindow : ''}` : 'n/a';

export function scoreCandidate(c: Cand, idx: number, i: RouteInput, t: RouterTuning): Scored {
  const st = i.states[c.provider];
  const notes: string[] = [];
  const cap = capabilityOf(c.model, i.env);
  let excluded: string | null = null;
  let score = idx * t.staticStep;
  if (i.breakerOpen(c.provider)) { excluded = 'breaker_open'; }

  const stats = i.statsOf(c.provider);
  const band: MgrBand = st?.band ?? 'unknown';
  score += t.bandPenalty[band];
  if (band === 'red') notes.push(`${c.provider} red ${pctText(st)}`);
  else if (band === 'orange' || band === 'yellow') notes.push(`${c.provider} ${band} ${pctText(st)}`);
  if (band === 'green' && st?.headroomPct != null) {
    const bonus = Math.min(14, (st.headroomPct / 100) * 14);
    score -= bonus; if (bonus >= 8) notes.push(`${c.provider} idle ${pctText(st)}`);
  }
  if (band === 'unknown') {
    if (stats && stats.requests5h < 30 && stats.errorRate < 0.1) { score -= 4; notes.push(`${c.provider} unmeasured, low gateway use`); }
    else notes.push(`${c.provider} unmeasured`);
  }
  if (st?.willExhaustBeforeReset) { score += 35; notes.push(`${c.provider} projected to exhaust before reset`); }

  const cost = i.costOf(c.provider, i.tier);
  if (cost != null && cost > 0 && st?.headroomPct != null) {
    const reqLeft = st.headroomPct / cost;
    if (reqLeft < 10) { score += 40; notes.push(`${c.provider} ~${Math.floor(reqLeft)} requests of headroom`); }
    else if (reqLeft < 50) score += 15;
    score += Math.min(20, cost * 2);
  }
  if (stats && stats.samples >= 5) {
    if (stats.errorRate > 0) score += stats.errorRate * 80;
    if (stats.errorRate >= 0.3) notes.push(`${c.provider} error rate ${(stats.errorRate * 100).toFixed(0)}%`);
    if (stats.p50LatencyMs != null && stats.p50LatencyMs > 5000) score += Math.min(12, ((stats.p50LatencyMs - 5000) / 1000) * 2);
  }
  if (i.jevRelieve?.(c.provider)) { score += 25; notes.push(`jev reduce_load ${c.provider}`); }
  return { cand: c, score, excluded, notes, capability: cap };
}

export function routeDynamic(i: RouteInput): RouteResult {
  const t: RouterTuning = { ...DEFAULT_TUNING, ...i.tuning, bandPenalty: { ...DEFAULT_TUNING.bandPenalty, ...i.tuning?.bandPenalty } };
  const seen = new Set<string>();
  const base = i.chain.filter((c) => (seen.has(candKey(c)) ? false : (seen.add(candKey(c)), true)));
  const unchanged = (why?: string): RouteResult => ({ chain: base, changed: false, primaryChanged: false, reasons: why ? [why] : [], scored: [], forced: false, explored: false });
  if (base.length < 2) return unchanged();

  const min = MIN_CAPABILITY[i.tier] ?? 1;
  const scoredAll = base.map((c, idx) => scoreCandidate(c, idx, i, t));
  const eligible = scoredAll.filter((s) => s.capability >= min);
  if (eligible.length === 0) return { ...unchanged('no candidate meets minimum capability; static chain kept'), scored: scoredAll };
  const dropped = scoredAll.filter((s) => s.capability < min);

  const usable = eligible.filter((s) => !s.excluded);
  const pool = usable.length ? usable : eligible; // if everything is excluded keep order, let the gateway skip/err
  const reasons: string[] = [];
  const staticPrimary = base[0];
  const staticPrimaryScored = scoredAll[0];

  let ordered = [...pool].sort((a, b) => a.score - b.score || scoredAll.indexOf(a) - scoredAll.indexOf(b));
  // excluded (breaker-open) candidates stay at the tail so the gateway can still report them as skipped
  const tail = eligible.filter((s) => s.excluded && usable.length);
  ordered = [...ordered, ...tail];

  // high risk: keep strong static primary unless it is out (breaker) or red
  if (i.highRisk) {
    const sp = ordered.find((s) => candKey(s.cand) === candKey(staticPrimary));
    const spBad = !sp || sp.excluded || (i.states[staticPrimary.provider]?.band === 'red');
    if (!spBad && sp) { ordered = [sp, ...ordered.filter((s) => s !== sp)]; reasons.push('high_risk: static primary preserved'); }
    else if (sp) reasons.push(`high_risk: primary unavailable (${sp.excluded ?? 'red'}), moved`);
  }

  // hysteresis against previous primary
  let forced = false;
  const best = ordered[0];
  const bestKey = candKey(best.cand);
  if (i.prev && i.prev.primary !== bestKey && !i.highRisk) {
    const prevS = ordered.find((s) => candKey(s.cand) === i.prev!.primary);
    if (prevS && !prevS.excluded) {
      const prevRed = i.states[prevS.cand.provider]?.band === 'red';
      const margin = prevS.score - best.score;
      const dwellOk = i.now - i.prev.at >= t.minDwellMs;
      if (!prevRed && (margin < t.hysteresisMargin || !dwellOk)) {
        ordered = [prevS, ...ordered.filter((s) => s !== prevS)];
        reasons.push(`hysteresis: kept ${i.prev.primary} (margin ${margin.toFixed(1)} < ${t.hysteresisMargin}${dwellOk ? '' : ', dwell'})`);
      }
    }
  }

  // exploration floor (deterministic counter), never on high risk
  let explored = false;
  if (!i.highRisk && t.exploreEvery > 0 && (i.exploreTick ?? 0) > 0 && (i.exploreTick! % t.exploreEvery) === 0) {
    const cand = ordered.slice(1).find((s) => {
      if (s.excluded) return false;
      const st = i.states[s.cand.provider];
      const stats = i.statsOf(s.cand.provider);
      const stale = !st || st.confidence === 'unknown' || st.stale;
      const idle = !stats || stats.requests5h === 0;
      const okBand = (st?.band ?? 'unknown') === 'green' || (st?.band ?? 'unknown') === 'unknown';
      return okBand && (stale || idle);
    });
    if (cand) { ordered = [cand, ...ordered.filter((s) => s !== cand)]; explored = true; reasons.push(`explore: ${candKey(cand.cand)} (keep measurements fresh)`); }
  }

  const chain = ordered.map((s) => s.cand);
  const newPrimary = chain[0];
  const primaryChanged = candKey(newPrimary) !== candKey(staticPrimary);
  const changed = chain.map(candKey).join('>') !== base.map(candKey).join('>');
  if (primaryChanged) {
    const why = [...(staticPrimaryScored.excluded ? [`${staticPrimary.provider} ${staticPrimaryScored.excluded}`] : []), ...staticPrimaryScored.notes.filter((n) => /red|orange|yellow|exhaust|headroom|error|jev/.test(n)), ...ordered[0].notes.filter((n) => /idle|unmeasured/.test(n))].slice(0, 3);
    reasons.unshift(`primary ${candKey(staticPrimary)} -> ${candKey(newPrimary)}${why.length ? ' (' + why.join('; ') + ')' : ''}`);
    forced = !!staticPrimaryScored.excluded || i.states[staticPrimary.provider]?.band === 'red' || !!i.states[staticPrimary.provider]?.willExhaustBeforeReset;
  } else if (changed) reasons.unshift('fallback order changed by headroom/health');
  if (dropped.length) reasons.push(`capability floor ${min}: dropped ${dropped.map((d) => candKey(d.cand)).join(',')}`);
  const droppedSet = new Set(dropped.map((d) => candKey(d.cand)));
  const finalChain = chain; // below-floor candidates are never re-added
  return { chain: finalChain, changed: changed || droppedSet.size > 0, primaryChanged, reasons, scored: scoredAll, forced, explored };
}

/** Compact, header-safe rendering of the reasons (ASCII, no newlines, <=220 chars). */
export function reasonHeader(r: RouteResult): string {
  return r.reasons.join(' | ').replace(/[^\x20-\x7E]/g, '?').slice(0, 220);
}
