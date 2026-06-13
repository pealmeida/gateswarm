# GateSwarm Router — Accuracy Roadmap (Richer Features, Not Boundary Tuning)

**Status:** proposal / working doc
**Owner:** routing team
**Scope:** push exact + adjacent accuracy on both routing dimensions — **effort tier**
(`scoreIntent`) and **plan/act mode** (`detectIntentMode`) — by adding *signal*
(richer features + a learned model), explicitly **not** by re-fitting tier
boundaries.

---

## 0. TL;DR

The current classifier is a **hand-weighted linear sum over 28 features**
(`heuristicScoreFromFeatures`), dominated by prompt length, mapped to tiers by 5
cut-points. The "ensemble" is heuristic-only: the cascade (the one component that
was meant to be a *learned* model) has never been loaded and runs at weight 0; RAG
and history bias are near-inert on cold prompts.

We have already squeezed most of what boundary tuning can give (exact 26.7% →
45.6%). The remaining error is concentrated in the **moderate / heavy / intensive**
band (~20–40% exact), where tiers overlap on length alone. Moving the cut-points
around trades one tier's recall for its neighbour's — zero-sum. To break past
~46% exact we need **more discriminating features and a model that can use them**,
not new boundaries.

This doc defines: (1) honest re-measurement of where we actually are, (2) a feature
roadmap, (3) a learned-model upgrade, (4) the eval protocol + acceptance gates that
keep us honest.

---

## 1. Current Architecture (what we're improving)

```
prompt
  │
  ├─ extractFeatures()                 28 features (feature-extractor-v04.ts)
  │     • 9 v3.3 binary signals
  │     • 6 v3.2 structural
  │     • 13 v0.4 (domains, entities, negation, novelty, expertise…)
  │
  ├─ heuristicScoreFromFeatures()      hand-weighted linear sum → [0,1]
  │     length 0.34 + struct 0.10 + arch 0.20 + tech 0.12 + code 0.10
  │     + reason 0.15 + domain 0.11 + systemBonus 0.12   (length-dominant)
  │
  ├─ ensembleVote()                    heuristic*1.0 (+RAG nudge if present) + historyBias
  │     cascade = DEAD (weights never loaded, weight 0)
  │     RAG = optional nudge, absent on cold prompts
  │     historyBias = ±0.1, needs ≥5 feedback rows to fire
  │
  └─ scoreToEffort()                   5 boundaries [0.21,0.28,0.32,0.37,0.46] → tier

detectIntentMode()                     separate path: keyword hits + regex patterns,
                                       planScore vs actScore, tie → auto
```

### 1.1 Baseline scores (from `eval/ASSESSMENT.md`, v0.5.2)

| Metric | Value | Note |
|---|---|---|
| Effort exact-tier | **45.6%** | ⚠️ measured on the *same* set boundaries were fit on |
| Effort adjacent ±1 | 84.4% | most errors are off-by-one |
| Signed bias | +0.01 | neutral, good |
| trivial recall | 73.3% | |
| moderate/heavy/intensive recall | ~20–40% | **the problem band** |
| extreme recall | 60.0% | |
| Mode — plan recall | 86.7% | |
| Mode — act recall | 60.0% | weakest mode dimension |
| Mode — act precision | 90.0% | |
| Mode — ambiguous→auto | 86.7% | |

### 1.2 Two structural problems behind the numbers

1. **The model is a linear sum; the boundary-band errors are interaction errors.**
   "Long + multi-domain + code + constraints → extreme" is a *conjunction*. A
   linear sum can't represent "needs ALL of these"; it just adds partial credit, so
   a long-but-simple prompt and a short-but-deep prompt collide in the same band.
   Boundaries can't fix a representation problem.

