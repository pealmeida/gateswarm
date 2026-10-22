export interface ModelsListOptions {
  provider?: string;
  refresh: boolean;
  json: boolean;
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
    if (listing.error) lines.push(`Note: ${listing.error}`);
    return lines.join('\n');
  }).join('\n\n');
}
