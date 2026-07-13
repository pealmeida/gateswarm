# Release Plan — v0.6.0 "Trustable Precision"

**Status:** DRAFT — adversarial review in progress (codex `gpt-5.6-sol`, 4 passes)
**Date:** 2026-07-12
**Objective:** a stable release in which every link between *data collection → training → gating → activation → routing* is verified, so the router can credibly converge toward precise prompt-complexity evaluation instead of silently stalling or silently regressing.

---

## 1. Method

Four serial adversarial review passes (codex CLI, model `gpt-5.6-sol`, read-only sandbox, hostile-reviewer brief, max 25 findings each):

| Pass | Scope | Status |
|------|-------|--------|
| 1 | Routing core: feature extractor, heuristic, ensemble voter, boundaries, ordinal classifier | pending retry |
| 2 | Gateway reliability: retry/fallback, streaming, provider-health, hot-reload | pending retry |
| 3 | Training/organic loop: vote sampling, persistence, label calibration | pending retry |
| 4 | Eval infra + config: leakage, gates, refit, SSL, config drift | ✅ 25 findings |

Every finding below marked **VERIFIED** was independently re-checked against source by Claude before entering this plan. Unverified findings are excluded or marked.

---

## 2. The activation kill chain (release-blocking)

Three independently confirmed defects compose into one catastrophic path:

1. **`eval/train-ordinal.ts` writes `v05_ordinal_weights.json` BEFORE the holdout gate runs** (VERIFIED, CRITICAL). File presence is the production activation switch for the ordinal cascade.
2. **A failed gate exits 0** (VERIFIED, CRITICAL). `gate result: FAIL` is printed and the process succeeds — CI, scripts, and humans piping `&&` all proceed.
3. **`loadConfig()` never applies `ensemble.weights` to the live voter** (VERIFIED, CRITICAL). The voter's module default is `heuristic 0.50 / cascade 0.50`; the config's gate-controlled `cascade: 0.00` is applied only via the CLI `setEnsembleWeights` path. The moment a weights file exists, production routes 50% on whatever model was trained — gated or not.

**Net effect:** one `npm run eval:train-ordinal` invocation on today's data-starved set (gate FAIL, CV 54.4% vs heuristic 61.1%) silently activates the rejected model at half weight in production. This already bit us once (stale weights file → 4 test failures).

### Fixes (Workstream A — Safety chain)

- A1. Train to a temp path; rename to `v05_ordinal_weights.json` **only after** all gate criteria pass; on FAIL leave existing artifact untouched and print why.
- A2. `process.exit(1)` on gate FAIL.
- A3. `loadConfig()` pushes `cfg.ensemble.weights` into the voter on every reload (same pattern as `syncTierBoundaries`); change voter module default to `heuristic 1.0, cascade 0.0` so the fail-open default is the currently-shipped behavior.
- A4. Weights file gains an embedded `gate: {passed, metrics, trainedAt, dataHash}` block; loader refuses files with `gate.passed !== true`.

---

## 3. Organic data pipeline integrity (Workstream B)

The entire post-v0.5.6 improvement path runs on organic gold labels. Three confirmed defects mean the pipeline, though now switched on, produces unusable data:

- **B1 (VERIFIED, CRITICAL).** `persistOrganicGoldLabel` stores only `promptSnippet: prompt.slice(0, 100)`. Full prompt is never persisted anywhere. Length/structure features — the heuristic's strongest signals — are destroyed. **Fix:** persist full prompt text (local, gitignored file; cap at 32 KB) alongside snippet; keep `promptHash` for dedup.
- **B2 (VERIFIED, HIGH).** `loadOrganicGoldVotes()` in train-ordinal looks for `prompt|text|input|user_prompt` and `gold_vote|tier|effort|label`; persisted rows have `promptSnippet` and `actualTier`. **Every organic row is silently discarded at retrain time.** Fix: shared, versioned decoder module used by both writer and reader; loader errors loudly on schema mismatch instead of skipping.
- **B3 (VERIFIED, HIGH).** No dedup or holdout-overlap exclusion when organic rows join training. Fix: normalized-prompt hash dedup + hard failure if any train row collides with frozen TEST ids/hashes.
- **B4 (my audit).** Vote prompts inject only on the non-streaming path (`moma-gateway.ts:1872`, single call site). Streaming/CLI traffic — the majority — never gets asked. Fix: append vote prompt as final SSE chunk before `[DONE]` (or trailing message for CLI providers).
- **B5 (my audit).** Collection-rate math: aleatoryRate 0.10 + fatigue floor 0.02 ≈ 5,500 answered requests to reach the 150-gold retrain threshold. Fix: raise `aleatoryRate` → 0.25 for first 90 days, remove `extreme` from `neverAskTiers` (keep `trivial`), keep fatigue decay.
- **B6 (label poisoning surface — pending pass 3).** Adversarial or careless replies write straight to gold. Mitigations to scope after pass 3 lands: per-agent trust, outlier check against heuristic score before persist, cap per-session gold contributions.

