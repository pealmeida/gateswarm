# GateSwarm as an Agent Plugin — Frontier Teacher, Classifier Student, HITL Gate

**Date:** 2026-09-04
**Status:** Proposal — design + feasibility assessment (no code changes)
**Builds on:** `2026-08-25-dogfood-loop-golden-dataset.md`, `2026-08-26-evolution-strategy.md`, `2026-08-25-gateswarm-lite-router-testing.md`
**Question answered:** (A) how to ship GateSwarm as a plugin so the coding agent acts as an **LLM teacher**, with `gateswarm-lite` as the **student**; (B) whether frontier-model distillation + human-in-the-loop can actually move the student, and at what cost.

---

## 0. TL;DR

- **The plugin is the missing surface, not the missing capability.** `packages/gateswarm-mcp` already gives an agent the *tools* (`route_prompt`, `submit_feedback`). What it cannot ship is the teacher's **instructions**: a rubric, a labeling protocol, an abstention rule, a stratified audit queue. A Claude Code plugin bundles MCP server + skill + subagent + commands + hooks behind one `/plugin install`, which is exactly the shape of "make the agent a teacher".
- **The student's ceiling is its feature basis, not its cut points.** `DEFAULT_BOUNDARIES` is 5 scalars fit on 60 training examples. Distillation onto 5 scalars saturates after a few hundred labels. The real payoff of teacher volume is (1) the 26-feature ordinal-logistic head, which is currently gated off for lack of data, and (2) **feature discovery** mined from teacher rationales.
- **The honest framing is hard-label distillation with a human calibration anchor.** No logits, no soft targets, no gradient path to the teacher. Teacher labels are *bronze* provenance and must never be laundered as human verdicts.
- **Cost is small; the binding constraint is human attention.** 678 transfer prompts × k=3 self-consistency ≈ ~3M teacher tokens (single-digit dollars). ~120–150 human audits ≈ 2–3 hours. Everything else is already built: `fit:report` produces the labeling queue, `eval:refit-boundaries` fits, `eval:train-ordinal` gates, `eval:gate` verifies on a frozen holdout.
- **Biggest risk is self-confirmation, not accuracy.** The teacher (Claude Opus) is *also a routing destination at the extreme tier*. A teacher biased upward routes traffic to itself. This is measurable (mean signed tier distance on a random control stratum) and must be measured before any label is used.

---

## 1. Current state (what actually exists)

| Piece | Where | State |
|---|---|---|
| Student — heuristic scorer | `packages/gateswarm-lite/src/feature-extractor.ts` | `FeatureVector` (35 declared fields), hand-weighted linear score → `scoreToEffort` |
| Student — parameters | `packages/gateswarm-lite/src/tier-boundaries.ts` | **5 cut points**: `[0.208938, 0.264209, 0.32502, 0.36585, 0.485382]` |
| Student — optional head | `src/classifiers/ordinal-logistic.ts` | 26 features + heuristic score, proportional-odds. **Inactive** — needs a gate-passed `v05_ordinal_weights.json` |
| Gold labels | `eval/dataset.json` | **90 effort prompts** (15/tier), split 60 train / 30 test, hash-frozen in `eval/splits/MANIFEST.json` |
| Unlabeled transfer set | `tests/fixtures/mljar-prompts.json` | **678 real-world prompts** with role/category/level metadata — already in the repo, unused for labeling |
| Weak-label pipeline | `eval/ssl/*` | dolly-15k + alpaca-52k corpus → features → label propagation → silver labels |
| Capture surface | `packages/gateswarm-mcp` | `route_prompt`, `route_session`, `submit_feedback`, `telemetry_summary` → `<project>/events.jsonl` |
| Label provenance model | `src/label-combiner.ts` | gold 1.0 / silver 0.3 / bronze 0.5, with agreement-based recalibration after 50 and 100 gold votes |
| Active-learning queue | `scripts/lib/fit.ts` → `labelingQueue()` | ranks prompts by **routing dollars moved** per boundary swing |
| Gates | `eval/train-ordinal.ts`, `eval/calibration-gate.ts` | adjacent ≥ 90%, ECE ≤ 0.10, per-tier recall ≥ 30% (n≥5), bootstrap CI lower > 0, coverage ≥ 95% |

**The gap in one line:** the agent currently relays *human* verdicts and never produces a label of its own, and the labeled set is 90 examples — too small to unlock the ordinal head or to justify a boundary move on anything but the same 90 prompts.

