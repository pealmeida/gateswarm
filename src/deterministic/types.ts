import { createLocalHeuristicProvider } from './local-heuristic-provider.js';
import { createJevDeterministicProvider } from './jev-provider.js';
import { createLayaDeterministicProvider } from './laya-provider.js';
import { createJevTierClient } from '../jev/client.js';

export interface DeterministicResult {
  ok: boolean;
  tier?: string;
  confidence?: number;
  error?: string;
  provider: string;
}

export interface DeterministicProvider {
  id: string;
  kind: 'deterministic';
  costUsd: 0;
  classify(input: { prompt: string }): Promise<DeterministicResult>;
}

/** Runs providers in registration order, then always has the local scorer available. */
export class DeterministicRegistry {
  private readonly providers = new Map<string, DeterministicProvider>();
  private readonly memo = new Map<string, Promise<DeterministicResult>>();
  private readonly local: DeterministicProvider;

  constructor(options: { localProvider?: DeterministicProvider; timeoutMs?: number } = {}) {
    this.local = options.localProvider ?? createLocalHeuristicProvider();
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.register(this.local);
  }

  private readonly timeoutMs: number;

  register(provider: DeterministicProvider): void {
    if (provider.costUsd !== 0 || provider.kind !== 'deterministic') {
      throw new TypeError('Deterministic providers must have kind deterministic and zero cost');
    }
    if (provider.id === this.local.id && provider !== this.local) {
      throw new Error(`Provider id already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): DeterministicProvider | undefined { return this.providers.get(id); }
  list(): DeterministicProvider[] { return [...this.providers.values()]; }

  resolve(input: { prompt: string }): Promise<DeterministicResult> {
    const key = JSON.stringify(input);
    const cached = this.memo.get(key);
    if (cached) return cached;
    const result = this.resolveUncached(input);
    this.memo.set(key, result);
    return result;
  }

  private async resolveUncached(input: { prompt: string }): Promise<DeterministicResult> {
    const chain = [...this.providers.values()].filter((provider) => provider.id !== this.local.id);
    chain.push(this.local);
    let lastError = 'unavailable';
    for (const provider of chain) {
      try {
        const result = await withTimeout(provider.classify(input), this.timeoutMs);
        if (result.ok) return { ...result, provider: provider.id };
        lastError = result.error ?? 'classification_failed';
      } catch (error) {
        lastError = error instanceof Error && error.message === 'timeout' ? 'timeout' : 'provider_error';
      }
    }
    // The local provider is expected to be total. Keep the return shape safe if a custom one fails.
    return { ok: false, error: lastError, provider: this.local.id };
  }
}

/** Builds the opt-in default chain: configured Laya, configured Jev, local scorer. */
export function createDefaultDeterministicRegistry(options: {
  enabled?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
} = {}): DeterministicRegistry {
  const registry = new DeterministicRegistry({ timeoutMs: options.timeoutMs });
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? env.GATESWARM_DETERMINISTIC_MODE === 'on';
  if (!enabled) return registry;

  const laya = createLayaDeterministicProvider(env.GATESWARM_LAYA_ENDPOINT);
  if (laya) registry.register(laya);
  const jevKey = env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
  if (jevKey) registry.register(createJevDeterministicProvider(createJevTierClient({ apiKey: jevKey }), 'jev'));
  return registry;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer!));
}

const defaultRegistry = createDefaultDeterministicRegistry();
/** Extension point for plugging in additional deterministic models. */
export function registerDeterministicProvider(provider: DeterministicProvider): void {
  defaultRegistry.register(provider);
}
