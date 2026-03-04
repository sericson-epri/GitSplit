import * as assert from 'assert';
import { parseDiff, DiffFile, DiffLine } from '../../git/diffParser';
import { generatePatch } from '../../patch/patchGenerator';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Collect all DiffLine objects with the given type from a parsed diff. */
function linesOfType(
  files: DiffFile[],
  type: 'add' | 'del' | 'context',
): DiffLine[] {
  return files.flatMap((f) => f.hunks.flatMap((h) => h.lines)).filter((l) => l.type === type);
}

/** Select all changed lines in a diff (all add + del). */
function selectAll(files: DiffFile[]): Set<string> {
  return new Set(linesOfType(files, 'add').concat(linesOfType(files, 'del')).map((l) => l.id));
}

/** Select only lines matching a predicate. */
function selectWhere(files: DiffFile[], pred: (l: DiffLine) => boolean): Set<string> {
  const all = files.flatMap((f) => f.hunks.flatMap((h) => h.lines));
  return new Set(all.filter(pred).map((l) => l.id));
}

// ── Test suites ────────────────────────────────────────────────────────────

describe('parseDiff', () => {
  it('parses a simple modified file', () => {
    const raw = [
      'diff --git a/foo.txt b/foo.txt',
      'index 0000001..0000002 100644',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,4 +1,4 @@',
      ' line1',
      '-old line2',
      '+new line2',
      ' line3',
      ' line4',
    ].join('\n');

    const files = parseDiff(raw);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].oldPath, 'foo.txt');
    assert.strictEqual(files[0].isNew, false);
    assert.strictEqual(files[0].isDeleted, false);
    assert.strictEqual(files[0].hunks.length, 1);

    const lines = files[0].hunks[0].lines;
    assert.strictEqual(lines.length, 5);  // ctx, del, add, ctx, ctx
    assert.strictEqual(lines[0].type, 'context');
    assert.strictEqual(lines[1].type, 'del');
    assert.strictEqual(lines[1].content, 'old line2');
    assert.strictEqual(lines[2].type, 'add');
    assert.strictEqual(lines[2].content, 'new line2');
  });

  it('parses a new file', () => {
    const raw = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..abcdef1',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,3 @@',
      '+line1',
      '+line2',
      '+line3',
    ].join('\n');

    const files = parseDiff(raw);
    assert.strictEqual(files[0].isNew, true);
    assert.strictEqual(linesOfType(files, 'add').length, 3);
    assert.strictEqual(linesOfType(files, 'del').length, 0);
  });

  it('parses a deleted file', () => {
    const raw = [
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line1',
      '-line2',
    ].join('\n');

    const files = parseDiff(raw);
    assert.strictEqual(files[0].isDeleted, true);
    assert.strictEqual(linesOfType(files, 'del').length, 2);
  });

  it('marks binary files', () => {
    const raw = [
      'diff --git a/image.png b/image.png',
      'index abc1234..def5678 100644',
      'Binary files a/image.png and b/image.png differ',
    ].join('\n');

    const files = parseDiff(raw);
    assert.strictEqual(files[0].isBinary, true);
    assert.strictEqual(files[0].hunks.length, 0);
  });

  it('assigns correct line numbers to context/del/add lines', () => {
    const raw = [
      'diff --git a/nums.txt b/nums.txt',
      '--- a/nums.txt',
      '+++ b/nums.txt',
      '@@ -5,5 +5,5 @@',
      ' ctx5',
      '-del6',
      '+add6',
      ' ctx7',
      ' ctx8',
      ' ctx9',
    ].join('\n');

    const files = parseDiff(raw);
    const lines = files[0].hunks[0].lines;
    assert.strictEqual(lines[0].oldLineNum, 5);
    assert.strictEqual(lines[0].newLineNum, 5);
    assert.strictEqual(lines[1].oldLineNum, 6);  // del
    assert.strictEqual(lines[1].newLineNum, null);
    assert.strictEqual(lines[2].oldLineNum, null); // add
    assert.strictEqual(lines[2].newLineNum, 6);
    assert.strictEqual(lines[3].oldLineNum, 7);
    assert.strictEqual(lines[3].newLineNum, 7);
  });

  it('handles multiple hunks in one file', () => {
    const raw = [
      'diff --git a/multi.txt b/multi.txt',
      '--- a/multi.txt',
      '+++ b/multi.txt',
      '@@ -1,4 +1,4 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      ' d',
      '@@ -10,4 +10,4 @@',
      ' x',
      '-y',
      '+Y',
      ' z',
      ' w',
    ].join('\n');

    const files = parseDiff(raw);
    assert.strictEqual(files[0].hunks.length, 2);
    assert.strictEqual(files[0].hunks[0].oldStart, 1);
    assert.strictEqual(files[0].hunks[1].oldStart, 10);
  });
});

