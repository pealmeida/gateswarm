#!/usr/bin/env npx tsx
/**
 * GateSwarm MoMA Router v0.5.2 — CLI Providers + Direct Routing + Plan/Act Mode
 *
 * Commands for configuring the model matrix, reasoning toggles,
 * retraining frequency, and checking v0.4 status.
 *
 * Usage:
 *   npx tsx src/gateswarm-cli.ts status                          # Show v0.4 status
 *   npx tsx src/gateswarm-cli.ts models                           # List tier models
 *   npx tsx src/gateswarm-cli.ts model <tier> <model> <provider>
 *   npx tsx src/gateswarm-cli.ts reasoning                        # Show reasoning status
 *   npx tsx src/gateswarm-cli.ts reasoning <tier> on|off
 *   npx tsx src/gateswarm-cli.ts retrain-freq                     # Show retrain frequency
 *   npx tsx src/gateswarm-cli.ts retrain-freq <N>                 # Set retrain after N interactions
 *   npx tsx src/gateswarm-cli.ts weights                          # Show ensemble weights
 *   npx tsx src/gateswarm-cli.ts weights <method> <value>
 *   npx tsx src/gateswarm-cli.ts feedback                         # Show feedback stats
 *   npx tsx src/gateswarm-cli.ts rag                              # Show RAG stats
 *   npx tsx src/gateswarm-cli.ts retrain                          # Trigger manual retraining
 *   npx tsx src/gateswarm-cli.ts providers                        # List all providers (v0.5.1)
 *   npx tsx src/gateswarm-cli.ts direct <provider> <model> "prompt"  # Direct route (v0.5.1)
 *   npx tsx src/gateswarm-cli.ts mode-status                      # Show Plan/Act model config (v0.5.2)
 *   npx tsx src/gateswarm-cli.ts mode-set <tier> <field> <value>  # Set plan-mode field for tier (v0.5.2)
 *   npx tsx src/gateswarm-cli.ts mode-detect "prompt text"        # Detect intent mode from prompt (v0.5.2)
 */

import { loadConfig, getConfig, saveConfig, setTierModel, setTierThinking, setRetrainFrequency, setEnsembleWeights, getAllTierModels, getReasoningStatus, getTierModelForMode, detectIntentMode } from './v04-config.js';
import type { IntentMode, EffortLevel } from './types.js';
import { getInteractionCount, getFeedbackEntries, getTierAccuracy, shouldRetrain } from './feedback-store.js';
import { getRagStats } from './rag-index.js';
import { retrainIfNeeded } from './retraining.js';

// Training mode — queries gateway HTTP API (in-memory state lives there)
const GATEWAY_URL = process.env.GATESWARM_URL || 'http://localhost:8900';

