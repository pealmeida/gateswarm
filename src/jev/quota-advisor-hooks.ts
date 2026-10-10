/**
 * Fire-and-forget hooks that connect the Jev quota advisor to the real gateway request path.
 *
 * GATESWARM_JEV_DECISIONS=advise|enforce (with GATESWARM_JEV_MODE=shadow) → the advisor is consulted and
 * local-vs-Jev opinions are written to jsonl (metadata only). These hooks NEVER alter routing: the gateway
 * ignores the result (enforce is intentionally not wired into the request path). Off by default → no-op.
 * Prompt text is never passed in; callers pass only tier, provider, model-name class flag and risk-flag tokens.
 */
import { providerQuota } from '../provider-quota.js';
import { getProviderQuotaPercentages } from '../quota-band-matrix.js';
import { detectFlags } from './pre-delegation.js';
import { adviseDowngrade, classifyProviderError, getJevDecisionsMode, type QuotaBandName } from './quota-advisor.js';

const PREMIUM_RE = /opus|astra/i;

function bandForProvider(provider: string, pct: number | null): QuotaBandName {
  if (providerQuota.isBreakerOpen(provider)) return 'red';
  if (pct === null) return 'green'; // unknown: nothing to protect on evidence; logged as such
  return pct < 40 ? 'green' : pct < 70 ? 'yellow' : pct < 85 ? 'orange' : 'red';
}

/** Per request: local vs Jev opinion on serving the tier one step lower. Never awaited, never throws. */
export function quotaAdvisorObserveRequest(args: {
  tier: string; providerId: string; model: string; promptText: string; requestId?: string;
  /** max used-% for the provider across windows when known (from quota-sync / consumption tracker). */
  providerPct?: number | null; env?: NodeJS.ProcessEnv;
}): void {
  try {
    if (getJevDecisionsMode(args.env ?? process.env) === 'off') return;
    // flags are derived locally from the prompt; only the flag tokens leave this function.
    const riskFlags = detectFlags(args.promptText).filter((f) => f === 'auth_session' || f === 'migration_rls' || f === 'secrets' || f === 'production');
    let pct = args.providerPct ?? null;
    if (pct === null) { try { pct = getProviderQuotaPercentages().find((p) => p.provider === args.providerId)?.maxPct ?? null; } catch { pct = null; } }
    const band = bandForProvider(args.providerId, pct);
    void adviseDowngrade({ tier: args.tier, provider: args.providerId, premium: PREMIUM_RE.test(args.model), band, riskFlags: riskFlags as string[], requestId: args.requestId }, { env: args.env }).catch(() => undefined);
  } catch { /* fail-open */ }
}

/** After an upstream failure: local vs Jev classification of the error (code token only, never the body). */
export function quotaAdvisorObserveFailure(provider: string, status: number, body: unknown, requestId?: string, env?: NodeJS.ProcessEnv): void {
  try {
    if (getJevDecisionsMode(env ?? process.env) === 'off') return;
    void classifyProviderError({ provider, status, body, requestId }, { env }).catch(() => undefined);
  } catch { /* fail-open */ }
}
