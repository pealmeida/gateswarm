# Quota manager

Keeps a live, honest picture of every provider's quota and wraps execution batteries with a snapshot → short-interval
collection → final snapshot → report cycle. Between batteries, `survey` refreshes the measurements and calibrates how many
percentage points a request costs.

## Sources per provider (method + confidence)

Every provider state records `method` and `confidence`:
`measured` = reported by the provider (via CodexBar `--source cli|api`), `estimated` = gateway consumption vs limits you configured, `unknown` = neither. Unknown is never shown as 0.

| Provider | Best source | Fallback | If it is missing |
|---|---|---|---|
| claude-cli (Pro/Max) | CodexBar `--source cli` (5h + weekly %, reset, plan) | none (unknown) | install CodexBar, logged-in `claude` CLI |
| codex-cli (Plus/Pro) | CodexBar `--source cli` (codex app-server) | none | install CodexBar, logged-in `codex` CLI |
| zai | CodexBar `--source api` when `Z_AI_API_KEY` is in the collector's env | gateway tokens vs `GATESWARM_QUOTA_ZAI_5H_TOKENS` / `_7D_TOKENS` → *estimated* | key or limits |
| bailian (Token Plan) | CodexBar `alibaba-token-plan` when `GATESWARM_CODEXBAR_BAILIAN=1` (needs the `bl` CLI login) | gateway tokens vs `GATESWARM_QUOTA_BAILIAN_30D_TOKENS` (+ `GATESWARM_BAILIAN_CYCLE_START_DAY`) → *estimated* | `bl` login or limits |
| ollama (local) | none needed: unmetered, request counts only | – | – |

Not implemented: reading provider rate-limit response headers (the gateway does not persist them yet) — the circuit breaker (1308 / `insufficient_quota`) remains the authoritative "exhausted" signal and is exposed in the API.

Data older than 15 min (`GATESWARM_QUOTA_MAX_AGE_MIN`) or past its reset time is *unknown*. `src/quota-sync.ts` applies the same rule, so bands and routing never trust old numbers.

## CodexBar (third-party, MIT)

`scripts/install-codexbar.sh` downloads the pinned release (v0.73.0, SHA256 `a84f556c…10f9611`, verified before extraction) **outside the repo** (`~/.local/share/gateswarm/codexbar`). Point `GATESWARM_CODEXBAR_BIN` at the `codexbar` binary. Only `--source cli` (Claude/Codex) and `--source api` (Z.AI) are used; the collector keeps no account ids or e-mails and never prints keys. Each Claude collection opens a short CLI session (~30 s) and spends a little quota, so it is throttled (below).

## Commands

```
npx tsx scripts/quota-manager.ts status [--json]        # live view, no collection
npx tsx scripts/quota-manager.ts survey [--no-jev]      # collect all + recompute + quota-analyze (Jev advise) + calibration
npx tsx scripts/quota-manager.ts battery start <name> [--need claude-cli,zai] [--requests zai=200,codex-cli=40] [--strict] [--force]
npx tsx scripts/quota-manager.ts battery end            # final snapshot + report + calibration
npx tsx scripts/quota-manager.ts calibration [--last 20]
scripts/quota-manager-supervisor.sh start|stop|status   # background loop (no crontab)
scripts/with-quota-battery.sh <name> [opts] -- <command...>   # wrapper for any battery
```

`GET /v1/quota-manager` on the gateway returns the live state (per provider: band, confidence, method, headroom, resets, projection, what is missing), the active battery, the last survey with the Jev analysis summary, and the providers whose circuit breaker is open. `GET /v1/quota-analysis` remains the full analysis.

### Battery mode
* `battery start`: snapshot, **pre-check** (red/orange, unknown, estimated, projected exhaustion, estimated cost vs headroom using calibration) → warnings and proposals (reduce load / move tiers to a provider with headroom). It never blocks unless `--strict` (exit 3).
* While active, the supervisor collects every `GATESWARM_QUOTA_BATTERY_INTERVAL_SEC` (180 s); Claude at most every `GATESWARM_QUOTA_CLAUDE_MIN_INTERVAL_MIN` (6 min). Idle: every `GATESWARM_QUOTA_IDLE_INTERVAL_SEC` (600 s, also the Claude interval, so data never exceeds the 15 min limit).
* `battery end`: final snapshot; report in `data/quota-manager/reports/<name>-<ts>.{md,json}` with Δ% per provider/window, requests/tokens (gateway totals), %/request, headroom and "batteries left". Windows that reset mid-battery are flagged `reset`, not diffed. Deltas under 2 points are marked `~` (providers report whole percents).

### Between batteries
`survey` updates `data/quota-manager-state.json`, runs the analysis (Jev only when `GATESWARM_JEV_MODE=shadow` + `GATESWARM_JEV_DECISIONS=advise`), and appends `data/quota-calibration.jsonl` (requests, tokens, Δ%, %/request, tiers served by that provider) since the previous baseline. Nothing is applied to routing automatically.

### Integrating batteries
Wrap the runner: `scripts/with-quota-battery.sh publimatch-prod --need claude-cli,codex-cli,bailian -- ./your-battery.sh`. The same works for `scripts/benchmarks/collect.sh`.

## Data files (all under `data/`, git-ignored, no secrets)
`quota-sync.json`, `quota-manager-state.json`, `quota-manager-battery.json`, `quota-manager.interval`, `quota-calibration.jsonl`, `quota-manager/reports/`.

## Rollback
Stop the supervisor, remove the new data files, revert the PR. The gateway start script is not modified.
