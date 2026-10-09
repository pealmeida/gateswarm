/**
 * Jev pre-delegation guard (informative, never blocking).
 *
 * Given a task description (+ optional metadata), a deterministic local rule set
 * flags risk areas and recommends: human review, mandatory tests, task split.
 * Optionally (GATESWARM_JEV_MODE=shadow) Jev is asked for a risk level over the
 * FLAGS ONLY (never task text); Jev may only harden the verdict, never soften it.
 *
 * Safety: fail-open, 800 ms default timeout, private tasks never sent, no task
 * text in logs/payloads, key never logged.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getJevMode } from './shadow.js';
import { JEV_MODEL } from './questions.js';
import { sha256Hex } from './secret-scan.js';

export const RISK_FLAGS = ['auth_session', 'migration_rls', 'production', 'secrets', 'deploy', 'dependencies'] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface PreDelegationInput {
  /** Task text. Used locally only; never logged or sent. */
  task: string;
  /** Optional metadata (counts only). */
  filesTouched?: number;
  privacy?: 'private' | 'public';
  requestId?: string;
}

export interface PreDelegationRecommendation {
  humanReview: boolean;
  mandatoryTests: boolean;
  splitTask: boolean;
}

export interface PreDelegationResult {
  schema_version: 'jev-predelegation.v1';
  flags: RiskFlag[];
  localRisk: RiskLevel;
  jevRisk: RiskLevel | null;
  finalRisk: RiskLevel;
  recommend: PreDelegationRecommendation;
  jevStatus: 'off' | 'private' | 'skipped' | 'ok' | 'error';
  hardenedByJev: boolean;
  note: string;
}

const RULES: ReadonlyArray<{ flag: RiskFlag; re: RegExp }> = [
  { flag: 'auth_session', re: /\b(auth|login|logout|sign[- ]?in|session|sess[aã]o|senha|password|jwt|oauth|token|cookie|refresh)\b/i },
  { flag: 'migration_rls', re: /\b(migrat\w*|rls|row[- ]level|alter table|drop (table|column)|schema|policy|policies|sql)\b/i },
  { flag: 'production', re: /\b(prod|production|produ[cç][aã]o|live|hotfix)\b/i },
  { flag: 'secrets', re: /\b(secrets?|api[_ -]?keys?|credentials?|chave|\.env|private key|segredo)\b/i },
  { flag: 'deploy', re: /\b(deploy\w*|release|rollout|rollback|promote|vercel|ci\/cd|pipeline|merge)\b/i },
  { flag: 'dependencies', re: /\b(depend[eê]ncias?|dependenc\w*|npm (i|install|update)|upgrade|package(-lock)?\.json|lockfile|bump)\b/i },
];

const HIGH_FLAGS: ReadonlySet<RiskFlag> = new Set<RiskFlag>(['auth_session', 'migration_rls', 'secrets']);
const SPLIT_TEXT_CHARS = 1500;
const SPLIT_FILES = 10;
const SPLIT_BULLETS = 8;

const rank = (r: RiskLevel): number => RISK_LEVELS.indexOf(r);
const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (rank(a) >= rank(b) ? a : b);

export function detectFlags(task: string): RiskFlag[] {
  const text = typeof task === 'string' ? task : '';
  return RULES.filter((r) => r.re.test(text)).map((r) => r.flag);
}

function localRiskOf(flags: RiskFlag[]): RiskLevel {
  if (flags.some((f) => HIGH_FLAGS.has(f))) return 'high';
  if (flags.includes('production') && flags.length > 1) return 'high';
  return flags.length > 0 ? 'medium' : 'low';
}

function isLarge(input: PreDelegationInput): boolean {
  const text = typeof input.task === 'string' ? input.task : '';
  const bullets = (text.match(/^\s*(?:[-*]|\d+[.)])\s+/gm) ?? []).length;
  return (
    text.length > SPLIT_TEXT_CHARS ||
    bullets >= SPLIT_BULLETS ||
    (typeof input.filesTouched === 'number' && input.filesTouched > SPLIT_FILES)
  );
}

function recommend(flags: RiskFlag[], risk: RiskLevel, large: boolean): PreDelegationRecommendation {
  return {
    humanReview: risk === 'high' || flags.includes('production') || flags.includes('deploy'),
    mandatoryTests: flags.includes('auth_session') || flags.includes('migration_rls') || flags.includes('dependencies') || risk === 'high',
    splitTask: large || (flags.length >= 3),
  };
}

/** Pure, deterministic local decision (no network). */
export function assessLocally(input: PreDelegationInput): Pick<PreDelegationResult, 'flags' | 'localRisk' | 'recommend'> {
  const flags = detectFlags(input.task);
  const localRisk = localRiskOf(flags);
  return { flags, localRisk, recommend: recommend(flags, localRisk, isLarge(input)) };
}

export type JevRiskFn = (flags: RiskFlag[], meta: { large: boolean }) => Promise<RiskLevel | null>;

