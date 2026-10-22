import { describe, expect, it, vi } from 'vitest';
import { formatProviderModels, listProviderModelsResilient, parseGatewayResponse, sanitizeGatewayErrorMessage } from '../src/cli-models.js';

describe('CLI provider model resilience', () => {
  it('returns structured errors for HTTP and non-JSON gateway responses', async () => {
    await expect(parseGatewayResponse(Response.json({ error: { message: 'missing' } }, { status: 404 })))
      .resolves.toEqual({ error: { message: 'missing', status: 404 } });
    await expect(parseGatewayResponse(new Response('<html>oops</html>', { status: 500 })))
      .resolves.toMatchObject({ error: { status: 500, message: expect.stringContaining('non-JSON') } });
    await expect(parseGatewayResponse(Response.json({ data: [] }))).resolves.toEqual({ data: [] });
    await expect(parseGatewayResponse(new Response(null, { status: 204 }))).resolves.toEqual({});
    await expect(parseGatewayResponse(new Response(''))).resolves.toEqual({});
    await expect(parseGatewayResponse(new Response('<html>oops</html>', { status: 200 })))
      .resolves.toMatchObject({ error: { status: 200, message: expect.stringContaining('non-JSON') } });
  });

  it('keeps successful and failed providers in the result array', async () => {
    const fetchListing = vi.fn(async (id: string) => {
      if (id === '404') return { error: { message: 'not found', status: 404 } };
      if (id === '500') return { error: { message: 'server error', status: 500 } };
      if (id === 'html') return { error: { message: 'non-JSON response', status: 200 } };
      if (id === 'network') throw new Error('network unavailable');
      return { provider: id, supported: true, cached: false, data: [{ id: 'm1', source: 'static' }] };
    });
    const results = await listProviderModelsResilient(['ok', '404', '500', 'html', 'network'], fetchListing);
    expect(results[0]).toMatchObject({ provider: 'ok', data: [{ id: 'm1' }] });
    expect(results.slice(1)).toEqual([
      { provider: '404', error: { message: 'not found', status: 404 } },
      { provider: '500', error: { message: 'server error', status: 500 } },
      { provider: 'html', error: { message: 'non-JSON response', status: 200 } },
      { provider: 'network', error: { message: 'network unavailable' } },
    ]);
    const table = formatProviderModels(results.map(listing => listing.error
      ? { provider: listing.provider, supported: false, cached: false, data: [], error: listing.error }
      : listing));
    expect(table).toContain('ok: fresh, supported');
    expect(table).toContain('Note: network unavailable');
  });

  it('removes control characters from error messages before display', () => {
    expect(sanitizeGatewayErrorMessage('bad\u0000token\nagain\u007f')).toBe('badtokenagain');
  });
});
