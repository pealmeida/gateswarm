import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearModelListingCache, listProviderModels, parseCliConfigModels } from '../src/model-discovery.js';

const json = (body: unknown, ok = true, status = 200) => ({
  ok, status, json: async () => body, text: async () => JSON.stringify(body),
}) as Response;
let t = 1000;
const now = () => t;

beforeEach(() => {
  clearModelListingCache();
  t = 1000;
  delete process.env.GATESWARM_DISCOVERY_TTL_MS;
});

describe('API listers', () => {
  it('OpenAI-compatible uses Bearer and merges with static', async () => {
    const f = vi.fn(async (..._a: any[]) => json({ data: [{ id: 'a' }, { id: 'b' }] }));
    const r = await listProviderModels('x', {
      fetch: f as any, now,
      provider: { id: 'x', type: 'http-api', baseUrl: 'https://h.example/v1/', apiKey: 'k', models: ['b', 'c'] },
    });
    expect(f.mock.calls[0][0]).toBe('https://h.example/v1/models');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer k');
    expect(r.supported).toBe(true);
    expect(r.models).toHaveLength(3);
    expect(r.models).toEqual(expect.arrayContaining([
      { id: 'a', source: 'discovered' }, { id: 'b', source: 'both' }, { id: 'c', source: 'static' },
    ]));
  });

  it('Anthropic uses x-api-key and version header', async () => {
    const f = vi.fn(async (..._a: any[]) => json({ data: [{ id: 'claude-x' }] }));
    await listProviderModels('anthropic', {
      fetch: f as any, now,
      provider: { id: 'anthropic', type: 'http-api', baseUrl: 'https://api.anthropic.com', apiKey: 'k' },
    });
    expect(f.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models');
    const h = f.mock.calls[0][1].headers;
    expect(h['x-api-key']).toBe('k');
    expect(h['anthropic-version']).toBeTruthy();
  });

  it('Ollama uses /api/tags', async () => {
    const f = vi.fn(async (..._a: any[]) => json({ models: [{ name: 'llama3:8b' }] }));
    const r = await listProviderModels('ollama', {
      fetch: f as any, now,
      provider: { id: 'ollama', type: 'http-api', baseUrl: 'http://localhost:11434/v1' },
    });
    expect(f.mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
    expect(r.models).toEqual([{ id: 'llama3:8b', source: 'discovered' }]);
  });

  it('no baseUrl -> unsupported with static catalog', async () => {
    const f = vi.fn();
    const r = await listProviderModels('s', { fetch: f as any, now, provider: { id: 's', type: 'http-api', models: ['m'] } });
    expect(r.supported).toBe(false);
    expect(r.models).toEqual([{ id: 'm', source: 'static' }]);
    expect(f).not.toHaveBeenCalled();
  });

  it('HTTP failure falls back to static without throwing or leaking the key', async () => {
    const f = vi.fn(async () => json({}, false, 500));
    const r = await listProviderModels('x', {
      fetch: f as any, now,
      provider: { id: 'x', type: 'http-api', baseUrl: 'https://h.example', apiKey: 'secret-key', models: ['m'] },
    });
    expect(r.models).toEqual([{ id: 'm', source: 'static' }]);
    expect(r.error).toContain('500');
    expect(JSON.stringify(r)).not.toContain('secret-key');
  });

  it('does not expose arbitrary fetch errors or accept oversized response bodies', async () => {
    const failingFetch = vi.fn(async () => { throw new Error('https://user:secret@host/path?key=secret'); });
    const failed = await listProviderModels('x', {
      fetch: failingFetch as any, now,
      provider: { id: 'x', type: 'http-api', baseUrl: 'https://h.example', apiKey: 'secret' },
    });
    expect(failed.error).toBe('Model listing failed');
    expect(JSON.stringify(failed)).not.toContain('secret');

    const large = await listProviderModels('large', {
      fetch: vi.fn(async () => ({ ok: true, text: async () => 'x'.repeat(1024 * 1024 + 1) }) as any), now,
      provider: { id: 'large', type: 'http-api', baseUrl: 'https://h.example' },
    });
    expect(large.error).toBe('Model listing failed');
  });
});

describe('cache', () => {
  const p = { id: 'x', type: 'http-api' as const, baseUrl: 'https://h.example' };

  it('caches within TTL, expires after, refresh bypasses', async () => {
    const f = vi.fn(async () => json({ data: [{ id: 'a' }] }));
    const o = { fetch: f as any, now, provider: p };
    expect((await listProviderModels('x', o)).cached).toBe(false);
    t += 1000;
    expect((await listProviderModels('x', o)).cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await listProviderModels('x', { ...o, refresh: true })).cached).toBe(false);
    t += 15 * 60 * 1000 + 1;
    expect((await listProviderModels('x', o)).cached).toBe(false);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('honours GATESWARM_DISCOVERY_TTL_MS', async () => {
    process.env.GATESWARM_DISCOVERY_TTL_MS = '50';
    const f = vi.fn(async () => json({ data: [] }));
    const o = { fetch: f as any, now, provider: p };
    await listProviderModels('x', o);
    t += 100;
    await listProviderModels('x', o);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('CLI listers', () => {
  const fs = (files: Record<string, string>) => ({
    homedir: () => '/home/u',
    readFile: async (p: string) => {
      if (p in files) return files[p];
      throw new Error('ENOENT');
    },
  });

  it('opencode uses `opencode models` output', async () => {
    const exec = vi.fn(async (..._a: any[]) => 'prov/a\nprov/b\n');
    const r = await listProviderModels('opencode', { exec, fs: fs({}), now, provider: { id: 'opencode', type: 'cli-agent' } });
    expect(exec).toHaveBeenCalledWith('opencode', ['models'], expect.any(Number));
    expect(r.models.map(m => m.id)).toEqual(['prov/a', 'prov/b']);
  });

  it('uses a fixed executable and bounds injected CLI output', async () => {
    const exec = vi.fn(async (..._a: any[]) => 'x'.repeat(1024 * 1024 + 1));
    const r = await listProviderModels('opencode', { exec, fs: fs({}), now, provider: { id: 'opencode', type: 'cli-agent' } });
    expect(exec).toHaveBeenCalledWith('opencode', ['models'], expect.any(Number));
    expect(r.models).toEqual([]);
  });

  it('falls back to config when exec fails', async () => {
    const exec = vi.fn(async (..._a: any[]): Promise<string> => { throw new Error('ENOENT'); });
    const r = await listProviderModels('opencode', {
      exec, now, provider: { id: 'opencode', type: 'cli-agent' },
      fs: fs({ '/home/u/.config/opencode/opencode.json': JSON.stringify({ model: 'p/m1', provider: { p: { models: { m2: {} } } } }) }),
    });
    expect(r.models.map(m => m.id).sort()).toEqual(['m2', 'p/m1']);
  });

  it('codex parses toml, claude parses json, missing files never fail', async () => {
    const exec = vi.fn();
    const c = await listProviderModels('codex', {
      now, exec, provider: { id: 'codex', type: 'cli-agent' },
      fs: fs({ '/home/u/.codex/config.toml': 'model = "gpt-x"\n[profiles.a]\nmodel = "gpt-y"\n' }),
    });
    expect(c.models.map(m => m.id)).toEqual(['gpt-x', 'gpt-y']);
    expect(exec).not.toHaveBeenCalled();
    const cl = await listProviderModels('claude', {
      now, exec, provider: { id: 'claude', type: 'cli-agent' },
      fs: fs({ '/home/u/.claude/settings.json': '{"model":"opus"}' }),
    });
    expect(cl.models).toEqual([{ id: 'opus', source: 'discovered' }]);
    const none = await listProviderModels('claude', { now, exec, provider: { id: 'claude', type: 'cli-agent' }, fs: fs({}), refresh: true });
    expect(none.models).toEqual([]);
  });

  it('parseCliConfigModels tolerates garbage', () => {
    expect(parseCliConfigModels('{{{ not')).toEqual([]);
    expect(parseCliConfigModels('x'.repeat(1024 * 1024 + 1))).toEqual([]);
  });
});
