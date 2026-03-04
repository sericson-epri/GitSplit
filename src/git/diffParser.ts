/**
 * Structures for parsed unified diff output.
 */

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  /** Unique stable ID: `${fileIndex}:${hunkIndex}:${lineIndex}` */
  id: string;
  type: DiffLineType;
  /** Raw line content WITHOUT the leading +/-/space prefix */
  content: string;
  /** Line number in the old (base) file. null for pure additions. */
  oldLineNum: number | null;
  /** Line number in the new (HEAD) file. null for pure deletions. */
  newLineNum: number | null;
}

export interface DiffHunk {
  /** Index within the file's hunk array */
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after @@ … @@ (function/class name hint), may be empty */
  contextLabel: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Index within the parsed diff array */
  index: number;
  oldPath: string;
  newPath: string;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
}

/**
 * Parse the output of `git diff --unified=3` into structured objects.
 *
 * Handles:
 *  - Standard modified files
 *  - New files (--- /dev/null)
 *  - Deleted files (+++ /dev/null)
 *  - Binary files (skipped with isBinary = true)
 *  - Files with "no newline at end of file" markers (stripped)
 */
export function parseDiff(rawDiff: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!rawDiff.trim()) return files;

  const lines = rawDiff.split('\n');
  let i = 0;
  let fileIndex = 0;

  while (i < lines.length) {
    // Scan for the start of a file header: "diff --git a/... b/..."
    if (!lines[i].startsWith('diff --git ')) {
      i++;
      continue;
    }

    const diffLine = lines[i++];
    let oldPath = '';
    let newPath = '';
    let isBinary = false;
    let isNew = false;
    let isDeleted = false;

    // Consume header lines (index, old mode, new mode, Binary, ---, +++)
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      const line = lines[i];

      if (line.startsWith('Binary files')) {
        isBinary = true;
        i++;
        break;
      }

      if (line.startsWith('--- ')) {
        const path = line.slice(4).trim();
        oldPath = path === '/dev/null' ? '' : stripPrefix(path);
        isNew = path === '/dev/null';
      } else if (line.startsWith('+++ ')) {
        const path = line.slice(4).trim();
        newPath = path === '/dev/null' ? '' : stripPrefix(path);
        isDeleted = path === '/dev/null';
      }

      // Once we hit a hunk header, stop consuming file header lines
      if (line.startsWith('@@')) break;
      i++;
    }

    if (isBinary) {
      files.push({
        index: fileIndex++,
        oldPath: extractPathFromDiffLine(diffLine, 'a'),
        newPath: extractPathFromDiffLine(diffLine, 'b'),
        isBinary: true,
        isNew: false,
        isDeleted: false,
        hunks: [],
      });
      continue;
    }

    if (!oldPath && !newPath) {
      // Couldn't find --- / +++ lines; try extracting from diff --git line
      oldPath = extractPathFromDiffLine(diffLine, 'a');
      newPath = extractPathFromDiffLine(diffLine, 'b');
    }

    const displayPath = newPath || oldPath;
    const hunks: DiffHunk[] = [];
    let hunkIndex = 0;

    // Parse hunks
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      const line = lines[i];

      if (!line.startsWith('@@')) {
        i++;
        continue;
      }

      const hunkHeader = line;
      const parsed = parseHunkHeader(hunkHeader);
      if (!parsed) {
        i++;
        continue;
      }

      i++;

      const diffLines: DiffLine[] = [];
      let oldLineNum = parsed.oldStart;
      let newLineNum = parsed.newStart;
      let lineIndex = 0;

      while (i < lines.length) {
        const l = lines[i];

        // End of hunk: new hunk header or new file header
        if (l.startsWith('@@') || l.startsWith('diff --git ')) break;

        // "No newline at end of file" marker — skip
        if (l === '\\ No newline at end of file') {
          i++;
          continue;
        }

        const prefix = l[0];
        const content = l.slice(1);

        if (prefix === ' ') {
          diffLines.push({
            id: `${fileIndex}:${hunkIndex}:${lineIndex++}`,
            type: 'context',
            content,
            oldLineNum: oldLineNum++,
            newLineNum: newLineNum++,
          });
        } else if (prefix === '-') {
          diffLines.push({
            id: `${fileIndex}:${hunkIndex}:${lineIndex++}`,
            type: 'del',
            content,
            oldLineNum: oldLineNum++,
            newLineNum: null,
          });
        } else if (prefix === '+') {
          diffLines.push({
            id: `${fileIndex}:${hunkIndex}:${lineIndex++}`,
            type: 'add',
            content,
            oldLineNum: null,
            newLineNum: newLineNum++,
          });
        } else {
          // Unexpected prefix (e.g. empty line at end of diff) — treat as context
          if (l.length > 0) {
            diffLines.push({
              id: `${fileIndex}:${hunkIndex}:${lineIndex++}`,
              type: 'context',
              content: l,
              oldLineNum: oldLineNum++,
              newLineNum: newLineNum++,
            });
          }
        }

        i++;
      }

      hunks.push({
        index: hunkIndex++,
        oldStart: parsed.oldStart,
        oldLines: parsed.oldLines,
        newStart: parsed.newStart,
        newLines: parsed.newLines,
        contextLabel: parsed.contextLabel,
        lines: diffLines,
      });
    }

    files.push({
      index: fileIndex++,
      oldPath: isNew ? displayPath : oldPath || displayPath,
      newPath: isDeleted ? displayPath : newPath || displayPath,
      isBinary,
      isNew,
      isDeleted,
      hunks,
    });
  }

  return files;
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface HunkHeaderParsed {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  contextLabel: string;
}

/**
 * Parse `@@ -a,b +c,d @@ optional label` hunk header.
 * The `,b` and `,d` parts are optional (git omits them when the count is 1).
 */
function parseHunkHeader(header: string): HunkHeaderParsed | null {
  const m = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1], 10),
    oldLines: m[2] !== undefined ? parseInt(m[2], 10) : 1,
    newStart: parseInt(m[3], 10),
    newLines: m[4] !== undefined ? parseInt(m[4], 10) : 1,
    contextLabel: m[5].trim(),
  };
}

/** Strip the `a/` or `b/` prefix that git adds to diff paths. */
function stripPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

/** Extract file path from `diff --git a/foo b/foo` line. */
function extractPathFromDiffLine(line: string, side: 'a' | 'b'): string {
  // line format: diff --git a/<path> b/<path>
  // paths may contain spaces; the two halves are separated by ` b/`
  const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
  if (!m) return '';
  return side === 'a' ? m[1] : m[2];
}