---

## 2. Part A — GateSwarm as a plugin

### 2.1 Why a plugin rather than just `claude mcp add`

MCP registration gives the agent **tools**. It cannot ship:

- the **rubric** that defines what `heavy` means versus `intensive` (a skill),
- a **clean-context labeler** so 678 labeling calls don't pollute the working session (a subagent),
- **zero-friction capture** of real traffic (a `UserPromptSubmit` hook),
- **operator entry points** (`/gs-label`, `/gs-audit`, `/gs-refit`),
- one-command install and versioned distribution (`marketplace.json`).

A plugin ships all five, and keeps the MCP server as its transport.

### 2.2 Layout

Add to this repo (the repo doubles as its own marketplace):

```
.claude-plugin/
  marketplace.json                 # repo root → `claude plugin marketplace add pealmeida/gateswarm`
plugins/gateswarm/
  .claude-plugin/plugin.json
  .mcp.json                        # wraps packages/gateswarm-mcp
  skills/tier-teacher/SKILL.md     # THE RUBRIC — the teacher's actual instructions
  skills/tier-teacher/anchors.md   # few-shot anchors drawn from eval/dataset.json train split ONLY
  agents/tier-teacher.md           # isolated-context labeler subagent
  commands/gs-label.md             # run a teacher labeling batch
  commands/gs-audit.md             # HITL review of a stratified sample
  commands/gs-refit.md             # export → refit → gate → draft PR
  hooks/hooks.json                 # UserPromptSubmit capture (opt-in, off by default)
```

`plugin.json`:

```json
{
  "name": "gateswarm",
  "displayName": "GateSwarm Router",
  "version": "0.1.0",
  "description": "Complexity-aware model routing with a teacher/student distillation loop.",
  "author": { "name": "pealmeida" },
  "repository": "https://github.com/pealmeida/gateswarm-router",
  "license": "MIT",
  "keywords": ["llm-router", "model-routing", "distillation", "complexity-scoring"],
  "userConfig": {
    "project": { "type": "string", "title": "Project slug", "default": "default",
                 "description": "Telemetry grouping slug (letters, digits, '.', '_', '-')." },
    "telemetry_dir": { "type": "directory", "title": "Telemetry directory",
                       "description": "Overrides GATESWARM_TELEMETRY_DIR." },
    "capture_prompts": { "type": "boolean", "title": "Auto-capture prompts", "default": false }
  }
}
```

`.mcp.json` — path-independent, works installed or from a clone:

```json
{
  "mcpServers": {
    "gateswarm": {
      "command": "npx",
      "args": ["-y", "gateswarm-mcp"],
      "env": {
        "GATESWARM_TELEMETRY_DIR": "${user_config.telemetry_dir}",
        "GATESWARM_PROJECT": "${user_config.project}"
      }
    }
  }
}
```

> Depends on the npm publish already scheduled in the evolution strategy §2. Until then, pin
> `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/../../packages/gateswarm-mcp/dist/cli.js"]`.

