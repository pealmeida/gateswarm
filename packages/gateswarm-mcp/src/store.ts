/**
 * Append-only telemetry store for routing decisions and human verdicts.
 * One JSONL file per project under GATESWARM_TELEMETRY_DIR (default
 * ~/.gateswarm/telemetry). Records follow the InteractionEvent shape from
 * docs/superpowers/specs/2026-08-25-dogfood-loop-golden-dataset.md so the
 * golden-dataset export joins without transformation.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EffortLevel } from 'gateswarm-lite';
import type { ModelSpec, RoutingStrategy } from 'gateswarm-router';

export interface DecisionRecord {
  type: 'decision';
  eventId: string;
  ts: number;
  project: string;
  promptHash: string;
  promptSnippet: string;
  score: number;
  tier: EffortLevel;
  boundariesHash: string;
  strategy: RoutingStrategy;
  modelId: string;
  provider: string;
  alternatives: string[];
  reason: string;
  matrix: ModelSpec[];
  /** Present for session-scoped decisions (route_session). */
  turnsCount?: number;
  windowChars?: number;
}

export interface FeedbackRecord {
  type: 'feedback';
  ts: number;
  project: string;
  decisionEventId: string;
  promptHash: string;
  verdict: 'correct' | 'wrong';
  correctTier?: EffortLevel;
  reroutedModelId?: string;
  reroutedProvider?: string;
  notes?: string;
}

/**
 * A graded delivery: a model answered at a tier and the result was judged.
 * Distinct from FeedbackRecord — that judges whether the TIER was right, this
 * judges whether the OUTPUT was good. Conflating them would let a complaint
 * about a bad answer move the complexity boundaries.
 */
export interface OutcomeRecord {
  type: 'outcome';
  ts: number;
  project: string;
  decisionEventId?: string;
  promptHash?: string;
  modelId: string;
  provider: string;
  tier: EffortLevel;
  /** Judged output quality in [0,1]. */
  quality: number;
  /** False for transport/provider failures — excluded from quality, counted separately. */
  ok: boolean;
  /** 'human' verdicts outweigh 'model' ones during recalibration. */
  judge: 'human' | 'model';
  /** Actual tokens metered by the provider, when the caller knows them. */
  tokensIn?: number;
  tokensOut?: number;
  notes?: string;
}

export type TelemetryRecord = DecisionRecord | FeedbackRecord | OutcomeRecord;

export function telemetryDir(envDir?: string): string {
  return envDir ?? process.env.GATESWARM_TELEMETRY_DIR ?? join(homedir(), '.gateswarm', 'telemetry');
}

/**
 * Project names are caller-controlled path segments — restrict them to a slug
 * so no tool argument can escape the telemetry directory (path traversal).
 */
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function projectFile(project: string, envDir?: string): string {
  if (!SAFE_PROJECT.test(project)) {
    throw new Error(
      `invalid project "${project}": use a slug of letters, digits, ".", "_" or "-" (no path separators)`,
    );
  }
  return join(telemetryDir(envDir), project, 'events.jsonl');
}

export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

export function snippet(prompt: string, max = 256): string {
  return prompt.length <= max ? prompt : `${prompt.slice(0, max - 1)}…`;
}

export function appendRecord(project: string, record: TelemetryRecord, envDir?: string): void {
  const file = projectFile(project, envDir);
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
}

export function readRecords(project: string, envDir?: string): TelemetryRecord[] {
  const file = projectFile(project, envDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TelemetryRecord);
}

export function findDecision(
  project: string,
  eventId: string,
  envDir?: string,
): DecisionRecord | undefined {
  return readRecords(project, envDir)
    .filter((r): r is DecisionRecord => r.type === 'decision')
    .find((r) => r.eventId === eventId);
}
