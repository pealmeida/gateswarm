/**
 * Per-provider concurrency semaphore.
 *
 * Subscription-backed providers (Claude Code, Codex) and small plans (Bailian Token Plan,
 * Z.AI Coding) meter or throttle parallel agents, so the gateway caps in-flight calls
 * per provider. Excess callers wait briefly; if no slot frees up in time the caller skips
 * the target and moves down the fallback chain.
 *
 * Limits (0 / unset = unlimited) can be overridden per provider with
 *   GATESWARM_CONCURRENCY_<PROVIDER>   e.g. GATESWARM_CONCURRENCY_CLAUDE_CLI=1
 * Defaults are conservative and plan-agnostic; tune them to your own subscription.
 */

export const DEFAULT_PROVIDER_CONCURRENCY: Record<string, number> = {
  'claude-cli': 2,
  'codex-cli': 2,
  zai: 3,
  ollama: 1,
  // bailian: plan-dependent (Token Plan tiers allow roughly 1–8 parallel agents) — set
  // GATESWARM_CONCURRENCY_BAILIAN once your plan is known; unlimited until then.
};

export const DEFAULT_ACQUIRE_WAIT_MS = 15_000;

export type Release = () => void;

function envKey(provider: string): string {
  return `GATESWARM_CONCURRENCY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

export function getProviderConcurrencyLimit(provider: string): number {
  const raw = process.env[envKey(provider)];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return DEFAULT_PROVIDER_CONCURRENCY[provider] ?? 0;
}

interface Waiter { resolve: (r: Release | null) => void; timer: ReturnType<typeof setTimeout>; }

export class ProviderConcurrency {
  private inFlight = new Map<string, number>();
  private waiters = new Map<string, Waiter[]>();
  private limitFor: (provider: string) => number;

  constructor(limitFor: (provider: string) => number = getProviderConcurrencyLimit) {
    this.limitFor = limitFor;
  }

  /** Acquire a slot; resolves to a release function, or null if no slot became free within waitMs. */
  acquire(provider: string, waitMs: number = DEFAULT_ACQUIRE_WAIT_MS): Promise<Release | null> {
    const limit = this.limitFor(provider);
    if (!limit) return Promise.resolve(() => {});
    if ((this.inFlight.get(provider) || 0) < limit) return Promise.resolve(this.take(provider));
    if (waitMs <= 0) return Promise.resolve(null);
    return new Promise(resolve => {
      const w: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const list = this.waiters.get(provider) || [];
          const i = list.indexOf(w);
          if (i >= 0) list.splice(i, 1);
          resolve(null);
        }, waitMs),
      };
      const list = this.waiters.get(provider) || [];
      list.push(w);
      this.waiters.set(provider, list);
    });
  }

  private take(provider: string): Release {
    this.inFlight.set(provider, (this.inFlight.get(provider) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.set(provider, Math.max(0, (this.inFlight.get(provider) || 1) - 1));
      const next = (this.waiters.get(provider) || []).shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.take(provider));
      }
    };
  }

  snapshot(): Record<string, { inFlight: number; limit: number; waiting: number }> {
    const out: Record<string, { inFlight: number; limit: number; waiting: number }> = {};
    const names = new Set([...this.inFlight.keys(), ...this.waiters.keys(), ...Object.keys(DEFAULT_PROVIDER_CONCURRENCY)]);
    for (const p of names) out[p] = { inFlight: this.inFlight.get(p) || 0, limit: this.limitFor(p), waiting: (this.waiters.get(p) || []).length };
    return out;
  }
}

export const providerConcurrency = new ProviderConcurrency();
