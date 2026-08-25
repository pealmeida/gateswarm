# GateSwarm Lite + Advisory Router — Design Spec

**Date:** 2026-08-25
**Status:** Approved direction (workspaces extraction, advisory router)
**Related plan:** `docs/superpowers/plans/2026-08-25-gateswarm-lite-router.md`

## 1. Goal

Offer a lightweight, two-layer solution that can (1) evaluate the complexity of a prompt and (2) route it to the model with the best cost/benefit for that complexity — without carrying the full GateSwarm gateway (HTTP proxy, providers, RAG, feedback loop).

- **Layer 1 — `gateswarm-lite`:** zero-dependency complexity scorer. Input: prompt string. Output: score (0–1), effort tier (6 levels), extracted features. Feeds the routing matrix.
- **Layer 2 — `gateswarm-router`:** advisory router (AnyModel-plugin style). Input: prompt (or a precomputed tier) plus a model matrix. Output: a routing *decision* — which model/provider to use, with alternatives and reasoning. It does **not** execute the request; the caller does.

## 2. Context (facts from the current codebase)

The production complexity scorer is already lightweight and heuristic-only:

- `src/feature-extractor-v04.ts` — self-contained (zero imports). Exports `FeatureVector` (35 fields), `extractFeatures(prompt)`, `heuristicScoreFromFeatures(features, wordCount)`, `countPromptWords(prompt)`.
- `src/tier-boundaries.ts` — imports only `EffortLevel` from `src/types.ts`. Exports `DEFAULT_BOUNDARIES` (`[0.208938, 0.264209, 0.32502, 0.36585, 0.485382]`), `scoreToEffort(score)`, `setTierBoundaries`, `getTierBoundaries`, `getEffortRanges`, `EFFORT_RANGES`, `tierMidpoints`. Holds mutable module state (boundaries can be updated by retraining/hot-reload).
- The learned cascade/ordinal path is disabled by default (`feedback_loop.cascadeRetraining: false` in `v04_config.json`); the ensemble effectively runs heuristic-only. Transformers.js/ONNX are optional dependencies used for local *generation*, not scoring.
- The existing `src/routing-matrix.ts` is a browser/device-oriented effort × device-profile matrix (WebGPU/WASM local models). It stays untouched as gateway/browser infrastructure; it is **not** the new advisory router.
- The `eval/` pipeline (`refit-boundaries`, `calibrate`, `calibration-gate`) tunes the weights and cut points the scorer uses. **The scorer and its calibration machinery must live in the same repo** — this is why we extract into workspaces instead of a separate repo.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ repo: gateswarm-router (root package renamed             │
│       "gateswarm-gateway" — full gateway, unchanged)     │
│                                                          │
│  packages/gateswarm-lite          packages/gateswarm-router
│  ┌──────────────────────┐         ┌──────────────────────┐
│  │ feature-extractor.ts │  tier   │ types.ts (ModelSpec) │
│  │ tier-boundaries.ts   │ ──────► │ matrix.ts (default)  │
│  │ types.ts             │         │ select.ts            │
│  │ index.ts             │         │ index.ts (route())   │
│  │  scoreComplexity()   │         │ cli.ts               │
│  │ cli.ts               │         └──────────────────────┘
│  └──────────────────────┘                  │
│         ▲                                  ▼
│  src/ shims re-export            RouteDecision (advisory:
│  (gateway + eval keep            caller executes the call)
│   importing old paths)
└─────────────────────────────────────────────────────────┘
```

- **npm workspaces** (`"workspaces": ["packages/*"]`) in the existing repo. Both packages are independently publishable.
- The gateway keeps working through **re-export shims**: `src/feature-extractor-v04.ts` and `src/tier-boundaries.ts` become one-line re-exports from `gateswarm-lite`. All ~10 `src/` consumers, tests, and `eval/` scripts keep their import paths. Because the shims re-export the same module instance, mutable tier-boundary state (retraining, hot-reload) continues to work.
- Source-level resolution for dev tooling: `tsconfig.json` `paths` + `vite.config.ts` `resolve.alias` map `gateswarm-lite` → `packages/gateswarm-lite/src/index.ts` (and same for the router package), so `tsx`, `tsc --noEmit`, and `vitest` work without prebuilding packages.

## 4. Naming and versioning decision

- Layer 1 package: **`gateswarm-lite`**.
- Layer 2 package: **`gateswarm-router`** (per product decision).
- The root gateway package is renamed **`gateswarm-gateway`** (its bin was already `gateswarm-gateway`), freeing the `gateswarm-router` name for layer 2.
- Publishing caveat: the npm name `gateswarm-router` currently identifies the gateway at v0.6.0. If it was ever published under that name, the repurposed layer-2 package must start at a higher version (e.g. `0.7.0`) and its README must state the repurpose prominently. If never published, start at `0.1.0`.

## 5. Public API — `gateswarm-lite`

Zero runtime dependencies. Runs in Node ≥20, browsers, and edge runtimes.

```typescript
export type EffortLevel = 'trivial' | 'light' | 'moderate' | 'heavy' | 'intensive' | 'extreme';

