# Recommended models (September 2026)

GateSwarm routing defaults in `v04_config.json`, `calibration/matrix-variants/quota_band_matrices.json` (green/yellow bands), and `src/agent-registry.ts` follow this matrix. Prefix convention: `cc/` → Claude Code CLI, `cx/` → Codex CLI.

## Routing matrix (`tier_models`)

| Tier | Primary (act) | Plan | Main fallbacks |
|------|---------------|------|----------------|
| trivial | opencodego `mimo-v2.6-flash` | — | Go `deepseek-v4-flash`, `mimo-v2.5`; zai `glm-4.7-flash`, `glm-4.5-air` |
| light | opencodego `deepseek-v4-flash` | — | Go `mimo-v2.5`; zai flash |
| moderate | zai `glm-5` | zai `glm-4.7-flash` | zai `glm-5.1`, `glm-4.7`; Go flash |
| heavy | claude-cli `cc/claude-sonnet-5` | zai `glm-5` | zai `glm-5.1`; codex-cli `cx/gpt-6-luna` |
| intensive | codex-cli `cx/gpt-6-sol` | `cc/claude-sonnet-5` | `cx/gpt-6-luna`; zai `glm-5` / `glm-5.1` |
| extreme | claude-cli `cc/claude-opus-5-5` | `cc/claude-opus-5-5` (same as act) | `cx/gpt-6-astra`; zai `glm-5`; `cx/gpt-6-sol` |

Orange/red quota bands keep load-shedding behavior (more ollama-cloud under stress) but use the same CLI model IDs where Codex/Claude appear.

## Provider catalogs (in-repo)

### OpenCode Go (`opencodego`)

- Flash / low tiers: `mimo-v2.6-flash`, `deepseek-v4-flash`, `mimo-v2.5`
- Pro fallback: `deepseek-v4-pro`

**Catalog gap:** `deepseek-v4.1-flash` is not listed in `HTTP_PROVIDER_MODELS` yet; **light** tier uses `deepseek-v4-flash` as the closest match.

### Z.AI (`zai`)

- Flash: `glm-4.7-flash` (and `glm-4.5-air`)
- Standard: `glm-5`, `glm-5.1`

**Catalog gap:** `glm-5.3-flash` is not in the committed catalog; **moderate** act uses `glm-5` with plan `glm-4.7-flash`.

### Claude Code (`claude-cli`)

| GateSwarm ID | Codex/Claude CLI name |
|--------------|------------------------|
| `cc/claude-sonnet-5` | `sonnet-5` |
| `cc/claude-opus-5-5` | `opus` |
| `cc/claude-fable-5-1` | `fable` (Max / plan-gated; optional catalog alias — **not** used in default routing) |

Legacy IDs (`cc/claude-sonnet-4-6`, `cc/claude-opus-4-8`, …) remain in the catalog for backward compatibility but are **not** default primaries.

### Codex CLI (`codex-cli`)

| GateSwarm ID | CLI `model` |
|--------------|-------------|
| `cx/gpt-6-sol` | `gpt-6-sol` |
| `cx/gpt-6-luna` | `gpt-6-luna` |
| `cx/gpt-6-astra` | `gpt-6-astra` |

Legacy `cx/gpt-5.*` entries remain mapped for existing configs.

## Retirements (do not use as new primaries)

| Model | Notes |
|-------|--------|
| `cx/gpt-5.4-codex` / `gpt-5.4` | Removed from ChatGPT/Codex recommendations |
| `cc/claude-sonnet-4-6`, `cc/claude-opus-4-8` | Superseded by sonnet-5 / opus-5-5 family |
| ollama-cloud on trivial/light/heavy | Optional fallback only; OpenCode Go + Z.AI preferred for low tiers |

`gpt-5.5` may still exist in the Codex CLI until 2026-10-14; kept as a legacy catalog alias, not a default route.

## Ollama Cloud & Bailian

- **Ollama Cloud:** available in catalog; used in quota-stress bands and emergency fallbacks, never as the default primary for green/yellow matrices.
- **Bailian:** unchanged this round; inventory only.

## AnyModel / native delegation

Use the same model strings without `cc/` or `cx/` when the engine is native Claude or Codex. OpenCode Go still requires the session header patch documented in the integration guides.
