/**
 * Benchmark prior loader and within-tier reordering (MVP).
 * Reads calibration/benchmarks/* with hot-reload; never uses network at runtime.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import type { TaskCategory } from './task-category.js';
import { detectTaskCategory } from './task-category.js';
import type { TierModelConfig } from './v04-config.js';
import { getProviderQuotaPercentages, type ProviderQuotaPercentage } from './quota-band-matrix.js';
import { modelMatrix } from './model-matrix.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELOAD_INTERVAL_MS = 5 * 60 * 1000;
const REORDER_DELTA = 0.10;
const MIN_COVERAGE = 0.5;

export type BenchmarkPriorMode = 'off' | 'shadow' | 'on';

export interface BenchmarkObservation {
  schema_version?: number;
  source: string;
  benchmark: string;
  benchmark_version: string;
  metric: string;
  higher_is_better?: boolean;
  source_model_alias: string;
  gateswarm_model_id: string;
  match?: 'exact' | 'variant' | 'family';
  value: number;
  ci_low?: number;
  ci_high?: number;
  n?: number;
  percentile_in_benchmark?: number | null;
  self_reported?: boolean;
  harness?: string | null;
  effort?: string | null;
  source_url: string;
  source_date: string;
  fetched_at: string;
  raw_sha256?: string;
  license?: string;
  stale?: boolean;
}

export interface BenchmarkSnapshot {
  snapshot_id: string;
  generated_at: string;
  observations: BenchmarkObservation[];
}

export interface ModelCandidate {
  provider: string;
  model: string;
}

export interface BenchmarkSourceExplanation {
  source: string;
  benchmark: string;
  version: string;
  value: number;
  date: string;
  url: string;
  self_reported?: boolean;
}

export interface BenchmarkModelExplanation {
  model: string;
  provider: string;
  gateswarmModelId: string;
  priorScore: number | null;
  coverage: number;
  sources: BenchmarkSourceExplanation[];
  neutral: boolean;
  conflict?: boolean;
}

export interface RankCandidatesResult {
  order: ModelCandidate[];
  explanations: BenchmarkModelExplanation[];
  wouldReorder: boolean;
  snapshotSha256: string | null;
  snapshotId: string | null;
}

export interface BenchmarkPriorContext {
  category: TaskCategory;
  categoryConfidence: number;
  /** Original matrix order index per gateswarm model id */
  matrixIndex: Map<string, number>;
}

let _snapshot: BenchmarkSnapshot | null = null;
let _aliases: Record<string, unknown> | null = null;
let _categoryMap: Record<string, unknown> | null = null;
let _loadedAt = 0;
let _snapshotSha256: string | null = null;
let _loadFailed = false;

function resolveBenchmarksDir(): string {
  if (process.env.GATESWARM_BENCHMARK_DIR) {
    return process.env.GATESWARM_BENCHMARK_DIR;
  }
  const candidates: string[] = [];
  if (process.env.GATESWARM_ROOT) {
    candidates.push(join(process.env.GATESWARM_ROOT, 'calibration/benchmarks'));
  }
  let currentDir = __dirname;
  for (let i = 0; i < 5; i++) {
    candidates.push(join(currentDir, '../calibration/benchmarks'));
    candidates.push(join(currentDir, '../../calibration/benchmarks'));
    currentDir = dirname(currentDir);
  }
  candidates.push(join(process.cwd(), 'calibration/benchmarks'));
  for (const c of candidates) {
    try {
      if (require('fs').existsSync(join(c, 'snapshot.json'))) {
        return c;
      }
    } catch { /* continue */ }
  }
  return candidates[0] ?? join(__dirname, '../calibration/benchmarks');
}

export function getBenchmarkPriorMode(): BenchmarkPriorMode {
  const flag = (process.env.GATESWARM_BENCHMARK_PRIOR ?? '').trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(flag)) return 'on';
  if (/^(0|false|no|disabled|off)$/.test(flag)) return 'off';
  if (flag === 'shadow') return 'shadow';
  if (!flag) return 'shadow';
  return 'shadow';
}

/** True when reorder may be applied (flag ON + eligible category). */
export function isBenchmarkPriorEnabled(): boolean {
  return getBenchmarkPriorMode() === 'on';
}

