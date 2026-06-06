# GateSwarm Router

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20+-brightgreen.svg)](https://nodejs.org/)

**Self-optimizing LLM routing gateway. Scores every prompt, picks the cheapest capable model, learns from every interaction.**

---

## How It Works

GateSwarm Router is a TypeScript API gateway that sits between any OpenAI-compatible LLM client and multiple LLM providers. It intercepts every chat completion request, scores prompt complexity across 25 features using a weighted ensemble (heuristic 55%, RAG signal 25%, history bias 20%), routes to the right tier and model, compresses long conversations with TurboQuant, retrieves relevant RAG context, and logs feedback to continuously improve routing accuracy.

```
Client
  |
  v
GateSwarm (:8900)
  |-- Score complexity (ensemble voter)
  |-- Route to tier (trivial → extreme)
  |-- TurboQuant compression (Q8→Q0)
  |-- RAG context retrieval
  |-- Sanitize + forward + fallback
  |
  +-----> HTTP Providers          CLI Providers
          Bailian (Qwen)          Claude Code (cc/)
          ZAI (GLM)               Codex (cx/)
                                  Pi (pi/)
                                  Hermes (hm/)
                                  OpenClaw (oc/)
```

---

## Quick Start

```bash
git clone https://github.com/pealmeida/gateswarm-moma-router.git
cd gateswarm-moma-router
cp .env.example .env          # add your API keys
npm install
npm start                     # starts gateway on :8900
```

Point any OpenAI-compatible client at `http://localhost:8900/v1`:

```bash
curl http://localhost:8900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gateswarm","messages":[{"role":"user","content":"Hello"}]}'
```

---

## Routing Tiers

All 6 tiers and their current model assignments (from `v04_config.json`, hot-reloaded):

| Tier | Score Range | Model | Provider | Max Tokens |
|------|-------------|-------|----------|-----------|
| **trivial** | 0.00 – 0.1557 | glm-4.7 | zai | 256 |
| **light** | 0.1557 – 0.1842 | glm-4.7 | zai | 512 |
| **moderate** | 0.1842 – 0.2788 | MiniMax-M2.5 | bailian | 2048 |
| **heavy** | 0.2788 – 0.3488 | cc/claude-sonnet-4-6 | claude-cli | 4096 |
| **intensive** | 0.3488 – 0.4611 | cx/gpt-5.5-codex | codex-cli | 4096 |
| **extreme** | 0.4611 – 1.00 | cc/claude-opus-4-7 | claude-cli | 8192 |

Reasoning (`enable_thinking`) is on for heavy and extreme tiers. Tier models and fallback chains are fully configurable via CLI or by editing `v04_config.json` directly.

---

## CLI Management

Run via `npx tsx src/gateswarm-cli.ts <command>` or alias as `gateswarm`:

| Command | Description |
|---------|-------------|
| `status` | Show gateway status: version, ensemble weights, tier models, feedback buffer, RAG stats |
| `models` | List all tier models with provider and reasoning toggle |
| `model <tier> <model> <provider>` | Set the primary model for a tier (saved to `v04_config.json`) |
| `reasoning` | Show `enable_thinking` status for all tiers |
| `reasoning <tier> on\|off` | Toggle reasoning for a specific tier |
| `retrain-freq` | Show current retraining frequency |
| `retrain-freq <N>` | Set retraining to trigger after N interactions (minimum 50) |
| `weights` | Show ensemble weights (heuristic / cascade / ragSignal / historyBias) |
| `weights <method> <value>` | Set an ensemble weight (0–1) |
| `feedback` | Show feedback buffer stats and per-tier accuracy |
| `rag` | Show RAG index stats (total entries, active, avg tokens) |
| `retrain` | Trigger manual retraining and hot-swap weights |
| `training` | Show training mode status for all agents |
| `training <agentId> on\|off` | Enable or disable training mode for an agent |
| `training labels <agentId>` | Show collected gold/silver/bronze labels for an agent |
| `providers` | List all registered providers (HTTP + CLI) with type, status, and models |
| `direct <provider> <model> "prompt"` | Send a prompt directly to a specific provider/model, bypassing routing |

**Examples:**

```bash
npx tsx src/gateswarm-cli.ts model heavy qwen3.5-plus bailian
npx tsx src/gateswarm-cli.ts reasoning extreme on
npx tsx src/gateswarm-cli.ts retrain-freq 200
npx tsx src/gateswarm-cli.ts weights heuristic 0.35
npx tsx src/gateswarm-cli.ts providers
npx tsx src/gateswarm-cli.ts direct claude-cli cc/claude-sonnet-4-6 "What is 2+2?"
```

---

## Providers

### HTTP Providers

| Provider | ID | Models |
|----------|----|--------|
| Alibaba Bailian | `bailian` | MiniMax-M2.5, qwen3.5-plus, qwen3.6-plus, qwen3.6-max-preview, kimi-k2.5 |
| Z.AI | `zai` | glm-4.7, glm-4.5-air |

### CLI Providers

CLI providers are dispatched via subprocess spawn. They do not support streaming (auto-downgraded to sync). Direct routing prefix syntax: `cc/`, `cx/`, `pi/`, `hm/`, `oc/`.

| Provider | ID | Prefix | Notes |
|----------|----|--------|-------|
| Claude Code | `claude-cli` | `cc/` | Quota tracking (5h + weekly) |
| OpenAI Codex | `codex-cli` | `cx/` | Quota tracking (5h + weekly) |
| Pi | `pi-agent` | `pi/` | Quota tracking |
| Hermes | `hermes-agent` | `hm/` | Quota tracking |
| OpenClaw | `openclaw-agent` | `oc/` | Quota tracking |

---

## Configuration

`v04_config.json` is the live configuration file — hot-reloaded on CLI changes, no gateway restart needed.

Key sections:

- **`tier_models`** — primary model, provider, max_tokens, enable_thinking, fallback_models per tier
- **`ensemble.weights`** — heuristic (0.55), cascade (0), ragSignal (0.25), historyBias (0.2)
- **`tier_boundaries`** — score thresholds separating the 6 tiers
- **`feedback_loop`** — retraining frequency, LLM judge model and sampling rate, A/B holdout
- **`rag`** — max entries (10,000), TTL (24h), query max results

Edit via CLI commands (`model`, `reasoning`, `weights`, `retrain-freq`) or directly in `v04_config.json`.

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
