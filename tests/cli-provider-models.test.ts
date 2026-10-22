import { describe, expect, it } from 'vitest';
import { formatProviderModels, parseModelsListArgs } from '../src/cli-models.js';

describe('models list CLI parsing and formatting', () => {
  it('parses provider, refresh and json options in any order', () => {
    expect(parseModelsListArgs(['list', '--refresh', 'openrouter', '--json'])).toEqual({
      provider: 'openrouter', refresh: true, json: true,
    });
    expect(parseModelsListArgs(['list'])).toEqual({ refresh: false, json: false });
    expect(parseModelsListArgs(['other'])).toBeNull();
    expect(() => parseModelsListArgs(['list', 'a', 'b'])).toThrow(/Unexpected/);
  });

  it('prints model ids and sources with cache, support and error notes', () => {
    expect(formatProviderModels([{
      provider: 'demo', cached: true, supported: false,
      data: [{ id: 'demo/model', source: 'static' }], error: 'Model listing failed',
    }])).toContain('demo: cached, unsupported\n');
    const output = formatProviderModels([{
      provider: 'demo', cached: true, supported: false,
      data: [{ id: 'demo/model', source: 'static' }], error: 'Model listing failed',
    }]);
    expect(output).toContain('demo/model');
    expect(output).toContain('static');
    expect(output).toContain('Note: Model listing failed');
  });
});
