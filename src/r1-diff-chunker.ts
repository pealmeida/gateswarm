export interface R1Verdict {
  approved: boolean;
  notes?: string;
}

export interface R1ModelSelection<T> {
  model: T;
  degraded: boolean;
}

const DIFF_BOUNDARY = /(?=^diff --git )/m;
const HUNK_BOUNDARY = /(?=^@@ )/m;

function hardSplit(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxChars) {
    chunks.push(text.slice(offset, offset + maxChars));
  }
  return chunks;
}

/** Split one file diff at hunk boundaries, repeating its file header per chunk. */
function splitOversizeFile(fileDiff: string, maxChars: number): string[] {
  const hunks = fileDiff.split(HUNK_BOUNDARY);
  const header = hunks.shift() ?? '';
  if (hunks.length === 0) return hardSplit(fileDiff, maxChars);

  const chunks: string[] = [];
  let current = header;
  for (const hunk of hunks) {
    if (current.length > header.length && current.length + hunk.length > maxChars) {
      chunks.push(current);
      current = header;
    }
    if (current.length + hunk.length <= maxChars) {
      current += hunk;
      continue;
    }

    // A hunk itself is too large. Preserve the file header where it fits;
    // otherwise hard-split is the only safe remaining option.
    if (current.length > header.length) chunks.push(current);
    if (header.length >= maxChars) {
      chunks.push(...hardSplit(header + hunk, maxChars));
    } else {
      const available = maxChars - header.length;
      for (const piece of hardSplit(hunk, available)) chunks.push(header + piece);
    }
    current = header;
  }
  if (current.length > header.length) chunks.push(current);
  return chunks.length ? chunks : hardSplit(fileDiff, maxChars);
}

/**
 * Chunk a unified diff on file boundaries first, then hunk boundaries, with a
 * final character split for pathological single hunks.
 */
export function chunkUnifiedDiff(
  diff: string,
  maxChars = Number(process.env.MOMA_R1_MAX_DIFF_CHARS) || 60_000,
): string[] {
  if (!diff) return [];
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) maxChars = 60_000;

  const files = diff.split(DIFF_BOUNDARY);
  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const file of files) {
    if (!file) continue;
    const pieces = file.length > maxChars ? splitOversizeFile(file, maxChars) : [file];
    for (const piece of pieces) {
      if (piece.length > maxChars) {
        push();
        chunks.push(...hardSplit(piece, maxChars));
      } else if (current && current.length + piece.length > maxChars) {
        push();
        current = piece;
      } else {
        current += piece;
      }
    }
  }
  push();
  return chunks;
}

export function aggregateVerdicts(verdicts: R1Verdict[]): { approved: boolean; notes: string } {
  return {
    approved: verdicts.every((verdict) => verdict.approved),
    notes: verdicts.flatMap((verdict) => verdict.notes ? [verdict.notes] : []).join('\n'),
  };
}

export function pickR1Model<T>(primary: T, fallback: T, elapsedMs: number, budgetMs: number): R1ModelSelection<T> {
  const degraded = elapsedMs >= budgetMs;
  return { model: degraded ? fallback : primary, degraded };
}
