import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EffortLevel } from '../../src/types.js';
import { TIERS } from './dataset.js';

export const DEFAULT_MAX_TOKENS: Record<EffortLevel, number> = {
  trivial: 256,
  light: 512,
  moderate: 1024,
  heavy: 2048,
  intensive: 4096,
  extreme: 4096,
};

export const RUBRIC_PASS_RATIO = {
  pass: 25,
  total: 30,
} as const;

export interface EvalRuntimeConfig {
  maxTokens: Record<EffortLevel, number>;
  judgeProvider: string;
  configPath?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function rubricPassFloor(
  sampleSize: number,
  ratio: { pass: number; total: number } = RUBRIC_PASS_RATIO,
): number {
  if (!Number.isFinite(sampleSize) || sampleSize < 0) throw new Error('invalid sample size');
  if (!Number.isFinite(ratio.pass) || !Number.isFinite(ratio.total) || ratio.pass < 0 || ratio.total <= 0) {
    throw new Error('invalid pass ratio');
  }
  return Math.ceil(sampleSize * (ratio.pass / ratio.total));
}

export function maxTokensFromConfigValue(
  config: unknown,
  fallback: Record<EffortLevel, number> = DEFAULT_MAX_TOKENS,
): Record<EffortLevel, number> {
  const out: Record<EffortLevel, number> = { ...fallback };
  if (!isRecord(config) || !isRecord(config.tier_models)) return out;

  for (const tier of TIERS) {
    const tierConfig = config.tier_models[tier];
    if (!isRecord(tierConfig)) continue;
    const n = Number(tierConfig.max_tokens);
    if (Number.isFinite(n) && n > 0) out[tier] = Math.floor(n);
  }
  return out;
}

export function judgeProviderFromConfigValue(config: unknown): string {
  if (!isRecord(config) || !isRecord(config.feedback_loop)) return 'unknown';
  const raw = config.feedback_loop.llmJudgeModel ?? config.feedback_loop.llm_judge_model;

  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return 'unknown';
    const slash = s.indexOf('/');
    if (slash > 0) return s.slice(0, slash);
    const colon = s.indexOf(':');
    if (colon > 0) return s.slice(0, colon);
    return s;
  }

  if (isRecord(raw)) {
    const provider = raw.provider ?? raw.providerName;
    if (typeof provider === 'string' && provider.trim()) return provider.trim();
    const model = raw.model;
    if (typeof model === 'string') return judgeProviderFromConfigValue({ feedback_loop: { llmJudgeModel: model } });
  }

  return 'unknown';
}

function candidateConfigPaths(cwd: string): string[] {
  return [
    join(cwd, 'v04_config.json'),
    join(cwd, 'config', 'v04_config.json'),
    join(cwd, 'src', 'v04_config.json'),
    join(cwd, 'src', 'config', 'v04_config.json'),
  ];
}

export function loadEvalRuntimeConfig(opts: {
  cwd?: string;
  configPath?: string;
  fallbackMaxTokens?: Record<EffortLevel, number>;
} = {}): EvalRuntimeConfig {
  const cwd = opts.cwd ?? process.cwd();
  const fallback = opts.fallbackMaxTokens ?? DEFAULT_MAX_TOKENS;
  const candidates = opts.configPath ? [resolve(cwd, opts.configPath)] : candidateConfigPaths(cwd);

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return {
        maxTokens: maxTokensFromConfigValue(parsed, fallback),
        judgeProvider: judgeProviderFromConfigValue(parsed),
        configPath: path,
      };
    } catch {
      return { maxTokens: { ...fallback }, judgeProvider: 'unknown' };
    }
  }

  return { maxTokens: { ...fallback }, judgeProvider: 'unknown' };
}