// ── generatePatch tests ────────────────────────────────────────────────────

describe('generatePatch', () => {
  it('returns empty string when nothing is selected', () => {
    const raw = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n');

    const files = parseDiff(raw);
    const patch = generatePatch(files, new Set());
    assert.strictEqual(patch, '');
  });

  it('selects all changes — patch round-trips correctly', () => {
    const raw = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,4 +1,4 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      ' d',
    ].join('\n');

    const files = parseDiff(raw);
    const patch = generatePatch(files, selectAll(files));

    // Patch should contain both the removal and addition
    assert.ok(patch.includes('-b'), 'should contain deletion');
    assert.ok(patch.includes('+B'), 'should contain addition');
    assert.ok(patch.startsWith('--- a/foo.txt'), 'should start with file header');
  });

  it('partial selection: selects only deletion in a del/add pair', () => {
    const raw = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n');

    const files = parseDiff(raw);
    const delLines = linesOfType(files, 'del');
    const patch = generatePatch(files, new Set([delLines[0].id]));

    assert.ok(patch.includes('-b'), 'should include deletion');
    assert.ok(!patch.includes('+B'), 'should not include addition');
    assert.ok(!patch.includes('+b'), 'should not re-add the deleted line');
  });

  it('partial selection: selects only addition in a del/add pair', () => {
    const raw = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n');

    const files = parseDiff(raw);
    const addLines = linesOfType(files, 'add');
    const patch = generatePatch(files, new Set([addLines[0].id]));

    assert.ok(!patch.includes('-b'), 'unselected del should not appear as removal');
    assert.ok(patch.includes(' b'), 'unselected del should appear as context');
    assert.ok(patch.includes('+B'), 'should include addition');
  });

  it('multi-hunk: selects changes in second hunk only', () => {
    const raw = [
      'diff --git a/multi.txt b/multi.txt',
      '--- a/multi.txt',
      '+++ b/multi.txt',
      '@@ -1,4 +1,4 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      ' d',
      '@@ -10,4 +10,4 @@',
      ' x',
      '-y',
      '+Y',
      ' z',
      ' w',
    ].join('\n');

    const files = parseDiff(raw);
    const hunk2Lines = files[0].hunks[1].lines;
    const selected = new Set(
      hunk2Lines.filter((l) => l.type !== 'context').map((l) => l.id),
    );

    const patch = generatePatch(files, selected);
    assert.ok(!patch.includes('-b'), 'hunk1 change should be absent');
    assert.ok(!patch.includes('+B'), 'hunk1 change should be absent');
    assert.ok(patch.includes('-y'), 'hunk2 del should be present');
    assert.ok(patch.includes('+Y'), 'hunk2 add should be present');
  });

  it('hunk header oldStart is correct for partial selection', () => {
    // Original hunk: @@ -5,5 +5,5 @@
    const raw = [
      'diff --git a/nums.txt b/nums.txt',
      '--- a/nums.txt',
      '+++ b/nums.txt',
      '@@ -5,5 +5,5 @@',
      ' ctx5',
      '-del6',
      '+add6',
      ' ctx7',
      ' ctx8',
      ' ctx9',
    ].join('\n');

    const files = parseDiff(raw);
    const patch = generatePatch(files, selectAll(files));

    // Hunk header should start at old line 5
    assert.ok(patch.includes('@@ -5,'), `expected -5,… in patch, got:\n${patch}`);
  });

  it('new file: all additions selected — patch starts at +1,N', () => {
    const raw = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,3 @@',
      '+line1',
      '+line2',
      '+line3',
    ].join('\n');

    const files = parseDiff(raw);
    const patch = generatePatch(files, selectAll(files));

    assert.ok(patch.includes('--- /dev/null'), 'should keep /dev/null old path');
    assert.ok(patch.includes('+++ b/new.txt'), 'should keep new path');
    assert.ok(patch.includes('+line1'), 'should include additions');
    assert.ok(patch.includes('+line3'), 'should include all additions');
  });

  it('new file: partial selection — only selected additions appear', () => {
    const raw = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,4 @@',
      '+a',
      '+b',
      '+c',
      '+d',
    ].join('\n');

    const files = parseDiff(raw);
    const addLines = linesOfType(files, 'add');
    // Select only 'b' and 'd'
    const selected = new Set([addLines[1].id, addLines[3].id]);
    const patch = generatePatch(files, selected);

    assert.ok(!patch.includes('+a'), 'unselected a should be absent');
    assert.ok(patch.includes('+b'), 'selected b should be present');
    assert.ok(!patch.includes('+c'), 'unselected c should be absent');
    assert.ok(patch.includes('+d'), 'selected d should be present');
  });

  it('deleted file: all deletions selected', () => {
    const raw = [
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-line1',
      '-line2',
      '-line3',
    ].join('\n');

    const files = parseDiff(raw);
    const patch = generatePatch(files, selectAll(files));

    assert.ok(patch.includes('--- a/old.txt'), 'should keep old path');
    assert.ok(patch.includes('+++ /dev/null'), 'should keep /dev/null new path');
    assert.ok(patch.includes('-line1'), 'should include deletions');
  });

  it('large gap between changes → two sub-hunks', () => {
    // Two changes separated by 10 context lines → should produce 2 hunks
    const contextLines: string[] = [];
    for (let i = 2; i <= 11; i++) {
      contextLines.push(` ctx${i}`);
    }

    const raw = [
      'diff --git a/big.txt b/big.txt',
      '--- a/big.txt',
      '+++ b/big.txt',
      `@@ -1,${12 + 2} +1,${12 + 2} @@`,
      '-change1',
      '+CHANGE1',
      ...contextLines,
      '-change12',
      '+CHANGE12',
    ].join('\n');

    const files = parseDiff(raw);
    const patch = generatePatch(files, selectAll(files));

    // Count @@ occurrences — should be 2
    const hunkCount = (patch.match(/^@@/gm) ?? []).length;
    assert.strictEqual(hunkCount, 2, `expected 2 hunks, got ${hunkCount}\n${patch}`);
  });

  it('small gap between changes → single sub-hunk', () => {
    // Two changes separated by 4 context lines → single hunk (within 2*3=6 gap)
    const raw = [
      'diff --git a/close.txt b/close.txt',
      '--- a/close.txt',
      '+++ b/close.txt',
      '@@ -1,8 +1,8 @@',
      '-change1',
      '+CHANGE1',
      ' ctx2',
      ' ctx3',
      ' ctx4',
      ' ctx5',
      '-change6',
      '+CHANGE6',
    ].join('\n');

    const files = parseDiff(raw);
    const patch = generatePatch(files, selectAll(files));

    const hunkCount = (patch.match(/^@@/gm) ?? []).length;
    assert.strictEqual(hunkCount, 1, `expected 1 hunk, got ${hunkCount}\n${patch}`);
  });

  it('newStart offset is correct after a prior selected addition', () => {
    // Hunk 1: adds 2 lines (net +2). Hunk 2 starts at old line 10.
    // newStart of hunk 2 should be 10 + 2 = 12.
    const raw = [
      'diff --git a/offset.txt b/offset.txt',
      '--- a/offset.txt',
      '+++ b/offset.txt',
      '@@ -1,3 +1,5 @@',
      ' a',
      '+inserted1',
      '+inserted2',
      ' b',
      ' c',
      '@@ -10,3 +12,3 @@',
      ' x',
      '-y',
      '+Y',
      ' z',
    ].join('\n');

    const files = parseDiff(raw);
    const patch = generatePatch(files, selectAll(files));

    // The second hunk must start at +12 (old 10 + offset 2)
    assert.ok(
      patch.includes('+12,'),
      `expected +12,… in second hunk header, got:\n${patch}`,
    );
  });

  it('binary files are skipped', () => {
    const raw = [
      'diff --git a/image.png b/image.png',
      'Binary files a/image.png and b/image.png differ',
      'diff --git a/code.txt b/code.txt',
      '--- a/code.txt',
      '+++ b/code.txt',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' ctx',
    ].join('\n');

    const files = parseDiff(raw);
    const patch = generatePatch(files, selectAll(files));

    assert.ok(!patch.includes('image.png'), 'binary file should be skipped');
    assert.ok(patch.includes('code.txt'), 'text file should be present');
  });

  it('multiple files: only includes files with selected changes', () => {
    const raw = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      '-old_a',
      '+new_a',
      ' ctx',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1,2 +1,2 @@',
      '-old_b',
      '+new_b',
      ' ctx',
    ].join('\n');

    const files = parseDiff(raw);

    // Only select changes in b.txt (file index 1)
    const bLines = files[1].hunks[0].lines.filter((l) => l.type !== 'context');
    const patch = generatePatch(files, new Set(bLines.map((l) => l.id)));

    assert.ok(!patch.includes('a.txt'), 'a.txt should be absent when not selected');
    assert.ok(patch.includes('b.txt'), 'b.txt should be present');
  });
});