export interface ComplexityResult {
  score: number;          // 0–1 heuristic score
  tier: EffortLevel;      // scoreToEffort(score)
  wordCount: number;
  features: FeatureVector; // the 35 extracted features
  latencyMs: number;
}

export function scoreComplexity(prompt: string): ComplexityResult;

// Lower-level building blocks (re-exported unchanged):
export { extractFeatures, heuristicScoreFromFeatures, countPromptWords } // feature-extractor
export { scoreToEffort, setTierBoundaries, getTierBoundaries, getEffortRanges,
         EFFORT_RANGES, DEFAULT_BOUNDARIES, tierMidpoints }              // tier-boundaries
```

Behavioral guarantees:

- `scoreComplexity` truncates prompts above 64 KiB before scoring (same guard as `intent-engine-v04.ts`).
- **Parity invariant:** for any prompt, `scoreComplexity(p).score` and `.tier` must equal the gateway's `scoreIntentSync(p).value` and `.tier`. A regression test enforces this.
- CLI: `gateswarm-lite "<prompt>"` (or stdin) prints the `ComplexityResult` as JSON.

## 6. Public API — `gateswarm-router`

Depends only on `gateswarm-lite`. Advisory-only: it returns a decision; it never calls a provider API, holds no API keys, and does no streaming/retries.

```typescript
export interface ModelSpec {
  id: string;              // e.g. "gpt-5-mini"
  provider: string;        // e.g. "openai"
  maxEffort: EffortLevel;  // highest tier this model handles reliably
  costPer1MInput: number;  // USD per 1M input tokens
  costPer1MOutput: number; // USD per 1M output tokens
  quality: number;         // 0–1 relative quality estimate
  avgLatencyMs?: number;
  tags?: string[];
}

export type RoutingStrategy = 'cheapest-capable' | 'best-value';

export interface RouteOptions {
  strategy?: RoutingStrategy; // default: 'cheapest-capable'
  matrix?: ModelSpec[];       // default: DEFAULT_MATRIX
  minQuality?: number;        // filter floor, default 0
}

export interface RouteDecision {
  model: ModelSpec;
  alternatives: ModelSpec[]; // up to 3 next-best capable models
  complexity: ComplexityResult;
  strategy: RoutingStrategy;
  reason: string;            // human-readable explanation
}

