/**
 * GateSwarm v0.5.4 — Main TUI App
 * Composes all panels in a 2-column responsive layout
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Header } from './Header.js';
import { ProvidersPanel } from './ProvidersPanel.js';
import { ModelsPanel } from './ModelsPanel.js';
import { TiersMatrix } from './TiersMatrix.js';
import { RouterConfig } from './RouterConfig.js';
import { ActivityPanel } from './ActivityPanel.js';
import { GateSwarmAPI } from '../api.js';
import { mockConsumption, mockIntel } from '../mock.js';
import type { ConsumptionReport, IntelReport, SyncedQuotaReport } from '../types.js';

interface Props {
  baseUrl: string;
  refreshInterval: number;
  mock: boolean;
  panel?: 'overview' | 'providers' | 'tiers' | 'activity';
}

type Tab = 'overview' | 'providers' | 'tiers' | 'activity';

/**
 * TTY-safe keyboard input. When running in a non-TTY context (e.g., piped
 * output, CI), Ink's setRawMode would throw. We detect this and skip the
 * input handler entirely; the snapshot mode below handles non-TTY.
 */
function useTuiInput(handler: (input: string, key: any) => void) {
  const isTty = Boolean(process.stdin.isTTY);
  try {
    useInput(handler, { isActive: isTty });
  } catch {
    // Non-TTY: input disabled.
  }
}

export function App({ baseUrl, refreshInterval, mock, panel = 'overview' }: Props) {
  const { exit } = useApp();
  const [tab, setTab] = useState<Tab>(panel);
  const [consumption, setConsumption] = useState<ConsumptionReport | null>(
    mock ? mockConsumption : null,
  );
  const [intel, setIntel] = useState<IntelReport | null>(mock ? mockIntel : null);
  const [synced, setSynced] = useState<SyncedQuotaReport | null>(null);
  const [serverOk, setServerOk] = useState<boolean>(mock ? true : false);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [error, setError] = useState<string | null>(null);

  const api = new GateSwarmAPI(baseUrl);

  const fetchData = async () => {
    if (mock) {
      setConsumption(mockConsumption);
      setIntel(mockIntel);
      setServerOk(true);
      setLastUpdate(new Date());
      return;
    }
    try {
      const [c, i, s] = await Promise.all([
        api.getConsumption(),
        api.getIntel(),
        api.getSyncedQuota().catch(() => null),
      ]);
      setConsumption(c);
      setIntel(i);
      setSynced(s);
      setServerOk(true);
      setError(null);
      setLastUpdate(new Date());
    } catch (e: any) {
      setServerOk(false);
      setError(e.message);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [refreshInterval]);

  useTuiInput((input, key) => {
    if (input === 'q' || key.ctrl || key.escape) {
      exit();
    } else if (input === '1') setTab('overview');
    else if (input === '2') setTab('providers');
    else if (input === '3') setTab('tiers');
    else if (input === '4') setTab('activity');
    else if (input === 'r') fetchData();
  });

  // Non-TTY: render a single snapshot and exit. Useful for piping to file or
  // embedding in logs (the `--once` flag is the recommended path for that,
  // but this also keeps the TUI useful in restricted environments).
  if (!process.stdin.isTTY) {
    return (
      <Box flexDirection="column">
        <Header
          intel={intel ?? undefined}
          consumption={consumption ?? undefined}
          serverOk={serverOk}
          lastUpdate={lastUpdate}
          refreshInterval={refreshInterval}
        />
        {!serverOk && error && (
          <Box paddingX={1}>
            <Text color="red">⚠  {error}</Text>
          </Box>
        )}
        {consumption && (
          <Box flexDirection="row">
            <ProvidersPanel consumption={consumption} synced={synced} height={20} />
            <ModelsPanel consumption={consumption} height={20} />
          </Box>
        )}
        {consumption && intel && (
          <Box flexDirection="row">
            <TiersMatrix intel={intel} consumption={consumption} height={14} />
            <RouterConfig intel={intel} consumption={consumption} height={14} />
          </Box>
        )}
        {intel && (
          <ActivityPanel intel={intel} height={10} />
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header
        intel={intel ?? undefined}
        consumption={consumption ?? undefined}
        serverOk={serverOk}
        lastUpdate={lastUpdate}
        refreshInterval={refreshInterval}
      />

      {!serverOk && error && (
        <Box paddingX={1}>
          <Text color="red">⚠  {error}</Text>
        </Box>
      )}

      <Box paddingX={1}>
        <Text dimColor>[1]overview [2]providers [3]tiers [4]activity  </Text>
        <Text color="cyan" bold>{tab}</Text>
        <Text dimColor>  [r]refresh [q]quit</Text>
      </Box>

      {consumption && intel && tab === 'overview' && (
        <Box flexDirection="row">
          <ProvidersPanel consumption={consumption} synced={synced} height={16} />
          <ModelsPanel consumption={consumption} height={16} />
        </Box>
      )}

      {consumption && intel && tab === 'overview' && (
        <Box flexDirection="row">
          <TiersMatrix intel={intel} consumption={consumption} height={14} />
          <RouterConfig intel={intel} consumption={consumption} height={14} />
        </Box>
      )}

      {consumption && intel && tab === 'overview' && (
        <Box flexDirection="row">
          <ActivityPanel intel={intel} height={10} />
        </Box>
      )}

      {consumption && intel && tab === 'providers' && (
        <Box flexDirection="column">
          <ProvidersPanel consumption={consumption} synced={synced} height={20} />
          <ModelsPanel consumption={consumption} height={16} />
        </Box>
      )}

      {consumption && intel && tab === 'tiers' && (
        <Box flexDirection="column">
          <TiersMatrix intel={intel} consumption={consumption} height={16} />
          <RouterConfig intel={intel} consumption={consumption} height={14} />
        </Box>
      )}

      {intel && tab === 'activity' && (
        <Box flexDirection="column">
          <ActivityPanel intel={intel} height={20} />
        </Box>
      )}
    </Box>
  );
}
