# GateSwarm Lite + Router — Testing and Refinement Playbook

**Date:** 2026-08-25
**Status:** Companion to the design spec
**Spec:** `docs/superpowers/specs/2026-08-25-gateswarm-lite-router-design.md`
**Plan:** `docs/superpowers/plans/2026-08-25-gateswarm-lite-router.md`

This document is how we know the two-layer split is correct, and how we improve scoring and routing after the extraction without breaking parity.

The product goal is: **score a prompt, then address it to the cheapest capable model for that complexity.** Tests lock the first half (score/tier identity with the gateway). The second half is locked by selection semantics plus a golden routing table against a *fixed* fixture matrix — never against live vendor prices.

---

## 1. What “correct” means

| Layer | Correctness | Not in scope |
|-------|-------------|--------------|
| `gateswarm-lite` | Same `score` and `tier` as `scoreIntentSync` for every prompt | Matching a human’s subjective “this feels heavy” |
| `gateswarm-router` | Given `(tier, matrix, strategy)`, the chosen `model.id` is deterministic per the spec | That the default matrix prices are current |
| Gateway after extraction | Existing tests and eval scripts still pass via shims | Changing proxy/provider behavior |

If a golden prompt’s *absolute* tier looks wrong to a human, that is a **scorer calibration** issue. Fix it with the eval pipeline (Section 6), not by special-casing the router.

---

## 2. Test inventory (must exist after implementation)

| File | Owns |
|------|------|
| `tests/lite-parity.test.ts` | `scoreComplexity` ≡ `scoreIntentSync` on the golden prompt set; 64 KiB truncate; result shape |
| `tests/router-select.test.ts` | empty matrix, capability filter, both strategies, quality tie-break, `minQuality`, fallback, alternatives ≤ 3, `blendedCost` 25/75, `valueScore`, `DEFAULT_MATRIX` well-formed and capable at every tier |
| `tests/router-route.test.ts` | `route()` wires scorer + `selectModel`; custom matrix and strategy pass through |
| Existing `tests/feature-extractor-v04.test.ts`, `tests/tier-boundaries.test.ts`, `tests/intent-engine.test.ts` | Prove shims did not change gateway imports |
| `tests/router-golden.test.ts` | Frozen routing table against `GOLDEN_MATRIX` (Section 4) |

Commands (repo root, PowerShell):

```powershell
npm test
npm run typecheck
npm run check:consistency
npm run build
node packages/gateswarm-lite/dist/cli.js "What is the capital of France?"
node packages/gateswarm-router/dist/cli.js "Design a distributed cache with failover" --strategy best-value
```

Expected: all tests pass; both CLIs print JSON; lite has `score`/`tier`; router has `model`/`complexity`/`reason`.

CLI hang check (Windows-critical):

```powershell
node packages/gateswarm-lite/dist/cli.js
```

Expected: exit code 1 immediately, stderr `{"error":"..."}` — process must not wait on stdin when stdin is a TTY.

---

## 3. Golden prompt set (complexity)

Use these strings in `tests/lite-parity.test.ts`. They are chosen to exercise length, code, architecture, and diagnostic signals — not to assert a specific tier in the parity test. Parity only asserts lite ≡ gateway.

| id | Prompt |
|----|--------|
| g1 | `hi` |
| g2 | `What is the capital of France?` |
| g3 | `Rewrite this sentence to be more formal: we gotta ship it asap` |
| g4 | `Summarize the differences between TCP and UDP in one paragraph.` |
| g5 | `Write a Python function that parses a CSV file and returns the top 5 rows sorted by revenue, with unit tests.` |
| g6 | `Design a microservices architecture for a real-time trading platform, including failure modes, data consistency strategy, and a migration plan from the current monolith.` |
| g7 | `Explain async/await` |
| g8 | empty string `''` |
| g9 | a 100 KB string (`'analyze this system '.repeat(5000)`) — truncate path |

Optional snapshot (add only after the first green parity run): a table of `{ id, score, tier }` written into `tests/fixtures/lite-score-snapshot.json`. On later PRs, fail if any score drifts by more than `1e-12` or the tier changes. That snapshot is regenerated **only** when `feature-extractor.ts` or `DEFAULT_BOUNDARIES` change on purpose, and the PR must say so.

### 3.1 External corpus: MLJAR AI prompts (added 2026-08-25)

