# GateSwarm Tier Routing — Architecture Review & Improvement Plan

**Date:** 2026-07-11
**Input:** `eval/reports/routing-hybrid-20260711-1439/` (verdict: NOT VERIFIED)
**Companion doc:** `docs/ACCURACY_ROADMAP.md` (this plan re-prioritizes it with new evidence)

---

## 1. Architecture review (score → ensemble → tier → model)

```
prompt
 ├─ extractFeatures()               28 features (feature-extractor-v04.ts)
 ├─ heuristicScoreFromFeatures()    hand-weighted linear sum, length-dominant
 ├─ ensembleVote()                  effectively heuristic-only:
 │     cascade: weight 0, weights never loaded (dead slot)
 │     RAG:     optional 0.2 nudge, absent on cold prompts
 │     history: additive ±0.1, needs ≥5 feedback rows (store is EMPTY)
 ├─ scoreToEffort()                 5 cuts [0.21, 0.28, 0.32, 0.37, 0.46]
 └─ tier_models[tier]               model + fallback chain (v04_config.json)
```

### Findings (ranked by impact)

**A1 — Stale boundaries after score-scale change (primary cause of this run's failure).**
Commit `b57e59b` (v0.5.6-bug6) added `compoundScore` (up to +0.12) and expanded the
tech vocabulary, shifting the score distribution upward — but the 5 cut points were
never re-fit. Result: systematic over-routing (heavy→extreme 13/15, moderate→heavy/extreme
10/15). Measured on this run's scores, the *current* cuts yield 44.4% exact while
*optimal* cuts on the same scores yield **63.3%** — ~19pp lost to boundary
miscalibration alone. The optimal cuts are ≈ `[0.22, 0.30, 0.43, 0.54, 0.55]`:
the real moderate band is ~[0.30, 0.43], not [0.28, 0.32); the configured heavy band
[0.32, 0.37) contains almost no actual heavy-gold scores (heavy p25 = 0.450).

**A2 — Score is non-monotonic in gold tier: heavy > intensive.**
Per-tier score medians: moderate 0.341, **heavy 0.470, intensive 0.418**, extreme 0.585.
Heavy prompts ("implement LRU cache / rate limiter / parser") are dense in code
keywords, imperatives, and tech terms — every lexical feature fires. Intensive prompts
("checkout latency spiked… figure out if it's the cache or the pool") are diagnostic
prose: long, but few keyword hits. The linear sum therefore ranks heavy *above*
intensive. **No boundary placement can fix an ordering inversion** — even optimal cuts
leave intensive recall at 1/15. This is the feature-representation gap
ACCURACY_ROADMAP §1.2 predicted, now with a precise signature.

**A3 — Cross-component constants live on a dead scale.**
`tierComplexityMap` (ensemble-voter.ts) and `tierScores` (intent-engine-v04.ts) map
tiers to scores `{heavy: 0.50, intensive: 0.70, extreme: 0.90}` — but under current
boundaries, **everything ≥0.46 is extreme**. A RAG neighbor labeled "heavy" nudges the
score toward 0.50 = extreme territory. `cascadeThresholds` still defaults to the
pre-v0.5.2 cuts `[0.08, 0.18, 0.32, 0.52, 0.72]`. These constants were calibrated for
the old scale and were never migrated. Any future warm-RAG run will inherit this bias.

**B1 — The "ensemble" is a single heuristic.** Confirmed empirically: all four ablation
modes identical (48.9%), `data/feedback/` is empty, RAG store cold. Cascade slot has
never held a model. The ensemble machinery adds complexity and failure surface today
without adding signal.

**B2 — Dual heuristic drift.** `intent-engine.ts:v33Score` (browser path, 9-signal
formula) and `feature-extractor-v04.ts:heuristicScoreFromFeatures` (server path,
28-feature formula) produce *different score distributions* but flow through the *same*
boundaries. The boundaries can be correct for at most one path; the browser path
silently misroutes.

**B3 — Gateway serves provider errors as answers (live-quality "failures" are infra).**
The intensive/extreme judge failures are literally
`"Failed to authenticate. API Error: 401 Invalid authentication credentials"`
(codex-cli) returned with HTTP 200 and judged 0–1. The configured fallback chain
(glm-5, deepseek-v4-pro, …) did **not** engage on auth failure. Trivial's 2.40 judge
mean comes from **empty-body 200s** from `deepseek-v4-flash-free`, which the rubric
does not fail (empty content only fails on timeout). Heavy had 3 hard timeouts.
→ The tier→model quality claim was **not actually measured** for intensive/extreme;
it was an auth outage measurement.

**B4 — Eval hygiene gaps.** Boundaries historically fit on the same 90 prompts they're
scored on (leak; roadmap §3 built splits — use them). n=15/tier offline and n=5/tier
live are underpowered for per-tier floors. Eval `MAX_TOKENS` disagrees with config
`tier_models[*].max_tokens`. Runtime routing config drifts from committed defaults
(trivial routed to `opencode-free/deepseek-v4-flash-free`, config says
`ollama/qwen2.5:0.5b` with zai fallbacks).

---

## 2. What the eval actually established

| Claim component | Verdict | Evidence |
|---|---|---|
| Scoring ranks prompts sensibly | Mostly (Spearman 0.793) | except heavy↔intensive inversion (A2) |
| Cuts convert score→tier well | **No** | 44.4% vs 63.3% achievable on same scores (A1) |
| Ensemble adds signal | **Unproven** | cold stores; ablation flat (B1) |
| Tier→model gives quality | **Unmeasured** for intensive/extreme/trivial | 401s, empty bodies, timeouts (B3) |
| Critical probes | Pass | greetings→trivial, async/await ≥ light |

Ceiling analysis (this run's scores): optimal 5 cuts → 63.3% exact / 78.9% adjacent;
if heavy+intensive were one class → 73.3%. So: **~19pp available from recalibration,
~10pp more requires features that separate heavy from intensive, remainder needs a
learned model + more data.**

---

## 3. Improvement plan

### Phase 0 — Reliability & measurement fixes (1–2 days) — do first

| # | Fix | Where | Gate |
|---|---|---|---|
| 0.1 | Provider error → engage fallback chain: non-2xx/auth-error/empty-body from a provider must trigger `fallback_models`, never be served as content. Add credential preflight per provider at startup; mark unhealthy providers and skip them. | gateway (moma-gateway.ts) | live re-run: 0 rows containing provider error text; 0 empty-body 200s |
| 0.2 | Rubric hard-fails: empty content on HTTP 200; known provider-error patterns. | eval/lib/hybrid-rubric.ts | rubric catches all B3 rows |
| 0.3 | Health-aware skip + per-provider timeout policy in the live eval; record `skipped(reason)` instead of judging garbage. | eval/hybrid-routing-eval.ts | judge n reflects real answers only |
| 0.4 | Warm-store ablation: seed RAG index + feedback store from fixtures before Phase 2 ablation; otherwise print `ABLATION_INVALID (cold stores)` and exclude from verdict. | eval/lib/hybrid-ablation.ts | ablation deltas become interpretable |

### Phase 1 — Recalibrate & unify the scale (1 day)

| # | Fix | Gate |
|---|---|---|
| 1.1 | Re-fit the 5 cuts on the **train split only** (`eval/splits/train.v1.json`), report 5-fold CV. This is the one permitted boundary re-fit (score scale changed in `b57e59b`); freeze after. Expected ≈ +12–18pp exact held-out. | CV exact ≥ 55%; no tier recall < 25% except intensive (known A2 limit) |
| 1.2 | Derive `tierComplexityMap` / `tierScores` / cascade thresholds from the live boundaries (band midpoints from config) — delete the three hardcoded copies. | RAG nudge toward "heavy" lands inside the heavy band |
| 1.3 | Single scoring module: server formula compiled for browser too; delete or alias `v33Score`'s divergent formula. | browser and server produce identical scores on a shared test vector |
| 1.4 | Add a **score-distribution drift guard** to CI: per-tier median scores on the golden set vs the boundaries; fail if any tier's median leaves its band (this is what would have caught `b57e59b`). | CI red on future scale shifts |

### Phase 2 — Features that break the heavy↔intensive inversion (2–3 days)

Targeted at the A2 signature (implement-one-thing vs diagnose/redesign-under-constraints):

- **Decomposition:** `requirement_count` (musts/bullets/numbered items), `distinct_imperative_verbs`, `question_count`, `conjunction/enumeration count` (roadmap §4.2).
- **Scale/quantity signals:** numbers-with-units (`50MB`, `2M events/sec`, `sub-100ms`, `40-billion-row`, `five regions`) — currently invisible, near-perfect intensive/extreme markers in the dataset.
- **Diagnostic/causal markers:** "figure out which/why", "not sure if it's X or Y", "spiked from X to Y", "after the last deploy" → intensive.
- **Cut the 10 dead features** (MI < 0.03 per feature-report) before any model fit.
- **Real tokenizer** for length (roadmap §4.1).

Gate: heavy & intensive recall ≥ 40% each on CV, adjacent ≥ 80%, no other tier drops >5pp.

### Phase 3 — Learned ordinal model in the cascade slot (2 days, roadmap §5)

Ordinal logistic regression over the (pruned + Phase 2) features; isotonic/Platt
calibration; confidence = calibrated max-prob (replaces margin proxy, current ECE 0.232);
abstention → conservative neighbor on near-ties. Boundaries retire from the hot path.
Gate: ≥ +3pp exact over Phase 2 CV, ECE ≤ 0.10.

### Phase 4 — Ensemble honesty (parallel)

With warm-store ablation (0.4) as the instrument: keep RAG/history only if each shows
≥ +1pp exact warm-vs-cold; otherwise set weights to 0 in config and simplify
`ensembleVote` to the paths that exist. Wire the Phase 3 model into the cascade slot
(it already exists at weight 0).

### Phase 5 — Per-tier quality & cost (parallel)

- Trivial: after 0.1 (empty-body → fallback), re-measure; if judge still < 3.0, promote `zai/glm-4.7-flash` to primary (verdict rec #5).
- Heavy/intensive/extreme: fix codex-cli auth; keep timeout policy from 0.3.
- Increase live sample to ≥ 10/tier so per-tier judge floors have power.
- Track over-route cost: signed bias × tier-cost delta (already proposed in roadmap §7.1).

### Ongoing — Dataset growth (roadmap §6)

≥ 50 prompts/tier stratified, hard negatives seeded from this run's misroutes
(especially heavy-that-looks-extreme and intensive-that-scores-low), frozen hash-pinned
splits, labels never from the same LLM family being evaluated.

---

## 4. Sequencing & expected trajectory

| Step | Exact (CV, expected) | What unblocks it |
|---|---|---|
| Today | 44.4% (this run) / 44.4% ± 6.1% (CV) | — |
| Phase 1 recalibration | ~55–60% | boundaries match current score scale |
| Phase 2 features | ~62–68% | heavy↔intensive separable |
| Phase 3 ordinal model | +3–5pp, calibrated confidence | interactions + abstention |
| Phase 5 | live per-tier judge ≥ 3.0 everywhere | infra, not ML |

Phases 0 and 1 are independent and together address every FAIL in the verdict except
the intrinsic heavy/intensive overlap (Phase 2). Re-run
`eval/hybrid-routing-eval.ts` after Phase 0+1 for an honest verdict; re-run warm
ablation after 0.4.
