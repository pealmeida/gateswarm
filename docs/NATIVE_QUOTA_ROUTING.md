# Native quota routing, modality routing and deterministic handlers

All of this lives inside the gateway process. Every flag defaults to **off**; every failure is **fail-open** (the static chain / normal LLM routing is used).

| Flag | Values | Default | Effect |
|---|---|---|---|
| `GATESWARM_DYNAMIC_ROUTING` | off / shadow / on | off | per-request re-order/filter of the tier chain by quota state |
| `GATESWARM_MODALITY_ROUTING` | off / shadow / on | off | route image/audio (video/3D) outputs to capable providers |
| `GATESWARM_DETERMINISTIC_ROUTING` | off / shadow / on | off | answer matched requests with local deterministic handlers (no LLM) |
| `GATESWARM_QUOTA_REFRESH_MS` | ms | 60000 | internal refresh timer for quota state (reads `data/quota-sync.json`) |
| `GATESWARM_QUOTA_COLLECT` | on / off | off | also run the CodexBar collector in-process (otherwise use `scripts/quota-manager-supervisor.sh`) |
| `GATESWARM_OPTIMIZER_MS` | ms | 1800000 | period of the tier_models proposal |
| `GATESWARM_MODEL_CAPABILITY` | JSON `{regex: 1..5}` | – | override the capability table |
| `GATESWARM_MODALITY_REGISTRY_FILE` | path | – | extra capability entries (JSON array) |

`shadow` computes and logs, never changes the response. `on` applies.

## 1. Dynamic chain (`src/quota-manager/dynamic-router.ts`, `native.ts`)

Per request, the chain `[primary, ...fallbacks]` is scored (lower = better) from: static position, quota band, idle headroom bonus, projected exhaustion before reset, learned %-per-request vs headroom, gateway error rate / p50 latency (rolling 5 h), and a Jev "reduce_load" vote.

Rules enforced in code (and tests):
* **Capability floor** per tier (`MIN_CAPABILITY`: moderate 2, heavy 3, intensive/extreme 4). Candidates below it are dropped; if none qualify the static chain is kept. A tier is never served below its floor.
* **High risk** (auth/migration/secrets/production flags from `detectFlags`): the static strong primary is kept unless it is breaker-open or red; no exploration.
* **Jev only hardens**: a `reduce_load` stance adds a penalty; there is no input through which Jev can make a provider *more* attractive.
* **Hysteresis**: the previous primary is kept unless a rival wins by 15 points and the 2-minute dwell elapsed (red / breaker / exhaustion switch immediately).
* **Exploration floor**: every 25th request per tier, an unmeasured/stale/idle green candidate is promoted so its measurements stay fresh (counter, not random).
* **Breaker-open** providers go to the tail (still listed so the gateway reports them as skipped).
* Skipped for plan mode and vision/audio requests.

Explanation: `X-Routing-Reason` gets `dyn[mode]: <reasons>` appended; `data/dynamic-routing.jsonl` logs tier, static vs dynamic chain, reasons, latency (µs) — **no prompt text**. Changed decisions are always logged, unchanged ones 1 in 20.

Calibration: each refresh attributes requests seen since the last refresh to the provider's usage delta; when a window moved ≥ 2 points (providers report whole percents) a `source: "live"` record is appended to `data/quota-calibration.jsonl`. `costOf(provider, tier)` reads it (≥ 3 requests).

Optimizer: `optimize()` runs periodically, writes `data/quota-manager/optimizer-proposal.json` (diff of `tier_models`, `applied:false`) and is shown in `/v1/quota-manager`. **Never applied automatically.**

Exposure: `/health` → `dynamicRouting` (mode, state age, decisions, avg latency µs); `GET /v1/quota-manager` → `native` + `optimizer`.

## 2. Which layers are deterministic (no LLM)

| Layer | Implementation | Jev role |
|---|---|---|
| Chain choice / re-order | scoring table above | `reduce_load` vote may only add penalty |
| Provider error classification | `classifyQuotaExhaustion` / `localErrorClass` (status+code tables) → circuit breaker | classification is computed locally first; Jev (advise) is logged, never softens |
| Exhaustion forecast | linear projection of used % at reset (`projectedPctAtReset`) | none |
| Minimum capability per tier | regex table + floors | none (override only by operator env) |
| Bands | threshold table per provider | none |
| Modality/intent detection | explicit fields + conservative leading-imperative regexes | none |
| Capability registry / planner | table lookup + quota gate | none |
| Deterministic handlers | `math` (own parser, no `eval`), `json-format`, pluggable | none |

The local rule always decides first. Jev (when `GATESWARM_JEV_DECISIONS` is advise/enforce) can only tighten.

## 3. Modality and deterministic routing (`src/modality/`)

Detection (no LLM, no network): explicit `modality` / `output_type` / `output_modality` / `modalities` (OpenAI style) / header `x-output-type`; `deterministic: {handler,input}` or header `x-deterministic`. Heuristics only for a **leading** imperative ("generate an image of …", "gere uma imagem de …", "tts: …") or a prompt that is entirely an arithmetic expression (dates and bare numbers are excluded).

Capability registry: built-ins are the Bailian Token Plan models reported by the operator — `wan2.7-image` (text→image), `qwen-audio-3.0-tts` (text→audio), `qwen-audio-3.0-realtime` (registered only, no executor) — marked `source: builtin-reported` (**not probed by GateSwarm**; request shape assumed OpenAI-compatible `/images/generations`, `/audio/speech`). Add more via `GATESWARM_MODALITY_REGISTRY_FILE`. An entry is active only if its provider is configured here. **Video and 3D have no built-in provider**: requests return `422 modality_no_provider` ("sem provedor ativo") — nothing is emulated.

Plan outcomes: `llm` | `deterministic` | `multimodal` | error (`422 no_provider`, `501 no_executor`, `429 quota_exhausted`, `422 no_deterministic_handler`). Quota: providers in red band or breaker-open are skipped; the rest are ordered by band. Outcomes feed `nativeQuota.observe` so the manager sees the usage.

`GET /v1/modality` lists modes, per-output status (`active` / `no_active_provider`) and handlers. Shadow adds `X-Modality-Shadow`; live adds `X-Modality-Route`. Log: `data/modality-routing.jsonl` (no prompt).

Responses are chat-completion shaped; generated media is in `gateswarm.data` (URL or base64).

## 4. Promote / rollback

1. `shadow` → watch `data/dynamic-routing.jsonl` / `modality-routing.jsonl` and `/health` for a few batteries (check reasons, flapping, `avgLatencyUs`).
2. Flip one flag to `on` in the start script and restart. Promote `GATESWARM_DYNAMIC_ROUTING` first; modality/deterministic are independent.
3. Rollback: set the flag to `off` (or remove it) and restart. No data migration; logs/proposals can be deleted.
