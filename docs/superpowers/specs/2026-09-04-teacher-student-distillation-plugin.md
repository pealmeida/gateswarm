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

---

## 6. Agent-as-voter and outcome-grounded review inside Claude Code

§5 removed most of the human from the *labeling* path. This section removes them from the *voting* path, and adds a second, better teacher signal that only an agentic host can produce: **what the work actually took**.

### 6.1 The mechanisms Claude Code provides

| Need | Mechanism | Session-context cost | Token cost |
|---|---|---|---|
| Delegate **every** prompt to the classifier | `UserPromptSubmit`, `type: "command"`, `async: true` | none (no stdout) | zero |
| Teacher votes **instead of the user** | `UserPromptSubmit`, `type: "prompt"` | none | small, cacheable prefix |
| Observe realized effort as it happens | `PostToolUse`, `type: "command"`, `async: true` | none | zero |
| Review the finished work against its tier | `Stop`, `type: "agent"` | none — runs as a subagent | one short review |
| Persist labels | `type: "mcp_tool"` → `gateswarm` server | none | zero |

**`prompt_id` is the join key.** It is a UUID present on *every* hook event and, per the hooks reference, exists precisely to correlate telemetry. `UserPromptSubmit` (the decision), each `PostToolUse` (the effort counters), and `Stop` (the outcome) all carry the same `prompt_id`, so the three writes land on one record with no correlation heuristics. `transcript_path` — also on every event — gives the reviewer the full trajectory without the main session having to carry it.

Two rules keep this invisible to the user: every hook returns **no `additionalContext`** (context injected on every turn is a tax the loop has not earned), and every hook is `async` or exits 0 unconditionally. A scoring bug must never be able to block a prompt or delay a Stop.

