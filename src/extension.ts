import * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { DiffPanelProvider } from './webview/diffPanelProvider';
import { GitSplitViewProvider } from './views/gitSplitViewProvider';
import { SelectionStore } from './views/selectionStore';
import { DiffFile } from './git/diffParser';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  const gitService = new GitService(workspaceRoot);
  const store = new SelectionStore();

  let diffFiles: DiffFile[] = [];

  // ── Diff panel (single-file webview) ─────────────────────────────────────
  const diffPanel = new DiffPanelProvider(
    context.extensionUri,
    gitService,
    workspaceRoot,
    store,
    (fileIndex) => treeProvider.refreshFile(fileIndex),
  );
  context.subscriptions.push(diffPanel);

  // ── Tree view provider ────────────────────────────────────────────────────
  const treeProvider = new GitSplitViewProvider(
    store,
    (file) => diffPanel.showFile(file),
  );

  const treeView = vscode.window.createTreeView('gitSplitView', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
    canSelectMany: false,
    manageCheckboxStateManually: true,
  });

  treeView.onDidChangeCheckboxState(
    (e) => treeProvider.handleCheckboxChange(e.items),
    undefined,
    context.subscriptions,
  );

  context.subscriptions.push(treeView, treeProvider);

  // ── Load diff helper ──────────────────────────────────────────────────────
  async function loadDiff(): Promise<void> {
    const config = vscode.workspace.getConfiguration('gitSplit');
    const baseBranch: string = config.get('baseBranch', 'main');
    try {
      diffFiles = await gitService.getDiff(baseBranch);
      treeProvider.loadFiles(diffFiles);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`GitSplit: Failed to load diff — ${msg}`);
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('gitSplit.refresh', async () => {
      await loadDiff();
    }),

    vscode.commands.registerCommand('gitSplit.openFileDiff', (file: DiffFile) => {
      diffPanel.showFile(file);
    }),

    vscode.commands.registerCommand('gitSplit.selectAll', () => {
      store.setAll(true);
      treeProvider.refreshFile(-1);
    }),

    vscode.commands.registerCommand('gitSplit.deselectAll', () => {
      store.setAll(false);
      treeProvider.refreshFile(-1);
    }),

    vscode.commands.registerCommand('gitSplit.createBranch', async () => {
      if (store.totalSelected() === 0) {
        vscode.window.showWarningMessage(
          'GitSplit: No lines are selected. Select lines in the diff view first.',
        );
        return;
      }

      const branchName = await vscode.window.showInputBox({
        title: 'GitSplit: Create New Branch',
        prompt: 'Enter a name for the new branch',
        placeHolder: 'feature/my-focused-fix',
        validateInput: (v) => v.trim() ? undefined : 'Branch name cannot be empty.',
      });
      if (!branchName) return;

      const config = vscode.workspace.getConfiguration('gitSplit');
      const baseBranch: string = config.get('baseBranch', 'main');

      await diffPanel.handleCreateBranch(
        branchName.trim(),
        baseBranch,
        diffFiles,
      );

      // Reload diff after branch creation (we're back on original branch)
      await loadDiff();
    }),

    // Keep the old command registered so any existing keybindings still work
    vscode.commands.registerCommand('gitSplit.selectChanges', async () => {
      await loadDiff();
    }),
  );

  // ── Auto-load on activation if repo is valid ──────────────────────────────
  gitService.currentBranch()
    .then(() => loadDiff())
    .catch(() => { /* not a git repo — tree stays empty */ });
}

export function deactivate(): void {
  // subscriptions disposed automatically
}
