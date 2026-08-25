#!/usr/bin/env node
/**
 * gateswarm-mcp — MCP stdio server entry point.
 * Register with any MCP-capable CLI/IDE agent:
 *   claude mcp add gateswarm -- node <repo>/packages/gateswarm-mcp/dist/cli.js
 */
import { createState, handleMessage } from './server.js';

const state = createState();
const encoding = 'utf-8';

process.stdin.setEncoding(encoding);
process.stdout.setEncoding(encoding);

let buffer = '';
for await (const chunk of process.stdin) {
  buffer += chunk;
  let newlineIndex = buffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      const response = handleMessage(state, line);
      if (response !== null) process.stdout.write(`${response}\n`);
    }
    newlineIndex = buffer.indexOf('\n');
  }
}