---

## 4. Eval trustworthiness (Workstream C)

Confirmed defects that make current PASS verdicts weaker than they look:

- **C1 (VERIFIED, HIGH).** Offline phase of `hybrid-routing-eval` scores the **whole** golden bank — including rows the boundaries were refit on. Floors are train-contaminated. Fix: gate metrics computed exclusively on hash-pinned holdout TEST ids; report train-set numbers separately as diagnostics.
- **C2 (VERIFIED, HIGH).** `asEffort()` coerces any malformed `/v1/score` tier to `moderate` — a broken gateway can still "pass". Fix: unknown tier = infrastructure failure row, never scored.
- **C3 (VERIFIED, HIGH).** Exit verdict is only `offline.ok && rubricPass >= rubricFloor`; ignores critical probes, judge availability (JUDGE_DEGRADED), per-tier adequacy floors — and `rubricFloor` scales with scored rows, so **zero scored live rows passes**. Fix: verdict = AND over all documented floors + minimum live coverage (e.g. ≥70% of sampled rows scored).
- **C4 (VERIFIED, MEDIUM).** Adequacy judge receives the gold tier — label-conditioned grading. Fix: blind the judge; ask it to independently estimate required tier; compare post-hoc.
- **C5 (VERIFIED, HIGH).** `eval/split.ts` silently overwrites `folds.v1.json` / `holdout.v1.json` under the same version. Fix: refuse overwrite when version exists; require explicit version bump.
- **C6 (VERIFIED, HIGH).** `refit-boundaries --apply` writes cut points into mutable `v04_config.json` while `src/tier-boundaries.ts` claims single-source-of-truth. Fix: refit becomes proposal-only (writes a report); applying = reviewed change to the TS source; config JSON may only *override* with an explicit `boundaries_override` key that logs loudly.
- **C7 (HIGH, calibration-gate).** New `eval/calibration-gate.ts` (untracked): unknown predictions count adjacent-to-trivial via `indexOf() === -1` (VERIFIED); no request timeout; connection failures scored as wrong answers instead of infra exit; aggregate-only floor. Fix before it enters the repo.
- **C8 (gate power — my audit).** Ordinal gate compares point estimates at n=60 (±13pp CV noise). Fix: bootstrap CI on the delta; pass requires lower bound > 0, plus per-tier minimum recall (not just heavy).

## 5. Config robustness (Workstream D)

- **D1 (VERIFIED, HIGH).** `JSON.parse` cast straight to `V04Config`, no validation; partial/corrupt config replaces live state. Fix: schema validation (zod or hand-rolled) on all six tiers, numeric ranges, provider references; reject invalid, keep last-known-good.
- **D2 (VERIFIED, HIGH).** Read/parse failures swallowed by bare `catch {}` — stale state with zero signal. Fix: structured error log + `/health` exposes `configReload: {ok, lastError, loadedAt}`.
- **D3 (VERIFIED, HIGH).** `saveConfig` writes the live file in place — interrupt = truncated JSON. Fix: temp file + fsync + atomic rename, keep `.bak` of last-known-good.
- **D4 (VERIFIED, MEDIUM).** No in-flight reload guard; concurrent expiries race. Fix: single shared reload promise.
- **D5 (VERIFIED, MEDIUM).** `label_propagation.py` duplicates tier boundaries as literals. Fix: generate a versioned boundary artifact from the TS source; Python verifies hash.

