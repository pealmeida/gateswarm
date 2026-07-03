# Secrets — Sovereign Vault integration

`sv-secrets.mjs` is the official drop-in Node loader from
[pealmeida/sovereign-vault](https://github.com/pealmeida/sovereign-vault)
(`clients/node/sv-secrets.mjs`, vendored verbatim @ `c29e0db4`, 2026-07-02).
Do not edit it here — re-vendor from upstream to update.

`vault-env.ts` is GateSwarm's wrapper around the loader. At gateway startup it
loads provider API keys **vault-first** from the Sovereign Vault container
named by `SV_CONTAINER` (default `env-gateswarm`), falling back to the local
`.env` when the vault is locked, unavailable, or not installed — so a missing
vault never blocks the gateway.

| Env var | Default | Meaning |
|---|---|---|
| `SECRETS_SOURCE` | `auto` | `auto` = vault first, `.env` fallback · `vault` = vault only (fail hard) · `env` = `.env` only |
| `SV_CONTAINER` | `env-gateswarm` | Vault container holding the gateway's `.env` file |
| `SV_FILE` | `.env` | File name inside the container |
| `SV_BIN` | `sovereign-vault` on PATH | Path to the vault CLI binary |
| `SV_TIMEOUT_MS` | `30000` | Time allowed for the human approval prompt |

Precedence: values read from the **vault overwrite** anything dotenv loaded
from `.env` (the vault is the primary source of truth). Values read from the
`.env` fallback never overwrite variables already present in the environment.

To push your current `.env` into the vault (one approval click on the desktop
app): `node scripts/sv-import-env.mjs` — see that script's header for options.
