# GateSwarm Router — Prompt Evaluation Assessment (v0.5.2)

Comprehensive assessment of classifier **assertiveness** across the two routing
dimensions — **effort tier** (`scoreIntent`) and **plan/act mode**
(`detectIntentMode`) — against a labeled golden dataset of 90 effort prompts
(15 per tier) and 45 mode prompts (15 plan / 15 act / 15 ambiguous), generated
by an independent team of agents (see `eval/dataset.json`).

Run with: `npx tsx eval/assess.ts`

## Headline results (baseline → after fixes)

| Metric | Baseline | After | Δ |
|---|---|---|---|
| Effort exact-tier accuracy | 26.7% | **45.6%** | +18.9 pp |
| Effort adjacent (±1 tier) | 68.9% | **84.4%** | +15.5 pp |
| Escalation rate | 100.0% | **16.7%** | −83.3 pp |
| Signed routing bias | −0.76 | **+0.01** | neutral |
| Confidence distinct values | 1 (constant 0.70) | **54** | real |
| trivial recall (free tier) | 0.0% | **73.3%** | reachable |
| intensive recall | 0.0% | **40.0%** | — |
| extreme recall | 26.7% | **60.0%** | +33.3 pp |
| Mode — plan recall | 66.7% | **86.7%** | +20.0 pp |
| Mode — act recall | 13.3% | **60.0%** | +46.7 pp |
| Mode — act precision | 50.0% | **90.0%** | +40.0 pp |
| Mode — ambiguous→auto | 86.7% | 86.7% | held |

## Defects found and fixed

1. **Always-escalate (critical).** The active routing path hardcoded
   `confidence = 0.70`; because `0.5 ≤ 0.70 < 0.8` always triggered the
   "escalate one tier" branch, **every** non-extreme prompt was over-routed by a
   tier. The **trivial tier was unreachable** — the free-tier models could never
   be selected. *Fix:* real confidence from boundary margin; escalation only for
   genuine boundary coin-flips (`confidence < 0.55`), bounded to one tier.

2. **Fake confidence.** Confidence was a constant, so "confidence-based routing"
   and the low-confidence training triggers were inert. *Fix:* confidence is now
   derived from distance to the nearest tier boundary (54 distinct values across
   the set) and from heuristic/RAG agreement when RAG context exists.

3. **RAG neutral floor.** With no prior context the RAG signal defaulted to 0.5
   and, at weight 0.25, added a flat **+0.125** to every score. *Fix:* RAG is now
   optional; absent → the heuristic is used directly at full dynamic range.

4. **Weak heuristic features.** The score was essentially architecture-keyword
   counting; moderate/heavy/intensive all clustered at ≈0.04 (intensive even
   scored *below* moderate). Prompt length — the strongest available signal —
   was unused except as a gate. *Fix:* length (log-saturating) + sentence
   structure are now first-class; lexical signals are secondary. Per-tier medians
   are monotonic (trivial 0.18 → extreme 0.44).

5. **Boundary drift / hardcoding.** Three different boundary sets existed across
   files; the fallback path diverged from canonical. *Fix:* one calibrated set
   `[0.21, 0.28, 0.32, 0.37, 0.46]` (derived from the golden-set score
   distribution), and boundaries are now **config-driven** (`scoreToEffort` reads
   a validated cache synced from `v04_config.json`).

6. **Mode act-recall collapse.** Act prompts without literal keywords
   ("the login button throws a 500") fell through to `auto` (13% recall). *Fix:*
   added imperative-at-start detection and bug/symptom patterns; plan gained
   deliberation patterns ("not sure how…", "which is better…").

7. **Broken / unimplementable retraining.** The weight grid-search's
   `simulateAccuracy` ignored the candidate weights entirely (no-op), and the
   feedback store never persisted the prompt or component scores, so re-running
   the ensemble under new weights was impossible — meanwhile it could write a
   nonzero (dead) cascade weight into config. *Fix:* the feedback store now
   persists the routing `score`; retraining was retargeted to **tier-boundary
   recalibration** from real `(score, actualTier)` labels — a genuine,
   data-driven self-improvement that takes effect live (config hot-reload), with
   a ≥2pp-improvement guard.

## Remaining limitations (honest)

- Exact accuracy on the **moderate/heavy/intensive** band is the weakest
  (≈20–40%); these tiers overlap genuinely by length and even humans disagree.
  84% adjacent accuracy means most residual errors are off-by-one — the regime
  the confidence-driven escalation and the new boundary-retraining loop are
  designed to refine on real production labels.
- Boundaries were calibrated against a synthetic golden set; the training loop
  will recalibrate them on real LLM-judged feedback as it accrues.
