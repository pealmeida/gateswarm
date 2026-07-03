# GateSwarm v0.5.4 — Test Commands

A complete, copy-paste-ready reference for testing GateSwarm v0.5.4 on
**Pi (chat interface)**, **terminal (interactive)**, and **CI/scripts**.

> **Quick health check** — if these 4 commands work, you're set:
> ```bash
> gateswarm intel          # v0.5.3 token consumption intel
> gateswarm consumption    # per-provider 5h/weekly/monthly
> gateswarm tui --once     # one-shot JSON dump of the TUI
> pi /gateswarm intel      # from inside Pi chat
> ```

---

## 1. Service health

```bash
# Service status
systemctl status moma-gateway

# Restart if needed
systemctl restart moma-gateway
sleep 4
systemctl is-active moma-gateway

# Hit a few endpoints directly
curl -s http://localhost:8900/v05/intel | python3 -m json.tool | head -10
curl -s http://localhost:8900/v05/intel/consumption | python3 -m json.tool | head -10
curl -s http://localhost:8900/v05/intel/quota | python3 -m json.tool | head -10

# TUI JSON dump
node $(dirname $(readlink -f "$0"))/../cli/dist/cli.js --once | python3 -m json.tool | head -20
```

---

## 2. `gateswarm` CLI — the canonical entry point

```bash
# Help (lists every command)
gateswarm --help
gateswarm help

# ── v0.5.3 Consumption Intelligence (new) ──────────────────
gateswarm intel                                      # tier recommendations + provider stats
gateswarm consumption                                # per-provider 5h/weekly/monthly + quota
gateswarm consumption 5h                             # just the 5h window
gateswarm consumption weekly                         # just the weekly window
gateswarm consumption monthly                        # just the monthly window
gateswarm quota                                      # RPM/RPD/tokens/throttled
gateswarm rediscover                                 # force immediate model rediscovery

# ── v0.5.4 TUI client (new) ───────────────────────────────
gateswarm tui                                        # launch TUI (interactive, needs TTY)
gateswarm tui --refresh 5                            # 5s refresh interval
gateswarm tui --tab providers                        # start on providers tab
gateswarm tui --once                                 # one-shot JSON dump
gateswarm tui --once | jq '.consumption.totalProviders'   # scriptable
gateswarm tui --mock --once                          # no server needed

# Direct binary (no shell wrapper)
gateswarm-tui --once                                 # same as `gateswarm tui --once`
gateswarm-tui --refresh 2                            # 2s refresh

# ── Existing v0.5.1/v0.5.2 commands (still work) ────────
gateswarm status
gateswarm models
gateswarm model intensive kimi-k2-thinking ollama-cloud
gateswarm reasoning extreme on
gateswarm reasoning
gateswarm weights
gateswarm weights heuristic 0.45
gateswarm retrain-freq
gateswarm retrain-freq 200
gateswarm feedback
gateswarm rag
gateswarm retrain
gateswarm providers
gateswarm training
gateswarm direct claude-cli cc/claude-sonnet-4-6 "What is 2+2?"
gateswarm mode-status
gateswarm mode-detect "draft an architecture plan for the new service"
```

---

## 3. Inside Pi (chat agent)

Pi's `/gateswarm` slash command runs the CLI and shows the output in chat.

```text
/gateswarm                       # = gateswarm status
/gateswarm intel                 # v0.5.3 tier recommendations
/gateswarm consumption           # per-provider 5h/weekly/monthly
/gateswarm consumption weekly    # just weekly
/gateswarm quota                 # RPM/RPD/tokens
/gateswarm tui                   # auto-falls-back to --once in chat
/gateswarm tui --once            # explicit JSON dump
/gateswarm rediscover            # force model rediscovery
/gateswarm providers             # list all providers
/gateswarm models                # tier → model mappings
/gateswarm feedback
/gateswarm rag
/gateswarm weights
/gateswarm reasoning extreme on
```

> **Tab completion** is registered for all v0.5.3/v0.5.4 subcommands:
> type `/gateswarm <Tab>` to see the full list, or `/gateswarm consumption <Tab>`
> to see `5h | weekly | monthly`.

To re-load tab completions after an extension edit, restart Pi:
```bash
# Pi will pick up changes on next start
pkill -f "pi-coding-agent" 2>/dev/null || true
```

---

## 4. Direct TUI launch (terminal)

The TUI is a full-screen terminal UI. Launch it in any real terminal:

```bash
# Full interactive TUI
gateswarm tui
gateswarm-tui

# In a remote SSH session
ssh user@host "gateswarm-tui"

# With custom refresh
gateswarm-tui --refresh 2

# Start on a specific tab
gateswarm-tui --tab providers
gateswarm-tui --tab tiers
gateswarm-tui --tab activity

# Try it without a server (uses built-in mock data)
gateswarm-tui --mock
```

### Keyboard shortcuts inside the TUI

