export interface SkippableLiveRow {
  skipped?: boolean;
}

export interface SkippedSummary {
  provider: string;
  reason: string;
  count: number;
}

export function providerFromRouted(header: string): string {
  const routed = header.trim();
  const slash = routed.indexOf('/');
  return slash >= 0 ? routed.slice(0, slash) : routed;
}

export function markProviderUnhealthy(
  unhealthyProviders: Map<string, string>,
  routedModel: string,
  reason: string,
): void {
  const provider = providerFromRouted(routedModel);
  if (provider && !unhealthyProviders.has(provider)) {
    unhealthyProviders.set(provider, reason);
  }
}

export function providerSkipReason(
  unhealthyProviders: ReadonlyMap<string, string>,
  routedModel: string,
): string | undefined {
  const provider = providerFromRouted(routedModel);
  return provider ? unhealthyProviders.get(provider) : undefined;
}

export function rowsForLiveScoring<T extends SkippableLiveRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => !r.skipped);
}

export function summarizeSkippedRows<T extends SkippableLiveRow & { routedModel?: string; reason?: string }>(
  rows: readonly T[],
): SkippedSummary[] {
  const counts = new Map<string, SkippedSummary>();
  for (const row of rows.filter((r) => r.skipped)) {
    const provider = providerFromRouted(row.routedModel || '') || '(unknown)';
    const reason = row.reason || 'unknown';
    const key = `${provider}\t${reason}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { provider, reason, count: 1 });
  }
  return [...counts.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.reason.localeCompare(b.reason));
}
