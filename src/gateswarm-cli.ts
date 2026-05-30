#!/usr/bin/env npx tsx
/**
 * GateSwarm MoMA Router v0.5.1 — CLI
 *
 * Commands for configuring the model matrix, reasoning toggles,
 * retraining frequency, and checking v0.4 status.
 *
 * Usage:
 *   npx tsx src/gateswarm-cli.ts status           # Show v0.4 status
 *   npx tsx src/gateswarm-cli.ts models            # List tier models
 *   npx tsx src/gateswarm-cli.ts model <tier> <model> <provider>
 *   npx tsx src/gateswarm-cli.ts reasoning         # Show reasoning status
 *   npx tsx src/gateswarm-cli.ts reasoning <tier> on|off
 *   npx tsx src/gateswarm-cli.ts retrain-freq      # Show retrain frequency
 *   npx tsx src/gateswarm-cli.ts retrain-freq <N>  # Set retrain after N interactions
 *   npx tsx src/gateswarm-cli.ts weights           # Show ensemble weights
 *   npx tsx src/gateswarm-cli.ts weights <method> <value>
 *   npx tsx src/gateswarm-cli.ts feedback          # Show feedback stats
 *   npx tsx src/gateswarm-cli.ts rag               # Show RAG stats
 *   npx tsx src/gateswarm-cli.ts retrain           # Trigger manual retraining
 *   npx tsx src/gateswarm-cli.ts providers         # List all providers (v0.5.1)
 *   npx tsx src/gateswarm-cli.ts direct <provider> <model> "prompt"  # Direct route (v0.5.1)
 */

import { loadConfig, getConfig, saveConfig, setTierModel, setTierThinking, setRetrainFrequency, setEnsembleWeights, getAllTierModels, getReasoningStatus } from './v04-config.js';
import { getInteractionCount, getFeedbackEntries, getTierAccuracy, shouldRetrain } from './feedback-store.js';
import { getRagStats } from './rag-index.js';
import { retrainIfNeeded } from './retraining.js';

// Training mode — queries gateway HTTP API (in-memory state lives there)
const GATEWAY_URL = process.env.GATESWARM_URL || 'http://localhost:8900';

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
🧠 GateSwarm MoMA Router v0.6.2 — CLI

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

effort Customization (v0.6):
  effort-status                             Show per-agent effort profiles
  effort-set <agentId> <default> [ceiling] [bias]  Set agent effort profile
  effort-override <tier> "prompt"           Test override routing

Plan/Act Modes (v0.6):
  mode-status                               Show mode config per tier
  mode-set <tier> <model> <provider> [max_tokens]  Set plan model for tier
  mode "prompt"                             Test mode detection

Token Economy (v0.6):
  token-stats                               Show token economy stats
  token-stats <agentId>                     Show per-agent token stats
  token-stats reset                         Reset token economy stats

Auto-Fallback (v0.6.2):
  health                                    Show provider health + quota status
  quota                                     Show detailed quota info
  quota <providerId>                        Probe specific provider
  reset <providerId>                        Reset provider cooldown/quota

Tiers: trivial, light, moderate, heavy, intensive, extreme
Providers: zai, bailian, openrouter, claude-cli, codex-cli, pi-agent, hermes-agent, openclaw-agent

Examples:
  gateswarm model intensive qwen3.6-plus bailian
  gateswarm reasoning extreme on
  gateswarm retrain-freq 200
  gateswarm weights heuristic 0.35
  gateswarm effort-set bmad-dev moderate heavy -0.1
  gateswarm mode-set moderate glm-4.7-flash zai 512
  gateswarm mode "draft an architecture for..."
  gateswarm token-stats
  gateswarm providers
  gateswarm direct claude-cli cc/claude-sonnet-4-6 "What is 2+2?"
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
    console.log(`✅ Retraining complete. Accuracy: ${(result.accuracy! * 100).toFixed(1)}%`);
    console.log('   New weights hot-swapped (no restart needed).');
  } else {
    console.log('⏭️  Not enough data for retraining yet.');
    console.log('   Need min 50 samples per tier with LLM-judged ground truth.');
  }
}

// ─── v0.5.1: Direct Routing Commands ───────────────────────

