# Jev quota advisor

Module `src/jev/quota-advisor.ts`. Local rules decide first; Jev can only **harden** (downgrade a tier, treat an error as quota exhaustion, require a fallback), never soften.

Flag `GATESWARM_JEV_DECISIONS` (needs `GATESWARM_JEV_MODE=shadow`): `off` (default, Jev never called) | `advise` (Jev asked and logged, effective decision stays local) | `enforce` (effective = hardest of local and Jev; opt-in only). Timeout 800 ms (`GATESWARM_JEV_TIMEOUT_MS`), fail-open.

Decisions: `adviseDowngrade` (band yellow/orange/red; high-risk flags are not downgraded by Jev outside red), `classifyProviderError` (1308 / 429 / insufficient_quota / MissingSession → breaker), `reviewTierRow` (tier table resilience).

Only metadata is sent (tier, band, provider, flags, HTTP status, whitelisted error-code token). No prompt text, no error bodies. Log: `data/jev-shadow/jev-quota-advisor.jsonl` (override `GATESWARM_JEV_QUOTA_ADVISOR_LOG`) with local vs Jev opinion per decision.

Status: module and tests only; not yet wired into the gateway request path.