`hooks/hooks.json` — capture only, never blocking, opt-in via `capture_prompts`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
                     "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/capture.sh" } ] }
    ]
  }
}
```

`capture.sh` reads the hook JSON on stdin, calls `scoreComplexity` + `route`, appends a `DecisionRecord`, and exits 0 with **no stdout** (adding context on every turn would be an unacceptable tax). It must never exit 2 — a scoring bug must not be able to block a user's prompt.

### 2.3 Teacher and student, named explicitly

| Role | Who | Emits | Provenance |
|---|---|---|---|
| **Student** | `scoreComplexity` + `DEFAULT_BOUNDARIES` (+ optional ordinal head) | `score`, `tier` | — |
| **Teacher** | the frontier agent, running `skills/tier-teacher` | `teacherTier`, `confidence`, `rationale`, `evidence[]` | **bronze** |
| **Oracle** | the human, via `/gs-audit` | `judgedTier` | **gold** |

**Non-negotiable:** the teacher does **not** call `submit_feedback`. That tool writes the human-verdict record consumed as `agentId: "review:<project>"` gold. Reusing it would launder model opinion into the golden dataset and silently destroy the one clean signal the whole gate depends on.

### 2.4 New MCP tools required

Four additive tools on `packages/gateswarm-mcp/src/server.ts`, all writing to the same append-only JSONL:

| Tool | Args | Writes |
|---|---|---|
| `submit_teacher_label` | `promptHash \| prompt`, `teacherTier`, `confidence` (0–1), `rationale` (≤200 ch), `evidence[]`, `teacherModel`, `rubricVersion`, `k`, `agreement` | `{type:'teacher_label', provenance:'bronze', …}` |
| `next_label_batch` | `project`, `n`, `strategy: 'boundary-swing' \| 'score-decile' \| 'random'` | nothing — reads, returns the queue |
| `next_audit_batch` | `project`, `n`, `strata` | nothing — returns the stratified HITL sample |
| `submit_audit` | `promptHash`, `judgedTier`, `notes` | `{type:'audit', provenance:'gold', …}` |

`next_label_batch` with `strategy: 'boundary-swing'` is just `labelingQueue()` from `scripts/lib/fit.ts` exposed over MCP — the active-learning selector is already written and already ranks by routing dollars moved.

### 2.5 The teacher rubric (`skills/tier-teacher/SKILL.md`) — design constraints

1. **Tier definitions are behavioral, never model-named.** "Requires multi-step decomposition and cross-file reasoning", not "needs Opus". The teacher must never see `DEFAULT_MATRIX`. This is the primary defense against the self-routing loop (§3.6).
2. **Anchors come from the train split only** (`eval/splits/holdout.v1.json` → `effort.train`, 60 ids). Anchoring on holdout prompts contaminates the only clean evaluation surface the project has.
3. **Abstention is a first-class output.** `teacherTier: null` with a reason beats a coin flip; abstentions become HITL queue entries, not labels.
4. **Structured output**: tier, confidence, ≤1-line rationale, and 1–3 `evidence` spans quoted from the prompt. Evidence spans are what make §3.4 (feature discovery) possible.
5. **Self-consistency k=3.** Label 3× independently; `agreement = modal_count / k`. Store it. Disagreement (k=3 → 2/1 or 1/1/1) is a stronger uncertainty signal than self-reported confidence and is the cheapest HITL routing key.
6. **Rubric is versioned** (`rubricVersion`); every label carries it. A rubric edit invalidates comparability, exactly like a boundary edit.

---

## 3. Part B — executing the distillation

### 3.1 What kind of distillation this actually is

Not logit/soft-target distillation: no access to teacher logits, and the student is not a differentiable network — it is 5 monotonic cut points plus, optionally, a 26-feature proportional-odds model. This is **hard-label distillation onto a frozen feature basis**, with a human-labeled calibration anchor.

The consequence matters for expectations:

```
teacher knowledge  ──►  tier label  ──►  [ frozen FeatureVector ]  ──►  student parameters
                                          ^^^^^^^^^^^^^^^^^^^^^^
                                          the actual bottleneck
```

If the teacher separates two prompts using a distinction the 35 features cannot represent, **no amount of labels will transfer it**. The two fitting targets, in ascending order of what teacher volume buys:

| Target | Params | Labels to saturate | Realistic gain |
|---|---|---|---|
| `DEFAULT_BOUNDARIES` refit | 5 | ~200–300 | small; boundaries are already fit, gains land in the ±2–4pp band |
| Ordinal-logistic head | ~27 | ~800–1500 | the real prize — currently unshippable for lack of data |
| **New features** mined from rationales | n/a | ~300 rationales to spot patterns | largest, and the only one that raises the ceiling |

### 3.2 Transfer set and selection

Priority order, all already on disk:

1. **678 MLJAR prompts** (`tests/fixtures/mljar-prompts.json`) — real, role-diverse, unlabeled, and carries a `level` field (Beginner/…) usable as a weak prior for stratification sanity checks.
2. **Organic telemetry** (`<project>/events.jsonl`) — genuinely in-distribution for the deployment; the dogfood rule ("no synthetic-only calibration") makes this the one that legitimizes a boundary PR.
3. **dolly/alpaca** via `ssl:build-corpus` — volume for the ordinal head, weakest distribution match.

**Select by uncertainty, not at random.** 60% of the labeling budget on `strategy: 'boundary-swing'` (prompts whose tier flips under a small boundary perturbation — these are the only prompts whose labels can move a cut point), 20% stratified across score deciles (keeps the fit from collapsing onto the middle), 20% pure random (this stratum is what makes the agreement estimate in §3.5 unbiased — do not skip it, and do not fit on it before it is audited).

### 3.3 Pipeline

```
  [ next_label_batch ]           the queue: boundary-swing 60 / decile 20 / random 20
          │
          ▼
  [ tier-teacher subagent ]      k=3 self-consistency, rubric vN, abstain allowed
          │  submit_teacher_label (bronze)
          ▼
  events.jsonl ──► [ next_audit_batch ]  4 strata (§3.5) ──► human ──► submit_audit (gold)
          │                                                                │
          ▼                                                                ▼
  agreement + kappa + mean signed distance ───────────────────► bronze weight (label-combiner)
          │
          ▼
  export ──► eval/lib/dataset.js shape ──► eval:refit-boundaries  (train split only)
                                       ──► eval:train-ordinal --silver <teacher.jsonl>
                                       ──► eval:gate  (frozen HUMAN holdout, untouched)
          │
          ▼
  own PR: DEFAULT_BOUNDARIES and/or v05_ordinal_weights.json + eval numbers + both snapshots regenerated
