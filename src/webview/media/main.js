// @ts-check
/// <reference lib="dom" />

(function () {
  'use strict';

  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────
  /** @type {import('../../git/diffParser').DiffFile | null} */
  let currentFile = null;
  /** Set of selected line IDs (mirrors SelectionStore in extension host) */
  const selectedIds = new Set();

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const fileBadgeEl  = /** @type {HTMLElement} */ (document.getElementById('file-badge'));
  const filePathEl   = /** @type {HTMLElement} */ (document.getElementById('file-path'));
  const diffContentEl = /** @type {HTMLElement} */ (document.getElementById('diff-content'));

  // ── Message handling ──────────────────────────────────────────────────────
  window.addEventListener('message', (/** @type {MessageEvent} */ e) => {
    const msg = e.data;
    if (msg.type === 'fileData') {
      renderFile(msg.file, msg.selectedIds);
    }
  });

  vscode.postMessage({ type: 'ready' });

  // ── Render ────────────────────────────────────────────────────────────────

  /**
   * @param {import('../../git/diffParser').DiffFile} file
   * @param {string[]} initialSelected
   */
  function renderFile(file, initialSelected) {
    currentFile = file;
    selectedIds.clear();
    for (const id of initialSelected) selectedIds.add(id);

    const displayPath = file.newPath || file.oldPath;
    filePathEl.textContent = displayPath;

    const badge = fileBadge(file);
    fileBadgeEl.textContent = badge.label;
    fileBadgeEl.className = `file-badge ${badge.cls}`;

    if (file.isBinary) {
      diffContentEl.innerHTML = `<div class="placeholder">⚠ Binary file — cannot show diff.</div>`;
      return;
    }
    if (file.hunks.length === 0) {
      diffContentEl.innerHTML = `<div class="placeholder">No text changes in this file.</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const hunk of file.hunks) {
      frag.appendChild(buildHunkEl(file, hunk));
    }
    diffContentEl.innerHTML = '';
    diffContentEl.appendChild(frag);
  }

  /**
   * @param {import('../../git/diffParser').DiffFile} file
   * @param {import('../../git/diffParser').DiffHunk} hunk
   */
  function buildHunkEl(file, hunk) {
    const container = document.createElement('div');
    container.className = 'diff-hunk';

    // ── Hunk header row (with checkbox) ──────────────────────────────────
    const headerRow = document.createElement('div');
    headerRow.className = 'hunk-header-row';

    const hunkCbCell = document.createElement('div');
    hunkCbCell.className = 'hunk-cb-cell';
    const hunkCb = document.createElement('input');
    hunkCb.type = 'checkbox';
    hunkCb.title = 'Select / deselect entire hunk';

    const changeLineIds = hunk.lines
      .filter((l) => l.type !== 'context')
      .map((l) => l.id);

    // Initial check state
    const selectedCount = changeLineIds.filter((id) => selectedIds.has(id)).length;
    hunkCb.checked = selectedCount > 0;
    hunkCb.indeterminate = selectedCount > 0 && selectedCount < changeLineIds.length;

    hunkCb.addEventListener('change', () => {
      const checked = hunkCb.checked;
      hunkCb.indeterminate = false;
      // Update local state
      for (const id of changeLineIds) {
        if (checked) selectedIds.add(id);
        else selectedIds.delete(id);
      }
      // Sync line checkboxes in DOM
      for (const id of changeLineIds) {
        const cb = /** @type {HTMLInputElement|null} */ (
          container.querySelector(`input[data-id="${CSS.escape(id)}"]`)
        );
        if (cb) {
          cb.checked = checked;
          const row = cb.closest('.diff-line');
          if (row) row.classList.toggle('deselected', !checked);
        }
      }
      // Tell extension host
      vscode.postMessage({ type: 'hunkToggle', lineIds: changeLineIds, checked });
    });

    hunkCbCell.appendChild(hunkCb);
    headerRow.appendChild(hunkCbCell);

    // Two blank number-gutter spacers to align with diff lines
    for (let i = 0; i < 2; i++) {
      const sp = document.createElement('div');
      sp.className = 'hunk-num-spacer';
      headerRow.appendChild(sp);
    }

    const label = document.createElement('div');
    label.className = 'hunk-label';
    label.textContent =
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` +
      (hunk.contextLabel ? '  ' + hunk.contextLabel : '');
    headerRow.appendChild(label);
    container.appendChild(headerRow);

    // ── Lines ─────────────────────────────────────────────────────────────
    for (const line of hunk.lines) {
      container.appendChild(buildLineEl(line, hunkCb, changeLineIds));
    }

    return container;
  }

  /**
   * @param {import('../../git/diffParser').DiffLine} line
   * @param {HTMLInputElement} hunkCb  Parent hunk checkbox (to update indeterminate state)
   * @param {string[]} changeLineIds   All selectable IDs in this hunk
   */
  function buildLineEl(line, hunkCb, changeLineIds) {
    const row = document.createElement('div');
    const isChange = line.type !== 'context';
    row.className = `diff-line ${line.type}`;
    if (isChange && !selectedIds.has(line.id)) row.classList.add('deselected');

    // Checkbox cell (blank for context lines)
    const cbCell = document.createElement('div');
    cbCell.className = 'line-cb-cell';

    if (isChange) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = line.id;
      cb.checked = selectedIds.has(line.id);

      cb.addEventListener('change', () => {
        const checked = cb.checked;
        if (checked) selectedIds.add(line.id);
        else selectedIds.delete(line.id);
        row.classList.toggle('deselected', !checked);
        updateHunkCheckbox(hunkCb, changeLineIds);
        vscode.postMessage({ type: 'lineToggle', id: line.id, checked });
      });

      // Clicking anywhere on the row toggles the checkbox
      row.addEventListener('click', (e) => {
        if (e.target !== cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      });

      cbCell.appendChild(cb);
    }

    row.appendChild(cbCell);

    // Old line number
    const oldNum = document.createElement('div');
    oldNum.className = 'line-num';
    oldNum.textContent = line.oldLineNum != null ? String(line.oldLineNum) : '';
    row.appendChild(oldNum);

    // New line number
    const newNum = document.createElement('div');
    newNum.className = 'line-num';
    newNum.textContent = line.newLineNum != null ? String(line.newLineNum) : '';
    row.appendChild(newNum);

    // Sign
    const sign = document.createElement('div');
    sign.className = 'line-sign';
    sign.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
    row.appendChild(sign);

    // Content
    const content = document.createElement('div');
    content.className = 'line-content';
    content.textContent = line.content;
    row.appendChild(content);

    return row;
  }

  /**
   * Keep the hunk checkbox in sync after a per-line toggle.
   * @param {HTMLInputElement} hunkCb
   * @param {string[]} ids
   */
  function updateHunkCheckbox(hunkCb, ids) {
    const sel = ids.filter((id) => selectedIds.has(id)).length;
    hunkCb.indeterminate = sel > 0 && sel < ids.length;
    hunkCb.checked = sel > 0;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /**
   * @param {import('../../git/diffParser').DiffFile} file
   * @returns {{ label: string, cls: string }}
   */
  function fileBadge(file) {
    if (file.isBinary)  return { label: 'BIN', cls: 'bin' };
    if (file.isNew)     return { label: 'NEW', cls: 'new' };
    if (file.isDeleted) return { label: 'DEL', cls: 'del' };
    return { label: 'MOD', cls: 'mod' };
  }
})();
