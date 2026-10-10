# GateSwarm Quota Sync

Feeds real(ish) per-provider usage into GateSwarm's quota bands and health scoring.

```
[consumption-history.json / CLI session files]
            │
            ▼
   scripts/quota-sync.py ──>  data/quota-sync.json
                                      │  (gateway re-reads every 5 min,
                                      ▼   GATESWARM_QUOTA_SYNC_RELOAD_MS)
                      quota bands + provider health + /v05/intel/quota
```

## Data sources

| Provider | Source | Notes |
|---|---|---|
| **zai** | `data/consumption-history.json` | Token sums over 5h / 7d / 30d. `usedPct` only when a plan limit is configured |
| **bailian** | `data/consumption-history.json` | Same; the Token Plan is metered monthly, so configure the 30d limit |
| **codex-cli** | `~/.codex/sessions/*.jsonl` | Tokens per window; `usedPct` is `null` (plan limit unknown — use `/status` in the CLI) |
| **claude-cli** | `~/.claude/sessions/` | Same |

Unknown limits are reported as `usedPct: null`, never `0`, so "unknown" is not mistaken for "idle".

## Plan limits (configure for your own subscription)

Plan limits differ per subscription tier and are **not** hard-coded. Optional environment variables (tokens):

```
GATESWARM_QUOTA_ZAI_5H_TOKENS   GATESWARM_QUOTA_ZAI_7D_TOKENS
GATESWARM_QUOTA_BAILIAN_30D_TOKENS
GATESWARM_BAILIAN_CYCLE_START_DAY   # day of month (1-28) your Token Plan cycle renews; enables the monthly-pace overlay
```

Z.AI meters *credits* (weighted by model), so a token limit is only a rough proxy; the circuit breaker
(error 1308) is the authoritative signal.

## Running it

```bash
python3 scripts/quota-sync.py          # one-off sync
```

Periodic sync (every 5 minutes) with cron:

```
*/5 * * * * cd /path/to/gateswarm && python3 scripts/quota-sync.py >> /tmp/quota-sync.log 2>&1
```

No cron available? A loop works too: `while true; do python3 scripts/quota-sync.py; sleep 300; done`.

## Related runtime protections (in the gateway)

- **Circuit breaker** — a `1308` (Z.AI) or `insufficient_quota` response opens a per-provider breaker until the reset time in the
  error (clamped; unknown resets are re-probed after 1 h). Visible in `/health` under `quotaBreakers`.
- **Concurrency semaphores** — `GATESWARM_CONCURRENCY_<PROVIDER>` (defaults: claude-cli 2, codex-cli 2, zai 3, ollama 1;
  `bailian` unlimited until set). Visible in `/health` under `concurrency`.
- **Per-provider bands** — see `docs/QUOTA_BAND_MATRIX.md` and `calibration/matrix-variants/quota_band_matrices.json`.

## Adding a new provider

1. Add a scraper in `scripts/quota-sync.py` (or call `scrape_from_history("myprovider", {...limits})`) and list it in `main()`.
2. Add its quota config in `src/provider-quota.ts` (`MULTI_WINDOW_QUOTAS`, `PROVIDER_QUOTA_CONFIGS`).
