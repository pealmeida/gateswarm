# Recommended models (October 2026)

GateSwarm routing defaults in `v04_config.json`, `src/v04-config.ts`, `calibration/matrix-variants/quota_band_matrices.json` and `src/agent-registry.ts` follow this matrix. Prefix convention: `cc/` → Claude Code CLI, `cx/` → Codex CLI. Providers in use: Z.AI, Bailian (Token Plan), Claude Code, Codex, and local Ollama as a last resort. OpenCode Go and Ollama Cloud were removed.

## Routing matrix (`tier_models`)

| Tier | Primary (act) | Plan | Main fallbacks |
|------|---------------|------|----------------|
| trivial (`max_tokens` 1024) | bailian `deepseek-v4.1-flash` | — | zai `glm-5.3-flash`; bailian `qwen3.8-flash`; ollama `qwen2.5:1.5b` |
| light | zai `glm-5.3-flash` | — | bailian `deepseek-v4-flash-0731`, `qwen3.8-flash` |
| moderate | zai `glm-5.3` | bailian `deepseek-v4.1-flash` | bailian `qwen3.8-flash`, `glm-5.3`; zai `glm-5.1` |
| heavy | claude-cli `cc/claude-sonnet-5` | zai `glm-5.3` | bailian `qwen3.8-max`, `deepseek-v4-pro`; codex-cli `cx/gpt-6-luna` |
| intensive | codex-cli `cx/gpt-6-sol` | `cc/claude-sonnet-5` | `cc/claude-sonnet-5`; bailian `qwen3.8-max`; `cx/gpt-6-luna` |
| extreme | claude-cli `cc/claude-opus-5-5` | `cc/claude-opus-5-5` (same as act) | `cx/gpt-6-astra`, `cx/gpt-6-sol`; bailian `qwen3.8-max` |

The Bailian, Z.AI, Claude and Codex reasoning models always think: with a small `max_tokens` the visible answer can come back empty, which is why the trivial tier uses 1024.

Quota bands (`quota_band_matrices.json`) reuse the same model IDs; load-shedding now promotes Bailian models instead of Ollama Cloud / OpenCode Go.

## Provider catalogs (in-repo)

### Bailian Token Plan (`bailian`)

Text models: `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`, `glm-5.2`, `glm-5.3`, `deepseek-v4-pro`, `deepseek-v4-flash-0731`, `deepseek-v4.1-flash`. The endpoint and key come from `BAILIAN_BASE` / `BAILIAN_KEY` (never committed). Check your plan terms before routing backend traffic through it.

### Z.AI (`zai`)

`glm-4.5`, `glm-4.5-air`, `glm-4.6`, `glm-4.7`, `glm-5`, `glm-5-turbo`, `glm-5.1`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flashx`. `glm-4.7-flash` is no longer listed by the API and was dropped.

### Claude Code (`claude-cli`)

| GateSwarm ID | Claude CLI name |
|--------------|-----------------|
| `cc/claude-sonnet-5` | `sonnet-5` |
| `cc/claude-opus-5-5` | `opus` |
| `cc/claude-haiku-4-5` | `claude-haiku-4-5` |

### Codex CLI (`codex-cli`)

| GateSwarm ID | CLI `model` |
|--------------|-------------|
| `cx/gpt-6-sol` | `gpt-6-sol` |
| `cx/gpt-6-luna` | `gpt-6-luna` |
| `cx/gpt-6-astra` | `gpt-6-astra` |

## Retirements

| Model / provider | Notes |
|------------------|-------|
| `opencodego` (all models) | Subscription cancelled; provider removed from the registry and defaults |
| `ollama-cloud` | Removed (no key, unused) |
| `glm-4.7-flash` | Not in Z.AI `/models`; replaced by `glm-5.3-flash` |
| `cx/gpt-5.*`, `cx/gpt-4.1` | Legacy Codex IDs removed from the catalog |
| `cc/claude-*-4-*` (sonnet-4-6, opus-4-7, opus-4-8), `cc/claude-fable-5-1` | Removed (superseded / plan-gated) |
| `qwen3.5-plus`, `qwen3.6-plus`, `qwen3-coder-plus` | Not in the Token Plan; agent defaults and heuristic weights updated |

## AnyModel / native delegation

Use the same model strings without `cc/` or `cx/` when the engine is native Claude or Codex.
