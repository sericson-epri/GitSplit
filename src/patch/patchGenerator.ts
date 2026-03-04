import { DiffFile, DiffHunk, DiffLine, DiffLineType } from '../git/diffParser';

/** Number of context lines to keep around selected changes. */
const CONTEXT_LINES = 3;

/**
 * Convert a set of selected diff-line IDs into a valid unified diff patch
 * that can be fed directly to `git apply`.
 *
 * Selection rules
 * ---------------
 * - `del` line selected   → becomes a `-` line in the patch (line removed from base)
 * - `del` line unselected → becomes a ` ` context line in the patch (line stays)
 * - `add` line selected   → becomes a `+` line in the patch (line added)
 * - `add` line unselected → omitted from the patch entirely
 * - `context` line        → always kept as ` `
 *
 * After flattening, the effective-line list is split into sub-hunks:
 * groups of selected changes separated by ≤ 2×CONTEXT_LINES context lines
 * share one hunk; larger gaps produce separate hunks.
 *
 * Hunk headers are recalculated from scratch using the old-file line numbers
 * stored on each DiffLine, with a running `newLineOffset` to track how
 * prior selected changes shift the new-file line counter.
 */
export function generatePatch(
  files: DiffFile[],
  selectedLineIds: ReadonlySet<string>,
): string {
  const fileParts: string[] = [];

  for (const file of files) {
    if (file.isBinary) continue;

    const hunkParts: string[] = [];
    // Track how much the new-file line numbers have shifted due to previously
    // emitted selected additions/deletions within this file.
    let newLineOffset = 0;

    for (const hunk of file.hunks) {
      const subHunks = generateSubHunks(hunk, selectedLineIds, newLineOffset);

      for (const sh of subHunks) {
        hunkParts.push(sh.text);
        newLineOffset += sh.offsetDelta;
      }
    }

    if (hunkParts.length === 0) continue;

    // Build file header
    const oldPath = file.isNew ? '/dev/null' : `a/${file.oldPath}`;
    const newPath = file.isDeleted ? '/dev/null' : `b/${file.newPath}`;
    const header = `--- ${oldPath}\n+++ ${newPath}\n`;

    fileParts.push(header + hunkParts.join(''));
  }

  return fileParts.join('');
}

// ── Internal types ──────────────────────────────────────────────────────────

interface EffectiveLine {
  /** Patch prefix character */
  prefix: ' ' | '-' | '+';
  content: string;
  /** Old-file line number for ` ` and `-` lines; null for `+` lines */
  oldLineNum: number | null;
  /** Whether this line represents a *selected* change (not context / unselected-del-as-context) */
  isSelectedChange: boolean;
}

interface SubHunk {
  text: string;
  /** Net change to the new-file line offset after this sub-hunk */
  offsetDelta: number;
}

// ── Core algorithm ──────────────────────────────────────────────────────────

function generateSubHunks(
  hunk: DiffHunk,  // kept for fallback oldStart on new-file hunks
  selectedLineIds: ReadonlySet<string>,
  newLineOffset: number,
): SubHunk[] {
  // Step 1: Build effective-line list applying selection rules.
  const effective: EffectiveLine[] = [];

  for (const line of hunk.lines) {
    switch (line.type) {
      case 'context':
        effective.push({
          prefix: ' ',
          content: line.content,
          oldLineNum: line.oldLineNum,
          isSelectedChange: false,
        });
        break;

      case 'del':
        if (selectedLineIds.has(line.id)) {
          // Selected removal — goes into patch as a `-` line.
          effective.push({
            prefix: '-',
            content: line.content,
            oldLineNum: line.oldLineNum,
            isSelectedChange: true,
          });
        } else {
          // Unselected removal — line stays in the file, treat as context.
          effective.push({
            prefix: ' ',
            content: line.content,
            oldLineNum: line.oldLineNum,
            isSelectedChange: false,
          });
        }
        break;

      case 'add':
        if (selectedLineIds.has(line.id)) {
          // Selected addition — goes into patch as a `+` line.
          effective.push({
            prefix: '+',
            content: line.content,
            oldLineNum: null,
            isSelectedChange: true,
          });
        }
        // Unselected addition — omit entirely.
        break;
    }
  }

  // Step 2: Find indices of selected changes.
  const changeIndices = effective
    .map((l, idx) => (l.isSelectedChange ? idx : -1))
    .filter((idx) => idx >= 0);

  if (changeIndices.length === 0) return [];

  // Step 3: Group change indices into sub-hunks.
  // Two changes belong to the same sub-hunk when their gap (excluding additions,
  // which have no oldLineNum) is ≤ 2 * CONTEXT_LINES.
  const groups: number[][] = [[changeIndices[0]]];

  for (let i = 1; i < changeIndices.length; i++) {
    const prev = changeIndices[i - 1];
    const curr = changeIndices[i];

    // Count the number of "old-file lines" between prev and curr.
    // `+` lines don't occupy old-file lines, so skip them when measuring gap.
    const gapOldLines = effective
      .slice(prev + 1, curr)
      .filter((l) => l.prefix !== '+').length;

    if (gapOldLines <= CONTEXT_LINES * 2) {
      groups[groups.length - 1].push(curr);
    } else {
      groups.push([curr]);
    }
  }

  // Step 4: Render each group as a sub-hunk.
  const subHunks: SubHunk[] = [];
  let runningOffset = newLineOffset;

  for (const group of groups) {
    const firstIdx = group[0];
    const lastIdx = group[group.length - 1];

    // Window into effective[]: extend CONTEXT_LINES before/after the group.
    const winStart = Math.max(0, firstIdx - CONTEXT_LINES);
    const winEnd = Math.min(effective.length - 1, lastIdx + CONTEXT_LINES);
    const window = effective.slice(winStart, winEnd + 1);

    // Compute oldStart — the old-file line number of the first line in the window
    // that has an oldLineNum (i.e. not a pure `+` line).
    // For new-file hunks (--- /dev/null), ALL effective lines are `+` with no
    // oldLineNum; fall back to the hunk's own oldStart (0 for new files).
    const firstWithOld = window.find((l) => l.oldLineNum !== null);
    const oldStart = firstWithOld !== undefined ? firstWithOld.oldLineNum! : hunk.oldStart;
    const oldCount = window.filter((l) => l.prefix !== '+').length;
    const newCount = window.filter((l) => l.prefix !== '-').length;

    // newStart = position in the new file where this hunk lands.
    // For ordinary hunks: oldStart + accumulated line-offset from prior hunks.
    // For new-file hunks (oldStart === 0): first line of new content is always 1
    // (plus any offset from prior sub-hunks within the same hunk, which is 0 for
    // new files since they only ever have one hunk).
    const newStart = oldStart === 0 ? 1 + runningOffset : oldStart + runningOffset;

    // Build hunk header and body.
    const oldCountStr = oldCount === 1 ? '' : `,${oldCount}`;
    const newCountStr = newCount === 1 ? '' : `,${newCount}`;
    let text = `@@ -${oldStart}${oldCountStr} +${newStart}${newCountStr} @@\n`;

    for (const l of window) {
      text += l.prefix + l.content + '\n';
    }

    // Calculate how this sub-hunk shifts subsequent new-file line numbers:
    // each selected `+` line adds 1, each selected `-` line subtracts 1.
    const delta =
      window.filter((l) => l.prefix === '+' && l.isSelectedChange).length -
      window.filter((l) => l.prefix === '-' && l.isSelectedChange).length;

    runningOffset += delta;
    subHunks.push({ text, offsetDelta: delta });
  }

  return subHunks;
}
