/**
 * Jev quota advisor (metadata only, fail-open, local rule decides first).
 *
 * GATESWARM_JEV_DECISIONS = off (default) | advise | enforce
 *  - off:     Jev is never called.
 *  - advise:  Jev is asked and the divergence is logged; the effective decision stays the local one.
 *  - enforce: the effective decision is max-hardness(local, Jev). Jev can only harden
 *             (downgrade / treat as quota exhaustion / require fallback), never soften.
 * Requires GATESWARM_JEV_MODE=shadow as well (same opt-in as the other Jev modules).
 *
 * Only metadata is sent (tier, band, provider, flags, status code, error-code token).
 * No prompt text, no keys, no hosts. Default timeout 800 ms; any failure => local decision.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyQuotaExhaustion } from '../provider-quota.js';
import { getJevMode } from './shadow.js';
import { JEV_MODEL } from './questions.js';

export type JevDecisionsMode = 'off' | 'advise' | 'enforce';
export function getJevDecisionsMode(env: NodeJS.ProcessEnv = process.env): JevDecisionsMode {
  if (getJevMode(env) !== 'shadow') return 'off';
  const raw = (env.GATESWARM_JEV_DECISIONS ?? '').trim().toLowerCase();
  return raw === 'advise' || raw === 'enforce' ? raw : 'off';
}

/** Generic Jev choice question over a metadata-only state. Returns null on any failure. */
export type JevChoiceFn = (
  question: { id: string; instructions: string; criteria: Record<string, string> },
  state: Record<string, string | number | boolean | string[]>,
) => Promise<{ choice: string; latencyMs: number; tokensIn: number | null } | null>;

