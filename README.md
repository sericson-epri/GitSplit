# GitSplit

**Cherry-pick individual changed lines from a messy Git branch into a clean focused pull request.**

GitSplit adds a command to VS Code that lets you review every changed line between your current branch and a base branch, select only the lines you want, and push them to a brand-new clean branch — all without touching your working tree.

---

## Features

- **Diff selection UI** — a full-screen webview shows every changed file and hunk with checkboxes you can tick individually or in bulk.
- **Partial hunk support** — select a single line from a multi-line change; GitSplit reconstructs a syntactically correct unified diff patch for only those lines.
- **Safe working-tree handling** — detects uncommitted changes and stashes them automatically before switching branches, then restores them when done.
- **Auto-push & PR URL** — optionally push the branch and open the GitHub "Create PR" page in one click.
- **Binary file awareness** — binary files are shown as read-only and skipped from patch generation.

---

## Usage

1. Open a repository in VS Code.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Run **"GitSplit: Select Changes"**.
4. Review the diff. Check/uncheck lines and hunks.
5. Click **"Create Branch & Commit"**, enter a branch name and commit message, then confirm.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `gitSplit.baseBranch` | `"main"` | Branch to diff against |
| `gitSplit.autoPush` | `false` | Push the new branch to the remote automatically |
| `gitSplit.autoOpenPR` | `true` | Open the GitHub Create PR URL after pushing |

---

## Project Structure

```
src/
├── extension.ts            # Entry point — registers the command
├── git/
│   ├── diffParser.ts       # Parse raw unified diff → DiffFile / DiffHunk / DiffLine
│   └── gitService.ts       # All git operations (diff, branch, apply, commit, push)
├── patch/
│   └── patchGenerator.ts   # Convert selected line IDs → valid unified diff patch
├── webview/
│   ├── diffPanelProvider.ts # VS Code WebviewPanel host + message routing
│   └── media/
│       ├── main.js          # Webview frontend (vanilla JS)
│       └── style.css        # Webview styles (VS Code theme tokens)
└── test/
    ├── runTests.ts          # Mocha test runner
    └── patch/
        └── patchGenerator.test.ts  # Unit tests for patch generation
```

---

## Development

```bash
npm install
npm run compile          # one-off build
npm run watch            # watch mode
npm test                 # compile + run unit tests
```

Press **F5** in VS Code to launch the Extension Development Host.

---

## How Patch Generation Works

Selecting a subset of changed lines produces a valid unified diff that `git apply` can cleanly apply to the base branch:

| Original line type | User action | In generated patch |
|---|---|---|
| Context | — | ` ` context line |
| Deletion (`-`) | ✅ selected | `-` removal line |
| Deletion (`-`) | ☐ unselected | ` ` context (line stays) |
| Addition (`+`) | ✅ selected | `+` addition line |
| Addition (`+`) | ☐ unselected | omitted entirely |

After building the effective-line list, groups of selected changes that are within 6 context lines of each other are merged into a single hunk; larger gaps produce separate hunks. Hunk headers (`@@ -a,b +c,d @@`) are recalculated from scratch using original line numbers plus a running offset that accounts for all prior selected additions/deletions in the same file.
