/**
 * Quota manager — IO layer: collector invocation, state/battery/calibration files, battery lifecycle, survey, tick.
 * Files (all under <root>/data, no secrets, no account identifiers):
 *   quota-sync.json            written by scripts/quota-sync.py
 *   quota-manager-state.json   latest computed state (+ last analysis summary)
 *   quota-manager-battery.json active battery (absent when idle)
 *   quota-manager/reports/     battery reports (.json + .md)
 *   quota-calibration.jsonl    cost-in-% per request calibration history
 *   quota-manager.interval     seconds the supervisor should sleep before the next tick
 */
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeStates, precheck, estimateCostPerRequest, type CalibrationRecord, type PrecheckResult, type ProviderState, type SyncFile, type WindowName, type Confidence, parseTime, KNOWN_PROVIDERS, sameReset,
} from './core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = process.env.GATESWARM_ROOT ?? join(HERE, '..', '..');

export interface Paths { root: string; data: string; sync: string; state: string; battery: string; calibration: string; reports: string; interval: string; lock: string; history: string }
export function paths(root = DEFAULT_ROOT): Paths {
  const data = join(root, 'data');
  return { root, data, sync: join(data, 'quota-sync.json'), state: join(data, 'quota-manager-state.json'), battery: join(data, 'quota-manager-battery.json'), calibration: join(data, 'quota-calibration.jsonl'), reports: join(data, 'quota-manager', 'reports'), interval: join(data, 'quota-manager.interval'), lock: join(data, 'quota-manager.lock'), history: join(data, 'consumption-history.json') };
}

export interface ManagerConfig {
  maxAgeMin: number;
  idleIntervalSec: number;
  batteryIntervalSec: number;
  /** Claude collections cost quota: never collect it more often than this (min). */
  claudeMinIntervalMin: number;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ManagerConfig {
  const n = (k: string, d: number) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return { maxAgeMin: n('GATESWARM_QUOTA_MAX_AGE_MIN', 15), idleIntervalSec: n('GATESWARM_QUOTA_IDLE_INTERVAL_SEC', 600), batteryIntervalSec: n('GATESWARM_QUOTA_BATTERY_INTERVAL_SEC', 180), claudeMinIntervalMin: n('GATESWARM_QUOTA_CLAUDE_MIN_INTERVAL_MIN', 6) };
}

export interface Deps {
  now: () => number;
  /** runs the collector for the given providers (undefined = all) */
  collect: (only?: string[]) => Promise<void>;
  /** optional analysis hook (quota-analyze with Jev advise); returns a small summary */
  analyze?: () => Promise<AnalysisSummary | null>;
  /** tier names whose primary model is served by `provider` (for calibration labels) */
  tiersOf?: (provider: string) => Promise<string[]>;
}
export interface AnalysisSummary { generatedAt: string; mode: string; jevCalls: number; movesLocal: number; movesJev: number; providers: Array<{ provider: string; band: string; stance: string; localStance: string; jevStance: string | null; headroom: string }>; diffJev: string }

const readJson = async <T>(p: string): Promise<T | null> => { try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return null; } };
const writeJson = async (p: string, v: unknown) => { await fs.mkdir(dirname(p), { recursive: true }); const t = `${p}.${process.pid}.tmp`; await fs.writeFile(t, JSON.stringify(v, null, 2), 'utf8'); await fs.rename(t, p); };

export function pythonCollector(root: string, env: NodeJS.ProcessEnv = process.env): Deps['collect'] {
  return (only) => new Promise((resolve) => {
    const args = [join(root, 'scripts', 'quota-sync.py'), ...(only?.length ? ['--only', only.join(',')] : [])];
    const c = spawn(env.GATESWARM_PYTHON ?? 'python3', args, { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore'] });
    c.on('error', () => resolve());
    c.on('close', () => resolve()); // failures surface as stale/unknown data, never as 0
  });
}

// ─── calibration / totals ────────────────────────────────

export async function readCalibration(p: Paths): Promise<CalibrationRecord[]> {
  try { return (await fs.readFile(p.calibration, 'utf8')).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as CalibrationRecord]; } catch { return []; } }); } catch { return []; }
}
export interface Totals { [provider: string]: { requests: number; tokens: number; errors: number } }
export async function readTotals(p: Paths): Promise<Totals> {
  const h = await readJson<{ providers?: Record<string, { totalRequests?: number; totalTokensIn?: number; totalTokensOut?: number; totalErrors?: number }> }>(p.history);
  const out: Totals = {};
  for (const [k, v] of Object.entries(h?.providers ?? {})) out[k] = { requests: v.totalRequests ?? 0, tokens: (v.totalTokensIn ?? 0) + (v.totalTokensOut ?? 0), errors: v.totalErrors ?? 0 };
  return out;
}

