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

_Pending pass 3 findings — placeholder._

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
