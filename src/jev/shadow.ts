/**
 * Jev SHADOW observer.
 *
 * TypeScript ESM, zero dependencies, targets Node 20.
 *
 * Purpose: mirror production routing traffic into the Jev tier classifier and
 * record what Jev *would* have said, without ever influencing the routing
 * decision. The shadow observer is strictly observational:
 *
 * - `observe()` is synchronous, returns `void` immediately and NEVER throws.
 *   Nothing is awaited in the caller; work happens on detached promises.
 * - The routing decision (and the request path) is never blocked, never
 *   altered and never delayed by this module.
 * - Mode is re-read from the environment on EVERY call: when the mode is
 *   `off` (the default) `observe()` returns immediately with zero side
 *   effects — no file I/O, no network, not even a hash of the prompt.
 *
 * Safety / privacy rules honored here:
 * - Records NEVER contain the prompt text, the API key, the Authorization
 *   header or any response body. Only a sha256 of the prompt, its length and
 *   classifier metadata are persisted.
 * - `privacy: 'private'` prompts are never hashed and never sent anywhere;
 *   only a `skipped/private` record with a redacted digest is written.
 * - Every failure path is swallowed (fail-open): a broken shadow must never
 *   take down the gateway.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJevTierClient, type JevTierResult } from './client.js';
import { JEV_MODEL, JEV_TIERS, type JevTier } from './questions.js';
import { sha256Hex } from './secret-scan.js';

/** Repo root, resolved the same way `src/benchmark-logger.ts` does it. */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

/** Default JSONL sink when `GATESWARM_JEV_LOG` is unset. */
const DEFAULT_LOG_PATH = join(REPO_ROOT, 'data', 'jev-shadow', 'jev-shadow.jsonl');

/** Default max concurrent shadow classifications. */
const DEFAULT_MAX_INFLIGHT = 4;

/** Default request deadline for the shadow client. */
const DEFAULT_TIMEOUT_MS = 400;

/** Digest placeholder used for prompts we must not hash (`private`). */
const REDACTED_SHA = 'redacted';

/** Record schema tag. */
const SCHEMA_VERSION = 'jev-shadow.v1' as const;

/**
 * Shadow mode. Only the literal value `shadow` (trimmed, case-insensitive) in
 * `GATESWARM_JEV_MODE` enables observation; everything else — unset, `on`,
 * `1`, `true`, `yes`, garbage — means `off`.
 */
export type JevMode = 'off' | 'shadow';

/**
 * Read the Jev shadow mode from the environment.
 *
 * Deliberately conservative: `on`/`1`/`true` do NOT enable the shadow
 * observer, because shadow mode is opt-in by exact value only.
 */
export function getJevMode(env: NodeJS.ProcessEnv = process.env): JevMode {
  const raw = env.GATESWARM_JEV_MODE;
  if (typeof raw !== 'string') return 'off';
  return raw.trim().toLowerCase() === 'shadow' ? 'shadow' : 'off';
}

/** Input handed to the shadow observer at a scoring / routing site. */
export interface JevShadowInput {
  /** The user prompt. Never persisted; only hashed (unless private). */
  prompt: string;
  /** Tier the production scorer picked. */
  scorerTier: string;
  /** Optional scorer confidence / score. */
  scorerScore?: number;
  /** Optional correlation id. */
  requestId?: string;
  /** Where in the pipeline the observation was taken. */
  source: 'score' | 'route';
  /** Privacy class. `private` prompts are never sent nor hashed. */
  privacy?: 'public' | 'internal' | 'private';
}

/**
 * One JSONL line. Contains no prompt text, no API key, no response bodies.
 */
export interface JevShadowRecord {
  schema_version: typeof SCHEMA_VERSION;
  /** ISO timestamp. */
  ts: string;
  source: 'score' | 'route';
  request_id: string | null;
  /** sha256 hex of the prompt, or 'redacted' for private prompts. */
  prompt_sha256: string;
  prompt_chars: number;
  scorer_tier: string;
  scorer_score: number | null;
  status: 'ok' | 'skipped' | 'error';
  /** skipped: private | secret_scan_blocked | overloaded | no_key; error: client error code. */
  reason: string | null;
  jev_tier: string | null;
  jev_confidence: number | null;
  /** true when Jev disagreed with the production scorer. */
  diverged: boolean | null;
  /** index(jev tier) - index(scorer tier) in JEV_TIERS. */
  tier_delta: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  cache_hit: boolean;
  jev_model: typeof JEV_MODEL;
}

