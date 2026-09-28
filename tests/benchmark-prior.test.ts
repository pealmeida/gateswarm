/**
 * Benchmark prior + task category tests.
 * Fictional data lives under tests/fixtures/benchmark-fictional (never calibration/benchmarks).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { detectTaskCategory } from '../src/task-category.js';
import {
  getBenchmarkPriorMode,
  isBenchmarkPriorEnabled,
  rankCandidates,
  resetBenchmarkPriorCache,
  shouldApplyBenchmarkReorder,
  buildBenchmarkTransparency,
} from '../src/benchmark-prior.js';
import { readFileSync } from 'fs';

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/benchmark-fictional');
const originalBenchmarkDir = process.env.GATESWARM_BENCHMARK_DIR;
const originalPriorFlag = process.env.GATESWARM_BENCHMARK_PRIOR;

function useFictionalBenchmarkDir(): void {
  process.env.GATESWARM_BENCHMARK_DIR = FIXTURE_DIR;
  resetBenchmarkPriorCache();
}

describe('task-category', () => {
  it('detects code prompts with reasonable confidence', () => {
    const r = detectTaskCategory('Fix the TypeScript bug in src/router.ts and add a unit test');
    expect(r.category).toBe('code');
    expect(r.confidence).toBeGreaterThanOrEqual(0.45);
  });

  it('falls back to general on empty prompt', () => {
    expect(detectTaskCategory('').category).toBe('general');
  });
});

describe('benchmark prior flags', () => {
  afterEach(() => {
    if (originalPriorFlag === undefined) delete process.env.GATESWARM_BENCHMARK_PRIOR;
    else process.env.GATESWARM_BENCHMARK_PRIOR = originalPriorFlag;
  });

  it('defaults to shadow mode when unset', () => {
    delete process.env.GATESWARM_BENCHMARK_PRIOR;
    expect(getBenchmarkPriorMode()).toBe('shadow');
    expect(isBenchmarkPriorEnabled()).toBe(false);
  });

  it('enables apply only for ON', () => {
    process.env.GATESWARM_BENCHMARK_PRIOR = 'on';
    expect(isBenchmarkPriorEnabled()).toBe(true);
    expect(shouldApplyBenchmarkReorder('code')).toBe(true);
    expect(shouldApplyBenchmarkReorder('agentic')).toBe(false);
  });

  it('off mode disables computation path in rankCandidates guard', () => {
    process.env.GATESWARM_BENCHMARK_PRIOR = 'off';
    useFictionalBenchmarkDir();
    return rankCandidates(
      [{ provider: 'zai', model: 'glm-5' }, { provider: 'zai', model: 'glm-5.1' }],
      'code',
      { category: 'code', categoryConfidence: 0.9, matrixIndex: new Map() },
    ).then(r => {
      expect(r.wouldReorder).toBe(false);
    });
  });
});

describe('rankCandidates with fictional fixture', () => {
  beforeEach(() => {
    useFictionalBenchmarkDir();
    process.env.GATESWARM_BENCHMARK_PRIOR = 'shadow';
  });

  afterEach(() => {
    resetBenchmarkPriorCache();
    if (originalBenchmarkDir === undefined) delete process.env.GATESWARM_BENCHMARK_DIR;
    else process.env.GATESWARM_BENCHMARK_DIR = originalBenchmarkDir;
    if (originalPriorFlag === undefined) delete process.env.GATESWARM_BENCHMARK_PRIOR;
    else process.env.GATESWARM_BENCHMARK_PRIOR = originalPriorFlag;
  });

  const candidates = [
    { provider: 'zai', model: 'glm-5' },
    { provider: 'zai', model: 'glm-5.1' },
  ];
  const matrixIndex = new Map(candidates.map((c, i) => [`${c.provider}/${c.model}`, i]));

  it('shadow mode computes wouldReorder without applying helper gate', async () => {
    const ranked = await rankCandidates(candidates, 'code', {
      category: 'code',
      categoryConfidence: 0.95,
      matrixIndex,
    });
    expect(ranked.wouldReorder).toBe(true);
    expect(ranked.order[0].model).toBe('glm-5.1');
  });

  it('does not reorder for general category', async () => {
    const ranked = await rankCandidates(candidates, 'general', {
      category: 'general',
      categoryConfidence: 0.95,
      matrixIndex,
    });
    expect(ranked.wouldReorder).toBe(false);
    expect(ranked.order[0].model).toBe('glm-5');
  });

  it('is deterministic for the same inputs', async () => {
    const a = await rankCandidates(candidates, 'code', {
      category: 'code',
      categoryConfidence: 0.95,
      matrixIndex,
    });
    resetBenchmarkPriorCache();
    useFictionalBenchmarkDir();
    const b = await rankCandidates(candidates, 'code', {
      category: 'code',
      categoryConfidence: 0.95,
      matrixIndex,
    });
    expect(a.order).toEqual(b.order);
  });

  it('missing snapshot directory falls back to no-op reorder', async () => {
    process.env.GATESWARM_BENCHMARK_DIR = join(process.cwd(), 'tests/fixtures/missing-benchmark-dir');
    resetBenchmarkPriorCache();
    const ranked = await rankCandidates(candidates, 'code', {
      category: 'code',
      categoryConfidence: 0.95,
      matrixIndex,
    });
    expect(ranked.wouldReorder).toBe(false);
    expect(ranked.explanations).toEqual([]);
  });
});

describe('collector schema fixture', () => {
  it('fictional observations include url and date', () => {
    const doc = JSON.parse(readFileSync(join(FIXTURE_DIR, 'snapshot.json'), 'utf-8'));
    for (const obs of doc.observations) {
      expect(obs.source_url).toBeTruthy();
      expect(obs.source_date).toBeTruthy();
      expect(obs.gateswarm_model_id).toBeTruthy();
    }
  });
});

describe('buildBenchmarkTransparency', () => {
  beforeEach(() => {
    useFictionalBenchmarkDir();
    process.env.GATESWARM_BENCHMARK_PRIOR = 'shadow';
  });

  afterEach(() => {
    resetBenchmarkPriorCache();
    if (originalBenchmarkDir === undefined) delete process.env.GATESWARM_BENCHMARK_DIR;
    else process.env.GATESWARM_BENCHMARK_DIR = originalBenchmarkDir;
  });

  it('exposes category and benchmark block for score-like surfaces', async () => {
    const out = await buildBenchmarkTransparency(
      'Fix the TypeScript bug in src/router.ts: refactor the function and add unit tests',
      {
        model: 'glm-5',
        provider: 'zai',
        max_tokens: 2048,
        enable_thinking: false,
        fallback_models: [{ model: 'glm-5.1', provider: 'zai' }],
      },
    );
    expect(out.category).toBe('code');
    expect(out.benchmark.order.length).toBeGreaterThan(0);
    expect(out.benchmark.explanations.length).toBeGreaterThan(0);
  });
});