export function getBenchmarkPriorHeaderValue(): BenchmarkPriorMode {
  return getBenchmarkPriorMode();
}

export function shouldComputeBenchmarkPrior(): boolean {
  return getBenchmarkPriorMode() !== 'off';
}

function gateswarmModelId(provider: string, model: string): string {
  if (provider === 'claude-cli' && model.startsWith('cc/')) return model;
  if (provider === 'codex-cli' && model.startsWith('cx/')) return model;
  if (model.includes('/')) return model;
  return model;
}

function matchConfidence(match?: string): number {
  switch (match) {
    case 'exact': return 1.0;
    case 'variant': return 0.7;
    case 'family': return 0.4;
    default: return 0.4;
  }
}

function sourceWeight(selfReported: boolean): number {
  return selfReported ? 0.4 : 1.0;
}

function freshnessWeight(sourceDate: string, halfLifeDays: number): number {
  const parsed = Date.parse(sourceDate);
  if (Number.isNaN(parsed)) return 0.5;
  const ageDays = (Date.now() - parsed) / (86400 * 1000);
  let w = 0.5 ** (ageDays / halfLifeDays);
  if (ageDays > 180) w = Math.min(w, 0.25);
  return w;
}

function halfLifeForSource(source: string): number {
  if (source === 'livebench') return 120;
  if (source === 'vendor') return 60;
  return 90;
}

async function loadBundle(): Promise<void> {
  const now = Date.now();
  if (_snapshot && !_loadFailed && (now - _loadedAt) < RELOAD_INTERVAL_MS) {
    return;
  }

  const dir = resolveBenchmarksDir();
  try {
    const snapRaw = await fs.readFile(join(dir, 'snapshot.json'), 'utf-8');
    _snapshotSha256 = createHash('sha256').update(snapRaw).digest('hex');
    _snapshot = JSON.parse(snapRaw) as BenchmarkSnapshot;
    const aliasesRaw = await fs.readFile(join(dir, 'aliases.yaml'), 'utf-8');
    _aliases = parseYaml(aliasesRaw) as Record<string, unknown>;
    const mapRaw = await fs.readFile(join(dir, 'category_map.yaml'), 'utf-8');
    _categoryMap = parseYaml(mapRaw) as Record<string, unknown>;
    _loadedAt = now;
    _loadFailed = false;
  } catch {
    _snapshot = null;
    _aliases = null;
    _categoryMap = null;
    _snapshotSha256 = null;
    _loadFailed = true;
    _loadedAt = now;
  }
}

function categoryBenchmarkWeights(category: TaskCategory): Array<{ key: string; weight: number }> {
  if (!_categoryMap || category === 'general') return [];
  const cats = (_categoryMap.categories ?? _categoryMap) as Record<string, { benchmarks?: Array<{ id: string; weight: number }> }>;
  const entry = cats[category];
  if (!entry?.benchmarks) return [];
  return entry.benchmarks.map(b => ({ key: b.id, weight: b.weight }));
}

function observationMatchesBenchmark(obs: BenchmarkObservation, key: string): boolean {
  const b = obs.benchmark;
  return b === key || b.endsWith(`/${key}`) || b.includes(key);
}

function percentileForObservation(obs: BenchmarkObservation, all: BenchmarkObservation[]): number {
  if (obs.percentile_in_benchmark != null && !Number.isNaN(obs.percentile_in_benchmark)) {
    return obs.percentile_in_benchmark;
  }
  const peers = all.filter(
    o => o.benchmark === obs.benchmark
      && o.benchmark_version === obs.benchmark_version
      && o.metric === obs.metric,
  );
  if (peers.length < 2) return 0.5;
  const higher = obs.higher_is_better !== false;
  const sorted = [...peers].sort((a, b) => (higher ? a.value - b.value : b.value - a.value));
  const idx = sorted.findIndex(p => p.source_model_alias === obs.source_model_alias && p.gateswarm_model_id === obs.gateswarm_model_id);
  if (idx < 0) return 0.5;
  return idx / Math.max(1, sorted.length - 1);
}

