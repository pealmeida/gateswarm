/**
 * GateSwarm v0.5.6 — Header component
 * Shows status summary at top of TUI
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ConsumptionReport, IntelReport } from '../types.js';
import { formatNumber } from '../format.js';

interface Props {
  intel?: IntelReport;
  consumption?: ConsumptionReport;
  serverOk: boolean;
  lastUpdate: Date;
  refreshInterval: number;
}

export function Header({ intel, consumption, serverOk, lastUpdate, refreshInterval }: Props) {
  if (!serverOk) {
    return (
      <Box borderStyle="round" borderColor="red" paddingX={1}>
        <Text color="red" bold>● GateSwarm v0.5.6 — SERVER UNREACHABLE</Text>
      </Box>
    );
  }

  if (!intel || !consumption) {
    return (
      <Box borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow">● GateSwarm v0.5.6 — Loading…</Text>
      </Box>
    );
  }

  const s = intel.stats;
  const errorRate = (s.errorRate * 100).toFixed(1);
  const errorColor = s.totalErrors === 0 ? 'green' : s.errorRate > 0.05 ? 'red' : 'yellow';

  // Check if we have recent synced data
  const synced = consumption && (consumption as any).syncedAt;
  const syncedAge = synced ? Math.round((Date.now() - new Date(synced).getTime()) / 60000) : null;

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box>
        <Text color="cyan" bold>● GateSwarm v{intel.version} </Text>
        <Text dimColor>| </Text>
        <Text>{s.totalModels} models </Text>
        <Text dimColor>({s.availableModels} avail, {s.unhealthyModels} unhlth) </Text>
        <Text dimColor>| </Text>
        <Text>{consumption.totalProviders} providers </Text>
        <Text dimColor>| </Text>
        <Text>{s.totalRequests} reqs </Text>
        <Text dimColor>| </Text>
        <Text color={errorColor}>{s.totalErrors} err ({errorRate}%) </Text>
        <Text dimColor>| </Text>
        <Text color="green">${s.estimatedCost.toFixed(4)}</Text>
      </Box>
      <Box>
        <Text dimColor>last update: {lastUpdate.toLocaleTimeString()} | refresh: {refreshInterval}s | tokens: </Text>
        <Text>{formatNumber(s.totalTokensIn)} in + {formatNumber(s.totalTokensOut)} out = </Text>
        <Text color="cyan" bold>{formatNumber(s.totalTokensIn + s.totalTokensOut)} total</Text>
        {syncedAge !== null && syncedAge < 10 && (
          <Text dimColor> | sync: </Text>
        )}
        {syncedAge !== null && syncedAge < 10 && (
          <Text color="green" bold>●</Text>
        )}
        {syncedAge !== null && syncedAge >= 10 && (
          <Text dimColor> | sync: stale</Text>
        )}
      </Box>
    </Box>
  );
}
