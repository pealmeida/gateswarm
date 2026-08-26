/**
 * Append-only telemetry store for routing decisions and human verdicts.
 * One JSONL file per project under GATESWARM_TELEMETRY_DIR (default
 * ~/.gateswarm/telemetry). Records follow the InteractionEvent shape from
 * docs/superpowers/specs/2026-08-25-dogfood-loop-promptly-anymodel.md so the
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

export type TelemetryRecord = DecisionRecord | FeedbackRecord;

export function telemetryDir(envDir?: string): string {
  return envDir ?? process.env.GATESWARM_TELEMETRY_DIR ?? join(homedir(), '.gateswarm', 'telemetry');
}

export function projectFile(project: string, envDir?: string): string {
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
