# GateSwarm MoMA Router

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-20+-brightgreen.svg)](https://nodejs.org/)
[![Latest release](https://img.shields.io/github/v/release/pealmeida/gateswarm-router?sort=semver)](https://github.com/pealmeida/gateswarm-router/releases)

**Evidence-gated LLM routing gateway.** Scores every prompt, picks the cheapest *capable* model, and collects feedback for safer improvements.

> **Latest stable:** [v0.5.6](https://github.com/pealmeida/gateswarm-router/releases/tag/v0.5.6) — Routing Transparency + Quota-Aware Routing + OSS Hygiene
> **Releases:** v0.4.4 · v0.5.2 · v0.5.3 · v0.5.4 · v0.5.5 · v0.5.6 (see [Releases](#releases) below)

---

## What is it?

**GateSwarm** is an **LLM routing gateway**. It sits between any OpenAI-compatible client (your IDE agent, your CLI, your app) and a pool of language models — local, cloud HTTP, and CLI agents. Every chat-completion request passes through it. It scores the prompt's complexity, picks the **cheapest model capable of answering it**, forwards the request, and records outcome evidence for gated improvements.

**MoMA — Mixture of Multimodal Agents** — is the routing pattern at its core. Instead of one model serving every prompt, GateSwarm dynamically mixes and matches across providers based on what each prompt actually needs.

```
Your client  ──►  GateSwarm :8900  ──►  right model for the job
                                         (hosted flash model, cloud model, or reasoning agent)
```

### In one sentence

> **Every prompt gets scored; the cheapest capable model answers; feedback informs evidence-gated improvements.**

### Four things it does that a normal API client doesn't

1. **Routes by complexity, not by hand.** You stop choosing between GPT-5 and Claude Opus per call. The router picks for you — automatically, per request.
2. **Plan vs Act, per tier.** *"Design a global CRDT system"* (planning) and *"implement the CRDT in Rust"* (acting) can route to **different models at the same tier**. Planning leans on reasoning agents (Claude Opus, Codex); acting leans on fast/cheap HTTP models (GLM, Qwen).
3. **Routes by modality.** Send an `image_url` content part and the router restricts candidates to **vision-capable models** — widening the tier band if no in-tier vision model is healthy (`vision_widened`). Text-only models never receive raw base64; media parts degrade to `[image]` placeholders when a text-only fallback is unavoidable.
4. **Fails over intelligently.** Z.AI rate-limits? The router detects the health drop, decays the score, and falls through to the next healthy provider — without your client ever seeing a 429.

### What it is *not*

- **Not a model.** GateSwarm doesn't generate text. It decides who should.
- **Not a training framework.** It uses a heuristic-first scorer. RAG and history remain opt-in ensemble signals (both default to weight 0 pending evidence), while boundary retraining produces reviewed proposals rather than changing live routing.
- **Not an OpenAI replacement.** It's a transparent drop-in *in front of* OpenAI-compatible providers. Swap the base URL, keep your client code.

---

## Why use it?

| Benefit | What it means in practice |
|---|---|
| **Cost reduction** | Hosted flash `zai/glm-4.7-flash` answers trivial questions (*"2+2"*); expensive Claude Opus is reserved for extreme-tier prompts. Saves 60–90% on token spend for mixed workloads. |
| **Quality on demand** | Hard prompts automatically escalate to stronger models. You don't have to manually choose. |
| **Plan vs Act separation** | Planning and acting can dispatch to different models within the same tier — Claude Opus for thinking, Codex for writing. |
| **Provider failover** | If your Bailian key expires or Z.AI rate-limits, the router detects health decay and falls through to the next provider automatically. |
| **Multimodal-aware** | Image requests route only to vision-capable models (`X-Modality: text+vision`); text-only providers never see raw base64 payloads. |
| **OpenAI-compatible** | Drop-in for any OpenAI client. Change `base_url` to `:8900`, no SDK changes. |
| **Evidence-gated learning** | 34-feature heuristic routing collects redacted organic feedback; learned signals and boundary changes activate only after their evidence and review gates pass. |
| **Transparent** | CLI (`gateswarm`) and TUI (`gateswarm-bar`) show last decision, weights, health, quota. No black box. |
| **Local + cloud + CLI** | Mixes optional local Ollama, cloud HTTP providers (Z.AI, Ollama Cloud, Bailian, OpenCodeGo), and Claude Code/Codex/Pi/Hermes/OpenClaw CLI agents. |

Training mode asks for votes on synchronous, streaming, and CLI responses. Gold votes retain full redacted prompts in `data/organic/labeled.jsonl` under a versioned schema, and replies are bound to vote IDs. The ordinal cascade remains inactive unless a gate-passed `v05_ordinal_weights.json` artifact is present; it is not enabled by default.

---

## How it works

```
Client (OpenAI-compatible, any agent)
  |
  v
GateSwarm Router (:8900)
  |-- Score complexity (heuristic-first voter — 34 features)
  |-- Detect intent mode (plan vs act, stem-aware keyword match)
  |-- Apply effort_override (if set)
  |-- Route to tier + mode model (trivial → extreme)
  |-- TurboQuant compression (Q8 → Q0) for long contexts
  |-- RAG context retrieval (Q* filter excludes compressor noise)
  |-- Sanitize + forward + fallback
  |-- Record feedback → evidence-gated training and proposals
  |
  +-----> HTTP Providers                  CLI Providers (subprocess)
          Z.AI (GLM-4.7, GLM-5, GLM-5.1)  Claude Code (cc/)
          Ollama Cloud (minimax-m2.7)      Codex CLI (cx/)
          Ollama (optional local provider) Pi (pi/)
                                          Hermes (hm/)
                                          OpenClaw (oc/)
```

### Routing tiers

The six built-in default tiers are defined in `DEFAULT_V04_CONFIG`; deployments may override them through the hot-reloaded `v04_config.json`.

| Tier | Score Range | Act Model | Act Provider | Max Tokens | Reasoning |
|------|-------------|-----------|--------------|------------|-----------|
| **trivial** | 0.000000 – 0.208938 | glm-4.7-flash | zai | 256 | — |
| **light** | 0.208938 – 0.264209 | minimax-m2.7 | ollama-cloud | 512 | — |
| **moderate** | 0.264209 – 0.325020 | glm-5 | zai | 2048 | — |
| **heavy** | 0.325020 – 0.365850 | glm-5.1 | zai | 4096 | ✓ |
| **intensive** | 0.365850 – 0.485382 | cx/gpt-5.4-codex | codex-cli | 4096 | ✓ |
| **extreme** | 0.485382 – 1.000000 | cx/gpt-5.4-codex | codex-cli | 8192 | ✓ |

Reasoning (`enable_thinking`) is on for heavy, intensive, and extreme tiers. Tier models, plan/act overrides, and fallback chains are fully configurable via CLI or by editing `v04_config.json` directly.

### Plan vs Act (per tier)

Every tier has two model assignments — one for **acting** (default: implementation, execution, bug-fixing) and one for **planning** (exploration, drafting, architecture). For the upper tiers, planning routes to CLI reasoning agents (Codex, Claude Code) while acting stays on fast/cheap HTTP models.

| Tier | Act Model | Act Provider | Plan Model | Plan Provider |
|------|-----------|--------------|------------|---------------|
| **trivial** | glm-4.7-flash | zai | (uses act) | — |
| **light** | minimax-m2.7 | ollama-cloud | (uses act) | — |
| **moderate** | glm-5 | zai | glm-4.7-flash | zai |
| **heavy** | glm-5.1 | zai | glm-5 | zai |
| **intensive** | cx/gpt-5.4-codex | codex-cli | cc/claude-sonnet-4-6 | claude-cli |
| **extreme** | cx/gpt-5.4-codex | codex-cli | cc/claude-opus-4-8 | claude-cli |

Auto-detection (`detectIntentMode`) scores stem-aware keyword hits plus intent patterns. Override explicitly with `"mode": "plan"` / `"mode": "act"` in the request body, or the `X-Mode` request header.

### Health-aware routing

The router reads `providerQuota` health scores and skips throttled providers before dispatch. Health decays on every successful call (so a transient 429 from a quota probe doesn't permanently poison a provider), and is reset by re-probing via `POST /v05/intel/rediscover`.

If the static primary for a tier is unhealthy, the router falls through to the configured fallback chain. If all fallbacks are unhealthy, it falls back to `cheapest_available` from the dynamic discovery pool. Read more in [docs/ROUTING_STRATEGY.md](docs/ROUTING_STRATEGY.md).

### Multimodal routing (the "M" in MoMA)

Requests carrying `image_url` / `input_audio` / video content parts are detected at ingress and routed modality-aware:

- **Vision filter.** A request with image parts only considers vision-capable models (`supportsVision` in the model matrix). The tier's static primary is skipped unless it can see.
- **Tier-band widening.** If no vision model exists in the scored tier's band, the router widens to *any* healthy vision-capable model (`X-Routing-Reason: vision_widened`) — a capable eye beats a perfect tier fit.
- **Payload hygiene.** Vision targets receive the original content arrays untouched. Text-only targets (including all CLI agents) get compact `[image]`/`[audio]` placeholders — raw base64 never leaks into prompts, scoring, or context compression.
- **Transparency.** Every response carries `X-Modality` (`text`, `text+vision`, `text+vision+audio`) alongside the other routing headers (`X-Tier`, `X-Score`, `X-Routed-Model`, `X-Routing-Reason`).

```bash
# Vision request → routed to a vision model automatically
curl :8900/v1/chat/completions -d '{
  "model": "auto",
  "messages": [{ "role": "user", "content": [
    { "type": "text", "text": "What color is this?" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
  ]}]
}'
# → X-Modality: text+vision, X-Routed-Model: ollama-cloud/gemini-3-flash-preview
```

---

## Quick Start

```bash
git clone https://github.com/pealmeida/gateswarm-router.git
cd gateswarm-router
cp .env.example .env          # add your API keys
npm install
npm start                     # gateway on :8900
```

The default low tiers use hosted Z.AI and Ollama Cloud models, so configure the relevant provider keys; local Ollama is optional and is not a default routing path.

Point any OpenAI-compatible client at `http://localhost:8900/v1`:

```bash
curl http://localhost:8900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ***…d34b" \
  -d '{"model":"gateswarm","messages":[{"role":"user","content":"Explain quantum computing"}]}'
```

For systemd-managed deployments (recommended for VPS), see [docs/GATEWAY_QUICKSTART.md](docs/GATEWAY_QUICKSTART.md).

---

## Day-to-day usage

### Let it auto-route
Just send a chat completion with `model: "gateswarm"`. Done.

### Force a tier (effort override)
Skip the scoring and lock a tier:

```bash
# Request body
POST /v1/chat/completions
{ "model": "gateswarm", "messages": [...], "effort_override": "heavy" }

# OR header form
POST /v1/chat/completions
X-Effort-Override: heavy
```

Valid values: `trivial`, `light`, `moderate`, `heavy`, `intensive`, `extreme`. Invalid values return HTTP 400. The greeting fast-path is skipped when an override is set, so the caller's chosen tier is always honored.

### Force plan vs act mode
```bash
{ "model": "gateswarm", "messages": [...], "mode": "plan" }
# or header  X-Mode: plan
```

Auto-detects by default (stem-aware: `draft/outline/explore/…` → plan; `implement/build/fix/…` → act).

### Bypass routing entirely (direct mode)
Pin a specific provider/model:

```json
{ "model": "gateswarm", "messages": [...],
  "direct_route": { "provider": "claude-cli", "model": "cc/claude-sonnet-4-6" } }
```

Or via headers: `X-Direct-Provider: claude-cli` / `X-Direct-Model: cc/claude-sonnet-4-6`.
Or use the model field shorthand: `"model": "cc/claude-sonnet-4-6"`.

### Inspect decisions
```bash
gateswarm status             # ensemble weights, tier models, feedback buffer
gateswarm health             # 11-point health check (gateway + 4 HTTP + 5 CLI)
gateswarm feedback           # per-tier accuracy, retrain ETA
gateswarm providers          # all providers + quota + status
gateswarm version            # verify 7 version stamps align
```

### Launch the TUI
```bash
gateswarm tui                # gateswarm-bar (Ink) — live tier matrix + last request
```

---

## Customizing

Three layers of customization, from safest to most invasive.

### 1. CLI commands (live, hot-reload — no restart)

```bash
# Models + reasoning
gateswarm model heavy glm-5.1 zai              # change act model
gateswarm reasoning extreme on                 # toggle thinking

# Ensemble + boundary proposals
gateswarm weights heuristic 0.35               # reweight ensemble
gateswarm retrain-freq 200                     # retrain every 200 interactions
gateswarm retrain                              # create a reviewable boundary proposal

# Plan/Act
gateswarm mode-set heavy plan-model glm-5 zai  # change plan model
gateswarm mode-detect "implement rate limiter" # test intent detection
gateswarm resolve intensive plan               # what model would dispatch
gateswarm effort-override heavy "design CRDT"  # force tier once

# Direct + diagnostics
gateswarm direct claude-cli cc/claude-sonnet-4-6 "What is 2+2?"
gateswarm ops-guide                            # full ops guide
```

Full command reference below. Changes are persisted to `v04_config.json` and hot-reloaded by the gateway.

### 2. Edit `v04_config.json` directly

Key sections:
- **`tier_models.<tier>`** — `model`, `provider`, `max_tokens`, `enable_thinking`, plus plan-mode fields
- **`tier_boundaries`** — score thresholds separating the 6 tiers
- **`ensemble.weights`** — `heuristic`, `cascade`, `ragSignal`, `historyBias` (must sum to 1.0)
- **`feedback_loop`** — proposal frequency, LLM judge model, sampling rate
- **`rag`** — max entries, TTL, query limits

A consistency check (`eval/consistency-check.ts`) enforces that every model in the config exists in its provider's catalog. So you can't typo a model name silently.

### 3. Add a new provider or model

**New model on an existing provider:** add it to the provider's catalog — `HTTP_PROVIDER_MODELS` in `src/agent-registry.ts` for HTTP providers, `DEFAULT_CLI_PROVIDERS` (with a prefix alias) for CLI agents — then reference it in `v04_config.json` tier_models. Unprefixed model names resolve to the first registered provider whose catalog lists them, so no extra routing rule is needed.

**New provider:**

1. HTTP: add a catalog entry to `HTTP_PROVIDER_MODELS` and register it in `AgentRegistry.initialize()` (base URL + API key from `.env`). CLI: add an entry to `DEFAULT_CLI_PROVIDERS` with its prefix alias map.
2. Reference its models in `v04_config.json` tier_models.
3. Run `npm run check:consistency` to validate (also enforced by `npm test`).

CLI providers require only an OAuth/binary check; HTTP providers require API keys in `.env`.

---

## Updating

### Pull the latest version

```bash
cd gateswarm-router
git pull
npm install            # in case deps changed
npm run check:types    # typecheck
npm test               # test suite
```

Restart the systemd service (if running that way):
```bash
sudo systemctl restart moma-gateway.service
gateswarm health      # verify clean
```

### Track releases

GitHub Releases are the source of truth: https://github.com/pealmeida/gateswarm-router/releases

```
v0.4.4 (May 14, 2026) — context-aware
v0.5.2 (Jun 6, 2026)  — plan/act dual routing, recalibrated tiers
v0.5.3 (Jun 20, 2026) — dotenv + debounced writes (foundational)
v0.5.4 (Jun 20, 2026) — plan/act + effort override (the feature release)
v0.5.5 (Jun 20, 2026) — health-aware routing + portable paths + OSS hygiene
v0.5.6 (Jun 20, 2026) — re-shuffle + CHANGELOG + README (LATEST)
v0.6.0 (In progress)  — security hardening, reliable fallbacks, honest evals, organic-loop fixes, and routing-core correctness on `release/v0.6.0`
```

v0.6.0 is developed on `release/v0.6.0` and driven by a four-pass, 96-finding adversarial review documented in [docs/RELEASE_PLAN_v0.6.0.md](docs/RELEASE_PLAN_v0.6.0.md).

### Version alignment

The project maintains **7 version stamps** that must stay aligned. Verify with:
```bash
gateswarm version
```
If any stamp drifts, the gateway prints which file needs updating.

### Operational tasks

For full ops — debugging, quota syncing, log analysis, security audit, health decay tuning — see **`docs/OPS_GUIDE.md`**. For architectural deep-dive (9-stage pipeline, TurboQuant levels, 7-phase sanitization, fallback chains) see **`docs/ARCHITECTURE.md`**.

---

## CLI Management Reference

Run via `npx tsx src/gateswarm-cli.ts <command>` or alias as `gateswarm`.

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
| `retrain` | Generate a validation-gated boundary proposal for review; never hot-swaps live boundaries |

### Plan/Act Mode Commands

| Command | Description |
|---------|-------------|
| `mode-status` | Show plan/act model assignments for all 6 tiers |
| `mode-set <tier> <field> <value>` | Set a plan-mode field for a tier (`plan_model`, `plan_provider`, `plan_max_tokens`, `plan_enable_thinking`) |
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

---

## Providers

### HTTP Providers

| Provider | ID | Models (subset) | Status |
|----------|----|------------------|--------|
| Z.AI (GLM Coding Lite) | `zai` | glm-4.7-flash, glm-4.7, glm-5, glm-5.1 | ✓ Healthy |
| Ollama Cloud (free tier) | `ollama-cloud` | minimax-m2.7, minimax-m3, kimi-k2.6, kimi-k2.7-code, deepseek-v4-pro | ✓ Healthy |
| Ollama (local, optional) | `ollama` | qwen2.5:0.5b | Optional — not a trivial/light default |
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

Edit via CLI commands (`model`, `mode-set`, `reasoning`, `weights`, `retrain-freq`) or directly in `v04_config.json`.

### Secrets: Sovereign Vault (recommended)

The gateway loads provider API keys **vault-first** from [Sovereign Vault](https://github.com/pealmeida/sovereign-vault) — a local-first, human-in-the-loop secrets vault — falling back to `.env` automatically when the vault is locked, unavailable, or not installed. No plaintext keys need to live on disk once imported:

```bash
cp .env.example .env          # fill in your keys once
node scripts/sv-import-env.mjs  # push them into vault container "env-gateswarm"
rm .env                       # optional: go vault-only
```

Requires the Sovereign Vault desktop app running and unlocked (`sovereign-vault` on PATH or `SV_BIN` set). Control behavior with `SECRETS_SOURCE=auto|vault|env`, `SV_CONTAINER`, `SV_FILE`, `SV_TIMEOUT_MS` — see [src/secrets/README.md](src/secrets/README.md).

### Environment Variables

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `BAILIAN_KEY` | Alibaba Bailian API key (optional; expired as of 2026-06-20) |
| `BAILIAN_BASE` | Bailian base URL |
| `GLM_API_KEY` / `ZAI_KEY` | Z.AI (GLM) API key — **required for default trivial, moderate, and heavy primaries** |
| `ZAI_BASE` | Z.AI base URL |
| `OPENCODEGO_KEY` | OpenCodeGo API key (optional; quota exhausted, resets in 14d) |
| `OLLAMA_CLOUD_KEY` | Ollama Cloud API key (optional) |
| `OLLAMA_BASE` | Ollama base URL (default: `http://127.0.0.1:11434/v1`) |
| `MOMA_ADMIN_TOKEN` | Token required for agent-management and `/v04/retrain`; when unset, those endpoints remain unauthenticated and the gateway emits a loud startup warning |
| `MOMA_MAX_BODY_BYTES` | Maximum request-body size in bytes (default: `1048576`); larger bodies receive HTTP 413 |
| `PORT` | Gateway port (default: 8900) |
| `GATESWARM_ROOT` | Path to the router root (set by systemd; used by CLI health probes) |

`GET /health` also reports `configReload` (last reload status/error and timestamp) and `scorerHealth` (including ordinal scorer state), alongside provider and agent status.

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
│   ├── classifiers/                    # 34-feature heuristic + ordinal scorer
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
│   ├── RELEASE_PLAN_v0.6.0.md          # 96-finding adversarial review plan
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

The release tags on GitHub are the source of truth:

```
v0.4.4 (May 14, 2026) — context-aware
v0.5.2 (Jun 6, 2026)  — plan/act dual routing, recalibrated tiers
v0.5.3 (Jun 20, 2026) — found: dotenv + debounced writes (foundational)
v0.5.4 (Jun 20, 2026) — feat: plan/act + effort override (the feature)
v0.5.5 (Jun 20, 2026) — fix: health-aware routing + portable paths + OSS hygiene
v0.5.6 (Jun 20, 2026) — chore: re-shuffle + CHANGELOG + README (LATEST)
v0.6.0 (In progress)  — security hardening, reliable fallbacks, honest evaluation, and routing-core fixes
```

The clean 5-version sequence v0.5.3 → v0.5.6 was finalized to redistribute the work into a meaningful version progression. Each release is a coherent, semantically-correct release; no CHANGELOG-only retro-tags.

v0.6.0 is being developed on `release/v0.6.0`, guided by the 96-finding adversarial review in [docs/RELEASE_PLAN_v0.6.0.md](docs/RELEASE_PLAN_v0.6.0.md). It hardens admin access, request-size limits, and redaction; validates streaming and provider health; protects evaluation integrity; repairs the organic training loop; and closes routing-core correctness gaps in Unicode handling, non-finite values, and signal deduplication.

---

## Contributing

1. Fork the repo and create a feature branch
2. Run `npm run check:types` and `npm test` before submitting
3. See [CONTRIBUTING.md](CONTRIBUTING.md) for code style and PR guidelines

---

## License

MIT — see [LICENSE](LICENSE).
