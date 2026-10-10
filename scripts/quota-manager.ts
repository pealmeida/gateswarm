/**
 * Quota manager CLI.
 *   quota-manager status [--json]
 *   quota-manager tick                          one collection cycle (used by the supervisor)
 *   quota-manager survey [--no-jev]             collect all + recompute + quota-analyze (Jev advise) + calibration
 *   quota-manager battery start <name> [--need p1,p2] [--requests claude-cli=40,zai=200] [--strict] [--force]
 *   quota-manager battery end
 *   quota-manager battery status
 *   quota-manager calibration
 * No secrets are read or printed; the collector inherits the environment (e.g. Z_AI_API_KEY) without echoing it.
 */
import { analyzeQuota, loadAnalysisInput } from '../src/jev/quota-analysis.js';
import { batteryEnd, batteryStart, activeBattery, getManagerView, loadConfig, paths, pythonCollector, readCalibration, snapshot, survey, tick, DEFAULT_ROOT, type Deps, type AnalysisSummary } from '../src/quota-manager/index.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const root = DEFAULT_ROOT;
const p = paths(root);
const cfg = loadConfig();

async function analyze(): Promise<AnalysisSummary | null> {
  const input = await loadAnalysisInput({ now: Date.now() });
  if (!input) return null;
  const env = flag('--no-jev') ? { ...process.env, GATESWARM_JEV_DECISIONS: 'off' } : process.env;
  const r = await analyzeQuota(input, { env });
  return { generatedAt: r.generatedAt, mode: r.mode, jevCalls: r.jev.calls, movesLocal: r.movesLocal.length, movesJev: r.movesJev.length, diffJev: r.diffJev,
    providers: r.providers.map((x) => ({ provider: x.provider, band: x.band, stance: x.stance, localStance: x.localStance, jevStance: x.jevStance, headroom: x.headroom })) };
}
async function tiersOf(provider: string): Promise<string[]> {
  const input = await loadAnalysisInput({ now: Date.now() });
  return Object.entries(input?.tierModels ?? {}).filter(([, v]) => v.provider === provider).map(([k]) => k);
}
const deps: Deps = { now: () => Date.now(), collect: pythonCollector(root), analyze, tiersOf };
const parseReq = (s?: string) => Object.fromEntries((s ?? '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, Number(v)]; }).filter(([, v]) => Number.isFinite(v)));
const fmt = (n: number | null) => (n === null ? ' n/a' : String(n).padStart(5));

function printStates(states: Awaited<ReturnType<typeof getManagerView>>['providers']) {
  console.log('provider     band     conf       used%  headroom  resets-in  method');
  for (const s of states) {
    const w = s.windows.find((x) => x.name === s.limitingWindow) ?? s.windows[0];
    console.log(`${s.provider.padEnd(12)} ${s.band.padEnd(8)} ${s.confidence.padEnd(10)} ${fmt(s.maxUsedPct)}  ${fmt(s.headroomPct)}     ${String(w?.minutesToReset ?? 'n/a').padStart(6)}m   ${s.method}${s.willExhaustBeforeReset ? '  ⚠ exhausts before reset' : ''}`);
  }
}

const [cmd, sub] = args;
if (cmd === 'status') {
  const v = await getManagerView(p, Date.now(), cfg);
  if (flag('--json')) console.log(JSON.stringify(v, null, 2)); else { printStates(v.providers); console.log(v.battery ? `battery active: ${v.battery.name}` : 'no active battery'); v.alerts.forEach((a) => console.log(`alert: ${a}`)); }
} else if (cmd === 'tick') {
  const r = await tick(p, deps, cfg);
  console.log(r.skipped ? `skipped: ${r.skipped}` : `collected: ${r.collected.join(',')}`);
} else if (cmd === 'survey') {
  const st = await survey(p, deps, cfg);
  printStates(st.providers);
  if (st.lastSurvey?.analysis) { const a = st.lastSurvey.analysis; console.log(`analysis: mode=${a.mode} jevCalls=${a.jevCalls} moves(local/jev)=${a.movesLocal}/${a.movesJev}`); }
  Object.entries(st.missing).forEach(([k, v]) => console.log(`missing[${k}]: ${v.join('; ')}`));
} else if (cmd === 'battery' && sub === 'start') {
  const name = args[2];
  if (!name || name.startsWith('--')) { console.error('usage: battery start <name>'); process.exit(2); }
  const r = await batteryStart(p, deps, cfg, { name, need: val('--need')?.split(','), plannedRequests: parseReq(val('--requests')), strict: flag('--strict'), force: flag('--force') });
  printStates(r.states);
  r.precheck.warnings.forEach((w) => console.log(`[${w.level}] ${w.message}`));
  r.precheck.proposals.forEach((x) => console.log(`proposal: ${x}`));
  console.log(r.started ? `battery "${name}" started (collection every ${cfg.batteryIntervalSec}s via the supervisor)` : `NOT started: ${r.reason}`);
  process.exit(r.started ? 0 : 3);
} else if (cmd === 'battery' && sub === 'end') {
  const r = await batteryEnd(p, deps, cfg);
  if (!r) { console.error('no active battery'); process.exit(4); }
  console.log(`report: ${r.files.md}\ncalibration records added: ${r.calibrationAdded}`);
  for (const x of r.report.providers) console.log(`${x.provider.padEnd(12)} ${x.confidence.padEnd(9)} req=${x.requests} Δ=${x.windows.map((w) => `${w.window}:${w.windowReset ? 'reset' : w.deltaPct ?? 'n/a'}`).join(' ')} headroom=${x.endHeadroomPct ?? 'n/a'} left≈${x.batteriesLeft ?? 'n/a'}`);
} else if (cmd === 'battery' && sub === 'status') {
  const b = await activeBattery(p);
  console.log(b ? JSON.stringify({ name: b.name, startedAt: b.startedAt, samples: b.samples.length, need: b.need }) : 'no active battery');
} else if (cmd === 'calibration') {
  const c = await readCalibration(p);
  console.log(JSON.stringify(c.slice(-(Number(val('--last')) || 20)), null, 2));
} else if (cmd === 'collect') {
  printStates(await snapshot(p, deps, cfg, val('--only')?.split(',')));
} else { console.error('usage: quota-manager status|tick|survey|collect|battery start <name>|battery end|battery status|calibration'); process.exit(2); }
