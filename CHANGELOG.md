# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.6-routing-fix] - 2026-06-20

### Fixed
- **Tier routing primaries purged of dead providers**: Bailian API key expired (HTTP 401) and OpenCodeGo hit `GoUsageLimitError` (14d reset). Re-routed all six tiers to currently-healthy providers only — zai for moderate/heavy, codex-cli for intensive/extreme, ollama for trivial/light. `v04_config.json` rewritten with no bailian or opencodego references in any tier.
- **LLM judge silently no-oping**: `self-eval.ts` hardcoded the judge provider to `bailian`; with bailian down, the judge was returning `adequacy: -1` for every request. Now config-driven (`config.feedback_loop.llmJudgeModel`), defaulting to `zai/glm-4.7`.
- **`/health` banner reported stale version**: hardcoded `'bailian/qwen3.5-plus'` for the `llmJudge` field. Now reads `getConfig().feedback_loop.llmJudgeModel` at request time.
- **Provider health-score poisoning**: `recordSuccess()` never decayed `rateLimitHits`, so a single batch of 429s from quota-sync probes tanked `zai` health to 0 (penalty `20 × 15 = -300`). Now decays by 1 per success.
- **RAG signal pollution**: `RagEntry.tier` is overloaded between effort tiers (`moderate`/`heavy`/...) and compressor quality tiers (`Q0`/`Q1`/`Q2`). The intent engine treated both the same, so 9 cached "Hello, how can I help" RAG entries biased every score by +0.075. RAG now filters `Q*` entries before computing the signal. Index cleaned: 21 → 12 entries.
- **TUI showed only static tier recommendations, not the actual last request decision**: `TiersMatrix.tsx` now shows a `★ LAST REQUEST →` header with the tier/provider/model of the most recent `request`-source decision, plus a `►` marker on the active row.
- **Codex CLI / Claude CLI health checks were lies**: `codex --version` / `claude --version` pass without auth. Replaced with `bin/cli-health-probe.sh` which verifies binary + auth (OPENAI_API_KEY / ChatGPT OAuth via `~/.codex/auth.json` / `~/.claude/.credentials.json`). Both CLIs are correctly authenticated (verified: codex exec gpt-5.4 returns "pong" in 8s; Claude has OAuth credentials).
- **Hardcoded absolute paths in source**: `src/agent-registry.ts` had `/root/.openclaw/workspace/gateswarm-moma-router/scripts/cli-health-probe.sh` (4 occurrences) — would break for any non-default install. Replaced with portable `"${GATESWARM_ROOT:-.}"/bin/cli-health-probe.sh <agent>`. The systemd unit now exports `GATESWARM_ROOT`; the script auto-resolves its own location for local dev. A new `bin/` directory is shipped alongside `scripts/`.
- **Pi status bar showed `(moa)` instead of `(moma)`**: `defaultProvider` in `~/.pi/agent/settings.json` was `"moa"`. Renamed to `"moma"` (also in `models.json`). Pi must be restarted to pick up the new label.
- **Ephemeral runtime state was tracked in git**: `data/consumption-history.json`, `data/provider-quota.json`, `data/quota-sync.json`, `data/model-matrix.json` were all tracked but contain operational state regenerated on every gateway start. Now gitignored + untracked via `git rm --cached`. The gateway regenerates them on first run.

### Added
- **`bin/cli-health-probe.sh`** — auth-aware health probe for codex-cli, claude-cli, pi-agent, hermes-agent. Auto-locates the router root via `$BASH_SOURCE`; honors `GATESWARM_ROOT` env override; falls back to PATH lookup.
- **`scripts/cli-health-probe.sh`** — canonical source (the `bin/` copy is identical).
- **`docs/OPS_GUIDE.md`** — 25KB operations guide covering updates, debugging, analysis, versioning, and emergency procedures.
- **`docs/SECURITY_AUDIT.md`** — pre-release security audit documenting what was checked and what was fixed.
- **`gateswarm ops-guide`** CLI command — prints the full ops guide via `GET /v05/intel/ops-guide`.
- **`gateswarm health`** CLI command — 11-point health check (service, 4 HTTP providers, 5 CLI providers, last request decision).
- **`gateswarm version`** CLI command — verifies all 7 version stamps are aligned across files.
- **`GET /v05/intel/ops-guide`** endpoint — serves the ops guide over HTTP.
- **`GET /v05/intel/last-decision`** endpoint — returns the most recent `request`-source decision (filtered; no health-check noise).
- **`getRecentDecisions(limit, source?)`** — supports filtering by source for cleaner TUI consumption.

### Changed
- **`v04_config.json` version**: `v0.5.1-cli-providers` → `v0.5.6-routing-fix` (adds `_note` documenting the provider health situation).
- **Tier primaries (all tiers)**:
  - trivial: ollama/qwen2.5:0.5b (unchanged)
  - light: zai/glm-4.7-flash (unchanged)
  - **moderate**: zai/glm-5 (was bailian/MiniMax-M2.5)
  - **heavy**: zai/glm-5.1 (was bailian/qwen3.5-plus)
  - intensive: codex-cli/cx/gpt-5.4-codex (unchanged, verified working)
  - extreme: codex-cli/cx/gpt-5.4-codex (unchanged, verified working)
