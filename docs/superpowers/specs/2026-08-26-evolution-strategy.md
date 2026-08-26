# GateSwarm Evolution Strategy — Installation, Usage, Evolution

**Date:** 2026-08-26
**Status:** Proposal
**Builds on:** two-layer split (PR #5), dogfood flywheel, gateway discontinuation assessment (2026-08-26)

## 1. Product shape: three consumption modes

GateSwarm serves three distinct users from one monorepo. Every evolution decision should name which mode it serves:

| Mode | User | Entry point | Package |
|---|---|---|---|
| **SDK** | Developers embedding scoring/routing | `npm i gateswarm-lite gateswarm-router` | lite, router |
| **Agent** | CLI/IDE AI agent users | `npx gateswarm-mcp` (zero clone) | mcp |
| **Executor** | Teams wanting the full proxy | `npm i gateswarm-gateway` / docker | gateway (phases 1→3 per assessment) |

## 2. Installation track — "install in one command, no repo clone"

Today every artifact requires cloning this repo and `npm run build`. Target state:

1. **npm publish (highest leverage, do first).** All three packages are publish-ready (`prepublishOnly` = build+test; exports/bin/files configured; nothing on the registry conflicts — verified). Publish enables:
   - `npx gateswarm-lite "prompt"` and `npx gateswarm-route "prompt" --strategy best-value` with zero install
   - MCP registration with **no clone**: `"command": "npx", "args": ["gateswarm-mcp"]`
2. **CI release workflow.** GitHub Actions: tag `lite@x.y.z` / `router@x.y.z` / `mcp@x.y.z` → run full battery (427 tests + typecheck + consistency + build) → publish on green. No manual publishes.
3. **Changesets** (or equivalent) for changelogs per package — lite and router have different consumers and must release independently; mcp follows whichever dependency changed.
4. **Gateway stays installable** (`gateswarm-gateway` name is free) but its README leads with "you probably want lite + router + your own executor" and links the assessment.

## 3. Usage track — the flywheel IS the product

1. **Golden dataset loop as the documented happy path** (README already leads with it): register MCP → verdicts accumulate → `fit:report` → label the queue → `eval:refit-boundaries` → `eval:gate` → own-PR boundaries.
2. **Distribution surfaces**: list `gateswarm-mcp` in MCP server directories (Claude registry, mcp.so, PulseMCP); ship an `examples/` folder (custom matrix file, agent config, telemetry export → eval adapter).
3. **Zero-config defaults, data-overrides everywhere**: DEFAULT_MATRIX and DEFAULT_BOUNDARIES work out of the box; production users override via `RouteOptions.matrix` / `setTierBoundaries` — never code edits.
4. **The eval adapter** (dogfood doc §4 export → `eval/lib/dataset.js` shape) is the one missing glue piece for external users' labels; small, high-leverage.

## 4. Evolution track — one brain, phased gateway retirement

1. **Phase 1 (next release): gateway adopts `gateswarm-router` selection** — health/quota/plan-act become filters *around* `selectModel`, ending the dual-selection-brain state (gateway still uses its internal matrix today; 0 imports of router). This makes every calibration improvement flow to ALL modes.
2. **Calibration releases on their own cadence**: boundary changes are own-PRs with eval numbers (rule already in testing spec §6); snapshots guard drift both directions.
3. **Quarterly maintenance**: DEFAULT_MATRIX price review (spec §7), score-snapshot regeneration review, dependency audit.
4. **Governance unchanged**: spec/decision doc → PR with checklist → parity + snapshot + e2e gates. The 427-test battery is the merge contract.

## 5. North-star metrics

- **Fit**: `fit:report` cost delta vs. oracle labeling on real telemetry (the metric that matters)
- **Adoption**: npm downloads, MCP registrations, telemetry verdict counts
- **Quality**: parity suite green, snapshot drift = 0 outside intentional changes

## 6. 90-day plan

| Window | Installation | Usage | Evolution |
|---|---|---|---|
| Days 0–30 | Publish lite/router/mcp; CI release workflow; npx MCP config | MCP directory listings; `examples/` | Merge PR #5; gateway 0.7.0 planning |
| Days 31–60 | Changesets; docker image for gateway (if kept) | Eval adapter for external labels | Phase 1: gateway routes via `selectModel` |
| Days 61–90 | Release cadence review | First calibration release from real telemetry | Phase 2 assessment (executor parity check) |

## 7. Anti-goals (unchanged)

No ML/embeddings in lite · router stays advisory (no execution) · eval pipeline stays in this repo · no version gymnastics: independent SemVer per package (lite 0.1.0 · router 0.1.0 · mcp 0.1.0 · gateway 0.6.0+), no lineage inheritance (policy: package-structure assessment §Versioning).
