import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/gitService';
import { generatePatch } from '../patch/patchGenerator';
import { DiffFile } from '../git/diffParser';
import { SelectionStore } from '../views/selectionStore';

interface LineToggleMessage   { type: 'lineToggle';  id: string; checked: boolean; }
interface HunkToggleMessage   { type: 'hunkToggle';  lineIds: string[]; checked: boolean; }
interface ReadyMessage        { type: 'ready'; }

type WebviewInbound = LineToggleMessage | HunkToggleMessage | ReadyMessage;

/** VS Code webview panel that shows a single file's diff for line-level selection. */
export class DiffPanelProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private currentFile: DiffFile | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly gitService: GitService,
    private readonly workspaceRoot: string,
    private readonly store: SelectionStore,
    /** Called after any line/hunk toggle so the tree view can refresh. */
    private readonly onSelectionChanged: (fileIndex: number) => void,
  ) {}

  /** Open or update the panel to show a specific file's diff. */
  showFile(file: DiffFile): void {
    this.currentFile = file;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'gitSplitDiff',
        'GitSplit Diff',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'media')],
          retainContextWhenHidden: true,
        },
      );

      this.panel.webview.html = this.buildHtml(this.panel.webview);

      this.panel.webview.onDidReceiveMessage(
        (msg: WebviewInbound) => this.handleMessage(msg),
        undefined,
        this.disposables,
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }, undefined, this.disposables);
    } else {
      this.panel.reveal(vscode.ViewColumn.One, true);
    }

    const displayPath = file.newPath || file.oldPath;
    this.panel.title = path.basename(displayPath);
    this.sendFileData(file);
  }

  private sendFileData(file: DiffFile): void {
    this.postMessage({
      type: 'fileData',
      file,
      selectedIds: this.store.selectedIdsForFile(file.index),
    });
  }

  private handleMessage(msg: WebviewInbound): void {
    if (msg.type === 'ready') {
      if (this.currentFile) this.sendFileData(this.currentFile);
      return;
    }

    if (msg.type === 'lineToggle') {
      this.store.setLine(msg.id, msg.checked);
      if (this.currentFile) this.onSelectionChanged(this.currentFile.index);
      return;
    }

    if (msg.type === 'hunkToggle') {
      this.store.setHunk(msg.lineIds, msg.checked);
      if (this.currentFile) this.onSelectionChanged(this.currentFile.index);
      return;
    }
  }

  /** Create the new branch from the current selection in the store. */
  async handleCreateBranch(
    branchName: string,
    commitMessage: string,
    baseBranch: string,
    files: DiffFile[],
  ): Promise<void> {
    const selectedLineIds = this.store.getSelectedIds();

    if (selectedLineIds.length === 0) {
      vscode.window.showErrorMessage('GitSplit: No lines selected.');
      return;
    }

    // Check for uncommitted changes
    if (await this.gitService.hasUncommittedChanges().catch(() => false)) {
      const choice = await vscode.window.showWarningMessage(
        'GitSplit: Your working tree has uncommitted changes. They will be stashed before creating the branch and restored afterwards.',
        'Continue',
        'Cancel',
      );
      if (choice !== 'Continue') return;
    }

    let stashed = false;
    const originalBranch = await this.gitService.currentBranch().catch(() => '');

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'GitSplit', cancellable: false },
      async (progress) => {
        try {
          stashed = await this.gitService.hasUncommittedChanges().catch(() => false);
          if (stashed) {
            progress.report({ message: 'Stashing uncommitted changes…' });
            await this.stash();
          }

          if (await this.gitService.branchExists(branchName)) {
            vscode.window.showErrorMessage(
              `GitSplit: Branch "${branchName}" already exists. Choose a different name.`,
            );
            return;
          }

          progress.report({ message: 'Generating patch…' });
          const selectedSet = new Set(selectedLineIds);
          const patch = generatePatch(files, selectedSet);

          if (!patch.trim()) {
            vscode.window.showErrorMessage('GitSplit: Selected lines produced an empty patch.');
            return;
          }

          progress.report({ message: `Creating branch "${branchName}"…` });
          await this.gitService.createBranchFrom(branchName, baseBranch);

          progress.report({ message: 'Applying patch…' });
          try {
            await this.gitService.applyPatch(patch);
          } catch (applyErr: unknown) {
            await this.gitService.checkout(originalBranch).catch(() => undefined);
            await this.gitService.deleteBranch(branchName).catch(() => undefined);
            const m = applyErr instanceof Error ? applyErr.message : String(applyErr);
            vscode.window.showErrorMessage(`GitSplit: Patch could not be applied:\n${m}`);
            return;
          }

          progress.report({ message: 'Committing…' });
          await this.gitService.commit(commitMessage);

          const config = vscode.workspace.getConfiguration('gitSplit');
          const autoPush: boolean = config.get('autoPush', false);
          const autoOpenPR: boolean = config.get('autoOpenPR', true);
          let prUrl: string | null = null;

          if (autoPush) {
            progress.report({ message: 'Pushing branch…' });
            try {
              await this.gitService.push(branchName);
              prUrl = await this.gitService.getPRUrl(branchName, baseBranch);
            } catch (pushErr: unknown) {
              vscode.window.showWarningMessage(
                `GitSplit: Branch committed but push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`,
              );
            }
          }

          if (prUrl && autoOpenPR) {
            await vscode.env.openExternal(vscode.Uri.parse(prUrl));
          }

          const pushNote = autoPush ? ' Branch pushed.' : ' Push it manually when ready.';
          vscode.window.showInformationMessage(
            `GitSplit: Branch "${branchName}" created successfully!${pushNote}`,
          );

          await this.gitService.checkout(originalBranch).catch(() => undefined);

        } finally {
          if (stashed) await this.unstash().catch(() => undefined);
        }
      },
    );
  }

  private async stash(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cp = require('child_process') as typeof import('child_process');
      cp.execFile('git', ['stash', 'push', '--include-untracked', '-m', 'gitsplit-auto-stash'],
        { cwd: this.workspaceRoot }, (err) => err ? reject(err) : resolve());
    });
  }

  private async unstash(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cp = require('child_process') as typeof import('child_process');
      cp.execFile('git', ['stash', 'pop'],
        { cwd: this.workspaceRoot }, (err) => err ? reject(err) : resolve());
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private postMessage(msg: Record<string, any>): void {
    this.panel?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'media', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'media', 'style.css'),
    );
    const nonce = getNonce();

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>GitSplit Diff</title>
</head>
<body>
  <div id="app">
    <div id="file-header">
      <span id="file-badge" class="file-badge mod"></span>
      <span id="file-path">—</span>
    </div>
    <div id="diff-scroll">
      <div id="diff-content">
        <div class="placeholder">Click a file in the GitSplit sidebar to view its diff.</div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