## 6. SSL pipeline honesty (Workstream E — gated, not release-blocking)

Already shelved behind activation gate; keep shelved. When revisited (~300 organic seeds):

- **E1 (VERIFIED via review, HIGH).** Grid ranked on golden TEST accuracy; silver selector tie-breaks on TEST — overfits silver generation to the eval bank. Fix: nested train-only validation; TEST touched exactly once.
- **E2 (HIGH).** Silver confidence calibrated on clamped seed nodes — circular 90% criterion. Fix: withheld seed folds.
- **E3 (MEDIUM).** TF-IDF/SVD/scaler fit on full corpus incl. TEST — transductive leak. Fix: fit on train-only, apply frozen transform to TEST.

## 7. Precision ceiling (Workstream F — the "final objective" path)

Shipped scorer is a hand-weighted linear model over 34 surface features; CV exact plateaus low-60s, live 67.8%. Semantics is the ceiling-breaker:

- **F1.** Offline prototype: MiniLM/e5-small embeddings (deps already in `optionalDependencies`: `@huggingface/transformers`, `onnxruntime-web`) + ordinal head, evaluated on frozen CV splits. Pure offline experiment; no production wiring until it beats heuristic under C8's corrected gate.
- **F2.** Ordinal retrain at ≥150 usable organic gold rows (post-B1/B2, current 7 rows are snippet-only and must be excluded or re-collected).
- **F3.** ragSignal micro-weight (0.10) live A/B — only positive live ablation delta so far (+10pp cold, n=30, one row; needs more evidence before default-on).

## 8. Gateway reliability (Workstream G)

Pass 2 delivered 25 findings (registry: `adv-review/pass2.out`). v0.6.0 subset, grouped:

**G-security (release-blocking):**
- G1/F01 (CRITICAL). Agent-management endpoints unauthenticated; responses expose full agent objects incl. API keys. Fix: admin token (`MOMA_ADMIN_TOKEN`) required on all agent CRUD; redact `apiKey` from every response except one-time registration.
- G2/F02 (HIGH). No request body size limit → memory-exhaustion DoS. Fix: bounded body (default 1 MB), HTTP 413.
- G3/F03 (MEDIUM). Malformed JSON silently becomes `{}` and gets routed/spent. Fix: HTTP 400 on parse failure.
- G4/F19 (HIGH). Raw upstream error bodies logged verbatim (PII/credential echo risk). Fix: redacted bounded metadata only.

**G-provider-health:**
- G5/F20. Free-text failure classification false-positives on short legit answers; structured provider error codes not preferred. Fix: structured fields first, error-shaped openings required.
- G6/F21. Tool-call/content-filter completions with null text misclassified as empty unusable bodies. Fix: usable if tool_calls/refusal/finish_reason present.
- G7/F22. `server_error` excluded from hard failures + streak reset on non-hard → repeated 5xx never cools down. Fix: per-class failure tracking.
- G8/F23 (MEDIUM). Cooldowns in-memory only; restart retries known-bad providers. Fix: persist bounded health state.
- G9/F24 (MEDIUM). Stale in-flight success clears newer cooldown. Fix: generation/timestamp guard.
- G10/F25. Rejected attempt promise aborts whole fallback chain. Fix: catch, classify as transport failure, continue.

**G-routing/payload:**
- G11/F04. Direct HTTP routing drops tools/temperature/max_tokens/response_format/stop from client body. Fix: pass sanitized body through, strip only gateway-owned fields.
- G12/F05. Direct non-streaming accepts HTTP-200 error bodies as success, skips health accounting.
- G13/F06. Greeting fast path discards system prompt/history/tools when last message looks like a greeting. Fix: only for genuine single-turn, no-system, no-tools requests.
- G14/F07. `effort_override` still runs full scorer first. Fix: branch around scorer.
- G15/F08. Multiple `getConfig()` reads across awaits mix hot-reload generations mid-request. Fix: immutable config snapshot per request.
- G16/F16. 60s global fallback budget ineffective (each attempt can block 120s). Fix: per-attempt timeout derived from remaining budget.
- G17/F17. `enable_thinking` computed for primary reused on fallbacks. Fix: fresh payload per target.
- G18/F18. HTTP 5xx bypasses provider-health/outcome recording. Fix: classify+record before advancing.

