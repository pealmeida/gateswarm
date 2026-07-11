export type ProviderFailureKind =
  | 'auth'
  | 'transport'
  | 'timeout'
  | 'rate_limit'
  | 'server_error'
  | 'provider_error'
  | 'unusable_body';

export interface ProviderBodyFailure {
  reason: string;
  kind: ProviderFailureKind;
  message: string;
}

export interface ProviderFallbackTarget {
  providerId: string;
  model: string;
  label: string;
}

export type ProviderAttemptResult<TData> =
  | { ok: true; data: TData }
  | { ok: false; kind: ProviderFailureKind; message: string; status?: number };

export type ProviderFallbackResult<TTarget extends ProviderFallbackTarget, TData> =
  | { ok: true; target: TTarget; data: TData; tried: string[] }
  | { ok: false; status: 502; error: { message: string; type: 'provider_chain_exhausted'; tried: string[] }; tried: string[] };

interface ProviderHealthState {
  consecutiveHardFailures: number;
  unhealthyUntil: number;
}

const COOLDOWN_MS = 5 * 60 * 1000;
const HARD_FAILURES = new Set<ProviderFailureKind>(['auth', 'transport', 'timeout']);

const AUTH_PATTERNS = [
  /failed to authenticate/i,
  /invalid (authentication|api key)/i,
  /\bunauthori[sz]ed\b/i,
  /\bapi error:?\s*(401|403)\b/i,
];

const API_ERROR_PATTERN = /\bapi error:?\s*\d{3}\b/i;
const RATE_LIMIT_PATTERN = /\brate limit(?:ed|s|ing)?\b/i;
const PROVIDER_ERROR_OPENING = /^(error|failed|api error|invalid|unauthori[sz]ed|rate limit|too many requests)\b/i;

function contentToText(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);

  if (Array.isArray(content)) {
    return content.map(contentToText).filter(t => t.trim().length > 0).join('\n');
  }

  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.input_text === 'string') return content.input_text;
    if (typeof content.output_text === 'string') return content.output_text;
    if (typeof content.content === 'string' || Array.isArray(content.content)) return contentToText(content.content);
    if (typeof content.message === 'string' || typeof content.message === 'object') return contentToText(content.message);
    if (typeof content.value === 'string') return content.value;
  }

  return '';
}

export function extractProviderResponseText(data: any): string {
  if (!data) return '';

  if (typeof data === 'string') return data;
  if (typeof data.output_text === 'string') return data.output_text;
  if (typeof data.text === 'string') return data.text;
  if (typeof data.content === 'string' || Array.isArray(data.content)) return contentToText(data.content);

  const err = data.error;
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;

  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice) {
    if (choice.message?.content !== undefined) return contentToText(choice.message.content);
    if (choice.delta?.content !== undefined) return contentToText(choice.delta.content);
    if (choice.text !== undefined) return contentToText(choice.text);
  }

  return '';
}

export function getUnusableContentReason(content: any): ProviderBodyFailure | null {
  const text = contentToText(content).trim();
  if (!text) {
    return { reason: 'empty_body', kind: 'unusable_body', message: 'empty response body' };
  }

  const normalized = text.replace(/\s+/g, ' ');
  const shortEnoughToBeProviderError = normalized.length <= 500;

  if (shortEnoughToBeProviderError && AUTH_PATTERNS.some(re => re.test(normalized))) {
    return { reason: 'provider_auth_error_body', kind: 'auth', message: normalized };
  }

  if (shortEnoughToBeProviderError && API_ERROR_PATTERN.test(normalized)) {
    const kind: ProviderFailureKind = /\bapi error:?\s*(401|403)\b/i.test(normalized) ? 'auth' : 'provider_error';
    return { reason: 'provider_api_error_body', kind, message: normalized };
  }

  // Rate-limit mentions only count as an error body when the text READS like
  // an error (error-ish opening) — a short legitimate answer about handling
  // rate limits must not be discarded. HTTP-level 429s are caught separately.
  if (
    shortEnoughToBeProviderError &&
    RATE_LIMIT_PATTERN.test(normalized) &&
    PROVIDER_ERROR_OPENING.test(normalized)
  ) {
    return { reason: 'provider_rate_limit_body', kind: 'rate_limit', message: normalized };
  }

  return null;
}

