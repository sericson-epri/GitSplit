import * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { DiffPanelProvider } from './webview/diffPanelProvider';

let panelProvider: DiffPanelProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const cmd = vscode.commands.registerCommand('gitSplit.selectChanges', async () => {
    // Resolve workspace root
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('GitSplit: No workspace folder is open.');
      return;
    }

    const gitService = new GitService(workspaceRoot);

    // Verify the folder is a git repo
    try {
      await gitService.currentBranch();
    } catch {
      vscode.window.showErrorMessage(
        'GitSplit: The current workspace is not inside a Git repository.',
      );
      return;
    }

    // Warn about uncommitted changes (informational — provider handles stashing)
    const dirty = await gitService.hasUncommittedChanges().catch(() => false);
    if (dirty) {
      const choice = await vscode.window.showWarningMessage(
        'GitSplit: Your working tree has uncommitted changes. They will be stashed automatically before creating the clean branch and restored afterwards.',
        { modal: false },
        'OK',
        'Cancel',
      );
      if (choice !== 'OK') return;
    }

    const config = vscode.workspace.getConfiguration('gitSplit');
    const baseBranch: string = config.get('baseBranch', 'main');

    // Reuse or create the panel provider
    if (!panelProvider || isPanelDisposed()) {
      panelProvider = new DiffPanelProvider(
        context.extensionUri,
        gitService,
        workspaceRoot,
      );
      context.subscriptions.push(panelProvider);
    }

    await panelProvider.show(baseBranch);
  });

  context.subscriptions.push(cmd);
}

export function deactivate(): void {
  panelProvider?.dispose();
}

function isPanelDisposed(): boolean {
  try {
    // DiffPanelProvider sets panel to undefined when disposed
    return panelProvider === undefined;
  } catch {
    return true;
  }
}
