# GateSwarm Bar TUI

A cross-platform terminal UI for monitoring GateSwarm providers, models, and
router configuration in real-time. Inspired by [CodexBar](https://codexbar.app),
implemented in TypeScript with [Ink](https://github.com/vadimdemedes/ink) (React
for CLIs).

## Features

- **Live polling** of `/v05/intel/consumption` and `/v05/intel` (configurable
  interval, default 10s)
- **4 tabs**: Overview (default), Providers, Tiers, Activity
- **6 panels per tab**:
  - Header — total models, providers, requests, errors, cost
  - Providers — per-provider 5h/weekly/monthly quota bars with ETA warnings
  - Models — top models by traffic, latency, errors
  - Tiers matrix — 6-tier routing recommendations with confidence scores
  - Router config — discovery interval, TurboQuant, CWM, provider health
  - Live activity — recent routing decisions with reason codes
- **Cross-OS**: macOS, Linux, Windows (anywhere Node.js runs)
- **Single-file binary** when bundled
- **Mock mode** for testing without a running server

## Install

```bash
cd $(dirname $(readlink -f "$0"))/../cli
npm install
npm run build
npm link                 # exposes `gateswarm-bar` globally
```

## Usage

```bash
# Default (talks to http://localhost:8900, refresh 10s)
gateswarm-bar

# Use built-in mock data (no server required)
gateswarm-bar --mock

# Custom server URL
gateswarm-bar --url http://router.example.com:8900

# Faster refresh
gateswarm-bar --refresh 5

# Start on a specific tab
gateswarm-bar --tab providers

# One-shot JSON dump (for scripts / CI)
gateswarm-bar --once
gateswarm-bar --once --mock | jq '.consumption.totalProviders'
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` | Show Overview tab |
| `2` | Show Providers tab |
| `3` | Show Tiers tab |
| `4` | Show Activity tab |
| `r` | Force refresh |
| `q` / `Esc` / `Ctrl+C` | Quit |

## Environment Variables

- `GATESWARM_URL` — default server URL (overridden by `--url`)

## Architecture

```
cli/
├── package.json
├── tsconfig.json
└── src/
    ├── cli.tsx              # Entry point, arg parsing, render
    ├── api.ts                # HTTP client for /v05/intel/*
    ├── types.ts              # TypeScript types matching server responses
    ├── mock.ts               # Mock data for --mock mode
    ├── format.ts             # Bar renderer, color helpers, formatters
    └── components/
        ├── App.tsx           # Main layout, polling, tab routing
        ├── Header.tsx        # Status summary
        ├── ProvidersPanel.tsx
        ├── ModelsPanel.tsx
        ├── TiersMatrix.tsx
        ├── RouterConfig.tsx
        └── ActivityPanel.tsx
```

## Comparison to CodexBar

| Feature | CodexBar | GateSwarm Bar |
|---|---|---|
| **Platform** | macOS only | macOS, Linux, Windows |
| **UI type** | Native menu bar + WidgetKit | Terminal TUI |
| **Providers** | 40+ (each with own fetcher) | 6 (consolidated via GateSwarm) |
| **Cost tracking** | Local log scan (Codex/Claude) | Server-side token tracking |
| **Quotas** | Per-provider native | Per-window (5h/wk/mo) with ETA |
| **Privacy** | Reads browser cookies, OAuth tokens | Reads only the local GateSwarm API |
| **Installation** | Homebrew cask, dmg | Local build followed by `npm link` |
| **License** | MIT | MIT |

## Roadmap

- [ ] Per-model breakdown (extend `/v05/intel/models` to consumption tracker)
- [ ] Color customization (--theme light/dark)
- [ ] Filter by provider (e.g., only show ollama-cloud)
- [ ] Export to CSV/JSON
- [ ] Alert mode (terminal bell when quota > 80%)
- [ ] Plugin system for custom panels
- [ ] Bundled single-file binary (via `bun build` or `pkg`)

## See also

- [CodexBar](https://github.com/steipete/CodexBar) — the inspiration
- [Ink](https://github.com/vadimdemedes/ink) — React for CLIs
- [GateSwarm v0.5.3 docs](../README.md) — the server this client queries