export function selectModel(tier: EffortLevel, matrix: ModelSpec[], opts?: RouteOptions): {
  model: ModelSpec; alternatives: ModelSpec[]; reason: string;
};
export function route(prompt: string, opts?: RouteOptions): RouteDecision;
export const DEFAULT_MATRIX: ModelSpec[];
```

Selection semantics:

- **Capability filter:** a model is *capable* if `rank(maxEffort) >= rank(tier)` (rank: trivial=0 … extreme=5) and `quality >= minQuality`.
- **Blended cost:** `costPer1MInput * 0.25 + costPer1MOutput * 0.75` (output-weighted; typical chat workloads are output-heavy).
- **`cheapest-capable` (default):** among capable models, lowest blended cost wins; ties broken by higher quality.
- **`best-value`:** among capable models, highest `quality / (1 + blendedCost)` wins.
- **Fallback:** if no model is capable (e.g. `extreme` tier with a weak matrix), pick the model with the highest `maxEffort` rank, ties broken by quality; `reason` states the fallback.
- The matrix is **data, not code**: `DEFAULT_MATRIX` ships as a reviewed starting point (prices are estimates and must be reviewed periodically); callers pass their own matrix for production use.
- CLI: `gateswarm-route "<prompt>"` prints the `RouteDecision` as JSON; `--strategy best-value` and `--matrix <file.json>` supported.

## 7. Migration mechanics

1. Root `package.json`: rename to `gateswarm-gateway`, add `"workspaces": ["packages/*"]`, add dependency `"gateswarm-lite": "*"`.
2. `git mv src/feature-extractor-v04.ts packages/gateswarm-lite/src/feature-extractor.ts` and `git mv src/tier-boundaries.ts packages/gateswarm-lite/src/tier-boundaries.ts` (history preserved).
3. `packages/gateswarm-lite/src/types.ts` defines `EffortLevel`; root `src/types.ts` re-exports it from `gateswarm-lite` (single source of truth, structurally identical so no consumer changes).
4. New shims at the old paths (`src/feature-extractor-v04.ts`, `src/tier-boundaries.ts`) re-export everything from `gateswarm-lite`. No other `src/`, `tests/`, or `eval/` file changes its imports.
5. `tsconfig.json` `paths` + `vite.config.ts` `resolve.alias` provide source-level package resolution for `tsx`/`vitest`/`tsc --noEmit`.
6. Root `build` script builds `gateswarm-lite` and `gateswarm-router` (their own `tsc -p`) before the gateway build, so `dist/` imports resolve through the workspace symlinks.

## 8. Non-goals

- No request execution/proxying in the router (no provider SDKs, no API keys, no streaming). A thin executor can be added later as a separate package without breaking the advisory API.
- No device profiles in the new router (the existing `src/routing-matrix.ts` keeps that concern for the browser/gateway).
- No ML cascade/ordinal/embeddings in `gateswarm-lite` — heuristic-only, matching production behavior.
- No changes to gateway behavior, eval pipeline, or the Python legacy (`router.py`, `train.py`).

## 9. Error handling

- `scoreComplexity`: non-finite scores are impossible from the heuristic path; `scoreToEffort` already guards non-finite input by returning `'moderate'` (existing behavior, unchanged).
- `selectModel` with an empty matrix throws `Error('gateswarm-router: matrix is empty')` — a caller bug, fail fast.
- CLI entrypoints exit 1 with a JSON error object on invalid input (empty prompt, unreadable matrix file).

## 10. Testing strategy

- **Parity regression:** `scoreComplexity` vs `scoreIntentSync` — identical `score`/`tier` across a fixture set of prompts spanning all 6 tiers (guards the extraction against drift).
- **Existing suite green:** all current `tests/` and `eval` consistency checks pass unchanged through the shims (`npm test`, `npm run typecheck`, `npm run check:consistency`).
- **Router unit tests:** capability filtering, both strategies, tie-breaking, fallback path, empty-matrix error, `minQuality`.
- **Matrix validation test:** `DEFAULT_MATRIX` entries are well-formed (ranks valid, costs > 0, quality in (0,1]) and at least one model is capable per tier.
- **Build verification:** both packages build standalone; root `npm run build` produces a working gateway dist; package CLIs smoke-tested from built output.

## 11. Success criteria

1. `npm i gateswarm-lite` (or workspace import) gives `scoreComplexity()` with zero dependencies, working in Node/browser/edge.
2. `route(prompt)` returns the cheapest capable model for the scored tier, with alternatives and reasoning, in < 5 ms typical.
3. The gateway, tests, and eval pipeline behave identically before and after the refactor (parity test + full suite green).
4. Tier boundaries remain retrainable: `eval:refit-boundaries` output still feeds the same `setTierBoundaries` the lite package exports.

## 12. Risks

| Risk | Mitigation |
|------|------------|
| Score drift during extraction | Files moved verbatim (`git mv`); parity test locks score/tier equality |
| Workspace resolution breaks tsx/vitest | Source-level `paths` + vite alias; verified in plan Task 1 before any move |
| Dual module instances of tier-boundary state | Shims re-export the single lite module; no duplicate implementation remains in `src/` |
| npm name repurpose confuses existing users | README callout + version bump strategy (Section 4) |
| Default matrix prices go stale | Matrix is data with a review note; callers encouraged to supply their own |
