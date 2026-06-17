#!/usr/bin/env node
/**
 * GateSwarm v0.5.4 — CLI entry point
 *
 * Usage:
 *   gateswarm-bar                     # default: http://localhost:8900, refresh 10s
 *   gateswarm-bar --mock              # use built-in mock data (no server needed)
 *   gateswarm-bar --url http://x:8900 # custom server
 *   gateswarm-bar --refresh 5         # 5s refresh interval
 *   gateswarm-bar --tab providers     # start on providers tab
 *   gateswarm-bar --once              # print once and exit (no TUI)
 */

import React from 'react';
import { render } from 'ink';
import { App } from './components/App.js';

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    url: getArg(args, '--url') ?? process.env.GATESWARM_URL ?? 'http://localhost:8900',
    refresh: parseInt(getArg(args, '--refresh') ?? '10', 10),
    mock: args.includes('--mock'),
    once: args.includes('--once'),
    panel: (getArg(args, '--tab') ?? 'overview') as
      | 'overview' | 'providers' | 'tiers' | 'activity',
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function runOnce(opts: ReturnType<typeof parseArgs>) {
  const api = await import('./api.js');
  const client = new api.GateSwarmAPI(opts.url);
  try {
    const [consumption, intel] = await Promise.all([
      client.getConsumption(),
      client.getIntel(),
    ]);
    console.log(JSON.stringify({ consumption, intel }, null, 2));
  } catch (e: any) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
}

async function main() {
  const opts = parseArgs();

  if (opts.once) {
    await runOnce(opts);
    return;
  }

  // Non-TTY mode: render once and exit. We use unmount() to trigger cleanup.
  if (!process.stdin.isTTY) {
    const instance = render(
      React.createElement(App, {
        baseUrl: opts.url,
        refreshInterval: opts.refresh,
        mock: opts.mock,
        panel: opts.panel,
      }),
    );
    // Wait for the first fetch cycle to complete (or timeout after 1.5× refresh).
    // We poll for the App's "serverOk" state by waiting for a frame render.
    const waitMs = Math.min(15_000, Math.max(2_000, opts.refresh * 1500));
    setTimeout(() => {
      instance.unmount();
      process.exit(0);
    }, waitMs);
    return;
  }

  // TTY mode: wait for the user to quit.
  const { waitUntilExit } = render(
    React.createElement(App, {
      baseUrl: opts.url,
      refreshInterval: opts.refresh,
      mock: opts.mock,
      panel: opts.panel,
    }),
  );

  await waitUntilExit();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
