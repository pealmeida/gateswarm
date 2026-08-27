# GateSwarm Lite + Advisory Router — Design Spec

**Date:** 2026-08-25
**Status:** Approved — ready for implementation
**Implementation plan:** `docs/superpowers/plans/2026-08-25-gateswarm-lite-router.md`
**Testing & refinement:** `docs/superpowers/specs/2026-08-25-gateswarm-lite-router-testing.md`

## 1. Goal

Offer a lightweight, two-layer solution that can (1) evaluate prompt complexity and (2) address the prompt to the model with the best cost/benefit for that complexity — without carrying the full GateSwarm gateway (HTTP proxy, providers, RAG, feedback loop).

- **Layer 1 — `gateswarm-lite`:** zero-dependency complexity scorer. Input: prompt string. Output: score (0–1), effort tier (6 levels), extracted features. This is the only contract layer 2 needs.
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
│  src/ shims (named re-exports)   RouteDecision (advisory:
│  gateway + eval keep             caller executes the call)
│  importing old paths
└─────────────────────────────────────────────────────────┘
```

- **npm workspaces** (`"workspaces": ["packages/*"]`) in the existing repo. Both packages are independently publishable.
- The gateway keeps working through **named re-export shims** (not `export *`). `src/feature-extractor-v04.ts` re-exports only extractor symbols; `src/tier-boundaries.ts` re-exports only boundary symbols. Both import from the `gateswarm-lite` package entry, so they share the **same module instance**. Mutable tier-boundary state (retraining, hot-reload) continues to work. `export *` is forbidden here: it would leak `scoreComplexity` / `EffortLevel` onto legacy module surfaces.
- Source-level resolution for dev tooling: `tsconfig.json` `paths` + `vite.config.ts` `resolve.alias` map `gateswarm-lite` → `packages/gateswarm-lite/src/index.ts` (and same for the router package), so `tsx`, `tsc --noEmit`, and `vitest` work without prebuilding packages.
- The gateway depends on `gateswarm-lite` only. It does **not** depend on `gateswarm-router`; the full proxy keeps its own provider routing.

### Target file tree (new / moved)

```
packages/
  gateswarm-lite/
    package.json
    tsconfig.json
    README.md
    src/
      types.ts              # EffortLevel
      feature-extractor.ts  # git mv from src/feature-extractor-v04.ts
      tier-boundaries.ts    # git mv from src/tier-boundaries.ts
      index.ts              # scoreComplexity + re-exports
      cli.ts
  gateswarm-router/
    package.json
    tsconfig.json
    README.md
    src/
      types.ts              # ModelSpec, RouteOptions, RouteDecision
      matrix.ts             # DEFAULT_MATRIX (data)
      select.ts             # selectModel, blendedCost, valueScore
      index.ts              # route()
      cli.ts
src/
  feature-extractor-v04.ts  # named re-export shim
  tier-boundaries.ts        # named re-export shim
  types.ts                  # EffortLevel re-exported from gateswarm-lite
tests/
  lite-parity.test.ts
  router-select.test.ts
  router-route.test.ts
```

## 4. Naming and versioning

- Layer 1 package: **`gateswarm-lite`**, version `0.1.0`.
- Layer 2 package: **`gateswarm-router`**, version `0.1.0`.
- The root gateway package is renamed **`gateswarm-gateway`** (its bin was already `gateswarm-gateway`), freeing the `gateswarm-router` name for layer 2.
- **Versioning policy (decided 2026-08-26):** independent SemVer per package — version numbers communicate each package's own API maturity, never the gateway lineage. The gateway was never published to npm (GitHub releases only), so there is no registry collision and `0.1.0` is correct for both new packages. Full policy (caret ranges, mutable-state coupling rule, lite 1.0 criteria): `docs/superpowers/specs/2026-08-26-package-structure-assessment.md` §Versioning.

## 5. Public API — `gateswarm-lite`

Zero runtime dependencies. Runs in Node ≥20, browsers, and edge runtimes. The library entry (`index.ts`) must not import Node APIs; only `cli.ts` may.

```typescript
export type EffortLevel = 'trivial' | 'light' | 'moderate' | 'heavy' | 'intensive' | 'extreme';

export interface ComplexityResult {
  score: number;           // 0–1 heuristic score
  tier: EffortLevel;       // scoreToEffort(score)
  wordCount: number;
  features: FeatureVector; // the 35 extracted features
  latencyMs: number;
}

export function scoreComplexity(prompt: string): ComplexityResult;

export const MAX_PROMPT_SIZE = 64 * 1024;

