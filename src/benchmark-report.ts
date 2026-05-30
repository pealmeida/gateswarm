#!/usr/bin/env tsx
/**
 * MoMA v2 Benchmark Report Generator
 * 
 * Usage: npx tsx src/benchmark-report.ts
 */

import { benchmarkLogger } from './benchmark-logger.js';

(async () => {
  await benchmarkLogger.initialize();
  const report = await benchmarkLogger.generateReport();
  console.log(report);
})();
