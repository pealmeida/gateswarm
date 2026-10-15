import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodexExecArgs } from '../src/agent-registry.js';

describe('buildCodexExecArgs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the safe workspace-write default', () => {
    expect(buildCodexExecArgs({})).toEqual(['exec', '--sandbox', 'workspace-write', '-']);
  });

  it('adds the configured working and additional directories', () => {
    expect(buildCodexExecArgs({
      GATESWARM_CODEX_SANDBOX: 'read-only',
      GATESWARM_CODEX_WORKDIR: '/project',
      GATESWARM_CODEX_ADD_DIRS: '/one:/two',
    })).toEqual([
      'exec', '--sandbox', 'read-only', '--cd', '/project',
      '--add-dir', '/one', '--add-dir', '/two', '-',
    ]);
  });

  it('requires the external-sandbox opt-in for danger-full-access', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildCodexExecArgs({ GATESWARM_CODEX_SANDBOX: 'danger-full-access' }))
      .toEqual(['exec', '--sandbox', 'workspace-write', '-']);
    expect(warn).toHaveBeenCalledOnce();

    expect(buildCodexExecArgs({
      GATESWARM_CODEX_SANDBOX: 'danger-full-access',
      GATESWARM_EXTERNAL_SANDBOX: '1',
    })).toEqual(['exec', '--sandbox', 'danger-full-access', '-']);
  });

  it('warns and falls back for an invalid sandbox mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(buildCodexExecArgs({ GATESWARM_CODEX_SANDBOX: 'unsafe-ish' }))
      .toEqual(['exec', '--sandbox', 'workspace-write', '-']);
    expect(warn).toHaveBeenCalledOnce();
  });
});