// Lower-level building blocks (signatures unchanged from today):
export { extractFeatures, heuristicScoreFromFeatures, countPromptWords }
export { scoreToEffort, setTierBoundaries, getTierBoundaries, getEffortRanges,
         EFFORT_RANGES, DEFAULT_BOUNDARIES, tierMidpoints }
export type { FeatureVector, TierBoundaries }
```

Behavioral guarantees:

- `scoreComplexity` truncates prompts above 64 KiB (`64 * 1024` characters) before scoring — same guard as `src/intent-engine-v04.ts`. Truncation is silent in the library (no `console.error`); the gateway shim path keeps its own logging.
- Latency is measured with `performance.now()` (sub-millisecond; `Date.now()` would usually report `0`).
- **Parity invariant:** for any prompt, `scoreComplexity(p).score` and `.tier` must equal the gateway's `scoreIntentSync(p).value` and `.tier`. A regression test enforces this.
- Empty string is a valid prompt: score it (do not throw). The CLI rejects empty input; the library does not.
- CLI: `gateswarm-lite "<prompt>"` (or stdin) prints `ComplexityResult` as JSON. If there is no argv prompt **and** stdin is a TTY, exit 1 immediately (do not hang on Windows). Otherwise read stdin. Exit 1 with `{"error":"..."}` on empty input.

## 6. Public API — `gateswarm-router`

Depends only on `gateswarm-lite`. Advisory-only: it returns a decision; it never calls a provider API, holds no API keys, and does no streaming/retries.

```typescript
export interface ModelSpec {
  id: string;              // e.g. "gpt-5-mini"
  provider: string;        // e.g. "openai"
  maxEffort: EffortLevel;  // highest tier this model handles reliably
  costPer1MInput: number;  // USD per 1M input tokens
  costPer1MOutput: number; // USD per 1M output tokens
  quality: number;         // (0, 1] relative quality estimate
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
  alternatives: ModelSpec[]; // up to 3 next-best capable models (excludes chosen)
  complexity: ComplexityResult;
  strategy: RoutingStrategy;
  reason: string;
}

export function selectModel(
  tier: EffortLevel,
  matrix: ModelSpec[],
  opts?: RouteOptions,
): { model: ModelSpec; alternatives: ModelSpec[]; reason: string };

