# Routing Hybrid Eval — Design Spec

**Date:** 2026-07-11  
**Status:** Approved  
**Repo:** `gateswarm-moma-router` (`/root/.openclaw/workspace/gateswarm-moma-router`)

## Problem

We need evidence that GateSwarm’s complexity score → ensemble → tier → model chain makes the **best decision across each tier**, not only that unit tests pass. Current mid-tiers are weak (moderate/heavy recall), the moderate band is extremely narrow (0.30–0.31), and live routing can diverge from `/v1/score` because of provider health and ensemble signals.

## Goals

1. Measure **offline routing quality** on the full golden effort set (90 prompts).
2. Measure **ensemble contribution** via ablation (heuristic / +RAG / +history / full).
3. Measure **live outcome quality** on a balanced spot-check (5 prompts × 6 tiers = 30).
4. Produce a **final human/agent verdict** (this session’s evaluator) with per-tier PASS/WEAK/FAIL and a global VERIFIED | NOT VERIFIED | INCONCLUSIVE.

## Non-goals

- Training cascade weights or expanding the golden dataset in this pass.
- Wiring the hybrid eval into GitHub Actions (follow-up).
- Changing tier boundaries or models as part of the eval run itself (recommendations only).

## Success definition (hybrid)

| Layer | Metric | Floor |
|-------|--------|-------|
| Offline | Exact-tier accuracy (n=90) | ≥ 48% |
| Offline | Adjacent-tier accuracy (±1) | ≥ 75% |
| Offline | Per-tier recall | ≥ 40% each (flag if below) |
| Live | Rubric hard-pass | ≥ 25 / 30 |
| Live | LLM-judge mean adequacy | ≥ 3.5 / 5 overall; ≥ 3.0 / 5 per tier |
| Critical probes | `Explain async/await` | predicted tier ≥ `light` |
| Critical probes | Short greetings | predicted tier = `trivial` |

Final evaluator synthesizes automated metrics + qualitative review of live transcripts.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1 — Offline score (all 90)                            │
│   POST /v1/score  → exact, adjacent, confusion, score hist  │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2 — Ensemble ablation (in-process, no live LLM)       │
│   heuristic-only | +RAG | +history | full weights           │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3 — Live spot-check (30)                              │
│   gateway /v1/chat/completions (auto)                       │
│   rubric hard-fail + LLM judge (zai/glm-4.7-flash)          │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 4 — Final evaluator (agent)                           │
│   summary.md + VERDICT                                      │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. `eval/hybrid-routing-eval.ts` (new)

Orchestrates Phases 1–3. CLI:

```bash
npx tsx eval/hybrid-routing-eval.ts [--port 8900] [--seed 42] [--out eval/reports/routing-hybrid-<ts>]
```

Requirements:

- Gateway must be healthy on `--port` (exit 2 if unreachable).
- Load effort examples via `eval/lib/dataset.ts` (`loadEffort()`).
- Stratified sample: exactly 5 prompts per tier, deterministic with `--seed` (default 42). Prefer prompts already in frozen CV folds when possible; otherwise `seededShuffle` per tier.
- Persist raw JSON artifacts under `--out`.

### 2. Phase 1 — Offline scoring

For each of 90 prompts: `POST http://127.0.0.1:$PORT/v1/score` with `{ prompt }`.

Record: `id`, `goldTier`, `predTier`, `score`, `confidence`, `selected.provider/model`, `latencyMs`.

Compute: exact %, adjacent %, per-tier precision/recall/F1, confusion matrix (6×6), score histograms per gold tier, boundary-bucket counts for scores in `[0.29, 0.32]` (moderate stress).

Reuse metric helpers from `eval/lib/metrics.ts` where they exist; otherwise implement local identical definitions:

- **Exact:** `pred === gold`
- **Adjacent:** `|index(pred) - index(gold)| ≤ 1`

### 3. Phase 2 — Ablation

In-process (import `extractFeatures`, `heuristicScoreFromFeatures`, `ensembleVote`, `scoreToEffort` / intent-engine path). Four modes:

| Mode | Inputs |
|------|--------|
| `heuristic` | heuristic only, no RAG, no history bias |
| `heuristic+rag` | heuristic + ragSignal if RAG returns hits else heuristic-only |
| `heuristic+history` | heuristic + historyBias from feedback store (may be ~0 cold) |
| `full` | same weights as `v04_config.json` ensemble |

Compare exact/adjacent per mode. Flag any mode that drops adjacent by ≥5pp vs heuristic.

### 4. Phase 3 — Live spot-check

For each of 30 sampled prompts:

1. `POST /v1/chat/completions` with `model: "auto"`, `stream: false`, `max_tokens` by gold tier (256/512/1024/2048/4096/4096).
2. Capture response headers: `X-Tier`, `X-Score`, `X-Routed-Model`, `X-Routing-Method`, `X-Routing-Reason`, `X-Modality`.
3. Capture body content (and reasoning fields if content empty).
4. **Rubric hard-fail** if any:
   - HTTP ≠ 200
   - timeout (>120s)
   - empty content and empty reasoning
   - clear refusal template (“I can’t help with…”) on benign coding/Q&A prompts
5. **LLM judge** via direct route `zai/glm-4.7-flash` with a fixed JSON schema prompt:
   - `adequacy` 1–5
   - `on_tier` boolean (answer sophistication roughly matches gold tier intent)
   - `reason` ≤ 200 chars
6. Soft-check: routed provider for gold `trivial`/`light` should be `opencode-free` or `zai` (current free-only policy). Record violations; do not hard-fail the whole run.

### 5. Phase 4 — Final evaluator

Human/agent (this session) reads:

- `summary.md` (machine-generated)
- `scores.json`, `ablation.json`, `live.json`
- misroute examples (worst over/under by |Δtier|)

Issues a verdict block:

```
VERIFIED | NOT VERIFIED | INCONCLUSIVE
Per-tier: trivial=… light=… …
Evidence: …
Recommendations: …
```

## Artifacts

```
eval/reports/routing-hybrid-<YYYYMMDD-HHMM>/
  scores.json
  ablation.json
  live.json
  summary.md
  verdict.md          # written in Phase 4
```

`eval/reports/` should be gitignored if not already (operational artifacts).

## npm scripts

```json
"eval:hybrid": "tsx eval/hybrid-routing-eval.ts",
"eval:assess": "tsx eval/assess.ts",
"eval:calibrate": "tsx eval/calibrate.ts",
"eval:gate": "tsx eval/calibration-gate.ts"
```

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Free-tier rate limits (opencode-free / zai) | Serialize live calls; 500ms spacing; retry once on 429 |
| Judge returns empty / non-JSON | Rubric still applies; mark judge=`unavailable`; INCONCLUSIVE if >20% missing |
| Score vs chat tier divergence | Record both; treat divergence as WEAK signal for that tier |
| Moderate band instability | Explicit boundary stress section in summary |

## Approval record

- Success criterion: **Hybrid**
- Live budget: **Balanced (5×6=30)**
- Judge: **Rubric + LLM (`zai/glm-4.7-flash`) + final agent evaluator**
- Design approved: 2026-07-11 (user: “Proceed”)
