import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
  serverErrorTimestamps: number[];
  latestFailure: ProviderHealthAttempt;
}

interface PersistedProviderHealthState {
  providerId: string;
  unhealthyUntil: number;
}

interface PersistedProviderHealth {
  version: 1;
  cooldowns: PersistedProviderHealthState[];
}

export interface ProviderHealthAttempt {
  generation: number;
  timestamp: number;
}

const COOLDOWN_MS = 5 * 60 * 1000;
const HARD_FAILURES = new Set<ProviderFailureKind>(['auth', 'transport', 'timeout']);
const SERVER_ERROR_THRESHOLD = 3;
const MAX_PERSISTED_COOLDOWNS = 100;
const TERMINAL_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter']);

const AUTH_PATTERNS = [
  /failed to authenticate/i,
  /invalid (authentication|api key)/i,
  /\bunauthori[sz]ed\b/i,
  /\bapi error:?\s*(401|403)\b/i,
];

const API_ERROR_PATTERN = /\bapi error:?\s*\d{3,4}\b/i;
const RATE_LIMIT_PATTERN = /\brate limit(?:ed|s|ing)?\b/i;
const PROVIDER_ERROR_OPENING = /^(error|failed|api error|invalid|unauthori[sz]ed|rate limit|too many requests)\b/i;

function errorCode(value: any): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim().toLowerCase() : '';
}

function failureForStructuredError(error: any): ProviderBodyFailure | null {
  if (!error || typeof error !== 'object') return null;

  const code = errorCode(error.code ?? error.status ?? error.type);
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  const detail = message || code || 'provider returned a structured error';

  if (
    code === '401' || code === '403' || /auth|api[_ -]?key|unauthori[sz]ed/.test(code)
    || AUTH_PATTERNS.some(re => re.test(message)) || /\bapi error:?\s*(401|403)\b/i.test(message)
  ) {
    return { reason: 'provider_auth_error_body', kind: 'auth', message: detail };
  }
  if (
    code === '429' || code === '1305' || code === '1308' || /rate.?limit|too_many_requests|throttl/.test(code)
    || RATE_LIMIT_PATTERN.test(message) || /\b(429|1305|1308)\b/.test(message)
  ) {
    return { reason: 'provider_rate_limit_body', kind: 'rate_limit', message: detail };
  }
  if (/^5\d\d$/.test(code) || /server|internal/.test(code) || /server|internal/i.test(message)) {
    return { reason: 'provider_server_error_body', kind: 'server_error', message: detail };
  }
  if (code || message) return { reason: 'provider_error_body', kind: 'provider_error', message: detail };
  return null;
}

function hasUsableCompletion(data: any): boolean {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  if (!choice || typeof choice !== 'object') return false;

  const message = choice.message;
  const hasToolCall = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  const hasFunctionCall = !!message?.function_call;
  const terminal = TERMINAL_FINISH_REASONS.has(choice.finish_reason);
  if (hasToolCall || hasFunctionCall || terminal) return true;

  // Some compatible providers omit finish_reason despite returning a normal
  // message. A response-shaped completion must never be reclassified from
  // incidental prose inside its content.
  return contentToText(message?.content ?? choice.text).trim().length > 0;
}

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

  if (shortEnoughToBeProviderError && PROVIDER_ERROR_OPENING.test(normalized) && AUTH_PATTERNS.some(re => re.test(normalized))) {
    return { reason: 'provider_auth_error_body', kind: 'auth', message: normalized };
  }

  if (shortEnoughToBeProviderError && PROVIDER_ERROR_OPENING.test(normalized) && API_ERROR_PATTERN.test(normalized)) {
    const code = normalized.match(/\bapi error:?\s*(\d{3,4})\b/i)?.[1];
    const kind: ProviderFailureKind = code === '401' || code === '403'
      ? 'auth'
      : code === '429' || code === '1305' || code === '1308'
        ? 'rate_limit'
        : code !== undefined && /^5\d\d$/.test(code)
          ? 'server_error'
          : 'provider_error';
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
  if (hasUsableCompletion(data)) return null;

  const structuredError = failureForStructuredError(data?.error);
  if (structuredError) return structuredError;

  return getUnusableContentReason(extractProviderResponseText(data));
}