export function route(prompt: string, opts?: RouteOptions): RouteDecision;
export const DEFAULT_MATRIX: ModelSpec[];
export const EFFORT_RANK: Record<EffortLevel, number>;
export function blendedCost(m: ModelSpec): number;
export function valueScore(m: ModelSpec): number;
```

Selection semantics:

- **Capability filter:** a model is *capable* if `EFFORT_RANK[maxEffort] >= EFFORT_RANK[tier]` (trivial=0 … extreme=5) and `quality >= minQuality`.
- **Blended cost:** `costPer1MInput * 0.25 + costPer1MOutput * 0.75` (output-weighted; typical chat workloads are output-heavy).
- **`cheapest-capable` (default):** among capable models, lowest blended cost wins; ties broken by higher quality.
- **`best-value`:** among capable models, highest `quality / (1 + blendedCost)` wins; ties broken by lower blended cost. The `+1` prevents near-free models from exploding the ratio.
- **Fallback:** if no model is capable (e.g. `extreme` tier with a weak matrix), pick the model with the highest `maxEffort` rank, ties broken by quality; `reason` contains the substring `falling back`.
- Switches over `RoutingStrategy` use a `never` default so a new strategy is a compile error until handled.
- The matrix is **data, not code**: `DEFAULT_MATRIX` ships as a reviewed starting point (prices are estimates and must be reviewed periodically); callers pass their own matrix for production use.
- CLI: `gateswarm-route "<prompt>"` prints the `RouteDecision` as JSON; `--strategy best-value` and `--matrix <file.json>` supported. Same TTY/stdin rule as the lite CLI. Invalid `--strategy` or unreadable matrix → exit 1 with JSON error.

### Default matrix (starting point)

Eight models spanning all six tiers. At least one model must be capable at `extreme`. Prices are USD/1M tokens, estimated 2026-08 — not a billing source of truth.

| id | provider | maxEffort | in / out | quality |
|----|----------|-----------|----------|---------|
| gemini-flash-lite | google | light | 0.10 / 0.40 | 0.55 |
| gpt-5-mini | openai | moderate | 0.25 / 2.00 | 0.70 |
| gemini-flash | google | moderate | 0.30 / 2.50 | 0.72 |
| deepseek-chat | deepseek | heavy | 0.27 / 1.10 | 0.74 |
| gemini-pro | google | intensive | 1.25 / 10.00 | 0.87 |
| gpt-5.2 | openai | intensive | 1.75 / 14.00 | 0.88 |
| claude-sonnet | anthropic | extreme | 3.00 / 15.00 | 0.92 |
| claude-opus | anthropic | extreme | 15.00 / 75.00 | 0.97 |

## 7. Migration mechanics

1. Root `package.json`: rename to `gateswarm-gateway`, add `"workspaces": ["packages/*"]`, add dependency `"gateswarm-lite": "0.1.0"`.
2. `git mv src/feature-extractor-v04.ts packages/gateswarm-lite/src/feature-extractor.ts` and `git mv src/tier-boundaries.ts packages/gateswarm-lite/src/tier-boundaries.ts` (history preserved). Do not edit those two files during the move.
3. `packages/gateswarm-lite/src/types.ts` defines `EffortLevel`. Root `src/types.ts` both `import type { EffortLevel }` (so existing interfaces in that file still type-check) and `export type { EffortLevel } from 'gateswarm-lite'`.
4. Named-export shims at the old paths. No other `src/`, `tests/`, or `eval/` file changes its import path.
5. `tsconfig.json` `paths` + `vite.config.ts` `resolve.alias` provide source-level package resolution for `tsx`/`vitest`/`tsc --noEmit`.
6. Root `build` script builds workspaces (`npm run build --workspaces --if-present`) before the gateway `tsc`. If root `tsconfig.build.json` emits `dist/packages`, exclude `packages` from that config.

## 8. Non-goals

- No request execution/proxying in the router (no provider SDKs, no API keys, no streaming). A thin executor can be added later as a separate package without breaking the advisory API.
- No device profiles in the new router (the existing `src/routing-matrix.ts` keeps that concern for the browser/gateway).
- No ML cascade/ordinal/embeddings in `gateswarm-lite` — heuristic-only, matching production behavior.
- No changes to gateway request behavior, eval pipeline logic, or the Python legacy (`router.py`, `train.py`).
- No publish to npm in this work; packages are workspace-local until a later release task.

## 9. Error handling

- `scoreComplexity`: non-finite scores are impossible from the heuristic path; `scoreToEffort` already guards non-finite input by returning `'moderate'` (existing behavior, unchanged).
- `selectModel` with an empty matrix throws `Error('gateswarm-router: matrix is empty')` — a caller bug, fail fast.
- CLI entrypoints exit 1 with a JSON error object on invalid input (empty prompt, unreadable matrix file, unknown strategy). They never throw an uncaught exception for those cases.

## 10. Testing (summary)

Full procedure, golden prompts, and refinement loop: `docs/superpowers/specs/2026-08-25-gateswarm-lite-router-testing.md`.

Must-pass before calling the extraction done:

- Parity: `scoreComplexity` vs `scoreIntentSync` on a fixture set.
- Existing `npm test`, `npm run typecheck`, `npm run check:consistency` green through the shims.
- Router unit tests: capability filter, both strategies, tie-break, fallback, empty matrix, `minQuality`, alternatives cap.
- `DEFAULT_MATRIX` well-formed and capable at every tier.
- Both packages build standalone; CLIs smoke-tested from `dist/`.

## 11. Success criteria

1. `import { scoreComplexity } from 'gateswarm-lite'` works with zero runtime dependencies in Node (and is browser-safe: no Node imports in `index.ts`).
2. `route(prompt)` returns the cheapest capable model for the scored tier, with alternatives and reasoning, typically well under 5 ms.
3. The gateway, tests, and eval pipeline behave identically before and after the refactor (parity test + full suite green).
4. Tier boundaries remain retrainable: `eval:refit-boundaries` output still feeds the same `setTierBoundaries` the lite package exports.

## 12. Risks

| Risk | Mitigation |
|------|------------|
| Score drift during extraction | Files moved verbatim (`git mv`); parity test locks score/tier equality |
| Workspace resolution breaks tsx/vitest | Source-level `paths` + vite alias; verified in plan Task 1 before any move |
| Dual module instances of tier-boundary state | Both shims import from the package entry; no duplicate implementation remains in `src/` |
| `export *` pollutes legacy module surfaces | Named re-exports only |
| CLI hangs on Windows with no args | Fail fast when stdin is a TTY |
| npm name repurpose confuses existing users | README callout + version strategy (Section 4) |
| Default matrix prices go stale | Matrix is data with a review note; callers supply their own in production |
