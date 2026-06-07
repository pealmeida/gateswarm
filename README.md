# GateSwarm MoMA Router

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20+-brightgreen.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.5.2-blue.svg)](https://github.com/pealmeida/gateswarm-router)

**Self-optimizing LLM routing gateway with Plan/Act dual-model routing. Scores every prompt, picks the cheapest capable model per intent mode, learns from every interaction.**

---

## What's New in v0.5.2

- **Plan/Act Dual-Model Routing** — Separate cheaper models for planning (exploration, drafting, research) vs. acting (implementation, execution). Auto-detects intent mode from prompt keywords with explicit `X-Mode` header override.
- **Recalibrated Effort Classifier** — Length/structure-aware heuristic with tighter tier boundaries for more accurate routing.
- **OpenCodeGo Provider** — New HTTP provider for deepseek-v4-flash, deepseek-v4-pro, and qwen3.7-plus.
- **Expanded CLI Provider Models** — claude-opus-4-8 alias, gpt-5.4/5.5-codex for plan tiers.
- **Mode CLI Commands** — `mode-status`, `mode-set`, `mode-detect` for managing plan/act configurations.
- **X-Mode Response Headers** — `X-Mode` and `X-Mode-Confidence` returned on every routed request.

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

Every tier has two model assignments — one for **planning** (cheaper, good at exploration) and one for **acting** (more capable, good at execution):

| Tier | Act Model | Act Provider | Plan Model | Plan Provider |
|------|-----------|-------------|------------|---------------|
| **trivial** | glm-4.5-air | zai | glm-4.5-air | zai |
| **light** | deepseek-v4-flash | opencodego | deepseek-v4-flash | opencodego |
| **moderate** | glm-4.7 | zai | cx/gpt-5.4-codex | codex-cli |
| **heavy** | deepseek-v4-pro | opencodego | cx/gpt-5.5-codex | codex-cli |
| **intensive** | glm-5.1 | zai | cc/claude-sonnet-4-6 | claude-cli |
| **extreme** | qwen3.7-plus | opencodego | cc/claude-opus-4-8 | claude-cli |

**Auto-detection**: The gateway scores 16 plan keywords (explain, research, design, compare, analyze, brainstorm, outline, review, document, plan, explore, summarize, evaluate, architect, draft, study) and 11 act keywords (implement, fix, build, write, create, deploy, refactor, test, debug, generate, execute). Override explicitly with `"mode": "plan"` or `"mode": "act"` in the request body, or via the `X-Mode` header.

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
| **moderate** | 0.28 – 0.32 | glm-4.7 | zai | 2048 | — |
| **heavy** | 0.32 – 0.37 | deepseek-v4-pro | opencodego | 4096 | ✓ |
| **intensive** | 0.37 – 0.46 | glm-5.1 | zai | 4096 | — |
| **extreme** | 0.46 – 1.00 | qwen3.7-plus | opencodego | 8192 | ✓ |

Reasoning (`enable_thinking`) is on for heavy and extreme tiers. Tier models, plan/act overrides, and fallback chains are fully configurable via CLI or by editing `v04_config.json` directly.

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
| Alibaba Bailian | `bailian` | MiniMax-M2.5, qwen3.5-plus, qwen3.6-plus, qwen3.6-max-preview, kimi-k2.5 |
| Z.AI | `zai` | glm-4.5-air, glm-4.7, glm-5.1 |
| OpenCodeGo | `opencodego` | deepseek-v4-flash, deepseek-v4-pro, qwen3.7-plus |

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
