# gateswarm-mcp

Model Context Protocol server that plugs the GateSwarm advisory router into **any MCP-capable CLI/IDE AI agent** (Claude Code, Cursor, Windsurf, Cline, opencode, Zed, …).

The agent gains three tools:

| Tool | What it does |
|---|---|
| `route_prompt` | Scores the prompt (`gateswarm-lite`), returns tier + score, the chosen model/provider with reasoning and blended cost, alternatives, and a `eventId`. Appends a `decision` record to the telemetry store. |
| `submit_feedback` | Human verdict on a decision: `correct`, or `wrong` + `correctTier`. For wrong verdicts it immediately shows which model the router *would* pick at the corrected tier. Appends a `feedback` record. |
| `telemetry_summary` | Per-project counts: decisions by tier, feedback verdicts. |

Feedback records are golden-dataset labels — they feed `eval:refit-boundaries` via the dogfood loop (see `docs/superpowers/specs/2026-08-25-dogfood-loop-promptly-anymodel.md`).

Advisory only: no provider calls, no API keys. Execute the request yourself or through the GateSwarm gateway proxy.

## Register with your agent

Build once from the repo root: `npm run build`

**Claude Code**
```sh
claude mcp add gateswarm -- node /path/to/gateswarm-router/packages/gateswarm-mcp/dist/cli.js
```

**Cursor / Windsurf / Cline / opencode** — add to the MCP config (e.g. `.cursor/mcp.json`, `~/.opencode/config.json`):
```json
{
  "mcpServers": {
    "gateswarm": {
      "command": "node",
      "args": ["/path/to/gateswarm-router/packages/gateswarm-mcp/dist/cli.js"]
    }
  }
}
```

**Any other MCP client** — it is a plain stdio server speaking newline-delimited JSON-RPC 2.0.

## Configuration

- `GATESWARM_TELEMETRY_DIR` — telemetry root (default `~/.gateswarm/telemetry`). One JSONL file per project: `<dir>/<project>/events.jsonl`.
- Records follow the `InteractionEvent` shape from the dogfood spec; export is `cat`.

## Typical agent flow

1. User submits a task → agent calls `route_prompt {prompt, project}`.
2. Agent shows: tier, chosen model/provider, cost, reason.
3. User says "that's a trivial job" → agent calls `submit_feedback {eventId, verdict:"wrong", correctTier:"light"}` → server replies with the model that should have been used.
4. Verdicts accumulate per project; run the eval pipeline periodically to recalibrate boundaries from real traffic.

> Requires `gateswarm-lite` + `gateswarm-router` workspace builds present in `dist/` (`npm run build` handles ordering).
