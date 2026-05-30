# GateSwarm MoMA Router v0.6 — Release Plan

**Date:** 2026-05-25
**Status:** ✅ Implemented & Running
**Goal:** Effort customization, Plan/Act modes, RTK-inspired token economy
**Version:** v0.6.0 "Sieve"

---

## Motivation

Three independent vectors converge on the same problem: **token waste**.

1. **Effort overprovisioning** — Every prompt goes through the same classification funnel. A user who knows their task is "just a light refactor" can't tell the router to skip intensive routing. No manual override exists.

2. **No mode awareness** — The router treats exploration ("draft an architecture") and execution ("implement the API") identically. Claude Code's Plan/Act modes proved that separating intent from execution cuts token waste dramatically.

3. **Output noise** — The RTK article (rflpazini, Dev.to) demonstrated 5.3M tokens saved across 612 commands (92.6% average reduction) by filtering CLI output *before* it enters context. GateSwarm compresses *input* messages (TurboQuant) but passes raw provider output into context and feedback. RTK's strategies apply directly.

---

## Feature 1: Effort Customization

### Problem
The router always classifies → routes. Users and agents have no way to say "I know this is heavy, just use the heavy model" or "keep this trivial no matter what the score says."

### Design

#### 1.1 Request-Level Override

Three methods to override effort at the request level (same pattern as v0.5.1 direct routing):

```json
// Method 1: body.effort_override
{ "effort_override": "heavy" }

// Method 2: body.model with effort suffix
// "qwen3.5-plus?effort=heavy" — model routes normally, effort forced
{ "model": "qwen3.5-plus", "effort_override": "light" }

// Method 3: Headers
X-Effort-Override: moderate
```

**Behavior:**
- `effort_override` skips complexity scoring entirely
- Model resolution still uses `getTierModel(effort)` for the forced tier
- Fallback chain, TurboQuant compression, and feedback pipeline all fire normally
- Logged as `effort: "override"` in benchmark (separate from auto-routed)

#### 1.2 Per-Agent Effort Profile

Extend agent config with an `effortProfile`:

```json
{
  "id": "bmad-dev",
  "effortProfile": {
    "default": "moderate",      // floor — never route below this
    "ceiling": "heavy",         // cap — never route above this
    "bias": 0.15                // shift score downward (favor lighter routing)
  }
}
```

- `default`: Acts as a floor. A trivial prompt gets bumped to moderate.
- `ceiling`: Acts as a cap. An extreme prompt gets routed to heavy instead.
- `bias`: Positive shifts score down (favor lighter), negative shifts up (favor heavier). Applied before tier boundary check.

#### 1.3 CLI Commands

```bash
gateswarm effort-status                         # Show per-agent effort profiles
gateswarm effort-set <agentId> <profile>        # Set agent effort profile
gateswarm effort-override <tier> "prompt"        # Test override routing
```

### Files Changed
- `src/moma-gateway.ts` — effort override resolution in `handleChatCompletion`
- `src/agent-registry.ts` — effortProfile in AgentConfig
- `src/gateswarm-cli.ts` — new effort commands
- `v04_config.json` — schema extension for effort profiles

---

## Feature 2: Plan/Act Modes

### Problem
GateSwarm routes purely on *prompt complexity*, not *intent phase*. "Draft a design doc" and "implement the design doc" may score similarly but have fundamentally different token/quality requirements.

### Design

#### 2.1 Mode Detection (automatic)

Extend the intent engine with a **mode signal** alongside complexity score:

```typescript
interface IntentResult {
  score: number;
  effort: EffortLevel;
  mode: 'plan' | 'act' | 'auto';  // NEW
  modeConfidence: number;         // 0-1
}
```

**Plan-mode signals** (prompt is exploration-oriented):
- Keywords: `draft`, `outline`, `brainstorm`, `sketch`, `explore`, `what if`, `options`, `approach`, `consider`, `pros and cons`, `compare`, `tradeoff`, `strategy`, `roadmap`, `plan`, `design` (when not paired with implementation verbs)
- Heuristic: high ratio of question marks + low code keyword density → plan
- Score adjustment: plan-mode reduces effective score by 0.05–0.15 (favors lighter/faster models)

**Act-mode signals** (prompt is execution-oriented):
- Keywords: `implement`, `build`, `code`, `fix`, `deploy`, `run`, `test`, `apply`, `merge`, `write the code`, `create the file`
- Heuristic: imperative verbs + code keywords + sequential markers → act
- Score adjustment: act-mode increases effective score by 0.05–0.10 (ensures adequate capability)

**Auto mode**: mixed signals or low confidence → no adjustment.

#### 2.2 Mode Configuration (per-agent, per-tier)

