import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../git/gitService';
import { generatePatch } from '../patch/patchGenerator';
import { DiffFile } from '../git/diffParser';

interface CreateBranchMessage {
  type: 'createBranch';
  branchName: string;
  commitMessage: string;
  selectedLineIds: string[];
}

interface ReadyMessage {
  type: 'ready';
}

type WebviewInbound = CreateBranchMessage | ReadyMessage;

/** VS Code webview panel that hosts the diff selection UI. */
export class DiffPanelProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly gitService: GitService,
    private readonly workspaceRoot: string,
  ) {}

  /** Open (or reveal) the diff selection panel. */
  async show(baseBranch: string): Promise<void> {
    // Reuse existing panel if open
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.loadDiff(baseBranch);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'gitSplitDiff',
      'GitSplit: Select Changes',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'media')],
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewInbound) => this.handleMessage(msg, baseBranch),
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, undefined, this.disposables);

    // Wait for the webview to signal it's ready, then send diff data
    await this.loadDiff(baseBranch);
  }

  private async loadDiff(baseBranch: string): Promise<void> {
    this.postMessage({ type: 'loading' });
    try {
      const files = await this.gitService.getDiff(baseBranch);
      this.postMessage({ type: 'diffData', files, baseBranch });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message: `Failed to get diff: ${msg}` });
    }
  }

  private async handleMessage(msg: WebviewInbound, baseBranch: string): Promise<void> {
    if (msg.type === 'ready') {
      await this.loadDiff(baseBranch);
      return;
    }

    if (msg.type === 'createBranch') {
      await this.handleCreateBranch(msg, baseBranch);
    }
  }

  private async handleCreateBranch(
    msg: CreateBranchMessage,
    baseBranch: string,
  ): Promise<void> {
    const { branchName, commitMessage, selectedLineIds } = msg;

    // Validate inputs
    if (!branchName.trim()) {
      this.postMessage({ type: 'error', message: 'Branch name cannot be empty.' });
      return;
    }
    if (!commitMessage.trim()) {
      this.postMessage({ type: 'error', message: 'Commit message cannot be empty.' });
      return;
    }
    if (selectedLineIds.length === 0) {
      this.postMessage({ type: 'error', message: 'No lines selected.' });
      return;
    }

    // Check for uncommitted changes
    try {
      if (await this.gitService.hasUncommittedChanges()) {
        const choice = await vscode.window.showWarningMessage(
          'Your working tree has uncommitted changes. GitSplit will stash them before creating the branch and restore them afterwards.',
          'Continue',
          'Cancel',
        );
        if (choice !== 'Continue') return;
        // Stash
        await this.stash();
      }
    } catch (err: unknown) {
      this.showError(err);
      return;
    }

    let stashed = false;
    const originalBranch = await this.gitService.currentBranch().catch(() => '');

    try {
      stashed = await this.gitService.hasUncommittedChanges();
      if (stashed) {
        await this.stash();
      }

      // Check if target branch already exists
      if (await this.gitService.branchExists(branchName)) {
        this.postMessage({
          type: 'error',
          message: `Branch "${branchName}" already exists. Please choose a different name.`,
        });
        return;
      }

      this.postMessage({ type: 'progress', message: 'Getting diff…' });
      const files: DiffFile[] = await this.gitService.getDiff(baseBranch);
      const selectedSet = new Set(selectedLineIds);
      const patch = generatePatch(files, selectedSet);

      if (!patch.trim()) {
        this.postMessage({ type: 'error', message: 'Selected lines produced an empty patch.' });
        return;
      }

      this.postMessage({ type: 'progress', message: `Creating branch "${branchName}"…` });
      await this.gitService.createBranchFrom(branchName, baseBranch);

      this.postMessage({ type: 'progress', message: 'Applying patch…' });
      try {
        await this.gitService.applyPatch(patch);
      } catch (applyErr: unknown) {
        // Clean up the newly created branch before surfacing error
        await this.gitService.checkout(originalBranch).catch(() => undefined);
        await this.gitService.deleteBranch(branchName).catch(() => undefined);
        const msg2 = applyErr instanceof Error ? applyErr.message : String(applyErr);
        this.postMessage({ type: 'error', message: `Patch could not be applied cleanly:\n${msg2}` });
        return;
      }

      this.postMessage({ type: 'progress', message: 'Committing…' });
      await this.gitService.commit(commitMessage);

      const config = vscode.workspace.getConfiguration('gitSplit');
      const autoPush: boolean = config.get('autoPush', false);
      const autoOpenPR: boolean = config.get('autoOpenPR', true);

      let prUrl: string | null = null;

      if (autoPush) {
        this.postMessage({ type: 'progress', message: 'Pushing branch…' });
        try {
          await this.gitService.push(branchName);
          prUrl = await this.gitService.getPRUrl(branchName, baseBranch);
        } catch (pushErr: unknown) {
          vscode.window.showWarningMessage(
            `Branch committed locally but push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`,
          );
        }
      }

      if (prUrl && autoOpenPR) {
        await vscode.env.openExternal(vscode.Uri.parse(prUrl));
      }

      this.postMessage({
        type: 'success',
        message: `Branch "${branchName}" created successfully!${autoPush ? ' Branch pushed.' : ' Push it manually when ready.'}`,
        prUrl: prUrl ?? undefined,
      });

      // Switch back to original branch so user isn't left on the new branch
      await this.gitService.checkout(originalBranch).catch(() => undefined);

    } catch (err: unknown) {
      this.showError(err);
    } finally {
      if (stashed) {
        await this.unstash().catch(() => undefined);
      }
    }
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

  private showError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.postMessage({ type: 'error', message: msg });
    vscode.window.showErrorMessage(`GitSplit: ${msg}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private postMessage(msg: Record<string, any>): void {
    this.panel?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    // Try to load from media files on disk; fall back to inline.
    const mediaDir = path.join(this.extensionUri.fsPath, 'src', 'webview', 'media');

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
  <title>GitSplit</title>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <h1 class="logo">🔀 GitSplit</h1>
      <div id="toolbar-actions">
        <button id="btn-select-all" class="btn btn-secondary">Select All</button>
        <button id="btn-deselect-all" class="btn btn-secondary">Deselect All</button>
        <button id="btn-create" class="btn btn-primary" disabled>Create Branch &amp; Commit</button>
      </div>
    </div>

    <div id="main-area">
      <div id="file-list-panel">
        <div class="panel-header">Changed Files</div>
        <div id="file-list"></div>
      </div>
      <div id="diff-panel">
        <div id="diff-content">
          <div class="placeholder">Loading diff…</div>
        </div>
      </div>
    </div>

    <!-- Create Branch Modal -->
    <div id="modal-overlay" class="hidden">
      <div id="modal">
        <h2>Create Branch &amp; Commit</h2>
        <label for="input-branch">New branch name</label>
        <input id="input-branch" type="text" placeholder="feature/my-focused-fix" spellcheck="false" />
        <label for="input-message">Commit message</label>
        <textarea id="input-message" rows="3" placeholder="fix: correct off-by-one in pagination"></textarea>
        <div class="modal-actions">
          <button id="btn-modal-cancel" class="btn btn-secondary">Cancel</button>
          <button id="btn-modal-confirm" class="btn btn-primary">Create</button>
        </div>
      </div>
    </div>

    <!-- Status bar at bottom -->
    <div id="status-bar">
      <span id="status-text">Select the changes you want in your PR, then click "Create Branch &amp; Commit".</span>
      <span id="selection-count"></span>
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
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
