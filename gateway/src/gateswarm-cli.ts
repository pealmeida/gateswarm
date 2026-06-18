#!/usr/bin/env npx tsx
/**
 * GateSwarm MoA Router v0.4 — CLI
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
🧠 GateSwarm MoA Router v0.4 — CLI

Commands:
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

Tiers: trivial, light, moderate, heavy, intensive, extreme
Providers: zai, bailian, openrouter

Examples:
  gateswarm model intensive qwen3.6-plus bailian
  gateswarm reasoning extreme on
  gateswarm retrain-freq 200
  gateswarm weights heuristic 0.35
  gateswarm training                        Show training status
  gateswarm training jack on                Enable training for jack agent
  gateswarm training labels jack            Show gold labels for jack
`);
}

async function cmdStatus() {
  const config = await loadConfig();
  const interactionCount = getInteractionCount();
  const accuracy = getTierAccuracy();
  const ragStats = getRagStats();

  console.log('🧠 GateSwarm MoA Router v0.4 — Status\n');
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

// ─── Main ─────────────────────────────────────────────────

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
    case 'training':
      await cmdTraining(args[1], args[2]);
      break;
    default:
      console.error(`❌ Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(console.error);