export function buildCalibration(opts: { source: 'battery' | 'survey'; battery?: string; ts: string; before: ProviderState[]; after: ProviderState[]; totalsBefore: Totals; totalsAfter: Totals; tiersOf: Record<string, string[]> }): CalibrationRecord[] {
  const recs: CalibrationRecord[] = [];
  for (const a of opts.after) {
    const b = opts.before.find((x) => x.provider === a.provider);
    if (!b || a.confidence === 'unknown') continue;
    const requests = (opts.totalsAfter[a.provider]?.requests ?? 0) - (opts.totalsBefore[a.provider]?.requests ?? 0);
    const tokens = (opts.totalsAfter[a.provider]?.tokens ?? 0) - (opts.totalsBefore[a.provider]?.tokens ?? 0);
    if (requests <= 0) continue;
    for (const aw of a.windows) {
      const bw = b.windows.find((w) => w.name === aw.name);
      if (!bw || aw.usedPct === null || bw.usedPct === null) continue;
      if (!sameReset(aw.resetAt, bw.resetAt)) continue; // window rolled over: delta meaningless
      const d = Math.round((aw.usedPct - bw.usedPct) * 10) / 10;
      if (d < 0) continue;
      recs.push({ schema_version: 'quota-calibration.v1', ts: opts.ts, source: opts.source, battery: opts.battery, provider: a.provider, window: aw.name as WindowName, tiers: opts.tiersOf[a.provider] ?? [], requests, tokens, deltaPct: d, pctPerRequest: Math.round((d / requests) * 1000) / 1000, pctPer1kTokens: tokens > 0 ? Math.round((d / tokens) * 1e6) / 1000 : null, lowResolution: d < 2, confidence: a.confidence as Confidence });
    }
  }
  return recs;
}

