# GateSwarm MoMA Router v0.5.1 — Release Status

## ✅ COMPLETE

### Files Deleted (v0.6+ only)
- `src/output-filter.ts` — RTK token economy output filtering
- `src/token-economy.ts` — Token economy tracking
- `src/quota-tracker.ts` — v0.6.2 quota management
- `src/provider-health.ts` — v0.6.2 provider health/circuit breaker

### Files Stripped (v0.6+ features removed)
1. **src/types.ts** — Removed `IntentMode`, `DataSource`, mode/effortOverride from `RoutingDecision`
2. **src/v04-config.ts** — Removed `plan_model`, `plan_provider`, `data_sources`, effort profile functions
3. **src/agent-registry.ts** — Removed `DataSource`, `EffortProfile`, `data_sources` fields
4. **src/gateswarm-cli.ts** — Removed effort/mode/token-stats/health/quota commands
5. **v04_config.json** — Stripped `plan_*` and `data_sources` from all tiers

### Version Updates
- `package.json` → version "0.5.1"
- `v04_config.json` → version "v0.5.1-cli-providers"
- CLI banner → "v0.5.1 — CLI Providers + Direct Routing"

## ⚠️ REMAINING WORK

### src/moma-gateway.ts (2220 lines)
This file has v0.6+ features deeply integrated. Needs careful stripping of:

1. **Header (lines 1-56)** — Update to v0.5.1, remove v0.6/v0.6.1/v0.6.2 references
2. **Imports (lines 82-90)** — Remove output-filter, token-economy, provider-health, quota-tracker
3. **Functions** — Delete `detectDataSources()` and `mergeDataSources()`
4. **handleChatCompletion** — Strip:
   - Effort override logic (~lines 595-645)
   - Mode override/detection (~lines 617-678)
   - Data source validation (~lines 693-730)
5. **Fallback dispatch** — Remove quota tracking calls (~lines 1011-1106)
6. **Startup** — Remove quota probe initialization (~lines 1499-1511)
7. **Health endpoint** — Remove v0.6.2 health/quota status (~lines 1576-1640)
8. **Endpoints** — Remove /v06/effort, /v06/mode, /v06/token-stats, /v06.1/data-sources

## 📋 CHANGELOG NEEDED

Add to CHANGELOG.md:

```markdown
## [0.5.1-cli-providers] — 2026-XX-XX

### Added
- **Direct Routing Bypass** — Skip classification via body.direct_route, model override, or headers
- **Provider Listing** — GET /v1/providers lists all HTTP + CLI providers
- **CLI Providers** — Subprocess dispatch for Claude Code, Codex, Pi, Hermes, OpenClaw

### Changed
- Version: 0.5.1 (stable open-source release)
- Banner: "CLI Providers + Direct Routing"

### Removed (for this release)
- All v0.6+ features: effort override, plan/act modes, RTK token economy, data source validation, provider health/quota
```

## 🎯 NEXT STEPS

1. Manually strip moma-gateway.ts (or spawn focused subagent with smaller edits)
2. Test compilation: `npx tsc --noEmit` or `npx tsx src/moma-gateway.ts --help`
3. Update CHANGELOG.md with v0.5.0 and v0.5.1 entries
4. Create git tag: `git tag v0.5.1-cli-providers`
5. Push to gateswarm remote: `git push gateswarm main --tags`
6. Set v0.5.1 as `stable` branch on GitHub
