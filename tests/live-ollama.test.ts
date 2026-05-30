/**
 * Live Ollama Test — Real model inference via Ollama API
 * Requires: `ollama serve` running with qwen2.5:7b pulled
 * 
 * Run: npx vitest run tests/live-ollama.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { OllamaAdapter } from '../src/adapters/ollama-adapter.js';
import { heuristicScore } from '../src/intent-engine.js';
import { scoreToEffort, classifyDevice, lookupMatrix } from '../src/routing-matrix.js';
import { LearningLoop } from '../src/learning/learning-loop.js';
import type { RoutingOutcome } from '../src/learning/learning-loop.js';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:7b-instruct-q4_K_M';

describe('🔴 Live Ollama Inference', () => {
  let adapter: OllamaAdapter;
  let available = false;

  beforeAll(async () => {
    adapter = new OllamaAdapter({
      id: 'ollama-live',
      modelId: OLLAMA_MODEL,
      displayName: 'Ollama Live',
      baseUrl: OLLAMA_BASE,
      maxTokens: 512,
      costPer1kTokens: 0,
    });
    await adapter.initialize();
    available = adapter.isAvailable;
  });

  it('connects to Ollama server', () => {
    console.log(`  📡 Ollama: ${OLLAMA_BASE}`);
    console.log(`  📦 Model: ${OLLAMA_MODEL}`);
    console.log(`  ✅ Available: ${available}`);
    if (!available) console.log('  ⚠️  Skipping live tests — Ollama not available');
  });

  it('generates a response for a trivial prompt', async () => {
    if (!available) return;

    const tokens: string[] = [];
    const start = performance.now();

    for await (const chunk of adapter.generate({
      prompt: 'What is 2+2? Answer with just the number.',
      maxTokens: 32,
      temperature: 0.1,
    })) {
      if (chunk.token) tokens.push(chunk.token);
      if (chunk.done && chunk.usage) {
        console.log(`  📊 Tokens: ${chunk.usage.completionTokens} prompt: ${chunk.usage.promptTokens}`);
      }
    }

    const latency = performance.now() - start;
    const text = tokens.join('');
    console.log(`  ⏱️  Latency: ${latency.toFixed(0)}ms`);
    console.log(`  💬 Response: "${text.slice(0, 100)}"`);

    expect(text.length).toBeGreaterThan(0);
    expect(latency).toBeLessThan(30000); // under 30s
    expect(text).toMatch(/4/); // should contain "4"
  }, 60000);

  it('generates a response for a moderate prompt', async () => {
    if (!available) return;

    const tokens: string[] = [];
    const start = performance.now();

    for await (const chunk of adapter.generate({
      prompt: 'Explain the difference between REST and GraphQL in 3 sentences.',
      maxTokens: 256,
      temperature: 0.7,
    })) {
      if (chunk.token) tokens.push(chunk.token);
    }

    const latency = performance.now() - start;
    const text = tokens.join('');
    console.log(`  ⏱️  Latency: ${latency.toFixed(0)}ms`);
    console.log(`  💬 Response: "${text.slice(0, 200)}..."`);

    expect(text.length).toBeGreaterThan(50);
    expect(latency).toBeLessThan(60000);
  }, 90000);

  it('streams tokens incrementally', async () => {
    if (!available) return;

    const timestamps: number[] = [];
    const start = performance.now();

    for await (const chunk of adapter.generate({
      prompt: 'List 3 programming languages.',
      maxTokens: 64,
      temperature: 0.3,
    })) {
      if (chunk.token) timestamps.push(performance.now() - start);
    }

    console.log(`  📊 Tokens received: ${timestamps.length}`);
    console.log(`  📊 First token: ${timestamps[0]?.toFixed(0)}ms`);
    console.log(`  📊 Last token: ${timestamps[timestamps.length - 1]?.toFixed(0)}ms`);

    // Should receive multiple chunks (streaming)
    expect(timestamps.length).toBeGreaterThan(3);
    // First token should arrive relatively fast
    expect(timestamps[0]).toBeLessThan(10000);
  }, 60000);
});

describe('🔴 Live End-to-End Pipeline', () => {
  let adapter: OllamaAdapter;
  let available = false;

  beforeAll(async () => {
    adapter = new OllamaAdapter({
      id: 'ollama-e2e',
      modelId: OLLAMA_MODEL,
      displayName: 'Ollama E2E',
      baseUrl: OLLAMA_BASE,
      maxTokens: 512,
      costPer1kTokens: 0,
    });
    await adapter.initialize();
    available = adapter.isAvailable;
  });

  const testPrompts = [
    { text: 'Hello!', expectedEffort: 'trivial', expectedTier: 'local' },
    { text: 'What is the capital of France?', expectedEffort: 'trivial', expectedTier: 'local' },
    { text: 'Explain how HTTP works to a beginner in 2 paragraphs', expectedEffort: 'moderate', expectedTier: 'gatekeeper' },
    { text: 'Write a Python function that reverses a string', expectedEffort: 'heavy', expectedTier: 'cloud' },
  ];

  it('processes prompts through full pipeline with real inference', async () => {
    if (!available) return;

    const learning = new LearningLoop({ tier1: 0.3, tier2: 0.6 });
    console.log('\n  📊 End-to-End Pipeline Results:');
    console.log('  ' + 'Prompt'.padEnd(55) + 'Effort'.padEnd(12) + 'Tier'.padEnd(10) + 'Latency'.padEnd(10) + 'Tokens');
    console.log('  ' + '-'.repeat(95));

    for (const tp of testPrompts) {
      const score = heuristicScore(tp.text);
      const effort = scoreToEffort(score);
      const deviceClass = classifyDevice('wasm', 8, false); // server = desktop
      const cell = lookupMatrix(effort, deviceClass);

      // Route to Ollama for all (since we have a real model)
      const tokens: string[] = [];
      const start = performance.now();
      let usageTokens = 0;

      for await (const chunk of adapter.generate({
        prompt: tp.text,
        maxTokens: 128,
        temperature: 0.5,
      })) {
        if (chunk.token) tokens.push(chunk.token);
        if (chunk.done && chunk.usage) usageTokens = chunk.usage.completionTokens;
      }

      const latency = performance.now() - start;
      const response = tokens.join('');

      // Record for learning
      learning.recordOutcome({
        prompt: tp.text,
        score,
        effort,
        tier: cell.cloudOverride ? 'cloud' : 'local',
        model: OLLAMA_MODEL,
        latencyMs: latency,
        tokenCount: usageTokens || tokens.length,
        costCents: 0, // local
        userSatisfied: null,
        timestamp: Date.now(),
      });

      console.log(`  ${tp.text.slice(0, 53).padEnd(55)}${effort.padEnd(12)}${(cell.cloudOverride ? 'cloud' : 'local').padEnd(10)}${(latency.toFixed(0) + 'ms').padEnd(10)}${usageTokens || tokens.length}`);
    }

    const stats = learning.getStats();
    console.log(`\n  📊 Session Stats: ${stats.totalQueries} queries, ${stats.localPct}% local, avg cost savings ${stats.costSavingsPct}%`);
    console.log(`  📊 Learned thresholds: ${JSON.stringify(learning.currentThresholds)}`);

    const learnings = learning.getRecentLearnings();
    if (learnings.length > 0) {
      console.log('  🧠 Auto-learnings:');
      learnings.forEach(l => console.log(`     - [${l.type}] ${l.description}`));
    }
  }, 120000);
});
