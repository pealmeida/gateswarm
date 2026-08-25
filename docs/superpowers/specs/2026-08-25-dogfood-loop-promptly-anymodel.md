# Dogfood Loop Architecture — Promptly × AnyModel × GateSwarm

**Date:** 2026-08-25
**Status:** Proposal — architecture for "eat your own dog food" data flywheel
**Builds on:** `2026-08-25-gateswarm-lite-router-design.md`, testing playbook §6–§7
**Principle:** GateSwarm scores and routes Promptly/AnyModel traffic in production, captures every interaction, and turns that traffic into the labeled golden dataset that recalibrates the scorer — the system improves by using itself.

---

## 1. Roles (who eats what)

| Component | Role | Consumes | Emits |
|---|---|---|---|
| **Promptly** | Prompt library + review UI. Saves prompts with project/use-case tags, versions them, hosts the human labeling queue. | `gateswarm-lite` only (browser-safe) | saved prompts, gold/judged labels |
| **AnyModel** | Executor plugin layer. Takes a routing *decision*, executes across providers, standardizes outcomes. | `gateswarm-router` (+ lite transitively) | outcomes, costs, failure signals |
| **gateswarm-lite** | The scorer under test. | prompt | `ComplexityResult` |
| **gateswarm-router** | The policy under test. | tier + matrix | `RouteDecision` |
| **gateway (this repo)** | Proxy mode for OpenAI-compatible clients; reference implementation of capture. | everything above | same events via its own path |

Dogfood rule: **no synthetic-only calibration.** Every boundary or matrix change must trace to captured real interactions.

## 2. Dataflow

```
                    ┌────────────────────────────────────────────┐
                    │                PROMPTLY                     │
                    │  save/tag/version prompts · review queue    │
                    └───────┬───────────────────────▲────────────┘
                            │ prompt + context      │ gold/judged labels
                            ▼                       │
 user ──► prompt ──► [gateswarm-lite]──► tier ──► [gateswarm-router]──► RouteDecision
                            │                       │                 │
                            │      InteractionEvent │                 ▼
                            ▼                       ▼          [ANYMODEL executes]
                     ┌──────────────────────────────────┐   provider APIs
                     │  TELEMETRY STORE (append-only)   │        │
                     │  events.jsonl / SQLite/project   │◄───────┘ outcome
                     └───────┬──────────────────────────┘
                             │ export (label ladder: bronze→silver→gold)
                             ▼
                     ┌──────────────────────────────────┐
                     │  EVAL PIPELINE (this repo)       │
                     │  calibrate · refit-boundaries    │
                     │  calibration-gate · features     │
                     └───────┬──────────────────────────┘
                             │ approved proposal (own PR)
                             ▼
              setTierBoundaries() / DEFAULT_BOUNDARIES + matrix data
                             │
                             ▼
                  next request is scored better  ⟲ flywheel
```

## 3. Contracts

### 3.1 Package dependencies (unchanged public APIs)

- Promptly → `gateswarm-lite@^0.1.0` — zero deps, runs in browser.
- AnyModel → `gateswarm-router@^0.1.0` — advisory only; AnyModel owns execution, keys, retries.
- Known spec-sanctioned gap worth adding early: **precomputed tier input**. Design §1 says layer 2 accepts "a prompt *(or a precomputed tier)*"; today `route()` takes prompts only. Add `RouteOptions.tier?: EffortLevel` (skip lite scoring when provided) so AnyModel can replay stored tiers and A/B scorers without re-scoring. Small, additive, backward compatible.

### 3.2 InteractionEvent v1 (the atom of the golden dataset)

One JSON line per request, written **after** outcome resolves. Schema-versioned like `OrganicLabelRow` (writer + reader share the type).

```typescript
interface InteractionEventV1 {
  version: 1;
  eventId: string;            // uuid
  ts: number;                 // epoch ms
  project: string;            // use-case/project slug ("promptly-blog", "anymodel-support")
  useCase?: string;           // free tag ("summarize", "code-review")
  promptHash: string;         // sha256(prompt) — dedupe/join key
  promptChars: number;
  promptSnippet: string;      // ≤256 chars, REDACTED (src/redact.ts)
  promptFull?: string;        // optional opt-in store, also redacted, ≤32_768 (organic-labels cap)

  // Layer 1 observation
  score: number;              // scoreComplexity().score
  tier: EffortLevel;
  extractorVersion: string;   // e.g. "v04+phase2", boundaries hash below
  boundariesHash: string;     // hash(getTierBoundaries()) at decision time

  // Layer 2 observation
  strategy: RoutingStrategy;
  chosenModelId: string;
  chosenProvider: string;
  matrixVersion: string;      // hash of matrix rows used
  alternatives: string[];     // ids only, ≤3
  reason: string;

  // Execution observation (from AnyModel; absent if caller executed elsewhere)
  ok: boolean;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;           // actual, from provider metering
  errorClass?: string;        // "rate_limit" | "timeout" | "quality_reject" | ...

  // Signals (fill the label ladder, §4)
  regenerated?: boolean;      // user hit regenerate → implicit negative
  acceptedFirst?: boolean;    // response kept without edit → implicit positive
  thumbsUp?: boolean;         // explicit
  judgedTier?: EffortLevel;   // human review verdict (Promptly queue)
}
```

