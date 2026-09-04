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


---

## 9. Calibration + delegation plugin — implemented 2026-09-04

### 9.1 Calibration: the confidence signal was inverted, not merely miscalibrated

§8 left ECE at 0.177 against a <=0.10 gate. The cause was not a badly tuned
constant. Confidence came from distance to the nearest tier boundary
(`~0.06 margin -> 0.95`, on a boundary -> `0.5`), duplicated verbatim in
`src/ensemble-voter.ts` and `src/classifiers/heuristic-linear.ts`. Measured
out-of-fold on the golden set, that mapping runs the wrong way:

| margin band | mean margin | observed accuracy | old formula asserted |
|---|---|---|---|
| narrowest | 0.0036 | **75.0%** | 52.7% |
| middle | 0.0322 | 75.0% | 74.2% |
| wide | 0.0859 | **41.7%** | **95.0%** |
| widest | 0.1765 | 66.7% | 95.0% |

Boundary distance carries no information about whether the tier is right. This
is the same class of defect as `ASSESSMENT.md` #2 ("fake confidence"): a
constant 0.70 was replaced by a formula that *looks* principled and was never
checked against outcomes.

What does predict correctness is the **predicted tier itself**. Confidence is now
`P(correct | predicted tier)`, estimated out-of-fold with cut points refit on
inner train folds only, Laplace-smoothed (K=6) toward the accuracy prior:

| confidence source | ECE |
|---|---|
| old margin formula | 0.205 |
| constant = accuracy | 0.000 (calibrated but useless — carries no information) |
| **per-tier reliability** | **0.093** |

Shipped as `packages/gateswarm-lite/src/confidence.ts`
(`DEFAULT_TIER_RELIABILITY`, `confidenceForTier`, `fitTierReliability`,
`setTierReliability`) — hot-reloadable data, exactly like the tier boundaries,
and now the single source for both the runtime and eval paths, so the duplicated
constant that caused this cannot drift again. Measured on the pipeline:
**ECE 0.177 -> 0.086**, accuracy unchanged at 62.2% / 94.4%.

The table is honest about the weak band: `trivial` 0.752, `light` 0.787,
`moderate` 0.617, `heavy` 0.550, `intensive` 0.491, `extreme` 0.617. Confidence
below 0.5 on `intensive` is not a bug — it is the scorer reporting that it is
worse than a coin flip there, which is what makes it useful for triage.

### 9.2 The plugin

```
.claude-plugin/marketplace.json          -> claude plugin marketplace add pealmeida/gateswarm
plugins/gateswarm/
  .claude-plugin/plugin.json             userConfig: project, telemetry_dir, matrix_path
  .mcp.json                              npx gateswarm-mcp
  skills/model-delegation/SKILL.md       the injected skill
  commands/gs-route.md  gs-review.md  gs-recalibrate.md
```

The skill teaches one loop — **split -> route -> delegate -> grade ->
recalibrate** — and its load-bearing instructions are the constraints, not the
happy path:

- **Split on deliverable boundaries.** A unit that cannot be judged on its own
  cannot be graded, and an ungraded unit teaches nothing.
- **Grade against what the unit asked for**, not against what a larger model
  would have written. Marking a cheap model down for being terse on a `light`
  unit drives the matrix toward always routing high — the exact failure §7
  documented.
- **Grade the successes too.** A vote set of pure complaints makes every model
  look bad and the recalibration meaningless.
- **`judge: "human"` only when a person actually decided.** Model judgement is
  weighted lower on purpose; mislabelling it corrupts the signal that outranks it.
- **Never file a bad answer through `submit_feedback`.** That judges the *tier*
  and moves the complexity boundaries for every future prompt.

### 9.3 Two votes, two loops — kept structurally apart

| | judges | feeds | changes |
|---|---|---|---|
| `submit_feedback` | was the **tier** right? | golden dataset | `DEFAULT_BOUNDARIES` — which tier a prompt gets |
| `submit_outcome` | was the **output** good? | quality votes | `ModelSpec.quality` / `maxEffort` — which model serves a tier |

Separate record types, separate storage, separate consumers, and a test that
asserts a quality complaint is never counted as a tier verdict. Collapsing them
would let one bad answer shift routing for all future traffic.

### 9.4 Quality-driven recalibration

`packages/gateswarm-router/src/calibrate.ts` turns graded outcomes into a new
matrix. Two invariants:

1. **Quality is relative, never absolute.** Win rates are comparable only within
   one matrix on one workload, so recalibrated values are renormalised onto the
   input matrix's span. Otherwise a project with generous raters inflates every
   model and `minQuality` stops meaning anything.
2. **Evidence gates the move.** Estimates shrink toward the prior with K=8
   pseudo-counts, and `maxEffort` demotion needs >=5 graded outcomes at the
   ceiling tier below a 0.5 floor. Three votes cannot overturn a prior — by
   design. Human verdicts carry double weight.

End to end, with eight `inaccurate` votes for `deepseek-chat` at `heavy`:

```
deepseek-chat  quality 0.740 -> 0.550  n=8  maxEffort heavy -> moderate
routing for tier "heavy"  BEFORE: deepseek-chat   AFTER: gemini-pro
```

That is the requested behaviour concretely: **output quality changes what the
next prompt is routed to.** Transport failures are excluded from quality and
counted separately, so a provider outage does not read as a bad model.

### 9.5 State after this change

| gate | value | status |
|---|---|---|
| exact vs baseline | 62.2% (from 61.1%) | pass |
| adjacent >= 90% | 94.4% | pass |
| heavy recall >= 30% | 33.3% | pass |
| **ECE <= 0.10** | **0.086** | **pass** |
| real traffic tiers | 5 of 6, max share 30.4% | — |
| cost index | 2090 (from 8136), -74.3% | — |
| suite | **467 pass** (was 429) | pass |

All four scorer gates now pass simultaneously for the first time.

### 9.6 Still not claimed

- **Real-world tier accuracy is still unmeasured.** Calibration makes the
  confidence number honest; it does not make the tier right. Only real-traffic
  labels do that.
- **The reliability table is fitted on 90 golden prompts.** It is the correct
  shape and the correct source, but its values will move once real verdicts
  arrive — which is what `setTierReliability` exists for.
- **Recalibration has been tested, not proven in production.** The demotion
  thresholds (K=8, 5 samples, 0.5 floor) are reasoned defaults, not empirical
  ones; they are the first thing to revisit once real quality votes exist.
- **`openai` remains unreachable** under `cheapest-capable` — a `DEFAULT_MATRIX`
  property, unchanged here.


---

## 10. Is this the right architecture? — evaluated 2026-09-04

**Objective:** *automatically detect prompt complexity and route to the most
cost-efficient model, load-balancing token usage across multiple providers.*

Verdict in one line: **the approach is sound and nearly finished for the routing
half, has almost no cost headroom left to justify further classifier work, and
has no implementation at all for the load-balancing half.**

### 10.1 The classifier is already at 92% of its own ceiling

Measured on the golden set with `DEFAULT_MATRIX`:

| routing policy | cost per prompt | vs no router |
|---|---|---|
| always route `extreme` (no router) | $12.000 | — |
| **GateSwarm today** | **$4.398** | **-63.3%** |
| **perfect classifier** (oracle labels) | **$3.708** | **-69.1%** |

