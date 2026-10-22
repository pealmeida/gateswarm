import { describe, expect, it, vi } from 'vitest';
import { parseProviderModelPath, providerModelsResponse } from '../src/moma-gateway.js';

describe('provider model listing endpoint helpers', () => {
  it('decodes and validates provider ids', () => {
    expect(parseProviderModelPath('/v1/providers/a%2Eb/models')).toEqual({ id: 'a.b' });
    expect(parseProviderModelPath('/v1/providers/bad%2Fid/models')).toEqual({ error: 'invalid provider id' });
    expect(parseProviderModelPath('/v1/providers/%ZZ/models')).toEqual({ error: 'invalid provider id' });
    expect(parseProviderModelPath('/v1/providers/a/models/extra')).toBeNull();
  });

  it('returns only public listing fields and forwards refresh', async () => {
    const lister = vi.fn(async (_id: string, _opts: { refresh?: boolean }) => ({
      provider: 'safe', supported: true, cached: false, fetchedAt: 123,
      models: [{ id: 'm1', source: 'discovered' as const }], error: 'HTTP 503',
    }));
    const result = await providerModelsResponse('safe', true, lister);
    expect(lister).toHaveBeenCalledWith('safe', { refresh: true });
    expect(result).toEqual({ status: 200, body: {
      object: 'list', provider: 'safe', supported: true, cached: false, fetched_at: 123,
      data: [{ id: 'm1', source: 'discovered' }], error: 'HTTP 503',
    } });
    expect(JSON.stringify(result)).not.toContain('apiKey');
  });

  it('maps unknown providers to a JSON 404', async () => {
    const result = await providerModelsResponse('missing', false, async () => ({
      provider: 'missing', supported: false, cached: false, fetchedAt: 1, models: [], error: 'unknown provider',
    }));
    expect(result).toEqual({ status: 404, body: { error: { message: 'Unknown provider: missing', type: 'not_found' } } });
  });
});