export function providerFailureKindForHttp(status: number, body: unknown = ''): ProviderFailureKind {
  let parsedBody = body;
  if (typeof body === 'string') {
    try { parsedBody = JSON.parse(body); } catch {}
  }
  const structuredError = typeof parsedBody === 'object' && parsedBody !== null
    ? failureForStructuredError((parsedBody as any).error ?? parsedBody)
    : null;
  if (structuredError) return structuredError.kind;

  const text = typeof body === 'string' ? body : '';
  const providerCode = text.match(/\bapi error:?\s*(\d{3,4})\b/i)?.[1];
  if (providerCode === '401' || providerCode === '403') return 'auth';
  if (providerCode === '429' || providerCode === '1305' || providerCode === '1308') return 'rate_limit';
  if (providerCode !== undefined && /^5\d\d$/.test(providerCode)) return 'server_error';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || status === 1305 || status === 1308) return 'rate_limit';
  if (status >= 500) return 'server_error';
  if (PROVIDER_ERROR_OPENING.test(text) && AUTH_PATTERNS.some(re => re.test(text))) return 'auth';
  if (PROVIDER_ERROR_OPENING.test(text) && RATE_LIMIT_PATTERN.test(text)) return 'rate_limit';
  return 'provider_error';
}

export class ProviderHealthTracker {
  private states = new Map<string, ProviderHealthState>();
  private generation = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly log: (message: string) => void = (message) => console.log(message),
    private readonly persistencePath: string | null = null,
  ) {
    this.restoreCooldowns();
  }

  beginAttempt(_providerId: string): ProviderHealthAttempt {
    return { generation: ++this.generation, timestamp: this.now() };
  }

  getSkipReason(providerId: string): string | null {
    const state = this.states.get(providerId);
    if (!state || state.unhealthyUntil <= 0) return null;

    const remainingMs = state.unhealthyUntil - this.now();
    if (remainingMs > 0) {
      return `unhealthy cooldown ${Math.ceil(remainingMs / 1000)}s remaining`;
    }

    state.unhealthyUntil = 0;
    state.consecutiveHardFailures = 0;
    state.serverErrorTimestamps = [];
    this.persistCooldowns();
    this.log(`[ProviderHealth] ${providerId} cooldown expired; trying provider again`);
    return null;
  }

  recordFailure(
    providerId: string,
    kind: ProviderFailureKind,
    label = providerId,
    detail = '',
    attempt: ProviderHealthAttempt = this.beginAttempt(providerId),
  ): void {
    const state = this.states.get(providerId) ?? {
      consecutiveHardFailures: 0,
      unhealthyUntil: 0,
      serverErrorTimestamps: [],
      latestFailure: { generation: 0, timestamp: 0 },
    };
    if (attempt.generation < state.latestFailure.generation || attempt.timestamp < state.latestFailure.timestamp) return;
    state.latestFailure = attempt;

    if (HARD_FAILURES.has(kind)) {
      state.consecutiveHardFailures += 1;
      if (state.consecutiveHardFailures >= 2 && state.unhealthyUntil <= this.now()) {
        this.markUnhealthy(providerId, state, label, detail, `${state.consecutiveHardFailures} consecutive hard failures`);
      }
    }

    if (kind === 'server_error') {
      const windowStart = this.now() - COOLDOWN_MS;
      state.serverErrorTimestamps = state.serverErrorTimestamps.filter(timestamp => timestamp >= windowStart);
      state.serverErrorTimestamps.push(this.now());
      if (state.serverErrorTimestamps.length >= SERVER_ERROR_THRESHOLD && state.unhealthyUntil <= this.now()) {
        this.markUnhealthy(providerId, state, label, detail, `${state.serverErrorTimestamps.length} server errors within 300s`);
      }
    }

    this.states.set(providerId, state);
    this.persistCooldowns();
  }

  recordSuccess(providerId: string, attempt: ProviderHealthAttempt = this.beginAttempt(providerId)): void {
    const state = this.states.get(providerId);
    if (!state) return;
    if (attempt.generation < state.latestFailure.generation || attempt.timestamp < state.latestFailure.timestamp) return;
    const wasUnhealthy = state.unhealthyUntil > this.now();
    state.consecutiveHardFailures = 0;
    state.unhealthyUntil = 0;
    state.serverErrorTimestamps = [];
    this.persistCooldowns();
    if (wasUnhealthy) this.log(`[ProviderHealth] ${providerId} marked healthy after successful response`);
  }

  reset(): void {
    this.states.clear();
    this.persistCooldowns();
  }

  private markUnhealthy(providerId: string, state: ProviderHealthState, label: string, detail: string, reason: string): void {
    state.unhealthyUntil = this.now() + COOLDOWN_MS;
    const suffix = detail ? `: ${detail}` : '';
    this.log(`[ProviderHealth] ${providerId} marked unhealthy for 300s after ${reason} on ${label}${suffix}`);
  }

  private restoreCooldowns(): void {
    if (!this.persistencePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.persistencePath, 'utf8')) as Partial<PersistedProviderHealth>;
      if (parsed.version !== 1 || !Array.isArray(parsed.cooldowns)) return;
      const now = this.now();
      for (const cooldown of parsed.cooldowns.slice(0, MAX_PERSISTED_COOLDOWNS)) {
        if (typeof cooldown?.providerId !== 'string' || !Number.isFinite(cooldown.unhealthyUntil) || cooldown.unhealthyUntil <= now) continue;
        this.states.set(cooldown.providerId, {
          consecutiveHardFailures: 0,
          unhealthyUntil: cooldown.unhealthyUntil,
          serverErrorTimestamps: [],
          latestFailure: { generation: 0, timestamp: 0 },
        });
      }
    } catch {
      // Health persistence is advisory: an unavailable or corrupt file must
      // never prevent the router from starting.
    }
  }

  private persistCooldowns(): void {
    if (!this.persistencePath) return;
    try {
      const now = this.now();
      const cooldowns = [...this.states.entries()]
        .filter(([, state]) => state.unhealthyUntil > now)
        .sort(([, a], [, b]) => b.unhealthyUntil - a.unhealthyUntil)
        .slice(0, MAX_PERSISTED_COOLDOWNS)
        .map(([providerId, state]) => ({ providerId, unhealthyUntil: state.unhealthyUntil }));
      if (cooldowns.length === 0) {
        try { unlinkSync(this.persistencePath); } catch {}
        return;
      }
      mkdirSync(dirname(this.persistencePath), { recursive: true });
      const data: PersistedProviderHealth = { version: 1, cooldowns };
      writeFileSync(this.persistencePath, JSON.stringify(data), 'utf8');
    } catch {
      // Best-effort persistence deliberately does not affect request routing.
    }
  }
}

export const providerHealth = new ProviderHealthTracker(
  () => Date.now(),
  (message) => console.log(message),
  resolve(process.cwd(), 'data', 'provider-health.json'),
);

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
    const attemptInfo = health.beginAttempt(target.providerId);
    let result: ProviderAttemptResult<TData>;
    try {
      result = await attempt(target);
    } catch (error: any) {
      result = {
        ok: false,
        kind: 'transport',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.ok) {
      health.recordSuccess(target.providerId, attemptInfo);
      return { ok: true, target, data: result.data, tried };
    }

    health.recordFailure(target.providerId, result.kind, target.label, result.message, attemptInfo);
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
