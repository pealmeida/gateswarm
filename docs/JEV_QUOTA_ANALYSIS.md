# Jev quota analysis layer

Report-only layer that reads local quota data and proposes how to redistribute tiers between providers to use idle quota
(for example credit-style plans) and protect scarce quota (subscription CLIs, 5h-window plans). **Nothing is applied automatically.**

## Inputs (plain files under `data/`, all optional)
`quota-sync.json`, `provider-quota.json`, `consumption-history.json`, `provider-health.json`, plus the tier config
(`GATESWARM_CONFIG_FILE` or `v04_config.json`). Optional plan limits (tokens per window) via `GATESWARM_QUOTA_LIMITS_FILE`
(`{"<provider>": {"5h": n, "7d": n, "30d": n}}`) and `GATESWARM_BAILIAN_CYCLE_START_DAY` for monthly pace. Do not commit these.

## Decision model
1. The **local rule** decides first (stance per provider: `increase_load` / `hold` / `reduce_load`; moves for tiers).
2. **Jev** (`GATESWARM_JEV_MODE=shadow` + `GATESWARM_JEV_DECISIONS=advise|enforce`, default off) receives only aggregated metrics
   (percentages, pace, rates, band, provider class) and may only **harden**: raise a provider's stance toward `reduce_load`, or veto a move.
3. The report carries both `diffLocal` and `diffJev`. Timeout 800 ms, fail-open, no prompt text, no keys, no hosts.

## Use
```
npx tsx scripts/quota-analyze.ts [--json] [--no-jev] [--out report.json] [--loop <minutes>] [--config <v04_config.json>]
GET /v1/quota-analysis[?jev=0]     # cached 120 s; report + proposed diff, never applied
```
Logs: `data/jev-shadow/jev-quota-analysis.jsonl` (override `GATESWARM_JEV_QUOTA_ANALYSIS_LOG`), `jev-quota-advisor.jsonl` for the per-request advisor.

## Gateway hooks (advise only)
With decisions on, the gateway logs (never awaited, never changes routing) the local-vs-Jev downgrade opinion per request
and the local-vs-Jev error classification after each upstream failure. `enforce` is **not** wired into the request path.