```json
{
  "tier_models": {
    "moderate": {
      "model": "MiniMax-M2.5",
      "provider": "bailian",
      "max_tokens": 2048,
      "enable_thinking": false,
      "plan_model": "glm-4.5-air",
      "plan_provider": "zai",
      "plan_max_tokens": 512,
      "plan_enable_thinking": false
    }
  }
}
```

When mode = `plan`:
- Uses `plan_model` / `plan_provider` instead of primary model
- Lower `max_tokens` (exploration doesn't need long outputs)
- `enable_thinking` typically off (speed over depth)
- Fallback chain still applies

When mode = `act`:
- Uses primary model (full capability)
- Full `max_tokens` budget
- `enable_thinking` follows tier config

#### 2.3 Explicit Mode Override

Same pattern as effort override:

```json
{ "mode": "plan" }        // Force plan mode
{ "mode": "act" }          // Force act mode
// Header: X-Mode: plan
```

#### 2.4 CLI Commands

```bash
gateswarm mode-status                       # Show mode config per tier
gateswarm mode-set <tier> <model> <provider>  # Set plan model for tier
gateswarm mode "draft an architecture..."    # Test mode detection
```

### Files Changed
- `src/intent-engine.ts` — mode detection (add to `v33Score` / `scoreIntentV04`)
- `src/intent-engine-v04.ts` — mode signal in ensemble pipeline
- `src/v04-config.ts` — plan_model per tier, mode config
- `src/moma-gateway.ts` — mode-aware routing in `handleChatCompletion`
- `src/types.ts` — `mode: 'plan' | 'act' | 'auto'` in routing decision
- `src/gateswarm-cli.ts` — mode commands

---

## Feature 3: RTK-Inspired Token Economy

### Problem
TurboQuant compresses *input context* (messages sent to provider). But GateSwarm also consumes tokens on:
1. **Provider output** → stored in feedback, RAG, benchmark logs (full text)
2. **CLI provider stdout** → command output sent as context to CLI agents (no filtering)
3. **Session continuity** → entire response text captured in continuity summaries
4. **Self-eval / LLM judge** → full prompt + full response sent to judge model

RTK demonstrated that structured output filtering (not generic summarization) achieves 92.6% token savings without losing diagnostic value. The key insight: **filter by output type, not by content importance**.

### Design

#### 3.1 Output Filter Engine

New module: `src/output-filter.ts`

RTK's strategies adapted for GateSwarm's API-gateway context:

| Strategy | GateSwarm Application | Expected Savings |
|----------|----------------------|------------------|
| **Stats Extraction** | CLI command output (git status, ls, test results) → aggregate counts instead of full output | 70-99% |
| **Failure Focus** | Test/build output → pass = "✓ 47 tests", fail = full stack trace | 100% on success |
| **Code Filtering** | File reads in CLI agent context → 3 levels: none/minimal/aggressive | 20-90% |
| **Deduplication** | Repeated log lines → `[ERROR] Connection refused (×50)` | 60-95% |
| **Tree Compression** | Directory listings → `src/ ├── lib/ (12 files)` | 70-85% |
| **NDJSON Parsing** | Structured JSON output → extract only event summaries | 50-80% |
| **State Machine** | Multi-line process output (pytest, gradle) → parse phases, extract summary | 80-99% |

#### 3.2 Integration Points

**A. CLI Provider Output Filtering**
```typescript
// In handleCliProvider():
const rawOutput = await adapter.chatCompletion(...);
const filtered = applyOutputFilter(rawOutput.content, {
  strategy: 'auto-detect',  // auto-detect output type
  level: 'standard',         // standard | aggressive | full
});
// Use filtered.content for context, rawOutput preserved in tee for debug
```

**B. HTTP Provider Response Filtering**
```typescript
// After provider response received:
const responseText = data.choices[0].message.content;
const filtered = applyOutputFilter(responseText, {
  strategy: 'code-filter',   // for code responses
  level: 'minimal',          // strip comments, keep signatures
});

// Store filtered version for feedback/RAG/continuity
recordFeedback({ ...responseTokens: estimateTokens(filtered.content) });
addRagEntry({ summary: filtered.content.slice(0, 200) });
```

**C. Tee Mechanism (RTK-inspired)**
When output is filtered, save the full version to a tee file:
```
~/.gateswarm/tee/<timestamp>_<agent>_<model>.log
```
The model can request the full output if needed:
```
✅ 47 tests passed (2.6M tokens filtered)
[full output: ~/.gateswarm/tee/1716851200_bmad-dev_test.log]
```

#### 3.3 Token Tracking Dashboard

Extend the metrics server to track filtered vs raw tokens:

```bash
gateswarm token-stats                    # Show token economy stats
gateswarm token-stats --agent bmad-dev   # Per-agent breakdown
```

Output:
```
📊 Token Economy — Last 24h

Agent          Raw In    Raw Out   Filtered  Saved     Savings%
────────────── ───────── ───────── ───────── ───────── ────────
bmad-dev       245,000   180,000   42,000    383,000   82.1%
bmad-architect  89,000    67,000   31,000   125,000   67.2%
jack           156,000   120,000   85,000   191,000   58.9%

Total saved: 699,000 tokens (~$2.10 at current rates)
```

#### 3.4 Configuration

```json
{
  "output_filter": {
    "enabled": true,
    "defaultLevel": "standard",    // standard | aggressive | full
    "teeEnabled": true,             // save filtered output to tee files
    "teeMaxAgeMs": 3600000,         // auto-cleanup tee files after 1h
    "teeMaxTotalBytes": 100_000_000, // 100MB cap
    "strategies": {
      "cliOutput": "auto-detect",   // auto-detect | stats | failure-focus | tree
      "codeResponses": "minimal",   // none | minimal | aggressive
      "testOutput": "failure-focus",
      "logOutput": "dedup",
      "jsonOutput": "ndjson-parse"
    },
    "perAgent": {
      "bmad-dev": { "level": "aggressive", "codeResponses": "minimal" },
      "bmad-architect": { "level": "standard" }
    }
  }
}
```

### Files Changed (NEW)
- `src/output-filter.ts` — OutputFilter class with all strategies
- `src/token-economy.ts` — Token economy tracking + stats
- `src/tee-store.ts` — Tee file management (save/cleanup/lookup)

### Files Changed (MODIFIED)
- `src/moma-gateway.ts` — integrate output filtering in response pipeline
- `src/v04-config.ts` — output_filter config schema
- `src/gateswarm-cli.ts` — token-stats command
- `src/metrics-server.ts` — token economy endpoint

---

## Implementation Plan

### Phase 1: Effort Customization (Week 1) — ✅ COMPLETE
- [x] Extend `AgentConfig` with `effortProfile` (default/ceiling/bias)
- [x] Add `effort_override` resolution in `handleChatCompletion`
- [x] Wire effort bias into scoring pipeline
- [x] CLI commands: `effort-status`, `effort-set`, `effort-override`
- [x] Tests: override bypasses classification, profile floors/ceilings work

### Phase 2: Plan/Act Modes (Week 2) — ✅ COMPLETE
- [x] Mode detection in intent engine (plan/act/auto signals)
- [x] Extend `TierModelConfig` with `plan_model`, `plan_provider`, `plan_max_tokens`
- [x] Mode-aware routing in gateway (plan → plan_model, act → primary)
- [x] Explicit mode override via body/headers
- [x] CLI commands: `mode-status`, `mode-set`, `mode` (test detection)
- [x] Tests: mode detection accuracy, plan routing uses cheaper models

### Phase 3: RTK Token Economy (Week 3-4) — ✅ COMPLETE
- [x] `output-filter.ts` — core filter engine with 7 strategies
- [x] `tee-store.ts` — tee file management
- [x] `token-economy.ts` — tracking + stats aggregation
- [x] Integrate into CLI provider dispatch (primary use case)
- [x] Integrate into HTTP provider response pipeline
- [x] Wire into feedback/RAG/continuity (store filtered, tee full)
- [x] CLI: `token-stats` command
- [x] Config: `output_filter` schema in v04_config
- [x] Tests: filter strategies, tee mechanism, token tracking accuracy

### Phase 4: Integration + Polish (Week 4) — ✅ COMPLETE
- [x] Combined test: effort override + plan mode + output filter
- [x] Benchmark: before/after token consumption comparison
- [x] Documentation update
- [x] Version bump: v0.5.1 → v0.6.0

---

## Success Metrics

| Metric | Current (v0.5.1) | Target (v0.6) |
|--------|-------------------|----------------|
| Token waste (output noise) | 0% filtering | ≥70% average reduction |
| Effort misrouting | No override | Manual override + per-agent profiles |
| Mode-blind routing | Always auto | Plan/Act detection + explicit override |
| Per-request token control | None | 3 override methods (body/headers/model suffix) |
| CLI output in context | Raw | Filtered (stats/failure-focus/tree) |
| Token visibility | Basic per-agent count | Detailed economy dashboard |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Mode detection false positives | Wrong model routed, quality drop | Conservative thresholds, auto-mode fallback, per-agent tuning |
| Output filtering loses critical info | Debugging becomes harder | Tee mechanism always preserves full output; fail-safe returns raw on filter error |
| Effort profiles create blind spots | Some tasks underprovisioned | Ceiling prevents under-provisioning; bias is bounded (±0.2) |
| Added latency from filter engine | +5-15ms per request | Filter is sync, O(n) on output length; measured <2ms for typical responses |
| Config complexity grows | Harder to maintain | Centralized in v04_config.json; CLI commands for all mutations |

---

## Version Identity

```
GateSwarm MoMA Router v0.6.0
Codename: "Sieve" (filters everything — effort, mode, output)
TurboQuant: v3.7 (adds output-side filtering)
CLI: 17 commands (was 13)
```
