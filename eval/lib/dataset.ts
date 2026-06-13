/**
 * Shared dataset loader for the model-agnostic eval harness.
 *
 * Flattens eval/dataset.json into stable, id'd LabeledPrompt records so that
 * every classifier and every eval run references the exact same examples by id.
 * Effort and mode are separate labeled sets (different label spaces).
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { EffortLevel, IntentMode } from '../../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATASET_PATH = join(__dirname, '..', 'dataset.json');

export const TIERS: EffortLevel[] = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'];
export const MODES = ['plan', 'act', 'ambiguous'] as const;
export type ModeLabel = (typeof MODES)[number];

export interface EffortExample {
  id: string;       // `effort:<tier>:<index>`
  prompt: string;
  tier: EffortLevel;
}
export interface ModeExample {
  id: string;       // `mode:<label>:<index>`
  prompt: string;
  label: ModeLabel; // gold; 'ambiguous' means the correct detection is 'auto'
}

interface RawDataset {
  effort: { tier: EffortLevel; prompts: string[] }[];
  mode: { mode: ModeLabel; prompts: string[] }[];
}

export function loadRaw(): { raw: RawDataset; bytes: string } {
  const bytes = readFileSync(DATASET_PATH, 'utf-8');
  return { raw: JSON.parse(bytes) as RawDataset, bytes };
}

export function loadEffort(): EffortExample[] {
  const { raw } = loadRaw();
  const out: EffortExample[] = [];
  for (const g of raw.effort) {
    g.prompts.forEach((prompt, i) => out.push({ id: `effort:${g.tier}:${i}`, prompt, tier: g.tier }));
  }
  return out;
}

export function loadMode(): ModeExample[] {
  const { raw } = loadRaw();
  const out: ModeExample[] = [];
  for (const g of raw.mode) {
    g.prompts.forEach((prompt, i) => out.push({ id: `mode:${g.mode}:${i}`, prompt, label: g.mode }));
  }
  return out;
}

export const tierIdx = (t: EffortLevel) => TIERS.indexOf(t);

/** The detection target for a mode gold label: ambiguous → auto, else itself. */
export function modeTarget(label: ModeLabel): IntentMode {
  return label === 'ambiguous' ? 'auto' : (label as IntentMode);
}