export async function getCategoryPrior(
  modelId: string,
  category: TaskCategory,
): Promise<{ prior: number | null; coverage: number; sources: BenchmarkSourceExplanation[]; conflict: boolean }> {
  await loadBundle();
  if (!_snapshot || category === 'general') {
    return { prior: null, coverage: 0, sources: [], conflict: false };
  }

  const weights = categoryBenchmarkWeights(category);
  if (weights.length === 0) {
    return { prior: null, coverage: 0, sources: [], conflict: false };
  }

  const obsForModel = _snapshot.observations.filter(o => o.gateswarm_model_id === modelId);
  let weightedSum = 0;
  let weightTotal = 0;
  const sources: BenchmarkSourceExplanation[] = [];
  const independentSigns: number[] = [];

  for (const bw of weights) {
    const matching = obsForModel.filter(o => observationMatchesBenchmark(o, bw.key));
    const independent = matching.filter(o => !o.self_reported);
    const pool = independent.length > 0 ? independent : matching.filter(o => o.self_reported);
    if (pool.length === 0) continue;

    const obs = pool.sort((a, b) => Date.parse(b.source_date) - Date.parse(a.source_date))[0];
    const pct = percentileForObservation(obs, _snapshot.observations);
    const w = bw.weight
      * sourceWeight(!!obs.self_reported)
      * matchConfidence(obs.match)
      * freshnessWeight(obs.source_date, halfLifeForSource(obs.source));
    weightedSum += w * pct;
    weightTotal += w;
    sources.push({
      source: obs.source,
      benchmark: obs.benchmark,
      version: obs.benchmark_version,
      value: obs.value,
      date: obs.source_date,
      url: obs.source_url,
      self_reported: obs.self_reported,
    });
    if (!obs.self_reported) {
      independentSigns.push(pct >= 0.5 ? 1 : -1);
    }
  }

  const conflict = independentSigns.length >= 2
    && independentSigns.some(s => s > 0)
    && independentSigns.some(s => s < 0);

  if (weightTotal < MIN_COVERAGE) {
    return { prior: null, coverage: weightTotal, sources, conflict };
  }

  return { prior: weightedSum / weightTotal, coverage: weightTotal, sources, conflict };
}

function providerQuotaSlack(provider: string, quotas: ProviderQuotaPercentage[]): number {
  const row = quotas.find(q => q.provider === provider);
  if (!row || row.maxPct == null) return 0.5;
  return Math.max(0, Math.min(1, (100 - row.maxPct) / 100));
}

function modelLatency(provider: string, model: string): number {
  const entry = modelMatrix.getModel(provider, model);
  return entry?.avgLatencyMs ?? 99999;
}

function buildMatrixIndex(candidates: ModelCandidate[]): Map<string, number> {
  const m = new Map<string, number>();
  candidates.forEach((c, i) => {
    m.set(gateswarmModelId(c.provider, c.model), i);
  });
  return m;
}