### 6.2 Wiring

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command", "async": true,
          "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/score-and-open.sh" },
        { "type": "prompt", "timeout": 20,
          "prompt": "You are the GateSwarm tier teacher. Rubric: @${CLAUDE_PLUGIN_ROOT}/skills/tier-teacher/SKILL.md\nJudge ONLY the user prompt in this event. Return {\"tier\",\"confidence\",\"rationale\",\"evidence\"} or {\"tier\":null}.\n$ARGUMENTS" }
      ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "async": true,
                     "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/tally.sh" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "agent",
                     "prompt": "Review the completed task against its routing decision. Read the transcript at the transcript_path in $ARGUMENTS, compute the realized-effort vector, and call gateswarm/submit_outcome_review. Do not comment on the answer's quality as evidence for tier.\n$ARGUMENTS" } ] }
    ]
  }
}
```

`score-and-open.sh` scores + routes + opens the record. The `prompt` hook is the teacher's vote. `tally.sh` increments counters keyed by `prompt_id`. The `Stop` agent hook closes the record.

### 6.3 Two teacher signals, and why the second is worth more

| | **Teacher-prior** (`UserPromptSubmit`) | **Teacher-posterior** (`Stop`) |
|---|---|---|
| Sees | the prompt text | the whole trajectory |
| Asks | "what tier does this look like?" | "what tier did this turn out to be?" |
| Latency | immediate | end of task |
| Cost | small per prompt | one review per task |
| **Error correlation with the student** | **high — same input, same surface cues** | **low — different evidence entirely** |
| Provenance | bronze | silver (see §6.6) |

This is the part worth being blunt about: a prompt-only teacher is *another model guessing from exactly the text the student already sees*. It is better-informed than the student's 35 features, but its mistakes correlate with the student's, so it adds less independent information than its accuracy suggests. The outcome reviewer breaks that correlation — it is scored against evidence the student structurally cannot access at prediction time. **That is the label worth collecting.**

### 6.4 The realized-effort vector

Computable from `transcript_path` plus the `PostToolUse` tally, all with zero model calls:

| Signal | Read from |
|---|---|
| `assistantTurns` | transcript |
| `toolCalls`, by kind | tally |
| `filesRead`, `filesEdited`, `linesChanged` | tally on `Edit`/`Write` |
| `testRuns`, `testFailuresBeforeGreen` | tally on `Bash` + `tool_response` |
| `backtracks` — re-reading a file already read, reverting an edit | transcript |
| `userInterventions` — user turns mid-task that correct or redirect | transcript (**strongest single negative**) |
| `subagentSpawns` | `SubagentStop` events |
| `tokensIn/Out`, `wallClockMs` | transcript |
| `completed` vs abandoned | terminal state |
| `effort.level` — Claude Code's own setting | any hook event (free cross-check against the tier) |

**Map realized effort to a realized tier by project-relative quantiles, not absolute thresholds.** Fifteen tool calls means something different in a monorepo than in a scratch project. `TIER_EXPECTED_TOKEN_RANGES` in `src/self-eval.ts` is the absolute-threshold version of this idea and is the wrong shape for agentic work — it scores one response's output tokens, not a trajectory.

### 6.5 The routing verdict

`src/self-eval.ts` already has the skeleton: `quickEval()` for heuristic adequacy, `llmJudge()` returning `{adequacy, correctTier}`, and a `predictedCorrectTier` field on `SelfEvalResult`. The Claude Code reviewer is that function generalized from *one response* to *one trajectory*. Combine adequacy with effort:

| | **low realized effort** | **high realized effort** |
|---|---|---|
| **task succeeded** | tier right, or **over-routed** | tier right, or **under-routed** |
| **task failed / abandoned** | ambiguous prompt — queue for human | **under-routed** |

Verdict vocabulary: `right` · `over_routed` · `under_routed` · `unknown`. `unknown` is a first-class output and must outnumber forced guesses on a healthy corpus.

`over_routed` and `under_routed` are directly cost-denominated, which is what makes them useful: `labelingQueue()` in `scripts/lib/fit.ts` already prices boundary swings in dollars per prompt, so an outcome verdict converts straight into "this cut point is costing $X".

### 6.6 Three-way agreement collapses the human's role

Each record ends with three independent tier estimates:

```
student tier    ← 35 features, prediction time
teacher prior   ← rubric on prompt text
realized tier   ← trajectory, after the fact
```

| Pattern | Action | Provenance |
|---|---|---|
| all three agree | store, no human | **bronze**, high confidence |
| prior **and** realized agree, student differs | store, no human — **the highest-value training example** | **silver** |
| prior and student agree, realized differs | ask the human — misleading prompt, or a confound | queue |
| all three differ | ask the human | queue |
| reviewer returned `unknown` | ask the human | queue |
| random control (~3%) | ask the human, **rendered identically** | gold |

This maps onto `src/label-combiner.ts` unchanged. It also *upgrades* its silver tier: silver is currently "RAG contextual consensus" at weight 0.3, a weak signal. Two independent judges concurring against the student is a much stronger silver, and the existing agreement-based recalibration (`FULL_PHASE_MIN_COMPARISONS = 30`, `FULL_PHASE_MIN_AGREEMENT = 0.7`) will find that out on its own if fed the comparisons.

### 6.7 Confounds — what this can and cannot calibrate

This is the section to read twice.

1. **Realized effort measures `difficulty × (1 / model capability)`, not difficulty.** A weak model taking 15 turns and a hard task taking 15 turns are indistinguishable from the trajectory alone. Normalize per-model from the event history, or hold the model fixed within any comparison.

2. **In Claude Code the executor is Claude, not the routed model.** The transcript measures what *Claude* needed, which is a reasonable difficulty proxy but is not the counterfactual for "would `zai/glm-4.7-flash` have coped?". The consequence is sharp and worth stating as a rule: **Claude Code outcome review calibrates the scorer and the boundaries; it cannot calibrate `DEFAULT_MATRIX` or any model's `maxEffort`.** Matrix calibration needs the gateway executing genuinely routed requests — that is what `eval/hybrid-routing-eval.ts` is for.

3. **Acceptance is not evidence of correct routing.** Route high and you get a thorough answer that looks justified; route low and you get a terse answer the user accepts, which also looks justified. The counterfactual is unobservable without intervention. Budget a ~5% **shadow stratum** that is deliberately routed one tier off and compare outcomes — without it, the loop can only confirm itself.

4. **The reviewer is grading its own model family's work.** Not a dishonesty problem — a perceptual one: work the model found easy reads as easy. Mitigations: the reviewer runs from `transcript_path` only, with no session context; the rubric forbids citing the answer's quality as evidence for tier; and the human control stratum from §3.5 still measures signed bias `E[reviewer − human]`. If that drifts past ±0.2 tiers, fix the rubric, not the boundaries.

5. **Attribution is genuinely messy.** One `prompt_id` can span several `Stop` events (the model pauses and continues), and one user *task* can span several prompts. Rule: attribute effort to the `prompt_id` that opened the record, close the record on the first `Stop` where `stop_hook_active` is false, and mark records with `userInterventions > 0` as multi-prompt — they are the queue's best entries anyway.

### 6.8 What the user does now

Nothing, in the normal case. The classifier is called on every prompt by a hook, the teacher votes in the user's place, the reviewer grades the finished work against the tier, and all three land on one `prompt_id`-keyed record. The human is asked only on the disagreement patterns in §6.6 and on the ~3% control — and the control is the part that keeps the whole loop honest, so it is the one thing that must never be optimized away.

---

## 7. Reality check — measured, 2026-09-04

Everything above is design. This section is measurement, run on this commit with `npm run eval:cv`, `eval:leaderboard`, `simulate:prompts`, and `fit:report`. It changes the recommended sequencing.

### 7.1 Accuracy on the golden distribution is better than the docs claim

`eval/ASSESSMENT.md` (45.6% exact / 84.4% adjacent) is stale — it is v0.5.2 and, as `ACCURACY_ROADMAP.md` §1.2 admits, was measured on the same set the boundaries were fit on. Cross-validated on this commit:

| Classifier | exact | ± | adjacent | bias | ECE | mode F1 | latency |
|---|---|---|---|---|---|---|---|
| `heuristic-linear` | **61.1%** | 7.0% | **94.4%** | +0.02 | 0.150 | 93.3% | 0.18 ms |
| `ordinal-logistic` | 58.9% | 5.7% | 91.1% | +0.03 | 0.149 | n/a | 0.22 ms |

Per-tier recall (heuristic): trivial 100% · light 66.7% · moderate 73.3% · **heavy 26.7%** · intensive 40.0% · extreme 60.0%.

Two gate failures stand out: **ECE 0.150** against the ≤0.10 requirement, and **heavy recall 26.7%** against ≥30%. Adjacent (94.4%) clears its ≥90% bar comfortably.

**The ordinal head is worse than the hand-weighted heuristic it was meant to replace** (58.9% vs 61.1%). That is the textbook signature of a 27-parameter model fit on 60 training examples, and it is the strongest empirical argument in this document for §3: the learned head is not a bad idea, it is a starved one.

### 7.2 On real-world prompts, the scorer routes 100% to `extreme`

`npm run simulate:prompts` over the 678-prompt MLJAR corpus — the only real-world traffic in the repo:

```
trivial 0 · light 0 · moderate 0 · heavy 0 · intensive 0 · extreme 678 (100.0%)
```

Direct measurement of why:

| | golden set | MLJAR (real) |
|---|---|---|
| score p50 | 0.16 – 0.50 across tiers | **0.765** |
| score **min** | 0.125 | **0.500** |
| prompt chars p50 | 113 | **1869** (16×) |

The top boundary is **0.485382**. The *minimum* real-world score (0.500) is above it, so **678/678 land in `extreme`**. `fit:report` reaches the same conclusion through its own path and prints the warning: *"Saturation: 100.0% of traffic above top boundary … top band carries >50% of traffic — tiers carry little resolution there"*, with all four lower boundaries flagged **"no nearby traffic — dead zone"** and a labeling priority queue containing exactly **one** item.

The mechanism is not a bug — it is the design working as documented. `ACCURACY_ROADMAP.md` §1 records that the scorer is length-dominant (`length 0.34`, "the strongest available signal"). Golden prompts are hand-written one-liners; real professional prompts are long because they are *well-specified*, not because they are hard. **On real traffic, length is a confounded feature.**

### 7.3 What this costs

| Scenario | Cost index (678 prompts) | Model share |
|---|---|---|
| **Today** | **8136** ($12.000/1M blended, mean) | 100% `claude-sonnet` |
| Recalibrated to a plausible mixed distribution | ~1985 | spread across the matrix |

So the honest cost answer for real-world use **today** is not the README's 60–90% saving. It is **zero saving, with routing overhead on top** — strictly worse than pinning the expensive model directly. The ~76% gap above is the *opportunity*, and the mix behind it is an assumption, which is precisely what the loop exists to replace with measurements.

### 7.4 Does the loop in §3–§6 fix this?

**The cost failure: yes, and the diagnosis is favorable.** Saturation is not total — only 10.6% of real prompts hit the hard 1.000 ceiling, and there are 90 distinct score values across 678 prompts. Fitting cut points to equal-frequency sextiles of real traffic yields five **non-degenerate** boundaries (0.640 · 0.700 · 0.765 · 0.850 · 0.960). There is real resolution left to exploit; the boundaries are simply in the wrong place for this distribution. Better still, the loop's designated transfer set *is* the corpus that exposes the failure.

**The accuracy failure: partially.** Refitting to quantiles only swaps one assumption (the golden distribution) for another (a uniform tier mix in real traffic). Teacher labels replace that assumption with judgments — that is the point of §3 — but two limits hold:

- The 10.6% pinned at 1.000 is a **representation** problem. No arrangement of cut points separates tied scores. Fixing it needs the feature work `ACCURACY_ROADMAP.md` already prescribes: normalize or re-saturate length, and add features that separate *long-and-routine* from *long-and-hard*. Teacher `evidence[]` spans (§3.4) are the fastest way to find them.
- Matrix and `maxEffort` calibration remains out of reach from Claude Code telemetry (§6.7 rule 2).

### 7.5 The finding that changes the sequencing

§5.2 and §6.6 budget human attention on the assumption that **the student is usually right**, so teacher–student disagreement is the rare, valuable case. At 100% `extreme`, that assumption inverts: the student says `extreme` for everything, so disagreement would be the overwhelming majority of traffic and the review queue becomes *everything*. The loop's entire ask-rate economy collapses if it is switched on before the saturation is addressed.

Recommended order — **do not ship the plugin for cost savings first**:

1. **Fix saturation.** Re-saturate the length feature and/or refit boundaries against real traffic. Cheap, and it is a prerequisite: labels collected from a scorer pinned at max carry almost no information.
2. **Then run the loop** (§3–§6) to convert the quantile assumption into judgments, and to mine rationales for the missing features.
3. **Then re-run `fit:report`** and quote cost efficiency from measurement.

### 7.6 Answering the question directly

> *Will this setup allow us to run GateSwarm in real-world use cases while maintaining high inference accuracy and cost efficiency?*

- **Inference speed and cost of the router itself:** already fine and not the constraint — 0.18 ms mean, zero model calls, zero dollars.
- **Accuracy:** 61.1% exact / 94.4% adjacent is respectable *on the golden distribution*, and unknown on the real one, because zero real-world labels exist today. ECE and heavy recall currently fail their gates.
- **Cost efficiency in real-world use, today:** no. 100% of real traffic routes to the most expensive model. The claimed 60–90% saving is unsupported on the one real corpus in the repo.
- **With the loop, after step 1:** plausible, and the arithmetic is attractive (~76% of the cost index is addressable) — but it must be *earned by measurement*, through the existing gates, not assumed.

The setup is **necessary and well-designed, but not sufficient on its own**, and its value is unlocked in a specific order. Every number above came from tooling already in this repository, which is the strongest thing that can be said for the project's honesty infrastructure: it detected its own headline failure without being asked to.


---

## 8. Saturation fix — implemented 2026-09-04

§7 diagnosed the failure. This section records the fix that shipped with it, and its measured effect.

### 8.1 Root cause

Every term in `heuristicScoreFromFeatures` was a **count or a flag**, and every one saturated. A long prompt maxed all of them at once, so the score measured *how much text is present* across a dozen proxies rather than how hard the task is. The golden set (median 18 words) and real traffic (median ~280 words) therefore occupied disjoint score ranges.

Confirming this, no existing feature separates real-world difficulty: against the MLJAR corpus's own declared level, the best is `multi_step` at Spearman +0.180, raw word count reaches +0.131, and **12 of 36 features have |rho| < 0.05**. A constrained grid search over reweightings of the existing features found 36 configurations that preserved golden accuracy and **not one** that spread real traffic beyond two tiers — the composite score topped out at rho 0.125, *worse than word count alone*. Reweighting could not fix this.

### 8.2 The change

Three parts, all in `packages/gateswarm-lite/src/feature-extractor.ts`:

1. **Two new features, both densities per 100 words** — the first length-normalized features in the vector, which is why they survive the distribution shift that breaks counts:
   - `openended_density` — verbs whose answer the prompt cannot mechanically determine (design, architect, optimize, evaluate, trade-off, justify, critique, prioritize). Real-traffic rho **+0.156**.
   - `structure_density` — bullet lines and `Label:` fields. A heavily structured prompt is a *specified* one, so it is easier than its length suggests. Real-traffic rho **-0.173**, the strongest signal of either sign.
2. **A density correction** on the evidence sum: `evidence x (REF/wordCount)^0.70` above `REF = 35` words, exactly 1 below it, so short-prompt behavior is untouched. Both constants were chosen by grid search against *both* distributions at once, under a hard guard that golden CV must not regress.
3. **Defensive coercion** (`num()`) so a pre-v0.6.1 `FeatureVector` missing the new fields reads as zero rather than poisoning the score with `NaN` — `heuristicScoreFromFeatures` is public API.

`DEFAULT_BOUNDARIES` were then refit **once** on the golden set, as `ACCURACY_ROADMAP.md` permits after a feature change: `[0.196029, 0.264209, 0.324887, 0.36585, 0.523832]`, mirrored into `v04_config.json`.

### 8.3 Measured effect

| | before | after |
|---|---|---|
| Golden CV exact | 61.1% ± 7.0% | **62.2% ± 6.5%** |
| Golden CV adjacent | 94.4% | **94.4%** |
| **heavy recall** | 26.7% (gate fail) | **33.3% (gate pass)** |
| extreme recall | 60.0% | **73.3%** |
| ECE | 0.150 | 0.177 (**still fails** <=0.10) |
| Real-traffic tiers used | **1 of 6** | **5 of 6** |
| Largest tier share | **100%** | **30.4%** |
| Real score range | 0.500 - 1.000 (disjoint from golden) | **0.209 - 0.690 (overlaps golden)** |
| Models receiving traffic | 1 | **4** |
| Providers receiving traffic | 1 | **3** (google, deepseek, anthropic) |
| **Cost index (678 prompts)** | **8136** ($12.000 mean) | **2090** ($3.083 mean) — **-74.3%** |
| Latency | 0.19 ms | 0.19 ms |
| Test suite | 429 pass | **429 pass** |

Real-traffic distribution is now light 135 / moderate 206 / heavy 121 / intensive 200 / extreme 16. `trivial` stays empty, correctly — none of 678 professional prompts is a greeting.

Difficulty ordering also emerged where there was none: Advanced prompts now reach `intensive` at 39.5% versus 28.9% for Beginner, and `extreme` at 4.7% versus 1.4%. Before the fix all three levels were indistinguishable (mean scores 0.39 / 0.38 / 0.39).

A useful side effect: the 100 KB repetitive-filler fixture (`'analyze this system '` x 5000) now scores `moderate` instead of saturating — repetition is correctly no longer read as difficulty.

### 8.4 What is fixed, and what is not

**Fixed.** The scorer no longer routes all real traffic to the most expensive model. Cost efficiency on the one real corpus is now measured at -74.3%, not assumed. Traffic distributes across 4 models and 3 providers. Golden accuracy improved rather than regressed, and heavy recall crossed its gate.

**Not fixed, and not claimed:**

- **ECE 0.177 still fails the <=0.10 gate**, and got slightly worse. Discrimination improved; the confidence estimate was not recalibrated to match. That is the next piece of work, and it blocks any claim of calibrated confidence.
- **Real-world accuracy remains unmeasured.** Spread is not correctness. rho against declared level is ~0.15 — a real signal, but weak, and declared level is a proxy for the topic's level, not the prompt's difficulty. Only the teacher/HITL loop in Sections 3-6 produces actual real-traffic tier labels.
- **The tier proportions are still an artifact of the golden distribution**, not a measurement of real traffic. They are now *plausible* rather than degenerate, which is what makes label collection worth doing — see Section 7.5.
- **`openai` remains unreachable** under `cheapest-capable`: `gpt-5-mini` and `gpt-5.2` are price-dominated by `deepseek-chat` and `gemini-pro` at every tier they serve. That is a property of `DEFAULT_MATRIX`, not of the scorer, and needs a matrix decision rather than a scoring change.

### 8.5 Sequencing, revisited

Section 7.5 warned that the distillation loop's ask-rate economics collapse while the student says `extreme` for everything. That blocker is now cleared: with five tiers in use and no tier above 31%, teacher-student disagreement becomes the informative minority the loop assumes. **The loop in Sections 3-6 is now safe to switch on.**
