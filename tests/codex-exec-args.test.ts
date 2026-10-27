import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodexExecArgs, DEFAULT_CLI_PROVIDERS } from '../src/agent-registry.js';
import { CliProviderAdapter } from '../src/adapters/cli-provider.js';

describe('buildCodexExecArgs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the safe workspace-write default', () => {
    expect(buildCodexExecArgs({}))
      .toEqual(['exec', '--sandbox', 'workspace-write', '--model', '{model}', '-']);
  });

  it('adds the configured working and additional directories', () => {
    expect(buildCodexExecArgs({
      GATESWARM_CODEX_SANDBOX: 'read-only',
      GATESWARM_CODEX_WORKDIR: '/project',
      GATESWARM_CODEX_ADD_DIRS: '/one:/two',
    })).toEqual([
      'exec', '--sandbox', 'read-only', '--model', '{model}', '--cd', '/project',
      '--add-dir', '/one', '--add-dir', '/two', '-',
    ]);
  });

  it('requires the external-sandbox opt-in for danger-full-access', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildCodexExecArgs({ GATESWARM_CODEX_SANDBOX: 'danger-full-access' }))
      .toEqual(['exec', '--sandbox', 'workspace-write', '--model', '{model}', '-']);
    expect(warn).toHaveBeenCalledOnce();

    expect(buildCodexExecArgs({
      GATESWARM_CODEX_SANDBOX: 'danger-full-access',
      GATESWARM_EXTERNAL_SANDBOX: '1',
    })).toEqual(['exec', '--sandbox', 'danger-full-access', '--model', '{model}', '-']);
  });

  it('warns and falls back for an invalid sandbox mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildCodexExecArgs({ GATESWARM_CODEX_SANDBOX: 'unsafe-ish' }))
      .toEqual(['exec', '--sandbox', 'workspace-write', '--model', '{model}', '-']);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('codex-cli model routing', () => {
  const makeCodexAdapter = () => new CliProviderAdapter({
    command: 'codex',
    argsTemplate: buildCodexExecArgs({}),
    modelFlag: '--model',
    inputFormat: 'stdin',
    outputFormat: 'stdout-text',
    timeoutMs: 1000,
    maxTokens: 1000,
    maxConcurrent: 1,
  });

  it('substitutes the {model} placeholder with the routed model', () => {
    const adapter = makeCodexAdapter();
    expect((adapter as any).buildArgs('prompt', 'gpt-x', {}))
      .toEqual(['exec', '--sandbox', 'workspace-write', '--model', 'gpt-x', '-']);
  });

  it('drops the --model pair when no model is given', () => {
    const adapter = makeCodexAdapter();
    expect((adapter as any).buildArgs('prompt', '', {}))
      .toEqual(['exec', '--sandbox', 'workspace-write', '-']);
  });

  it('registers codex-cli with a model flag and placeholder', () => {
    const entry = DEFAULT_CLI_PROVIDERS['codex-cli'];
    const template = entry.cliConfig.argsTemplate;
    const idx = template.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(template[idx + 1]).toBe('{model}');
    expect(entry.cliConfig.modelFlag).toBe('--model');
  });
});
