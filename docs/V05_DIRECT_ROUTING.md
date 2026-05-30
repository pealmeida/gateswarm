# GateSwarm MoMA Router v0.5.1 — Direct Routing Bypass

> **Date:** 2026-05-19  
> **Status:** Implemented  
> **Feature:** Bypass complexity classification and route directly to user-specified provider/model

## Overview

Users can now skip the complexity scoring and tier routing logic by specifying the target provider and model directly in the request. This is useful for:

- **Testing specific providers** without classification interference
- **Debugging** — force a request to a particular model
- **Cost control** — explicitly choose cheap/expensive models
- **CLI provider verification** — test individual CLI agents (Claude Code, Codex, etc.)

## API Usage

### Method 1: Request Body Parameters

Add `direct_route` object to the request body:

```json
POST /v1/chat/completions
{
  "messages": [{"role": "user", "content": "Hello"}],
  "direct_route": {
    "provider": "claude-cli",
    "model": "cc/claude-sonnet-4-6"
  }
}
```

**Parameters:**
- `direct_route.provider` — Provider ID (bailian, zai, openrouter, claude-cli, codex-cli, pi-agent, hermes-agent, openclaw-agent)
- `direct_route.model` — Model name (with or without prefix notation: `cc/claude-sonnet-4-6` or just `claude-sonnet-4-6`)

### Method 2: Model Parameter Override

Set `model` to a fully qualified `provider/model` string:

```json
POST /v1/chat/completions
{
  "messages": [{"role": "user", "content": "Hello"}],
  "model": "claude-cli/cc/claude-sonnet-4-6"
}
```

### Method 3: Header Override

Set `X-Direct-Provider` and `X-Direct-Model` headers:

```bash
curl -X POST http://localhost:8900/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer moma-..." \
  -H "X-Direct-Provider: claude-cli" \
  -H "X-Direct-Model: cc/claude-sonnet-4-6" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

## CLI Usage

```bash
# Using gateswarm CLI (new direct command)
npx tsx src/gateswarm-cli.ts direct claude-cli cc/claude-sonnet-4-6 "What is 2+2?"
npx tsx src/gateswarm-cli.ts direct bailian qwen3.5-plus "Explain closures"
npx tsx src/gateswarm-cli.ts direct codex-cli cx/gpt-5.3-codex "Write a fibonacci function"

# With specific gateway URL
GATESWARM_URL=http://localhost:8900 npx tsx src/gateswarm-cli.ts direct claude-cli cc/claude-opus-4-7 "Design a microservices architecture"
```

## Available Providers

| Provider ID | Type | Models |
|-------------|------|--------|
| `bailian` | HTTP API | qwen3.6-plus, qwen3.5-plus, qwen3-coder-plus, qwen3.6-max-preview, qwen4.6 |
| `zai` | HTTP API | glm-4.7, glm-4.7-flash, glm-5, glm-5-turbo, glm-5.1 |
| `openrouter` | HTTP API | owl-alpha, glm-4.7-flash, qwen-plus, gemini-2.5-flash, claude-sonnet-4.6, claude-opus-4.6 |
| `claude-cli` | CLI Agent | cc/claude-sonnet-4-6, cc/claude-opus-4-7, cc/claude-haiku-4-5 |
| `codex-cli` | CLI Agent | cx/gpt-5.3-codex, cx/gpt-4.1 |
| `pi-agent` | CLI Agent | pi/qwen3.5-plus, pi/glm-4.7-flash |
| `hermes-agent` | CLI Agent | hm/glm-4.7, hm/glm-4.7-flash |
| `openclaw-agent` | CLI Agent | oc/bailian/qwen3.5-plus, oc/zai/glm-4.7-flash |

## Security

- Direct routing still requires valid agent authentication (API key)
- CLI provider loop guard is still enforced (agent can't route to itself)
- All direct routing requests are logged with `📍 [agent] Direct route:` prefix

## Implementation Details

### Gateway Changes

1. **Direct route detection** — Before complexity scoring, check for `direct_route` body param, `model` override, or headers
2. **Provider resolution** — Parse `provider/model` format or resolve provider from ID
3. **CLI/HTTP dispatch** — Use same dispatch logic as routed requests
4. **Fallback chain** — Not used for direct routing (user explicitly chose target)
5. **Logging** — Distinct log format for audit trail

### New Endpoint

- `GET /v1/providers` — List all available providers with their models and types
- `POST /v1/direct/chat` — Alternative endpoint for direct routing (same body format)