2. **The eval is optimistic (overfit leak).** Boundaries `[0.21…0.46]` were
   grid-searched (`eval/calibrate.ts`, `retraining.ts:optimizeBoundaries`) on the
   **same 90-prompt golden set** the 45.6% is reported on. Real held-out accuracy is
   almost certainly lower. **We don't currently know our true accuracy.** Fix this
   first (§3) — otherwise every "improvement" is unverifiable.

---

## 2. Principle: richer features over boundary tuning

| Lever | Ceiling | Why |
|---|---|---|
| Boundary tuning | ~hit | Zero-sum across adjacent tiers; can't separate overlapping classes |
| **Richer features** | **high** | Adds new axes of separation the current 28 miss (semantics, decomposition depth, real token count) |
| **Learned model** | **high** | Captures feature *interactions* + emits calibrated probabilities (→ real confidence, real abstention) |
| Dataset growth | enabling | More + harder labels on the weak band; required for any learned model |

Rule for this roadmap: **a change is in-scope if it adds or better-exploits signal;
out-of-scope if it only re-positions the 5 cut-points.** Boundaries may be *re-fit
once* after the feature/model set changes, then frozen as a downstream calibration
step — not a tuning knob.

---

## 3. Phase 0 — Honest measurement (do first, ~1 day)

Cannot improve what we mis-measure. Build the harness before touching features.

### 3.1 Train/val/test split + k-fold CV
- Split `dataset.json` into **train / held-out test** (e.g. 70/30, stratified by
  tier). Fit boundaries + any model on train ONLY; report on test.
- For small-N robustness, add **stratified k-fold CV** (k=5) and report mean ± std
  exact/adjacent. This is the headline number going forward, replacing the current
  single-set figure.
- Acceptance: re-run baseline through CV → record the *real* baseline (expect it to
  drop from 45.6%; that's fine — it's the truth).

### 3.2 Per-feature diagnostics
Add `eval/feature-report.ts`:
- **Feature → tier correlation** (Spearman) and **mutual information** per feature.
  Tells us which of the 28 actually carry signal and which are noise.
- **Ablation:** drop each feature, re-measure. Features whose removal doesn't hurt
  are dead weight (suspect: `temporal_references`, `output_format_spec`,
  `novelty_score` may be near-zero contributors).
- **Per-tier feature medians** (already implied in code comments) as a table, to see
  where tiers are indistinguishable.

### 3.3 Error corpus
- Dump every misclassified prompt with (expected, predicted, score, full feature
  vector) to `eval/errors.json`. This is the work-list for §4 and the seed for
  hard-negative dataset growth (§6).

**Deliverable:** `eval/feature-report.ts`, `eval/cv.ts`, a real CV baseline number,
and `eval/errors.json`. Everything below is measured against the CV baseline.

---

## 4. Phase 1 — Richer features (the core of the ask)

Add features that create separation the current 28 lack. Each ships behind the
existing `FeatureVector` and is validated by §3 (MI + ablation) before it stays.

### 4.1 Real tokenization (replace `split(/\s+/)`)
Word-split mis-estimates length for code, CJK, long identifiers. Use a real
tokenizer (tiktoken/gpt-tokenizer) → `token_count`, `tokens_per_sentence`,
`type_token_ratio` on tokens. Length is the dominant signal; measuring it correctly
is the highest-ROI single change.

