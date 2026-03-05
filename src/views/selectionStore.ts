import { DiffFile } from '../git/diffParser';

/**
 * Central store for which diff lines have been selected across all files.
 * The tree view manages file-level toggles; the diff webview manages per-line toggles.
 * Both write through this store so state stays consistent.
 */
export class SelectionStore {
  /** lineId → selected */
  private readonly selected = new Set<string>();
  /** fileIndex → array of all selectable line IDs in that file */
  private fileLineIds = new Map<number, string[]>();

  /** Replace the entire file map when a fresh diff is loaded. */
  loadFiles(files: DiffFile[]): void {
    this.selected.clear();
    this.fileLineIds.clear();
    for (const file of files) {
      if (file.isBinary) continue;
      const ids: string[] = [];
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type !== 'context') {
            ids.push(line.id);
            this.selected.add(line.id); // default: all selected
          }
        }
      }
      this.fileLineIds.set(file.index, ids);
    }
  }

  /** Select or deselect all lines belonging to a file. */
  setFile(fileIndex: number, select: boolean): void {
    const ids = this.fileLineIds.get(fileIndex) ?? [];
    for (const id of ids) {
      if (select) this.selected.add(id);
      else this.selected.delete(id);
    }
  }

  /** Toggle a single line. */
  setLine(id: string, select: boolean): void {
    if (select) this.selected.add(id);
    else this.selected.delete(id);
  }

  /** Toggle all lines in a hunk (identified by their IDs passed in). */
  setHunk(lineIds: string[], select: boolean): void {
    for (const id of lineIds) {
      if (select) this.selected.add(id);
      else this.selected.delete(id);
    }
  }

  isSelected(id: string): boolean {
    return this.selected.has(id);
  }

  /**
   * Returns the check state of a file:
   *  - 1 = all lines selected
   *  - 0 = no lines selected
   *  - 0.5 = some lines selected (partial)
   */
  fileCheckState(fileIndex: number): 0 | 0.5 | 1 {
    const ids = this.fileLineIds.get(fileIndex) ?? [];
    if (ids.length === 0) return 0;
    const count = ids.filter((id) => this.selected.has(id)).length;
    if (count === 0) return 0;
    if (count === ids.length) return 1;
    return 0.5;
  }

  /** Select or deselect every line across all files. */
  setAll(select: boolean): void {
    if (select) {
      for (const ids of this.fileLineIds.values()) {
        for (const id of ids) this.selected.add(id);
      }
    } else {
      this.selected.clear();
    }
  }

  getSelectedIds(): string[] {
    return Array.from(this.selected);
  }

  totalSelected(): number {
    return this.selected.size;
  }

  /** IDs selected for a specific file (used when opening the diff panel). */
  selectedIdsForFile(fileIndex: number): string[] {
    const ids = this.fileLineIds.get(fileIndex) ?? [];
    return ids.filter((id) => this.selected.has(id));
  }
}
