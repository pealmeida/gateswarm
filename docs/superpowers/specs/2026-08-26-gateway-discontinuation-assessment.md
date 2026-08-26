# GateSwarm Gateway — Discontinuation Assessment

**Date:** 2026-08-26
**Status:** Assessment (decision-support; no deprecation action taken)
**Context:** PR #5 split `gateswarm-lite` (scorer) and `gateswarm-router` (advisory selection) out of the gateway. Question on the table: can `gateswarm-gateway` (root package) be discontinued now that the two-layer split exists?

## Verdict

**Do not discontinue now. Discontinuation is viable only in phases, gated on measurable criteria.**

The split extracted exactly two of the gateway's concerns — **scoring** (lite) and **tier→model selection policy** (router). The gateway remains the only component that *executes* anything, and it is the mandatory host of the calibration pipeline. Concretely today:

- `src/` = **44 files**; `moma-gateway.ts` alone is **3,402 lines** of proxy/execution logic
- **17 of 42 test suites** exercise gateway internals (providers, failover, quotas, routing behavior)
- **0 imports** of `gateswarm-router` from `src/` — the proxy still uses its own selection (consumption-intelligence / model-matrix / tier_models), by design (spec §3: "the full proxy keeps its own provider routing")
- Production runs **v0.5.6**, with **v0.6.0 in progress**

## Capability replacement matrix

| Gateway capability | Replacement today | Discontinuable? |
|---|---|---|
| Complexity scoring | ✅ `gateswarm-lite` (gateway already consumes it via shims) | Yes — done |
| Tier→model selection (static matrix) | ✅ `gateswarm-router` | Partially — gateway doesn't use it yet |
| OpenAI-compatible HTTP endpoint (`/v1/chat/completions`) | ❌ none (router is advisory-only, no executor shipped) | No |
| Request execution (HTTP providers + CLI agents) | ❌ none (AnyModel is designated executor in the dogfood architecture, not yet at parity) | No |
| Failover, health checks, cooldowns, 429 masking | ❌ none | No |
| Streaming, timeouts, retries | ❌ none (explicitly out of scope of the split) | No |
| Plan/Act dual-model routing, vision-capability routing, effort overrides | ❌ none | No |
| Quota tracking, consumption intelligence, tier rebalancing | ❌ none | No |
| RAG/feedback persistence, ensemble signals, retraining proposals | ❌ none (lite is heuristic-only per spec non-goals) | No |
| Browser dashboard + device profiles (`routing-matrix.ts`) | ❌ none | No |
| **Eval / calibration pipeline** (`refit-boundaries`, `calibrate`, `gate`) | — | **Never moves**: spec §2 mandates scorer and calibration live in the same repo; this repo keeps them regardless of the gateway's fate |

## Deprecation is a spectrum — recommended phases

**Phase 0 — today (this PR).** Gateway = *executor + ops + eval host*. No deprecation. Publish state documented (nothing on npm; GitHub releases carry v0.5.6, v0.6.0 in progress).

**Phase 1 — gateway 0.7.0 (single selection brain).** Gateway replaces its internal static tier→model selection with `gateswarm-router` (`selectModel` + matrix as data), keeping health/quota/plan-act as *additional filters around it*. Exit criteria: router selection used for ≥1 tier_models code path in production; parity suite green. This is the step that makes future discontinuation meaningful — otherwise lite/router never actually absorb the routing brain.

**Phase 2 — executor parity.** AnyModel (or any executor) reaches parity on: proxy compat, failover, streaming, telemetry capture (InteractionEvent). Gateway goes **maintenance-only** (security fixes only), deprecation notice in README. Exit criteria: 30 consecutive days of production traffic through the alternative executor; eval pipeline unaffected.

**Phase 3 — archival.** Gateway frozen, `src/` trimmed to what eval/ still needs (shims stay). The repo pivots to lite + router + mcp + eval. Tagger/badge updated.

## Risks of discontinuing immediately

1. **Breaking production** — v0.5.6 users have no migration path; the OpenAI-compatible endpoint disappears.
2. **Dead-ending the in-progress v0.6.0** release.
3. **Losing the flywheel's reference capture** — the dogfood architecture names the gateway the reference implementation of telemetry capture until AnyModel proves out.
4. **Calibration orphaning risk** — if the repo dissolves into packages-only without the eval pipeline intact, boundary refits lose their labeled-data machinery (spec violation).
5. **Test surface loss** — 17 suites cover proxy/provider behavior; deleting them deletes the only regression net for execution semantics.

## What this means for the current PR

Nothing changes: the split is exactly the prerequisite for Phase 1. The gateway's role after merge should be stated in its README ("executor + ops + calibration host; selection policy migrating to gateswarm-router").

## Decision checklist (revisit each release)

- [ ] Has any production executor replaced the proxy endpoint? (Phase 2 gate)
- [ ] Does gateway selection route through `gateswarm-router`? (Phase 1 gate)
- [ ] Do failover/quota/plan-act have owners outside `src/`? (Phase 2 gate)
- [ ] Is `eval/` still green in this repo, untouched? (always)