### 4.2 Decomposition / reasoning-depth features
The thing that separates moderate from extreme is **how many sub-problems** the
prompt implies, not its length. Cheap proxies (no LLM):
- `distinct_imperative_verbs` — count unique action verbs ("build AND test AND
  deploy" = 3).
- `requirement_count` — count of constraints/bullets/"must"/"should"/numbered items.
- `clause_depth` — max nesting of subordinate clauses (conjunctions + commas + "that
  / which / where" chains).
- `conjunction_count`, `enumeration_count` (lists, "1) 2) 3)", "a. b. c.").
- `question_count` — multiple distinct questions = compound.

These directly attack the moderate↔heavy↔intensive overlap.

### 4.3 Semantic features (embeddings)
Keyword lists are brittle (a finance prompt with no listed keyword scores 0 on
`domain_finance`). Add a small local embedding model (e.g. `all-MiniLM-L6-v2` via a
local runner, or the existing local-SLM path):
- Precompute **per-tier centroid embeddings** from the training prompts.
- Feature: `cosine_to_tier[k]` for each tier → 6 features; or a single
  `nearest_tier_by_embedding` + `embedding_margin`.
- This is a **kNN/prototype signal in semantic space** — captures "this *reads*
  like a heavy prompt" independent of which keywords appear.
- Keep it optional/cached so the synchronous CLI path still works without it.

### 4.4 Better domain & expertise detection
- Replace flat keyword `OR` with **weighted keyword density** (count, not boolean)
  and embedding-based domain similarity (4.3 generalizes this).
- `jargon_density` = rare/technical token ratio vs a common-word baseline.

### 4.5 Mode-specific features (plan/act)
Current mode detector is keyword/regex counting → act recall stuck at 60%. Add:
- **Modality / mood:** modal verbs ("would/could/should/might" → plan;
  imperative-at-start → act). Partly present; make it a graded feature not a single
  regex.
- **Tense:** future/conditional ("I'm going to", "we will") leans plan; present
  imperative leans act.
- **Artifact presence:** stack trace / error code / log line / file path / diff →
  strong **act** signal ("the login button throws a 500"). Currently under-weighted
  → the documented act-recall failure mode.
- **Question-vs-command ratio:** many questions → plan; single command → act.
- `deliberation_markers` ("not sure how", "which is better", "thinking about",
  "trade-off") → plan.

### 4.6 Acceptance per feature
A new feature stays only if, on CV: it has non-trivial MI with the label AND
ablating it costs ≥0.5pp exact (or improves a specific weak-tier recall). Otherwise
cut it — feature bloat hurts a learned model and the audit trail.

---

## 5. Phase 2 — Learned model (use the richer features properly)

A linear hand-tuned sum cannot exploit interactions. Replace
`heuristicScoreFromFeatures` (or wrap it) with a trained model. This *resurrects*
the dead cascade slot with an actually-loaded model.

### 5.1 Model choice — ordinal, not flat
Tiers are **ordered** (trivial < … < extreme). Use **ordinal regression**, not
6-way softmax — it directly optimizes "off-by-one is better than off-by-three",
which is exactly our adjacent-accuracy goal. Options, in increasing complexity:

1. **Ordinal logistic regression** over the feature vector — tiny, interpretable,
   ships in pure TS, no native deps. **Start here.**
2. **Gradient-boosted trees** (e.g. via a JS XGBoost/LightGBM port or a small
   pure-TS GBDT) — captures interactions, robust on small data, gives feature
   importance for free. **Likely the sweet spot.**
3. Small MLP — only if (1)/(2) plateau and the dataset is large enough (§6).

Keep the linear heuristic as the **fallback** (`v33Fallback`) when the model can't
load — same pattern already in `scoreIntent`.

### 5.2 Calibrated probabilities → real confidence + abstention
The model outputs per-tier probabilities. Apply **isotonic / Platt calibration** on
val. Then:
- **Confidence** = calibrated max-class prob (replaces the boundary-margin proxy in
  `confidenceFromMargin`).
- **Abstention:** when top-2 tiers are within ε, the router can fall back to the
  conservative neighbour or surface low-confidence to the orchestrator — principled,
  data-driven, replaces the removed hardcoded escalation hack.

### 5.3 Boundaries become a one-time calibration, then frozen
With a probabilistic model, "boundaries" reduce to argmax over calibrated probs (or
a single cost-weighted threshold if we want asymmetric over/under-routing cost).
Cut-point grid-search retires from the hot path → fulfils the "not boundary tuning"
mandate structurally.

### 5.4 Training data pipeline
- Train on `dataset.json` (train split) + **real feedback** from
  `data/feedback/entries.json` (already persists `score` + `actualTier` since
  v0.5.2 — the retraining fix).
- `retrainIfNeeded()` (`retraining.ts:91`) retargets from boundary-recalibration to
  **model refit** on accrued feedback, with the same ≥2pp-improvement guard and hot
  reload.

---

## 6. Phase 3 — Dataset growth (enabling, parallel track)

A learned model needs more than 90 prompts, especially on the weak band.
- Grow to **≥300 effort prompts** (≥50/tier), **≥150 mode prompts**, stratified.
- **Hard-negative mining:** seed new prompts from `eval/errors.json` — the exact
  confusions the model makes (long-simple vs short-deep, act-without-keywords).
- **Inter-annotator labels:** the band tiers are genuinely fuzzy (humans disagree).
  Collect 2–3 labels/prompt, keep agreement stats; treat low-agreement prompts as
  soft labels (don't over-penalize the model for human-ambiguous cases).
- **Provenance:** keep synthetic vs real-feedback prompts tagged so we can measure
  generalization synthetic→real.

---

## 7. Eval Protocol & Acceptance Gates

Every change runs the full battery; a change merges only if it clears the gates.

### 7.1 Battery (extend `eval/assess.ts`)
- Effort: exact, adjacent ±1, **per-tier recall**, signed bias, mean |distance|,
  confusion matrix — all under **5-fold CV** (mean ± std).
- Mode: plan/act precision+recall, ambiguous→auto, **per-class F1**.
- Confidence: calibration curve (reliability diagram) + ECE (expected calibration
  error).
- Cost proxy: signed bias × tier-cost delta = expected $ over/under-spend (we route
  to pay for models — over-routing is a real cost, already tracked in
  `benchmark-logger.ts`).

### 7.2 Acceptance gates (no regressions)
| Gate | Threshold |
|---|---|
| Effort exact (CV) | **≥ +3pp over current CV baseline**, no tier's recall drops >5pp |
| Effort adjacent (CV) | ≥ 84% (hold the line) |
| Signed bias | within ±0.10 (no systematic over/under-route) |
| Mode act recall | **≥ 75%** (from 60%) |
| Mode plan recall | ≥ 85% (hold) |
| Calibration ECE | ≤ 0.10 (confidence means something) |
| Latency | sync path ≤ current; async (embedding) path budgeted + cached |

### 7.3 Always report what we DON'T cover
Per the project honesty norm: every eval run logs dataset size, synthetic vs real
ratio, and any tier with <20 samples (under-powered). No silent "we cover
everything."

---

## 8. Phased Plan & Sequencing

| Phase | Work | Gate | Rough effort |
|---|---|---|---|
| **0** | CV harness, feature MI/ablation, error corpus | real baseline known | 1 day |
| **1a** | Real tokenizer + decomposition features (§4.1–4.2) | +2pp exact, MI-validated | 1–2 days |
| **1b** | Mode features (§4.5) | act recall ≥75% | 1 day |
| **1c** | Embedding/semantic features (§4.3–4.4) | +2pp on weak band | 2–3 days |
| **2a** | Ordinal logistic model + calibration (§5.1–5.2) | ≥+3pp exact, ECE ≤0.10 | 2 days |
| **2b** | GBDT if (2a) plateaus + feedback-driven refit (§5.3–5.4) | ≥+3pp over 2a | 2–3 days |
| **3** | Dataset growth + hard negatives (§6) | ≥300 effort prompts, CV std shrinks | ongoing |

Phases 1a/1b/3 are independent → parallelizable. 1c and 2 depend on 0. Boundaries
re-fit **once** after Phase 2, then frozen.

---

## 9. Risks / Honest Caveats

- **Small data.** 90 prompts is too few for a high-variance model (MLP/deep GBDT).
  Start ordinal-linear; grow data (Phase 3) before trusting a heavy model. CV std is
  the guardrail.
- **Embedding latency + deps.** Adds a model dependency and async cost; keep it
  optional and cached, keep the pure-TS sync fallback intact.
- **Synthetic→real gap.** Golden set is synthetic; real production prompts differ.
  The feedback loop (already wired) is what closes this — weight real-feedback
  refits accordingly.
- **Irreducible band overlap.** Even humans disagree on moderate/heavy/intensive;
  adjacent accuracy (±1) is the more honest north star there. Target exact gains on
  the *separable* confusions surfaced by §3.3, not the genuinely-fuzzy ones.
- **Don't reintroduce boundary tuning by the back door.** If a "feature" is really a
  threshold knob, it's out of scope.

---

## 10. First Concrete Steps

1. `eval/cv.ts` — stratified k-fold; print real baseline. *(unblocks everything)*
2. `eval/feature-report.ts` — MI + ablation table; identify dead features.
3. `eval/errors.json` dumper in `assess.ts`.
4. Swap `split(/\s+/)` → real tokenizer in `feature-extractor-v04.ts`; add
   decomposition features; re-measure.
5. Prototype ordinal-logistic in `src/learned-model.ts`, wire as the cascade slot in
   `ensemble-voter.ts` (the slot already exists at weight 0 — give it a real model).

---

## 11. Model-Agnostic Experiment Harness (swap any model, same eval)

Goal of this section: run **any** classification model — rule-based, learned-ML, or
a real LLM provider — through the **identical** dataset split and eval battery, so
results are directly comparable and the best model wins on evidence, not vibes.
"Different models" spans two senses, both first-class:

- **ML families:** heuristic-linear (baseline), ordinal-logistic, GBDT, embedding-kNN.
- **Real LLM providers already in the fleet** (groq-llama, gemini-flash, glm-flash,
  bailian — see `agents/missionops-*`) used as **zero-shot tier/mode classifiers**.

This fits the router's own thesis (multi-model routing): the classifier itself
becomes a pluggable, benchmarked backend.

### 11.1 Common contract — every model implements the same interface

```ts
// src/classifiers/types.ts
export interface TierPrediction {
  tier: EffortLevel;
  probs?: Record<EffortLevel, number>; // present for probabilistic/calibrated models
  score?: number;                      // present for scalar models (heuristic)
  confidence: number;
  latencyMs: number;
  costUsd?: number;                    // present for LLM backends
}
export interface ModePrediction { mode: IntentMode; confidence: number; latencyMs: number; costUsd?: number; }

export interface TierClassifier {
  id: string;                 // 'heuristic-linear' | 'ordinal-logistic' | 'gbdt'
                              // | 'embed-knn' | 'llm:groq-llama-3.3' | 'llm:gemini-flash' …
  kind: 'rule' | 'learned' | 'llm';
  version: string;            // bumps invalidate the prediction cache
  requiresTraining: boolean;
  fit?(train: LabeledPrompt[]): Promise<void> | void;   // no-op for rule/llm zero-shot
  predictEffort(prompt: string, feats?: FeatureVector): Promise<TierPrediction>;
  predictMode?(prompt: string): Promise<ModePrediction>;
}
```

Any model that satisfies this drops into the leaderboard. The current scorer is
wrapped as `heuristic-linear` with zero behavior change — it becomes the baseline
row, not a special case.

### 11.2 The thing that guarantees "same test set" — frozen splits

Fairness fails the moment two models see different data. Pin it:

1. **Deterministic, seeded, stratified split.** `eval/split.ts` produces folds from a
   fixed seed (passed in — `Math.random` is unavailable/banned in this codebase
   anyway, so seeding is explicit). Same seed → byte-identical folds for every model.
2. **Checked-in split files.** Write `eval/splits/test.v1.json`, `train.v1.json`,
   `folds.v1.json`. Every model reads these — nobody re-splits. The test set is a
   file, not a runtime decision.
3. **Dataset + split hashes.** Record SHA-256 of `dataset.json` and each split file
   in `eval/splits/MANIFEST.json`. The harness asserts the hash before running; CI
   fails if the data changed without a version bump. This is what makes "same
   datasets" enforceable, not aspirational.
4. **One battery, applied uniformly.** Every model goes through the same
   `eval/assess.ts` metrics (CV mean±std, per-tier recall, confusion, mode F1,
   calibration/ECE, cost+latency). No per-model metric tweaks.

### 11.3 Making LLM backends reproducible (else "same eval" breaks)

LLMs are nondeterministic + cost money → naive use breaks comparability. Rules:

- **Temperature 0**, fixed system+user prompt template, template version in the
  model `version` string.
- **Prediction cache** keyed by `(model.id, model.version, sha256(prompt))` →
  `data/eval-cache/<model>.json`. Re-runs read cache → identical results, near-zero
  cost, deterministic CI. Cache invalidates only on version bump.
- **Fixed label vocabulary in the prompt:** force the LLM to emit exactly one of the
  6 tier names / 3 modes (constrained output / JSON schema), parse-fail → record as
  abstain, not silent drop.
- **Snapshot cost + latency** per call so the leaderboard's Pareto axis is real.

### 11.4 Avoid circularity — classifier vs label oracle

A strong LLM can play **two different roles**; never the same one twice on the same
data:

- **Candidate classifier** (cheap LLMs): compete on the leaderboard, scored against
  human/golden labels.
- **Label oracle** (strong LLM, e.g. Opus) for **Phase 3 dataset growth only**.

Hard rule: **do not evaluate an LLM classifier against labels generated by that same
LLM** (or its family) — that measures self-consistency, not accuracy. Keep oracle
provenance tagged in the dataset (`labeled_by`) and exclude an LLM's own-labeled rows
from its eval split.

### 11.5 Leaderboard runner + Pareto selection

`eval/leaderboard.ts`:

```
for each registered model:
  assert dataset+split hashes match MANIFEST
  if requiresTraining: fit(train.v1) per fold
  predict(test.v1 / each fold)  [LLM → via cache]
  run full battery → row
emit table sorted by CV exact, with adjacent / per-tier recall / mode F1
          / ECE / median latency / $ per 1k requests
```

Selection is **not** "highest accuracy." The router pays per token → pick on the
**accuracy-vs-cost-vs-latency Pareto front**. A 4% local ordinal-logistic that's
free and 1ms can beat a 6%-better LLM classifier that costs $/req and adds 800ms —
because the classifier runs on *every* request before routing. The leaderboard makes
that trade explicit instead of hidden.

### 11.6 Stacking — use the LLM as a *feature*, not a *replacement*

Best-accuracy-per-dollar move: don't replace the local model with an LLM; **feed a
cheap LLM's tier guess as one more feature** into the learned model (§5), alongside
the §4 features and the embedding signal. Train the meta-learner to trust the LLM
only where it adds signal. Variant: **cascade by confidence** — local model decides
when confident; defer to the LLM only on low-confidence/boundary prompts (small
fraction of traffic → small cost, large accuracy lift exactly where the band overlap
hurts). Both are just new rows in the same leaderboard.

### 11.7 Acceptance — unchanged gates, now per-model

The §7.2 gates apply to every leaderboard row identically. A model "wins" only if it
clears the gates **and** sits on the Pareto front for the router's actual cost
budget. Same test set, same datasets, same battery, same thresholds — the harness
enforces all four by hash, so "best model" is a reproducible claim.

### 11.8 New concrete steps (extend §10)

6. `eval/split.ts` + `eval/splits/{train,test,folds}.v1.json` + `MANIFEST.json`
   (hashes). *(unblocks fair multi-model comparison)*
7. `src/classifiers/types.ts` + wrap current scorer as `heuristic-linear`.
8. `src/classifiers/llm-classifier.ts` — generic LLM backend (temp 0, schema'd
   output, cached) parameterized by provider; register groq/gemini/glm/bailian.
9. `eval/leaderboard.ts` — hash-asserting runner → sorted accuracy×cost×latency table.
10. Stacking model: LLM-tier-guess + embedding + §4 features → meta-learner (§5);
    plus a confidence-cascade variant. Both compete on the same board.

---

## 12. Measured Baseline — Phase 0 COMPLETE (harness shipped)

The model-agnostic harness is built and run. Files:
`eval/lib/{dataset,split,metrics,runner}.ts`, `eval/{split,cv,leaderboard,feature-report}.ts`,
`src/classifiers/{types,heuristic-linear}.ts`. Splits frozen + hash-pinned at
`eval/splits/` (seed 42, 5-fold, dataset sha256 `6454042d…`). Scripts:
`npm run eval:split | eval:cv | eval:leaderboard | eval:features`.

### 12.1 Real CV baseline (`heuristic-linear`, leak-free 5-fold)

| Metric | Old single-set (ASSESSMENT.md) | **Real CV (mean±std)** | Read |
|---|---|---|---|
| Effort exact | 45.6% | **44.4% ± 6.1%** | ~matches |
| Effort adjacent ±1 | 84.4% | **74.4% ± 8.3%** | **−10pp — the overfit leak, confirmed** |
| Signed bias | +0.01 | **−0.24** | under-routes on held-out |
| ECE (calibration) | n/a | **0.232** | confidence ≈ noise |
| Mode macro-F1 | (act recall 60%) | **93.3%** | mode is **not** the problem now |
| Latency | — | 0.04 ms | free, local |

Per-tier recall (CV): trivial 93% · light 73% · **moderate 27% · heavy 7% · intensive 13%** · extreme 53%.
→ The entire accuracy deficit lives in the **moderate/heavy/intensive** band, exactly
as predicted. The old report's +0.01 bias and 84% adjacent were optimistic artifacts
of fitting boundaries on the eval set.

### 12.2 Feature diagnostics (`eval:features`, MI vs tier)

**Top signal:** `word_count` MI **1.37** (dominant), `avg_word_length` 0.61. Everything
else is ≤0.30.

**10 of 28 features are dead** (MI <0.03 — never fire on the real prompts):
`code_block_size`, `domain_legal`, `domain_medical`, `domain_engineering`,
`prior_context_needed`, `multi_domain` (all exactly 0.000), plus `entity_count`,
`temporal_references`, `output_format_spec`, `user_expertise_level`. The keyword-based
domain detectors **match almost nothing** in the dataset → confirms §4.3/§4.4: replace
keyword lists with embedding/semantic domain signal.

**Why the weak band collapses (nonmonotonic features):**
- `has_imperative` spikes at heavy (0.80) then craters at intensive (0.07) — flips the
  ranking exactly where it hurts.
- `technical_terms` is flat 0.6–0.8 across moderate→extreme — zero separating power in
  the band.
- `novelty_score` MI 0.39 but ρ **−0.17** (nonmonotonic) — spurious; likely noise from
  type/token ratio on short prompts. Audit or drop.

### 12.3 What this re-prioritizes

1. **Length is ~all the current signal.** §4.1 (real tokenizer) and §4.2
   (decomposition/depth features) are now the **highest-ROI** work — they add the
   *only* axes likely to separate the band, since lexical features are dead or flat.
2. **Mode is solved enough** (93% macro-F1 on CV) — deprioritize §4.5 vs the effort band.
3. **Calibration is broken** (ECE 0.232) — the §5.2 calibrated-probability work is
   needed for the confidence/abstention story to mean anything.
4. **Cut the 10 dead features** before training any learned model (§4.6 gate) — they're
   pure noise to a GBDT/logistic fit.
5. New honest headline going forward: **44.4% ± 6.1% exact / 74.4% adjacent** (CV),
   not 45.6% / 84.4%. All gates in §7.2 measure against this.

