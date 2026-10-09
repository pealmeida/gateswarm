/**
 * Secret scanning utilities.
 *
 * TypeScript ESM, zero dependencies, targets Node 20.
 *
 * Safety rules honored here:
 * - All pattern regexes are non-global (no `lastIndex` state bugs on reuse).
 * - Findings expose only the pattern/env NAME, never the matched secret text.
 */

import { createHash } from 'node:crypto';

export interface SecretPattern {
  name: string;
  re: RegExp;
}

export interface EnvValue {
  name: string;
  value: string;
}

export type SecretFindingKind = 'regex' | 'env_literal';

export interface SecretFinding {
  kind: SecretFindingKind;
  /** Pattern name or environment variable name. Never contains secret material. */
  name: string;
}

export interface ScanResult {
  /** True when no findings were produced. */
  clean: boolean;
  findings: SecretFinding[];
}

/**
 * Minimum length for an environment variable value to be treated as a
 * meaningful literal worth scanning for.
 */
const MIN_ENV_LITERAL_LENGTH = 8;

/**
 * Known secret shapes. All regexes are non-global on purpose so they can be
 * safely tested repeatedly without mutating internal regex state.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'openai_sk', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: 'github_token', re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: 'github_pat', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
  { name: 'aws_akid', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'slack', re: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer', re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
  { name: 'google_api', re: /AIza[0-9A-Za-z_-]{35}/ },
  {
    name: 'kv_secret',
    re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/i,
  },
];

/**
 * Scan `text` for known secret shapes and for literal occurrences of the
 * provided environment values.
 *
 * Returns only finding NAMES (pattern name or env variable name); the matched
 * secret text is never included in the result. Findings are deduplicated by
 * kind+name.
 *
 * Env literals are only considered when `value.length >= 8` to avoid flagging
 * trivially short strings that appear everywhere.
 */
export function scanSecrets(
  text: string,
  envValues?: EnvValue[],
): ScanResult {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  const add = (kind: SecretFindingKind, name: string): void => {
    const key = `${kind}\u0000${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ kind, name });
  };

  if (typeof text === 'string' && text.length > 0) {
    for (const { name, re } of SECRET_PATTERNS) {
      // re.test is safe here: regexes are non-global, so no lastIndex mutation.
      if (re.test(text)) {
        add('regex', name);
      }
    }

    if (envValues) {
      for (const { name, value } of envValues) {
        if (typeof value !== 'string' || value.length < MIN_ENV_LITERAL_LENGTH) {
          continue;
        }
        if (text.includes(value)) {
          add('env_literal', name);
        }
      }
    }
  }

  return { clean: findings.length === 0, findings };
}

/**
 * Collect environment entries whose NAME looks sensitive
 * (KEY/TOKEN/SECRET/PASS/PAT, case-insensitive) and whose value is long
 * enough to be a plausible secret (>= 8 chars).
 */
export function loadSensitiveEnvValues(
  env: Record<string, string | undefined> = process.env,
): EnvValue[] {
  const nameRe = /(KEY|TOKEN|SECRET|PASS|PAT)/i;
  const out: EnvValue[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (value.length < MIN_ENV_LITERAL_LENGTH) continue;
    if (!nameRe.test(name)) continue;
    out.push({ name, value });
  }
  return out;
}

/**
 * SHA-256 of a UTF-8 string, hex-encoded.
 */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
