# Jev shadow mode (J0)

Status: **J0 — observe only. Off by default. Does not change routing.**

The Jev (TypeSafe decision API, `jev-1.13.0`) is queried in parallel with the
existing scorer for the same prompt. The result is only written to a JSONL log so
we can measure divergence, latency and cost before giving Jev any influence.

## Behaviour
| Item | Value |
|---|---|
| Flag | `GATESWARM_JEV_MODE=off\|shadow` — default `off`; any other value is `off` |
| Hook points | `/v1/score` and the main routing path in `moma-gateway.ts` (after the scorer; skipped on explicit effort override) |
| Effect on routing | **None.** Call is fire-and-forget (`void`); tier/model/response are untouched |
| Timeout | `GATESWARM_JEV_TIMEOUT_MS` (default 400 ms), no retries |
| Fail-open | Any Jev error/timeout/exception is swallowed and logged as `status:error` |
| Concurrency cap | 4 in flight; excess is logged `skipped/overloaded` |
| Cache | in-memory LRU (500) by sha256 of the request payload; hits cost 0 |
| Sampling | `GATESWARM_JEV_SAMPLE` 0..1 |
| Key | `TYPESAFE_API_KEY` (or `JEV_API_KEY`) from env/bridge only; never logged, never in cache or log |
| Sanitisation | local secret-scan (patterns + sensitive env literals) **before** any network call; a hit means the prompt is never sent (`skipped/secret_scan_blocked`). `privacy:'private'` inputs are never sent (`skipped/private`) |
| Log | `data/jev-shadow/jev-shadow.jsonl` (gitignored), schema `jev-shadow.v1`: `scorer_tier, jev_tier, jev_confidence, diverged, tier_delta, latency_ms, cost_usd, cache_hit, status, reason, prompt_sha256` — **no prompt text** |

## Privacy warning
In `shadow` mode, prompts that pass the secret-scan are sent to an external API
(TypeSafe). The gateway currently has no per-request privacy flag, so enable shadow
only on non-sensitive traffic (dev/benchmark), never on a gateway that serves
private user data, until retention terms are confirmed.

## Enabling (needs explicit GO — not enabled anywhere by this PR)
```
GATESWARM_JEV_MODE=shadow TYPESAFE_API_KEY=… node dist/…   # key via env bridge
```
Analyse with: `jq -s 'map(select(.status=="ok")) | {n:length, diverged:(map(select(.diverged))|length)}' data/jev-shadow/jev-shadow.jsonl`

## Roadmap (see PAPER-JUIZ-JEV-HITL §J0–J3)
- **J0 (this PR)**: shadow log.
- **J1**: add judge shadow + the R0–R6 aggregation matrix as *logged* verdicts (`/v1/score` extra fields, still no tier change). Gate: ≥40 HITL labels.
- **J2**: Jev as tiebreak only for heavy/intensive, only AUTO→HITL (never HITL→AUTO, never raises to `extreme`). Gate: holdout ≥180 labels, weighted κ ≥ 0.80, flips ≤ 2%, wrong-auto ≤ 5%, p95 < 500 ms, pt-BR evaluated.
- **J3**: continuous HITL calibration.
Jev **only blocks**: it never approves on its own.

## Tests
`npx vitest run tests/jev-shadow.test.ts` (13 tests: flag default, secret/private never sent, fail-open, timeout, no key leakage, in-flight cap, JSONL).
Note: if `vitest` fails with a `std-env` SyntaxError, `node_modules` is corrupted — reinstall with a clean npm cache (`npm install --no-package-lock --ignore-scripts --cache /tmp/npmcache`).