**G-streaming:**
- G19/F09. Streaming requests bypass fallback chain entirely; pre-stream failures unrecorded. Fix: validate usable SSE response before committing headers, fall back until then.
- G20/F10. `stream:true` treats HTTP-200 JSON as SSE. Fix: require SSE content-type; parse JSON as error/non-streaming.
- G21/F11. Stream read failure hidden behind `[DONE]`, benchmarked as success. Fix: structured SSE error + truncation event + failed attempt record.
- G22/F12 (MEDIUM). SSE parser only accepts `\n\n` (not CRLF). Fix: incremental parser accepting both.
- G23/F13. Greeting-stream exceptions swallowed, connection just ends. Fix: redacted log + health update + explicit error event.
- G24/F14. CLI streaming commits 200 pre-subprocess; failures become fake assistant text with internal error details. Fix: buffer until CLI start OK, sanitized SSE error otherwise.
- G25/F15 (= B4). Streaming/CLI completions never get vote prompts → organic collection dead for streaming clients. Fix: stream-safe vote prompt before terminal chunk.

## 9. Training-loop correctness (Workstream H)

Pass 3 delivered 25 findings (registry: `adv-review/pass3.out`). CRITICALs verified: #1 vote misattribution, #18/#19 runtime boundary mutation via unauthenticated endpoint + multi-million-combo grid on the request path, #23 LLM judge overwrites human gold labels.

**H-label-integrity (release-blocking):**
- H1/#1 (CRITICAL). Bare vote replies attribute to the newest pending vote regardless of which conversation answered. Fix: bind replies to vote ID + session identity; reject bare replies when >1 vote pending.
- H2/#2. "❌" without a corrected tier records actualTier = predictedTier with agreed=false — self-contradictory row. Fix: reject, ask for the tier, don't consume the vote.
- H3/#23 (CRITICAL). Gold entries enter the judge queue (adequacyScore null) and `updateAdequacy` overwrites human actualTier unconditionally. Fix: exclude source=gold_vote from judging; gold actualTier immutable to lower-trust paths.
- H4/#22. Gold feedback joins to newest entry by truncated promptHash only — repeated prompts across agents overwrite the wrong interaction. Fix: join by vote/request ID + agent.
- H5/#11. Retrain coverage grouped by predictedTier, not actualTier. H6/#12. shouldRetrain has no completed-retrain watermark — true forever once reached. H7/#21. Admission accepts NaN/Inf scores and absent tiers.
- H8/#4. Raw prompt text persisted to three stores with no secret/PII redaction. Fix: centralized redaction pass (API-key-shaped substrings, emails, long digit runs) before any persistence.
- H9/#6. Vote consumption spans 4 non-atomic writes. Fix: write-ahead record keyed by vote ID; idempotent replay.

**H-silver/calibration:**
- H10/#7. `ragPhase: disabled` never actually checked — SILVER emitted during bootstrap. H11/#8. Q0/Q1/Q2 tiers cast into EffortLevel. H12/#9. SILVER consensus consumes router's own predictions (no provenance) — self-training loop. H13/#10. Interaction counter increments only on retrieval success. H14/#15. LabelSource.confidence ignored — low-confidence labels vote at full weight. H15/#16. Failed silver calibration keeps default weight and passes "validated" gate. H16/#17. All calibration state memory-only, resets on restart.

**H-persistence/retraining:**
- H17/#13. votes.json non-atomic whole-file writes + catch-and-default = silent history loss. H18/#14. Every vote rewrites 5k records synchronously on request path. H19/#24. Feedback mutations memory-only until periodic flush. H20/#25. RAG index parse failure → silent empty index, then overwritten. H21/#5. Fatigue counts in-memory only.
- H22/#18+#19+#20 (CRITICAL). `retrainIfNeeded` (exposed via unauthenticated POST /v04/retrain) grid-searches ~millions of boundary combos on-thread and mutates live boundaries, no holdout validation — bypasses the frozen single source of truth and every gate. Fix: endpoint becomes proposal-only (report file, admin-gated), boundary changes go through the C6 reviewed path; grid replaced by sorted quantile/DP optimizer offline.

