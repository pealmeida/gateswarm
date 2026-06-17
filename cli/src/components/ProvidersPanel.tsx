/**
 * GateSwarm v0.5.4 — Providers panel
 * Shows each provider with 5h/weekly/monthly quota bars
 *
 * v0.5.4: When synced quota data is available (from real provider dashboards),
 * shows real percentages with [synced] marker. Falls back to internal tracking.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ConsumptionReport, SyncedQuotaReport } from '../types.js';
import { formatNumber, pctColor, usageBar } from '../format.js';

interface Props {
  consumption: ConsumptionReport;
  synced?: SyncedQuotaReport | null;
  height?: number;
}

interface WindowDisplay {
  usedPct: number | null;
  usedTokens: number;
  limitTokens: number | null;
  resetAt: string;
  isReal: boolean;
}

export function ProvidersPanel({ consumption, synced, height = 14 }: Props) {
  const providers = consumption.providers.slice(0, 6); // Top 6

  // Helper: get real window data if available
  const getRealWindow = (provider: string, windowKey: string): WindowDisplay | null => {
    if (!synced) return null;
    const snap = synced.snapshots?.[provider];
    if (!snap) return null;
    const w = snap.windows?.[windowKey];
    if (!w) return null;
    return {
      usedPct: w.usedPctTokens ?? w.usedPctRequests,
      usedTokens: w.usedTokens ?? 0,
      limitTokens: w.limitTokens,
      resetAt: w.resetAt,
      isReal: true,
    };
  };

  return (
    <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="column" height={height}>
      <Box>
        <Text color="green" bold>┌─ PROVIDERS ({consumption.totalProviders}) </Text>
        <Text dimColor>─ quota remaining per window</Text>
        {synced && synced.snapshots && Object.keys(synced.snapshots).length > 0 && (
          <Text color="cyan"> [real data]</Text>
        )}
      </Box>
      {providers.length === 0 && (
        <Text color="gray" dimColor>  no providers with usage yet</Text>
      )}
      {providers.map((p) => {
        // Prefer real synced data, fall back to internal tracking
        const fh5h = getRealWindow(p.provider, '5h');
        const wk7d = getRealWindow(p.provider, '7d');
        const mo30d = getRealWindow(p.provider, '30d');

        // Fallback to internal quota
        const fh = p.quota.fiveHour;
        const wk = p.quota.weekly;
        const mo = p.quota.monthly;

        // Pick best available source
        const display5h = fh5h ?? {
          usedPct: fh.usedPctTokens ?? fh.usedPctRequests,
          usedTokens: fh.usedTokens,
          limitTokens: fh.limitTokens,
          resetAt: fh.resetAt,
          isReal: false,
        };
        const displayWk = wk7d ?? {
          usedPct: wk.usedPctTokens ?? wk.usedPctRequests,
          usedTokens: wk.usedTokens,
          limitTokens: wk.limitTokens,
          resetAt: wk.resetAt,
          isReal: false,
        };
        const displayMo = mo30d ?? {
          usedPct: mo.usedPctTokens ?? mo.usedPctRequests,
          usedTokens: mo.usedTokens,
          limitTokens: mo.limitTokens,
          resetAt: mo.resetAt,
          isReal: false,
        };

        return (
          <Box key={p.provider} flexDirection="column" marginTop={0}>
            <Box>
              <Text>  </Text>
              <Text bold color="white">{p.provider.padEnd(14)}</Text>
              <Text dimColor>  5h: </Text>
              <Text color={pctColor(display5h.usedPct)}>{usageBar(display5h.usedPct, 8)}</Text>
              <Text> {display5h.usedPct !== null ? `${display5h.usedPct.toFixed(1)}%` : 'N/A'} </Text>
              <Text color={pctColor(display5h.usedPct)}>
                {formatNumber(display5h.usedTokens)}/{display5h.limitTokens === null ? '∞' : formatNumber(display5h.limitTokens)} tok
              </Text>
              {display5h.isReal && <Text color="cyan" bold> ✓</Text>}
              {fh.etaExhaustion && !display5h.isReal && (
                <Text color="red" bold> ⚠ETA</Text>
              )}
            </Box>
            <Box>
              <Text>  </Text>
              <Text dimColor>             </Text>
              <Text dimColor>  wk: </Text>
              <Text color={pctColor(displayWk.usedPct)}>{usageBar(displayWk.usedPct, 8)}</Text>
              <Text dimColor> {displayWk.usedPct !== null ? `${displayWk.usedPct.toFixed(1)}%` : 'N/A'} </Text>
              <Text dimColor>
                {formatNumber(displayWk.usedTokens)}/{displayWk.limitTokens === null ? '∞' : formatNumber(displayWk.limitTokens)} tok
              </Text>
              {displayWk.isReal && <Text color="cyan" dimColor> ✓</Text>}
            </Box>
            <Box>
              <Text>  </Text>
              <Text dimColor>             </Text>
              <Text dimColor>  mo: </Text>
              <Text color={pctColor(displayMo.usedPct)}>{usageBar(displayMo.usedPct, 8)}</Text>
              <Text dimColor> {displayMo.usedPct !== null ? `${displayMo.usedPct.toFixed(1)}%` : 'N/A'} </Text>
              <Text dimColor>
                {formatNumber(displayMo.usedTokens)}/{displayMo.limitTokens === null ? '∞' : formatNumber(displayMo.limitTokens)} tok
              </Text>
              {displayMo.isReal && <Text color="cyan" dimColor> ✓</Text>}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