Rules:
- Redact before persist (`src/redact.ts`). Full text storage is opt-in per project.
- Append-only; never mutate past events — corrections are new events.
- One store **per project** (see §5), so a project can be exported/shared independently.

## 4. Label ladder → golden dataset

Reuses the provenance model already implemented in `src/label-combiner.ts` (bronze/silver/gold weights + phase gating `disabled → low → full`) and `src/training-mode.ts` consensus:

| Rank | Source | Meaning | Auto? |
|---|---|---|---|
| bronze | execution outcomes only | ok/error/latency/cost signals | ✅ |
| silver | weak user signal | `regenerated` (negative), `acceptedFirst` (positive) | ✅ |
| gold | human judgment | Promptly review queue sets `judgedTier`; maps to `provenance: 'judged' \| 'gold'` | 🧑 |

Golden dataset = all events with `judgedTier` present, joined with their scoring observations. Export shape matches the organic pipeline:

```
{ promptHash, prompt, predictedTier, actualTier, agreed,
  agentId: "promptly:<project>", ts }   // ← OrganicLabelRow-compatible
```

Phase gating stays honest: consensus/calibration features stay `disabled` until interaction counts cross the existing thresholds — do not shortcut them.

## 5. Storage layout

```
~/.gateswarm/
  telemetry/
    <project>/events.jsonl        # append-only InteractionEventV1 lines
    <project>/index.sqlite        # optional: vote-persistence-style SQLite mirror
  datasets/
    <project>/golden-<date>.jsonl # exported labeled sets (gold first, silver flagged)
```

- JSONL primary (zero-dep, greppable, diffable); SQLite mirror optional for dashboards (pattern already exists in `src/vote-persistence.ts`).
- Retention: raw events ≥90 days local; exports are permanent (that IS the dataset).
- Privacy: snippet/full-text flags are per-project config; hashes always stored so datasets join without text.

## 6. Calibration closed loop (scorer)

1. `npm run corpus:simulate` style reporting extended with `--project <slug>` slices (simulate script already computes distributions; add input = telemetry export).
2. Export golden set from Promptly reviews → adapter feeds `eval/lib/dataset.js` loaders (same shape refit already consumes).
3. `npm run eval:refit-boundaries` → candidate cut points + CV metrics into `eval/reports`.
4. `npm run eval:gate` approves/rejects.
5. Apply: runtime hot-reload via `setTierBoundaries()` for experiments; promoted cut points land as an **own PR** editing `DEFAULT_BOUNDARIES`, regenerating BOTH snapshots (`lite-score-snapshot.json`, `mljar-score-snapshot.json`), suite green.
6. Parity invariant is untouched: Promptly/AnyModel call the same `scoreComplexity` module the gateway shims expose — one module instance everywhere (workspace link).

## 7. Policy closed loop (matrix/providers)

Per project matrix files (`matrix.<project>.json`), reviewed like data (testing spec §7):

- **maxEffort demotion:** model fails tier T repeatedly (`errorClass: quality_reject` rate > threshold in events) → drop one rank. Never hack `selectModel`.
- **quality as win-rate:** relative quality per project = accepted-first rate normalized within your matrix (not absolute Elo).
- **prices:** refresh from provider sheets quarterly; `costUsd` from events validates blendedCost assumptions (25/75 weights stay fixed without a spec revision).
- **strategy fit per project:** compare realized costUsd between cheapest-capable and best-value cohorts in the events; projects with hard quality floors pin `minQuality`.

## 8. What this does NOT change

- No executor inside `gateswarm-router` (advisory invariant holds; AnyModel is the executor).
- No ML/embeddings in `gateswarm-lite`.
- No gateway proxy behavior change — gateway remains the reference capture implementation.
- No npm publishing required to run the loop (workspace links suffice).

## 9. Phased roadmap

| Phase | Deliverable | Exit criteria |
|---|---|---|
| P0 | `InteractionEventV1` schema + JSONL sink util (new small module, e.g. `packages/gateswarm-telemetry` or gateway-side `src/telemetry.ts`) | events append + redact + hash round-trip tested |
| P1 | Wire capture in gateway path + AnyModel executor callback | every routed request yields exactly one event |
| P2 | Dogfood internally: route this repo's own dev/eval prompts through the stack | 500+ real events across ≥3 projects |
| P3 | Promptly review queue (batch tier judgments) writing gold labels | ≥100 gold labels |
| P4 | Eval adapter + first boundary-refit PR from organic gold set | gate-approved proposal merged with eval numbers |
| P5 | Per-project matrices + cost dashboards from events | measurable cost-per-solved-task delta |

## 10. Risks

| Risk | Mitigation |
|---|---|
| Label bias (only angry users judge) | review queue samples stratified by tier/score decile, not just failures |
| Feedback loop self-confirming | hold out N% of events from any fitting; keep MLJAR/g-set snapshots as external drift alarms |
| PII leakage into datasets | redact-by-default, full-text opt-in, hash joins |
| Boundary churn | phase gating + `eval:gate` + own-PR rule unchanged |
| Matrix overfit to one workload | matrices are per-project data; DEFAULT_MATRIX stays demo-only |
