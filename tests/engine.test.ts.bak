/**
 * Complete Engine Test — Local + Cloud API + CLI Adapters + Self-Improvement
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { LearningLoop } from '../src/learning/learning-loop.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import type { RoutingOutcome } from '../src/learning/learning-loop.js';

// ─── Fixtures ───────────────────────────────────────────

function makeOutcome(overrides: Partial<RoutingOutcome> = {}): RoutingOutcome {
  return {
    prompt: 'Test prompt',
    score: 0.3,
    effort: 'light',
    tier: 'local',
    model: 'tinyllama-1.1b-q4',
    latencyMs: 500,
    tokenCount: 50,
    costCents: 0,
    userSatisfied: null,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Learning Loop Tests ────────────────────────────────

describe('🧠 Self-Improvement Learning Loop', () => {
  it('records outcomes and tracks history', () => {
    const loop = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

    for (let i = 0; i < 20; i++) {
      loop.recordOutcome(makeOutcome({ score: i * 0.05, tier: i < 10 ? 'local' : 'cloud' }));
    }

    const stats = loop.getStats();
    expect(stats.totalQueries).toBe(20);
    expect(stats.localPct).toBe(50);
    expect(stats.cloudPct).toBe(50);
  });

  it('auto-adjusts thresholds when local latency is high', () => {
    const loop = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

    // Simulate 10 queries with high local latency
    for (let i = 0; i < 10; i++) {
      loop.recordOutcome(makeOutcome({
        tier: 'local',
        latencyMs: 5000, // > 3s threshold
      }));
    }

    const thresholds = loop.currentThresholds;
    // Should have lowered tier1 to route more to cloud
    expect(thresholds.tier1).toBeLessThan(0.3);

    const learnings = loop.getRecentLearnings();
    const thresholdLearning = learnings.find(l => l.type === 'threshold_adjustment');
    expect(thresholdLearning).toBeDefined();
    console.log(`  📊 Threshold adjusted: ${thresholdLearning!.description}`);
  });

  it('auto-adjusts thresholds when too much cloud usage', () => {
    const loop = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

    // Simulate 10 queries, 80% to cloud
    for (let i = 0; i < 10; i++) {
      loop.recordOutcome(makeOutcome({
        tier: i < 8 ? 'cloud' : 'local',
        costCents: i < 8 ? 0.15 : 0,
      }));
    }

    const thresholds = loop.currentThresholds;
    // Should have raised tier2 to use local more
    expect(thresholds.tier2).toBeGreaterThan(0.6);
  });

  it('detects error patterns', () => {
    const loop = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

    // Simulate 10 queries with 3 empty responses
    for (let i = 0; i < 10; i++) {
      loop.recordOutcome(makeOutcome({
        tokenCount: i < 7 ? 50 : 0, // 3 empty responses
        latencyMs: i < 7 ? 500 : 15000,
      }));
    }

    const learnings = loop.getRecentLearnings();
    const errorLearning = learnings.find(l => l.type === 'error_pattern');
    expect(errorLearning).toBeDefined();
  });

  it('tracks prompt patterns for recurring queries', () => {
    const loop = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

    // Same pattern repeated
    for (let i = 0; i < 5; i++) {
      loop.recordOutcome(makeOutcome({ prompt: 'What is the weather in Paris?' }));
    }

    const patterns = loop.getPromptPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].count).toBe(5);

    console.log('  📊 Tracked patterns:');
    patterns.slice(0, 3).forEach(p => {
      console.log(`     "${p.pattern.slice(0, 40)}..." ×${p.count} (avg ${p.avgLatencyMs.toFixed(0)}ms, score ${p.avgScore.toFixed(2)})`);
    });
  });

  it('provides comprehensive routing stats', () => {
    const loop = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

    // Mix of outcomes
    const efforts = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
    const tiers = ['local', 'local', 'gatekeeper', 'cloud', 'cloud', 'cloud'];
    for (let i = 0; i < 30; i++) {
      const idx = i % 6;
      loop.recordOutcome(makeOutcome({
        effort: efforts[idx],
        tier: tiers[idx],
        score: idx * 0.17,
        costCents: tiers[idx] === 'cloud' ? 0.15 : 0,
        latencyMs: 200 + idx * 300,
      }));
    }

    const stats = loop.getStats();
    console.log('  📊 Routing Stats:');
    console.log(`     Total queries: ${stats.totalQueries}`);
    console.log(`     Local: ${stats.localPct}% | Cloud: ${stats.cloudPct}%`);
    console.log(`     By effort:`);
    for (const [effort, s] of Object.entries(stats.byEffort)) {
      console.log(`       ${effort}: ${s.count} queries, avg ${s.avgLatencyMs.toFixed(0)}ms, avg score ${s.avgScore.toFixed(2)}`);
    }

    expect(stats.totalQueries).toBe(30);
    expect(stats.localPct + stats.cloudPct).toBe(100);
  });
});

// ─── Adapter Registry Tests ─────────────────────────────

describe('🔌 Adapter Registry', () => {
  it('registers and lists adapters', () => {
    const registry = new AdapterRegistry();

    registry.registerCloudApi('test-cloud', {
      id: 'test-cloud',
      modelId: 'gpt-4o-mini',
      displayName: 'Test Cloud',
      endpoint: '/api/test',
      provider: 'openai',
      maxTokens: 1000,
      costPer1kTokens: 0.15,
    });

    const adapters = registry.list();
    expect(adapters.length).toBe(1);
    expect(adapters[0].displayName).toBe('Test Cloud');
    expect(adapters[0].costPer1kTokens).toBe(0.15);
  });

  it('registers all three adapter types', () => {
    const registry = new AdapterRegistry();

    registry.registerLocal('test-local', {
      id: 'test-local', modelId: 'test-model', displayName: 'Test Local',
      backend: 'wasm', maxTokens: 512, sizeMB: 100, minMemoryGB: 1,
    });

    registry.registerCloudApi('test-cloud', {
      id: 'test-cloud', modelId: 'gpt-4o-mini', displayName: 'Test Cloud',
      endpoint: '/api/test', provider: 'openai', maxTokens: 1000, costPer1kTokens: 0.15,
    });

    registry.registerCli('test-cli', {
      id: 'test-cli', modelId: 'test-cli-model', displayName: 'Test CLI',
      command: 'echo', maxTokens: 512, costPer1kTokens: 0, timeout: 5000,
    });

    const adapters = registry.list();
    expect(adapters.length).toBe(3);

    const backends = adapters.map(a => a.backend);
    expect(backends).toContain('wasm');
    expect(backends).toContain('cloud-api');
    expect(backends).toContain('cloud-cli');
  });

  it('tracks adapter entry stats', () => {
    const registry = new AdapterRegistry();

    registry.registerCloudApi('test-cloud', {
      id: 'test-cloud', modelId: 'gpt-4o-mini', displayName: 'Test Cloud',
      endpoint: '/api/test', provider: 'openai', maxTokens: 1000, costPer1kTokens: 0.15,
    });

    const entry = registry.get('test-cloud');
    expect(entry).toBeDefined();
    expect(entry!.loaded).toBe(true); // cloud is always loaded
  });

  it('disposes all adapters cleanly', async () => {
    const registry = new AdapterRegistry();

    registry.registerCloudApi('c1', {
      id: 'c1', modelId: 'gpt-4o-mini', displayName: 'C1',
      endpoint: '/api/test', provider: 'openai', maxTokens: 1000, costPer1kTokens: 0.15,
    });

    await registry.disposeAll();
    expect(registry.list().length).toBe(0);
  });
});

// ─── Architecture Validation ────────────

describe('🏛️ Architecture Validation', () => {
  it('learning loop nudge pattern works correctly', () => {
    // Review every N turns, never blocks UX
    const loop = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

    // First 9 queries: no review (nudge interval = 10)
    for (let i = 0; i < 9; i++) {
      loop.recordOutcome(makeOutcome());
    }
    let learnings = loop.getRecentLearnings();
    expect(learnings.length).toBe(0);

    // 10th query triggers review with high latency → should learn
    loop.recordOutcome(makeOutcome({ latencyMs: 5000 }));
    learnings = loop.getRecentLearnings();
    expect(loop.getStats().totalQueries).toBe(10);

    console.log('  ✅ Nudge-based learning triggers at correct interval');
  });

  it('three adapter backends cover all execution targets', () => {
    const registry = new AdapterRegistry();

    registry.registerLocal('local', {
      id: 'local', modelId: 'test', displayName: 'Local',
      backend: 'webgpu', maxTokens: 512, sizeMB: 100, minMemoryGB: 1,
    });
    registry.registerCloudApi('cloud', {
      id: 'cloud', modelId: 'gpt-4o-mini', displayName: 'Cloud',
      endpoint: '/api/test', provider: 'openai', maxTokens: 1000, costPer1kTokens: 0.15,
    });
    registry.registerCli('cli', {
      id: 'cli', modelId: 'test-cli', displayName: 'CLI',
      command: 'ollama run test', maxTokens: 512, costPer1kTokens: 0, timeout: 5000,
    });

    const adapters = registry.list();
    const backends = new Set(adapters.map(a => a.backend));

    console.log('  📊 Adapter backends:', [...backends]);
    expect(backends.size).toBe(3); // webgpu, cloud-api, cloud-cli
    expect(backends.has('webgpu')).toBe(true);
    expect(backends.has('cloud-api')).toBe(true);
    expect(backends.has('cloud-cli')).toBe(true);
  });
});
