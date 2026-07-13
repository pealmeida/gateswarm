import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getEnsembleWeights, setEnsembleWeights } from '../src/ensemble-voter.js';
import { DEFAULT_V04_CONFIG, getConfig, getConfigReloadHealth, loadConfig, saveConfig } from '../src/v04-config.js';

function cloneConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_V04_CONFIG));
}

async function withTemporaryConfig(test: (configFile: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gateswarm-v04-config-'));
  const configFile = join(directory, 'v04_config.json');
  const originalConfigFile = process.env.GATESWARM_CONFIG_FILE;
  process.env.GATESWARM_CONFIG_FILE = configFile;

  try {
    await writeFile(configFile, JSON.stringify(cloneConfig(), null, 2), 'utf-8');
    await loadConfig(true);
    await test(configFile);
  } finally {
    if (originalConfigFile === undefined) delete process.env.GATESWARM_CONFIG_FILE;
    else process.env.GATESWARM_CONFIG_FILE = originalConfigFile;
    await loadConfig(true);
    await rm(directory, { recursive: true, force: true });
  }
}

describe('v04 config ensemble activation', () => {
  it('defaults the live voter to heuristic-only routing', () => {
    expect(getEnsembleWeights()).toEqual({
      heuristic: 1,
      cascade: 0,
      ragSignal: 0,
      historyBias: 0,
    });
  });

  it('applies configured ensemble weights to the live voter on load', async () => {
    setEnsembleWeights({ heuristic: 0, cascade: 1, ragSignal: 0, historyBias: 0.2 });

    await loadConfig();

    expect(getEnsembleWeights()).toEqual(DEFAULT_V04_CONFIG.ensemble.weights);
  });

  it('rejects partial and corrupt configs while retaining the last-known-good config', async () => {
    await withTemporaryConfig(async configFile => {
      const lastKnownGood = await loadConfig(true);
      const partialConfig = cloneConfig();
      delete partialConfig.tier_models.heavy;
      await writeFile(configFile, JSON.stringify(partialConfig), 'utf-8');

      expect(await loadConfig(true)).toBe(lastKnownGood);
      expect(getConfig()).toBe(lastKnownGood);
      expect(getConfigReloadHealth()).toMatchObject({
        ok: false,
        lastError: 'Invalid configuration: tier_models.heavy is required',
        source: 'file',
      });

      await writeFile(configFile, '{ not valid json', 'utf-8');
      expect(await loadConfig(true)).toBe(lastKnownGood);
      expect(getConfigReloadHealth()).toMatchObject({ ok: false, lastError: expect.any(String) });
    });
  });

  it('atomically saves complete JSON and preserves the previous file as a backup', async () => {
    await withTemporaryConfig(async configFile => {
      const oldConfig = cloneConfig();
      const newConfig = cloneConfig();
      newConfig.tier_models.trivial.model = 'replacement-model';
      await writeFile(configFile, JSON.stringify(oldConfig, null, 2), 'utf-8');
      await loadConfig(true);

      await saveConfig(newConfig);

      expect(JSON.parse(await readFile(configFile, 'utf-8'))).toEqual(newConfig);
      expect(JSON.parse(await readFile(`${configFile}.bak`, 'utf-8'))).toEqual(oldConfig);
    });
  });
});