A classifier with **100% accuracy** would save only **5.8pp more** of the
no-router bill. GateSwarm already captures **91.7% of the total achievable
saving**.

This is the most consequential number in this document, and it retires an
argument made earlier in it. §3 proposed a teacher/HITL distillation programme
costing ~2-3 days of engineering, ~3M teacher tokens and 2-3 hours of human
attention. As a **cost** play, that programme is chasing at most 5.8pp and
realistically a fraction of it. It remains justified for *trust* — knowing the
tier is right, calibrated confidence, safe escalation — but it should no longer
be sold as a cost lever, and it should not be the next thing built.

Caveat, and it is a real one: this is computed on the 90-prompt golden
distribution. The real-traffic equivalent cannot be computed, because there are
no real-traffic labels — the same gap §7 and §8 flagged.

### 10.2 The system is being measured on the wrong axis

| metric | value |
|---|---|
| exact **tier** accuracy | 67.8% |
| correct **model** chosen | **75.6%** |

The objective does not care about tiers; it cares about which model gets the
request. Reported on the axis that matters, the router is ~8pp better than its
headline number says.

The gap exists because the tier space is finer than the decision space:

```
trivial  ─┐
light    ─┴─> gemini-flash-lite      6 tiers collapse to 4 models.
moderate ─┐                          2 of 5 boundaries cannot change
heavy    ─┴─> deepseek-chat          the decision, so misclassifying
intensive ──> gemini-pro             across them costs exactly $0.
extreme   ──> claude-sonnet
```

### 10.3 Accuracy effort is aimed away from the money

| boundary | cost jump | recall of the tiers it separates |
|---|---|---|
| `light`\|`moderate` | 2.7x | 60% / 73% |
| **`heavy`\|`intensive`** | **8.8x** | **33% / 33%** |
| `intensive`\|`extreme` | 1.5x | 33% / 73% |

The single most expensive decision in the system is the one the classifier is
worst at. Meanwhile effort is spread across a 6-way problem whose two cheapest
distinctions are financially free.

**The highest-return change available is not more labels — it is collapsing the
label space onto the decision space** and spending the whole accuracy budget on
the `heavy`|`intensive` line. A binary classifier at one boundary is a far
easier problem than 6-way ordinal, and it is where the 8.8x lives.

### 10.4 Load balancing: not implemented, and the code for it is orphaned

On 678 real prompts:

| | |
|---|---|
| provider concentration (Herfindahl) | **0.477** (0.250 = four providers even) |
| providers receiving traffic | 3 of 4 |
| models receiving traffic | **4 of 8** |
| never routed to | `gpt-5-mini`, `gemini-flash`, `gpt-5.2`, `claude-opus` |

`selectModel` is a pure `argmin(cost)` over the capable set. Same prompt, same
tier, same model, every time. There is no token accounting, no rate-limit
awareness, and no distribution policy in `gateswarm-router` at all.

The gateway has the parts — `src/provider-quota.ts` defines `ProviderQuota`,
`MultiWindowQuotaConfig` (5h / weekly / monthly), `LoadBalanceDecision`, and a
`rankProvidersForTier()` that scores providers by remaining RPM/RPD, health and
cost. **`rankProvidersForTier` has zero callers.** It was written and never
wired into selection. `LoadBalanceDecision` is imported by the gateway as a type
only.

So the third of the objective is not underperforming — it is absent, and its
implementation is sitting unused in the repository.

### 10.5 The objective as stated contains a conflict

"Most cost-efficient" and "load-balanced across providers" pull in opposite
directions whenever models are differently priced. Measured, on real traffic:

| policy | cost/prompt | provider HHI | providers |
|---|---|---|---|
| cheapest capable (today) | **$3.083** | 0.477 | 3 |
| cheapest 2, even split | $4.886 (+58%) | 0.319 | 4 |
| inverse-cost weighted | $5.887 (+91%) | 0.275 | 4 |
| all capable, even split | $17.320 (+462%) | 0.288 | 4 |

Buying evenness costs 58-462%. **Even distribution is almost certainly not what
you want.** What makes both halves of the objective true at once is a different
framing:

> minimise cost, **subject to** per-provider rate and quota limits, and to
> availability.

Under that framing load balancing is **free until a limit binds**: use the
cheapest capable model until its quota or rate limit is exhausted, then spill to
the next-cheapest capable one. Spread is a *consequence* of constraints, not a
goal traded against cost. That is a constrained-allocation problem — closer to
bin-packing with fallback than to classification — and it is what
`rankProvidersForTier` was evidently written for.

### 10.6 Alternatives, honestly

| approach | verdict |
|---|---|
| **Complexity tiers (current)** | Sound, cheap (0.19 ms, no model call), interpretable, and ~92% of the way to its own ceiling. Keep it. |
| **Cascade — try cheapest, escalate on failure** | The serious competitor. It *observes* capability instead of predicting it, so it needs no classifier and cannot be wrong about complexity. Given only 5.8pp of headroom remains, a cascade could plausibly match the classifier with no classifier at all. Costs: escalation latency, double-pay on escalation, and it needs an output verifier. **Worth benchmarking; the repo cannot yet answer whether it wins, because that needs per-model quality data — which `submit_outcome` (§9) now collects.** |
| **Learned per-model win-rate router** | Strictly more expressive than tiering: predict P(model m answers acceptably) per model rather than forcing models onto one capability rank. But it buys ≤5.8pp on cost, so it is a *quality* play, not a cost one. Reachable incrementally from the §9 outcome data. |
| **Contextual bandit over models** | Uniquely, it handles distribution natively — exploration *is* load balancing — and self-calibrates without upfront labels. Costs: exploration spend, cold start, harder to reason about and to explain to a user. |
| **Constrained allocation with spillover** | Not an alternative to the classifier — the missing complement to it. This is what objective 3 actually requires. |

### 10.7 Recommendation

1. **Stop investing in classifier accuracy for cost reasons.** 5.8pp of headroom
   does not repay the distillation programme. Keep §3-§6 on the shelf for when
   the goal is trust rather than spend.
2. **Report decision accuracy (75.6%), not tier accuracy (67.8%)**, and collapse
   the tier space onto the decision space. Then put the whole accuracy budget on
   the `heavy`|`intensive` boundary, where the 8.8x is.
3. **Build the spillover router** — wire `rankProvidersForTier` into selection,
   give `gateswarm-router` an optional quota/health input, and return a ranked
   capable set rather than a single winner. This is the only objective with a
   real gap, and most of its code already exists.
4. **Benchmark a cascade against the classifier** using `submit_outcome` data
   once enough quality votes exist. If the cascade wins, the classifier becomes
   a latency optimisation rather than the core mechanism — which is worth
   knowing before investing further in either.

One caveat on the whole evaluation: every number here uses `DEFAULT_MATRIX`,
which the repo itself documents as "a reviewed starting point, NOT a source of
truth". The headroom, the boundary values, and the concentration figures all
move with the real matrix. Re-run this evaluation against the models you can
actually reach before acting on it.


---

## 11. Does the classifier earn its keep? — measured 2026-09-04