/** Minimal client surface the observer needs (injectable for tests). */
export interface JevShadowClient {
  askTier(prompt: string): Promise<JevTierResult>;
}

export interface JevShadowOptions {
  /** Environment to read config from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable client (tests). Defaults to `createJevTierClient`, built lazily, once. */
  client?: JevShadowClient;
  /** Explicit JSONL path. Defaults to `GATESWARM_JEV_LOG` or the repo data dir. */
  logPath?: string;
  /** Max concurrent shadow calls. Default 4; excess calls are logged `skipped/overloaded`. */
  maxInflight?: number;
  /** Request deadline override (ms). Default `GATESWARM_JEV_TIMEOUT_MS` or 400. */
  timeoutMs?: number;
  /** Record sink (tests). When provided it replaces file logging entirely. */
  writeRecord?: (rec: JevShadowRecord) => void;
}

export interface JevShadow {
  /** Fire-and-forget observation. Synchronous, never throws. */
  observe(input: JevShadowInput): void;
  /** Wait for all in-flight work (and pending writes) to settle. Never throws. */
  drain(): Promise<void>;
}

function normalizeMaxInflight(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_MAX_INFLIGHT;
  if (!Number.isInteger(v) || v < 1) return DEFAULT_MAX_INFLIGHT;
  return v;
}

