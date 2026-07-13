# GateSwarm Quota Sync (v0.1.0)

The "CodexBar" pattern — scrapes real quota data from provider dashboards/CLIs
and feeds it into the GateSwarm TUI.

## How it works

```
[Provider CLI/API]  ──>  [quota-sync.py]  ──>  [data/quota-sync.json]
                                                          │
                                                          ▼
                                              [Gateway /v05/intel/sync]
                                                          │
                                                          ▼
                                                  [gateswarm-bar TUI]
```

## Data sources

| Provider | Source | Method |
|---|---|---|
| **opencodego** | `consumption-history.json` | Token sums from 5h/7d/30d hourly buckets |
| **zai** | `consumption-history.json` | Token sums from 5h/7d/30d hourly buckets |
| **ollama-cloud** | `consumption-history.json` | Token sums from 5h/7d/30d hourly buckets |
| **codex-cli** | `~/.codex/sessions/*.jsonl` | Parse token counts per session file |
| **claude-cli** | `~/.claude/sessions/` | Parse token counts per session file |

## Usage

```bash
# Manual sync
python3 $(dirname "$0")/quota-sync.py

# Schedule this command with your preferred job runner if periodic sync is needed.

# View in TUI
gateswarm-bar
```

## TUI indicators

- `[real data]` — synced quota data available
- `✓` next to a row — that window's data is from real dashboard scrape
- `N/A` — no data available for that window

## Adding a new provider

1. Add a scraper function in `scripts/quota-sync.py`:
   ```python
   def scrape_myprovider():
       return {
           "provider": "myprovider",
           "syncedAt": ...,
           "source": "...",
           "windows": { "5h": {...}, "7d": {...}, "30d": {...} }
       }
   ```

2. Add to the scrapers list in `main()`.

3. Add the quota config in `src/provider-quota.ts` `MULTI_WINDOW_QUOTAS`.

## Limitations

- Codex/Claude session files only contain data after installation — older sessions return 0
- Some providers (ZAI, OpenCode Go) don't expose quota APIs; we use GateSwarm's tracked usage
- For true real-time sync, would need to scrape the web dashboards (requires browser automation + auth)
