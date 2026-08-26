# Package Structuring Assessment — adding `gateswarm-core`

**Date:** 2026-08-26
**Status:** Assessment (decision-support)
**Question:** `gateswarm-gateway` → `gateswarm-lite` + `gateswarm-router` + `gateswarm-mcp` + **`gateswarm-core`** — is a fourth package justified, and what belongs in it?

## Verdict

**Yes to `gateswarm-core`, with a narrow mandate: the telemetry contract.** It becomes the shared event schema + store + dataset export that today is trapped inside `gateswarm-mcp` — which is a *transport* package, yet currently owns the *data* contract. The dogfood architecture requires three emitters of the same events (MCP plugin, gateway/AnyModel executor, review tooling); owning that contract in `mcp` forces the wrong dependency direction (gateway → mcp).

Everything else stays where it is. In particular: **scoring stays in lite, selection stays in router, `eval/` stays as repo tooling** (spec §2 only requires same-repo, not same-package).

## Current structure — inventory and pressure points

| Concern | Lives in | Publishable | Problem |
|---|---|---|---|
| Scoring (extractor, boundaries, sessions) | `packages/gateswarm-lite` | ✅ zero deps | none — leaf by design |
| Selection policy (matrix, selectModel, route) | `packages/gateswarm-router` | ✅ dep: lite | none |
| MCP transport (JSON-RPC, tools) | `packages/gateswarm-mcp` | ✅ dep: lite+router | **owns telemetry schema/store** — wrong home |
| Telemetry schema (`DecisionRecord`, `FeedbackRecord`, JSONL store) | inside mcp `store.ts` | only via mcp | gateway/AnyModel can't emit events without depending on an MCP server package |
| Fit math + labeling queue (`fit:report`) | `scripts/lib/fit.ts` | ❌ repo-only | users of published packages can't run fit analysis |
| Corpus/snapshot tooling | `scripts/` | ❌ repo-only | acceptable (calibration is repo-side) |
| Eval pipeline (11 scripts) | `eval/` | ❌ | correct as-is — imports via shims, 0 package deps |
| Proxy/execution (44 files) | root `gateswarm-gateway` | ✅ | phases per discontinuation assessment |

## Proposed structure

```
lite (0.1.0, zero deps)          ← unchanged, MUST stay leaf
  ▲
router (0.6.0, dep: lite)        ← unchanged
  ▲
core (0.1.0, dep: lite+router)   ← NEW
  • InteractionEventV1 / DecisionRecord / FeedbackRecord (moved from mcp/store.ts)
  • append-only JSONL store (project files, env override)   (moved)
  • boundariesHash / matrix fingerprint helpers              (moved)
  • dataset export: events.jsonl → OrganicLabelRow-shaped golden set (new, the §4 adapter glue)
  • fit math: buildRows / boundarySwings / labelingQueue / saturation  (moved from scripts/lib/)
  ▲                    ▲
mcp (0.1.0, dep: core)  gateway (dep: core for capture)   AnyModel/review tooling (external, dep: core)
```

Dependency rules that keep this sane:
1. **lite never depends on anything** (browser-safe leaf, spec invariant).
2. **core is types + pure functions + fs I/O only** — no transport, no provider calls, no Node-only APIs in its public surface beyond `node:fs` in the store module (documented).
3. **mcp keeps only JSON-RPC/tools** and consumes the store from core.
4. **gateway imports core** when Phase 1/2 capture lands — enabling its telemetry without touching mcp.

## What NOT to move into core (explicit anti-scope)

- ❌ Scorer or boundaries (would break zero-dep lite or invert layers)
- ❌ `eval/` pipeline (repo tooling; publishing adds noise, zero consumers)
- ❌ Corpus fixtures/snapshots (calibration artifacts, regenerate repo-side)
- ❌ MCP protocol handling (stays in mcp)
- ❌ Any executor logic (gateway's phased retirement path)

## Migration plan (mechanical, ~half a day)

1. `packages/gateswarm-core/` scaffold (package.json 0.1.0, tsconfig, build chain slot before mcp)
2. `git mv` semantics: move `store.ts` content mcp→core; mcp re-exports from core (public API of mcp unchanged — its `index.ts` already re-exports store types, so dependents see no break)
3. Move `scripts/lib/fit.ts` → core; `fit:report` script imports `gateswarm-core`; test follows the move
4. Add dataset-export function (`events.jsonl → golden-*.jsonl`) with round-trip test
5. Root build chain: lite → router → core → mcp → gateway
6. Tests: existing mcp/e2e suites must stay green untouched (they validate the move); add one core unit suite

## Costs and risks

| Risk | Mitigation |
|---|---|
| 5 packages = release orchestration | changesets + tag-per-package CI (evolution strategy §2); core changes are additive |
| Premature abstraction (only mcp consumes today) | justified by *architecture*, not hope: gateway capture is Phase 1/2-committed; wrong-direction dependency is the cost of waiting |
| API split churn for early mcp users | mcp keeps re-exporting store symbols — zero breaking change |
| Version lineage confusion (router 0.6.0 shared line) | core starts 0.1.0 like lite/mcp; README lineage note already covers router |

## Decision

- [ ] Approve core as telemetry-contract package (this doc)
- [ ] Execute migration (half-day, suite-gated)
- [ ] Defer: gateway Phase 1 wiring of core capture (next release, per discontinuation phases)
