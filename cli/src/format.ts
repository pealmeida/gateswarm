/**
 * GateSwarm v0.5.6 — Visual primitives
 * Bar renderer, color helpers, formatting
 */

import { QuotaWindowStatus } from './types.js';

/** Render a horizontal usage bar with color based on % used */
export function usageBar(pct: number | null, width = 10): string {
  if (pct === null) return '∞'.padEnd(width);
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const symbol = pct >= 90 ? '█' : pct >= 60 ? '▓' : '▰';
  return symbol.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

/** Color tag based on % used */
export function pctColor(pct: number | null): 'green' | 'yellow' | 'red' | 'gray' {
  if (pct === null) return 'gray';
  if (pct >= 80) return 'red';
  if (pct >= 50) return 'yellow';
  return 'green';
}

/** Format duration in ms → human readable */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

/** Format number with K/M suffix */
export function formatNumber(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Format pct with safety for null */
export function formatPct(pct: number | null): string {
  return pct === null ? '∞' : `${pct.toFixed(1)}%`;
}

/** Render a single window's quota status as a one-liner */
export function renderQuotaLine(
  label: string,
  q: QuotaWindowStatus,
  width = 10,
): string {
  const bar = usageBar(q.usedPctRequests, width);
  const color = pctColor(q.usedPctRequests);
  const pct = formatPct(q.usedPctRequests);
  const tokPct = formatPct(q.usedPctTokens);
  const reqText = q.limitRequests === null
    ? '∞ req'
    : `${q.usedRequests}/${q.limitRequests}`;
  const tokText = q.limitTokens === null
    ? '∞ tok'
    : `${formatNumber(q.usedTokens)}/${formatNumber(q.limitTokens!)}`;
  return `${label} [${bar}] ${pct} ${reqText} (${tokText} ${tokPct})`;
}
