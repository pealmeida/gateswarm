# GateSwarm MoMA Router

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20+-brightgreen.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.5.6-blue.svg)](https://github.com/pealmeida/gateswarm-router)
[![Latest release](https://img.shields.io/github/v/release/pealmeida/gateswarm-router?sort=semver)](https://github.com/pealmeida/gateswarm-router/releases)

**Self-optimizing LLM routing gateway with health-aware tier selection, Plan/Act dual-model routing, and effort overrides.** Scores every prompt via a 25-feature ensemble, picks the cheapest capable model per intent mode, and learns from every interaction.

> **Latest stable:** [v0.5.6](https://github.com/pealmeida/gateswarm-router/releases/tag/v0.5.6) (Plan/Act + Effort Override)
> **Previously shipped:** [v0.5.5](https://github.com/pealmeida/gateswarm-router/releases/tag/v0.5.5) (Routing Transparency + Quota-Aware Routing + OSS Hygiene) · [v0.5.3](https://github.com/pealmeida/gateswarm-router/releases/tag/v0.5.3) (Foundational fixes: dotenv + debounced writes)
> **Releases on GitHub:** v0.4.4, v0.5.2, v0.5.3, v0.5.5, v0.5.6

---

## What's New

### v0.5.6 — Plan/Act + Effort Override (current stable — LATEST)

- **Plan/Act auto-detection** — `detectIntentMode()` scores prompts based on keyword patterns. Plan keywords (draft, outline, brainstorm, sketch, explore, what if, options, approach, consider, tradeoff, strategy, roadmap, plan, design, compare, pros and cons) vs act keywords (implement, build, code, fix, deploy, run, test, apply, merge, write the code, create the file). Auto-defaults to act when scores are tied.
- **Per-tier `plan_model` config** — each of moderate, heavy, intensive, extreme has a separate plan_model/plan_provider/plan_max_tokens/plan_enable_thinking. When the request mode is `plan`, the gateway routes to the plan model instead of the primary. Saves tokens on exploration while preserving capability for execution.
- **`effort_override` request field + `X-Effort-Override` header** — bypass ensemble scoring; jump straight to the named tier (`trivial`/`light`/`moderate`/`heavy`/`intensive`/`extreme`). Invalid values return HTTP 400. The greeting fast-path is skipped when an override is set.
- **`POST /v06/mode/detect`** — test mode detection on any prompt. Returns `{ mode, confidence, planScore, actScore }`.
- **`POST /v06/resolve`** — given a (tier, mode), returns the model that would be dispatched. Useful for debugging and dashboards.
- **CLI commands**: `gateswarm resolve <tier> [mode]`, `gateswarm effort-override <tier> <prompt>`.

### v0.5.5 — Routing Transparency + Quota-Aware Routing + OSS Hygiene (foundation for v0.5.6)

- **Removed broken `dotenv` import + dep** — was listed in `package.json` as a dependency but never installed, which would fail `npm start` outside systemd. The systemd unit already sources `.env` via `set -a; source`, so the import was redundant.
- **Debounced `agent-registry.save()`** — was 2 full-file writes per request; now coalesces bursts into 1 write per 1s window. Graceful shutdown via SIGINT/SIGTERM triggers `flushPending()` so the last burst is not lost on restart. Verified: 10 parallel requests → 0 immediate writes → 1 write after 1s.

### v0.5.2 — Plan/Act Dual-Model Routing (the first public release on origin)

- **Plan/Act Dual-Model Routing** — each tier carries an *act* model (default) and a *plan* model; plan mode dispatches the **actual request** to the plan model.
- **More accurate intent detection** — stem-aware word-boundary keyword matching. Act recall 60% → 100%, plan recall 87% → 93%.
- **Less over-routing, more accurate tiers** — exact-tier accuracy 41% → 49%, within-±1 83% → 88%.
- **Provider/model consistency enforced** — `eval/consistency-check.ts` verifies every model in `v04_config.json` exists in its provider's catalog.
- **OpenCodeGo provider** — HTTP adapter for deepseek-v4-flash/pro, qwen3.7, kimi, minimax, mimo.
- **Mode CLI commands** — `mode-status`, `mode-set`, `mode-detect`.

---

## How It Works

GateSwarm Router is a TypeScript API gateway that sits between any OpenAI-compatible LLM client and multiple LLM providers. It intercepts every chat completion request, scores prompt complexity across 25 features using a weighted ensemble (heuristic 55%, RAG signal 25%, history bias 20%), detects intent mode (plan vs act), routes to the right tier and model pair, compresses long conversations with TurboQuant, retrieves relevant RAG context, and logs feedback to continuously improve routing accuracy.

```
Client (OpenAI-compatible, any agent)
  |
  v
GateSwarm Router (:8900)
  |-- Score complexity (ensemble voter)
  |-- Detect intent mode (plan vs act)
  |-- Apply effort_override (if set)
  |-- Route to tier + mode model (trivial → extreme)
  |-- TurboQuant compression (Q8 → Q0)
  |-- RAG context retrieval
  |-- Sanitize + forward + fallback
  |
  +-----> HTTP Providers                  CLI Providers (subprocess)
          Z.AI (GLM-4.7, GLM-5, GLM-5.1)  Claude Code (cc/)
          Ollama Cloud (minimax-m2.7)      Codex CLI (cx/)
          Ollama (local: qwen2.5:0.5b)     Pi (pi/)
                                          Hermes (hm/)
                                          OpenClaw (oc/)
```

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
  -H "Authorization: Bearer moma-f4…d34b" \
  -d '{"model":"gateswarm","messages":[{"role":"user","content":"Explain quantum computing"}]}'
```

For systemd-managed deployments (recommended for VPS), see [docs/GATEWAY_QUICKSTART.md](docs/GATEWAY_QUICKSTART.md).

---

## Plan/Act Dual-Model Routing

Every tier has two model assignments — one for **acting** (default: implementation, execution, bug-fixing) and one for **planning** (exploration, drafting, architecture). For the upper tiers, planning routes to CLI reasoning agents (Codex, Claude Code) while acting stays on fast/cheap HTTP models. Current defaults (from `v04_config.json`, hot-reloaded):

| Tier | Act Model | Act Provider | Plan Model | Plan Provider |
|------|-----------|-------------|------------|---------------|
| **trivial** | qwen2.5:0.5b | ollama | (uses act) | — |
| **light** | minimax-m2.7 | ollama-cloud | (uses act) | — |
| **moderate** | glm-5 | zai | glm-4.7-flash | zai |
| **heavy** | glm-5.1 | zai | glm-5 | zai |
| **intensive** | cx/gpt-5.4-codex | codex-cli | cc/claude-sonnet-4-6 | claude-cli |
| **extreme** | cx/gpt-5.4-codex | codex-cli | cc/claude-opus-4-6 | claude-cli |

Auto-detection (`detectIntentMode`) scores stem-aware keyword hits plus intent patterns. Override explicitly with `"mode": "plan"` / `"mode": "act"` in the request body, or the `X-Mode` request header. Values are configurable via `gateswarm mode-set` or by editing `v04_config.json` directly.

---

## Effort Override

Skip the ensemble scoring and force a specific tier:

```bash
# Request body
POST /v1/chat/completions
{ "model": "gateswarm", "messages": [...], "effort_override": "heavy" }

# OR header form
POST /v1/chat/completions
X-Effort-Override: heavy
```

Valid values: `trivial`, `light`, `moderate`, `heavy`, `intensive`, `extreme`. Invalid values return HTTP 400. The greeting fast-path is skipped when an override is set, so the caller's chosen tier is always honored.

---

## Routing Tiers

All 6 tiers and their current model assignments (from `v04_config.json`, hot-reloaded):

| Tier | Score Range | Act Model | Act Provider | Max Tokens | Reasoning |
|------|-------------|-----------|-------------|-----------|-----------|
| **trivial** | 0.00 – 0.16 | qwen2.5:0.5b | ollama | 256 | — |
| **light** | 0.16 – 0.28 | minimax-m2.7 | ollama-cloud | 512 | — |
| **moderate** | 0.28 – 0.35 | glm-5 | zai | 2048 | — |
| **heavy** | 0.35 – 0.40 | glm-5.1 | zai | 4096 | ✓ |
| **intensive** | 0.40 – 0.46 | cx/gpt-5.4-codex | codex-cli | 4096 | — |
| **extreme** | 0.46 – 1.00 | cx/gpt-5.4-codex | codex-cli | 8192 | — |

Reasoning (`enable_thinking`) is on for heavy and extreme tiers. Tier models, plan/act overrides, and fallback chains are fully configurable via CLI or by editing `v04_config.json` directly.

---

## Health-Aware Routing

The router reads `providerQuota` health scores and skips throttled providers before dispatch. Health decays on every successful call (so a transient 429 from a quota probe doesn't permanently poison a provider), and is reset by re-probing via `POST /v05/intel/rediscover`.

If the static primary for a tier is unhealthy, the router falls through to the configured fallback chain. If all fallbacks are unhealthy, it falls back to `cheapest_available` from the dynamic discovery pool.

Read more in [docs/ROUTING_STRATEGY.md](docs/ROUTING_STRATEGY.md).

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

### Plan/Act Mode Commands

| Command | Description |
|---------|-------------|
| `mode-status` | Show plan/act model assignments for all 6 tiers |
| `mode-set <tier> <field> <value>` | Set a plan-mode field for a tier (plan_model, plan_provider, plan_max_tokens, plan_enable_thinking) |
| `mode-detect "<prompt>"` | Test auto-detection of plan vs act on a prompt |
| `resolve <tier> [mode]` | Show what model would be used for (tier, mode) |
| `effort-override <tier> "<prompt>"` | Force a tier for one request, bypassing ensemble scoring |

### Provider Commands

| Command | Description |
|---------|-------------|
| `providers` | List all registered providers (HTTP + CLI) with type, status, quota, and models |
| `direct <provider> <model> "<prompt>"` | Send a prompt directly to a specific provider/model, bypassing routing |

### Operations Commands (v0.5.6+)

| Command | Description |
|---------|-------------|
| `ops-guide` | Print the full operations guide (updates, debugging, analysis, versioning) |
| `health` | 11-point health check (service, 4 HTTP providers, 5 CLI providers, last decision) |
| `version` | Verify all 7 version stamps are aligned across files |
| `tui` | Launch the gateswarm-bar TUI (Ink-based) |

### Training Commands

| Command | Description |
|---------|-------------|
| `training` | Show training mode status for all agents |
| `training <agentId> on\|off` | Enable or disable training mode for an agent |
| `training labels <agentId>` | Show collected gold/silver/bronze labels for an agent |

**Examples:**

```bash
# Model management
npx tsx src/gateswarm-cli.ts model heavy glm-5.1 zai
npx tsx src/gateswarm-cli.ts reasoning extreme on
npx tsx src/gateswarm-cli.ts retrain-freq 200
npx tsx src/gateswarm-cli.ts weights heuristic 0.35

# Plan/Act modes + effort override
npx tsx src/gateswarm-cli.ts mode-status
npx tsx src/gateswarm-cli.ts mode-set heavy plan-model glm-5 zai
npx tsx src/gateswarm-cli.ts mode-detect "implement a rate limiter in Rust"
npx tsx src/gateswarm-cli.ts resolve intensive plan
npx tsx src/gateswarm-cli.ts effort-override heavy "design a global CRDT system"

# Operations
npx tsx src/gateswarm-cli.ts health
npx tsx src/gateswarm-cli.ts version
npx tsx src/gateswarm-cli.ts ops-guide

# Providers
npx tsx src/gateswarm-cli.ts providers
npx tsx src/gateswarm-cli.ts direct claude-cli cc/claude-sonnet-4-6 "What is 2+2?"
```

---

## Providers

### HTTP Providers

| Provider | ID | Models (subset) | Status |
|----------|----|------------------|--------|
| Z.AI (GLM Coding Lite) | `zai` | glm-4.7-flash, glm-4.7, glm-5, glm-5.1 | ✓ Healthy |
| Ollama Cloud (free tier) | `ollama-cloud` | minimax-m2.7, minimax-m3, kimi-k2.6, kimi-k2.7-code, deepseek-v4-pro | ✓ Healthy |
| Ollama (local) | `ollama` | qwen2.5:0.5b | ✓ Healthy |
| Alibaba Bailian | `bailian` | qwen3.5-plus, qwen3.6-plus, qwen3-coder-plus | ⚠️ Key expired (rotate to re-enable) |
| OpenCodeGo | `opencodego` | qwen3.7-plus, qwen3.7-max, deepseek-v4-flash/pro, kimi | ⚠️ Quota exhausted (resets in 14d) |

> Provider model catalogs are validated against the routing config by
> `eval/consistency-check.ts` (enforced in the test suite) — a tier or fallback can never
> reference a model a provider doesn't serve.

### CLI Providers

CLI providers are dispatched via subprocess spawn. They do not support streaming (auto-downgraded to sync). Direct routing prefix syntax: `cc/`, `cx/`, `pi/`, `hm/`, `oc/`.

| Provider | ID | Prefix | Auth |
|----------|----|--------|------|
| Claude Code | `claude-cli` | `cc/` | OAuth (`~/.claude/.credentials.json`) |
| OpenAI Codex | `codex-cli` | `cx/` | ChatGPT OAuth (`~/.codex/auth.json`) |
| Pi | `pi-agent` | `pi/` | n/a (binary only) |
| Hermes | `hermes-agent` | `hm/` | n/a |
| OpenClaw | `openclaw-agent` | `oc/` | n/a |

CLI health checks are auth-aware: `bin/cli-health-probe.sh` verifies both the binary is installed AND the auth credentials are present (verifying `codex --version` alone was a lie that let unauthenticated providers appear healthy).

---

## Configuration

`v04_config.json` is the live configuration file — hot-reloaded on CLI changes, no gateway restart needed.

Key sections:

- **`tier_models.<tier>`** — act (primary) model, provider, max_tokens, enable_thinking, plus `plan_model`, `plan_provider`, `plan_max_tokens`, `plan_enable_thinking` for Plan/Act dual routing
- **`tier_boundaries`** — score thresholds separating the 6 tiers
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
| `BAILIAN_KEY` | Alibaba Bailian API key (optional; expired as of 2026-06-20) |
| `BAILIAN_BASE` | Bailian base URL |
| `GLM_API_KEY` / `ZAI_KEY` | Z.AI (GLM) API key — **required for moderate/heavy primary** |
| `ZAI_BASE` | Z.AI base URL |
| `OPENCODEGO_KEY` | OpenCodeGo API key (optional; quota exhausted, resets in 14d) |
| `OLLAMA_CLOUD_KEY` | Ollama Cloud API key (optional) |
| `OLLAMA_BASE` | Ollama base URL (default: `http://127.0.0.1:11434/v1`) |
| `PORT` | Gateway port (default: 8900) |
| `GATESWARM_ROOT` | Path to the router root (set by systemd; used by CLI health probes) |

---

## Architecture

Full architecture documentation including the 9-stage request pipeline, TurboQuant compression levels, 7-phase message sanitization, RAG lifecycle, feedback store, training mode, and fallback chains:

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

For operations — how to update, debug, analyze, and version this codebase — see [docs/OPS_GUIDE.md](docs/OPS_GUIDE.md).

---

## Project Layout

```
gateswarm-router/
├── README.md                          # this file
├── CHANGELOG.md                        # release history
├── LICENSE                             # MIT
├── CONTRIBUTING.md                     # how to contribute
├── CODE_OF_CONDUCT.md                  # community standards
├── SECURITY.md                         # vulnerability reporting
├── QUICKSTART.md                       # 5-minute setup
├── PRD.md                              # product requirements
├── REQUIREMENTS.md → docs/REQUIREMENTS.md  # technical requirements
├── ARCHITECTURE.md → docs/ARCHITECTURE.md   # (root file removed; see docs/)
│
├── package.json                        # Node deps
├── tsconfig.json
├── v04_config.json                     # the live config (hot-reloaded)
├── v32_cascade_weights.json            # legacy v0.3.2 weights (reference)
├── v33_heuristic_weights.json          # legacy v0.3.3 weights (reference)
│
├── bin/                                # CLI binaries on PATH
│   └── cli-health-probe.sh             # auth-aware health probe
├── scripts/                            # operational scripts
│   ├── cli-health-probe.sh             # canonical source
│   └── quota-sync.py                   # provider quota scraper
├── src/                                # active TypeScript source
│   ├── moma-gateway.ts                 # main gateway
│   ├── gateswarm-cli.ts                # CLI + TUI client
│   ├── agent-registry.ts               # provider/agent registry
│   ├── v04-config.ts                   # config + Plan/Act logic
│   ├── intent-engine-v04.ts            # ensemble voter
│   ├── consumption-intelligence.ts     # token economy
│   ├── provider-quota.ts               # health scoring
│   ├── model-matrix.ts                 # model catalog
│   ├── rag-index.ts                    # RAG with Q* filter
│   ├── adapters/                       # provider adapters (HTTP + CLI)
│   ├── classifiers/                    # 25-feature heuristic
│   └── types/                          # TypeScript type defs
├── cli/                                # gateswarm-bar TUI
│   ├── src/
│   │   ├── cli.tsx                     # Ink-based TUI
│   │   ├── api.ts                      # gateway HTTP client
│   │   ├── types.ts                    # API types
│   │   └── components/                 # Header, TiersMatrix, ModelsPanel, etc.
│   ├── README.md
│   └── package.json
├── tests/                              # vitest test suite
│   ├── agent-registry-debounce.test.ts # v0.5.3
│   ├── plan-act-routing.test.ts        # v0.5.4
│   ├── intent-engine.test.ts
│   ├── cli-providers.test.ts
│   └── ...
├── docs/                               # documentation
│   ├── ARCHITECTURE.md
│   ├── OPS_GUIDE.md                    # updates, debugging, analysis, versioning
│   ├── SECURITY_AUDIT.md               # pre-release security audit
│   ├── ROUTING_STRATEGY.md
│   ├── INTEGRATION.md
│   ├── GATEWAY_QUICKSTART.md
│   ├── PERSISTENCE_GUIDE.md
│   ├── CONTEXT_COMPRESSION_GUIDE.md
│   ├── ACCURACY_ROADMAP.md
│   ├── TRAINING_MODE_GUIDE.md
│   ├── REQUIREMENTS.md
│   ├── V06_BACKPORT_PLAN.md            # v0.6.x backport roadmap
│   ├── SAFETY.md
│   └── research/                       # v3.x accuracy analyses
├── eval/                               # evaluation harness
│   ├── cv.ts                           # cross-validation
│   ├── feature-report.ts
│   ├── leaderboard.ts
│   ├── lib/                            # dataset, metrics, runner, split
│   └── splits/                         # v1 CV folds + holdout
├── llmfit/                             # Python training tooling
│   ├── llmfit.py
│   ├── anonymizer.py                   # strips paths/identifiers from logs
│   ├── self_eval.py
│   └── datasets/                       # training data generators
├── gateway/                            # ⚠️ LEGACY v0.4.4 reference (do not use)
│   └── README.md                       #   "kept for historical reference only"
├── data/                               # runtime state (gitignored; regenerated on first run)
│   ├── feedback/                       #   feedback store
│   ├── rag/                            #   RAG index
│   ├── training/                       #   training state
│   └── benchmark-logs/                  #   raw benchmark logs
├── Dockerfile                          # container build
├── Dockerfile.inference                # inference container
└── .github/
    ├── ISSUE_TEMPLATE/                  # bug report + feature request
    ├── workflows/ci.yml                 # typecheck + test on push/PR
    └── pull_request_template.md
```

---

## Releases

The release tags on GitHub are the source of truth. The version sequence is:

```
v0.4.4 (May 14, 2026) — context-aware
v0.5.2 (Jun 6, 2026)  — plan/act dual routing, recalibrated tiers
v0.5.3 (Jun 20, 2026) — found: dotenv + debounced writes (now part of v0.5.5 line)
v0.5.5 (Jun 20, 2026) — health-aware routing + portable paths + OSS hygiene
v0.5.6 (Jun 20, 2026) — feat: plan/act + effort override (LATEST)
v0.5.6 (Jun 20, 2026) — fix: health-aware routing + portable paths + OSS hygiene
```

The `v0.6.x` development line (kept local on the `v0.6.x-guide` branch) is used as a reference for backporting improvements. See [docs/V06_BACKPORT_PLAN.md](docs/V06_BACKPORT_PLAN.md) for the v0.6.x roadmap.

The `v0.5.3` foundational work is on the `release/v0.5.x` branch (now merged into main as part of v0.5.5). The cleanup branch can be deleted once the v0.5.5/v0.5.6 release sequence is final.

---

## Contributing

1. Fork the repo and create a feature branch
2. Run `npm run check:types` and `npm test` before submitting
3. See [CONTRIBUTING.md](CONTRIBUTING.md) for code style and PR guidelines

---

## License

MIT — see [LICENSE](LICENSE).
