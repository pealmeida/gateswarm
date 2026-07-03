/**
 * Sovereign Vault → process.env bootstrap for GateSwarm.
 *
 * Loads provider API keys from a Sovereign Vault container before the agent
 * registry initializes, with the local .env as an automatic fallback so a
 * locked/absent vault never blocks the gateway. See src/secrets/README.md.
 */

import { loadSecrets } from './sv-secrets.mjs';

export interface VaultEnvResult {
  /** Where the secrets came from: vault | cache | env | none. */
  source: string;
  /** Number of variables loaded (0 when source is "none"). */
  count: number;
  /** Container the loader targeted. */
  container: string;
}

export async function loadVaultEnv(): Promise<VaultEnvResult> {
  const container = process.env.SV_CONTAINER || 'env-gateswarm';
  const file = process.env.SV_FILE || '.env';
  const source = process.env.SECRETS_SOURCE || 'auto';
  // Same .env the gateway's dotenv call targets (repo root).
  const envPath = new URL('../../.env', import.meta.url).pathname;

  try {
    const result = await loadSecrets({ container, file, envPath, source });
    if (result.source === 'vault' || result.source === 'cache') {
      // The vault is the primary source of truth — its values overwrite
      // whatever dotenv already loaded from the (possibly stale) .env.
      Object.assign(process.env, result.vars);
    } else {
      // .env fallback: never clobber variables the real environment set.
      for (const [k, v] of Object.entries(result.vars)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    }
    return { source: result.source, count: Object.keys(result.vars).length, container };
  } catch (err) {
    // SECRETS_SOURCE=vault throws here by design (no silent fallback);
    // anything else means neither vault nor .env exists — providers relying
    // on those keys will simply register as unconfigured.
    if (source === 'vault') throw err;
    return { source: 'none', count: 0, container };
  }
}