| Key | Action |
|---|---|
| `1` | Overview tab (default) |
| `2` | Providers tab |
| `3` | Tiers tab |
| `4` | Activity tab |
| `r` | Force refresh now |
| `q` / `Esc` / `Ctrl+C` | Quit |

### Sample session

```bash
$ gateswarm-tui
# …TUI renders all 5 panels: Header, Providers, Models, Tiers Matrix, Router Config, Activity…
# Press `2` to switch to Providers tab
# Press `r` to refresh
# Press `q` to quit
```

---

## 5. Scripting & CI

The `--once` flag dumps the full TUI report as JSON to stdout. Perfect for
shell pipelines, monitoring, and CI.

```bash
# One-shot JSON
gateswarm tui --once
gateswarm-tui --once

# Pretty-print
gateswarm tui --once | jq '.'

# Specific values
gateswarm tui --once | jq '.consumption.totalProviders'           # → 4
gateswarm tui --once | jq '.consumption.totalFiveHour.totalTokens' # → 7557
gateswarm tui --once | jq '.intel.stats.totalModels'              # → 412

# Loop a watch every 30s
while true; do
  echo "=== $(date) ==="
  gateswarm tui --once | jq '{
    providers: .consumption.totalProviders,
    reqs_5h:   .consumption.totalFiveHour.requests,
    tokens_5h: .consumption.totalFiveHour.totalTokens,
    errs:      .intel.stats.totalErrors,
    cost:      .intel.stats.estimatedCost
  }'
  sleep 30
done

# Alert when quota > 80% on any provider
gateswarm tui --once | jq -r '
  .consumption.providers[]
  | select(.quota.fiveHour.usedPctRequests != null and .quota.fiveHour.usedPctRequests > 80)
  | "⚠  \(.provider) at \(.quota.fiveHour.usedPctRequests)% of 5h quota"
'

# Cron: dump daily snapshot
echo "$(date -I),$(gateswarm tui --once | jq -c .)" >> /var/log/gateswarm-daily.jsonl
```

---

## 6. Troubleshooting

```bash
# Service not running
systemctl status moma-gateway
journalctl -u moma-gateway --no-pager -n 30

# Server unreachable from CLI
curl -s http://localhost:8900/v05/intel/health  # check endpoint
GATESWARM_URL=http://localhost:8900 gateswarm intel   # explicit URL

# TUI not rendering / Raw mode error
# → You're in a non-TTY context. Use --once or a real terminal.
gateswarm tui --once                   # non-TTY fallback
script -qfc "gateswarm tui" /tmp/out   # wrap in PTY

# Build the CLI if dist/ is missing
cd $(dirname $(readlink -f "$0"))/../cli
npm install && npm run build

# Re-link the global `gateswarm` and `gateswarm-tui` binaries
cd $(dirname $(readlink -f "$0"))/../cli
npm link
# Or manually:
ln -sf $(dirname $(readlink -f "$0"))/../cli/dist/cli.js /usr/local/bin/gateswarm-tui
chmod +x /usr/local/bin/gateswarm-tui
```

---

## 7. The full pipeline at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  User input                                                        │
│  ├─ Terminal:  gateswarm intel / gateswarm tui / gateswarm-tui     │
│  ├─ Pi chat:   /gateswarm intel / /gateswarm tui /gateswarm ...    │
│  └─ Script:    gateswarm tui --once | jq .                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  /usr/local/bin/gateswarm → bash wrapper → npx tsx src/cli.ts      │
│  /usr/local/bin/gateswarm-tui → node cli/dist/cli.js              │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ HTTP to localhost:8900
┌─────────────────────────────────────────────────────────────────────┐
│  GateSwarm MoMA Router v0.5.3 (systemd: moma-gateway)              │
│  ├─ /v05/intel          (tier recommendations, stats)              │
│  ├─ /v05/intel/consumption (5h/weekly/monthly per provider)        │
│  ├─ /v05/intel/quota    (RPM/RPD/tokens remaining)                 │
│  └─ /v05/intel/rediscover (force model rediscovery)                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Underlying LLM providers (6)                                      │
│  ├─ ollama         (local CPU, 2 models)                           │
│  ├─ ollama-cloud   (42 hosted models)                              │
│  ├─ opencodego     (19 models)                                     │
│  ├─ zai            (GLM coding lite, 7 models)                     │
│  ├─ bailian        (5 models)                                      │
│  └─ openrouter     (337 models)                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 8. Cheat sheet (one-liner version)

```bash
# === Health ===
systemctl is-active moma-gateway
curl -s http://localhost:8900/v05/intel | jq '.stats | {models: .totalModels, reqs: .totalRequests, errs: .totalErrors}'

# === v0.5.3 intel ===
gateswarm intel
gateswarm consumption
gateswarm consumption weekly
gateswarm quota
gateswarm rediscover

# === v0.5.4 TUI ===
gateswarm tui                # interactive
gateswarm tui --once         # one-shot
gateswarm tui --once | jq '.'   # pretty

# === Pi chat ===
# /gateswarm intel
# /gateswarm consumption
# /gateswarm tui --once
```
