/**
 * Provider/Model Consistency Check
 *
 * Validates that every model referenced in the active routing config
 * (v04_config.json tier_models — act, plan, fallbacks) resolves to a configured
 * provider whose catalog actually lists that model. Catches "model/provider not
 * working" bugs before they hit production dispatch.
 *
 * Catalogs are read from the committed in-code source of truth
 * (HTTP_PROVIDER_MODELS + DEFAULT_CLI_PROVIDERS), so this runs in CI without the
 * gitignored data/agent-registry.json. When that file IS present (local dev), the
 * CLI run additionally reports on agent tierConfigs.
 *
 * Exposed as runConsistencyCheck() for the vitest suite; also a CLI diagnostic:
 *   npx tsx eval/consistency-check.ts
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_CLI_PROVIDERS, HTTP_PROVIDER_MODELS } from '../src/agent-registry.js';

export interface ConsistencyResult {
  errors: string[];
  warnings: string[];
  httpProviders: string[];
  cliProviders: string[];
}

// Mirror agentRegistry.resolveModel prefix/pattern logic to infer providerId from a model string.
function inferProvider(model: string): string | null {
  if (model.startsWith('cc/')) return 'claude-cli';
  if (model.startsWith('cx/')) return 'codex-cli';
  if (model.startsWith('pi/')) return 'pi-agent';
  if (model.startsWith('hm/')) return 'hermes-agent';
  if (model.startsWith('oc/')) return 'openclaw-agent';
  if (model.startsWith('openrouter/')) return 'openrouter';
  if (model.startsWith('bailian/')) return 'bailian';
  if (model.startsWith('zai/')) return 'zai';
  if (model.startsWith('opencodego/')) return 'opencodego';
  if (model.startsWith('glm-')) return 'zai';
  if (model.startsWith('deepseek-') || model.startsWith('qwen3.7-')) return 'opencodego';
  if (model.startsWith('qwen') || model.startsWith('kimi') || model.startsWith('MiniMax')) return 'bailian';
  return null; // unknown — resolveModel would default to bailian
}

function buildCatalogs() {
  const http: Record<string, Set<string>> = {};
  for (const [pid, models] of Object.entries(HTTP_PROVIDER_MODELS)) http[pid] = new Set(models);
  const cli: Record<string, Set<string>> = {};
  for (const [pid, p] of Object.entries<any>(DEFAULT_CLI_PROVIDERS)) cli[pid] = new Set(p.models);
  return { http, cli, all: new Set([...Object.keys(http), ...Object.keys(cli)]) };
}

/**
 * Validate the committed routing config (v04_config.json) against the committed
 * provider catalogs. CI-safe — no dependency on the gitignored runtime registry.
 */
export function runConsistencyCheck(rootDir?: string): ConsistencyResult {
  const base = rootDir ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const v04 = JSON.parse(readFileSync(join(base, 'v04_config.json'), 'utf-8'));
  const { http, cli, all } = buildCatalogs();

  const catalogKey = (providerId: string, model: string): string =>
    cli[providerId] ? model : (model.includes('/') ? model.split('/').slice(1).join('/') : model);

  const errors: string[] = [];
  const warnings: string[] = [];

  function checkModel(ctx: string, model: string, declaredProvider?: string): void {
    const inferred = inferProvider(model);
    const providerId = declaredProvider ?? inferred ?? 'bailian';
    if (!all.has(providerId)) {
      errors.push(`${ctx}: provider "${providerId}" for model "${model}" is not a configured provider`);
      return;
    }
    if (declaredProvider && inferred && inferred !== declaredProvider && model.includes('/')) {
      warnings.push(`${ctx}: model "${model}" prefix implies provider "${inferred}" but config declares "${declaredProvider}"`);
    }
    const catalog = cli[providerId] ?? http[providerId];
    const key = catalogKey(providerId, model);
    if (catalog && !catalog.has(key) && !catalog.has(model)) {
      errors.push(`${ctx}: model "${key}" not in ${providerId} catalog [${[...catalog].join(', ')}]`);
    }
  }

  for (const [tier, cfg] of Object.entries<any>(v04.tier_models)) {
    checkModel(`v04.${tier}.model`, cfg.model, cfg.provider);
    if (cfg.plan_model) checkModel(`v04.${tier}.plan_model`, cfg.plan_model, cfg.plan_provider);
    for (const fb of cfg.fallback_models ?? []) checkModel(`v04.${tier}.fallback`, fb.model, fb.provider);
  }

  return { errors, warnings, httpProviders: Object.keys(http), cliProviders: Object.keys(cli) };
}

/**
 * Extra (local-only) check of the runtime agent registry, if present. Agent
 * tierConfigs carry no declared provider, so the provider is inferred by prefix.
 */
export function checkAgentRegistry(rootDir?: string): { errors: string[]; checked: boolean } {
  const base = rootDir ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const file = join(base, 'data/agent-registry.json');
  if (!existsSync(file)) return { errors: [], checked: false };
  const registry = JSON.parse(readFileSync(file, 'utf-8'));
  const { http, cli, all } = buildCatalogs();
  const catalogKey = (pid: string, m: string) => cli[pid] ? m : (m.includes('/') ? m.split('/').slice(1).join('/') : m);
  const errors: string[] = [];
  for (const [aid, agent] of Object.entries<any>(registry.agents ?? {})) {
    for (const [tier, model] of Object.entries<any>(agent.tierConfig ?? {})) {
      const providerId = inferProvider(model) ?? 'bailian';
      if (!all.has(providerId)) { errors.push(`agent.${aid}.${tier}: provider "${providerId}" not configured`); continue; }
      const catalog = cli[providerId] ?? http[providerId];
      const key = catalogKey(providerId, model);
      if (catalog && !catalog.has(key) && !catalog.has(model)) {
        errors.push(`agent.${aid}.${tier}: model "${key}" not in ${providerId} catalog`);
      }
    }
  }
  return { errors, checked: true };
}

// ─── CLI entrypoint ──────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const r = runConsistencyCheck();
  const agents = checkAgentRegistry();
  console.log('═══ Provider/Model Consistency Check ═══\n');
  console.log(`Providers: HTTP=[${r.httpProviders.join(', ')}] CLI=[${r.cliProviders.join(', ')}]`);
  console.log(`Scope: v04_config.json tier_models${agents.checked ? ' + data/agent-registry.json agents' : ' (agent-registry.json absent — skipped)'}\n`);
  const errors = [...r.errors, ...agents.errors];
  if (errors.length === 0 && r.warnings.length === 0) {
    console.log('✅ All model references resolve to configured providers with matching catalog entries.');
  } else {
    if (errors.length) {
      console.log(`❌ ${errors.length} ERROR(S):`);
      for (const e of [...new Set(errors)]) console.log('  - ' + e);
    }
    if (r.warnings.length) {
      console.log(`\n⚠️  ${r.warnings.length} WARNING(S):`);
      for (const w of [...new Set(r.warnings)]) console.log('  - ' + w);
    }
    process.exitCode = errors.length ? 1 : 0;
  }
}