Separate the question, because the two halves have opposite answers.

### 11.1 A router: yes, decisively

Routing is worth **-63.3%** against no router, costs **0.19 ms** and **$0** per
prompt, makes no network call, and is fully interpretable. Nothing else in the
system delivers a return like that. §10's small *remaining headroom* (5.8pp)
has been read as "the router is marginal" — it is the opposite claim: the router
has already taken almost all of the money that was there to take.

### 11.2 This classifier, as 35 features: not on the available evidence

Same 5-fold CV, cut points refit per fold, only the score function swapped:

| scoring function | tier acc | model acc | $/prompt | under-routed |
|---|---|---|---|---|
| **full 35-feature scorer** | 63.3% | 73.3% | $4.168 | 8.9% |
| **`log(word count)` alone** | **70.0%** | **84.4%** | $4.122 | 1.1% |
| **`log(character count)` alone** | **85.6%** | **86.7%** | **$3.869** | 2.2% |
| random score | 20.0% | 22.2% | $8.194 | 17.8% |
| always cheapest | 16.7% | 33.3% | $0.325 | **66.7%** |
| always most capable | 16.7% | 16.7% | $12.000 | 0.0% |
| oracle | 100% | 100% | $3.708 | 0.0% |

**A one-line character count beats the entire feature apparatus by 22pp on tier
accuracy and 13pp on model accuracy, while costing less and under-routing less.**
It lands within 4% of the oracle's cost.

### 11.3 Why — and why the eval cannot settle it

The golden set is length-separated by construction:

| tier | interquartile char range |
|---|---|
| trivial | 22 - 27 |
| light | 57 - 98 |
| moderate | 86 - 94 |
| heavy | 114 - 127 |
| intensive | 160 - 176 |
| extreme | 192 - 203 |

**Only 1 of 15 tier pairs has overlapping interquartile length ranges.** Whoever
wrote `eval/dataset.json` wrote longer prompts for harder tiers, so the benchmark
encodes "harder = longer" as a near-deterministic rule and rewards any model that
learns exactly that.

Two things follow, and both matter:

1. **The 85.6% is not evidence that length measures complexity.** It is evidence
   that the dataset was built that way.
2. **Every accuracy number this project has ever reported — 45.6%, 61.1%, 62.2% —
   was measured on a benchmark a one-liner scores 85.6% on.** The 35-feature
   scorer does not merely fail to beat the trivial baseline; it loses to it by a
   wide margin on its own benchmark.

On real traffic the rule the golden set teaches is simply false:

| declared level | median chars |
|---|---|
| Beginner | 1504 |
| Intermediate | **1965** |
| Advanced | 1895 |

Non-monotonic — Intermediate prompts are longer than Advanced ones. And measured
earlier, length correlates with real difficulty at rho 0.131 while the full
composite reaches only ~0.15. **On neither dataset is there evidence that the 35
features beat length.**

This also completes the root-cause chain for §7:

```
golden set written with length ≈ difficulty
   -> scorer calibrated length-dominant (weight 0.34, "strongest available signal")
      -> real traffic breaks the assumption (length ⊥ difficulty)
         -> every real prompt saturates -> 100% routed to `extreme`
```

The saturation bug was not a coding error. It was the benchmark's construction
propagating into production.

### 11.4 What this changes

**Keep the router. Stop treating the feature set as earned.** Concretely:

1. **Add a length-only baseline to `eval/leaderboard.ts` immediately.** It is
   ~20 lines against the existing `TierClassifier` interface, and it is the
   guard the eval has never had: *any* model that cannot beat `log(chars)` is not
   paying for its complexity. Had this existed, the 35 features would never have
   shipped unchallenged.
