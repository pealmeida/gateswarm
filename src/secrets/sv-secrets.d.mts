/**
 * Type declarations for the vendored Sovereign Vault Node loader
 * (clients/node/sv-secrets.mjs — see README.md in this directory).
 */

export interface LoadSecretsOptions {
  container: string;
  /** File name inside the container (default ".env"). */
  file?: string;
  /** Local fallback path (default ".env"). */
  envPath?: string;
  /** "auto" | "vault" | "env" (default: SECRETS_SOURCE or "auto"). */
  source?: string;
  /** Path to the sovereign-vault CLI binary (default: SV_BIN or PATH lookup). */
  bin?: string;
  timeoutMs?: number;
  otp?: string;
  cacheTtlMs?: number;
}

export interface LoadSecretsResult {
  source: 'vault' | 'env' | 'cache';
  vars: Record<string, string>;
}

export function loadSecrets(options: LoadSecretsOptions): Promise<LoadSecretsResult>;

export function readFromVault(options: {
  container: string;
  file?: string;
  bin?: string;
  timeoutMs?: number;
  otp?: string;
}): Promise<string>;

export function parseDotenv(text: string): Record<string, string>;

export function clearCache(container?: string, file?: string): void;
