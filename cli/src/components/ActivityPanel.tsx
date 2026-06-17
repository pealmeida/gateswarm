/**
 * GateSwarm v0.5.6 — Activity panel
 * Shows recent routing decisions and live traffic
 *
 * v0.5.6: Filter out health-check / balance-check / recovery-check decisions
 * from the live activity feed. Those decisions come from background polling
 * (balance check, recovery check, tier-recommendation refresh) and have
 * nothing to do with real user traffic. Showing them confused operators
 * into thinking their prompt was routed to a tier it never actually hit.
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
  // v0.5.6: only show real request decisions. Health/balance/recovery checks
  // pollute the feed and have caused false-positive "wrong tier" reports.
  const allDecisions = intel.recentDecisions ?? [];
  const decisions = allDecisions
    .filter((d: any) => !d.source || d.source === 'request')
    .slice(0, 8);

  const hiddenCount = allDecisions.length - decisions.length;

  return (
    <Box borderStyle="round" borderColor="white" paddingX={1} flexDirection="column" height={height}>
      <Box>
        <Text color="white" bold>┌─ LIVE ACTIVITY </Text>
        <Text dimColor>─ last {decisions.length} request routing decisions ─</Text>
        {hiddenCount > 0 && (
          <Text dimColor>  ({hiddenCount} health checks hidden)</Text>
        )}
      </Box>
      {decisions.length === 0 ? (
        <Text color="gray" dimColor>  no recent request decisions — make a request via /v1/chat/completions</Text>
      ) : (
        decisions.map((d, i) => {
          const tierColor = {
            trivial: 'gray', light: 'cyan', moderate: 'green',
            heavy: 'yellow', intensive: 'magenta', extreme: 'red',
          }[d.tier] || 'white';
          const conf = (d.confidence * 100).toFixed(0);
          const ts = d.timestamp || (Date.now() - i * 5000);
          return (
            <Box key={i}>
              <Text>  </Text>
              <Text dimColor>#{String(i + 1).padStart(2)} </Text>
              <Text color={tierColor} bold>{d.tier.padEnd(10)}</Text>
              <Text>→ </Text>
              <Text>{d.provider}/{d.model.padEnd(28)}</Text>
              <Text dimColor> conf={conf}% </Text>
              <Text dimColor>[{d.reason}] </Text>
              <Text dimColor>{timeAgo(ts)}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