const DEFAULT_TIMEOUT_MS = 800;
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export function createJevChoiceFn(opts: { apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch; endpoint?: string }): JevChoiceFn {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  return async (q, state) => {
    if (!opts.apiKey) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await doFetch(opts.endpoint ?? ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JEV_MODEL, state, questions: { [q.id]: { type: 'choice', instructions: q.instructions, criteria: q.criteria } } }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { model?: unknown; answers?: Record<string, { choice?: unknown }>; usage?: { input_tokens?: unknown } };
      if (body?.model !== JEV_MODEL) return null;
      const c = body.answers?.[q.id]?.choice;
      if (typeof c !== 'string' || !(c in q.criteria)) return null;
      const ti = body.usage?.input_tokens;
      return { choice: c, latencyMs: Date.now() - t0, tokensIn: typeof ti === 'number' ? ti : null };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ─── Logging (jsonl, metadata only) ───────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG = join(HERE, '..', '..', 'data', 'jev-shadow', 'jev-quota-advisor.jsonl');

export interface AdvisorOptions {
  env?: NodeJS.ProcessEnv;
  jev?: JevChoiceFn;
  logPath?: string;
  /** Test sink replacing file logging. */
  writeRecord?: (rec: Record<string, unknown>) => void;
}

async function logRec(rec: Record<string, unknown>, opts: AdvisorOptions, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const full = { schema_version: 'jev-quota-advisor.v1', ts: new Date().toISOString(), ...rec };
    if (opts.writeRecord) return void opts.writeRecord(full);
    const p = opts.logPath ?? env.GATESWARM_JEV_QUOTA_ADVISOR_LOG ?? DEFAULT_LOG;
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.appendFile(p, `${JSON.stringify(full)}\n`, 'utf8');
  } catch { /* fail-open */ }
}

function resolveJev(opts: AdvisorOptions, env: NodeJS.ProcessEnv): JevChoiceFn {
  return opts.jev ?? createJevChoiceFn({
    apiKey: env.TYPESAFE_API_KEY ?? env.JEV_API_KEY,
    timeoutMs: Number(env.GATESWARM_JEV_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  });
}

// ─── (a) Tier downgrade under yellow/orange/red bands ────────────
export type QuotaBandName = 'green' | 'yellow' | 'orange' | 'red';
export type DowngradeDecision = 'keep' | 'downgrade';
export const TIER_LADDER = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;
const HIGH_RISK_FLAGS = new Set(['auth_session', 'migration_rls', 'secrets', 'production']);

export interface DowngradeInput {
  tier: string;
  provider: string;
  /** Premium model (e.g. Opus / Astra) that the band overlay may drop first. */
  premium: boolean;
  band: QuotaBandName;
  riskFlags: string[];
  requestId?: string;
}
export interface DowngradeResult {
  local: DowngradeDecision;
  jev: DowngradeDecision | null;
  /** max-hardness(local, jev) — what Jev would have us do. */
  proposed: DowngradeDecision;
  /** What the caller must actually do (local unless mode=enforce). */
  effective: DowngradeDecision;
  /** Tier to use if effective === 'downgrade' (one step down, never below trivial). */
  targetTier: string;
  mode: JevDecisionsMode;
  status: 'off' | 'skipped' | 'ok';
  diverged: boolean;
}

const hasHighRisk = (f: string[]) => f.some((x) => HIGH_RISK_FLAGS.has(x));

/** Pure local rule. High-risk tasks are never downgraded by Jev (quality guard), red always downgrades. */
export function localDowngrade(i: DowngradeInput): DowngradeDecision {
  switch (i.band) {
    case 'green': return 'keep';
    case 'yellow': return i.premium && i.riskFlags.length === 0 ? 'downgrade' : 'keep';
    case 'orange': return hasHighRisk(i.riskFlags) ? 'keep' : 'downgrade';
    case 'red': return 'downgrade';
  }
}

export function stepDown(tier: string): string {
  const idx = TIER_LADDER.indexOf(tier as (typeof TIER_LADDER)[number]);
  return idx <= 0 ? tier : TIER_LADDER[idx - 1]!;
}

export async function adviseDowngrade(input: DowngradeInput, opts: AdvisorOptions = {}): Promise<DowngradeResult> {
  const env = opts.env ?? process.env;
  const mode = getJevDecisionsMode(env);
  const local = localDowngrade(input);
  let jev: DowngradeDecision | null = null;
  let status: DowngradeResult['status'] = 'off';
  let lat: number | null = null;
  let tok: number | null = null;
  // Jev is only consulted when the band is not green (nothing to protect otherwise).
  if (mode !== 'off' && input.band !== 'green') {
    try {
      const r = await resolveJev(opts, env)({
        id: 'downgrade',
        instructions: 'Quota of an AI provider is under pressure (band yellow/orange/red). Given only task metadata, decide whether the request should be served one effort tier lower to protect the quota. Tasks with auth, migration, secrets or production risk flags should keep their tier unless the band is red.',
        criteria: {
          keep: 'Keep the tier: high-risk flags and band not red, or green/low pressure.',
          downgrade: 'Serve one tier lower: no high-risk flags and the quota band is under pressure, or band is red.',
        },
      }, { tier: input.tier, provider: input.provider, premium_model: input.premium, quota_band: input.band, risk_flags: input.riskFlags });
      if (r) { jev = r.choice as DowngradeDecision; status = 'ok'; lat = r.latencyMs; tok = r.tokensIn; } else status = 'skipped';
    } catch { status = 'skipped'; }
  }
  // Jev may harden toward 'downgrade' only when there is no high-risk flag, except red band.
  const jevAllowed = jev === 'downgrade' && (input.band === 'red' || !hasHighRisk(input.riskFlags));
  const proposed: DowngradeDecision = local === 'downgrade' || jevAllowed ? 'downgrade' : 'keep';
  const effective = mode === 'enforce' ? proposed : local;
  const res: DowngradeResult = { local, jev, proposed, effective, targetTier: effective === 'downgrade' ? stepDown(input.tier) : input.tier, mode, status, diverged: jev !== null && jev !== local };
  await logRec({ kind: 'downgrade', request_id: input.requestId ?? null, mode, tier: input.tier, provider: input.provider, premium: input.premium, band: input.band, flags: input.riskFlags, local, jev, proposed, effective, status, diverged: res.diverged, latency_ms: lat, tokens_in: tok }, opts, env);
  return res;
}

// ─── (b) Provider error classification for the circuit breaker ───
export type ErrorClass = 'quota_exhausted' | 'transient' | 'auth' | 'other';
const ERROR_CODE_WHITELIST = ['1308', 'insufficient_quota', 'rate_limit', 'MissingSession', 'invalid_api_key', 'overloaded', 'none'] as const;

export interface ErrorInput { provider: string; status: number; body: unknown; requestId?: string }
export interface ErrorResult { local: ErrorClass; jev: ErrorClass | null; proposed: ErrorClass; effective: ErrorClass; code: string; mode: JevDecisionsMode; status: 'off' | 'skipped' | 'ok'; diverged: boolean }

/** Extracts a whitelisted error-code token (never the raw body). */
export function errorCodeToken(status: number, body: unknown): string {
  let text = '';
  try { text = typeof body === 'string' ? body : JSON.stringify(body) ?? ''; } catch { /* ignore */ }
  if (status === 1308 || /["':\s]1308["',}\s]/.test(text)) return '1308';
  for (const c of ERROR_CODE_WHITELIST) if (c !== 'none' && text.toLowerCase().includes(c.toLowerCase())) return c;
  return 'none';
}

export function localErrorClass(status: number, body: unknown): ErrorClass {
  if (classifyQuotaExhaustion(status, body)) return 'quota_exhausted';
  if (/MissingSession|invalid_api_key/i.test((() => { try { return typeof body === 'string' ? body : JSON.stringify(body); } catch { return ''; } })() ?? '') || status === 401 || status === 403) return 'auth';
  if (status === 429 || status === 408 || status >= 500) return 'transient';
  return 'other';
}

const HARDNESS: Record<ErrorClass, number> = { other: 0, transient: 1, auth: 2, quota_exhausted: 3 };

export async function classifyProviderError(input: ErrorInput, opts: AdvisorOptions = {}): Promise<ErrorResult> {
  const env = opts.env ?? process.env;
  const mode = getJevDecisionsMode(env);
  const local = localErrorClass(input.status, input.body);
  const code = errorCodeToken(input.status, input.body);
  let jev: ErrorClass | null = null;
  let status: ErrorResult['status'] = 'off';
  let lat: number | null = null;
  let tok: number | null = null;
  if (mode !== 'off') {
    try {
      const r = await resolveJev(opts, env)({
        id: 'error_class',
        instructions: 'Classify an AI provider error from metadata only (HTTP status and a known error-code token). Decide whether the provider should be removed from routing until its quota resets.',
        criteria: {
          quota_exhausted: 'Quota or credit exhausted until a reset (e.g. code 1308, insufficient_quota). Open the circuit breaker.',
          transient: 'Short rate limit or server hiccup (429 without a quota code, 5xx). Retry or fall back, no breaker.',
          auth: 'Credential or session problem (401, 403, MissingSession, invalid_api_key). Do not retry.',
          other: 'Client error unrelated to quota or credentials.',
        },
      }, { provider: input.provider, http_status: input.status, error_code: code });
      if (r) { jev = r.choice as ErrorClass; status = 'ok'; lat = r.latencyMs; tok = r.tokensIn; } else status = 'skipped';
    } catch { status = 'skipped'; }
  }
  const proposed = jev !== null && HARDNESS[jev] > HARDNESS[local] ? jev : local;
  const effective = mode === 'enforce' ? proposed : local;
  const res: ErrorResult = { local, jev, proposed, effective, code, mode, status, diverged: jev !== null && jev !== local };
  await logRec({ kind: 'error_class', request_id: input.requestId ?? null, mode, provider: input.provider, http_status: input.status, code, local, jev, proposed, effective, status, diverged: res.diverged, latency_ms: lat, tokens_in: tok }, opts, env);
  return res;
}

// ─── (c) Rebalancing table review ────────────────────────────────
export interface TierRow { tier: string; provider: string; model: string; fallbacks: { provider: string; model: string }[]; planModel?: string }
export type RowVerdict = 'accept' | 'harden';
export interface RowReview { tier: string; local: RowVerdict; jev: RowVerdict | null; proposed: RowVerdict; effective: RowVerdict; reasons: string[]; diverged: boolean; mode: JevDecisionsMode; status: 'off' | 'skipped' | 'ok' }

const SUBSCRIPTION = new Set(['claude-cli', 'codex-cli']);

/** Local rule: a row is hardened when it lacks provider diversity in fallbacks or leans only on subscription CLIs. */
export function localRowReview(row: TierRow): { verdict: RowVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const others = new Set(row.fallbacks.map((f) => f.provider).filter((p) => p !== row.provider));
  if (others.size < 1) reasons.push('no_cross_provider_fallback');
  if (row.fallbacks.length < 2) reasons.push('fewer_than_2_fallbacks');
  if (SUBSCRIPTION.has(row.provider) && row.fallbacks.length > 0 && row.fallbacks.every((f) => SUBSCRIPTION.has(f.provider))) reasons.push('all_subscription_cli');
  return { verdict: reasons.length ? 'harden' : 'accept', reasons };
}

export async function reviewTierRow(row: TierRow, opts: AdvisorOptions = {}): Promise<RowReview> {
  const env = opts.env ?? process.env;
  const mode = getJevDecisionsMode(env);
  const { verdict: local, reasons } = localRowReview(row);
  let jev: RowVerdict | null = null;
  let status: RowReview['status'] = 'off';
  let lat: number | null = null;
  let tok: number | null = null;
  if (mode !== 'off') {
    try {
      const prov = [row.provider, ...row.fallbacks.map((f) => f.provider)];
      const r = await resolveJev(opts, env)({
        id: 'row_review',
        instructions: 'Review one routing-table row (effort tier -> primary provider, ordered fallback providers) for quota resilience. Only provider names and counts are given.',
        criteria: {
          accept: 'Resilient: the primary has at least two fallbacks and at least one on a different provider family.',
          harden: 'Fragile: fewer than two fallbacks, no fallback on another provider, or all providers are subscription CLIs sharing quota pressure.',
        },
      }, { tier: row.tier, primary_provider: row.provider, provider_chain: prov, fallback_count: row.fallbacks.length, distinct_fallback_providers: new Set(row.fallbacks.map((f) => f.provider)).size, primary_is_subscription_cli: SUBSCRIPTION.has(row.provider) });
      if (r) { jev = r.choice as RowVerdict; status = 'ok'; lat = r.latencyMs; tok = r.tokensIn; } else status = 'skipped';
    } catch { status = 'skipped'; }
  }
  const proposed: RowVerdict = local === 'harden' || jev === 'harden' ? 'harden' : 'accept';
  const effective = mode === 'enforce' ? proposed : local;
  const res: RowReview = { tier: row.tier, local, jev, proposed, effective, reasons, diverged: jev !== null && jev !== local, mode, status };
  await logRec({ kind: 'row_review', tier: row.tier, mode, primary_provider: row.provider, fallback_providers: row.fallbacks.map((f) => f.provider), local, jev, proposed, effective, reasons, status, diverged: res.diverged, latency_ms: lat, tokens_in: tok }, opts, env);
  return res;
}
