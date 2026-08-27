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
router (0.1.0, dep: lite)        ← unchanged
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
| Version lineage confusion | resolved 2026-08-26: no lineage inheritance — every package versions independently from 0.1.0 (see §Versioning below) |

## Versioning policy (decided 2026-08-26)

**Independent SemVer per package, no lineage inheritance.** A version number communicates the maturity of *that package's API* — never brand history. The gateway's v0.5.x/v0.6.0 line lives in GitHub releases only (nothing was ever published to npm), so new packages start at `0.1.0` regardless of which codebase they were extracted from. The earlier "split lineage" experiment (router at 0.6.0) was reverted for this reason: a consumer seeing `0.6.0` assumes six cycles of API evolution that never happened.

Rules:

1. **Independent cadence.** Each package releases on its own schedule via changesets + one tag per package (`lite@x.y.z`, `router@x.y.z`, `mcp@x.y.z`). No lockstep: lite changes rarely (calibration-gated), router changes with strategies/matrix, mcp follows its dependencies. Lockstep would force empty releases of exactly the package whose stability we most want to signal.
2. **Caret ranges for internal deps** (`"gateswarm-lite": "^0.1.0"`, not exact pins). This lets npm dedupe to a single module instance across the tree. This matters more here than in most projects: `tier-boundaries` holds **mutable module state** (`setTierBoundaries`) — two installed copies of lite means retraining updates silently stop propagating to the router's copy.
3. **Coordinated major exception.** When lite crosses a major, router/mcp/core bump a major in the same release window even if their own APIs are unchanged, so caret ranges keep resolving to one lite instance. This is the only sanctioned deviation from full independence.
4. **Lite graduates to 1.0.0 early.** Its API is tiny (`scoreComplexity`, `scoreSession`, boundary functions) and already locked by parity tests + frozen snapshots. Criteria for 1.0: first npm publish + one calibration cycle completed through the eval pipeline without API change. After 1.0: **patch** = fix with zero score change (snapshot-verified) · **minor** = additive API or documented boundary recalibration (own PR with eval numbers, per testing spec §6) · **major** = contract change (`ComplexityResult`, signatures).
5. **Gateway keeps its own line** (0.6.0+ → phased retirement per the discontinuation assessment). It never constrains package versions.

## Decision

- [x] Versioning policy above (applied in PR #5: router reset to 0.1.0, caret ranges)
- [ ] Approve core as telemetry-contract package (this doc)
- [ ] Execute migration (half-day, suite-gated)
- [ ] Defer: gateway Phase 1 wiring of core capture (next release, per discontinuation phases)
