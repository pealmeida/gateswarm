export interface ModelsListOptions {
  provider?: string;
  refresh: boolean;
  json: boolean;
}

export interface GatewayError {
  error: { message: string; status?: number };
}

/** Parse gateway responses without allowing HTTP or content-type failures to escape as JSON errors. */
export async function parseGatewayResponse(res: Response): Promise<any | GatewayError> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { error: { message: `Gateway returned a non-JSON response${res.status ? ` (HTTP ${res.status})` : ''}`, status: res.status } };
  }
  if (res.ok && !text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (res.ok && !text.trim()) return {};
    return { error: { message: `Gateway returned a non-JSON response${res.status ? ` (HTTP ${res.status})` : ''}`, status: res.status } };
  }
  if (!res.ok) {
    const message = (body as any)?.error?.message || `Gateway request failed (HTTP ${res.status})`;
    return { error: { message, status: res.status } };
  }
  return body;
}

export function sanitizeGatewayErrorMessage(message: unknown): string {
  return String(message ?? '').replace(/[\x00-\x1f\x7f]/g, '');
}

export async function listProviderModelsResilient(
  ids: string[], fetchListing: (id: string) => Promise<any>,
): Promise<any[]> {
  return Promise.all(ids.map(async provider => {
    try {
      const result = await fetchListing(provider);
      if (result?.error) return { provider, error: result.error };
      return { ...result, provider: result?.provider || provider };
    } catch (error) {
      return { provider, error: { message: error instanceof Error ? error.message : 'Model listing request failed' } };
    }
  }));
}

export function parseModelsListArgs(args: string[]): ModelsListOptions | null {
  if (args[0] !== 'list') return null;
  const options: ModelsListOptions = { refresh: false, json: false };
  for (const arg of args.slice(1)) {
    if (arg === '--refresh') options.refresh = true;
    else if (arg === '--json') options.json = true;
    else if (!arg.startsWith('-') && options.provider === undefined) options.provider = arg;
    else throw new Error(`Unexpected models list argument: ${arg}`);
  }
  return options;
}

export function formatProviderModels(listings: any[]): string {
  return listings.map(listing => {
    const lines = [`${listing.provider}: ${listing.cached ? 'cached' : 'fresh'}, ${listing.supported ? 'supported' : 'unsupported'}`];
    lines.push('ID'.padEnd(42) + 'SOURCE');
    lines.push('─'.repeat(50));
    for (const model of listing.data || []) lines.push(`${String(model.id).padEnd(42)}${model.source}`);
    if (listing.error) lines.push(`Note: ${typeof listing.error === 'string' ? listing.error : listing.error.message}`);
    return lines.join('\n');
  }).join('\n\n');
}