export function getUnusableProviderBodyReason(data: any): ProviderBodyFailure | null {
  return getUnusableContentReason(extractProviderResponseText(data));
}

export function providerFailureKindForHttp(status: number, body = ''): ProviderFailureKind {
  if (status === 401 || status === 403 || AUTH_PATTERNS.some(re => re.test(body))) return 'auth';
  if (status === 429 || status === 1305 || status === 1308 || RATE_LIMIT_PATTERN.test(body)) return 'rate_limit';
  if (status >= 500) return 'server_error';
  return 'provider_error';
}

export class ProviderHealthTracker {
  private states = new Map<string, ProviderHealthState>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly log: (message: string) => void = (message) => console.log(message),
  ) {}

  getSkipReason(providerId: string): string | null {
    const state = this.states.get(providerId);
    if (!state || state.unhealthyUntil <= 0) return null;

    const remainingMs = state.unhealthyUntil - this.now();
    if (remainingMs > 0) {
      return `unhealthy cooldown ${Math.ceil(remainingMs / 1000)}s remaining`;
    }

    state.unhealthyUntil = 0;
    state.consecutiveHardFailures = 0;
    this.log(`[ProviderHealth] ${providerId} cooldown expired; trying provider again`);
    return null;
  }

  recordFailure(providerId: string, kind: ProviderFailureKind, label = providerId, detail = ''): void {
    const state = this.states.get(providerId) ?? { consecutiveHardFailures: 0, unhealthyUntil: 0 };

    if (HARD_FAILURES.has(kind)) {
      state.consecutiveHardFailures += 1;
      if (state.consecutiveHardFailures >= 2 && state.unhealthyUntil <= this.now()) {
        state.unhealthyUntil = this.now() + COOLDOWN_MS;
        const suffix = detail ? `: ${detail}` : '';
        this.log(`[ProviderHealth] ${providerId} marked unhealthy for 300s after ${state.consecutiveHardFailures} consecutive hard failures on ${label}${suffix}`);
      }
    } else {
      state.consecutiveHardFailures = 0;
    }

    this.states.set(providerId, state);
  }

  recordSuccess(providerId: string): void {
    const state = this.states.get(providerId);
    if (!state) return;
    const wasUnhealthy = state.unhealthyUntil > this.now();
    state.consecutiveHardFailures = 0;
    state.unhealthyUntil = 0;
    if (wasUnhealthy) this.log(`[ProviderHealth] ${providerId} marked healthy after successful response`);
  }

  reset(): void {
    this.states.clear();
  }
}

export const providerHealth = new ProviderHealthTracker();

export async function runProviderFallbackChain<TTarget extends ProviderFallbackTarget, TData>(
  targets: TTarget[],
  attempt: (target: TTarget) => Promise<ProviderAttemptResult<TData>>,
  options: {
    health?: ProviderHealthTracker;
    shouldSkip?: (target: TTarget) => string | null;
    onSkip?: (target: TTarget, reason: string) => void;
    onFailure?: (target: TTarget, failure: Exclude<ProviderAttemptResult<TData>, { ok: true }>) => void;
  } = {},
): Promise<ProviderFallbackResult<TTarget, TData>> {
  const health = options.health ?? providerHealth;
  const tried: string[] = [];

  for (const target of targets) {
    const healthSkip = health.getSkipReason(target.providerId);
    const explicitSkip = healthSkip ?? options.shouldSkip?.(target) ?? null;
    if (explicitSkip) {
      tried.push(`${target.label} (skipped: ${explicitSkip})`);
      options.onSkip?.(target, explicitSkip);
      continue;
    }

    tried.push(target.label);
    const result = await attempt(target);
    if (result.ok) {
      health.recordSuccess(target.providerId);
      return { ok: true, target, data: result.data, tried };
    }

    health.recordFailure(target.providerId, result.kind, target.label, result.message);
    options.onFailure?.(target, result);
  }

  return {
    ok: false,
    status: 502,
    error: {
      message: `All providers failed or returned unusable responses (tried: ${tried.join(' -> ')})`,
      type: 'provider_chain_exhausted',
      tried,
    },
    tried,
  };
}