export async function rankCandidates(
  candidates: ModelCandidate[],
  category: TaskCategory,
  ctx: BenchmarkPriorContext,
): Promise<RankCandidatesResult> {
  await loadBundle();

  const originalOrder = [...candidates];
  const matrixIndex = ctx.matrixIndex.size > 0 ? ctx.matrixIndex : buildMatrixIndex(originalOrder);

  if (!shouldComputeBenchmarkPrior() || category === 'general' || ctx.categoryConfidence < 0.45) {
    return {
      order: originalOrder,
      explanations: [],
      wouldReorder: false,
      snapshotSha256: _snapshotSha256,
      snapshotId: _snapshot?.snapshot_id ?? null,
    };
  }

  if (!_snapshot || candidates.length < 2) {
    return {
      order: originalOrder,
      explanations: [],
      wouldReorder: false,
      snapshotSha256: _snapshotSha256,
      snapshotId: _snapshot?.snapshot_id ?? null,
    };
  }

  const quotas = getProviderQuotaPercentages();
  const explanations: BenchmarkModelExplanation[] = [];
  const scored: Array<{
    c: ModelCandidate;
    prior: number | null;
    coverage: number;
    conflict: boolean;
    sources: BenchmarkSourceExplanation[];
  }> = [];

  for (const c of candidates) {
    const gid = gateswarmModelId(c.provider, c.model);
    const { prior, coverage, sources, conflict } = await getCategoryPrior(gid, category);
    explanations.push({
      model: c.model,
      provider: c.provider,
      gateswarmModelId: gid,
      priorScore: prior,
      coverage,
      sources,
      neutral: prior == null || coverage < MIN_COVERAGE,
      conflict,
    });
    scored.push({ c, prior, coverage, conflict, sources });
  }

  const hasReorderable = scored.some(s => s.prior != null && s.coverage >= MIN_COVERAGE && !s.conflict);
  if (!hasReorderable) {
    return {
      order: originalOrder,
      explanations,
      wouldReorder: false,
      snapshotSha256: _snapshotSha256,
      snapshotId: _snapshot?.snapshot_id ?? null,
    };
  }

  const sorted = [...scored].sort((a, b) => {
    const aScore = a.prior ?? -1;
    const bScore = b.prior ?? -1;
    if (Math.abs(aScore - bScore) >= REORDER_DELTA) {
      return bScore - aScore;
    }
    const slackA = providerQuotaSlack(a.c.provider, quotas);
    const slackB = providerQuotaSlack(b.c.provider, quotas);
    if (slackA !== slackB) return slackB - slackA;
    const latA = modelLatency(a.c.provider, a.c.model);
    const latB = modelLatency(b.c.provider, b.c.model);
    if (latA !== latB) return latA - latB;
    const idxA = matrixIndex.get(gateswarmModelId(a.c.provider, a.c.model)) ?? 999;
    const idxB = matrixIndex.get(gateswarmModelId(b.c.provider, b.c.model)) ?? 999;
    return idxA - idxB;
  });

  const top = sorted[0];
  const incumbent = scored[0];
  let order = originalOrder;
  let wouldReorder = false;

  const topDiffers = top.c.provider !== incumbent.c.provider || top.c.model !== incumbent.c.model;
  if (top.prior != null && incumbent.prior != null && topDiffers) {
    const delta = (top.prior ?? 0) - (incumbent.prior ?? -1);
    if (
      delta >= REORDER_DELTA
      && top.coverage >= MIN_COVERAGE
      && !top.conflict
      && (top.sources.some(s => !s.self_reported) || top.coverage >= MIN_COVERAGE)
    ) {
      wouldReorder = true;
      order = sorted.map(s => s.c);
    }
  }

  return {
    order,
    explanations,
    wouldReorder,
    snapshotSha256: _snapshotSha256,
    snapshotId: _snapshot?.snapshot_id ?? null,
  };
}

export function shouldApplyBenchmarkReorder(category: TaskCategory): boolean {
  return isBenchmarkPriorEnabled() && category === 'code';
}

/** Reset cached files (tests). */
export async function buildBenchmarkTransparency(
  prompt: string,
  tierCfg: TierModelConfig | null | undefined,
): Promise<{
  category: TaskCategory;
  categoryConfidence: number;
  benchmark: {
    wouldReorder: boolean;
    order: ModelCandidate[];
    explanations: BenchmarkModelExplanation[];
    snapshotSha256: string | null;
    snapshotId: string | null;
  };
}> {
  const detected = detectTaskCategory(prompt);
  const category = detected.category;
  const categoryConfidence = detected.confidence;
  if (!tierCfg) {
    return {
      category,
      categoryConfidence,
      benchmark: {
        wouldReorder: false,
        order: [],
        explanations: [],
        snapshotSha256: null,
        snapshotId: null,
      },
    };
  }
  const candidates: ModelCandidate[] = [
    { provider: tierCfg.provider, model: tierCfg.model },
    ...(tierCfg.fallback_models || []),
  ];
  const matrixIndex = new Map<string, number>();
  candidates.forEach((c, i) => matrixIndex.set(`${c.provider}/${c.model}`, i));
  const ranked = await rankCandidates(candidates, category, {
    category,
    categoryConfidence,
    matrixIndex,
  });
  return {
    category,
    categoryConfidence,
    benchmark: {
      wouldReorder: ranked.wouldReorder,
      order: ranked.order,
      explanations: ranked.explanations,
      snapshotSha256: ranked.snapshotSha256,
      snapshotId: ranked.snapshotId,
    },
  };
}

export function resetBenchmarkPriorCache(): void {
  _snapshot = null;
  _aliases = null;
  _categoryMap = null;
  _loadedAt = 0;
  _snapshotSha256 = null;
  _loadFailed = false;
}