```

### 3.4 Feature discovery — the highest-value byproduct

Every teacher label carries `evidence[]`. Cluster the evidence spans on prompts where **the student is wrong and the teacher agrees with the human**. Those clusters name features the extractor is missing. Concretely, the extractor already has 10 known-dead fields (`DEAD_FEATURES` in `ordinal-logistic.ts`: `entity_count`, `code_block_size`, the three `domain_*`, …) — a rationale-mining pass is how you decide what replaces them. A new feature raises the ceiling; a refit boundary only redistributes under the existing one.

This is cheap (it rides on labels you already paid for) and is the one path that beats the ±2–4pp band.

### 3.5 HITL — where the human goes, and how little is needed

Humans cannot audit 678, and should not: their attention is the scarce input. Audit a **stratified ~120–150**:

| Stratum | Size | Purpose |
|---|---|---|
| Teacher ≠ student | ~40 | the disagreements are where a label changes a parameter |
| Teacher self-disagreement (`agreement < 1.0`) or abstain | ~30 | teacher-hard cases; also the rubric's bug report |
| Boundary-adjacent (within ±0.02 of a cut point) | ~30 | directly determines cut-point placement |
| **Random control** | ~30 | **unbiased** teacher-vs-human agreement + bias estimate — the only stratum whose statistics are quotable |

From the control stratum, compute and publish three numbers:

- **agreement** (exact tier match) and **adjacent agreement**;
- **Cohen's κ** on 6 ordered classes (weighted κ preferred);
- **mean signed tier distance** `E[teacher − human]` — the self-routing bias detector (§3.6).

Decision rule: **κ ≥ 0.6** → teacher labels usable as bronze; **0.4 ≤ κ < 0.6** → usable only as tie-breakers at weight ≤ 0.3; **κ < 0.4** → fix the rubric, discard the batch. `src/label-combiner.ts` already implements agreement-driven bronze recalibration (`FULL_PHASE_MIN_COMPARISONS = 30`, `FULL_PHASE_MIN_AGREEMENT = 0.7`) — feed it these comparisons instead of inventing a second mechanism.

Cadence: audit in batches of ~30, re-estimate κ each batch, stop when the κ confidence interval is tight enough to defend in the PR.

### 3.6 Risks specific to this design

| Risk | Why it bites here | Mitigation |
|---|---|---|
| **Self-routing loop** | Claude Opus is a matrix entry at the extreme tier; a teacher that inflates tiers routes traffic to itself and looks "safe" doing it | Teacher never sees the matrix; rubric is behavioral; **publish `E[teacher − human]`** every batch; \|bias\| > 0.2 tiers → re-anchor the rubric, never re-fit the boundaries |
| **Holdout contamination** | 30 human test prompts are the only clean surface | Teacher labels go to a **separate file**; `eval/dataset.json` is never edited; `MANIFEST.json` hash check already fails the run if it is |
| **Provenance laundering** | one careless `submit_feedback` call from the teacher poisons gold | Separate tool, separate record type, and a test asserting no `feedback` record carries a teacher `agentId` |
| **Rubric drift** | teacher labels across rubric versions are not comparable | `rubricVersion` on every label; refits filter to a single version |
| **Overfitting to MLJAR** | 678 prompts of a particular flavor | Keep both score snapshots as external drift alarms (already the rule); require organic telemetry in any PR that moves `DEFAULT_BOUNDARIES` |
| **Feedback loop self-confirmation** | student-selected queue → teacher labels → student refit | the 20% random stratum is held out of every fit; it is the loop's only external check |
| **Prompt privacy** | teacher labeling sends prompts to a provider | `src/redact.ts` before any teacher call; full-text opt-in per project (already the dogfood rule) |

### 3.7 Cost

| Input | Quantity | Cost |
|---|---|---|
| Teacher labeling | 678 × k=3 × ~1.5k tok ≈ 3M tokens | single-digit USD at frontier pricing |
| Human audit | 120–150 judgments @ ~60–90 s | 2–3 hours |
| Engineering | 4 MCP tools + plugin scaffold + export adapter | ~2–3 days |
| Re-runs (rubric v2, second batch) | ×2 of the above | budget for exactly one rubric revision |

The eval, gate, split, and queue machinery is already built and paid for.

### 3.8 Phases and exit criteria

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **D0** | Plugin scaffold + `.mcp.json` + marketplace entry | `claude plugin validate .` clean; `/gs-label --dry-run` lists a queue |
| **D1** | 4 MCP tools + record types + provenance test | teacher label round-trips; a test proves teacher records can never be read as gold |
| **D2** | Rubric v1 + anchors (train split only) + 30-prompt pilot | pilot κ on 30 human audits ≥ 0.5; `\|E[teacher−human]\| ≤ 0.3` |
| **D3** | Full 678 labeled, k=3 + 120–150 audits | κ ≥ 0.6; bias \|·\| ≤ 0.2; bronze weight set from measured agreement |
| **D4** | Export adapter → `eval:refit-boundaries` + `eval:train-ordinal --silver` | ordinal on gold+teacher beats gold-only on exact **and** does not worsen ECE |
| **D5** | Own PR | `eval:gate` PASS on the frozen human holdout: exact ≥ heuristic +3pp, adjacent ≥ 90%, per-tier recall ≥ 30% (n≥5), ECE ≤ 0.10; both snapshots regenerated; suite green |

Any phase failing its exit criterion stops the ladder. A failed D3 (κ < 0.6) is a rubric problem, not a boundary problem — do not proceed to D4 by weakening D3.

### 3.9 What this does not change

- No ML or embeddings inside `gateswarm-lite` — the student stays a feature-vector scorer.
- The router stays advisory; the plugin executes nothing.
- Teacher labels never alter live routing. `setTierBoundaries()` remains for experiments; `DEFAULT_BOUNDARIES` still moves only by reviewed PR.
- Gate thresholds are not renegotiated to accommodate teacher data. If teacher labels cannot pass the existing gate, they have not earned the change.

---

## 4. Open questions

1. **Should the teacher label tier or score?** A continuous 0–1 teacher score would give the cut-point fit far more signal per label than a 6-way class, and `fitMonotonicCutPoints` already works over scores. But frontier models are poorly calibrated on free-floating scalars. A middle path worth piloting at D2: tier + "position within tier" ∈ {low, mid, high} → 18 ordered buckets.
2. **k=3 same model, or 3 different models?** Cross-model consensus is a stronger bias check (it breaks the single-model self-routing prior) but costs a matrix of providers and complicates `teacherModel` provenance.
3. **Does the plugin ship the teacher at all by default?** Proposal: no — ship routing + capture enabled, and put labeling behind explicit `/gs-label`. Nobody's traffic should be silently labeled by a model.
4. **Retire `eval/ssl/*` label propagation once teacher labels exist?** They target the same silver slot with weaker signal; keeping both means two silver sources with different calibration. Decide at D4 on measured contribution.

---

## 5. Operating the loop — making it easy for the user and the teacher

§3 says what the loop is. This section says what it *costs to run*, because a distillation loop nobody runs is worth nothing.

### 5.1 The human vote UX already exists — reuse it, don't rebuild it

`src/training-mode.ts` + `src/vote-persistence.ts` already implement a low-friction gold-label capture path built for the gateway:

- `formatVotePrompt()` appends one line to a response: `🎯 [vote:abc123] Router chose: heavy (62% confidence). Reply: ✅ correct | ❌ trivial|light|…`
- `detectVoteReply()` / `parseVoteReply()` accept a **bare `✅` or `❌ heavy`** as the next message, bound to the pending vote within a 10-minute window.
- `shouldAskForVote()` samples: never on `trivial`, always below 0.5 confidence, otherwise `aleatoryRate 0.25` decayed by `e^(−votes/50)` (floor 0.02, cap 0.50), doubled on accuracy-gap tiers.
- `persistOrganicGoldLabel()` writes `OrganicLabelRow` with a WAL and replay.

**No new audit UI is needed.** The plugin surfaces this same one-token reply inside the agent. The human contribution to distillation is, and stays, `✅` or `❌ heavy`.

### 5.2 What the teacher changes: which prompts reach the human, not how they answer

Today `shouldAskForVote` asks the human on ~25% of non-trivial prompts and always below 0.5 confidence. Most of those asks are wasted — the student was right and the human confirms what a rubric could have confirmed.

With a teacher in the loop, the gate becomes:

```
teacher labels EVERY scored prompt (bronze, free-ish, no human)
      │
      ├─ teacher == student  ────────────►  no ask. bronze label stored.
      │
      ├─ teacher != student  ────────────►  ASK THE HUMAN  (this is the valuable ask)
      ├─ teacher abstains / k-disagrees ─►  ASK THE HUMAN
      └─ random control p≈0.03 ──────────►  ASK THE HUMAN (indistinguishable from the above)
```

Concretely: `aleatoryRate` drops `0.25 → 0.05` and `alwaysAskBelowConfidence` is replaced by the disagreement predicate. Ask *volume* falls by roughly half; ask *value* rises by more, because every remaining ask lands on a case where two independent judges differ. The fatigue decay, never-ask-trivial rule, cap, and WAL all stay exactly as they are.

**The control stratum must be visually identical to a disagreement ask.** If the human can tell which items are controls, the agreement estimate in §3.5 stops being unbiased.

### 5.3 Three levels of effort

| Level | Trigger | Human effort | Model effort | Yields |
|---|---|---|---|---|
| **Cold start** — offline batch | `/gs-label --corpus mljar --n 678` once | one command, walk away | ~10 min background | 678 bronze labels, no traffic needed |
| **Steady state** — passive | plugin installed, nothing typed | occasional `✅` / `❌ heavy` | one cached rubric call per prompt | bronze on real traffic + gold on disagreements |
| **Harvest** — deliberate | `/gs-refit` when counts suffice | read one table, approve or not | refit + gate + draft PR | boundary and/or ordinal proposal with numbers |

Cold start is what removes the chicken-and-egg problem: the 678 MLJAR prompts are already in the repo, so the first distillation run needs **zero** accumulated traffic and **zero** human labels — the human only enters at the audit, once there is something to audit.

### 5.4 Making it cheap on the teacher side

Four mechanics, all of which matter more than model choice:

1. **Batch 20–25 prompts per teacher call, not one.** Per-call overhead is the rubric + anchors; amortizing it over 25 prompts cuts total tokens by roughly an order of magnitude for the offline pass.
2. **Keep the rubric + anchors as a fixed prefix and cache it.** It is identical across every call in a batch run — the single largest cost lever available, and it also makes `rubricVersion` a natural cache key.
3. **Structured output, no free text.** `{promptId, tier, confidence, rationale, evidence[]}` per item. Nothing to parse, nothing to repair.
4. **Abstention is cheaper than deliberation.** `tier: null` on a hard case costs a few tokens and routes the item to the human, which is where it belonged anyway.

For the in-session (steady-state) path the teacher call is small and can piggyback on context the agent already holds — the user's prompt is already in the window.

### 5.5 What the user actually types, end to end

```sh
claude plugin marketplace add pealmeida/gateswarm
claude plugin install gateswarm@gateswarm
/gs-label --corpus mljar          # once, cold start. walk away.
                                  # …then just work. answer ✅ / ❌ <tier> when asked.
/gs-audit                         # optional: pull 30 pending disagreements in one sitting
/gs-refit                         # when telemetry_summary shows enough gold
```

Five commands, of which two are install-once and one is optional. Everything else is a single emoji typed occasionally in the course of normal work.

### 5.6 What is *not* easy, honestly

- **The audit still needs a human who knows the tier semantics.** ~30 judgments to a stable κ estimate, and a rubric revision means re-auditing. This is the irreducible cost; §3.7's 2–3 hours is real work, not a formality.
- **`/gs-refit` output requires judgment.** The gate returns PASS/FAIL, but deciding whether a passing boundary move is *worth* shipping — against snapshot drift and against the organic-traffic requirement — is a review, not a button.
- **Cold-start labels are out-of-distribution for any specific deployment.** MLJAR prompts bootstrap the ordinal head; they do not license a `DEFAULT_BOUNDARIES` change on their own. The dogfood rule still binds: a boundary PR needs organic traffic behind it.
