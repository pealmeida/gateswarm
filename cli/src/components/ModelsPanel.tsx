/**
 * GateSwarm v0.5.4 — Models panel
 * Shows top models by recent usage
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ConsumptionReport } from '../types.js';
import { formatNumber } from '../format.js';

interface Props {
  consumption: ConsumptionReport;
  height?: number;
}

interface ModelSummary {
  provider: string;
  model: string;
  totalTokens: number;
  requests: number;
  errors: number;
  avgLatencyMs: number;
  isUnlimited: boolean;
}

export function ModelsPanel({ consumption, height = 12 }: Props) {
  // Synthesize a top-models view from provider consumption.
  // (Real /v05/intel/models would give per-model breakdown; this is a quick aggregation.)
  const modelSummary: ModelSummary[] = consumption.providers.flatMap((p) => {
    if (p.allTime.requests === 0) return [];
    return [{
      provider: p.provider,
      model: p.dailyAverage.tokens > 0 ? '(top by traffic)' : '—',
      totalTokens: p.allTime.totalTokens,
      requests: p.allTime.requests,
      errors: p.allTime.errors,
      avgLatencyMs: p.allTime.avgLatencyMs,
      isUnlimited: p.quota.fiveHour.limitRequests === null,
    }];
  });

  // Sort by total tokens desc
  modelSummary.sort((a, b) => b.totalTokens - a.totalTokens);

  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column" height={height}>
      <Box>
        <Text color="blue" bold>┌─ PROVIDER USAGE </Text>
        <Text dimColor>─ top by tokens (last 5h) ─</Text>
      </Box>
      {modelSummary.length === 0 && (
        <Text color="gray" dimColor>  no traffic yet — make a request to see data</Text>
      )}
      {modelSummary.slice(0, 8).map((m) => {
        const errColor = m.errors === 0 ? 'green' : 'red';
        return (
          <Box key={`${m.provider}-${m.model}`}>
            <Text>  </Text>
            <Text bold>{m.provider.padEnd(14)}</Text>
            <Text dimColor>  </Text>
            <Text>{String(m.requests).padStart(3)} req  </Text>
            <Text color="cyan" bold>{formatNumber(m.totalTokens).padStart(8)} tok  </Text>
            <Text dimColor>{(m.avgLatencyMs / 1000).toFixed(1)}s avg  </Text>
            <Text color={errColor}>{m.errors} err</Text>
            {m.isUnlimited && <Text dimColor>  (∞)</Text>}
          </Box>
        );
      })}
      {modelSummary.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>  total: {formatNumber(consumption.totalFiveHour.totalTokens)} tok in 5h across {modelSummary.length} providers</Text>
        </Box>
      )}
    </Box>
  );
}
