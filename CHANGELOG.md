# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-06-06

### Fixed
- **Plan mode now actually dispatches to the plan model.** The gateway computed the
  plan/act-resolved model but routed the primary request via `resolveModel(agent, effort)`,
  which ignores mode — so plan mode only flipped `X-Mode` headers while still calling the
  act model. Plan mode now dispatches to the tier's configured plan model/provider (CLI
  reasoning models for heavy/intensive/extreme); act/auto keep per-agent routing.
- **Plan-tier models corrected** in `v04_config.json` (were stale copies of the act model):
  moderate→`cx/gpt-5.4-codex`, heavy→`cx/gpt-5.5-codex`, intensive→`cc/claude-sonnet-4-6`,
  extreme→`cc/claude-opus-4-8`.
- **Provider/model consistency**: `glm-4.5-air` added to the zai catalog; `kimi-k2.5` and
  `MiniMax-M2.5` fallbacks repointed from bailian (which doesn't serve them) to opencodego
  (`minimax-m2.7`). New `eval/consistency-check.ts` + enforced test guard against config
  referencing models absent from a provider catalog.
- **Mode detection accuracy** (golden set): act recall 60%→100%, plan recall 87%→93%.
  Imperative verb list broadened (replace, spin up, migrate, …), bug/symptom patterns added
  (`can't upload`, `is blank`, `shows $0`, `stopped firing`), and keyword matching switched to
  stem-aware word boundaries (kills substring false positives like `explanation`/`codebase`,
  catches inflections like `weighing`/`considering`).
- **Complexity over-routing removed**: the ensemble's "escalate up one tier on low confidence"
  rule was dropped — it cut exact tier accuracy (41%→49%), nearly tripled adjacent error, and
  added a systematic +0.36-tier over-routing bias (paying for bigger models on simple prompts).
  Exact 41%→49%, ±1 83%→88%, bias +0.36→+0.12. (Boundary re-tuning was tested and rejected:
  cross-validation showed it overfit the 90-sample set without generalizing.)
- **Stale fallback boundaries** in `DEFAULT_V04_CONFIG` (used when config load fails) unified
  with the live `v04_config.json`/`intent-engine` cut points (were old `[0.1557…]` values).

### Added
- **Plan/Act router modes**: configure separate, cheaper models for planning (exploration/drafting)
  vs. acting (implementation/execution) per complexity tier
- `plan_model`, `plan_provider`, `plan_max_tokens`, `plan_enable_thinking` fields on all 6 tier configs
- Auto-detection of intent mode via keyword scoring (16 plan keywords, 11 act keywords)
- Explicit override via `body.mode` ("plan" | "act") or `X-Mode` request header
- `X-Mode` and `X-Mode-Confidence` response headers on all routed requests
- CLI commands: `mode-status` (view all tier plan/act models), `mode-set` (update plan_* config),
  `mode-detect` (test auto-detection on prompt text)
- **OpenCodeGo provider** — HTTP adapter for deepseek-v4-flash, deepseek-v4-pro, qwen3.7-plus
- **claude-opus-4-8** CLI alias in agent registry

### Changed
- **Effort ranges recalibrated** for length/structure-aware heuristic (trivial 0.00–0.21, light 0.21–0.28,
  moderate 0.28–0.32, heavy 0.32–0.37, intensive 0.37–0.46, extreme 0.46–1.00)
- trivial tier: free model → glm-4.5-air/zai
- light tier: glm-4.7/zai → deepseek-v4-flash/opencodego
- moderate tier: MiniMax-M2.5/bailian → glm-4.7/zai (act), cx/gpt-5.4-codex/codex-cli (plan)
- heavy tier: cc/claude-sonnet-4-6 → deepseek-v4-pro/opencodego (act), cx/gpt-5.5-codex/codex-cli (plan)
- intensive tier: cx/gpt-5.5-codex → glm-5.1/zai (act), cc/claude-sonnet-4-6/claude-cli (plan)
- extreme tier: cc/claude-opus-4-7 → qwen3.7-plus/opencodego (act), cc/claude-opus-4-8/claude-cli (plan)
- Unified effort ranges between `routing-matrix.ts`, `v04_config.json`, and `intent-engine-v04.ts`
- README fully rewritten with plan/act tier tables, mode commands, provider catalog

## [0.5.1-direct-routing] — 2026-05-19

### Added
- **Direct Routing Bypass** — Skip classification/RAG/fallback entirely for explicit routing
  - `body.direct_route: { provider, model }` — JSON body parameter
  - `X-Direct-Provider` / `X-Direct-Model` headers — header-based override
  - `provider/model` syntax in model field — e.g. `"cc/claude-sonnet-4-6"`, `"bailian/qwen3.5-plus"`
  - CLI providers: Claude Code (`cc/`), Codex (`cx/`), Pi (`pi/`), Hermes (`hm/`), OpenClaw (`oc/`)
- **Provider Listing Endpoint** — `GET /v1/providers` lists all HTTP + CLI providers with types, health, quota
- **Direct Chat Endpoint** — `POST /v1/direct/chat` for direct routing without agent lookup
- **CLI Provider Context Windows** — `turboquant-compressor.ts` v0.5 extension with per-CLI-provider context windows

### Changed
- Startup banner: "GateSwarm MoMA Router v0.5.1 (TurboQuant v3.6 + CLI Providers)"
- Health endpoint `router` field: "GateSwarm MoMA Router v0.5.1"
- Gateway version in `/health` response and meta objects: v0.5.1
- `resolveModel()` handles CLI prefixes (cc/, cx/, pi/, hm/, oc/) seamlessly
- CLI streaming detection: CLI providers auto-downgrade streaming requests to sync

---

## [0.5.0-cli-providers] — 2026-05-17

### Added
- **CLI Provider Adapter** — Subprocess dispatch for CLI-based coding agents
  - File: `src/adapters/cli-provider.ts`
  - Supports: Claude Code, OpenAI Codex, Pi, Hermes, OpenClaw
  - Quota tracking per provider (5-hour + weekly windows)
  - Health checks and status reporting
- **Agent Registry CLI Methods** — `resolveCliProvider()`, `registerCliProvider()`, `listCliProviders()`
- **CLI Provider Dispatch** — Gateway routes to CLI providers via subprocess spawn
  - Stdin/stdout protocol for chat completions
  - Graceful handling of CLI provider output format
- **CLI Provider Status Endpoint** — `GET /v05/cli` reports all CLI providers, their status, and quotas
- **Gateway CLI Commands** — `providers` and `direct` commands in `gateswarm-cli.ts` (v0.5.1)
  - `gateswarm providers` — list all providers with types, health, quota
  - `gateswarm direct <provider> <model> "prompt"` — direct routing test

### Changed
- Agent registry: v0.5 CLI provider methods added (Claude Code, Codex, Pi, Hermes, OpenClaw)
- Gateway: CLI provider dispatch integrated into request pipeline (line ~718)
- CLI providers auto-detected and registered on gateway startup (line ~1196)
- Streaming detection: CLI providers do not support streaming — auto-downgrade to sync
- Ensemble voter extended to support both HTTP and CLI providers
- Gateway startup log: lists all 5 CLI providers with their status

### Fixed
- `compressedMessages` declaration order with CLI provider integration
- CLI provider subprocess error handling (timeout, stderr capture)
- Quota tracking persistence across gateway restarts

---

## [0.4.4-context-aware] — 2026-05-14

### Fixed
- **RAG persistence** — RAG index now persists to JSON file (`data/rag/index.json`), survives gateway restarts. Auto-flush every 60s.
- **Feedback persistence** — Feedback store now persists to JSON file (`data/feedback/entries.json`), survives gateway restarts. Auto-flush every 60s.
- **History bias inert** — History bias was always 0 because the ensemble voter had a separate in-memory buffer that was never written to. Now wired to the persistent feedback store.
- **actualTier never populated** — Self-eval's LLM judge result now wires back to the feedback store via `updateAdequacy()`.
- **Training mode not wired** — Entire training mode system (vote requests, SILVER/BRONZE labels, calibration) was never connected to the request pipeline. Now integrated.
- **Dual RAG injection** — Removed redundant RAG retrieval from compressor; single injection point in gateway.
- **LLM judge circularity** — Judge was using same model (qwen3.5-plus) as the intensive tier. Now uses qwen3.6-plus (extreme tier) for anti-circularity.
- **enable_thinking disabled everywhere** — All tiers had reasoning off. Now enabled for heavy/intensive/extreme tiers.
- **Fallback chain skipped 5xx** — Retry loop only retried on 429/1305/1308. Now also retries on 5xx server errors.
- **Training mode `require()` in ESM** — Fixed `require('crypto')` to use ES import.

### Added
- **Context continuity anchor** — Tracks per-session summaries across model switches. When router changes models between turns, the new model gets key decisions from the previous turn.
- **Training mode HTTP endpoints** — `GET /v04/training`, `POST /v04/training/enable`, `POST /v04/training/vote`, `POST /v04/training/vote/reply`.
- **SILVER labels** — RAG consensus inference now runs on every request (when enabled) for semi-supervised learning.
- **BRONZE calibration** — LLM judge results now calibrate bronze weight against quick heuristic.

### Changed
- **Banner updated** — v0.4.4 (TurboQuant v3.6)
- **Heavy tier model** — Changed from glm-5.1/zai to qwen3.5-plus/bailian (glm-5.1 quota exhausted)
- **Extreme tier fallbacks** — Removed glm-5.1/zai fallback (same reason)

## [0.4.3-timeout-hardening] — 2026-05-14

### Fixed
- **Request timeout on upstream providers** — `fetch` calls to Bailian/ZAI had no timeout, causing indefinite hangs when providers stalled
  - `forwardToProvider()`: Added 120s `AbortSignal.timeout()` with AbortError handling → returns 504 on timeout
  - `handleChatCompletion()` retry loop: Added 120s timeout per target with proper fallback continuation
  - Streaming reader: Added 30s idle timeout between SSE chunks to prevent silent hangs
- **MoMA provider config**: Added `timeoutSeconds: 180` to prevent client-side timeout before gateway can respond

### Added
- **Auto-restart loop** in `scripts/start-gateway.sh` — exponential backoff (5s→10s→20s→60s), max 10 restarts
- **PORT parsing fix** in startup script — was broken when `--port` flag was used

## [0.4.0-self-optimizing] — 2026-05-11

### Added
- **Ensemble Voter** — Combines heuristic (40%), cascade (30%), RAG context (15%), and history bias (15%)
  - File: `src/ensemble-voter.ts`
  - Confidence-based routing: >0.8 → predicted tier, 0.5-0.8 → escalate one tier, <0.5 → intensive default
- **RAG Index** — TurboQuant compressed history as retrievable context
  - File: `src/rag-index.ts`
  - Dual persistence: in-memory + SQLite-backed
  - Keyword overlap scoring with 24h TTL
- **Self-Optimizing Feedback Loop** — Every interaction logged, periodic LLM judge, auto-retraining
  - File: `src/feedback-store.ts`, `src/self-eval.ts`, `src/retraining.ts`
  - LLM judge: `bailian/qwen3.5-plus` (10% sampling rate)
  - Hot-swap weights without gateway restart
  - A/B testing with 10% holdout
- **25-Feature Extractor** — Extended from 15 to 25 features
  - File: `src/feature-extractor-v04.ts`
  - NEW: has_negation, entity_count, code_block_size, domain detection (finance/legal/medical/engineering), temporal_references, output_format_spec, prior_context_needed, novelty_score, multi_domain, user_expertise_level
- **Reasoning Toggle** — Per-tier `enable_thinking` control
  - Config: `v04_config.json` → `tier_models[tier].enable_thinking`
  - Applied to provider payload in gateway
- **GateSwarm CLI** — 11 commands for v0.4 configuration
  - File: `src/gateswarm-cli.ts`
  - Commands: status, models, model, reasoning, retrain-freq, weights, feedback, rag, retrain
- **Cascade Retraining on Real Labels** — v3.2 cascade retrained on feedback data (not formula)
  - File: `scripts/cascade-retrain.py`
  - Uses LLM-judged ground truth from feedback buffer
- **v0.4 HTTP Endpoints** — `/v04/status`, `/v04/feedback`, `/v04/retrain`
  - Integrated into gateway request handler
- **Config Manager** — Centralized v0.4 configuration with hot-reload
  - File: `src/v04-config.ts`
  - User-configurable: tier models, reasoning toggle, retrain frequency, ensemble weights

### Changed
- Intent engine: `heuristicScore()` → `scoreIntentV04()` (ensemble-based)
- Provider payload: includes `enable_thinking` from tier model config
- Gateway startup banner: "GateSwarm MoMA Router v0.4"
- Health check: reports ensemble, feedback, llmJudge status

### Fixed
- Gateway `compressedMessages` crash bug (declared before RAG injection)
- Intent-engine boundary mismatch (code synced with weights.json)
- Version labels: all updated to v0.4

