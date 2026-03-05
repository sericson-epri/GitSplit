import * as vscode from 'vscode';
import { DiffFile } from '../git/diffParser';
import { SelectionStore } from './selectionStore';

/** One item in the tree = one changed file. */
export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly file: DiffFile,
    checkState: vscode.TreeItemCheckboxState,
  ) {
    const displayPath = file.newPath || file.oldPath;
    const shortName = displayPath.split('/').pop() ?? displayPath;
    super(shortName, vscode.TreeItemCollapsibleState.None);

    this.description = displayPath.includes('/')
      ? displayPath.substring(0, displayPath.lastIndexOf('/'))
      : undefined;

    this.tooltip = displayPath;
    this.resourceUri = vscode.Uri.file(displayPath);
    this.checkboxState = checkState;
    this.contextValue = 'gitSplitFile';

    // Clicking the item opens the diff panel
    this.command = {
      command: 'gitSplit.openFileDiff',
      title: 'Open Diff',
      arguments: [file],
    };
  }
}

/**
 * Drives the "GitSplit" tree view in the SCM sidebar.
 * Loads the full diff on construction/refresh and delegates selection state
 * to `SelectionStore`.
 */
export class GitSplitViewProvider
  implements vscode.TreeDataProvider<FileItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<FileItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private files: DiffFile[] = [];

  constructor(private readonly store: SelectionStore) {}

  /** Load (or reload) the diff. Called by the extension when the view is shown or refreshed. */
  loadFiles(files: DiffFile[]): void {
    this.files = files;
    this.store.loadFiles(files);
    this._onDidChangeTreeData.fire();
  }

  /** Re-render a specific file item (e.g. after line-level selection changes in the webview). */
  refreshFile(fileIndex: number): void {
    // Fire without an argument to refresh everything — VS Code tree view doesn't support
    // partial refresh for checkbox state reliably across all versions.
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileItem): FileItem[] {
    if (element) return [];
    return this.files.map((file) => {
      const state = this.store.fileCheckState(file.index);
      const checkState =
        state === 0
          ? vscode.TreeItemCheckboxState.Unchecked
          : vscode.TreeItemCheckboxState.Checked;
      return new FileItem(file, checkState);
    });
  }

  /** Called by VS Code when the user toggles a file checkbox. */
  handleCheckboxChange(
    changes: ReadonlyArray<[FileItem, vscode.TreeItemCheckboxState]>,
  ): void {
    for (const [item, state] of changes) {
      this.store.setFile(
        item.file.index,
        state === vscode.TreeItemCheckboxState.Checked,
      );
    }
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