- **CLI TUI version**: 0.5.4 → 0.5.6 across all `cli/src/*` file headers
- **`/usr/local/bin/gateswarm` wrapper**: v0.6.1 (lying) → v0.5.6
- **Pi `~/.pi/agent/models.json`**: gateswarm model name "v0.6.0 Sieve" (lying) → "v0.5.6"
- **Pi `~/.pi/agent/settings.json`**: `defaultProvider` `"moa"` → `"moma"`; `retry.provider.timeoutMs` 60000 → 240000 (codex-cli needs 100-150s)
- **systemd unit Description**: v0.5.5 → v0.5.6

### Known issues / user blockers
- **Rotate Bailian API key**: `BAILIAN_KEY=*** expired (HTTP 401)`. Once rotated, set the new key in `.env` and restart the gateway. Until then, `bailian` is treated as unhealthy and zai is the moderate/heavy primary (works fine).
- **OpenCodeGo quota resets in 14 days** (from 2026-06-20). After reset, restore opencodego models (qwen3.7-plus, qwen3.7-max, deepseek-v4-pro) as intensive/extreme fallbacks.
- **`npm audit` not run in this release cycle** — recommend running before next bump.

## [0.5.6] - 2026-06-17

### Fixed
- **Version banner drift**: gateway startup banner, `/health` `router` field, and listening log line all still reported `v0.5.5` even though `package.json` and the source code were on `v0.5.6` (routing transparency fixes). Now consistent at v0.5.6 across banner, `/health`, and file-header. Service banner now reads "Routing Transparency" instead of "Quota-Aware Routing".
- **Intel/persistence schema versions stuck at 0.5.4**: `/v05/intel` reported `version: "0.5.4"`, and `consumption-history.json`, `provider-quota.json`, `model-matrix.json` all initialized `version: "0.5.4"`. Bumped all to `0.5.6` to match the running gateway. (These track the gateway schema, so they should match.)
- **Pi statusline showed v0.5.1** (compiled bundle had v0.5.5 cached): the extension read its own hardcoded `config.version`, which drifted from the gateway. Now fetches `/health` at startup and uses the live gateway version; hardcoded fallback only if gateway is unreachable. Also updated `gateswarm-command` slash-command menu labels (removed stale `(v0.5.1)` / `(v0.5.3)` / `(v0.5.4)` annotations).

### Added
- `liveGatewayVersion()` helper in `pi-v33-statusline/index.ts` — fetches `http://localhost:8900/health`, parses `router` field for `vX.Y.Z`, caches result. Used by both statusline code paths (footer + update notification).

## [0.5.5] - 2026-06-14

### Fixed
- **Greeting fast-path respects client stream flag** — previously forced `stream:false` regardless of client intent, breaking SSE clients (Pi, Open WebUI).
- **Latency thresholds** and **quota-sync format alignment** with downstream consumers.

### Added
- **Self-healing tier rebalancing with feedback loop** — automatic tier adjustments based on real-world performance signals.
- **Quota-aware routing** — pre-flight health checks, greeting fallback, real dashboard sync.

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


## [0.5.6] - 2026-06-16

### Fixed
- **Duplicate `scoreToEffort` removed.** `routing-matrix.ts` carried a hardcoded copy
  with stale cut-points (0.1557, 0.1842, 0.2788, 0.3488, 0.4611) that disagreed with
  the canonical, config-driven version in `intent-engine.ts` (0.21, 0.28, 0.32, 0.37, 0.46)
  and with `v04_config.json:tier_boundaries`. Same prompt could score as `light` in one
  module and `moderate` in another. `routing-matrix.ts:scoreToEffort` now re-exports
  the canonical version; the constants are dead code.
- **ActivityPanel polluted by health-check decisions.** `consumptionIntelligence.selectModel`
  is called from three background paths (tier balance check, recovery check, tier-recommendation
  refresh) in addition to real request routing. Those background decisions showed up in the
  ActivityPanel as if a user prompt had been routed to that tier — e.g. the live feed
  showing `EXTREME → codex-cli` after a "Quanto é 2+2?" prompt that was actually classified
  as `trivial` and routed to `qwen2.5:0.5b`. The TUI now filters health/balance/recovery
  sources out of the live feed and shows how many were hidden.

### Added
- **`ConsumptionDecision.source` field** — `'request' | 'health-check' | 'balance-check' | 'recovery-check'`.
  `getTierRecommendations()` and the `/v05/intel/balance` endpoint now mark their decisions
  explicitly. Real request decisions keep `source: 'request'`.
- **Debug response headers** on `/v1/chat/completions`:
  - `X-Tier` — the classified effort level
  - `X-Score` — the 0–1 complexity score
  - `X-Routed-Model` — the final provider/model that answered (after fallbacks)
  - `X-Routed-Tier` — same as `X-Tier` (for symmetry with `X-Routed-Model`)
  - `X-Routing-Method` — the `source` of the decision
  - `X-Routing-Reason` — why this provider/model was chosen (`cheapest_available`, `consumption_balanced`, `static_fallback`, …)
- **CLI type alignment** — `TierRecommendation` in `cli/src/types.ts` now exposes the new
  `source` and `timestamp` fields.
