/**
 * Periodic quota analysis (report + proposed tier_models diff, never applied).
 *
 *   npx tsx scripts/quota-analyze.ts [--json] [--no-jev] [--out <file.json>] [--loop <minutes>] [--config <v04_config.json>]
 *
 * Jev is consulted only when GATESWARM_JEV_MODE=shadow and GATESWARM_JEV_DECISIONS=advise|enforce
 * (TYPESAFE_API_KEY from the environment; never printed). Only aggregated metrics are sent.
 */
import { promises as fs } from 'node:fs';
import { analyzeQuota, loadAnalysisInput, renderReportText } from '../src/jev/quota-analysis.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

async function once(): Promise<number> {
  const input = await loadAnalysisInput({ configFile: val('--config') });
  if (!input) { console.error('tier config not readable (set GATESWARM_CONFIG_FILE or --config)'); return 2; }
  const env = flag('--no-jev') ? { ...process.env, GATESWARM_JEV_DECISIONS: 'off' } : process.env;
  const report = await analyzeQuota(input, { env });
  const out = val('--out');
  if (out) await fs.writeFile(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(flag('--json') ? JSON.stringify(report, null, 2) : renderReportText(report));
  return 0;
}

const loopMin = Number(val('--loop'));
if (loopMin > 0) {
  for (;;) { await once().catch((e) => console.error('analysis failed:', (e as Error).message)); await new Promise((r) => setTimeout(r, loopMin * 60_000)); }
} else {
  process.exit(await once());
}