async function cmdProviders() {
  const result = await gatewayFetch('/v1/providers');
  const providers = result.data || [];
  console.log('📦 GateSwarm Providers:\n');
  console.log('Provider           Type        Configured  Models');
  console.log('──────────────── ───────── ───────── ──────────────────────────────');
  for (const p of providers) {
    const configured = p.type === 'cli-agent' ? '✅' : (p.configured ? '✅' : '❌');
    const modelList = p.models.join(', ').slice(0, 40);
    console.log(`${p.id.padEnd(17)}${p.type.padEnd(12)}${configured.padEnd(12)}${modelList}`);
  }
  console.log(`\nTotal: ${providers.length} providers (${providers.filter((p: any) => p.type === 'cli-agent').length} CLI + ${providers.filter((p: any) => p.type === 'http-api').length} HTTP)`);
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

// ═══════════════════════════════════════════════════════
// v0.6: Effort Customization Commands
// ═══════════════════════════════════════════════════════

async function cmdEffortStatus() {
  const result = await gatewayFetch('/v06/effort');
  console.log('🎛️  Effort Profiles:\n');
  console.log('Agent            Floor       Ceiling     Bias');
  console.log('──────────────── ─────────── ─────────── ──────');
  for (const a of (result.profiles || [])) {
    const ep = a.effortProfile || {};
    const floor = (ep.default || '-').padEnd(12);
    const ceiling = (ep.ceiling || '-').padEnd(12);
    const bias = ep.bias !== undefined && ep.bias !== 0 ? `${ep.bias > 0 ? '+' : ''}${ep.bias}` : '-';
    console.log(`${(a.id).padEnd(17)}${floor}${ceiling}${bias}`);
  }
}

async function cmdEffortSet(agentId: string, defaultTier: string, ceiling?: string, bias?: string) {
  const validTiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
  if (!validTiers.includes(defaultTier)) {
    console.error(`❌ Invalid tier: ${defaultTier}. Must be one of: ${validTiers.join(', ')}`);
    process.exit(1);
  }
  if (ceiling && !validTiers.includes(ceiling)) {
    console.error(`❌ Invalid ceiling tier: ${ceiling}. Must be one of: ${validTiers.join(', ')}`);
    process.exit(1);
  }
  const biasNum = bias ? parseFloat(bias) : undefined;
  if (bias !== undefined && (isNaN(biasNum!) || biasNum! < -0.2 || biasNum! > 0.2)) {
    console.error('❌ Bias must be between -0.2 and +0.2');
    process.exit(1);
  }

  const body: any = { agentId, default: defaultTier };
  if (ceiling) body.ceiling = ceiling;
  if (bias !== undefined) body.bias = biasNum;

  const result = await gatewayFetch('/v06/effort', 'POST', body);
  console.log(`✅ ${result.message}`);
  console.log(`   Profile: default=${result.effortProfile.default}, ceiling=${result.effortProfile.ceiling || 'none'}, bias=${result.effortProfile.bias ?? 'none'}`);
}

async function cmdEffortOverride(tier: string, prompt: string) {
  const startTime = Date.now();
  const result = await gatewayFetch('/v1/chat/completions', 'POST', {
    messages: [{ role: 'user', content: prompt }],
    effort_override: tier,
  });
  const latency = Date.now() - startTime;

  if (result.error) {
    console.error(`❌ ${result.error.message}`);
    process.exit(1);
  }

  const content = result.choices?.[0]?.message?.content || '(no content)';
  const usage = result.usage || {};
  console.log(`🎯 Effort Override → ${tier}\n`);
  console.log(`Response (${latency}ms):`);
  console.log('─'.repeat(50));
  console.log(content.slice(0, 500));
  console.log('─'.repeat(50));
  console.log(`\nTokens: ${usage.prompt_tokens || 0}→${usage.completion_tokens || 0} (total: ${usage.total_tokens || 0})`);
}

// ═══════════════════════════════════════════════════════
// v0.6: Plan/Act Mode Commands
// ═══════════════════════════════════════════════════════

async function cmdModeStatus() {
  const result = await gatewayFetch('/v06/mode');
  console.log('🎭 Plan/Act Mode Configuration:\n');
  console.log('Tier         Primary Model                  Plan Model');
  console.log('──────────── ────────────────────────────── ─────────────────────────────');
  for (const [tier, mc] of Object.entries(result.modeConfig as any)) {
    const m = mc as any;
    const plan = m.plan ? m.plan : '(same as primary)';
    console.log(`${tier.padEnd(13)}${m.primary.padEnd(32)}${plan}`);
  }
}

async function cmdModeSet(tier: string, model: string, provider: string, maxTokens?: string) {
  const validTiers = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
  if (!validTiers.includes(tier)) {
    console.error(`❌ Invalid tier: ${tier}. Must be one of: ${validTiers.join(', ')}`);
    process.exit(1);
  }

  const body: any = { tier, model, provider };
  if (maxTokens) body.max_tokens = parseInt(maxTokens, 10);

  const result = await gatewayFetch('/v06/mode', 'POST', body);
  console.log(`✅ ${result.message}`);
}

async function cmdModeDetect(prompt: string) {
  const result = await gatewayFetch('/v06/mode/detect', 'POST', { prompt });
  console.log('🎭 Mode Detection Result:\n');
  console.log(`  Mode:       ${result.mode}`);
  console.log(`  Confidence: ${(result.confidence * 100).toFixed(0)}%`);
  console.log(`  Plan signals: ${result.planScore}`);
  console.log(`  Act signals:  ${result.actScore}`);
}

// ═══════════════════════════════════════════════════════
// v0.6: Token Economy Commands
// ═══════════════════════════════════════════════════════

async function cmdTokenStats(agentId?: string) {
  const path = agentId ? `/v06/token-stats?agentId=${agentId}` : '/v06/token-stats';
  const result = await gatewayFetch(path);

  if (agentId) {
    const s = result.stats;
    if (!s) { console.log(`No data for agent: ${agentId}`); return; }
    const savingsPct = s.totalRawOut > 0 ? ((s.totalSaved / s.totalRawOut) * 100).toFixed(1) : '0.0';
    console.log(`📊 Token Economy — ${agentId}:\n`);
    console.log(`  Requests:      ${s.requestCount}`);
    console.log(`  Raw input:     ${formatTokens(s.totalRawIn)}`);
    console.log(`  Raw output:    ${formatTokens(s.totalRawOut)}`);
    console.log(`  Filtered:      ${formatTokens(s.totalFiltered)}`);
    console.log(`  Saved:         ${formatTokens(s.totalSaved)} (${savingsPct}%)`);
    console.log(`  Filter hits:   ${s.filterHitCount}`);
  } else {
    const g = result.global;
    const savingsPct = g.rawOut > 0 ? ((g.saved / g.rawOut) * 100).toFixed(1) : '0.0';
    console.log('📊 Token Economy — Global:\n');
    console.log(`  Raw input:     ${formatTokens(g.rawIn)}`);
    console.log(`  Raw output:    ${formatTokens(g.rawOut)}`);
    console.log(`  Filtered:      ${formatTokens(g.filtered)}`);
    console.log(`  Saved:         ${formatTokens(g.saved)} (${savingsPct}%)`);
    console.log('\nPer-Agent:');
    console.log('Agent            Raw Out   Filtered  Saved     Savings%');
    console.log('──────────────── ───────── ───────── ───────── ────────');
    for (const [id, s] of Object.entries(result.agents || {})) {
      const a = s as any;
      const pct = a.totalRawOut > 0 ? ((a.totalSaved / a.totalRawOut) * 100).toFixed(1) : '0.0';
      console.log(`${id.padEnd(17)}${formatTokens(a.totalRawOut).padEnd(10)}${formatTokens(a.totalFiltered).padEnd(10)}${formatTokens(a.totalSaved).padEnd(10)}${pct}%`);
    }
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

async function cmdTokenStatsReset() {
  await gatewayFetch('/v06/token-stats/reset', 'POST');
  console.log('✅ Token economy stats reset');
}

// ═══════════════════════════════════════════════════════
// v0.6.2: Provider Health + Quota Commands
// ═══════════════════════════════════════════════════════

function getBaseUrl(): string {
  return process.env.GATESWARM_URL || 'http://localhost:8900';
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

async function cmdHealth(sub?: string, providerId?: string) {
  const baseUrl = getBaseUrl();
  try {
    const resp = await fetch(`${baseUrl}/health/providers`);
    const data = await resp.json() as any;
    console.log('\n🏥 GateSwarm Provider Health + Quota Status\n');
    console.log(`  Timestamp: ${new Date(data.timestamp).toLocaleString()}`);
    for (const p of data.providers) {
      const status = p.health.status;
      const icon = status === 'healthy' ? '✅' : status === 'cooldown' ? '🔒' : status === 'degraded' ? '⚠️' : '❓';
      console.log(`  ${icon} ${p.id.padEnd(18)} ${status.padEnd(10)} ${p.name}`);
      if (p.health.totalRequests > 0) {
        console.log(`     Requests: ${p.health.totalRequests} | Errors: ${p.health.totalErrors} | Consecutive: ${p.health.consecutiveErrors}`);
      }
      if (p.health.cooldownUntil && p.health.cooldownUntil > Date.now()) {
        console.log(`     Cooldown until: ${new Date(p.health.cooldownUntil).toLocaleString()} (${p.health.cooldownReason})`);
      }
      if (p.quota) {
        const q = p.quota;
        if (q.limit > 0) console.log(`     Quota: ${q.used}/${q.limit} used (${q.remaining} remaining)`);
        else if (q.isExhausted) console.log(`     Quota: EXHAUSTED (reset in ${formatDuration(q.resetInMs)})`);
      }
      if (p.usedBy) console.log(`     Tiers: ${p.usedBy.join(', ')}`);
      console.log('');
    }
  } catch (err: any) { console.error(`Failed to fetch health status: ${err.message}`); }
}

async function cmdQuota(providerId?: string) {
  const baseUrl = getBaseUrl();
  try {
    if (providerId) {
      console.log(`🔍 Probing ${providerId}...`);
      const resp = await fetch(`${baseUrl}/health/providers`);
      const data = await resp.json() as any;
      const p = data.providers.find((p: any) => p.id === providerId);
      if (p) {
        console.log(`\n  Provider: ${p.name} (${p.id})`);
        console.log(`  Health:   ${p.health.status}`);
        if (p.quota) {
          const q = p.quota;
          console.log(`  Quota:    ${q.limit > 0 ? `${q.used}/${q.limit}` : 'unlimited/unknown'}`);
          if (q.isExhausted) console.log(`  Status:   EXHAUSTED`);
          if (q.resetInMs > 0) console.log(`  Reset in: ${formatDuration(q.resetInMs)}`);
        }
        if (p.quota?.cliWindows) {
          console.log(`  CLI Quota:`);
          for (const [win, d] of Object.entries(p.quota.cliWindows)) {
            const w = d as any;
            console.log(`    ${win}: ${w.used}/${w.limit > 0 ? w.limit : '∞'} (resets in ${w.resetsIn})`);
          }
        }
      } else { console.log(`  Provider '${providerId}' not found`); }
    } else { await cmdHealth(); }
  } catch (err: any) { console.error(`Failed to fetch quota: ${err.message}`); }
}

async function cmdResetProvider(providerId: string) {
  const baseUrl = getBaseUrl();
  try {
    const resp = await fetch(`${baseUrl}/health/providers/reset/${providerId}`, { method: 'POST' });
    const data = await resp.json() as any;
    console.log(`✅ Reset ${providerId}: ${data.status || 'healthy'}`);
  } catch (err: any) { console.error(`Failed to reset: ${err.message}`); }
}

async function main() {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const command = args[0];

  switch (command) {
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

    // ─── v0.6: Effort Customization ───
    case 'effort-status':
      await cmdEffortStatus();
      break;
    case 'effort-set':
      if (args.length < 3) {
        console.error('Usage: gateswarm effort-set <agentId> <default> [ceiling] [bias]');
        process.exit(1);
      }
      await cmdEffortSet(args[1], args[2], args[3], args[4]);
      break;
    case 'effort-override':
      if (args.length < 3) {
        console.error('Usage: gateswarm effort-override <tier> "prompt"');
        process.exit(1);
      }
      await cmdEffortOverride(args[1], args.slice(2).join(' '));
      break;

    // ─── v0.6: Plan/Act Modes ───
    case 'mode-status':
      await cmdModeStatus();
      break;
    case 'mode-set':
      if (args.length < 4) {
        console.error('Usage: gateswarm mode-set <tier> <model> <provider> [max_tokens]');
        process.exit(1);
      }
      await cmdModeSet(args[1], args[2], args[3], args[4]);
      break;
    case 'mode':
      if (args.length < 2) {
        console.error('Usage: gateswarm mode "prompt to test"');
        process.exit(1);
      }
      await cmdModeDetect(args.slice(1).join(' '));
      break;

    // ─── v0.6: Token Economy ───
    case 'token-stats':
      if (args[1] === 'reset') {
        await cmdTokenStatsReset();
      } else {
        await cmdTokenStats(args[1]);
      }
      break;

    // ─── v0.6.2: Provider Health + Quota ───
    case 'health':
      await cmdHealth(args[1], args[2]);
      break;
    case 'quota':
      await cmdQuota(args[1]);
      break;
    case 'reset':
      if (args[1]) {
        await cmdResetProvider(args[1]);
      } else {
        console.log('Usage: gateswarm reset <providerId>');
      }
      break;


    default:
      console.error(`❌ Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(console.error);
