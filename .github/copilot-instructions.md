# GitSplit Copilot Instructions

## Build and test commands

- `npm run compile` - Compile the TypeScript extension into `out\`.
- `npm run watch` - Watch-mode TypeScript compile for local iteration.
- `npm test` - Runs the existing verification flow (`pretest` compiles, then `node .\out\test\runTests.js` runs Mocha tests).
- Single test file: `npx mocha .\out\test\patch\patchGenerator.test.js`
- Single test case: `npx mocha .\out\test\patch\patchGenerator.test.js --grep "partial selection: selects only addition in a del/add pair"`

There is currently no lint script in `package.json`.

## High-level architecture

GitSplit is a VS Code extension that compares `HEAD` against a configured base branch, lets the user select individual changed lines, and recreates only the selected changes on a new branch without directly editing the current working tree.

### End-to-end flow

1. `src\extension.ts` is the entry point. It creates one `GitService`, one shared `SelectionStore`, the SCM tree provider, and the diff webview provider.
2. `loadDiff()` reads `gitSplit.baseBranch`, calls `GitService.getDiff(baseBranch)`, then loads the parsed `DiffFile[]` into the tree view.
3. `src\git\gitService.ts` shells out to Git for all repo operations. Diffs come from `git diff --no-color --unified=3 <base>...HEAD`, so the UI is based on a three-dot diff against commits unique to the current branch.
4. `src\git\diffParser.ts` turns raw unified diff text into `DiffFile` / `DiffHunk` / `DiffLine` objects. Binary files are preserved as file entries with `isBinary = true` and no hunks.
5. Selection happens in two UIs that share the same state: `src\views\gitSplitViewProvider.ts` manages file-level toggles in the SCM sidebar, and `src\webview\diffPanelProvider.ts` handles line/hunk toggles in the webview.
6. `src\views\selectionStore.ts` is the single source of truth for selected line IDs. When a new diff loads, every non-context line is selected by default.
7. When the user creates a branch, `DiffPanelProvider.handleCreateBranch()` gathers selected IDs, asks GitService to stash if needed, builds a patch with `src\patch\patchGenerator.ts`, creates a new branch from the base branch, and applies the patch with `git apply -`.

## Key conventions

- `DiffLine.id` is the stable selection key everywhere. It is generated as `${fileIndex}:${hunkIndex}:${lineIndex}` in `diffParser.ts`, and both the tree view and webview rely on it staying stable within a loaded diff.
- `SelectionStore` only tracks selectable change lines (`add` and `del`). Context lines are never selectable, and `loadFiles()` resets selection state completely on every refresh.
- Patch generation is selective rather than literal diff slicing. In `patchGenerator.ts`:
  - selected deletions stay `-`
  - unselected deletions are converted to context lines
  - selected additions stay `+`
  - unselected additions are omitted
- Patch hunks are recomputed from parsed line metadata, not copied from the original diff. `generatePatch()` rebuilds file headers, splits distant changes into sub-hunks, and tracks a running `newLineOffset` so later hunk headers stay valid after earlier selected additions/deletions.
- Git safety behavior matters more than UI polish here. Branch creation checks for uncommitted work, offers to stash with `--include-untracked`, and rolls back to the original branch plus deletes the new branch if `git apply` fails.
- Successful patch application leaves the selected changes unstaged on the new branch. The extension does not create the commit for the user.
- Treat `package.json` as the source of truth for contributed settings and commands. The README currently mentions `gitSplit.autoPush` / `gitSplit.autoOpenPR`, but the shipped extension configuration only contributes `gitSplit.baseBranch`, and the current code path only creates the branch and applies the patch.
- Tests currently focus on pure logic in `src\test\patch\patchGenerator.test.ts`: diff parsing, partial line selection, hunk splitting, new/deleted files, binary-file skipping, and hunk-header offset recalculation. There are no existing integration tests for the VS Code UI or Git shelling behavior.