`tests/mljar-corpus.test.ts` runs the full [mljar.com/ai-prompts](https://mljar.com/ai-prompts/) library — 678 real-world, role-organized prompts for data/ML/engineering work — through scorer and router:

| Artifact | Purpose |
|----------|---------|
| `tests/fixtures/mljar-prompts.json` | The corpus (fetched via `npm run corpus:build`) |
| `tests/fixtures/mljar-score-snapshot.json` | Frozen `{id → score, tier}` drift lock |
| `scripts/simulate-mljar-prompts.ts` (`npm run simulate:prompts`) | Distribution/latency/capability report; `-- --write-snapshot` regenerates the snapshot |
| `tests/mljar-corpus.test.ts` | Integrity + full-corpus parity + router capability invariant + snapshot lock |

Snapshot rules are identical to Section 3: regenerate **only** with an intentional extractor/boundary change, and say so in the PR. Baseline observation at freeze time (2026-08-25): the corpus scores 100% `extreme` (long structured engineering prompts saturate the heuristic; raw-score spread lives in `npm run simulate:prompts` output). Tier saturation is a calibration topic for the eval pipeline — not a router defect.

---

## 4. Golden routing table (addressing)

Do **not** freeze `DEFAULT_MATRIX` model ids in assertions — prices and names will change. Freeze a tiny `GOLDEN_MATRIX` inside `tests/router-golden.test.ts`:

```typescript
const GOLDEN_MATRIX: ModelSpec[] = [
  { id: 'nano',  provider: 'x', maxEffort: 'light',     costPer1MInput: 0.10, costPer1MOutput: 0.40,  quality: 0.50 },
  { id: 'small', provider: 'x', maxEffort: 'moderate',  costPer1MInput: 0.40, costPer1MOutput: 1.60,  quality: 0.70 },
  { id: 'mid',   provider: 'x', maxEffort: 'heavy',     costPer1MInput: 0.80, costPer1MOutput: 3.20,  quality: 0.80 },
  { id: 'big',   provider: 'x', maxEffort: 'extreme',   costPer1MInput: 5.00, costPer1MOutput: 20.00, quality: 0.95 },
];
```

Expected `selectModel` winners (strategy `cheapest-capable`, `minQuality` 0):

| tier | model.id | why |
|------|----------|-----|
| trivial | nano | cheapest among all capable (all four can do trivial) |
| light | nano | nano.maxEffort === light |
| moderate | small | nano is not capable |
| heavy | mid | nano/small not capable |
| intensive | big | only big ≥ intensive |
| extreme | big | only big ≥ extreme |

`best-value` at `extreme` must still pick `big` (only capable). At `trivial`, compute `valueScore` and assert the max; do not hard-code a guess if you change costs — derive expected id in the test from `valueScore`.

`route(prompt, { matrix: GOLDEN_MATRIX })` must equal `selectModel(scoreComplexity(prompt).tier, GOLDEN_MATRIX)` for g1–g7.

---

## 5. Acceptance checklist (extraction done)

Print this as a checklist in the implementing PR:

- [ ] `gateswarm-lite` `package.json` has no `dependencies` and no `optionalDependencies`.
- [ ] `gateswarm-router` `dependencies` is only `{ "gateswarm-lite": "0.1.0" }`.
- [ ] `packages/gateswarm-lite/src/index.ts` does not import `node:` or `fs`/`process`.
- [ ] `src/feature-extractor-v04.ts` and `src/tier-boundaries.ts` are named shims (no `export *`).
- [ ] `git log --follow packages/gateswarm-lite/src/feature-extractor.ts` shows pre-move history.
- [ ] `npm test` / `typecheck` / `check:consistency` / `build` all exit 0.
- [ ] Parity test covers g1–g9.
- [ ] Golden routing table (Section 4) is green.
- [ ] CLIs do not hang with no args on a TTY.
- [ ] Root package name is `gateswarm-gateway`; workspace packages are `gateswarm-lite` and `gateswarm-router`.

---

## 6. Refining the scorer (after extraction)

The heuristic and cut points stay the production ones. Improve them only through the existing eval pipeline, which must keep importing via the shims (or later switch to `gateswarm-lite` — same module).

| Goal | Command | Writes |
|------|---------|--------|
| Refit 5 cut points on labeled data | `npm run eval:refit-boundaries` | candidate boundaries; apply with `setTierBoundaries` |
| Calibrate / report | `npm run eval:calibrate` | metrics vs labels |
| Gate a candidate model/weights | `npm run eval:gate` | pass/fail |
| Feature ablation / report | `npm run eval:features` | which signals move mid-band accuracy |
| Consistency of gateway providers | `npm run check:consistency` | unrelated to lite, still required CI |

Rules:

1. Never hand-edit `DEFAULT_BOUNDARIES` in a router PR. Boundary changes are their own PR, with eval numbers in the description.
2. Never add embeddings, cascade, or ordinal loading to `gateswarm-lite`. If a learned scorer ships later, it is a different package or an opt-in export — not the default `scoreComplexity`.
3. After any extractor or boundary change, regenerate the optional score snapshot (Section 3) and re-run parity.

### 6.1 North star: model-complexity fit (`npm run fit:report`)

The product goal of the scorer is **fit**: boundaries should split real traffic so each band routes to the cheapest capable model for the work actually required in that band. Every scorer/router PR states its effect on fit (or why it is N/A). The review loop:

```
npm run fit:report            # where does traffic sit vs cut points? what does moving them cost/save?
        │
        ▼
labeling priority queue       # prompts within ±eps of a boundary, ranked by $ swing — judge these first
        │
        ▼
eval:refit-boundaries         # fit candidates on labeled data (train split only)
eval:calibrate / eval:gate    # approve or reject with metrics
        │
        ▼
own PR: DEFAULT_BOUNDARIES + regenerate BOTH snapshots (§3, §3.1) → full suite green
        │
        ▼
npm run fit:report            # confirm resolution improved; repeat
```

Interpretation guide: a boundary with no nearby traffic is either safely clear or useless — only labeled data can say which. Saturation above the top boundary means the router cannot differentiate there regardless of matrix quality; that is a scorer-calibration problem, never a `selectModel` problem.

Human-in-the-loop check (optional, not CI): pick 20 real prompts from your traffic, score them, and mark whether the tier feels one band off. Adjacent-band error is historically acceptable (~86% adjacent accuracy in the heuristic comments); exact-tier misses in the mid-band are the usual calibration target.

---

## 7. Refining the matrix (how we pick the “best” model)

“Best” is defined by the strategy, not by a vendor leaderboard.

1. **Production callers pass `RouteOptions.matrix`.** `DEFAULT_MATRIX` is a demo. Treat its prices as stale the day after merge.
2. Refresh procedure:
   - Update `costPer1MInput` / `costPer1MOutput` from the provider price sheet.
   - Set `maxEffort` from observed failure: if a model consistently fails `heavy` tasks, drop `maxEffort` one rank — do not hack `selectModel`.
   - Set `quality` as a relative 0–1 within *your* matrix only (not an absolute Elo).
3. Re-run `tests/router-select.test.ts` `DEFAULT_MATRIX` well-formed tests after edits.
4. Do not change blended-cost weights (0.25 / 0.75) without a new spec revision. If a caller is input-heavy (embeddings, RAG ingest), they pass a custom matrix with costs already reflecting that, or a future `RouteOptions.costBlend` — out of scope now.

---

## 8. Manual smoke (two minutes)

```powershell
# Layer 1 — complexity only
npx tsx packages/gateswarm-lite/src/cli.ts "hi"
npx tsx packages/gateswarm-lite/src/cli.ts "Design a microservices architecture for a real-time trading platform, including failure modes and a migration plan."

# Layer 2 — address to a model
npx tsx packages/gateswarm-router/src/cli.ts "hi"
npx tsx packages/gateswarm-router/src/cli.ts "Design a microservices architecture for a real-time trading platform, including failure modes and a migration plan." --strategy cheapest-capable
npx tsx packages/gateswarm-router/src/cli.ts "Design a microservices architecture for a real-time trading platform, including failure modes and a migration plan." --strategy best-value
```

Sanity: the second prompt must score a higher tier than `hi`, and the chosen model’s `maxEffort` rank must be ≥ that tier (unless the reason says `falling back`).

---

## 9. What we will not test

- Live HTTP calls to OpenAI/Anthropic/Google.
- Token-accurate cost (no tiktoken in these packages).
- Gateway `/v1/chat/completions` behavior (already covered elsewhere).
- Browser bundle size (nice-to-have later; library has zero deps so this is low risk).

---

## 10. When to stop refining

The extraction is successful when Section 5 is all checked. Further scorer/matrix work is product iteration, not a blocker. Do not delay the split to “get DEFAULT_MATRIX prices perfect.”