## 9b. Routing core correctness (Workstream I — pass 1, 21 findings)

CRITICAL/HIGH verified subset (registry: `adv-review/pass1.out`):

- I1/#1 (CRITICAL, VERIFIED). `setTierBoundaries` accepts `NaN` (`typeof NaN === 'number'`; both range comparisons false) and `scoreToEffort` sends non-finite scores to `extreme`. Fix: `Number.isFinite` on every boundary and score; non-finite score → `moderate` + loud log (fail-closed to the middle, not the most expensive tier).
- I2/#7 (HIGH, VERIFIED). Ordinal variance accumulators initialize to 1, not 0 — every fitted std inflated by 1/total; distorts coefficients worst on small gold sets (may have contributed to the gate failure). Fix: zero-init + regression test vs hand-computed stats.
- I3/#3+#4+#6. Weights-file activation: three implicit search paths, weak `loadState` validation (accepts non-finite coefficients, missing stds, unordered thresholds), and `loadAttempted` set before validation (transient read failure disables loading until restart). Fix: single configured path, strict schema validation, gate-passed marker (ties into A4), mark attempted only after successful validation.
- I4/#5. Ensemble/weights load failures swallowed silently. Fix: structured sanitized error + degraded flag on `/health`.
- I5/#9 (HIGH). Whitespace/ASCII tokenization collapses CJK, emoji-only, and minified-code prompts to ~1 word → severe under-routing. Fix: Unicode-aware segmentation (Intl.Segmenter), char-class signals, fixtures for multilingual/emoji/minified inputs.
- I6/#10+#12+#13 (HIGH/MEDIUM). Keyword evidence double-counted across overlapping families ("consensus" alone reaches moderate; `100 qps` counts twice; numbered lists counted by two patterns). Fix: dedup by matched span/signal family. **Any scorer change requires a CV re-run ≥ current baseline before merge.**
- I7/#11 (PLAUSIBLE — needs regression test). `Explain async/await` may score below the light boundary offline (live probe passed, possibly via warm RAG). Fix: regression test at the extractor level; recalibrate imperative contribution if confirmed.
- I8/#14+#16. `setEnsembleWeights` accepts negative/non-finite values; ordinal abstention ignores calibrated confidence. Fix: validate weights; abstain on low calibrated confidence OR low margin.
- I9/#18 (MEDIUM). Ordinal path re-extracts and re-tokenizes the full prompt after scoreIntent already did. Fix: pass the existing feature vector; cap prompt size before extraction.

Deferred (LOW/cleanup): #15 renormalization over present components, #17 history lazy-init merge, #19 substring false positives, #20 range representation, #21 dead code/35th feature.

## 9c. Multi-armed bandits in the learning architecture (Workstream J — evaluation)

**Question:** can MAB improve complexity-evaluation accuracy? **Answer: yes, but as a complement to the supervised path, not a replacement — and only after v0.6.0's reward-integrity fixes land.** Supervised gold labels teach *label imitation* ("what tier would a human assign"); bandit feedback answers the counterfactual the labels can never give: *"would the cheaper tier have sufficed for this request?"* That counterfactual defines the cost-optimal routing frontier, which is the router's actual objective.

**Feasibility grounding (measured):** ~60–120 requests/day (13 benchmark-log days, 828 rows). Benchmark logs already carry `tier, routed_model, latency_ms, cost_usd` per request — most of a reward function. Missing: adequacy outcome and action propensity.

**Where bandits fit, ranked by convergence speed at this traffic volume:**

