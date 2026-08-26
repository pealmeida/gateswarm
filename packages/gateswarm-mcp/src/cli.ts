#!/usr/bin/env node
/**
 * gateswarm-mcp — MCP stdio server entry point.
 * Register with any MCP-capable CLI/IDE agent:
 *   claude mcp add gateswarm -- node <repo>/packages/gateswarm-mcp/dist/cli.js
 */
import { createState, handleMessage } from './server.js';

const state = createState();

// stdin is a Readable — setEncoding is valid and keeps chunks as strings.
// stdout is a Writable: it has no setEncoding (calling it crashes when stdout
// is redirected to a file/nul), and write() already defaults to utf-8.
process.stdin.setEncoding('utf-8');

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