2. **The golden dataset needs length-decorrelated examples** — short-and-hard
   ("prove this is NP-complete"), long-and-easy (a 2000-character templated
   formatting request. This is the highest-value labelling work available, and
   it **revives the teacher/HITL programme of §3-§6 with a different target**:
   not more labels, but *adversarial* labels that break the length confound.
   §10 retired that programme as a cost play; this reinstates it as a validity
   play, which is a better justification than the one it originally had.
3. **Keep the classifier as the capable-set selector.** Even under §10.5's
   constrained-allocation architecture, something must decide which models are
   eligible before quota spillover can choose among them. That job survives
   regardless of how the score is computed — and today it could be computed by
   `log(chars)` with no measured loss.

### 11.5 The cascade question, quantified

Try the cheapest model first, escalate to the top on failure, paying for both:

- beats today's real-traffic $3.083/prompt if the cheapest model handles
  **>= 77.0%** of prompts unaided;
- beats the golden-set $4.398/prompt if it handles **>= 66.1%**.

Both ignore verifier cost and escalation latency, which favour the classifier.
Whether `gemini-flash-lite` clears 77% is exactly the kind of question
`submit_outcome` (§9) now collects data for, and it cannot be answered from
anything currently in this repository.

### 11.6 Answer

**Yes, keep a classifier — but a much smaller one than this, and stop reporting
its accuracy against a benchmark that cannot distinguish it from counting
characters.** The routing layer is the most valuable component in the system.
The 35-feature complexity model inside it is, on all available evidence,
unearned.


---

## 12. Evolving the classifier to predict effort, not length — measured 2026-09-04

§11 showed the scorer cannot beat counting characters on its own benchmark. This
section is the answer to "what would actually work", and it is measured rather
than proposed.

### 12.1 The decisive test is partial correlation, not correlation

A feature that correlates with difficulty *because it correlates with length* is
worthless — it re-imports the confound that caused the saturation failure. The
right screen is **partial Spearman correlation with difficulty, controlling for
log(length)**.

Run against the real-traffic corpus, that screen finds something the raw
correlation completely hides:

| signal | raw rho | **partial rho** (length controlled) |
|---|---|---|
| `requirement_count` | -0.063 | **-0.296** |
| `structure_density` | -0.160 | **-0.244** |
| `sentence_count` | +0.041 | **-0.201** |
| `multi_step` | +0.180 | +0.182 |
| `conjunction_enumeration` | +0.031 | **-0.150** |
| `technical_design` | +0.176 | +0.148 |
| `deictic_density` *(new candidate)* | -0.172 | -0.142 |
| log(chars) — the confound | +0.131 | — |

`requirement_count` is the strongest signal in the entire feature set once length
is held constant, it was invisible at raw rho -0.063, and **it points the opposite
way from how the scorer uses it.**

The pattern is coherent: **specification markers are negative predictors of
difficulty.** A prompt that enumerates its requirements, splits into sentences and
lists its constraints is *easier* than one of the same length that does not — it
has done the decomposition work for the model. The scorer adds all of these with
positive weights.

### 12.2 The signs are wrong, and length hid it

Fitting a ridge model on **length-normalised** features (every count divided by
word count), with a 70/30 split of the real corpus:

| model | held-out rho vs real difficulty |
|---|---|
| `log(chars)` alone | 0.083 |
| current shipped scorer | 0.244 |
| **length-residualised refit** | **0.399** |

**64% better than the shipped scorer, on held-out real data**, using the *same
features* — only the representation (densities) and the signs/weights (learned,
not hand-set) changed.

Three sign conflicts the refit surfaced:

| feature | scorer uses | data says |
|---|---|---|
| `requirement_count` | +0.012 each | **negative** |
| `sentence_count` | + (via `structScore`) | **negative** |
| `has_negation` | +0.02 | **negative** |

This explains why the composite barely beat length in §11: correctly-signed
features were being cancelled by wrongly-signed ones, and the length term carried
the result.

### 12.3 What to change, in order

**1. Representation: densities, never counts.** Divide every count feature by
prompt length. This is not a tweak — it is the single change that removes the
confound, and §8 already showed it works (the two density features added there are
the two strongest length-independent signals in the set). *Any new feature that is
a raw count will re-import the bug.*

**2. Learn the weights; stop hand-setting them.** The hand-weighted linear sum is
the mechanism by which three signs ended up backwards. The repo already has
`OrdinalLogisticClassifier` for this. §7.1 found it *underperforming* the
heuristic (58.9% vs 61.1%) — but that was on the length-separable golden set,
where the heuristic's length dominance is an advantage. On real data with density
features, the ordering should reverse. That is a cheap experiment and it has not
been run.

**3. Change the target: predict observable effort, not an assigned tier.** This is
the deepest change. "Complexity" is a latent property people disagree about;
**effort is observable** — turns taken, retries, tokens spent, whether a cheap
model coped. §6's outcome review already collects exactly this. Predicting a
measurable quantity converts a 6-way ordinal classification on subjective labels
into a regression on ground truth, and it makes the target *identical* to what the
objective in §10 actually cares about.

**4. Guard everything with the length baseline.** `log(chars)` in
`eval/leaderboard.ts` as a permanent row. Nothing ships that cannot beat it.

### 12.4 Signals worth adding — and the ones that failed

Twelve length-independent candidates were tested. Most did **not** clear
|partial rho| >= 0.10 and should not be built:

- failed: `unverifiable_ratio`, `checkable_ratio`, `definiteness`,
  `chained_reference`, `tradeoff_pressure`, `decision_points`, `why_how_ratio`,
  `subordination`, `rare_token_ratio`, `words_per_clause`
- survived: `deictic_density` (-0.142) — how much unresolved external reference
  the prompt carries; `multiplicity` (+0.107) — whether many answers are
  acceptable

That is a 2-from-12 hit rate on plausible-sounding features, which is the point:
**the existing features already carry more signal than new ones, they are just
mis-signed and swamped by length.** Fixing representation and signs is worth far
more than inventing features, and should come first.

### 12.5 Honest limits

- **The target is a proxy.** MLJAR `level` describes the *topic's* level, not the
  task's difficulty. rho 0.399 against a noisy label is real movement, not a
  claim about true difficulty. Observed effort (step 3) is the fix.
- **One corpus, one genre.** 678 professional role-prompts. Nothing here has been
  checked against conversational or agentic traffic.
- **The refit is a proof of concept**, not a shippable model: 37 parameters on 474
  training rows, and no calibration, gates or snapshots.
- **There is a real tension to resolve.** Flipping `requirement_count` and
  `sentence_count` improves real-traffic correlation but will likely *hurt* golden
  CV accuracy, because the golden set rewards length-alignment. That is a decision
  about which distribution the project is optimising for, and it should be made
  deliberately rather than discovered through a regression.


---

## 13. Adversarial review + the cost/accuracy index — 2026-09-04

### 13.1 On the Codex request

**Codex was not used, and no output here came from it.** There is no `codex`
binary or OpenAI credential in this container, no codex plugin installed, and a
catalog search returned nothing related. The review below is Claude's, run
against its own changes. A second-model review remains worth doing — this is not
a substitute for it, and nothing here should be cited as one.

### 13.2 Findings

Four checks aimed at the changes made this session, worst-case first.

**#1 — Calibration leak. NOT PRESENT (verified, not assumed).**
`DEFAULT_TIER_RELIABILITY` is fitted on all 90 golden prompts, so if the eval
used the shipped table the reported ECE would be leaked. It does not:
`eval/lib/runner.ts:67` calls `model.fit(trainEx)` whenever
`requiresTraining`, and `HeuristicLinearClassifier.fit()` refits reliability
out-of-fold on the training folds only. **ECE 0.086 is honest.**

**#2 — Zero-evidence quality drift. CONFIRMED BUG, FIXED.**
`recalibrateMatrix` renormalised every model onto the prior span using the new
min/max. Grading one model down therefore moved six models that had **no
observations at all** — `gemini-flash-lite` 0.550 → 0.669, enough to carry a
model across a `minQuality: 0.6` gate on evidence about a *different* model.
Replaced with a clamp into the prior span: a model with no samples now keeps its
prior exactly. Two regression tests pin it, including one asserting that a
`minQuality` cohort cannot change for an ungraded model.

**#3 — Ambiguous cost baseline. CONFIRMED BUG, FIXED.**
The report's "no router" baseline was the model with the highest `maxEffort`.
`claude-sonnet` and `claude-opus` tie there, so the baseline — and therefore
*every saving figure* — was whichever happened to sort first. Routing everything
to `claude-opus` scored an index of **-4.0** against a `claude-sonnet` baseline.
Ties now break on quality, then cost, and the report prints which model the
baseline is. A negative index is kept rather than clamped: spending more than the
baseline is a real outcome and should be visible.

**#4 — Retired model ids flatter the saving. CONFIRMED, FIXED.**
A decision naming a model absent from the current matrix was silently repriced at
today's cheapest capable substitute, understating real spend. Now counted as
`unpricedDecisions` and surfaced as a caveat.

**#5 — Density constants tuned and reported on the same corpus. DISCLOSED, TESTED, HOLDS.**
`DENSITY_REF_WORDS = 35` and `DENSITY_EXPONENT = 0.70` were grid-searched on the
full 678-prompt corpus whose spread was then reported — no held-out validation at
the time. Split test since:

| split | entropy | top tier share |
|---|---|---|
| half A (tuning-like) | 0.786 | 33.0% |
| **half B (held out)** | **0.816** | **30.1%** |
| golden set (different genre) | 0.963 | 21.1% |

The spread generalises to unseen prompts and to a different genre, and
neighbouring grid configs land in a broad plateau rather than a spike. The
methodological weakness is real and is recorded; the result survives it.

**#6 — `structure_density` false-positives on prose. OPEN, not fixed.**
`LABELLED_FIELD_RE` matches any capitalised word followed by a colon, so prose
containing `However:`, `Note:` or `TODO:` scores 23.08 structure per 100 words
and is therefore rated *easier*. Real, lower severity than #2-#4, and left open
deliberately: tightening the regex changes scores and would require regenerating
both frozen snapshots and re-validating §8's numbers. It should be fixed with
that revalidation, not slipped in beside it.

Suite after the fixes: **482 tests pass** (was 467), typecheck and build clean,
scorer metrics unchanged (62.2% / 94.4% / ECE 0.086).

### 13.3 The cost-efficiency and accuracy index

Shipped as `packages/gateswarm-mcp/src/report.ts` plus a `cost_report` MCP tool.

The governing rule is that **a savings number without its counterfactual is
marketing, not measurement**, so every figure names what it is measured against
and carries its denominator:

```
GateSwarm token economy — project "demo"

  Routed                48 prompts
  Baseline (no router)  576.00 blended $/1M  — every prompt at claude-opus
  Routed                130.58 blended $/1M
  Saved                 445.42  (77.3%)
  Cost-efficiency index 0.773   (1 = free, 0 = no better than the baseline, negative = worse)
  Metered tokens        in 16,920 / out 8,760 over 16 call(s)

  Tier mix
    trivial    ██████······    24  50.0%
    light      ███·········    12  25.0%
    ...
  Accuracy index (was the TIER right?)     66.7% ±23.6pp  (n=12)
  Quality index  (was the OUTPUT good?)    81.3%  (n=16, 4 human)

  Trend (oldest → newest)
    window        prompts   saving   accuracy   quality
    7d-0d ago         48    77.3%     66.7%     81.3%

  Read this before quoting any number above:
    · metered tokens cover 16/48 decisions; the rest is projected
```

Design decisions worth naming:

- **Two indices, never merged.** Accuracy answers *was the tier right* (from
  `submit_feedback`); quality answers *was the output good* (from
  `submit_outcome`). Averaging them would hide which half is failing.
- **Rates below 10 observations are withheld, not printed.** The report says
  "n/a (2 verdicts, needs 10)" rather than "50%".
- **Wilson intervals, not normal approximation** — at n=12 the honest error bar
  is ±23.6pp, and the normal approximation would understate it.
- **Projected vs metered is explicit.** Costs are matrix-projected until callers
  pass `tokensIn`/`tokensOut` to `submit_outcome`; partial coverage is stated as
  a fraction rather than extrapolated.
- **A quality index resting only on model self-judgement says so.** Without human
  verdicts it is a model grading itself, and the report refuses to present that
  as neutral.

### 13.4 What the index cannot tell you

- **It measures projected price, not delivered value.** A 77% saving on outputs
  nobody checked is not a saving. That is why the quality index sits beside it,
  and why the caveat block exists.
- **The baseline is a counterfactual, never observed.** Nobody ran this traffic
  through `claude-opus`; the comparison assumes it would have succeeded there.
- **Accuracy still rests on tier labels**, which §11 showed are measured against
  a length-separable benchmark. The index reports the verdicts it is given
  faithfully — it cannot repair the label problem underneath them.


---

## 14. structure_density prose false-positive — fixed 2026-09-04

§13.2 finding #6, deferred there because it moves scores and needed the frozen
snapshots regenerated alongside a revalidation of §8. Done here as one change.

### 14.1 The defect

`LABELLED_FIELD_RE` matched any capitalised word followed by a colon at the start
of a line, so discourse markers counted as input fields:

| prompt | old matches |
|---|---|
| `However:` / `Note:` / `Therefore:` / `TODO:` (pure prose) | **4** |
| a genuinely specified prompt with four input fields | 4 |

Indistinguishable. Since `structure_density` is a *negative* predictor — a
specified prompt is easier than its length implies — prose with asides was being
rated **easier than it is**, in exactly the direction that under-routes it.

### 14.2 The fix

Two rules, both narrow:

1. **A discourse stoplist.** `however, note(s), therefore, thus, warning,
   caution, important, tip, hint, todo, fixme, ps, nb, update, edit, disclaimer,
   reminder, aside, caveat, result, conclusion, in short, for example` are
   dropped when they appear as a line label.
2. **The first surviving label is free.** One `Sources: …` line is punctuation;
   structure means the pattern *repeats*. Implemented as `max(0, kept - 1)`,
   which avoids a threshold cliff and stays monotone.

Bullets are untouched — a list is unambiguous structure.

| case | before | after |
|---|---|---|
| prose with 4 discourse markers | 23.08 | **0.00** |
| single `Note:` aside | >0 | **0.00** |
| genuinely specified prompt | — | 17.65 |
| mixed (`Note:` + 2 real fields) | — | 8.33 |
| bulleted list | — | 42.86 |
| unstructured hard prompt | 0.00 | 0.00 |

### 14.3 Revalidation — the fix improved every gate it touched

| metric | §8/§9 | after fix |
|---|---|---|
| golden CV exact | 62.2% | **63.3%** |
| golden CV adjacent | 94.4% | 94.4% |
| **ECE** | 0.086 | **0.057** |
| light recall | 60.0% | **66.7%** |
| heavy / intensive recall | 33.3% / 33.3% | 33.3% / 33.3% |
| signed bias | +0.03 | +0.07 |
| real-traffic tiers used | 5 of 6 | 5 of 6 |
| largest tier share | 30.4% | 30.2% |
| cost index (678 prompts) | 2090 | 2148 |
| models / providers | 4 / 3 | 4 / 3 |
| suite | 482 | **488 pass** |

The false positive was costing accuracy, not just tidiness. Cost index rose 2.8%
— prompts whose prose asides had been mistaken for specification are no longer
discounted into a cheaper tier, which is the correction working.

### 14.4 Fitted artifacts

- **`DEFAULT_BOUNDARIES`: unchanged.** Refitting on the new scores moved them by
  at most 4.75e-7 — pure display rounding from when they were shipped. No churn.
- **`DEFAULT_TIER_RELIABILITY`: regenerated**, per the rule in `confidence.ts`
  that the table is refit whenever the scorer changes on purpose. Two tiers had
  drifted past 0.02 (`trivial` 0.752 → 0.820, `moderate` 0.617 → 0.595). The
  accuracy prior moved 0.6333 → 0.6444.
- **`lite-score-snapshot.json`: byte-identical.** None of its nine fixtures
  contains a colon-labelled line, which is itself evidence the fix is targeted.
- **`mljar-score-snapshot.json`: regenerated** — 132 of 678 prompts moved; the
  other 546 were untouched.

Six regression tests pin the behaviour, including that a discourse marker inside
an otherwise structured prompt is dropped while the real fields survive.


---

## 15. The length-only baseline — shipped 2026-09-04

§11.4's first recommendation, implemented: `src/classifiers/length-baseline.ts`,
registered in `eval/leaderboard.ts`.

### 15.1 What it is

A `TierClassifier` that ranks prompts by raw character count and nothing else.
It plays by the same rules as every other row — cut points fitted on the training
folds only, confidence calibrated out-of-fold — so the comparison is fair rather
than rigged toward the baseline.

It declares **no** `predictMode`. Length cannot separate planning from acting, and
a number in that column would be noise dressed as a measurement.

One implementation note worth recording: `fitMonotonicCutPoints` fits arbitrary
cut points over the score and log is monotone, so `LOG_CAP` **cannot change a
single tier prediction** — it only keeps the score in [0,1] for display and
calibration. Ranking by characters and by words are genuinely different orderings
though (a prompt of long words has more characters but fewer words), and
characters is the stronger baseline (86.7% vs ~70%), so the guard uses the
harder-to-beat one.

### 15.2 What it says

```
model                      exact       ±      adj    bias     ECE   modeF1        ms
length-only                86.7%    4.4%    95.6%   +0.13   0.028      n/a      0.00
heuristic-linear           63.3%    6.7%    94.4%   +0.07   0.057    93.3%      0.21
ordinal-logistic           58.9%    7.5%    94.4%   +0.02   0.154      n/a      0.24

Baseline guard — "length-only" ranks by prompt length alone: 86.7% exact.
  ✗ BEATEN BY THE BASELINE: heuristic-linear (63.3%), ordinal-logistic (58.9%)
    Either the model is not earning its complexity, or this dataset is separable
    by length and cannot measure what it claims to. Check the dataset first.
```

The leaderboard now states the verdict rather than leaving it to be inferred from
a table, and it names both readings — because on this dataset the second one is
the true one, and pointing only at the models would misdiagnose it.

Note the baseline also wins on ECE (0.028) and adjacent (95.6%). It is not merely
more accurate here; it is better calibrated. That follows from the same cause —
on a length-separable benchmark, length is close to the true label.

### 15.3 Two tests that are meant to fail one day

`tests/length-baseline.test.ts` encodes the §11 finding as live assertions rather
than prose, each with an explicit note that failure is good news:

- **`records that eval/dataset.json is separable by length alone`** — asserts the
  baseline exceeds 80% exact. If it drops, the dataset has been given
  length-decorrelated examples: update the bound and re-check the models.
- **`records that the shipped scorer does not yet clear the baseline`** — asserts
  `heuristic-linear < length-only`. When that fails because the scorer overtook
  length, the guard has done its job: delete the test, keep the leaderboard row.

Prose in a spec decays silently. An assertion cannot.

### 15.4 What this closes, and what it does not

**Closes:** the eval can no longer report an accuracy figure without the trivial
baseline standing beside it. Had this row existed, the 35 features would never
have shipped unchallenged, and §7's saturation failure — length-dominance learned
from a length-separable benchmark and carried into production — would have been
visible at the point it was introduced.

**Does not close:** the baseline is a guard, not a fix. The dataset is still
length-separable, real-world tier accuracy is still unmeasured, and the scorer
still loses to a one-liner on the only benchmark available. §12 is the work that
changes those; this is the instrument that will tell you whether it did.

Suite: **495 tests pass** (was 488).


---

## 16. Length-decorrelated examples — dataset v2, 2026-09-04

§12.3 named this the highest-value labelling work available. Done: 36 new
examples, `eval/dataset.json` 90 → 126, splits regenerated as v2.

### 16.1 What was added

Six per tier, written to invert the staircase rather than extend it:

| tier | old median chars | **new median chars** | kind |
|---|---|---|---|
| trivial | 26 | **423** | verbose preamble, one-token answer |
| light | 70 | **411** | long input, single mechanical transform |
| moderate | 88 | **433** | three short, three long — deliberately mixed |
| heavy | 123 | **53** | short, needs real reasoning |
| intensive | 167 | **40** | short, needs deep reasoning |
| extreme | 200 | **44** | short, top of the difficulty range |

Existing ids are untouched — new prompts are appended, so `effort:<tier>:<index>`
never shifts for anything already labelled.

### 16.2 It worked, and the measurement is unambiguous

**Length-to-tier Spearman correlation:**

| set | rho |
|---|---|
| original 90 | **0.956** — near-deterministic |
| the 36 new | **-0.790** |
| **combined 126** | **0.293** |

**Accuracy on old vs new examples, 5-fold, fit on train only:**

| model | on the original 90 | **on the 36 new** |
|---|---|---|
| `length-only` | 85.6% | **0.0%** |
| `heuristic-linear` | 62.2% | **11.1%** |

The length baseline scores **zero** on the new examples — exactly what a
length-decorrelated set should do to a length model. The shipped scorer scores
**11.1%**, which is the finding that matters: it fails the new examples almost as
completely as the baseline does. §11 argued from correlation that the 35 features
add little beyond length; this measures it directly.

Leaderboard, v1 → v2:

| model | v1 exact | v2 exact | v1 adjacent | v2 adjacent |
|---|---|---|---|---|
| `length-only` | 86.7% | **59.5%** | 95.6% | **70.5%** |
| `heuristic-linear` | 63.3% | 46.5% | 94.4% | 79.0% |
| `ordinal-logistic` | 58.9% | **50.0%** | 94.4% | 87.5% |

Two things worth noting. The baseline's *adjacent* accuracy collapsed 25pp — on
v2 length no longer makes merely off-by-one errors. And **`ordinal-logistic` now
beats `heuristic-linear`** (50.0% vs 46.5%), reversing v1. That is precisely what
§12.3 predicted: the learned model lost on v1 because length-dominance was an
*advantage* there. On a benchmark that is harder to game, it wins.

The guard still fires — length-only still leads at 59.5% — because 90 of 126
examples remain the original length-separated ones. `0.714 x 85.6% + 0.286 x 0%`
≈ 61%, which is what is observed. Reaching parity needs roughly 54 more
decorrelated examples.

### 16.3 Split versioning

`eval/split.ts` refuses to overwrite frozen splits, so this generated
`folds.v2.json` / `holdout.v2.json` and a v2 MANIFEST; the v1 files stay on disk
as history. The version was hardcoded in **seven** places, where a bump risked
leaving one consumer reading old folds against a new dataset hash. It now lives
once, as `ACTIVE_SPLIT_VERSION` in `eval/lib/split.ts`, with every consumer
importing `foldsFile()` / `holdoutFile()` / `trainFile()`.

### 16.4 Two fitted-artifact decisions, both measured

**`DEFAULT_BOUNDARIES`: NOT refit. Evidence, not preference.**

Refitting on v2 barely moves them (`0.1960 → 0.1974`, `0.3659 → 0.3607`), and:

| | v2 CV exact |
|---|---|
| cut points refit per fold | 47.6% |
| **shipped v1 boundaries** | **53.2%** |

The shipped boundaries *beat* refitting — fitting cut points to a bimodal
adversarial distribution overfits the fold. On real traffic the refit is also
slightly worse (entropy 0.798 vs 0.806, top share 32.3% vs 30.2%). This is
`ACCURACY_ROADMAP.md`'s claim confirmed empirically: **boundaries cannot fix a
representation problem.** The new examples expose a feature gap, and moving cut
points to chase them would trade real-traffic behaviour for examples the feature
set cannot express.

**`DEFAULT_TIER_RELIABILITY`: refit to v2.** The accuracy prior fell 0.6444 →
0.4762, and `intensive` from 0.4939 to 0.2648. The v1 values were not
conservative estimates that turned out wrong — they were inflated by the same
confound as everything else measured on v1: where length ≈ label, the scorer
looks reliable because length is. Shipped with an explicit note that they are a
floor rather than a verdict, since v2 over-weights adversarial examples; the true
figure on real traffic sits between the two, and `setTierReliability()` is how
real verdicts should eventually replace both.

### 16.5 State

| | v1 | v2 |
|---|---|---|
| golden CV exact | 63.3% | 46.5% |
| golden CV adjacent | 94.4% | 79.0% |
| ECE | 0.057 | 0.136 |
| length-to-tier rho | 0.956 | **0.293** |
| **real-traffic distribution** | 5 tiers, top 30.2% | **unchanged** |
| **cost index** | 2148 | **unchanged** |
| suite | 495 | **495 pass** |

Production behaviour is byte-identical — no boundary moved, so routing did not
change. What changed is that **the numbers are now honest**. The drop from 63.3%
to 46.5% is not a regression; it is the same scorer measured against a benchmark
that can no longer be passed by counting characters.

### 16.6 Caveats

- **The labels are one author's judgement.** They are defensible but unreviewed,
  which is exactly the human-verdict gap §3 exists to close. These 36 should be
  the first batch through `/gs-audit`.
- **rho 0.293 is not 0.** The new examples are deliberately inverted (-0.790)
  rather than length-neutral, so each tier is now bimodal in length. That kills
  the length shortcut but is not the same as length being independent of
  difficulty.
- **v2 is a stress test, not a representative sample.** Real traffic is neither
  v1's short hand-written prompts nor v2's adversarial mix, and no number here
  should be quoted as real-world accuracy.


---

## 17. Dataset v3 — the remaining 54, and the first model to clear the baseline

§16 left the benchmark at 126 examples with length-to-tier Spearman 0.293, and
the length baseline still winning at 59.5%. This adds the remaining 54.

### 17.1 A design change from v2

v2's 36 examples were **inverted** (rho -0.790): long-and-easy, short-and-hard.
That cancels the correlation but leaves every tier *bimodal* in length — very
short or very long, nothing between. Adding more of the same would have driven
the combined rho toward zero by cancellation while making the length distribution
stranger, not more realistic.

v3's 54 instead **fill each tier's length range**. Before, no hard tier had a
single example between 250 and 550 characters, and `trivial` had nothing between
60 and 250:

| tier | bands present at v2 | **at v3** |
|---|---|---|
| trivial | `[14, 0, 6, 0]` | `[14, 5, 6, 4]` |
| light | `[5, 10, 6, 0]` | `[7, 11, 9, 3]` |
| moderate | `[2, 16, 3, 0]` | `[6, 16, 6, 2]` |
| heavy | `[6, 15, 0, 0]` | `[6, 15, 6, 3]` |
| intensive | `[6, 15, 0, 0]` | `[6, 15, 8, 1]` |
| extreme | `[6, 15, 0, 0]` | `[6, 16, 7, 1]` |

*(bands: 25-60 / 60-250 / 250-550 / 550+ characters)*

Every tier now spans every band.

### 17.2 The correlation landed where it should

| example generation | length-to-tier rho |
|---|---|
| v1 originals (90) | 0.956 |
| v2 inverted (36) | -0.790 |
| **v3 range-filling (54)** | **-0.026** |
| **all 180** | **0.194** |
| *real traffic, for comparison* | *~0.131* |

The v3 examples are essentially **length-neutral by construction**, and the
combined benchmark now carries a length structure close to production's. That is
the right stopping point — not chance (0.0), which would be *less* realistic than
production, but parity with what real traffic actually looks like.

### 17.3 Accuracy by example generation

| model | v1 originals (90) | v2 inverted (36) | **v3 range-filling (54)** |
|---|---|---|---|
| `length-only` | 84.4% | 0.0% | **22.2%** |
| `heuristic-linear` | 55.6% | 11.1% | **33.3%** |
| `ordinal-logistic` | 56.7% | 38.9% | **50.0%** |

Length is at 22.2% on the v3 examples — near the 16.7% six-way chance rate.
`ordinal-logistic` reaches 50.0%, and the ordering across the three generations
is the clearest statement of the whole argument: the more a set of examples
resists being read as length, the further the learned model pulls ahead of the
hand-weighted one.

### 17.4 A model clears the baseline for the first time

```
model                      exact       ±      adj    bias     ECE
ordinal-logistic           48.9%    6.5%    87.8%   -0.06   0.061
length-only                48.9%    2.8%    63.3%   +0.64   0.095
heuristic-linear           41.7%    6.3%    75.0%   +0.15   0.031

Baseline guard — "length-only" ranks by prompt length alone: 48.9% exact, 63.3% adjacent, bias +0.64.
  ✗ does not clear the baseline: heuristic-linear (41.7% exact, 75.0% adjacent)
  ✓ clears the baseline: ordinal-logistic (ties on exact, 87.8% vs 63.3% adjacent)
```

**The guard was improved by this result rather than merely passing it.** As first
written it compared exact accuracy alone and counted a tie as a loss, which would
have reported `ordinal-logistic` as "beaten" while it was wrong by one tier where
the baseline was wrong by four (87.8% vs 63.3% adjacent, bias -0.06 vs +0.64).
A guard that draws the wrong conclusion from a real case is worse than none, so
it now judges on exact, adjacent and bias together.

`heuristic-linear` — the shipped scorer — still does not clear it.

### 17.5 Fitted artifacts

**`DEFAULT_BOUNDARIES`: still not refit**, and the evidence is stronger than at
v2. Shipped boundaries score 43.9% on v3 against 40.0% for refitting per fold,
and a refit would wreck real traffic: `extreme` would drop to **0** prompts,
`heavy` would jump to 307, entropy 0.806 → 0.666, top share 30.2% → 45.3%. The
cut points move to chase examples the features cannot represent, and production
pays for it. Boundaries do not fix representation.

**`DEFAULT_TIER_RELIABILITY`: refit to v3**, prior 0.4762 → 0.4000. `heavy` now
reads 0.256, barely above the 0.167 chance rate — the scorer reporting honestly
that it cannot do that tier. v3 is the first version whose length structure
resembles production, so these are the closest thing to a trustworthy floor the
project has had.

**`score-drift-guard`: two medians pinned, not accepted.** `trivial` (0.245) and
`heavy` (0.388) now sit outside their configured bands, both from the same cause:
the scorer over-scores long prompts, and v3 gives every tier long prompts. Nothing
about the scorer changed — the benchmark stopped hiding it. Pinned via the
mechanism that file already prescribes, with ±0.05 still catching genuine drift,
and a comment saying they come out when the feature work in §12 lands.

### 17.6 State

| | v1 | v2 | **v3** |
|---|---|---|---|
| examples | 90 | 126 | **180** |
| length-to-tier rho | 0.956 | 0.293 | **0.194** |
| `length-only` exact | 86.7% | 59.5% | **48.9%** |
| `length-only` adjacent | 95.6% | 70.5% | **63.3%** |
| best model clears baseline? | no | no | **yes (`ordinal-logistic`)** |
| golden CV exact (shipped scorer) | 63.3% | 46.5% | 41.7% |
| ECE | 0.057 | 0.136 | **0.031** |
| **real-traffic routing** | — | unchanged | **unchanged** |
| **cost index** | 2148 | 2148 | **2148** |
| suite | 495 | 495 | **495 pass** |

Production behaviour is byte-identical across all three revisions: no boundary
moved, so no prompt routes differently. The falling accuracy figures are not a
regression — they are the same scorer measured against a benchmark that gets
progressively harder to pass by counting characters.

### 17.7 What is now true, and what still is not

**True:** the benchmark can distinguish complexity from verbosity. A learned model
beats length on it. The scorer's reported accuracy is honest.

**Still not true:** the shipped scorer clears the baseline — it does not, at 41.7%
against 48.9%. That is §12's feature work, and this dataset is now the instrument
that will show whether it worked. And the 90 labels added across v2 and v3 remain
one author's judgement, unreviewed: they should be the first batch through
`/gs-audit` before any of these numbers is quoted outside this repository.


---

## 18. Pre-merge review — PR #6, 2026-09-04

A full-branch review before merge. Nine findings; eight fixed, one deliberately
left as a documented defect.

### 18.1 Fixed

**#1 (critical) — the recalibration feature was a no-op for the model most
likely to need it.** §13.2's fix for zero-evidence drift replaced a min/max
renormalisation with a clamp into `[priorLo, priorHi]`. That protected ungraded
models and broke demotion: the model sitting *at* `priorLo` could never move
down. Verified — **fifty human-weighted quality-0 votes on `gemini-flash-lite`
changed its quality from 0.550 to 0.550.** The one thing the module exists to do
did not happen.

The two goals were conflated. Now stated separately: a model with no evidence
keeps its prior exactly; a model with evidence moves to what its evidence says,
bounded only by `clamp01`. The worst model now demotes 0.550 → 0.041 and `light`
reroutes away from it. Two regression tests pin both halves, and the earlier test
asserting the span invariant was replaced — it had come to encode the bug.

**#4/#5 — calibrated confidence broke a downstream threshold.** `alwaysAskBelow
Confidence` defaulted to 0.5, which was the *floor* of the old `[0.5, 0.95]`
margin scale. Against genuinely calibrated values (heavy 0.256, intensive 0.335)
it fired on four tiers of six, swamping the aleatory sampling and fatigue decay
it sits beside, and `lowConfidence` stopped carrying information. Re-scaled to
0.30 in both places, below the calibrated spread, so it again marks only the
worst cases. The fix is the threshold, not the confidence — re-inflating the
number would reinstate the dishonesty §9 removed.

**#6 — `LABELLED_FIELD_RE` excluded digits and dots**, so `Step 1:`,
`P95 latency:` and `Node.js version:` scored zero structure. Widened. Cost index
improved 2148 → 1962 as a side effect.

**#7 — two of the plugin's three settings were inert.** `.mcp.json` passed
`GATESWARM_PROJECT`, which the server never read, and `matrix_path` was wired
nowhere. Both are now honoured as defaults.

**#8 — a comment claimed eval and production share one calibration source.**
They must not: eval fits per-fold or its ECE leaks, production uses the shipped
table, and an eval must never write global calibration state as a side effect.
The code was right; the comment was corrected.

**#9 — `cost_report` was missing from the plugin manifest test and README.**

### 18.2 Left as a known defect, deliberately

**#2/#3 — the shape term's ±0.15 caps misfire at both ends.** Confirmed:
`"Optimize the import order in this file."` scores `intensive`, and a 448-word
distributed-systems spec with 40 bulleted requirements scores `light`. The second
is the worse one — under-routing hard work sends it to a model that cannot do it.

An attempted fix (floor the evidence discount at 0.55, shrink the caps to
0.04/0.10) resolved all three regression cases in isolation. **It was reverted**,
because under the *shipped* boundaries it collapsed real traffic back into the
top two tiers — 417 `intensive` + 234 `extreme` of 678, the saturation failure
§8 exists to prevent.

The reason the grid search did not catch that is worth recording, because it is
the kind of error this document keeps finding elsewhere: **the search refit cut
points per candidate config, while production keeps `DEFAULT_BOUNDARIES` fixed.**
The entropy it reported was therefore not the entropy production would see. A
retune has to hold the boundaries fixed, or move them in the same experiment —
the two are coupled and cannot be tuned apart.

Left in place with the defect documented at the call site rather than patched
under time pressure. Shipping a half-tuned scorer is worse than shipping a known
one.

### 18.3 State at review end

| | |
|---|---|
| suite | **496 pass** (was 495; +2 regression, −1 that encoded a bug) |
| typecheck / build / `npm pack` | clean |
| golden CV exact / adjacent | 41.7% / 75.0% — unchanged |
| ECE | 0.031 — unchanged |
| real-traffic tiers | 5 of 6, top share 30.5% |
| **cost index** | **1962** (was 2148; the regex fix) |
| leaderboard verdict | unchanged — `ordinal-logistic` clears the baseline, the heuristic does not |

### 18.4 On the reviewer

This was Claude reviewing its own branch, and it found a critical bug in a fix
Claude had written one turn earlier. That is an argument for the review, not
against it — but it is not an argument that self-review suffices. The
second-model pass requested in §13.1 remains undone and remains worth doing.


---

## 19. CI failure — a 3.4-second regex on main

The first CI run on PR #6 failed. Worth recording, because the failure was not
what it looked like.

**All 496 tests passed.** The job failed on an unhandled error:

```
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
```

`tests/sequence-consistency.test.ts` ran for **121 seconds** on the runner
(~81 s locally). A synchronous, CPU-bound test held the event loop long enough
that the worker could not answer vitest's progress RPC, and vitest failed the run.

### 19.1 Not this branch's fault, and fixed anyway

Measured from an isolated worktree of `origin/main`: **3415 ms** to score a 64 KiB
prompt, against **3387 ms** on the branch. The pathology is on main; this branch
is marginally faster. What the branch did was raise total suite load — the golden
dataset doubled from 90 to 180 examples — which tipped a pre-existing problem over
the runner's threshold.

The first `git stash` comparison was itself wrong and worth flagging: everything
was committed, so the stash was a no-op and **both measurements were the branch.**
Redone properly in a worktree. Two bad measurements in two turns, both caught by
checking rather than by intuition.

### 19.2 The actual bug

Scoring was **quadratic in prompt length** — 4x per doubling, confirmed:

| chars | ms |
|---|---|
| 8,000 | 57 |
| 16,000 | 214 |
| 32,000 | 907 |
| 64,000 | **3,347** |

The cause, isolated to one line:

```ts
const question_count = countRegex(prompt, /[^?]+\?/g);
```

On text containing **no** `?`, `[^?]+` greedily consumes to the end of the string
at every start position, then fails to find `\?` and backtracks. Timed alone on
64 KiB: **3392 ms with no question mark, 0 ms with many.** The pathological case
is the common one — most prompts contain no question mark at all — and this ran on
every single score.

Replaced with a linear scan. Byte-identical counts across all **858** corpus
prompts and every edge case (`""`, `"?"`, `"??"`, `"a??b?"`, `"???a"`).

| | before | after |
|---|---|---|
| `extractFeatures`, 64 KiB | 3475 ms | **35 ms** |
| full test suite | 126 s | **49 s** |
| snapshot drift | — | **none** |

Three regression tests pin it: an absolute bound on the 64 KiB case, a
growth-ratio check that fails if quadratic behaviour returns, and a table of the
edge cases proving the new counter matches the regex it replaced.

### 19.3 Why this matters beyond CI

The README advertises "6-level complexity score in 12 ms". A prompt without a
question mark, near the size cap, took 3.4 seconds — **280x** the advertised
figure, in production, on main, unnoticed. The routing latency budget assumed
scoring was free.

It surfaced only because a test suite got slower and a CI runner was less forgiving
than a laptop. Nothing in the eval battery measures worst-case latency;
`bench:scorer` measures the envelope on ordinary prompts. That gap is worth
closing separately.
