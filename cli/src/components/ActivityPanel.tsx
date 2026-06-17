/**
 * GateSwarm v0.5.4 — Activity panel
 * Shows recent routing decisions and live traffic
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { IntelReport } from '../types.js';

interface Props {
  intel: IntelReport;
  height?: number;
}

function timeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function ActivityPanel({ intel, height = 10 }: Props) {
  const decisions = intel.recentDecisions.slice(0, 8);

  return (
    <Box borderStyle="round" borderColor="white" paddingX={1} flexDirection="column" height={height}>
      <Box>
        <Text color="white" bold>┌─ LIVE ACTIVITY </Text>
        <Text dimColor>─ last {decisions.length} routing decisions ─</Text>
      </Box>
      {decisions.length === 0 ? (
        <Text color="gray" dimColor>  no recent decisions — make a request via /v1/chat/completions</Text>
      ) : (
        decisions.map((d, i) => {
          const tierColor = {
            trivial: 'gray', light: 'cyan', moderate: 'green',
            heavy: 'yellow', intensive: 'magenta', extreme: 'red',
          }[d.tier] || 'white';
          const conf = (d.confidence * 100).toFixed(0);
          return (
            <Box key={i}>
              <Text>  </Text>
              <Text dimColor>#{String(i + 1).padStart(2)} </Text>
              <Text color={tierColor} bold>{d.tier.padEnd(10)}</Text>
              <Text>→ </Text>
              <Text>{d.provider}/{d.model.padEnd(28)}</Text>
              <Text dimColor> conf={conf}% </Text>
              <Text dimColor>[{d.reason}]</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
