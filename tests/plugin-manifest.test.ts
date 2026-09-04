import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The plugin ships as repo content, so nothing type-checks it. These tests are
 * the only thing standing between a typo in a manifest and a broken install.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugins', 'gateswarm');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

describe('marketplace manifest', () => {
  const marketplace = readJson(join(ROOT, '.claude-plugin', 'marketplace.json'));

  it('has the required name, owner and plugins fields', () => {
    expect(marketplace.name).toMatch(/^[a-z0-9-]+$/);
    expect(marketplace.owner?.name).toBeTruthy();
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
  });

  it('points every entry at a source directory that exists', () => {
    for (const p of marketplace.plugins) {
      expect(p.name).toMatch(/^[a-z0-9-]+$/);
      expect(typeof p.source).toBe('string');
      expect(p.source.startsWith('./')).toBe(true);
      expect(existsSync(join(ROOT, p.source))).toBe(true);
    }
  });
});

describe('plugin manifest', () => {
  const plugin = readJson(join(PLUGIN, '.claude-plugin', 'plugin.json'));

  it('uses a kebab-case name and a semver version', () => {
    expect(plugin.name).toMatch(/^[a-z0-9-]+$/);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plugin.description).toBeTruthy();
  });

  it('declares only supported userConfig types', () => {
    const allowed = new Set(['string', 'number', 'boolean', 'directory', 'file']);
    for (const [key, cfg] of Object.entries<any>(plugin.userConfig ?? {})) {
      expect(allowed.has(cfg.type), `${key} has type ${cfg.type}`).toBe(true);
      expect(cfg.title, `${key} needs a title`).toBeTruthy();
    }
  });
});

describe('bundled MCP server', () => {
  const mcp = readJson(join(PLUGIN, '.mcp.json'));

  it('registers the gateswarm server with a command', () => {
    expect(mcp.mcpServers?.gateswarm?.command).toBeTruthy();
    expect(Array.isArray(mcp.mcpServers.gateswarm.args)).toBe(true);
  });

  it('only interpolates userConfig keys the manifest actually declares', () => {
    const plugin = readJson(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    const declared = new Set(Object.keys(plugin.userConfig ?? {}));
    const refs = [...JSON.stringify(mcp).matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(declared.has(r), `undeclared user_config.${r}`).toBe(true);
  });
});

describe('skills and commands', () => {
  const frontmatter = (body: string) => {
    const m = /^---\n([\s\S]*?)\n---/.exec(body);
    expect(m, 'missing YAML frontmatter').toBeTruthy();
    return Object.fromEntries(
      m![1].split('\n').filter(Boolean).map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
    );
  };

  it('every skill has a name and a description that says when to use it', () => {
    const skillsDir = join(PLUGIN, 'skills');
    const skills = readdirSync(skillsDir);
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      const fm = frontmatter(readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf-8'));
      expect(fm.name).toBe(s);
      expect(fm.description.length).toBeGreaterThan(40);
    }
  });

  it('every command has a description', () => {
    const cmds = readdirSync(join(PLUGIN, 'commands')).filter((f) => f.endsWith('.md'));
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(frontmatter(readFileSync(join(PLUGIN, 'commands', c), 'utf-8')).description).toBeTruthy();
    }
  });

  it('the delegation skill names only tools the MCP server actually exposes', () => {
    const body = readFileSync(join(PLUGIN, 'skills', 'model-delegation', 'SKILL.md'), 'utf-8');
    const exposed = new Set([
      'route_prompt', 'route_session', 'submit_feedback', 'submit_outcome',
      'recalibrate_matrix', 'cost_report', 'telemetry_summary',
    ]);
    for (const ref of [...body.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])) {
      if (ref.includes('_') && !exposed.has(ref)) {
        // Only flag things that look like tool names, not field names.
        expect(['event_id', 'max_effort'].includes(ref), `skill references unknown tool \`${ref}\``).toBe(true);
      }
    }
  });
});
