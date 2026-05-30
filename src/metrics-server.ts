/**
 * Metrics Server — Lightweight HTTP endpoint for the dashboard.
 * 
 * Serves:
 *   GET /             → dashboard.html
 *   GET /dashboard    → dashboard.html
 *   GET /api/metrics  → JSON with all query history + KPIs
 *   POST /api/query   → Log a query result from CLI
 *   DELETE /api/metrics → Clear all metrics
 * 
 * Usage:
 *   npx tsx src/metrics-server.ts [--port 4174]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METRICS_FILE = resolve(__dirname, '../data/metrics.json');
const PUBLIC_DIR = resolve(__dirname, '../public');

const DEFAULT_PORT = 4174;

function getArgs() {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { port };
}

// ─── Metrics Persistence ────────────────────────────────────────
interface QueryRecord {
  id: number;
  ts: string;
  prompt: string;
  score: number;
  effort: string;
  model: string;
  tier: string;
  device: string;
  latency: number;
  expectedEffort?: string;
  adapter: string;
  tokensEstimate: number;
}

interface MetricsState {
  queries: QueryRecord[];
  totalQueries: number;
  nudges: number;
  patterns: number;
  startTime: string;
}

function loadMetrics(): MetricsState {
  if (existsSync(METRICS_FILE)) {
    try {
      return JSON.parse(readFileSync(METRICS_FILE, 'utf-8'));
    } catch {}
  }
  return { queries: [], totalQueries: 0, nudges: 0, patterns: 0, startTime: new Date().toISOString() };
}

function saveMetrics(metrics: MetricsState) {
  const dir = dirname(METRICS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
}

// ─── HTTP Server ────────────────────────────────────────────────
function sendJSON(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendHTML(res: ServerResponse, html: string) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function sendError(res: ServerResponse, status: number, message: string) {
  sendJSON(res, { error: message }, status);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function startServer() {
  const { port } = getArgs();
  const metrics = loadMetrics();

  const server = createServer(async (req, res) => {
    const url = req.url?.split('?')[0] || '/';
    const method = req.method?.toUpperCase() || 'GET';

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // ─── API Routes ──────────────────────────────────
      if (url === '/api/metrics' && method === 'GET') {
        sendJSON(res, metrics);
        return;
      }

      if (url === '/api/query' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const record: QueryRecord = {
          id: metrics.totalQueries + 1,
          ts: new Date().toISOString().slice(11, 19),
          prompt: (body.prompt || '').slice(0, 200),
          score: body.score ?? 0,
          effort: body.effort || 'trivial',
          model: body.model || 'unknown',
          tier: body.tier || 'local',
          device: body.device || 'unknown',
          latency: body.latency ?? 0,
          expectedEffort: body.expectedEffort,
          adapter: body.adapter || 'local',
          tokensEstimate: body.tokensEstimate ?? 200,
        };
        metrics.queries.push(record);
        metrics.totalQueries++;
        metrics.nudges = Math.floor(metrics.totalQueries / 10);
        metrics.patterns = Math.min(metrics.totalQueries, new Set(metrics.queries.map(q => q.effort)).size * 4);

        // Keep only last 500 queries in memory
        if (metrics.queries.length > 500) {
          metrics.queries = metrics.queries.slice(-500);
        }

        saveMetrics(metrics);
        sendJSON(res, { ok: true, id: record.id });
        return;
      }

      if (url === '/api/metrics' && method === 'DELETE') {
        metrics.queries = [];
        metrics.totalQueries = 0;
        metrics.nudges = 0;
        metrics.patterns = 0;
        metrics.startTime = new Date().toISOString();
        saveMetrics(metrics);
        sendJSON(res, { ok: true });
        return;
      }

      // ─── Static Files ────────────────────────────────
      if (url === '/' || url === '/dashboard' || url === '/dashboard.html') {
        const html = readFileSync(join(PUBLIC_DIR, 'dashboard.html'), 'utf-8');
        sendHTML(res, html);
        return;
      }

      sendError(res, 404, 'Not found');
    } catch (err: any) {
      console.error('Error:', err.message);
      sendError(res, 500, err.message);
    }
  });

  server.listen(port, () => {
    console.log(`\n  🧠 MoMA Metrics Dashboard`);
    console.log(`  ─────────────────────────`);
    console.log(`  Dashboard:  http://localhost:${port}`);
    console.log(`  Metrics API: http://localhost:${port}/api/metrics`);
    console.log(`  Log endpoint: POST http://localhost:${port}/api/query`);
    console.log(`  Data file:   ${METRICS_FILE}`);
    console.log(`\n  Waiting for CLI queries…\n`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    saveMetrics(metrics);
    console.log('\nMetrics saved. Goodbye.');
    process.exit(0);
  });
}

startServer();