/** Sampling rate in [0, 1]; anything unparsable or out of range means 1 (keep all). */
function readSample(env: NodeJS.ProcessEnv): number {
  const raw = env.GATESWARM_JEV_SAMPLE;
  if (typeof raw !== 'string' || raw.trim() === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 1;
  return n;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Create a shadow observer. All mutable state (in-flight set, write chain,
 * lazily built client) is confined to the returned closure.
 */
export function createJevShadow(opts: JevShadowOptions = {}): JevShadow {
  const env: NodeJS.ProcessEnv = opts.env ?? process.env;
  const maxInflight = normalizeMaxInflight(opts.maxInflight);
  const sink = typeof opts.writeRecord === 'function' ? opts.writeRecord : null;

  // Lazily built, exactly once (the injected client counts as "built").
  let client: JevShadowClient | null = typeof opts.client === 'object' && opts.client !== null ? opts.client : null;
  let clientBuilt = client !== null;

  // Lazily resolved log path + one-time recursive mkdir.
  let logPath: string | null = null;
  let dirEnsured: Promise<void> | null = null;

  // Detached in-flight observations + serialized appends (keeps JSONL order).
  const inflight = new Set<Promise<void>>();
  let writeChain: Promise<void> = Promise.resolve();

  function getClient(): JevShadowClient {
    if (!clientBuilt) {
      clientBuilt = true;
      client = createJevTierClient({
        apiKey: env.TYPESAFE_API_KEY ?? env.JEV_API_KEY,
        timeoutMs:
          typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
            ? opts.timeoutMs
            : Number(env.GATESWARM_JEV_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
      });
    }
    return client as JevShadowClient;
  }

  function resolveLogPath(): string {
    if (logPath === null) {
      const fromEnv = env.GATESWARM_JEV_LOG;
      logPath =
        typeof opts.logPath === 'string' && opts.logPath.length > 0
          ? opts.logPath
          : typeof fromEnv === 'string' && fromEnv.length > 0
            ? fromEnv
            : DEFAULT_LOG_PATH;
    }
    return logPath;
  }

  function ensureDir(): Promise<void> {
    if (dirEnsured === null) {
      dirEnsured = fs.mkdir(dirname(resolveLogPath()), { recursive: true }).then(
        () => undefined,
        () => undefined,
      );
    }
    return dirEnsured;
  }

  /** Emit a record: either the injected sink (sync) or an append to the JSONL file. */
  function emit(rec: JevShadowRecord): void {
    if (sink !== null) {
      try {
        sink(rec);
      } catch {
        // fail-open: a broken sink must never propagate.
      }
      return;
    }
    writeChain = writeChain
      .then(async () => {
        await ensureDir();
        await fs.appendFile(resolveLogPath(), `${JSON.stringify(rec)}\n`, 'utf8');
      })
      .catch(() => {
        // fail-open: logging failures are dropped, never thrown.
      });
  }

  function baseRecord(input: JevShadowInput, promptSha: string): JevShadowRecord {
    return {
      schema_version: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      source: input.source === 'route' ? 'route' : 'score',
      request_id: typeof input.requestId === 'string' && input.requestId.length > 0 ? input.requestId : null,
      prompt_sha256: promptSha,
      prompt_chars: typeof input.prompt === 'string' ? input.prompt.length : 0,
      scorer_tier: typeof input.scorerTier === 'string' ? input.scorerTier : '',
      scorer_score: isFiniteNumber(input.scorerScore) ? input.scorerScore : null,
      status: 'skipped',
      reason: null,
      jev_tier: null,
      jev_confidence: null,
      diverged: null,
      tier_delta: null,
      latency_ms: null,
      cost_usd: null,
      cache_hit: false,
      jev_model: JEV_MODEL,
    };
  }

  /** Fold a client result into a record. */
  function applyResult(rec: JevShadowRecord, result: JevTierResult): void {
    rec.latency_ms = isFiniteNumber(result.latencyMs) ? result.latencyMs : null;
    rec.cache_hit = result.cacheHit === true;
    rec.cost_usd = rec.cache_hit ? 0 : isFiniteNumber(result.costUsd) ? result.costUsd : null; // cache hit = no new spend

    if (result.ok === true && typeof result.tier === 'string') {
      rec.status = 'ok';
      rec.reason = null;
      rec.jev_tier = result.tier;
      rec.jev_confidence = isFiniteNumber(result.confidence) ? result.confidence : null;
      rec.diverged = result.tier !== rec.scorer_tier;
      const jevIdx = JEV_TIERS.indexOf(result.tier as JevTier);
      const scorerIdx = JEV_TIERS.indexOf(rec.scorer_tier as JevTier);
      rec.tier_delta = jevIdx >= 0 && scorerIdx >= 0 ? jevIdx - scorerIdx : null;
      return;
    }

    const code = typeof result.error === 'string' ? result.error : 'network';
    // Refusals that are expected / cost-free to report as non-errors.
    rec.status = code === 'secret_scan_blocked' || code === 'no_key' ? 'skipped' : 'error';
    rec.reason = code;
  }

  async function run(input: JevShadowInput, promptSha: string): Promise<void> {
    const rec = baseRecord(input, promptSha);
    try {
      const result = await getClient().askTier(input.prompt);
      applyResult(rec, result);
    } catch {
      // askTier() is documented as never-throwing; this is belt-and-braces.
      rec.status = 'error';
      rec.reason = 'network';
    }
    emit(rec);
  }

  function observe(input: JevShadowInput): void {
    try {
      // Mode is re-read on every call: no cached enablement, no cached
      // disablement. `off` bails out before any side effect at all.
      if (getJevMode(env) !== 'shadow') return;
      if (typeof input?.prompt !== 'string' || typeof input.scorerTier !== 'string') return;

      // Sampling: drop silently (no record, no call).
      const sample = readSample(env);
      if (sample < 1 && Math.random() >= sample) return;

      // Private prompts: never hashed, never sent anywhere.
      if (input.privacy === 'private') {
        const rec = baseRecord(input, REDACTED_SHA);
        rec.reason = 'private';
        emit(rec);
        return;
      }

      const promptSha = sha256Hex(input.prompt);

      // Shed load instead of queueing: the shadow must never build a backlog.
      if (inflight.size >= maxInflight) {
        const rec = baseRecord(input, promptSha);
        rec.reason = 'overloaded';
        emit(rec);
        return;
      }

      const task = run(input, promptSha);
      inflight.add(task);
      // Self-removal, both settle paths; never observed by the caller.
      void task.then(
        () => inflight.delete(task),
        () => inflight.delete(task),
      );
    } catch {
      // fail-open: the shadow observer never throws into the request path.
    }
  }

  async function drain(): Promise<void> {
    try {
      while (inflight.size > 0) {
        await Promise.all([...inflight]).catch(() => undefined);
      }
      // Records are enqueued before their task settles, so once the in-flight
      // set is drained the write chain holds every pending append.
      await writeChain;
    } catch {
      // fail-open.
    }
  }

  return { observe, drain };
}

/** Module-level singleton on `process.env`, built on first use. */
let singleton: JevShadow | null = null;

/**
 * Convenience entry point for call sites: `jevShadowObserve({...})`.
 *
 * Synchronous, never throws, and does nothing at all unless
 * `GATESWARM_JEV_MODE=shadow`.
 */
export function jevShadowObserve(input: JevShadowInput): void {
  try {
    if (singleton === null) singleton = createJevShadow();
    singleton.observe(input);
  } catch {
    // fail-open.
  }
}

export default createJevShadow;
