# GateSwarm MoMA Router

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20+-brightgreen.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.5.2-blue.svg)](https://github.com/pealmeida/gateswarm-router)

**Self-optimizing LLM routing gateway with Plan/Act dual-model routing. Scores every prompt, picks the cheapest capable model per intent mode, learns from every interaction.**

---

## What's New in v0.5.2

- **Plan/Act Dual-Model Routing** — Each tier carries an *act* model (default) and a *plan*
  model; plan mode dispatches the **actual request** to the plan model (upper tiers route to
  Codex / Claude Code CLI reasoning agents), not just a response header. Intent mode is
  auto-detected, or overridden via `body.mode` / the `X-Mode` header.
- **More accurate intent detection** — Stem-aware word-boundary keyword matching plus
  imperative + bug-symptom patterns. On the golden set: **act recall 60% → 100%**, **plan
  recall 87% → 93%**, no substring false positives (`explanation` ≠ `plan`, `codebase` ≠ `code`).
- **Less over-routing, more accurate tiers** — Removed a confidence-based escalation rule that
  pushed simple prompts to pricier models. Exact-tier accuracy **41% → 49%**, within-±1
  **83% → 88%**, over-routing bias **+0.36 → +0.12** tiers.
- **Provider/model consistency enforced** — `eval/consistency-check.ts` (wired into the test
  suite) verifies every act/plan/fallback model exists in its provider's catalog. Fixed stale
  references (`glm-4.5-air` catalog entry; `kimi-k2.5`/`MiniMax-M2.5` repointed to OpenCodeGo).
- **OpenCodeGo provider** — HTTP adapter for deepseek-v4-flash/pro, qwen3.7, kimi, minimax, mimo.
- **Mode CLI commands** — `mode-status`, `mode-set`, `mode-detect`; `X-Mode` /
  `X-Mode-Confidence` response headers on every routed request.

---

## How It Works

GateSwarm Router is a TypeScript API gateway that sits between any OpenAI-compatible LLM client and multiple LLM providers. It intercepts every chat completion request, scores prompt complexity across 25 features using a weighted ensemble (heuristic 55%, RAG signal 25%, history bias 20%), detects intent mode (plan vs act), routes to the right tier and model pair, compresses long conversations with TurboQuant, retrieves relevant RAG context, and logs feedback to continuously improve routing accuracy.

```
Client
  |
  v
GateSwarm (:8900)
  |-- Score complexity (ensemble voter)
  |-- Detect intent mode (plan vs act)
  |-- Route to tier + mode model (trivial → extreme)
  |-- TurboQuant compression (Q8→Q0)
  |-- RAG context retrieval
  |-- Sanitize + forward + fallback
  |
  +-----> HTTP Providers               CLI Providers
          Bailian (Qwen, MiniMax)       Claude Code (cc/)
          ZAI (GLM)                     Codex (cx/)
          OpenCodeGo (DeepSeek, Qwen)   Pi (pi/)
                                        Hermes (hm/)
                                        OpenClaw (oc/)
```

---

## Plan/Act Dual-Model Routing

Every tier has two model assignments — one for **acting** (the default: implementation,
execution, bug-fixing) and one for **planning** (exploration, drafting, architecture). For
the upper tiers, planning routes to CLI reasoning agents (Codex, Claude Code) while acting
stays on fast/cheap HTTP models:

| Tier | Act Model | Act Provider | Plan Model | Plan Provider |
|------|-----------|-------------|------------|---------------|
| **trivial** | glm-4.5-air | zai | glm-4.5-air | zai |
| **light** | deepseek-v4-flash | opencodego | deepseek-v4-flash | opencodego |
| **moderate** | deepseek-v4-flash | opencodego | cx/gpt-5.4-codex | codex-cli |
| **heavy** | deepseek-v4-pro | opencodego | cx/gpt-5.5-codex | codex-cli |
| **intensive** | glm-5.1 | opencodego | cc/claude-sonnet-4-6 | claude-cli |
| **extreme** | deepseek-v4-pro | opencodego | cc/claude-opus-4-8 | claude-cli |

> Plan mode dispatches the *primary* request to the plan model (not just a header) — in
> `act`/`auto` mode each agent keeps its own per-tier model. Values above are the live
> `v04_config.json` defaults and are hot-reloaded; edit them with `mode-set` or directly.

**Auto-detection** (`detectIntentMode`): the gateway scores stem-aware keyword hits plus
intent patterns for each mode. **Act** is detected from imperative commands (`implement`,
`fix`, `refactor`, `replace`, `spin up`, `migrate`, …) and bug/symptom reports (`it throws a
500`, `the page is blank`, `can't upload`, `shows $0`, `stopped firing`). **Plan** is detected
from deliberation phrasing (`brainstorm`, `outline`, `compare`, `weighing whether to…`,
`how should we…`, `not sure how to…`, `before I write any code…`). Word-boundary matching
avoids substring false positives (e.g. `explanation` no longer counts as `plan`, `codebase`
no longer counts as `code`). Override explicitly with `"mode": "plan"` / `"mode": "act"` in
the request body, or the `X-Mode` request header.

On the labeled golden set (`eval/dataset.json`), detection scores **100% act recall, 93% plan
recall**, with ambiguous prompts correctly left as `auto` 87% of the time.

---

## Quick Start

```bash
git clone https://github.com/pealmeida/gateswarm-router.git
cd gateswarm-router
cp .env.example .env          # add your API keys
npm install
npm start                     # starts gateway on :8900
```

Point any OpenAI-compatible client at `http://localhost:8900/v1`:

```bash
curl http://localhost:8900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gateswarm","messages":[{"role":"user","content":"Explain quantum computing"}]}'
```

---

## Routing Tiers

All 6 tiers and their current model assignments (from `v04_config.json`, hot-reloaded):

| Tier | Score Range | Act Model | Act Provider | Max Tokens | Reasoning |
|------|-------------|-----------|-------------|-----------|-----------|
| **trivial** | 0.00 – 0.21 | glm-4.5-air | zai | 256 | — |
| **light** | 0.21 – 0.28 | deepseek-v4-flash | opencodego | 512 | — |
| **moderate** | 0.28 – 0.32 | deepseek-v4-flash | opencodego | 2048 | — |
| **heavy** | 0.32 – 0.37 | deepseek-v4-pro | opencodego | 4096 | ✓ |
| **intensive** | 0.37 – 0.46 | glm-5.1 | opencodego | 4096 | — |
| **extreme** | 0.46 – 1.00 | deepseek-v4-pro | opencodego | 8192 | ✓ |

Reasoning (`enable_thinking`) is on for heavy and extreme tiers. Tier models, plan/act overrides, and fallback chains are fully configurable via CLI or by editing `v04_config.json` directly.

**Classifier accuracy** (measured by `eval/assess.ts` on the golden set): exact-tier 49%,
within-±1-tier **88%**, with near-zero over-routing bias. v0.5.2 removed a confidence-based
"escalate up one tier" rule that was systematically over-routing simple prompts to pricier
models (it cost ~8 points of exact accuracy and added a +0.36-tier bias).

---

## CLI Management

Run via `npx tsx src/gateswarm-cli.ts <command>` or alias as `gateswarm`:

### Core Commands

| Command | Description |
|---------|-------------|
| `status` | Show gateway status: version, ensemble weights, tier models, feedback buffer, RAG stats |
| `models` | List all tier models with provider and reasoning toggle |
| `model <tier> <model> <provider>` | Set the act (primary) model for a tier (saved to `v04_config.json`) |
| `reasoning` | Show `enable_thinking` status for all tiers |
| `reasoning <tier> on\|off` | Toggle reasoning for a specific tier |
| `retrain-freq` | Show current retraining frequency |
| `retrain-freq <N>` | Set retraining to trigger after N interactions (minimum 50) |
| `weights` | Show ensemble weights (heuristic / cascade / ragSignal / historyBias) |
| `weights <method> <value>` | Set an ensemble weight (0–1) |
| `feedback` | Show feedback buffer stats and per-tier accuracy |
| `rag` | Show RAG index stats (total entries, active, avg tokens) |
| `retrain` | Trigger manual retraining and hot-swap weights |

### Plan/Act Mode Commands (v0.5.2)

| Command | Description |
|---------|-------------|
| `mode-status` | Show plan/act model assignments for all 6 tiers |
| `mode-set <tier> plan\|act <model> <provider>` | Set plan or act model for a tier |
| `mode-set <tier> plan-tokens <N>` | Set plan max_tokens for a tier |
| `mode-set <tier> plan-reasoning on\|off` | Toggle reasoning for plan model |
| `mode-detect "prompt text"` | Test auto-detection of plan vs act on a prompt |

### Provider Commands

| Command | Description |
|---------|-------------|
| `providers` | List all registered providers (HTTP + CLI) with type, status, quota, and models |
| `direct <provider> <model> "prompt"` | Send a prompt directly to a specific provider/model, bypassing routing |

### Training Commands

| Command | Description |
|---------|-------------|
| `training` | Show training mode status for all agents |
| `training <agentId> on\|off` | Enable or disable training mode for an agent |
| `training labels <agentId>` | Show collected gold/silver/bronze labels for an agent |

**Examples:**

```bash
# Model management
npx tsx src/gateswarm-cli.ts model heavy deepseek-v4-pro opencodego
npx tsx src/gateswarm-cli.ts reasoning extreme on
npx tsx src/gateswarm-cli.ts retrain-freq 200
npx tsx src/gateswarm-cli.ts weights heuristic 0.35

# Plan/Act modes (v0.5.2)
npx tsx src/gateswarm-cli.ts mode-status
npx tsx src/gateswarm-cli.ts mode-set heavy plan cx/gpt-5.5-codex codex-cli
npx tsx src/gateswarm-cli.ts mode-set moderate plan-tokens 1024
npx tsx src/gateswarm-cli.ts mode-detect "implement a rate limiter in Rust"

# Providers
npx tsx src/gateswarm-cli.ts providers
npx tsx src/gateswarm-cli.ts direct claude-cli cc/claude-sonnet-4-6 "What is 2+2?"
```

---

## Providers

### HTTP Providers

| Provider | ID | Models |
|----------|----|--------|
| Alibaba Bailian | `bailian` | qwen3.5-plus, qwen3.6-plus, qwen3-coder-plus, qwen3.6-max-preview, qwen4.6 |
| Z.AI | `zai` | glm-4.5-air, glm-4.7, glm-4.7-flash, glm-5, glm-5-turbo, glm-5.1 |
| OpenCodeGo | `opencodego` | deepseek-v4-flash, deepseek-v4-pro, qwen3.7-plus, qwen3.7-max, kimi-k2.5/k2.6, glm-5.1, minimax-m2.7/m3, mimo-v2.5 |

> Provider model catalogs are validated against the routing config by
> `eval/consistency-check.ts` (enforced in the test suite) — a tier or fallback can never
> reference a model a provider doesn't serve.

### CLI Providers

CLI providers are dispatched via subprocess spawn. They do not support streaming (auto-downgraded to sync). Direct routing prefix syntax: `cc/`, `cx/`, `pi/`, `hm/`, `oc/`.

| Provider | ID | Prefix | Notes |
|----------|----|--------|-------|
| Claude Code | `claude-cli` | `cc/` | claude-sonnet-4-6, claude-opus-4-8. Quota tracking (5h + weekly) |
| OpenAI Codex | `codex-cli` | `cx/` | gpt-5.4-codex, gpt-5.5-codex. Quota tracking (5h + weekly) |
| Pi | `pi-agent` | `pi/` | qwen3.5-plus, glm-4.7-flash. Quota tracking |
| Hermes | `hermes-agent` | `hm/` | Quota tracking |
| OpenClaw | `openclaw-agent` | `oc/` | Quota tracking |

---

## Configuration

`v04_config.json` is the live configuration file — hot-reloaded on CLI changes, no gateway restart needed.

Key sections:

- **`tier_models.<tier>`** — act (primary) model, provider, max_tokens, enable_thinking, plus `plan_model`, `plan_provider`, `plan_max_tokens`, `plan_enable_thinking` for Plan/Act dual routing
- **`tier_boundaries`** — score thresholds separating the 6 tiers (v0.5.2 recalibrated)
- **`ensemble.weights`** — heuristic (0.55), cascade (0), ragSignal (0.25), historyBias (0.2)
- **`feedback_loop`** — retraining frequency (default 500), LLM judge model and sampling rate, A/B holdout
- **`rag`** — max entries (10,000), TTL (24h), query max results

Edit via CLI commands (`model`, `mode-set`, `reasoning`, `weights`, `retrain-freq`) or directly in `v04_config.json`.

### Direct Routing

Skip classification entirely by specifying a provider/model explicitly:

```json
{ "model": "gateswarm", "messages": [...], "direct_route": { "provider": "claude-cli", "model": "cc/claude-sonnet-4-6" } }
```

Or via headers: `X-Direct-Provider: claude-cli` / `X-Direct-Model: cc/claude-sonnet-4-6`.

Or use the model field shorthand: `"model": "cc/claude-sonnet-4-6"`.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `BAILIAN_KEY` | Alibaba Bailian API key |
| `BAILIAN_BASE` | Bailian base URL |
| `GLM_API_KEY` | Z.AI (GLM) API key |
| `ZAI_BASE` | Z.AI base URL |
| `PORT` | Gateway port (default: 8900) |

---

## Architecture

Full architecture documentation including the 9-stage request pipeline, TurboQuant compression levels, 7-phase message sanitization, RAG lifecycle, feedback store, training mode, and fallback chains:

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Contributing

1. Fork the repo and create a feature branch
2. Run `npm run check:types` and `npm test` before submitting
3. See [CONTRIBUTING.md](CONTRIBUTING.md) for code style and PR guidelines

---

## License

MIT — see [LICENSE](LICENSE).
