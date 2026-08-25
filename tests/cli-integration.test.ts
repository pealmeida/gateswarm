import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Real-use-case CLI integration: runs the actual CLIs as a user would —
 * argv prompts, piped stdin, bad flags, custom matrix files — through tsx
 * source execution (no prebuilt dist required).
 */

const LITE_CLI = join('packages', 'gateswarm-lite', 'src', 'cli.ts');
const ROUTER_CLI = join('packages', 'gateswarm-router', 'src', 'cli.ts');
const SPAWN_TIMEOUT_MS = 60_000;

function runCli(script: string, args: string[], opts: { input?: string } = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    input: opts.input ?? '',
    timeout: SPAWN_TIMEOUT_MS,
  });
}

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('gateswarm-lite CLI (real invocations)', () => {
  it('scores a prompt passed as an argument', () => {
    const r = runCli(LITE_CLI, ['What is the capital of France?']);
    expect(r.status).toBe(0);
    const out = parseJson(r.stdout);
    expect(typeof out.score).toBe('number');
    expect(['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme']).toContain(out.tier);
    expect(out.latencyMs).toBeTypeOf('number');
  });

  it('scores a prompt piped through stdin', () => {
    const r = runCli(LITE_CLI, [], { input: 'Design a distributed cache with failover\n' });
    expect(r.status).toBe(0);
    const out = parseJson(r.stdout);
    expect(typeof out.score).toBe('number');
    expect(out.tier).toBeTypeOf('string');
  });

  it('exits 1 immediately with a JSON error on empty input (no hang)', () => {
    const start = Date.now();
    const r = runCli(LITE_CLI, [], { input: '' });
    expect(r.status).toBe(1);
    expect(Date.now() - start).toBeLessThan(SPAWN_TIMEOUT_MS);
    const err = parseJson(r.stderr);
    expect(String(err.error)).toContain('empty prompt');
  });

  it('rejects whitespace-only argv as empty', () => {
    const r = runCli(LITE_CLI, ['   '], { input: '' });
    expect(r.status).toBe(1);
    expect(parseJson(r.stderr).error).toBeTruthy();
  });
});

describe('gateswarm-route CLI (real invocations)', () => {
  it('returns an advisory decision for an argv prompt', () => {
    const r = runCli(ROUTER_CLI, ['Design a distributed cache with failover', '--strategy', 'best-value']);
    expect(r.status).toBe(0);
    const out = parseJson(r.stdout);
    expect(out.strategy).toBe('best-value');
    expect((out.model as Record<string, unknown>).id).toBeTypeOf('string');
    expect(out.complexity).toBeTruthy();
    expect(String(out.reason).length).toBeGreaterThan(0);
  });

  it('defaults to cheapest-capable when --strategy is omitted', () => {
    const r = runCli(ROUTER_CLI, ['hello']);
    expect(r.status).toBe(0);
    expect(parseJson(r.stdout).strategy).toBe('cheapest-capable');
  });

  it('loads a custom matrix from a JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateswarm-cli-matrix-'));
    tempDirs.push(dir);
    const matrixPath = join(dir, 'matrix.json');
    writeFileSync(
      matrixPath,
      JSON.stringify([
        { id: 'only', provider: 'x', maxEffort: 'extreme', costPer1MInput: 1, costPer1MOutput: 2, quality: 0.9 },
      ]),
    );
    const r = runCli(ROUTER_CLI, ['hello world', '--matrix', matrixPath]);
    expect(r.status).toBe(0);
    const out = parseJson(r.stdout);
    expect((out.model as Record<string, unknown>).id).toBe('only');
  });

  it('exits 1 with a JSON error on an unknown --strategy', () => {
    const r = runCli(ROUTER_CLI, ['hi', '--strategy', 'fastest'], { input: '' });
    expect(r.status).toBe(1);
    const err = parseJson(r.stderr);
    expect(String(err.error)).toContain('invalid --strategy');
  });

  it('exits 1 with a JSON error on an unreadable matrix file', () => {
    const r = runCli(ROUTER_CLI, ['hi', '--matrix', 'Z:/definitely/not/here.json'], { input: '' });
    expect(r.status).toBe(1);
    expect(String(parseJson(r.stderr).error)).toContain('could not read matrix file');
  });

  it('exits 1 immediately on empty input (no hang)', () => {
    const r = runCli(ROUTER_CLI, [], { input: '' });
    expect(r.status).toBe(1);
    expect(parseJson(r.stderr).error).toBeTruthy();
  });
});
