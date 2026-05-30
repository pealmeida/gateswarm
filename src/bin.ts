#!/usr/bin/env npx tsx
/**
 * MoMA Cross-Platform — Quick Start CLI
 * 
 * Usage:
 *   npx tsx src/bin.ts                    # Interactive mode
 *   npx tsx src/bin.ts "What is 2+2?"     # Single query
 *   npx tsx src/bin.ts --test             # Run pipeline test
 *   npx tsx src/bin.ts --models           # List available models
 */

import { OllamaAdapter } from './adapters/ollama-adapter.js';
import { heuristicScore } from './intent-engine.js';
import { scoreToEffort, classifyDevice, lookupMatrix } from './routing-matrix.js';
import { LearningLoop } from './learning/learning-loop.js';

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:7b-instruct-q4_K_M';
const METRICS_URL = process.env.MOA_METRICS_URL ?? 'http://localhost:4174';

// ─── Metrics Logger ────────────────────────────────────────────
async function logToDashboard(data: {
  prompt: string; score: number; effort: string; model: string;
  tier: string; device: string; latency: number; expectedEffort?: string;
  adapter: string; tokensEstimate: number;
}) {
  try {
    await fetch(`${METRICS_URL}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(1000), // 1s timeout, non-blocking
    });
  } catch {
    // Dashboard not running — silently skip
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🧠 MoMA Cross-Platform — Quick Start

Usage:
  npx tsx src/bin.ts "your prompt here"    Single query
  npx tsx src/bin.ts --test                Run pipeline test
  npx tsx src/bin.ts --models              List available models
  npx tsx src/bin.ts --interactive         Interactive chat mode

Environment:
  OLLAMA_BASE_URL   Ollama server URL (default: http://localhost:11434)
  OLLAMA_MODEL      Model to use (default: qwen2.5:7b-instruct-q4_K_M)
`);
    return;
  }

  // Initialize adapter
  const adapter = new OllamaAdapter({
    id: 'ollama-main',
    modelId: OLLAMA_MODEL,
    displayName: 'Ollama Live',
    baseUrl: OLLAMA_BASE,
    maxTokens: 1024,
    costPer1kTokens: 0,
  });

  await adapter.initialize();

  if (!adapter.isAvailable) {
    console.error('❌ Ollama not available. Start with: ollama serve');
    console.error(`   Model: ${OLLAMA_MODEL}`);
    console.error(`   URL: ${OLLAMA_BASE}`);
    process.exit(1);
  }

  console.log(`✅ Connected to Ollama — ${OLLAMA_MODEL}`);

  if (args.includes('--models')) {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await res.json() as any;
    console.log('\n📦 Available models:');
    for (const m of data.models ?? []) {
      const size = (m.size / 1e9).toFixed(1);
      console.log(`  ${m.name.padEnd(40)} ${size}GB`);
    }
    return;
  }

  if (args.includes('--test')) {
    await runPipelineTest(adapter);
    return;
  }

  // Single query or interactive
  const prompt = args.find(a => !a.startsWith('--'));
  if (prompt) {
    await processQuery(adapter, prompt);
  } else {
    await interactiveMode(adapter);
  }
}

async function processQuery(adapter: OllamaAdapter, prompt: string) {
  const learning = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

  // Score
  const score = heuristicScore(prompt);
  const effort = scoreToEffort(score);
  const deviceClass = classifyDevice('wasm', 8, false);
  const cell = lookupMatrix(effort, deviceClass);

  console.log(`\n📊 Routing: effort=${effort}, score=${score.toFixed(2)}, model=${OLLAMA_MODEL}`);
  console.log(`💬 Response:\n`);

  const tokens: string[] = [];
  const start = performance.now();
  let totalUsage = 0;

  for await (const chunk of adapter.generate({ prompt, maxTokens: 512, temperature: 0.7 })) {
    if (chunk.token) {
      process.stdout.write(chunk.token);
      tokens.push(chunk.token);
    }
    if (chunk.done && chunk.usage) totalUsage = chunk.usage.totalTokens;
  }

  const latency = performance.now() - start;
  console.log(`\n\n⏱️  ${latency.toFixed(0)}ms | ${tokens.length} tokens${totalUsage ? ` (${totalUsage} total)` : ''} | effort: ${effort}`);

  learning.recordOutcome({
    prompt, score, effort,
    tier: cell.cloudOverride ? 'cloud' : 'local',
    model: OLLAMA_MODEL,
    latencyMs: latency,
    tokenCount: tokens.length,
    costCents: 0,
    userSatisfied: null,
    timestamp: Date.now(),
  });

  const stats = learning.getStats();
  console.log(`📈 Session: ${stats.totalQueries} queries, ${stats.localPct}% local`);

  // Log to metrics dashboard (non-blocking)
  logToDashboard({
    prompt, score, effort, model: OLLAMA_MODEL,
    tier: cell.cloudOverride ? 'cloud' : 'local',
    device: deviceClass, latency,
    adapter: 'ollama', tokensEstimate: tokens.length,
  });
}

