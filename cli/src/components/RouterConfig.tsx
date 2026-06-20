/**
 * GateSwarm v0.5.4 — Router config panel
 * Shows current configuration: static fallback, intel health, discovery, etc.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { IntelReport, ConsumptionReport } from '../types.js';

interface Props {
  intel: IntelReport;
  consumption: ConsumptionReport;
  height?: number;
}

export function RouterConfig({ intel, consumption, height = 14 }: Props) {
  const s = intel.stats;
  const errorRate = (s.errorRate * 100).toFixed(1);

  // Provider health
  const providerHealthRows = s.providers
    .filter((p) => p.totalRequests > 0 || p.availableModels > 0)
    .map((p) => ({
      ...p,
      errorRate: p.totalRequests > 0 ? (p.totalErrors / p.totalRequests) * 100 : 0,
    }))
    .sort((a, b) => b.totalRequests - a.totalRequests)
    .slice(0, 6);

  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column" height={height}>
      <Box>
        <Text color="yellow" bold>┌─ ROUTER CONFIG </Text>
        <Text dimColor>─ runtime state ─</Text>
      </Box>
      <Box>
        <Text>  v0.5.4 • token-consumption-intel • 408 models • 10 providers (live counts via /v05/intel)</Text>
      </Box>
      <Box>
        <Text dimColor>  Discovery: </Text>
        <Text>15min polling</Text>
        <Text dimColor>  |  </Text>
        <Text>Retention: </Text>
        <Text>35d</Text>
        <Text dimColor>  |  </Text>
        <Text>CWM: </Text>
        <Text color="green">90/10 enabled</Text>
      </Box>
      <Box>
        <Text dimColor>  TurboQuant: </Text>
        <Text color="green">v3.6 dynamic thresholds</Text>
        <Text dimColor>  |  </Text>
        <Text>Context budgets per tier (8K→500K)</Text>
      </Box>
      <Box>
        <Text dimColor>  Quota: </Text>
        <Text>5h/weekly/monthly</Text>
        <Text dimColor>  |  </Text>
        <Text color={s.totalErrors === 0 ? 'green' : 'red'}>Errors: {s.totalErrors} ({errorRate}%)</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>  ┌─ Provider health ─</Text>
      </Box>
      {providerHealthRows.map((p) => {
        const healthColor = p.errorRate === 0 ? 'green' : p.errorRate > 10 ? 'red' : 'yellow';
        return (
          <Box key={p.provider}>
            <Text>  </Text>
            <Text>{p.provider.padEnd(14)}</Text>
            <Text dimColor>  models: </Text>
            <Text>{p.availableModels}/{p.totalModels}</Text>
            <Text dimColor>  req: </Text>
            <Text>{p.totalRequests}</Text>
            <Text dimColor>  err: </Text>
            <Text color={healthColor}>{p.totalRequests > 0 ? p.errorRate.toFixed(0) + '%' : '—'}</Text>
            <Text dimColor>  lat: </Text>
            <Text>{p.avgLatencyMs > 0 ? (p.avgLatencyMs / 1000).toFixed(1) + 's' : '—'}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>  /v05/intel | /v05/intel/consumption | /v05/intel/quota</Text>
      </Box>
    </Box>
  );
}
