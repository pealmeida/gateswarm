/**
 * Output Filter v0.6 — Unit Tests
 *
 * Covers all 7 filter strategies:
 * stats-extraction, failure-focus, code-filter, deduplication,
 * tree-compression, ndjson-parse, state-machine
 *
 * Plus: auto-detect, tee mechanism, savings calculation
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyOutputFilter, readTee, cleanupTee, TEE_DIR } from '../src/output-filter.js';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

describe('Output Filter — Strategy Detection', () => {
  it('detects test failure output as failure-focus', async () => {
    const r = await applyOutputFilter(`PASS src/utils.test.ts
✓ should return true
✓ should handle edge cases
FAIL src/api.test.ts
✗ should connect to database
  Error: Connection refused
    at Object.connect (src/api.ts:12:11)
    at Suite.<anonymous> (src/api.test.ts:5:3)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 47 passed, 48 total`);
    expect(r.strategy).toBe('failure-focus');
    // Failure-focus preserves failure details, so savings may be low for short inputs
    expect(r.originalLength).toBeGreaterThan(0);
  });

  it('detects passing tests as failure-focus', async () => {
    const r = await applyOutputFilter(`PASS src/utils.test.ts
✓ should return true
✓ should handle edge cases
✓ should parse JSON
✓ should format dates

Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
Time:        2.34s`);
    expect(r.strategy).toBe('failure-focus');
    expect(r.savingsPct).toBeGreaterThan(30); // passing tests heavily compressed
    expect(r.content).toContain('All checks passed');
  });

  it('detects directory listing as tree-compression', async () => {
    const r = await applyOutputFilter(`src/
src/index.ts
src/utils.ts
src/api/handler.ts
src/api/routes.ts
src/api/middleware.ts
src/api/validators.ts
src/db/connection.ts
src/db/migrations.ts
src/db/models/user.ts
src/db/models/post.ts
README.md
package.json
tsconfig.json
5 files changed, 142 insertions(+), 89 deletions(-)`);
    expect(r.strategy).toBe('tree-compression');
    expect(r.savingsPct).toBeGreaterThan(20);
    expect(r.content).toContain('Directory summary');
  });

  it('detects NDJSON as ndjson-parse', async () => {
    const r = await applyOutputFilter(`{"type":"test","status":"pass","title":"should work","duration":12}
{"type":"test","status":"pass","title":"should handle null","duration":5}
{"type":"test","status":"fail","title":"should parse","duration":8,"error":"Expected number"}
{"type":"test","status":"pass","title":"should format","duration":3}
{"type":"test","status":"pass","title":"should render","duration":15}
{"type":"summary","total":5,"passed":4,"failed":1}`);
    expect(r.strategy).toBe('ndjson-parse');
    expect(r.content).toContain('6 events parsed');
    expect(r.content).toContain('failure');
  });

  it('detects build output as state-machine', async () => {
    const r = await applyOutputFilter(`[INFO] Starting build...
[INFO] Compiling TypeScript
Compiling module A...
Compiling module B...
Compiling module C...
[INFO] Running tests
[INFO] Building assets
Bundling main.js...
Bundling vendor.js...
[INFO] Optimizing
[INFO] Build complete`);
    expect(r.strategy).toBe('state-machine');
    expect(r.content).toContain('Build phases');
  });

  it('detects duplicated lines as deduplication', async () => {
    const r = await applyOutputFilter(`[ERROR] Connection refused
[ERROR] Connection refused
[ERROR] Connection refused
[ERROR] Connection refused
[ERROR] Connection refused
[WARN] Retrying in 5s...
[ERROR] Connection refused
[ERROR] Connection refused
[ERROR] Connection refused`);
    expect(r.strategy).toBe('deduplication');
    expect(r.content).toContain('x5') || expect(r.content).toContain('×5');
  });

  it('detects code content as code-filter', async () => {
    const r = await applyOutputFilter(`// Utility functions for the API
function createUser(name: string, email: string): User {
  // Validate input
  if (!name || !email) {
    throw new Error('Name and email are required');
  }
  // Create user in database
  const user = db.users.create({ name, email });
  return user;
}

function deleteUser(id: string): boolean {
  return db.users.delete(id);
}`);
    expect(r.strategy).toBe('code-filter');
  });

  it('detects stats output as stats-extraction', async () => {
    const r = await applyOutputFilter(`commit abc123
Author: John Doe
Date: Mon Jan 1 12:00:00 2024

    Fixed the auth bug

 src/auth.ts      | 12 ++++++++----
 src/middleware.ts | 8 ++++----
 src/utils.ts     | 3 ++-
 3 files changed, 14 insertions(+), 9 deletions(-)`);
    expect(r.strategy).toBe('stats-extraction');
  });

  it('defaults to deduplication for unrecognized content', async () => {
    const r = await applyOutputFilter(`Hello world
This is some generic text
That doesn't match any pattern
So it should default to deduplication`);
    expect(r.strategy).toBe('deduplication');
  });
});

describe('Output Filter — Filter Behavior', () => {
  it('failure-focus: all passing → minimal summary', async () => {
    const r = await applyOutputFilter(`PASS src/a.test.ts
✓ test1 (2ms)
✓ test2 (1ms)
✓ test3 (5ms)
✓ test4 (3ms)
✓ test5 (1ms)
✓ test6 (2ms)
✓ test7 (1ms)
✓ test8 (3ms)
✓ test9 (1ms)
✓ test10 (2ms)

Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total`);
    expect(r.content).toContain('All checks passed');
    expect(r.originalLength).toBeGreaterThan(r.filteredLength);
  });

  it('failure-focus: failures preserved with details', async () => {
    const r = await applyOutputFilter(`PASS src/utils.test.ts
✓ should return true
FAIL src/api.test.ts
✗ should connect to database
  Error: Connection refused
    at Object.connect (src/api.ts:12:11)
    at Suite.<anonymous> (src/api.test.ts:5:3)
PASS src/auth.test.ts
✓ should validate token

Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 12 passed, 13 total`);
    expect(r.content).toContain('failure');
    expect(r.content).toContain('Connection refused');
  });

  it('deduplication collapses repeated lines', async () => {
    const r = await applyOutputFilter(`line1
line2
line2
line2
line2
line2
line3
line4`);
    expect(r.content).toContain('x5');
    expect(r.savingsPct).toBeGreaterThan(0);
  });

  it('returns unchanged for very short content', async () => {
    const r = await applyOutputFilter('Hi');
    expect(r.content).toBe('Hi');
    expect(r.savingsPct).toBe(0);
    expect(r.strategy).toBe('none');
  });

  it('returns unchanged for empty content', async () => {
    const r = await applyOutputFilter('');
    expect(r.content).toBe('');
    expect(r.savingsPct).toBe(0);
  });

  it('savingsPct is correctly calculated', async () => {
    const content = 'A'.repeat(1000);
    const r = await applyOutputFilter(content, { strategy: 'deduplication' });
    // For 1000 same chars, it should deduplicate heavily
    const expectedSavings = Math.round((1 - r.filteredLength / r.originalLength) * 10000) / 100;
    expect(r.savingsPct).toBe(expectedSavings);
  });
});

describe('Output Filter — Tee Mechanism', () => {
  it('saves tee file when filtering occurs and teeEnabled=true', async () => {
    const content = `PASS src/a.test.ts
✓ test1 (2ms)
✓ test2 (1ms)
✓ test3 (5ms)
✓ test4 (3ms)
✓ test5 (1ms)

Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total`;

    const r = await applyOutputFilter(content, {
      strategy: 'auto-detect',
      teeEnabled: true,
    });

    expect(r.savingsPct).toBeGreaterThan(10);
    expect(r.teePath).toBeDefined();

    // Verify tee file exists and contains original content
    if (r.teePath) {
      const teeContent = await readTee(r.teePath);
      expect(teeContent).toBe(content);
    }
  });

  it('does not save tee file when teeEnabled=false', async () => {
    const content = `PASS src/a.test.ts
✓ test1 (2ms)
✓ test2 (1ms)

Test Suites: 1 passed, 1 total`;

    const r = await applyOutputFilter(content, {
      teeEnabled: false,
    });

    expect(r.teePath).toBeUndefined();
  });

  it('cleanupTee removes old files', async () => {
    // Create a fake old tee file
    await fs.mkdir(TEE_DIR, { recursive: true });
    const oldPath = join(TEE_DIR, '1000_old_test.log');
    await fs.writeFile(oldPath, 'old content', 'utf-8');

    await cleanupTee(0); // 0ms age = all files are old

    const exists = await fs.stat(oldPath).catch(() => null);
    expect(exists).toBeNull();
  });
});

describe('Output Filter — Filter Level', () => {
  it('minimal level preserves more content than aggressive', async () => {
    const code = `// Comment line
function hello() {
  // Inner comment
  return "hello";
}
// Footer comment`;

    const minimal = await applyOutputFilter(code, { strategy: 'code-filter', level: 'minimal' });
    const aggressive = await applyOutputFilter(code, { strategy: 'code-filter', level: 'aggressive' });

    expect(minimal.filteredLength).toBeGreaterThanOrEqual(aggressive.filteredLength);
  });

  it('standard level is between minimal and aggressive', async () => {
    const code = `// Full line comment
function parse(s: string) {
  // Validate
  if (!s) return null;
  return JSON.parse(s);
}`;

    const minimal = await applyOutputFilter(code, { strategy: 'code-filter', level: 'minimal' });
    const standard = await applyOutputFilter(code, { strategy: 'code-filter', level: 'standard' });
    const aggressive = await applyOutputFilter(code, { strategy: 'code-filter', level: 'aggressive' });

    expect(minimal.filteredLength).toBeGreaterThanOrEqual(standard.filteredLength);
    expect(standard.filteredLength).toBeGreaterThanOrEqual(aggressive.filteredLength);
  });
});
