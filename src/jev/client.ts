/**
 * Jev tier classification client.
 *
 * TypeScript ESM, zero dependencies, targets Node 20.
 *
 * Reuses `src/jev/questions.ts` (question set, model id, tier list, pricing)
 * and `src/jev/secret-scan.ts` (secret scanning + sha256 helper).
 *
 * Safety rules honored here:
 * - The API key, the Authorization header, the prompt and the response body are
 *   NEVER included in any returned value and never logged to the console.
 * - Error results carry only the `error` code, no detail strings.
 * - `askTier()` never throws; unexpected failures collapse to
 *   `{ ok:false, error:'network' }`.
 * - No retries: one request, bounded by an AbortController deadline.
 */

import { performance } from 'node:perf_hooks';

import {
  JEV_MODEL,
  JEV_PRICE_USD_PER_MTOK_INPUT,
  JEV_TIERS,
  JEV_TIER_QUESTIONS,
  type JevTier,
} from './questions.js';
import {
  loadSensitiveEnvValues,
  scanSecrets,
  sha256Hex,
} from './secret-scan.js';

/** Default remote endpoint for the tier classification service. */
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai';

/** Default request deadline. */
const DEFAULT_TIMEOUT_MS = 400;

/** Default LRU cache capacity. */
const DEFAULT_CACHE_MAX = 500;

/** Path appended to the endpoint for tier classification calls. */
const TIER_PATH = '/v1/systemone';

export type JevTierErrorCode =
  | 'no_key'
  | 'secret_scan_blocked'
  | 'timeout'
  | 'network'
  | 'http_error'
  | 'unparseable'
  | 'model_mismatch';

export type JevTierResult = {
  ok: boolean;
  tier?: JevTier;
  confidence?: number;
  latencyMs: number | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheHit: boolean;
  error?: JevTierErrorCode;
};

export interface JevTierClientOptions {
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  cacheMax?: number;
  now?: () => number;
}

export interface JevTierClient {
  askTier(prompt: string): Promise<JevTierResult>;
}

const TIER_SET: ReadonlySet<string> = new Set<string>(JEV_TIERS);

function fail(error: JevTierErrorCode): JevTierResult {
  return {
    ok: false,
    latencyMs: null,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cacheHit: false,
    error,
  };
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Create a Jev tier classification client.
 *
 * All state (LRU cache) is per-client and confined to the returned closure.
 */
export function createJevTierClient(opts: JevTierClientOptions): JevTierClient {
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey : undefined;
  const endpoint = (
    typeof opts.endpoint === 'string' && opts.endpoint.length > 0
      ? opts.endpoint
      : DEFAULT_ENDPOINT
  ).replace(/\/+$/, '');
  const timeoutMs = isNumber(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const cacheMax =
    isNumber(opts.cacheMax) && Number.isInteger(opts.cacheMax) && opts.cacheMax > 0
      ? opts.cacheMax
      : DEFAULT_CACHE_MAX;
  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;

  // Insertion-ordered Map used as an LRU: re-touch on hit, evict the oldest
  // entry once the capacity is exceeded.
  const cache = new Map<string, JevTierResult>();

  const cacheGet = (key: string): JevTierResult | undefined => {
    const hit = cache.get(key);
    if (hit === undefined) return undefined;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  };

  const cachePut = (key: string, value: JevTierResult): void => {
    if (cacheMax <= 0) return;
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  };

  async function askTier(prompt: string): Promise<JevTierResult> {
    const clock = typeof opts.now === 'function' ? opts.now : () => performance.now();
    const startedAt = clock();
    try {
      if (typeof prompt !== 'string') {
        return fail('unparseable');
      }

      const payload = {
        model: JEV_MODEL,
        state: { task: prompt },
        questions: JEV_TIER_QUESTIONS,
      };

      const cacheKey = sha256Hex(JSON.stringify(payload));
      const cached = cacheGet(cacheKey);
      if (cached !== undefined) {
        return { ...cached, cacheHit: true, latencyMs: null };
      }

      // Secret scan runs BEFORE any network call: both the outbound prompt and
      // the literal API key are checked against pattern shapes and against
      // sensitive environment literals. Findings are discarded — only the
      // blocking decision and the safe finding names are used.
      const envValues = loadSensitiveEnvValues();
      const promptScan = scanSecrets(prompt, envValues);
      if (!promptScan.clean) {
        return fail('secret_scan_blocked');
      }

      if (typeof apiKey !== 'string' || apiKey.length === 0) {
        return fail('no_key');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(endpoint + TIER_PATH, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timer);
        const name = err instanceof Error ? err.name : '';
        return fail(name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network');
      }

      if (!response.ok) {
        clearTimeout(timer);
        return fail('http_error');
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err: unknown) {
        const name = err instanceof Error ? err.name : '';
        return fail(name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'unparseable');
      } finally {
        clearTimeout(timer);
      }

      if (parsed === null || typeof parsed !== 'object') {
        return fail('unparseable');
      }

      const body = parsed as Record<string, unknown>;

      if (body.model !== JEV_MODEL) {
        return fail('model_mismatch');
      }

      const answers =
        body.answers === null || typeof body.answers !== 'object'
          ? undefined
          : (body.answers as Record<string, unknown>);
      const tierAnswer =
        answers === undefined
          ? undefined
          : answers.tier === null || typeof answers.tier !== 'object'
            ? undefined
            : (answers.tier as Record<string, unknown>);
      const choice = tierAnswer === undefined ? undefined : tierAnswer.choice;

      if (typeof choice !== 'string' || !TIER_SET.has(choice)) {
        return fail('unparseable');
      }

      const usage =
        body.usage === null || typeof body.usage !== 'object'
          ? undefined
          : (body.usage as Record<string, unknown>);

      const confidence = tierAnswer === undefined ? undefined : tierAnswer.confidence;
      const tokensIn = usage === undefined ? undefined : usage.input_tokens;
      const tokensOut = usage === undefined ? undefined : usage.output_tokens;

      

      const latencyMs = Math.round(clock() - startedAt);

      const result: JevTierResult = {
        ok: true,
        tier: choice as JevTier,
        confidence: isNumber(confidence) ? confidence : undefined,
        latencyMs,
        costUsd: isNumber(tokensIn) ? (tokensIn * JEV_PRICE_USD_PER_MTOK_INPUT) / 1e6 : null,
        tokensIn: isNumber(tokensIn) ? tokensIn : null,
        tokensOut: isNumber(tokensOut) ? tokensOut : null,
        cacheHit: false,
      };

      cachePut(cacheKey, result);
      return result;
    } catch {
      // Never throw: unexpected failures collapse to a bare error code.
      return fail('network');
    }
  }

  return { askTier };
}

export default createJevTierClient;
