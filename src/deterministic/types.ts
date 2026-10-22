import { createHash } from 'node:crypto';
import { createLocalHeuristicProvider } from './local-heuristic-provider.js';
import { createJevDeterministicProvider } from './jev-provider.js';
import { createLayaDeterministicProvider } from './laya-provider.js';
import { createJevTierClient } from '../jev/client.js';

export const DETERMINISTIC_TIERS = new Set(['trivial', 'light', 'standard', 'heavy']);
export interface DeterministicResult { ok: boolean; tier?: string; confidence?: number; error?: string; provider: string }
export interface DeterministicProvider {
  id: string; kind: 'deterministic'; costUsd: 0;
  classify(input: { prompt: string; signal?: AbortSignal }): Promise<DeterministicResult>;
}

export class DeterministicRegistry {
  private readonly providers = new Map<string, DeterministicProvider>();
  private readonly memo = new Map<string, { value: DeterministicResult; expires: number }>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly local: DeterministicProvider;
  private readonly timeoutMs: number;
  private readonly memoMax: number;
  private readonly memoTtlMs: number;
  private readonly cooldownMs: number;

  constructor(options: { localProvider?: DeterministicProvider; timeoutMs?: number; memoMax?: number; memoTtlMs?: number; cooldownMs?: number } = {}) {
    this.local = options.localProvider ?? createLocalHeuristicProvider();
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.memoMax = options.memoMax ?? 500;
    this.memoTtlMs = options.memoTtlMs ?? 30_000;
    this.cooldownMs = options.cooldownMs ?? 2_000;
    this.register(this.local);
  }
  register(provider: DeterministicProvider, options: { replace?: boolean } = {}): void {
    if (provider.costUsd !== 0 || provider.kind !== 'deterministic') throw new TypeError('Deterministic providers must have kind deterministic and zero cost');
    if (this.providers.has(provider.id) && this.providers.get(provider.id) !== provider && !options.replace) throw new Error(`Provider id already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
    this.memo.clear();
  }
  get(id: string): DeterministicProvider | undefined { return this.providers.get(id); }
  list(): DeterministicProvider[] { return [...this.providers.values()]; }
  resolve(input: { prompt: string }): Promise<DeterministicResult> {
    const key = createHash('sha256').update(input.prompt).digest('hex');
    const now = Date.now();
    const cached = this.memo.get(key);
    if (cached && cached.expires > now) { this.memo.delete(key); this.memo.set(key, cached); return Promise.resolve(cached.value); }
    if (cached) this.memo.delete(key);
    return this.resolveUncached(input).then((result) => {
      if (result.ok && this.memoMax > 0) {
        this.memo.set(key, { value: result, expires: Date.now() + this.memoTtlMs });
        while (this.memo.size > this.memoMax) this.memo.delete(this.memo.keys().next().value!);
      }
      return result;
    });
  }
  private async resolveUncached(input: { prompt: string }): Promise<DeterministicResult> {
    const chain = [...this.providers.values()].filter((p) => p.id !== this.local.id); chain.push(this.local);
    let lastError = 'unavailable';
    for (const provider of chain) {
      const failure = this.failures.get(provider.id);
      if (provider !== this.local && this.cooldownMs > 0 && failure && failure.until > Date.now()) { lastError = 'cooldown'; continue; }
      const controller = new AbortController();
      try {
        const result = await withTimeout(provider.classify({ ...input, signal: controller.signal }), this.timeoutMs, controller);
        if (result.ok && DETERMINISTIC_TIERS.has(result.tier ?? '')) {
          this.failures.delete(provider.id);
          return { ...result, provider: provider.id };
        }
        lastError = result.error ?? (result.ok ? 'invalid_tier' : 'classification_failed');
        this.recordFailure(provider.id);
      } catch (error) {
        lastError = error instanceof Error && error.message === 'timeout' ? 'timeout' : 'provider_error';
        console.debug(`[deterministic] provider=${provider.id} error=${error instanceof Error ? error.name : 'UnknownError'}`);
        this.recordFailure(provider.id);
      }
    }
    return { ok: false, error: lastError, provider: this.local.id };
  }
  private recordFailure(id: string): void {
    const count = (this.failures.get(id)?.count ?? 0) + 1;
    this.failures.set(id, { count, until: Date.now() + this.cooldownMs * Math.min(count, 3) });
  }
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); })]).finally(() => clearTimeout(timer!));
}

export function createDefaultDeterministicRegistry(options: { enabled?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): DeterministicRegistry {
  const registry = new DeterministicRegistry({ timeoutMs: options.timeoutMs });
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? env.GATESWARM_DETERMINISTIC_MODE === 'on';
  if (!enabled) return registry;
  const laya = createLayaDeterministicProvider(env.GATESWARM_LAYA_ENDPOINT);
  if (laya) registry.register(laya);
  const jevKey = env.TYPESAFE_API_KEY?.trim() || env.JEV_API_KEY?.trim();
  if (jevKey) registry.register(createJevDeterministicProvider(createJevTierClient({ apiKey: jevKey }), 'jev'));
  return registry;
}
let defaultRegistry: DeterministicRegistry | undefined;
export function getDefaultRegistry(): DeterministicRegistry { return defaultRegistry ??= createDefaultDeterministicRegistry(); }
export function registerDeterministicProvider(provider: DeterministicProvider): void { getDefaultRegistry().register(provider); }