- **J1 — Within-tier model selection (fast, weeks).** Arms = models in a tier's chain; reward = success − λ·norm(latency) − μ·norm(cost); observable on *every* request, no judge needed. Sliding-window Thompson sampling per tier (nonstationary providers). Supersedes static primary/fallback ordering; provider-health cooldowns remain as hard constraints. Can be validated **offline today** by replaying the 828 logged rows. Improves reliability/cost, not tier accuracy directly.
- **J2 — Uncertainty-directed vote solicitation (active learning, immediate).** Replace part of the aleatory vote sampling with an acquisition rule: solicit votes where |score − nearest cut| is small or scorers disagree. Each gold label buys maximum boundary information → directly accelerates the ordinal path (F2). Not strictly a bandit, but the same explore/exploit machinery.
- **J3 — Boundary-zone tier exploration (the accuracy play, months).** Contextual bandit restricted to requests whose score falls within ±ε of a cut point (~25–30% of traffic per the confusion matrix — nearly all misroutes are adjacent). Arms = {stay, one-tier-up, one-tier-down}; reward = judged adequacy − λ·cost. Exploration budget capped (≤5% of eligible traffic; down-exploration ≤3% and never on `alwaysAskBelowConfidence` requests). Logged decisions + propensities accumulate a counterfactual dataset that later trains the ordinal model on *outcomes*, not just labels. Full 6-arm tier bandit over all traffic is **rejected**: at this volume it would need years to beat a decent supervised scorer.
- **J4 — Exp4-style ensemble weighting (later).** Experts = heuristic, ordinal, RAG signal; bandit learns weights from realized rewards instead of hand-frozen constants. Only meaningful once ≥2 scorers independently pass gates; revisit after F2.

**Hard dependencies (why not before v0.6.0):** the reward channel is currently corrupted in ways a bandit would *learn from* — F05 counts HTTP-200 error bodies as success (bandit would learn to prefer broken providers), C4's judge sees the gold label, H3 lets the judge overwrite gold, H12's silver consensus is self-training. Bandits amplify reward bugs into policy; every one of these must land first.

**J0 — the only v0.6.0 item:** extend the benchmark log schema with `propensity` (probability the current policy assigned to the chosen tier/model; 1.0 for deterministic routing) and `adequacy` (filled async by the blinded judge when sampled). Costs two fields now; enables off-policy evaluation (IPS/doubly-robust) of *any* future bandit policy against accumulated history before it ever touches live traffic — the same evidence-gate philosophy as the ordinal model.

**Activation gate (preregistered):** a J1/J3 policy ships default-on only when its off-policy estimate on ≥30 days of propensity-logged history beats the static policy's realized reward with a bootstrap CI lower bound > 0.

## 9d. Bias mitigation across the pipeline (Workstream K — evaluation)

**Approach: measure per-slice first, correct verified biases at their source, reweight structural ones, constrain the decision layer, monitor drift.** Blanket "debiasing" without slice measurement is cargo cult; every item below ties to observed evidence.

