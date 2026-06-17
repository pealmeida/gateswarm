/**
 * GateSwarm v0.5.4 — Tiers matrix panel
 * Shows the 6-tier routing recommendations and candidates
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { IntelReport, ConsumptionReport } from '../types.js';

interface Props {
  intel: IntelReport;
  consumption: ConsumptionReport;
  height?: number;
}

const TIER_COLORS: Record<string, string> = {
  trivial: 'gray',
  light: 'cyan',
  moderate: 'green',
  heavy: 'yellow',
  intensive: 'magenta',
  extreme: 'red',
};

const TIER_EMOJI: Record<string, string> = {
  trivial: '○',
  light: '◌',
  moderate: '◔',
  heavy: '◑',
  intensive: '◕',
  extreme: '●',
};

export function TiersMatrix({ intel, consumption, height = 14 }: Props) {
  const tiers: Array<keyof typeof intel.recommendations> = [
    'trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme',
  ];
  const td = intel.stats.tierDistribution;

  return (
    <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column" height={height}>
      <Box>
        <Text color="magenta" bold>┌─ TIERS MATRIX </Text>
        <Text dimColor>─ 6-tier dynamic routing ─</Text>
      </Box>
      {tiers.map((tier) => {
        const rec = intel.recommendations[tier];
        if (!rec) return null;
        const candidates = td[tier] || 0;
        const conf = (rec.confidence * 100).toFixed(0);
        const confColor = rec.confidence >= 0.8 ? 'green' : rec.confidence >= 0.5 ? 'yellow' : 'red';
        const reasonColor = rec.reason === 'cheapest_available' ? 'green' :
          rec.reason === 'static_fallback' ? 'yellow' : 'cyan';
        return (
          <Box key={tier}>
            <Text>  </Text>
            <Text color={TIER_COLORS[tier]} bold>{TIER_EMOJI[tier]} {tier.padEnd(10)}</Text>
            <Text dimColor>→ </Text>
            <Text bold>{rec.provider.padEnd(13)}</Text>
            <Text>/{rec.model.padEnd(28)}</Text>
            <Text dimColor> conf=</Text>
            <Text color={confColor}>{conf}%</Text>
            <Text dimColor>  </Text>
            <Text color={reasonColor}>[{rec.reason}]</Text>
            <Text dimColor>  ({candidates} candidates)</Text>
          </Box>
        );
      })}
    </Box>
  );
}
