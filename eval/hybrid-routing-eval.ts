/**
 * Hybrid routing eval orchestrator — Phases 1–3 (offline score, ablation, live spot-check).
 *
 * Run: npx tsx eval/hybrid-routing-eval.ts [--port 8900] [--seed 42] [--out …]
 * Do not run the full live eval unless the gateway is up (Task 6).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EffortLevel } from '../src/types.js';
import { loadEffort, TIERS, tierIdx } from './lib/dataset.js';
import type { EffortExample } from './lib/dataset.js';
import { effortMetrics, pct } from './lib/metrics.js';
import type { EffortMetrics } from './lib/metrics.js';
import { samplePerTier } from './lib/hybrid-sample.js';
import { healthOrThrow, postScore, postChatAuto, judgeAdequacy } from './lib/hybrid-http.js';
import { loadEvalRuntimeConfig, rubricPassFloor } from './lib/hybrid-eval-helpers.js';
import type { ScoreResp } from './lib/hybrid-http.js';
import { rubricHardFail } from './lib/hybrid-rubric.js';
import {
  markProviderUnhealthy,
  providerFromRouted,
  providerSkipReason,
  rowsForLiveScoring,
  summarizeSkippedRows,
} from './lib/hybrid-live.js';
import { runAblation } from './lib/hybrid-ablation.js';
import type { AblationMode } from './lib/hybrid-ablation.js';
import { selectWarmAblationExamples } from './lib/hybrid-warm-fixtures.js';

const DEFAULT_TIMEOUT_FAST_MS = 120_000;
const DEFAULT_TIMEOUT_SLOW_MS = 180_000;

const FLOORS = {
  exact: 0.48,
  adjacent: 0.75,
  recall: 0.4,
  rubricPass: 25,
  rubricTotal: 30,
  judgeOverall: 3.5,
  judgePerTier: 3.0,
  judgeDegradedFrac: 0.2,
} as const;

const FREE_PROVIDERS = new Set(['opencode-free', 'zai']);

type CriticalProbe =
  | { prompt: string; minTier: EffortLevel; expect?: undefined }
  | { prompt: string; expect: EffortLevel; minTier?: undefined };

const CRITICAL: CriticalProbe[] = [
  { prompt: 'Explain async/await', minTier: 'light' },
  { prompt: 'hi', expect: 'trivial' },
  { prompt: 'hey, good morning', expect: 'trivial' },
];

interface ScoreRow {
  id: string;
  goldTier: EffortLevel;
  predTier: EffortLevel;
  score: number;
  confidence: number;
  selected?: { provider: string; model: string };
  latencyMs: number;
}

interface CriticalProbeResult {
  prompt: string;
  predTier: string;
  pass: boolean;
  detail: string;
}

interface LiveRow {
  id: string;
  goldTier: EffortLevel;
  prompt: string;
  status: number;
  headers: Record<string, string>;
  content: string;
  reasoning: string;
  rubricFail: boolean;
  rubricReasons: string[];
  judge: { adequacy: number; on_tier: boolean; reason: string; available: boolean };
  policyViolation: boolean;
  routedModel: string;
  skipped?: boolean;
  elapsedMs: number;
  reason?: string;
}

type AblationTable = Record<AblationMode, EffortMetrics>;
interface AblationReport {
  n: number;
  cold: AblationTable;
  warm?: AblationTable;
  warmInvalidReason?: string;
}

interface Args {
  port: number;
  seed: number;
  outDir: string;
  liveN: number;
  timeoutFastMs: number;
  timeoutSlowMs: number;
  help: boolean;
}

interface TimeoutBudgets {
  fastMs: number;
  slowMs: number;
}

function usage(): string {
  return `Usage: npx tsx eval/hybrid-routing-eval.ts [options]

Options:
  --port <n>     Gateway port (default: 8900)
  --seed <n>     Stratified sample seed (default: 42)
  --out <dir>    Output directory (default: eval/reports/routing-hybrid-<YYYYMMDD-HHMM>)
  --live-n <n>   Live samples per tier (default: 10)
  --timeout-fast <ms>  Timeout for trivial/light/moderate/heavy chats (default: 120000)
  --timeout-slow <ms>  Timeout for intensive/extreme chats (default: 180000)
  --help         Show this help and exit
`;
}

function defaultOutDir(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `eval/reports/routing-hybrid-${stamp}`;
}

function parsePositiveNumber(raw: string | undefined, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${flag}`);
  return n;
}

function parseArgs(argv: string[]): Args {
  let port = 8900;
  let seed = 42;
  let outDir = defaultOutDir();
  let liveN = 10;
  let timeoutFastMs = DEFAULT_TIMEOUT_FAST_MS;
  let timeoutSlowMs = DEFAULT_TIMEOUT_SLOW_MS;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--port') {
      port = parsePositiveNumber(argv[++i], '--port');
    } else if (a === '--seed') {
      seed = Number(argv[++i]);
      if (!Number.isFinite(seed)) throw new Error(`invalid --seed`);
    } else if (a === '--out') {
      outDir = argv[++i];
      if (!outDir) throw new Error(`missing --out value`);
    } else if (a === '--live-n') {
      liveN = parsePositiveNumber(argv[++i], '--live-n');
    } else if (a === '--timeout-fast') {
      timeoutFastMs = parsePositiveNumber(argv[++i], '--timeout-fast');
    } else if (a === '--timeout-slow') {
      timeoutSlowMs = parsePositiveNumber(argv[++i], '--timeout-slow');
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return { port, seed, outDir, liveN, timeoutFastMs, timeoutSlowMs, help };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asEffort(t: string): EffortLevel {
  if ((TIERS as string[]).includes(t)) return t as EffortLevel;
  return 'moderate';
}

function offlineFloorsMet(m: EffortMetrics): { ok: boolean; fails: string[] } {
  const fails: string[] = [];
  if (m.exact < FLOORS.exact) fails.push(`exact ${pct(m.exact)} < ${pct(FLOORS.exact)}`);
  if (m.adjacent < FLOORS.adjacent) fails.push(`adjacent ${pct(m.adjacent)} < ${pct(FLOORS.adjacent)}`);
  for (const t of TIERS) {
    const r = m.recall[t];
    if (!isNaN(r) && r < FLOORS.recall) fails.push(`recall[${t}] ${pct(r)} < ${pct(FLOORS.recall)}`);
  }
  return { ok: fails.length === 0, fails };
}

function compactConfusion(confusion: EffortMetrics['confusion']): string {
  const short = (t: string) => t.slice(0, 4);
  const head = ['exp\\pred', ...TIERS.map(short)].map((s, i) => (i === 0 ? s.padEnd(10) : s.padStart(5))).join('');
  const lines = [head];
  for (const exp of TIERS) {
    const cells = TIERS.map((p) => String(confusion[exp]?.[p] ?? 0).padStart(5)).join('');
    lines.push(exp.padEnd(10) + cells);
  }
  return lines.join('\n');
}

function routedProviderModel(routedModel: string): { provider: string; model: string } {
  const routed = routedModel.trim();
  if (!routed) return { provider: '(none)', model: '(none)' };
  const slash = routed.indexOf('/');
  if (slash > 0) {
    return {
      provider: routed.slice(0, slash),
      model: routed.slice(slash + 1) || '(none)',
    };
  }
  return {
    provider: providerFromRouted(routed) || '(unknown)',
    model: routed,
  };
}

function routedCountsByTier(live: LiveRow[]): Array<{ tier: EffortLevel; provider: string; model: string; count: number }> {
  const counts = new Map<string, { tier: EffortLevel; provider: string; model: string; count: number }>();
  for (const row of live) {
    const routed = routedProviderModel(row.routedModel);
    const key = `${row.goldTier}\t${routed.provider}\t${routed.model}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { tier: row.goldTier, provider: routed.provider, model: routed.model, count: 1 });
    }
  }
  return Array.from(counts.values()).sort(
    (a, b) =>
      tierIdx(a.tier) - tierIdx(b.tier) ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );
}

function judgeUnavailable5xx(judge: LiveRow['judge']): boolean {
  if (judge.available) return false;
  const reason = judge.reason.toLowerCase();
  return /\b5\d\d\b/.test(reason) || reason.includes('server error') || reason.includes('bad gateway') || reason.includes('service unavailable') || reason.includes('gateway timeout');
}

function writeSummary(opts: {
  outDir: string;
  metrics: EffortMetrics;
  offline: { ok: boolean; fails: string[] };
  probes: CriticalProbeResult[];
  ablation: AblationReport;
  live: LiveRow[];
  worst: ScoreRow[];
  judgeProvider: string;
}): string {
  const { metrics, offline, probes, ablation, live, worst, judgeProvider } = opts;
  const scoredLive = rowsForLiveScoring(live);
  const skippedSummary = summarizeSkippedRows(live);
  const rubricPass = scoredLive.filter((r) => !r.rubricFail).length;
  const judgeAvail = scoredLive.filter((r) => r.judge.available);
  const judgeMean =
    judgeAvail.length > 0
      ? judgeAvail.reduce((s, r) => s + r.judge.adequacy, 0) / judgeAvail.length
      : NaN;
  const judgeByTier: Record<string, number> = {};
  for (const t of TIERS) {
    const rows = judgeAvail.filter((r) => r.goldTier === t);
    judgeByTier[t] =
      rows.length > 0 ? rows.reduce((s, r) => s + r.judge.adequacy, 0) / rows.length : NaN;
  }
  const unavailableFrac = scoredLive.length ? (scoredLive.length - judgeAvail.length) / scoredLive.length : 0;
  const skippedCount = live.length - scoredLive.length;
  const rubricFloor = rubricPassFloor(scoredLive.length);
  const judge5xxCount = scoredLive.filter((r) => judgeUnavailable5xx(r.judge)).length;
  const judge5xxFrac = scoredLive.length ? judge5xxCount / scoredLive.length : 0;
  const modes: AblationMode[] = ['heuristic', 'heuristic+rag', 'heuristic+history', 'full'];
  const routedCounts = routedCountsByTier(live);

  const pushAblationTable = (lines: string[], table: AblationTable): void => {
    lines.push(`| Mode | Exact | Adjacent |`);
    lines.push(`|------|-------|----------|`);
    for (const mode of modes) {
      const m = table[mode];
      lines.push(`| ${mode} | ${pct(m.exact)} | ${pct(m.adjacent)} |`);
    }
  };

  const lines: string[] = [];
  lines.push(`# Hybrid routing eval summary`);
  lines.push('');
  lines.push(`Output: \`${opts.outDir}\``);
  lines.push('');
  lines.push(`## Offline score (n=${metrics.n})`);
  lines.push('');
  lines.push(`| Metric | Actual | Floor | Status |`);
  lines.push(`|--------|--------|-------|--------|`);
  lines.push(
    `| Exact | ${pct(metrics.exact)} | ${pct(FLOORS.exact)} | ${metrics.exact >= FLOORS.exact ? 'PASS' : 'FAIL'} |`,
  );
  lines.push(
    `| Adjacent | ${pct(metrics.adjacent)} | ${pct(FLOORS.adjacent)} | ${metrics.adjacent >= FLOORS.adjacent ? 'PASS' : 'FAIL'} |`,
  );
  lines.push('');
  lines.push(`### Per-tier recall (floor ${pct(FLOORS.recall)})`);
  lines.push('');
  lines.push(`| Tier | Recall | Status |`);
  lines.push(`|------|--------|--------|`);
  for (const t of TIERS) {
    const r = metrics.recall[t];
    const ok = !isNaN(r) && r >= FLOORS.recall;
    lines.push(`| ${t} | ${pct(r)} | ${ok ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push(`### Confusion matrix`);
  lines.push('');
  lines.push('```');
  lines.push(compactConfusion(metrics.confusion));
  lines.push('```');
  lines.push('');
  lines.push(`Offline floors: **${offline.ok ? 'MET' : 'NOT MET'}**`);
  if (!offline.ok) {
    for (const f of offline.fails) lines.push(`- ${f}`);
  }
  lines.push('');
  lines.push(`## Ablation (n=${ablation.n})`);
  lines.push('');
  lines.push(`### Cold stores`);
  lines.push('');
  pushAblationTable(lines, ablation.cold);
  lines.push('');
  if (ablation.warm) {
    lines.push(`### Warm stores`);
    lines.push('');
    pushAblationTable(lines, ablation.warm);
    lines.push('');
  } else {
    lines.push(
      `ABLATION_INVALID (cold stores): ${ablation.warmInvalidReason ?? 'warm-store seeding failed'}.`,
    );
    lines.push('');
    lines.push(
      `> **Cold-store caveat:** With no warm RAG store and empty feedback history, \`heuristic+rag\`, \`heuristic+history\`, and \`full\` may be numerically identical to (or barely different from) heuristic-only. Treat ablation deltas as informative only when stores are warm.`,
    );
    lines.push('');
  }
  lines.push(`## Live spot-check (n=${scoredLive.length}, skipped=${skippedCount}, sampled=${live.length})`);
  lines.push('');
  lines.push(
    `| Rubric pass | ${rubricPass}/${scoredLive.length} | floor ${rubricFloor}/${scoredLive.length} | ${rubricPass >= rubricFloor ? 'PASS' : 'FAIL'} |`,
  );
  lines.push(
    `| Judge mean overall | ${isNaN(judgeMean) ? 'n/a' : judgeMean.toFixed(2)} | floor ${FLOORS.judgeOverall} | ${!isNaN(judgeMean) && judgeMean >= FLOORS.judgeOverall ? 'PASS' : 'n/a or FAIL'} |`,
  );
  lines.push('');
  lines.push(`### Judge mean per tier (floor ${FLOORS.judgePerTier})`);
  lines.push('');
  lines.push(`| Tier | Mean adequacy | n | Status |`);
  lines.push(`|------|---------------|---|--------|`);
  for (const t of TIERS) {
    const m = judgeByTier[t];
    const n = judgeAvail.filter((r) => r.goldTier === t).length;
    const status = isNaN(m) ? 'n/a' : m >= FLOORS.judgePerTier ? 'PASS' : 'FAIL';
    lines.push(`| ${t} | ${isNaN(m) ? 'n/a' : m.toFixed(2)} | ${n} | ${status} |`);
  }
  lines.push('');
  lines.push(`### Routed provider/model counts`);
  lines.push('');
  if (!routedCounts.length) {
    lines.push('_None._');
  } else {
    lines.push(`| Tier | Provider | Model | Count |`);
    lines.push(`|------|----------|-------|-------|`);
    for (const r of routedCounts) {
      lines.push(`| ${r.tier} | ${r.provider} | ${r.model} | ${r.count} |`);
    }
  }
  lines.push('');
  lines.push(`### Skipped (infra)`);
  lines.push('');
  if (!skippedSummary.length) {
    lines.push('_None._');
  } else {
    lines.push(`| Provider | Reason | Count |`);
    lines.push(`|----------|--------|-------|`);
    for (const s of skippedSummary) {
      lines.push(`| ${s.provider} | ${s.reason} | ${s.count} |`);
    }
    lines.push('');
    lines.push(`Skipped rows are excluded from rubric and judge denominators.`);
  }
  if (unavailableFrac > FLOORS.judgeDegradedFrac) {
    lines.push('');
    lines.push(
      `JUDGE_DEGRADED: judge unavailable on ${(100 * unavailableFrac).toFixed(0)}% of live rows (>${100 * FLOORS.judgeDegradedFrac}%).`,
    );
  }
  if (judge5xxFrac > 0.5) {
    lines.push('');
    lines.push(
      `JUDGE_DOWN: ${judgeProvider} judge returned 5xx on ${(100 * judge5xxFrac).toFixed(0)}% of live rows.`,
    );
  }
  const policyHits = live.filter((r) => r.policyViolation);
  if (policyHits.length) {
    lines.push('');
    lines.push(`Soft policy violations (trivial/light → non-free provider): ${policyHits.length}`);
    for (const r of policyHits) {
      lines.push(`- ${r.id}: routed \`${r.routedModel || '(none)'}\``);
    }
  }
  lines.push('');
  lines.push(`## Critical probes`);
  lines.push('');
  for (const p of probes) {
    lines.push(`- ${p.pass ? 'PASS' : 'FAIL'}: \`${p.prompt}\` → ${p.predTier} (${p.detail})`);
  }
  lines.push('');
  lines.push(`## Worst misroutes (|Δtier| ≥ 2)`);
  lines.push('');
  if (!worst.length) {
    lines.push('_None._');
  } else {
    lines.push(`| id | gold | pred | Δ | score |`);
    lines.push(`|----|------|------|---|-------|`);
    for (const w of worst) {
      const d = tierIdx(w.predTier) - tierIdx(w.goldTier);
      lines.push(`| ${w.id} | ${w.goldTier} | ${w.predTier} | ${d >= 0 ? '+' : ''}${d} | ${w.score.toFixed(3)} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function runCriticalProbes(port: number): Promise<CriticalProbeResult[]> {
  const out: CriticalProbeResult[] = [];
  for (const c of CRITICAL) {
    const r = await postScore(port, c.prompt);
    const pred = asEffort(r.tier);
    if (c.minTier) {
      const pass = tierIdx(pred) >= tierIdx(c.minTier);
      out.push({
        prompt: c.prompt,
        predTier: pred,
        pass,
        detail: `minTier=${c.minTier}`,
      });
    } else {
      const pass = pred === c.expect;
      out.push({
        prompt: c.prompt,
        predTier: pred,
        pass,
        detail: `expect=${c.expect}`,
      });
    }
  }
  return out;
}

function chatTimeoutMs(tier: EffortLevel, budgets: TimeoutBudgets): number {
  return tier === 'intensive' || tier === 'extreme' ? budgets.slowMs : budgets.fastMs;
}

async function postChatWithRetry(
  port: number,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof postChatAuto>>> {
  let res = await postChatAuto(port, prompt, maxTokens, timeoutMs);
  if (res.status === 429) {
    await sleep(5000);
    res = await postChatAuto(port, prompt, maxTokens, timeoutMs);
  }
  return res;
}

async function judgeAdequacyWithRetry(
  port: number,
  prompt: string,
  answer: string,
  tier: EffortLevel,
): Promise<LiveRow['judge']> {
  const once = async (): Promise<LiveRow['judge']> => {
    try {
      return await judgeAdequacy(port, prompt, answer, tier);
    } catch (e) {
      return {
        adequacy: 0,
        on_tier: false,
        reason: e instanceof Error ? e.message : String(e),
        available: false,
      };
    }
  };

  const first = await once();
  if (first.available) return first;
  await sleep(3000);
  return once();
}

async function phase1(
  port: number,
  all: EffortExample[],
): Promise<{ rows: ScoreRow[]; metrics: EffortMetrics; probes: CriticalProbeResult[] }> {
  const rows: ScoreRow[] = [];
  for (const ex of all) {
    const r: ScoreResp = await postScore(port, ex.prompt);
    rows.push({
      id: ex.id,
      goldTier: ex.tier,
      predTier: asEffort(r.tier),
      score: r.score,
      confidence: r.confidence,
      selected: r.selected,
      latencyMs: r.latencyMs ?? 0,
    });
  }
  const metrics = effortMetrics(rows.map((r) => ({ expected: r.goldTier, predicted: r.predTier })));
  const probes = await runCriticalProbes(port);
  return { rows, metrics, probes };
}

async function phase3(
  port: number,
  sample: EffortExample[],
  opts: { maxTokens: Record<EffortLevel, number>; timeouts: TimeoutBudgets },
): Promise<LiveRow[]> {
  const live: LiveRow[] = [];
  const unhealthyProviders = new Map<string, string>();
  for (let i = 0; i < sample.length; i++) {
    const startedAt = Date.now();
    const ex = sample[i];
    try {
      const maxTokens = opts.maxTokens[ex.tier];
      const timeoutMs = chatTimeoutMs(ex.tier, opts.timeouts);
      const chat = await postChatWithRetry(port, ex.prompt, maxTokens, timeoutMs);
      const routedModel = chat.headers['x-routed-model'] || chat.headers['X-Routed-Model'] || '';
      const provider = providerFromRouted(routedModel);
      const softTier = ex.tier === 'trivial' || ex.tier === 'light';
      const policyViolation = softTier && Boolean(provider) && !FREE_PROVIDERS.has(provider);
      const skipReason = providerSkipReason(unhealthyProviders, routedModel);
      const timedOut = Boolean(chat.timedOut) || chat.status === 0;

      if (skipReason) {
        live.push({
          id: ex.id,
          goldTier: ex.tier,
          prompt: ex.prompt,
          status: timedOut ? 0 : chat.status,
          headers: chat.headers,
          content: '',
          reasoning: '',
          rubricFail: false,
          rubricReasons: [],
          judge: { adequacy: 0, on_tier: false, reason: skipReason, available: false },
          policyViolation,
          routedModel,
          skipped: true,
          elapsedMs: Date.now() - startedAt,
          reason: skipReason,
        });
        if (i < sample.length - 1) await sleep(500);
        continue;
      }

      const rubric = rubricHardFail(
        timedOut
          ? { status: 0, content: '', reasoning: '', timedOut: true }
          : {
              status: chat.status,
              content: chat.content,
              reasoning: chat.reasoning,
              timedOut: false,
            },
      );
      const answer = chat.content || chat.reasoning;
      if (rubric.reasons.includes('provider_error')) {
        markProviderUnhealthy(unhealthyProviders, routedModel, 'provider_error');
      }
      const judge =
        timedOut || chat.status === 0
          ? { adequacy: 0, on_tier: false, reason: 'chat_timeout', available: false }
          : rubric.fail
            ? { adequacy: 0, on_tier: false, reason: rubric.reasons[0] || 'rubric_hard_fail', available: false }
          : await judgeAdequacyWithRetry(port, ex.prompt, answer, ex.tier);

      live.push({
        id: ex.id,
        goldTier: ex.tier,
        prompt: ex.prompt,
        status: timedOut ? 0 : chat.status,
        headers: chat.headers,
        content: timedOut ? '' : chat.content,
        reasoning: timedOut ? '' : chat.reasoning,
        rubricFail: rubric.fail,
        rubricReasons: rubric.reasons,
        judge,
        policyViolation,
        routedModel,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Phase 3 item ${ex.id} failed (continuing): ${message}`);
      const rubric = rubricHardFail({ status: 0, content: '', reasoning: '', timedOut: true });
      live.push({
        id: ex.id,
        goldTier: ex.tier,
        prompt: ex.prompt,
        status: 0,
        headers: {},
        content: '',
        reasoning: '',
        rubricFail: rubric.fail,
        rubricReasons: rubric.reasons,
        judge: { adequacy: 0, on_tier: false, reason: message.slice(0, 200), available: false },
        policyViolation: false,
        routedModel: '',
        elapsedMs: Date.now() - startedAt,
        skipped: false,
        reason: undefined,
      });
    }

    if (i < sample.length - 1) await sleep(500);
  }
  return live;
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    console.error(usage());
    process.exit(1);
    return;
  }

  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
    return;
  }

  const { port, seed, outDir, liveN, timeoutFastMs, timeoutSlowMs } = args;
  const runtime = loadEvalRuntimeConfig();

  try {
    await healthOrThrow(port);
  } catch (e) {
    console.error(`Gateway unreachable on port ${port}: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  console.log(`Out: ${outDir}`);
  console.log(`Runtime config: ${runtime.configPath ?? 'defaults'}; judge=${runtime.judgeProvider}`);

  const all = loadEffort();
  console.log(`Phase 1 — Offline score (n=${all.length})…`);
  const { rows, metrics, probes } = await phase1(port, all);
  writeFileSync(
    join(outDir, 'scores.json'),
    JSON.stringify({ rows, metrics, criticalProbes: probes }, null, 2),
  );

  console.log(`Phase 2 — Ablation…`);
  const ablationExamples = selectWarmAblationExamples(all);
  const cold = runAblation(ablationExamples, { warm: false });
  const ablation: AblationReport = {
    n: ablationExamples.length,
    cold,
  };
  try {
    ablation.warm = runAblation(ablationExamples, { warm: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    ablation.warmInvalidReason = reason;
    console.error(`ABLATION_INVALID (cold stores): ${reason}`);
  }
  writeFileSync(join(outDir, 'ablation.json'), JSON.stringify(ablation, null, 2));

  console.log(`Phase 3 — Live spot-check (${liveN}×${TIERS.length}=${liveN * TIERS.length}, seed=${seed})…`);
  const sample = samplePerTier(all, liveN, seed);
  const live = await phase3(port, sample, {
    maxTokens: runtime.maxTokens,
    timeouts: { fastMs: timeoutFastMs, slowMs: timeoutSlowMs },
  });
  writeFileSync(
    join(outDir, 'live.json'),
    JSON.stringify(
      { seed, liveN, maxTokens: runtime.maxTokens, timeouts: { fastMs: timeoutFastMs, slowMs: timeoutSlowMs }, rows: live },
      null,
      2,
    ),
  );

  const worst = rows
    .filter((r) => Math.abs(tierIdx(r.predTier) - tierIdx(r.goldTier)) >= 2)
    .sort(
      (a, b) =>
        Math.abs(tierIdx(b.predTier) - tierIdx(b.goldTier)) -
        Math.abs(tierIdx(a.predTier) - tierIdx(a.goldTier)),
    );

  const offline = offlineFloorsMet(metrics);
  const summary = writeSummary({ outDir, metrics, offline, probes, ablation, live, worst, judgeProvider: runtime.judgeProvider });
  writeFileSync(join(outDir, 'summary.md'), summary);

  const scoredLive = rowsForLiveScoring(live);
  const rubricPass = scoredLive.filter((r) => !r.rubricFail).length;
  const rubricFloor = rubricPassFloor(scoredLive.length);
  const judgeAvail = scoredLive.filter((r) => r.judge.available).length;
  const unavailableFrac = scoredLive.length ? (scoredLive.length - judgeAvail) / scoredLive.length : 0;
  const judge5xxFrac = scoredLive.length
    ? scoredLive.filter((r) => judgeUnavailable5xx(r.judge)).length / scoredLive.length
    : 0;
  if (unavailableFrac > FLOORS.judgeDegradedFrac) {
    console.error('JUDGE_DEGRADED');
  }
  if (judge5xxFrac > 0.5) console.error(`JUDGE_DOWN: ${runtime.judgeProvider}`);

  console.log(`Offline exact=${pct(metrics.exact)} adjacent=${pct(metrics.adjacent)} floors=${offline.ok ? 'MET' : 'FAIL'}`);
  console.log(`Live rubric ${rubricPass}/${scoredLive.length} skipped=${live.length - scoredLive.length} (floor ${rubricFloor}/${scoredLive.length})`);
  console.log(`Wrote ${join(outDir, 'summary.md')}`);

  const exitOk = offline.ok && rubricPass >= rubricFloor;
  process.exit(exitOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