async function appendCalibration(p: Paths, recs: CalibrationRecord[]) {
  if (!recs.length) return;
  await fs.mkdir(p.data, { recursive: true });
  await fs.appendFile(p.calibration, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

async function tiersMap(deps: Deps): Promise<Record<string, string[]>> {
  const m: Record<string, string[]> = {};
  if (deps.tiersOf) for (const k of KNOWN_PROVIDERS) m[k] = await deps.tiersOf(k).catch(() => []);
  return m;
}

// ─── state ───────────────────────────────────────────────

export interface BatteryFile {
  name: string; startedAt: string; need: string[]; plannedRequests: Record<string, number>; intervalSec: number;
  before: ProviderState[]; totalsBefore: Totals; precheck: PrecheckResult;
  samples: Array<{ at: string; providers: Record<string, { band: string; maxUsedPct: number | null; confidence: string }> }>;
}
export interface ManagerStateFile {
  schema_version: 'quota-manager.v1'; updatedAt: string; providers: ProviderState[];
  battery: { name: string; startedAt: string } | null;
  lastSurvey: { at: string; analysis: AnalysisSummary | null } | null;
  baseline: { at: string; states: ProviderState[]; totals: Totals } | null;
  alerts: string[]; missing: Record<string, string[]>;
  calibrationSummary: Record<string, Record<string, { pctPerRequest: number; samples: number; requests: number }>>;
}

const DEFAULT_NEED = ['claude-cli', 'codex-cli', 'zai', 'bailian'];

function alertsOf(states: ProviderState[]): string[] {
  const a: string[] = [];
  for (const s of states) {
    if (s.band === 'red') a.push(`${s.provider} RED (${s.maxUsedPct}% ${s.limitingWindow})`);
    else if (s.band === 'orange') a.push(`${s.provider} ORANGE (${s.maxUsedPct}% ${s.limitingWindow})`);
    if (s.willExhaustBeforeReset) a.push(`${s.provider} projected to exhaust before reset`);
    if (s.confidence === 'unknown') a.push(`${s.provider} not measured`);
  }
  return a;
}
function calSummary(cal: CalibrationRecord[]): ManagerStateFile['calibrationSummary'] {
  const out: ManagerStateFile['calibrationSummary'] = {};
  for (const p of KNOWN_PROVIDERS) for (const w of ['5h', '7d', '30d'] as WindowName[]) { const e = estimateCostPerRequest(cal, p, w); if (e) (out[p] ??= {})[w] = e; }
  return out;
}

export async function readSync(p: Paths): Promise<SyncFile | null> { return readJson<SyncFile>(p.sync); }
export async function activeBattery(p: Paths): Promise<BatteryFile | null> { return readJson<BatteryFile>(p.battery); }

async function writeState(p: Paths, deps: Deps, cfg: ManagerConfig, states: ProviderState[], patch: Partial<ManagerStateFile> = {}): Promise<ManagerStateFile> {
  const prev = await readJson<ManagerStateFile>(p.state);
  const bat = await activeBattery(p);
  const cal = await readCalibration(p);
  const st: ManagerStateFile = {
    schema_version: 'quota-manager.v1', updatedAt: new Date(deps.now()).toISOString(), providers: states,
    battery: bat ? { name: bat.name, startedAt: bat.startedAt } : null,
    lastSurvey: prev?.lastSurvey ?? null, baseline: prev?.baseline ?? null,
    alerts: alertsOf(states), missing: Object.fromEntries(states.filter((s) => s.missing.length).map((s) => [s.provider, s.missing])),
    calibrationSummary: calSummary(cal), ...patch,
  };
  await writeJson(p.state, st);
  await fs.writeFile(p.interval, String(bat ? cfg.batteryIntervalSec : cfg.idleIntervalSec), 'utf8');
  return st;
}

export async function snapshot(p: Paths, deps: Deps, cfg: ManagerConfig, only?: string[]): Promise<ProviderState[]> {
  await deps.collect(only);
  return computeStates(await readSync(p), deps.now(), { maxAgeMin: cfg.maxAgeMin });
}

/** Live view (no collection): what GET /v1/quota-manager returns. */
export async function getManagerView(p: Paths, now = Date.now(), cfg = loadConfig()): Promise<ManagerStateFile & { live: true }> {
  const states = computeStates(await readSync(p), now, { maxAgeMin: cfg.maxAgeMin });
  const prev = await readJson<ManagerStateFile>(p.state);
  const bat = await activeBattery(p);
  return { schema_version: 'quota-manager.v1', updatedAt: new Date(now).toISOString(), providers: states, battery: bat ? { name: bat.name, startedAt: bat.startedAt } : null, lastSurvey: prev?.lastSurvey ?? null, baseline: null, alerts: alertsOf(states), missing: Object.fromEntries(states.filter((s) => s.missing.length).map((s) => [s.provider, s.missing])), calibrationSummary: prev?.calibrationSummary ?? {}, live: true };
}

// ─── battery ─────────────────────────────────────────────

export interface BatteryStartOpts { name: string; need?: string[]; plannedRequests?: Record<string, number>; strict?: boolean; force?: boolean }
export async function batteryStart(p: Paths, deps: Deps, cfg: ManagerConfig, o: BatteryStartOpts): Promise<{ started: boolean; reason?: string; precheck: PrecheckResult; states: ProviderState[] }> {
  const existing = await activeBattery(p);
  const states = await snapshot(p, deps, cfg);
  const need = o.need?.length ? o.need : DEFAULT_NEED;
  const pre = precheck({ states, need, plannedRequests: o.plannedRequests, calibration: await readCalibration(p) });
  if (existing && !o.force) return { started: false, reason: `battery "${existing.name}" already active (use --force to replace)`, precheck: pre, states };
  if (o.strict && !pre.ok) { await writeState(p, deps, cfg, states); return { started: false, reason: 'pre-check failed in --strict mode', precheck: pre, states }; }
  const b: BatteryFile = { name: o.name, startedAt: new Date(deps.now()).toISOString(), need, plannedRequests: o.plannedRequests ?? {}, intervalSec: cfg.batteryIntervalSec, before: states, totalsBefore: await readTotals(p), precheck: pre, samples: [] };
  await writeJson(p.battery, b);
  await writeState(p, deps, cfg, states);
  return { started: true, precheck: pre, states };
}

export interface BatteryReport {
  schema_version: 'quota-battery-report.v1'; name: string; startedAt: string; endedAt: string; durationMin: number; samples: number;
  precheck: PrecheckResult;
  providers: Array<{ provider: string; confidence: Confidence; method: string; requests: number; tokens: number; errors: number;
    windows: Array<{ window: WindowName; startPct: number | null; endPct: number | null; deltaPct: number | null; windowReset: boolean; lowResolution: boolean }>;
    pctPerRequest: number | null; endHeadroomPct: number | null; batteriesLeft: number | null; endBand: string; note: string | null }>;
  missing: Record<string, string[]>;
}

export async function batteryEnd(p: Paths, deps: Deps, cfg: ManagerConfig): Promise<{ report: BatteryReport; files: { json: string; md: string }; calibrationAdded: number } | null> {
  const b = await activeBattery(p);
  if (!b) return null;
  const after = await snapshot(p, deps, cfg);
  const totalsAfter = await readTotals(p);
  const end = deps.now();
  const rows: BatteryReport['providers'] = [];
  for (const a of after) {
    const s = b.before.find((x) => x.provider === a.provider);
    const reqs = (totalsAfter[a.provider]?.requests ?? 0) - (b.totalsBefore[a.provider]?.requests ?? 0);
    const toks = (totalsAfter[a.provider]?.tokens ?? 0) - (b.totalsBefore[a.provider]?.tokens ?? 0);
    const errs = (totalsAfter[a.provider]?.errors ?? 0) - (b.totalsBefore[a.provider]?.errors ?? 0);
    const wins = a.windows.map((aw) => {
      const bw = s?.windows.find((w) => w.name === aw.name);
      const reset = !!bw && !sameReset(bw.resetAt, aw.resetAt);
      const d = aw.usedPct !== null && bw?.usedPct != null && !reset ? Math.round((aw.usedPct - bw.usedPct) * 10) / 10 : null;
      return { window: aw.name, startPct: bw?.usedPct ?? null, endPct: aw.usedPct, deltaPct: d, windowReset: reset, lowResolution: d !== null && d < 2 };
    });
    // binding cost = the window where one battery eats the largest share of the remaining headroom
    let per: number | null = null; let left: number | null = null;
    for (const w of wins) {
      const hr = a.windows.find((x) => x.name === w.window)?.headroomPct ?? null;
      if (w.deltaPct == null || w.deltaPct <= 0 || hr === null) continue;
      const l = Math.floor(hr / w.deltaPct);
      if (left === null || l < left) { left = l; per = reqs > 0 ? Math.round((w.deltaPct / reqs) * 1000) / 1000 : null; }
    }
    rows.push({ provider: a.provider, confidence: a.confidence, method: a.method, requests: reqs, tokens: toks, errors: errs, windows: wins, pctPerRequest: per, endHeadroomPct: a.headroomPct, batteriesLeft: left, endBand: a.band, note: a.note });
  }
  const report: BatteryReport = { schema_version: 'quota-battery-report.v1', name: b.name, startedAt: b.startedAt, endedAt: new Date(end).toISOString(), durationMin: Math.round((end - (parseTime(b.startedAt) ?? end)) / 600) / 100, samples: b.samples.length, precheck: b.precheck, providers: rows, missing: Object.fromEntries(after.filter((s) => s.missing.length).map((s) => [s.provider, s.missing])) };
  const safe = b.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  const stamp = new Date(end).toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(p.reports, { recursive: true });
  const files = { json: join(p.reports, `${safe}-${stamp}.json`), md: join(p.reports, `${safe}-${stamp}.md`) };
  await writeJson(files.json, report);
  await fs.writeFile(files.md, renderBatteryReport(report), 'utf8');
  const cal = buildCalibration({ source: 'battery', battery: b.name, ts: report.endedAt, before: b.before, after, totalsBefore: b.totalsBefore, totalsAfter, tiersOf: await tiersMap(deps) });
  await appendCalibration(p, cal);
  await fs.rm(p.battery, { force: true });
  await writeState(p, deps, cfg, after, { baseline: { at: report.endedAt, states: after, totals: totalsAfter } });
  return { report, files, calibrationAdded: cal.length };
}

export function renderBatteryReport(r: BatteryReport): string {
  const L = [`# Quota battery report: ${r.name}`, `${r.startedAt} → ${r.endedAt} (${r.durationMin} min, ${r.samples} samples)`, ''];
  L.push('| provider | confidence | req | tokens | window | start% | end% | Δ% | %/req | headroom | batteries left | band |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  const f = (n: number | null) => (n === null ? 'n/a' : String(n));
  for (const p of r.providers) {
    const ws = p.windows.length ? p.windows : [{ window: '-' as WindowName, startPct: null, endPct: null, deltaPct: null, windowReset: false, lowResolution: false }];
    for (const w of ws) L.push(`| ${p.provider} | ${p.confidence} (${p.method}) | ${p.requests} | ${p.tokens} | ${w.window} | ${f(w.startPct)} | ${f(w.endPct)} | ${w.windowReset ? 'reset' : f(w.deltaPct)}${w.lowResolution ? '~' : ''} | ${f(p.pctPerRequest)} | ${f(p.endHeadroomPct)} | ${f(p.batteriesLeft)} | ${p.endBand} |`);
  }
  L.push('', '`~` = delta < 2 points (provider reports whole percents; ratio is coarse). `n/a` = not measured (never 0).');
  if (r.precheck.warnings.length) L.push('', '## Pre-check warnings', ...r.precheck.warnings.map((w) => `- [${w.level}] ${w.message}`));
  if (r.precheck.proposals.length) L.push('', '## Proposals', ...r.precheck.proposals.map((x) => `- ${x}`));
  const m = Object.entries(r.missing);
  if (m.length) L.push('', '## Missing for a measured reading', ...m.map(([k, v]) => `- ${k}: ${v.join('; ')}`));
  return L.join('\n') + '\n';
}

// ─── tick / survey ───────────────────────────────────────

async function acquireLock(p: Paths, now: number): Promise<boolean> {
  try { const st = await fs.stat(p.lock); if (now - st.mtimeMs < 10 * 60_000) return false; } catch { /* free */ }
  await fs.mkdir(p.data, { recursive: true }); await fs.writeFile(p.lock, String(process.pid)); return true;
}

export async function tick(p: Paths, deps: Deps, cfg: ManagerConfig): Promise<{ skipped?: string; collected: string[]; states: ProviderState[] }> {
  if (!(await acquireLock(p, deps.now()))) return { skipped: 'another tick is running', collected: [], states: [] };
  try {
    const bat = await activeBattery(p);
    const sync = await readSync(p);
    const claudeAge = (() => { const t = parseTime(sync?.snapshots?.['claude-cli']?.syncedAt); return t === null ? Infinity : (deps.now() - t) / 60_000; })();
    const claudeMin = bat ? cfg.claudeMinIntervalMin : cfg.idleIntervalSec / 60;
    const due = KNOWN_PROVIDERS.filter((k) => k !== 'claude-cli' || claudeAge >= claudeMin - 0.5);
    const states = await snapshot(p, deps, cfg, due);
    if (bat) {
      bat.samples.push({ at: new Date(deps.now()).toISOString(), providers: Object.fromEntries(states.map((s) => [s.provider, { band: s.band, maxUsedPct: s.maxUsedPct, confidence: s.confidence }])) });
      if (bat.samples.length > 500) bat.samples.splice(0, bat.samples.length - 500);
      await writeJson(p.battery, bat);
    }
    await writeState(p, deps, cfg, states);
    return { collected: due, states };
  } finally { await fs.rm(p.lock, { force: true }); }
}

export async function survey(p: Paths, deps: Deps, cfg: ManagerConfig, o: { analyze?: boolean } = {}): Promise<ManagerStateFile> {
  const states = await snapshot(p, deps, cfg);
  const totals = await readTotals(p);
  const prev = await readJson<ManagerStateFile>(p.state);
  const bat = await activeBattery(p);
  const at = new Date(deps.now()).toISOString();
  if (prev?.baseline && !bat) {
    await appendCalibration(p, buildCalibration({ source: 'survey', ts: at, before: prev.baseline.states, after: states, totalsBefore: prev.baseline.totals, totalsAfter: totals, tiersOf: await tiersMap(deps) }));
  }
  let analysis: AnalysisSummary | null = null;
  if (o.analyze !== false && deps.analyze) analysis = await deps.analyze().catch(() => null);
  return writeState(p, deps, cfg, states, { lastSurvey: { at, analysis }, baseline: bat ? prev?.baseline ?? null : { at, states, totals } });
}
