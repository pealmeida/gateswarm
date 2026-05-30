/**
 * Output Filter Engine — GateSwarm v0.6 (RTK-inspired)
 *
 * Filters provider/CLI output before it enters context, feedback, and RAG.
 * Strategies adapted from RTK (github.com/rtk-ai/rtk): filter by output type,
 * not by content importance. Full output saved to tee files for on-demand retrieval.
 */

import { promises as fs } from 'fs';
import { dirname, join } from 'path';

export interface FilterOptions {
  strategy?: 'auto-detect' | 'stats' | 'failure-focus' | 'tree' | 'code-filter' | 'dedup' | 'ndjson-parse';
  level?: 'standard' | 'aggressive' | 'full';
  teeEnabled?: boolean;
  agentId?: string;
  model?: string;
}

export interface FilterResult {
  content: string;
  strategy: string;
  originalLength: number;
  filteredLength: number;
  savingsPct: number;
  teeFilePath?: string;
}

const TEE_DIR = join(dirname(import.meta.url.replace('file://', '')), '../tee');

async function ensureTeeDir() {
  try { await fs.mkdir(TEE_DIR, { recursive: true }); } catch {}
}

/** Save full output to tee file before filtering */
async function saveTee(content: string, agentId: string, model: string): Promise<string> {
  await ensureTeeDir();
  const filename = `${Date.now()}_${agentId}_${model.replace(/[^a-zA-Z0-9.-]/g, '_')}.log`;
  const filePath = join(TEE_DIR, filename);
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/** Read a tee file by path */
export async function readTee(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Detect output type and apply appropriate filter */
function detectOutputType(content: string): string {
  if (/^\s*\d+ tests passed/.test(content) || /^\s*\d+ tests? failed/.test(content)) return 'test-output';
  if (/^git\s/.test(content) && /changed|modified|inserted|deleted/.test(content)) return 'git-status';
  if (/^\s*(│|\||\+|--|├|└|┌)/.test(content) && /\d+\s+file/.test(content)) return 'directory-tree';
  if (/^\{.*\}$/m.test(content) && content.split('\n').some(l => l.trim().startsWith('{') || l.trim().startsWith('['))) return 'json-output';
  if (content.split('\n').filter(l => l.startsWith('ERROR') || l.startsWith('WARN') || l.startsWith('FATAL')).length > 3) return 'log-output';
  if (/function\s+\w+|class\s+\w+|const\s+\w+\s*=\s*function|=>/.test(content)) return 'code-output';
  return 'generic';
}

/** Apply stats extraction for CLI command output */
function filterStats(content: string): string {
  const lines = content.split('\n');
  const passes = lines.filter(l => /passed|succeeded|ok/.test(l)).length;
  const fails = lines.filter(l => /failed|error|failed/.test(l)).length;
  const total = lines.filter(l => /^\d+\s+tests?/.test(l)).length;
  if (total > 0) return `${passes} passed, ${fails} failed (${total} total)`;
  const numbers = content.match(/\d+/g);
  if (numbers && numbers.length > 5) return `Stats: ${numbers.slice(0, 10).join(', ')}... (${numbers.length} values)`;
  return content.slice(0, 200);
}

/** Failure focus: only show failures, summarize passes */
function filterFailureFocus(content: string): string {
  const lines = content.split('\n');
  const failLines = lines.filter(l => /failed|error|ERROR|FAILED|✗|❌/.test(l));
  const passCount = lines.filter(l => /passed|ok|✓|✅/.test(l)).length;
  if (failLines.length === 0) return `✓ ${passCount} checks passed`;
  return `${passCount} passed, ${failLines.length} failed:\n` + failLines.slice(0, 20).join('\n');
}

/** Code filtering: keep signatures, strip implementations */
function filterCode(content: string, level: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inBlock = 0;
  for (const line of lines) {
    if (level === 'aggressive') {
      if (/^(function|class|const|interface|type|def|async)\s/.test(line)) {
        result.push(line);
        inBlock++;
      } else if (inBlock > 0 && /^\s{0,1}\}/.test(line)) {
        result.push(line);
        inBlock--;
      } else if (inBlock === 0) {
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

/** Deduplication: collapse repeated lines */
function filterDedup(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let prevLine = '';
  let repeatCount = 0;
  for (const line of lines) {
    if (line === prevLine) {
      repeatCount++;
    } else {
      if (repeatCount > 1) {
        result.push(`  [${prevLine}] (×${repeatCount})`);
      }
      result.push(line);
      repeatCount = 1;
      prevLine = line;
    }
  }
  if (repeatCount > 1) {
    result.push(`  [${prevLine}] (×${repeatCount})`);
  }
  return result.join('\n');
}

/** Tree compression: summarize directory listings */
function filterTree(content: string): string {
  const lines = content.split('\n');
  const dirCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  for (const line of lines) {
    const dirMatch = line.match(/\/?\s*$/);
    const fileMatch = line.match(/\.(\w+)\s*$/);
    if (dirMatch && line.includes('/')) {
      const parts = line.split('/');
      const dir = parts.slice(0, -1).join('/');
      dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
    }
    if (fileMatch) {
      const ext = fileMatch[1];
      fileCounts.set(ext, (fileCounts.get(ext) || 0) + 1);
    }
  }
  let summary = 'Directory structure:\n';
  for (const [dir, count] of dirCounts) {
    summary += `  ${dir}/ (${count} items)\n`;
  }
  for (const [ext, count] of fileCounts) {
    summary += `  *.${ext}: ${count} files\n`;
  }
  return summary;
}

/** NDJSON parsing: extract event summaries */
function filterNDJSON(content: string): string {
  const lines = content.split('\n').filter(l => l.trim());
  const events: Record<string, number> = {};
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const type = obj.type || obj.event || obj.level || 'unknown';
      events[type] = (events[type] || 0) + 1;
    } catch {
      // Not JSON, keep as-is
    }
  }
  if (Object.keys(events).length > 0) {
    return Object.entries(events).map(([type, count]) => `${type}: ${count}`).join('\n');
  }
  return content.slice(0, 500);
}

/** Main filter function */
export async function applyOutputFilter(
  content: string,
  options: FilterOptions = {},
): Promise<FilterResult> {
  const originalLength = content.length;
  const strategy = options.strategy || 'auto-detect';
  const level = options.level || 'standard';

  // Save full output to tee before filtering
  let teeFilePath: string | undefined;
  if (options.teeEnabled && options.agentId) {
    teeFilePath = await saveTee(content, options.agentId, options.model || 'unknown');
  }

  let filtered = content;
  const actualStrategy = strategy === 'auto-detect' ? detectOutputType(content) : strategy;

  switch (actualStrategy) {
    case 'test-output':
      filtered = filterFailureFocus(content);
      break;
    case 'git-status':
    case 'stats':
      filtered = filterStats(content);
      break;
    case 'directory-tree':
    case 'tree':
      filtered = filterTree(content);
      break;
    case 'code-output':
    case 'code-filter':
      filtered = filterCode(content, level);
      break;
    case 'log-output':
      filtered = filterDedup(content);
      break;
    case 'json-output':
    case 'ndjson-parse':
      filtered = filterNDJSON(content);
      break;
    default:
      filtered = content;
  }

  const savingsPct = originalLength > 0
    ? Math.round((1 - filtered.length / originalLength) * 100)
    : 0;

  return {
    content: filtered,
    strategy: actualStrategy,
    originalLength,
    filteredLength: filtered.length,
    savingsPct,
    teeFilePath,
  };
}