const DEFAULT_TIMEOUT_MS = 800;
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Jev risk question over flags only. Returns null on any failure (fail-open). */
export function createJevRiskFn(opts: { apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch; endpoint?: string }): JevRiskFn {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  return async (flags, meta) => {
    if (!opts.apiKey) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(opts.endpoint ?? ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: JEV_MODEL,
          state: { risk_flags: flags, flag_count: flags.length, large_task: meta.large },
          questions: {
            risk: {
              type: 'choice',
              instructions:
                'Given only the risk flags of a software task about to be delegated to an AI agent, classify the overall risk of delegating it without human review.',
              criteria: {
                low: 'No risk flags.',
                medium: 'Limited-impact areas such as dependencies or deploy tooling.',
                high: 'Auth/session, migrations/RLS, secrets, or production-touching changes.',
              },
            },
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { model?: unknown; answers?: { risk?: { choice?: unknown } } };
      if (body?.model !== JEV_MODEL) return null;
      const c = body.answers?.risk?.choice;
      return typeof c === 'string' && (RISK_LEVELS as readonly string[]).includes(c) ? (c as RiskLevel) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG = join(HERE, '..', '..', 'data', 'jev-shadow', 'jev-predelegation.jsonl');

export interface PreDelegationOptions {
  env?: NodeJS.ProcessEnv;
  jevRisk?: JevRiskFn;
  logPath?: string;
  /** Test sink replacing file logging. */
  writeRecord?: (rec: Record<string, unknown>) => void;
}

function buildNote(r: Omit<PreDelegationResult, 'note'>): string {
  const recs = [r.recommend.humanReview && 'revisão humana', r.recommend.mandatoryTests && 'teste obrigatório', r.recommend.splitTask && 'dividir tarefa'].filter(Boolean);
  return `[jev-pre-delegation, informativo] risco=${r.finalRisk}` +
    (r.flags.length ? ` flags=${r.flags.join(',')}` : '') +
    (recs.length ? ` recomenda: ${recs.join(', ')}` : ' sem recomendações') +
    (r.hardenedByJev ? ' (Jev endureceu)' : '') + ` jev=${r.jevStatus}`;
}

async function log(rec: Record<string, unknown>, opts: PreDelegationOptions, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    if (opts.writeRecord) return void opts.writeRecord(rec);
    const p = opts.logPath ?? env.GATESWARM_JEV_PREDELEGATION_LOG ?? DEFAULT_LOG;
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.appendFile(p, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch {
    /* fail-open */
  }
}

/** Never throws, never blocks routing: callers just attach `result.note`. */
export async function preDelegationCheck(input: PreDelegationInput, opts: PreDelegationOptions = {}): Promise<PreDelegationResult> {
  const env = opts.env ?? process.env;
  const local = assessLocally(input);
  let jevStatus: PreDelegationResult['jevStatus'] = 'off';
  let jev: RiskLevel | null = null;
  try {
    if (getJevMode(env) === 'shadow') {
      if (input.privacy === 'private') jevStatus = 'private';
      else {
        const fn = opts.jevRisk ?? createJevRiskFn({
          apiKey: env.TYPESAFE_API_KEY ?? env.JEV_API_KEY,
          timeoutMs: Number(env.GATESWARM_JEV_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        });
        jev = await fn(local.flags, { large: local.recommend.splitTask });
        jevStatus = jev === null ? 'skipped' : 'ok';
      }
    }
  } catch {
    jevStatus = 'error';
    jev = null;
  }
  const finalRisk = jev === null ? local.localRisk : maxRisk(local.localRisk, jev);
  const hardenedByJev = rank(finalRisk) > rank(local.localRisk);
  let rec = local.recommend;
  if (hardenedByJev) {
    // Jev can only add recommendations, never remove them.
    rec = {
      humanReview: rec.humanReview || finalRisk === 'high',
      mandatoryTests: rec.mandatoryTests || finalRisk === 'high',
      splitTask: rec.splitTask,
    };
  }
  const base = { schema_version: 'jev-predelegation.v1' as const, flags: local.flags, localRisk: local.localRisk, jevRisk: jev, finalRisk, recommend: rec, jevStatus, hardenedByJev };
  const result: PreDelegationResult = { ...base, note: buildNote(base) };
  await log(
    {
      schema_version: result.schema_version,
      ts: new Date().toISOString(),
      request_id: input.requestId ?? null,
      task_sha256: input.privacy === 'private' ? null : sha256Hex(input.task ?? ''),
      task_chars: (input.task ?? '').length,
      files_touched: input.filesTouched ?? null,
      flags: result.flags,
      local_risk: result.localRisk,
      jev_risk: result.jevRisk,
      final_risk: result.finalRisk,
      recommend: result.recommend,
      jev_status: result.jevStatus,
      hardened_by_jev: result.hardenedByJev,
    },
    opts,
    env,
  );
  return result;
}

/**
 * Fire-and-forget hook for the delegation/routing path. No-op unless
 * GATESWARM_JEV_MODE=shadow. Never throws, never awaited by callers, never
 * alters routing: output is only the JSONL log (and an optional note callback).
 */
export function preDelegationObserve(
  input: PreDelegationInput,
  opts: PreDelegationOptions & { onNote?: (note: string) => void } = {},
): void {
  try {
    const env = opts.env ?? process.env;
    if (getJevMode(env) !== 'shadow') return;
    void preDelegationCheck(input, opts)
      .then((r) => { try { opts.onNote?.(r.note); } catch { /* fail-open */ } })
      .catch(() => { /* fail-open */ });
  } catch {
    /* fail-open */
  }
}
