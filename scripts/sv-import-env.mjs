#!/usr/bin/env node
// sv-import-env.mjs — push GateSwarm's .env into a Sovereign Vault container.
//
// Stores the gateway's provider API keys (ZAI_KEY, OLLAMA_CLOUD_KEY, …) in
// Sovereign Vault so the gateway can load them vault-first at startup
// (see src/secrets/README.md). Writes via the vault's `vault.write` MCP tool
// through the `sovereign-vault mcp-stdio` proxy.
//
// Requirements: the Sovereign Vault desktop app running and UNLOCKED, and the
// target container created (APPROVAL mode recommended — you'll approve the
// write once from the desktop prompt).
//
// Usage:
//   node scripts/sv-import-env.mjs                          # .env → env-gateswarm/.env
//   node scripts/sv-import-env.mjs --container env-myproj   # custom container
//   node scripts/sv-import-env.mjs --env /path/to/.env      # custom source file
//   SV_BIN=/abs/path/sovereign-vault node scripts/sv-import-env.mjs
//
// After a successful import, verify the round-trip and switch the gateway to
// vault-first (optionally deleting the plaintext .env):
//   node src/secrets/sv-secrets.mjs --container env-gateswarm --source vault

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const container = get('--container') || process.env.SV_CONTAINER || 'env-gateswarm';
const fileName = get('--file') || process.env.SV_FILE || '.env';
const envPath = get('--env') || join(root, '.env');
const bin = process.env.SV_BIN || 'sovereign-vault';
const timeoutMs = Number(process.env.SV_TIMEOUT_MS) || 60000; // approval prompt time

if (!existsSync(envPath)) {
  console.error(`[sv-import-env] no file at ${envPath} — nothing to import`);
  process.exit(2);
}

const text = readFileSync(envPath, 'utf8');
const keyCount = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('=')).length;
const frame = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'vault.write',
    arguments: { container, file_name: fileName, content_b64: Buffer.from(text, 'utf8').toString('base64') },
  },
});

console.error(`[sv-import-env] importing ${keyCount} entries from ${envPath} → vault container "${container}" as "${fileName}"`);
console.error('[sv-import-env] approve the write on the Sovereign Vault desktop prompt if asked…');

const child = spawn(bin, ['mcp-stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let done = false;

const finish = (code, msg) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try { child.kill(); } catch {}
  console.error(msg);
  process.exit(code);
};

const timer = setTimeout(
  () => finish(1, `[sv-import-env] ERROR timed out after ${timeoutMs}ms (vault locked? prompt unanswered?)`),
  timeoutMs,
);

child.on('error', (e) => finish(1, `[sv-import-env] ERROR cannot run "${bin}": ${e.message} (set SV_BIN or add sovereign-vault to PATH)`));
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== 1 || !msg.result) continue;
    const textOut = msg.result?.content?.[0]?.text ?? '';
    if (msg.result.isError) return finish(1, `[sv-import-env] ERROR vault: ${textOut}`);
    return finish(0, `[sv-import-env] ✅ stored in "${container}/${fileName}" — gateway will now load keys vault-first`);
  }
});

child.stdin.write(frame + '\n');