async function runPipelineTest(adapter: OllamaAdapter) {
  console.log('\n🧪 Pipeline Test — 4 prompts across effort levels\n');
  
  const prompts = [
    { text: 'Hello!', label: 'trivial' },
    { text: 'What is the capital of Brazil?', label: 'light' },
    { text: 'Explain how HTTP works in 2 sentences', label: 'moderate' },
    { text: 'Write a Python hello world', label: 'heavy' },
  ];

  const learning = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

  for (const p of prompts) {
    const score = heuristicScore(p.text);
    const effort = scoreToEffort(score);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📌 [${p.label}] "${p.text}"`);
    console.log(`📊 effort=${effort}, score=${score.toFixed(2)}`);
    console.log(`${'─'.repeat(60)}`);

    const tokens: string[] = [];
    const start = performance.now();

    for await (const chunk of adapter.generate({ prompt: p.text, maxTokens: 128, temperature: 0.5 })) {
      if (chunk.token) {
        process.stdout.write(chunk.token);
        tokens.push(chunk.token);
      }
    }

    const latency = performance.now() - start;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`⏱️  ${latency.toFixed(0)}ms | ${tokens.length} tokens`);

    learning.recordOutcome({
      prompt: p.text, score, effort, tier: 'local',
      model: OLLAMA_MODEL, latencyMs: latency,
      tokenCount: tokens.length, costCents: 0,
      userSatisfied: null, timestamp: Date.now(),
    });
  }

  const stats = learning.getStats();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📈 Pipeline Summary:`);
  console.log(`   Queries: ${stats.totalQueries}`);
  console.log(`   Local: ${stats.localPct}% | Cloud: ${stats.cloudPct}%`);
  console.log(`   Learned thresholds: ${JSON.stringify(learning.currentThresholds)}`);
  
  const learnings = learning.getRecentLearnings();
  if (learnings.length > 0) {
    console.log(`   🧠 Auto-learnings:`);
    learnings.forEach(l => console.log(`     [${l.type}] ${l.description}`));
  }
}

async function interactiveMode(adapter: OllamaAdapter) {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const learning = new LearningLoop({ tier1: 0.3, tier2: 0.6 });

  console.log('\n🧠 MoMA Interactive — type your prompts (Ctrl+C to exit)\n');

  const ask = () => {
    rl.question('You: ', async (prompt: string) => {
      if (!prompt.trim()) { ask(); return; }

      const score = heuristicScore(prompt);
      const effort = scoreToEffort(score);
      console.log(`📊 [${effort}] score=${score.toFixed(2)} → `);

      const start = performance.now();
      const tokens: string[] = [];

      process.stdout.write('AI: ');
      for await (const chunk of adapter.generate({ prompt, maxTokens: 512, temperature: 0.7 })) {
        if (chunk.token) {
          process.stdout.write(chunk.token);
          tokens.push(chunk.token);
        }
      }

      const latency = performance.now() - start;
      console.log(`\n⏱️  ${latency.toFixed(0)}ms | ${tokens.length} tokens\n`);

      learning.recordOutcome({
        prompt, score, effort, tier: 'local',
        model: OLLAMA_MODEL, latencyMs: latency,
        tokenCount: tokens.length, costCents: 0,
        userSatisfied: null, timestamp: Date.now(),
      });

      ask();
    });
  };

  ask();
}

main().catch(console.error);