function bar(pct: number | null, width = 10): string {
  if (pct === null) return '∞'.padEnd(width);
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const symbol = pct >= 90 ? '█' : pct >= 60 ? '▓' : '▰';
  return symbol.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function pctColor(pct: number | null): string {
  if (pct === null) return '∞';
  if (pct >= 80) return 'HIGH';
  if (pct >= 50) return 'MED';
  return 'LOW';
}

async function gatewayFetch(path: string, method = 'GET', body?: object): Promise<any> {
  const url = `${GATEWAY_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

async function cmdTraining(agentId?: string, action?: string) {
  if (!agentId && !action) {
    // Show all agents training status
    const agents = await gatewayFetch('/v1/agents');
    console.log('🎯 Training Mode Status:\n');
    console.log('Agent            Enabled   Gold   Silver   Bronze   Pending');
    console.log('──────────────── ───────── ────── ──────── ──────── ───────');
    for (const agent of (agents.agents || [])) {
      const stats = await gatewayFetch(`/v04/training?agentId=${agent.id}`);
      const s = stats.stats;
      console.log(
        `${(agent.id || agent.name).padEnd(17)}` +
        `${(s.enabled ? 'ON ✅' : 'OFF  ').padEnd(10)}` +
        `${String(s.goldLabels).padEnd(7)}` +
        `${String(s.silverLabels).padEnd(9)}` +
        `${String(s.bronzeLabels).padEnd(9)}` +
        `${String(s.pendingVotes)}`
      );
    }
    return;
  }

  if (action === 'on' || action === 'off') {
    const enabled = action === 'on';
    const result = await gatewayFetch('/v04/training/enable', 'POST', { agentId, enabled });
    console.log(`${result.enabled ? '✅' : '🚫'} Training mode ${enabled ? 'enabled' : 'disabled'} for ${agentId}`);
    return;
  }

  if (action === 'labels') {
    const stats = await gatewayFetch(`/v04/training?agentId=${agentId}`);
    const s = stats.stats;
    console.log(`🎯 Training Labels — ${agentId}:\n`);
    console.log(`  Enabled:       ${s.enabled ? 'Yes ✅' : 'No'}`);
    console.log(`  Gold labels:   ${s.goldLabels}`);
    console.log(`  Silver labels: ${s.silverLabels}`);
    console.log(`  Bronze labels: ${s.bronzeLabels}`);
    console.log(`  Pending votes: ${s.pendingVotes}`);
    console.log(`  Overall acc:   ${s.overallAccuracy >= 0 ? (s.overallAccuracy * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log(`  Fatigue decay: ${s.fatigueDecay.toFixed(3)}`);
    console.log(`  RAG phase:     ${s.ragPhase}\n`);
    if (s.overallAccuracy >= 0) {
      console.log('  Per-tier accuracy:');
      for (const [tier, t] of Object.entries(s.perTierAccuracy as any)) {
        const pct = (t as any).accuracy >= 0 ? ((t as any).accuracy * 100).toFixed(1) + '%' : 'N/A';
        console.log(`    ${(tier as string).padEnd(12)} ${(t as any).correct}/${(t as any).total} = ${pct}`);
      }
    }
    console.log(`\n  Calibration: bronze=${stats.calibration.bronzeWeight.toFixed(2)}  silver=${stats.calibration.silverWeight.toFixed(2)}  phase=${stats.calibration.ragPhase}`);
    console.log(`  Retraining: ${stats.retraining.should ? 'YES — ' + stats.retraining.reason : 'No — ' + stats.retraining.reason}`);
    return;
  }

  // Default: show single agent status
  const stats = await gatewayFetch(`/v04/training?agentId=${agentId}`);
  const s = stats.stats;
  console.log(`🎯 ${agentId} Training: ${s.enabled ? 'ON ✅' : 'OFF'}`);
  console.log(`   Gold: ${s.goldLabels}  Silver: ${s.silverLabels}  Bronze: ${s.bronzeLabels}  Pending: ${s.pendingVotes}`);
}

const args = process.argv.slice(2);

function printUsage() {
  console.log(`
🧠 GateSwarm MoMA Router v0.5.6 — CLI + TUI + Consumption Intelligence

Ops Commands:
  ops-guide                                 Show operations guide (debugging, updates, versioning)
  health                                    Quick 10-second health check
  version                                   Show all version stamps and detect skew

Core Commands:
  status                                    Show v0.4 system status
  models                                    List tier models
  model <tier> <model> <provider>           Set model for tier
  reasoning                                 Show reasoning (enable_thinking) status
  reasoning <tier> on|off                   Toggle reasoning for tier
  retrain-freq                              Show retraining frequency
  retrain-freq <N>                          Set retrain after N interactions (min 50)
  weights                                   Show ensemble weights
  weights <method> <value>                  Set ensemble weight (heuristic/cascade/ragSignal/historyBias)
  feedback                                  Show feedback buffer stats
  rag                                       Show RAG index stats
  retrain                                   Trigger manual retraining
  training                                  Show training mode status (all agents)
  training <agentId> on|off                 Enable/disable training mode for agent
  training labels <agentId>                 Show collected gold labels for agent
  providers                                 List all providers and models
  direct <provider> <model> "prompt"        Direct route to provider/model

Plan/Act Mode Commands (v0.5.2):
  mode-status                               Show Plan/Act model configuration for all tiers
  mode-set <tier> <field> <value>           Set a plan-mode field for a tier
                                              Fields: plan_model, plan_provider,
                                                      plan_max_tokens, plan_enable_thinking
  mode-detect <prompt text>                 Detect intent mode (plan/act/auto) from prompt text
  effort-override <tier> <prompt text>      Force a specific tier, bypassing ensemble scoring (v0.5.7)
  resolve <tier> [mode]                     Show what model would be used for tier+mode (v0.5.7)

Consumption Intelligence Commands (v0.5.6):
  intel                                     Show v0.5.6 intel: tier recommendations, stats, providers
  consumption                               Show per-provider 5h/weekly/monthly consumption + quota
  consumption <window>                      Filter to one window: 5h | weekly | monthly
  quota                                     Show per-provider quota (RPM/RPD/tokens/throttled)
  rediscover                                Force immediate model rediscovery

TUI Commands (v0.5.6):
  tui                                       Launch GateSwarm Bar TUI (interactive, needs TTY)
  tui --once                                One-shot JSON dump of consumption
  tui --once | jq '.'                       Pipe to jq for scripting
  tui --refresh 5                           5s refresh interval
  tui --tab providers                       Start on a specific tab
  tui --mock                                Use built-in mock data (no server needed)

Tiers: trivial, light, moderate, heavy, intensive, extreme
Providers: zai, bailian, openrouter, claude-cli, codex-cli, pi-agent, hermes-agent, openclaw-agent,
           ollama, ollama-cloud, opencodego

Examples:
  gateswarm model intensive qwen3.5-plus bailian
  gateswarm reasoning extreme on
  gateswarm retrain-freq 200
  gateswarm weights heuristic 0.35
  gateswarm providers
  gateswarm direct claude-cli cc/claude-sonnet-4-6 "What is 2+2?"
  gateswarm mode-status
  gateswarm mode-set heavy plan_model qwen3.6-plus
  gateswarm mode-set heavy plan_enable_thinking true
  gateswarm mode-detect "draft an architecture plan for the new service"
  gateswarm intel                            # v0.5.6 token consumption intel
  gateswarm consumption                      # per-provider 5h/weekly/monthly
  gateswarm consumption weekly               # just the weekly window
  gateswarm quota                            # RPM/RPD/tokens remaining
  gateswarm tui                              # launch TUI (TTY only)
  gateswarm tui --once                       # JSON dump (scriptable)
`);
}

async function cmdStatus() {
  const config = await loadConfig();
  const interactionCount = getInteractionCount();
  const accuracy = getTierAccuracy();
  const ragStats = getRagStats();

  console.log('🧠 GateSwarm MoMA Router v0.4 — Status\n');
  console.log(`Version:    ${config.version}`);
  console.log(`Method:     ${config.method}`);
  console.log(`Interactions: ${interactionCount}`);
  console.log(`Retraining: every ${config.feedback_loop.retrainAfterInteractions} interactions`);
  console.log(`LLM Judge:  ${config.feedback_loop.llmJudgeModel} (${(config.feedback_loop.llmJudgeSamplingRate * 100).toFixed(0)}% sampling)\n`);

  console.log('Ensemble Weights:');
  for (const [k, v] of Object.entries(config.ensemble.weights)) {
    console.log(`  ${k.padEnd(14)} ${v.toFixed(2)}`);
  }

  console.log('\nConfidence Thresholds:');
  console.log(`  High:  > ${config.ensemble.confidenceThresholds.high} → route to predicted tier`);
  console.log(`  Low:   < ${config.ensemble.confidenceThresholds.low} → safe default (intensive)`);
  console.log(`  Medium: else → escalate one tier`);

  console.log('\nTier Models:');
  for (const [tier, tm] of Object.entries(config.tier_models)) {
    const thinking = tm.enable_thinking ? '🧠 reasoning ON' : '⚡ reasoning OFF';
    console.log(`  ${tier.padEnd(12)} ${tm.model.padEnd(20)} (${tm.provider}) ${thinking}`);
  }

  console.log('\nFeedback Buffer:');
  const totalJudged = Object.values(accuracy).reduce((s, a) => s + a.total, 0);
  console.log(`  Total interactions: ${interactionCount}`);
  console.log(`  Judged entries:     ${totalJudged}`);
  if (totalJudged > 0) {
    console.log('  Per-tier accuracy:');
    for (const [tier, stats] of Object.entries(accuracy)) {
      const pct = (stats.accuracy * 100).toFixed(1);
      console.log(`    ${tier.padEnd(12)} ${stats.correct}/${stats.total} = ${pct}%`);
    }
  }

  console.log('\nRAG Index:');
  console.log(`  Total entries:  ${ragStats.total}`);
  console.log(`  Active entries: ${ragStats.active}`);
  console.log(`  Avg tokens:     ${ragStats.avgTokens}`);
}

async function cmdModels() {
  const config = await loadConfig();
  console.log('📦 Tier Models:\n');
  console.log('Tier         Model                 Provider        Reasoning');
  console.log('──────────── ───────────────────── ─────────────── ─────────');
  for (const [tier, tm] of Object.entries(config.tier_models)) {
    const thinking = tm.enable_thinking ? 'ON' : 'OFF';
    console.log(`${tier.padEnd(13)}${tm.model.padEnd(22)}${tm.provider.padEnd(15)}${thinking}`);
  }
}

async function cmdModel(tier: string, model: string, provider: string) {
  const validTiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
  if (!validTiers.includes(tier)) {
    console.error(`❌ Invalid tier: ${tier}. Must be one of: ${validTiers.join(', ')}`);
    process.exit(1);
  }

  setTierModel(tier as any, model, provider);
  await saveConfig();
  console.log(`✅ Set ${tier} → ${provider}/${model}`);
}

async function cmdReasoning(tier?: string, value?: string) {
  await loadConfig();
  if (!tier) {
    const reasoning = getReasoningStatus();
    console.log('🧠 Reasoning Status (enable_thinking):\n');
    console.log('Tier         Reasoning');
    console.log('──────────── ─────────');
    for (const [t, enabled] of Object.entries(reasoning)) {
      console.log(`${t.padEnd(13)}${enabled ? 'ON  🧠' : 'OFF ⚡'}`);
    }
    return;
  }

  const validTiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
  if (!validTiers.includes(tier)) {
    console.error(`❌ Invalid tier: ${tier}`);
    process.exit(1);
  }

  const enabled = value === 'on' || value === 'true' || value === '1';
  setTierThinking(tier as any, enabled);
  await saveConfig();
  console.log(`✅ Set ${tier} reasoning ${enabled ? 'ON 🧠' : 'OFF ⚡'}`);
}

async function cmdRetrainFreq(value?: string) {
  const config = await loadConfig();
  if (!value) {
    console.log(`🔄 Retraining frequency: every ${config.feedback_loop.retrainAfterInteractions} interactions`);
    console.log(`   Min samples per tier: ${config.feedback_loop.minSamplesPerTier}`);
    console.log(`   Cascade retraining: ${config.feedback_loop.cascadeRetraining ? 'ON' : 'OFF'} (source: ${config.feedback_loop.cascadeRetrainingSource})`);
    return;
  }

  const n = parseInt(value, 10);
  if (isNaN(n) || n < 50) {
    console.error('❌ Value must be a number ≥ 50');
    process.exit(1);
  }

  setRetrainFrequency(n);
  await saveConfig();
  console.log(`✅ Set retraining frequency: every ${n} interactions`);
}

async function cmdWeights(method?: string, value?: string) {
  const config = await loadConfig();
  if (!method) {
    console.log('⚖️  Ensemble Weights:\n');
    for (const [k, v] of Object.entries(config.ensemble.weights)) {
      console.log(`  ${k.padEnd(14)} ${v.toFixed(2)}`);
    }
    return;
  }

  const validMethods = ['heuristic', 'cascade', 'ragSignal', 'historyBias'];
  if (!validMethods.includes(method)) {
    console.error(`❌ Invalid method: ${method}. Must be one of: ${validMethods.join(', ')}`);
    process.exit(1);
  }

  const v = parseFloat(value || '0');
  if (isNaN(v) || v < 0 || v > 1) {
    console.error('❌ Value must be a number between 0 and 1');
    process.exit(1);
  }

  setEnsembleWeights({ [method]: v } as any);
  await saveConfig();
  console.log(`✅ Set ${method} weight to ${v.toFixed(2)}`);
}

async function cmdFeedback() {
  const count = getInteractionCount();
  const accuracy = getTierAccuracy();
  const totalJudged = Object.values(accuracy).reduce((s, a) => s + a.total, 0);
  const overallAcc = totalJudged > 0
    ? (Object.values(accuracy).reduce((s, a) => s + a.correct, 0) / totalJudged * 100).toFixed(1)
    : 'N/A';

  console.log('📊 Feedback Buffer:\n');
  console.log(`  Total interactions: ${count}`);
  console.log(`  Judged entries:     ${totalJudged}`);
  console.log(`  Overall accuracy:   ${overallAcc}%`);

  if (totalJudged > 0) {
    console.log('\n  Per-tier:');
    for (const [tier, stats] of Object.entries(accuracy)) {
      const pct = (stats.accuracy * 100).toFixed(1);
      console.log(`    ${tier.padEnd(12)} ${stats.correct}/${stats.total} = ${pct}%`);
    }
  }
}

async function cmdRag() {
  const stats = getRagStats();
  console.log('🔍 RAG Index:\n');
  console.log(`  Total entries:  ${stats.total}`);
  console.log(`  Active entries: ${stats.active}`);
  console.log(`  Avg tokens:     ${stats.avgTokens}`);
}

async function cmdRetrain() {
  console.log('🔄 Triggering manual retraining...');
  const result = await retrainIfNeeded();
  if (result.retrained) {
    console.log(`✅ Retraining complete. Accuracy: ${((result.accuracyBefore ?? 0) * 100).toFixed(1)}% → ${((result.accuracyAfter ?? 0) * 100).toFixed(1)}%`);
    console.log(`   Recalibrated tier boundaries: ${JSON.stringify(result.boundaries)} (live, no restart needed).`);
  } else {
    console.log('⏭️  Not enough data for retraining yet.');
    console.log('   Need min 50 samples per tier with LLM-judged ground truth.');
  }
}

// ─── v0.5.1: Direct Routing Commands ───────────────────────

async function cmdProviders() {
  const result = await gatewayFetch('/v1/providers');
  const providers = result.data || [];
  console.log('📦 GateSwarm Providers (v0.5.1):\n');
  console.log('Provider           Type        Configured  Models');
  console.log('──────────────── ───────── ───────── ──────────────────────────────');
  for (const p of providers) {
    const configured = p.type === 'cli-agent' ? '✅' : (p.configured ? '✅' : '❌');
    const modelList = p.models.join(', ').slice(0, 40);
    console.log(`${p.id.padEnd(17)}${p.type.padEnd(12)}${configured.padEnd(12)}${modelList}`);
  }
  console.log(`\nTotal: ${providers.length} providers`);
}

async function cmdDirect(provider: string, model: string, prompt: string) {
  const startTime = Date.now();
  const result = await gatewayFetch('/v1/direct/chat', 'POST', {
    messages: [{ role: 'user', content: prompt }],
    direct_route: { provider, model },
  });
  const latency = Date.now() - startTime;

  if (result.error) {
    console.error(`❌ ${result.error.message}`);
    process.exit(1);
  }

  const choice = result.choices?.[0];
  const content = choice?.message?.content || '(no content)';
  const usage = result.usage || {};

  console.log(`📍 Direct Route → ${provider}/${model}\n`);
  console.log(`Response (${latency}ms):`);
  console.log(`─`.repeat(50));
  console.log(content);
  console.log(`─`.repeat(50));
  console.log(`\nTokens: ${usage.prompt_tokens || 0}→${usage.completion_tokens || 0} (total: ${usage.total_tokens || 0})`);
  console.log(`Model:  ${result.model}`);
}

// ─── v0.5.2: Plan/Act Mode Commands ─────────────────────

async function cmdModeStatus() {
  await loadConfig();
  const tiers = getAllTierModels();
  console.log('Plan/Act Model Configuration\n');
  console.log('Tier         Act Model             Plan Model');
  console.log('──────────── ───────────────────── ─────────────────────');
  for (const [tier, tm] of Object.entries(tiers)) {
    const actModel = tm.model;
    const planModel = tm.plan_model ? tm.plan_model : '(same as act)';
    console.log(`${tier.padEnd(13)}${actModel.padEnd(22)}${planModel}`);
  }
}

async function cmdModeSet(tier: string, field: string, value: string) {
  const validTiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
  if (!validTiers.includes(tier)) {
    console.error(`Invalid tier: ${tier}. Must be one of: ${validTiers.join(', ')}`);
    process.exit(1);
  }

  const validFields = ['plan_model', 'plan_provider', 'plan_max_tokens', 'plan_enable_thinking'];
  if (!validFields.includes(field)) {
    console.error(`Invalid field: ${field}. Must be one of: ${validFields.join(', ')}`);
    process.exit(1);
  }

  await loadConfig();
  const cfg = getConfig();
  const tierCfg = cfg.tier_models[tier as EffortLevel];

  if (field === 'plan_max_tokens') {
    const n = parseInt(value, 10);
    if (isNaN(n) || n <= 0) {
      console.error('plan_max_tokens must be a positive integer');
      process.exit(1);
    }
    (tierCfg as any)[field] = n;
  } else if (field === 'plan_enable_thinking') {
    (tierCfg as any)[field] = value === 'true' || value === '1' || value === 'on';
  } else {
    (tierCfg as any)[field] = value;
  }

  await saveConfig();
  console.log(`Set ${tier}.${field} = ${value}`);
}

async function cmdModeDetect(promptText: string) {
  const result = detectIntentMode(promptText);
  const pct = (result.confidence * 100).toFixed(0);
  console.log(`Mode: ${result.mode}, Confidence: ${pct}%, Plan score: ${result.planScore}, Act score: ${result.actScore}`);
}

// ─── v0.5.7 Effort Override + Mode Resolve Commands ──────────

async function cmdEffortOverride(tier: string, prompt: string) {
  const validTiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
  if (!validTiers.includes(tier)) {
    console.error(`❌ tier must be one of: ${validTiers.join(', ')}`);
    process.exit(1);
  }
  const result = await gatewayFetch('/v1/chat/completions', 'POST', {
    model: 'gateswarm',
    messages: [{ role: 'user', content: prompt }],
    effort_override: tier,
    stream: false,
    max_tokens: 50,
  });
  console.log(`🎯 Forced tier '${tier}' → ${result.model}`);
  console.log(`   Response: ${(result.choices?.[0]?.message?.content || '').slice(0, 100)}...`);
}

async function cmdResolve(tier: string, mode: string = 'auto') {
  const result = await gatewayFetch('/v06/resolve', 'POST', { tier, mode });
  console.log(`\n🎯 Tier=${result.tier} Mode=${result.mode}`);
  console.log(`   → ${result.resolved.provider}/${result.resolved.model}`);
  console.log(`   max_tokens=${result.resolved.max_tokens}  thinking=${result.resolved.enable_thinking}\n`);
}

// ─── v0.5.6 Consumption Intelligence Commands ────────────────

async function cmdIntel() {
  const data = await gatewayFetch('/v05/intel');
  const s = data.stats;
  const rec = data.recommendations;
  const errorRate = (s.errorRate * 100).toFixed(2);

  console.log('🧠 GateSwarm v' + data.version + ' — Token Consumption Intelligence\n');
  console.log('System:');
  console.log(`  Models: ${s.modelCount} indexed, ${s.availableModels} available, ${s.unhealthyModels} unhealthy`);
  console.log(`  Requests: ${s.totalRequests}, Errors: ${s.totalErrors} (${errorRate}%)`);
  console.log(`  Tokens: ${fmt(s.totalTokensIn)} in + ${fmt(s.totalTokensOut)} out = ${fmt(s.totalTokensIn + s.totalTokensOut)} total`);
  console.log(`  Cost: $${s.estimatedCost.toFixed(4)}`);
  console.log();
  console.log('Tier Recommendations:');
  for (const tier of ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme']) {
    const r = rec[tier];
    if (!r) continue;
    const cand = s.tierDistribution[tier] || 0;
    const conf = (r.confidence * 100).toFixed(0);
    console.log(`  ${tier.padEnd(10)} → ${r.provider}/${r.model.padEnd(28)} conf=${conf}% [${r.reason}] (${cand} candidates)`);
  }
  console.log();
  console.log('Provider Traffic:');
  for (const p of s.providers) {
    if (p.totalRequests > 0 || p.totalModels > 0) {
      console.log(`  ${p.provider.padEnd(15)} models: ${p.availableModels}/${p.totalModels}, req: ${p.totalRequests}, errors: ${p.totalErrors}, lat: ${p.avgLatencyMs}ms`);
    }
  }
}

async function cmdConsumption(window?: string) {
  const data = await gatewayFetch('/v05/intel/consumption');
  const windows: Array<[string, string]> = [
    ['5h', 'totalFiveHour'],
    ['weekly', 'totalWeekly'],
    ['monthly', 'totalMonthly'],
  ];
  const filter = window?.toLowerCase();

  console.log('📊 GateSwarm Consumption (v0.5.6) — Generated: ' + new Date(data.generatedAt).toLocaleString() + '\n');

  for (const [label, key] of windows) {
    if (filter && !filter.startsWith(label.slice(0, 2))) continue;
    const w = data[key];
    console.log(`${label.toUpperCase()} WINDOW (${w.windowMs / 1000 / 60 / 60}h):`);
    console.log(`  Total: ${w.requests} req, ${fmt(w.totalTokens)} tok (${fmt(w.tokensIn)} in + ${fmt(w.tokensOut)} out), ${w.errors} err, ${w.avgLatencyMs}ms avg`);
  }

  // Per-provider USAGE PERCENTAGE — the focus of this view
  const showAll = !filter;
  const focusWindow = showAll ? null : (
    filter.startsWith('5') ? 'fiveHour' :
    filter.startsWith('we') ? 'weekly' : 'monthly'
  );

  console.log('\n┌─ USAGE PERCENTAGE BY WINDOW ──────────────────────────────────────┐');

  for (const p of data.providers) {
    const fh = p.quota.fiveHour;
    const wk = p.quota.weekly;
    const mo = p.quota.monthly;

    const fhBar = bar(fh.usedPctRequests, 16);
    const fhReqStr = fh.limitRequests === null ? '∞' : `${fh.usedRequests}/${fh.limitRequests}`;
    const fhTokStr = fh.limitTokens === null ? '∞' : `${fmt(fh.usedTokens)}/${fmt(fh.limitTokens!)}`;

    const wkBar = bar(wk.usedPctRequests, 16);
    const wkReqStr = wk.limitRequests === null ? '∞' : `${wk.usedRequests}/${wk.limitRequests}`;

    const moBar = bar(mo.usedPctRequests, 16);
    const moReqStr = mo.limitRequests === null ? '∞' : `${mo.usedRequests}/${mo.limitRequests}`;

    const name = p.provider.padEnd(15);
    console.log(`\n  ${name}  ${p.fiveHour.requests} req in 5h, ${fmt(p.fiveHour.totalTokens)} tokens`);

    if (focusWindow === null || focusWindow === 'fiveHour') {
      const color = pctBadge(fh.usedPctRequests);
      const label = fh.limitRequests === null ? '(unlimited)' : `${fhReqStr} req | ${fhTokStr} tok`;
      console.log(`    5h:     [${fhBar}] ${color}  ${label}`);
    }
    if (focusWindow === null || focusWindow === 'weekly') {
      const color = pctBadge(wk.usedPctRequests);
      const label = wk.limitRequests === null ? '(unlimited)' : `${wkReqStr} req`;
      console.log(`    weekly: [${wkBar}] ${color}  ${label}`);
    }
    if (focusWindow === null || focusWindow === 'monthly') {
      const color = pctBadge(mo.usedPctRequests);
      const label = mo.limitRequests === null ? '(unlimited)' : `${moReqStr} req`;
      console.log(`    monthly:[${moBar}] ${color}  ${label}`);
    }
  }
  console.log('\n└────────────────────────────────────────────────────────────────────┘');
  console.log('  Legend: 0-50% LOW 🟢   50-80% MED 🟡   80-100% HIGH 🔴');

  console.log('\n┌─ QUOTA RESET SCHEDULE ─────────────────────────────────────────────┐');
  for (const p of data.providers) {
    const fh = p.quota.fiveHour;
    const wk = p.quota.weekly;
    const mo = p.quota.monthly;
    const fhReset = fh.limitRequests === null ? '∞ never resets' : `↻ ${fh.resetAt} (${fh.resetType})`;
    const wkReset = wk.limitRequests === null ? '∞ never resets' : `↻ ${wk.resetAt} (${wk.resetType})`;
    const moReset = mo.limitRequests === null ? '∞ never resets' : `↻ ${mo.resetAt} (${mo.resetType})`;
    console.log(`  ${p.provider.padEnd(15)} 5h: ${fhReset.padEnd(28)}  wk: ${wkReset.padEnd(28)}  mo: ${moReset}`);
  }
  console.log('└────────────────────────────────────────────────────────────────────┘');

  console.log('\n┌─ WINDOW TOTALS (all providers combined) ───────────────────────────┐');
  for (const [label, key] of windows) {
    const w = data[key];
    console.log(`  ${label.toUpperCase().padEnd(8)} ${String(w.requests).padStart(3)} req   ${fmt(w.totalTokens).padStart(8)} tok   ${String(w.errors).padStart(2)} err   ${String(w.avgLatencyMs).padStart(5)}ms avg`);
  }
  console.log('└────────────────────────────────────────────────────────────────────┘');
}

function pctBadge(pct: number | null): string {
  if (pct === null) return '  ∞  ';
  const p = pct.toFixed(1).padStart(5) + '%';
  if (pct >= 80) return `🔴 ${p}`;
  if (pct >= 50) return `🟡 ${p}`;
  return `🟢 ${p}`;
}

async function cmdQuota() {
  const data = await gatewayFetch('/v05/intel/quota');
  console.log('📊 Provider Quota (v0.5.6)\n');
  console.log('PROVIDER         HEALTH  RPM         RPD              TOKENS         THROTTLED');
  console.log('─────────────────────────────────────────────────────────────────────────────');
  for (const q of data.quotas) {
    const healthBar = bar(q.health, 10);
    const throttle = q.throttled ? '🚫 YES' : 'no';
    console.log(
      `${q.provider.padEnd(16)} ${healthBar} ${q.health.toString().padStart(3)}%  ${q.rpm.padEnd(11)} ${q.rpd.padEnd(16)} ${q.tokens.padEnd(13)} ${throttle}`,
    );
  }
}

async function cmdRediscover() {
  console.log('🔄 Forcing model rediscovery…');
  const result = await gatewayFetch('/v05/intel/rediscover', 'POST');
  console.log(`✅ Rediscovery complete: ${result.modelsIndexed || '?'} models indexed`);
}

async function cmdTui(args: string[]) {
  // Launch the v0.5.6 GateSwarm Bar TUI client.
  // In a TTY: full interactive UI. In non-TTY (piped): snapshot mode.
  // Resolve the cli/dist path relative to this script's location.
  // Path is: <this-script-dir>/../cli/dist/cli.js
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const cliPath = join(__dirname, '..', 'cli', 'dist', 'cli.js');
  const { spawn } = await import('child_process');
  const child = spawn('node', [cliPath, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const command = args[0];

  switch (command) {
    case 'ops-guide':
      await cmdOpsGuide();
      break;
    case 'health':
      await cmdHealth();
      break;
    case 'version':
      await cmdVersion();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'models':
      await cmdModels();
      break;
    case 'model':
      if (args.length < 4) {
        console.error('Usage: gateswarm model <tier> <model> <provider>');
        process.exit(1);
      }
      await cmdModel(args[1], args[2], args[3]);
      break;
    case 'reasoning':
      await cmdReasoning(args[1], args[2]);
      break;
    case 'retrain-freq':
      await cmdRetrainFreq(args[1]);
      break;
    case 'weights':
      await cmdWeights(args[1], args[2]);
      break;
    case 'feedback':
      await cmdFeedback();
      break;
    case 'rag':
      await cmdRag();
      break;
    case 'retrain':
      await cmdRetrain();
      break;
    case 'providers':
      await cmdProviders();
      break;
    case 'direct':
      if (args.length < 4) {
        console.error('Usage: gateswarm direct <provider> <model> "prompt"');
        console.error('  Example: gateswarm direct claude-cli cc/claude-sonnet-4-6 "What is 2+2?"');
        process.exit(1);
      }
      await cmdDirect(args[1], args[2], args.slice(3).join(' '));
      break;
    case 'training':
      await cmdTraining(args[1], args[2]);
      break;
    case 'mode-status':
      await cmdModeStatus();
      break;
    case 'mode-set':
      if (args.length < 4) {
        console.error('Usage: gateswarm mode-set <tier> <field> <value>');
        console.error('  Fields: plan_model, plan_provider, plan_max_tokens, plan_enable_thinking');
        process.exit(1);
      }
      await cmdModeSet(args[1], args[2], args[3]);
      break;
    case 'mode-detect':
      if (args.length < 2) {
        console.error('Usage: gateswarm mode-detect <prompt text>');
        process.exit(1);
      }
      await cmdModeDetect(args.slice(1).join(' '));
      break;
    case 'effort-override':
      if (args.length < 3) {
        console.error('Usage: gateswarm effort-override <tier> <prompt text>');
        process.exit(1);
      }
      await cmdEffortOverride(args[1], args.slice(2).join(' '));
      break;
    case 'resolve':
      if (args.length < 2) {
        console.error('Usage: gateswarm resolve <tier> [mode]');
        process.exit(1);
      }
      await cmdResolve(args[1], args[2] || 'auto');
      break;

    // ─── v0.5.6 Consumption Intelligence Commands ─────────
    case 'intel':
      await cmdIntel();
      break;
    case 'consumption':
      await cmdConsumption(args[1]);
      break;
    case 'quota':
      await cmdQuota();
      break;
    case 'rediscover':
      await cmdRediscover();
      break;
    case 'tui':
      await cmdTui(args.slice(1));
      break;

    case 'ops-guide':
      await cmdOpsGuide();
      break;
    case 'health':
      await cmdHealth();
      break;
    case 'version':
      await cmdVersion();
      break;

    default:
      console.error(`❌ Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// ─── v0.5.6 Operations Commands ──────────────────────────────

async function cmdOpsGuide(): Promise<void> {
  try {
    const res = await fetch(`${GATEWAY_URL}/v05/intel/ops-guide`);
    if (!res.ok) {
      console.error(`❌ Failed to fetch ops guide: HTTP ${res.status}`);
      process.exit(1);
    }
    const text = await res.text();
    console.log(text);
  } catch (e: any) {
    console.error(`❌ Could not reach gateway at ${GATEWAY_URL}: ${e.message}`);
    process.exit(1);
  }
}

async function cmdHealth(): Promise<void> {
  console.log('🏥 GateSwarm Health Check\n');
  let pass = 0, fail = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    const icon = ok ? '✅' : '❌';
    console.log(`  ${icon} ${label}: ${detail}`);
    if (ok) pass++; else fail++;
  };

  // 1. Service alive
  try {
    const res = await fetch(`${GATEWAY_URL}/health`);
    const d = await res.json();
    check('Service', d.status === 'healthy', `${d.router} (llmJudge: ${d.llmJudge})`);
  } catch (e: any) {
    check('Service', false, `unreachable: ${e.message}`);
  }

  // 2. Provider health (HTTP providers in quota, CLI providers in agent-registry)
  try {
    const quotaRes = await fetch(`${GATEWAY_URL}/v05/intel/quota`);
    const quota = await quotaRes.json();
    const criticalHttp = ['zai', 'opencodego', 'ollama', 'ollama-cloud'];
    for (const pid of criticalHttp) {
      const p = (quota.quotas || []).find((q: any) => q.provider === pid);
      if (!p) { check(`Provider ${pid}`, false, 'not registered'); continue; }
      const ok = p.health >= 80 && !p.throttled;
      check(`Provider ${pid}`, ok, `health=${p.health} throttled=${p.throttled}`);
    }
    // CLI providers — check the /v05/intel CLI endpoint
    const cliRes = await fetch(`${GATEWAY_URL}/v05/cli`);
    if (cliRes.ok) {
      const cli = await cliRes.json();
      for (const c of cli.providers || []) {
        check(`CLI ${c.id}`, true, `models=${(c.models || []).length} type=${c.type}`);
      }
    }
  } catch (e: any) {
    check('Provider health', false, `unreachable: ${e.message}`);
  }

  // 3. Last decision
  try {
    const res = await fetch(`${GATEWAY_URL}/v05/intel/last-decision`);
    if (res.ok) {
      const d = await res.json();
      check('Last decision', true, `${d.tier} → ${d.provider}/${d.model} (conf=${(d.confidence * 100).toFixed(0)}%)`);
    } else {
      check('Last decision', false, 'no recent request');
    }
  } catch (e: any) {
    check('Last decision', false, `unreachable: ${e.message}`);
  }

  console.log(`\n📊 ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

async function cmdVersion(): Promise<void> {
  console.log('📦 GateSwarm Version Sync Check\n');
  const fs = await import('fs/promises');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '..');

  // 1. Service reports
  try {
    const res = await fetch(`${GATEWAY_URL}/health`);
    const d = await res.json();
    console.log(`  [service]  ${d.router}`);
  } catch (e: any) {
    console.log(`  [service]  ❌ unreachable: ${e.message}`);
  }

  // 2. Files on disk
  const files: Array<[string, string]> = [
    ['package.json', path.join(repoRoot, 'package.json')],
    ['cli/package.json', path.join(repoRoot, 'cli/package.json')],
    ['v04_config.json', path.join(repoRoot, 'v04_config.json')],
    ['moma-gateway.ts', path.join(repoRoot, 'src/moma-gateway.ts')],
    ['/usr/local/bin/gateswarm', '/usr/local/bin/gateswarm'],
  ];
  for (const [label, p] of files) {
    try {
      const content = await fs.readFile(p, 'utf-8');
      const m = content.match(/v?0\.5\.\d+(-[a-z0-9-]+)?/);
      console.log(`  [${label.padEnd(22)}] ${m ? m[0] : '⚠️  no version found'}`);
    } catch (e: any) {
      console.log(`  [${label.padEnd(22)}] ❌ ${e.message}`);
    }
  }

  // 3. systemd — canonical unit is moma-gateway.service; legacy deployments used moa-gateway.service
  for (const unit of ['moma-gateway.service', 'moa-gateway.service']) {
    try {
      const content = await fs.readFile(`/etc/systemd/system/${unit}`, 'utf-8');
      const m = content.match(/v0\.5\.\d+/);
      console.log(`  [systemd Description]   ${m ? m[0] : '⚠️  no version'}${unit.startsWith('moa-') ? ' (legacy unit name moa-gateway — consider renaming to moma-gateway)' : ''}`);
      break;
    } catch {}
  }

  // 4. Pi
  try {
    const content = await fs.readFile(path.join(process.env.HOME || '~', '.pi/agent/models.json'), 'utf-8');
    const d = JSON.parse(content);
    const m = d.providers?.moma?.models?.[0]?.name;
    console.log(`  [~/.pi/agent/models.json] ${m ?? '⚠️  no moma provider'}`);
  } catch {}

  console.log('\nIf any line shows ⚠️, the version bump is incomplete. See `gateswarm ops-guide` §5.4.');
}

main().catch(console.error);