**Measured bias evidence (golden bank, n=90):**
- Length-tier confound: median words 5→28 monotonic with tier — "long = complex" is partly an artifact of dataset construction, so verbose-trivial prompts over-route and terse-expert prompts under-route.
- Language bias: 0/90 non-Latin prompts, while the tokenizer verifiably collapses CJK/emoji/minified input (pass 1 #9) — the bank cannot even see the router's worst slice.
- Distribution mismatch: bank balanced 15/tier; live traffic skews trivial/light; only ~14% software-domain prompts despite coding-heavy real usage.

### Pre-processing (data & features)
- **K1 — Slice-stratified eval bank.** Extend the bank with labeled slices: non-Latin (CJK/Cyrillic/Arabic), emoji/minified, length-decorrelated pairs (verbose-trivial, terse-extreme), domain strata (code/general/analysis). Report per-slice exact/adjacent — per-slice floors join the eval verdict. Bank version bump per C5.
- **K2 — Length deconfounding.** Report partial correlation of score with word count controlling for tier; add counterfactual test pairs (same task, padded vs terse — tier must not change). Feature-weight refits must not increase length dependence.
- **K3 — Selection-bias control on organic labels.** Vote solicitation is deliberately non-uniform (2× on weak tiers, always-on at low confidence) and replies are voluntary — the labeled set will never match traffic. Log solicitation propensity + reply stratum with every gold label; apply inverse-propensity weights when training on organic data; J2 active learning must record acquisition probability or it poisons the ordinal retrain.

### Modeling / training
- **K4 — Class priors.** Train/refit with per-tier weights reflecting *deployment* priors, not bank balance; per-tier recall floors (C8) stay as the guardrail against majority-tier collapse.
- **K5 — Label-source honesty.** Gold-only for boundary-defining decisions; silver/bronze confidence-weighted (H14) and provenance-gated (H12) — self-training is confirmation bias by construction.
- **K6 — Estimator correctness.** Variance-init fix (I2) and normalize-after-split (pass 1 #8 — promote from deferred: Platt calibration currently fits on leaked holdout statistics, inflating confidence).
- **K7 — Feedback-loop bias.** The router only observes outcomes of its own choices — labels derived from them systematically confirm the current policy. Counter: J0 propensity logging + J3 capped counterfactual exploration + IPS/doubly-robust corrections when training on outcome-derived labels.

### Post-processing (decision layer)
- **K8 — Cost-sensitive boundaries.** Refit objective uses an asymmetric misroute-cost matrix (under-routing extreme ≫ over-routing trivial) instead of raw exact accuracy — pure accuracy on skewed data squeezes rare expensive tiers (matches heavy's observed 40% recall).
- **K9 — Uncertainty-aware escalation.** Within ±ε of a cut with low confidence, round UP one tier (bounded extra cost, insures against the costlier error). Log every escalation for J3 to later learn ε.
- **K10 — Judge bias audit.** Blinded judge (C4) plus: track judge-vs-gold-vote agreement (calibration store already holds it) and adequacy-vs-response-length correlation — LLM judges reward verbosity, which silently rewards over-routing.

### Monitoring
- **K11 — Drift monitor.** Population-stability index between live traffic feature distribution (benchmark logs) and the eval bank per release; alert when the bank stops representing traffic. Publish per-slice metrics in every eval report.

**Sequencing:** K6 lands in v0.6.0 (wave 12 adjacency); K1/K2 next (they change what "accuracy" means — before any further boundary refit); K3 before the first organic-data retrain; K4/K8/K9 with that retrain; K7/K10/K11 alongside Workstream J.

## 9e. OSS hygiene (Workstream L — adversarial OSS review, 20 findings)

Registry: `adv-review/oss-review.out`. v0.6.0 scope (wave 14): fail-closed admin auth for non-loopback binds (CRITICAL — unset `MOMA_ADMIN_TOKEN` + exposed port = anyone mints agent keys, defeating `GATESWARM_REQUIRE_AUTH`); coherent npm artifact (files/exports/bin pointed at TS source while main pointed at dist — unpublishable); removal of maintainer-personal content (OPS_GUIDE runbook, SECURITY_AUDIT with private hostname, broken QUICKSTART, provider account states in README/config/CHANGELOG/provider-quota comments, cron/RunPod job IDs); SECURITY.md + THIRD_PARTY_NOTICES.md (alpaca-cleaned is CC BY-NC — flagged); CI action SHA-pinning + pack smoke; gitignore/PR-template/start-script fixes.

**Deferred post-0.6.0:** Docker base-image digest pinning, hash-locked Python requirements, dataset revision pinning inside train.py/build-corpus, full model cards + checksums for the vendored ONNX/tokenizer assets (manifest TODO added), pytest + container-build CI jobs.

## 10. Release sequencing

1. **A1–A4** (safety chain) — first; nothing else is safe to ship around a live footgun.
2. **B1–B3** (data integrity) — every day of collection before this is wasted data.
3. **B4–B5** (collection rate) + **D1–D4** (config robustness).
4. **C1–C7** (eval floors become truthful) — must precede any "v0.6.0 passes its gates" claim.
5. **G/H fixes** from passes 2–3 (slot by severity).
6. **F1** offline embedding prototype in parallel (no prod risk).
7. Full eval re-run on corrected floors → tag `v0.6.0`.

## 11. v0.6.0 release gate (all must hold)

- 100% of Workstream A landed; demonstrated: `train-ordinal` on current data exits non-zero and leaves no weights artifact.
- Organic round-trip test: synthetic vote → labeled.jsonl (full prompt) → `loadOrganicGoldVotes()` returns the row verbatim.
- Eval verdict recomputed on holdout-only floors; publish honest numbers even if lower than the contaminated 67.8%.
- Config fuzz test: truncated/partial/garbage `v04_config.json` never changes live routing and surfaces on `/health`.
- All tests green; typecheck clean; no new deps beyond optional embedding stack.

---

_Findings registry: scratchpad `adv-review/pass{1..4}.out`; verification notes in session log._
