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
  /** Cache of line checkboxes and rows for O(1) lookup in hunk toggles */
  /** @type {Map<string, {cb: HTMLInputElement, row: HTMLElement}>} */
  const lineCheckboxMap = new Map();

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const fileBadgeEl  = /** @type {HTMLElement} */ (document.getElementById('file-badge'));
  const filePathEl   = /** @type {HTMLElement} */ (document.getElementById('file-path'));
  const diffContentEl = /** @type {HTMLElement} */ (document.getElementById('diff-content'));
  const btnSelect    = /** @type {HTMLButtonElement} */ (document.getElementById('btn-select-highlighted'));
  const btnDeselect  = /** @type {HTMLButtonElement} */ (document.getElementById('btn-deselect-highlighted'));
  const selectionActionsEl = /** @type {HTMLElement} */ (document.getElementById('selection-actions'));
  const popupSelectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-popup-select'));
  const popupDeselectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-popup-deselect'));
  /** @type {string[]} */
  let highlightedLineIds = [];

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
    lineCheckboxMap.clear();
    highlightedLineIds = [];
    hideSelectionActions();
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
      // Sync line checkboxes in DOM via cached references
      for (const id of changeLineIds) {
        const entry = lineCheckboxMap.get(id);
        if (entry) {
          entry.cb.checked = checked;
          entry.row.classList.toggle('deselected', !checked);
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

      cbCell.appendChild(cb);
      lineCheckboxMap.set(line.id, { cb, row });
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

  // ── Highlighted selection helpers ──────────────────────────────────────────

  /**
   * Return the line IDs of all changed (add/del) diff lines that overlap
   * with the current native text selection.
   * @returns {string[]}
   */
  function getHighlightedLineIds() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];

    const range = sel.getRangeAt(0);
    const selectionRects = Array.from(range.getClientRects()).filter(rectHasVisibleArea);
    if (selectionRects.length === 0) return [];
    /** @type {string[]} */
    const ids = [];

    for (const [id, entry] of lineCheckboxMap) {
      if (rowIntersectsSelection(entry.row, selectionRects)) {
        ids.push(id);
      }
    }
    return ids;
  }

  function hideSelectionActions() {
    selectionActionsEl.classList.remove('visible');
    selectionActionsEl.setAttribute('aria-hidden', 'true');
  }

  /**
   * @param {DOMRect} rect
   */
  function positionSelectionActions(rect) {
    const popupRect = selectionActionsEl.getBoundingClientRect();
    const top = Math.max(8, rect.top - popupRect.height - 8);
    const centeredLeft = rect.left + (rect.width / 2) - (popupRect.width / 2);
    const maxLeft = Math.max(8, window.innerWidth - popupRect.width - 8);
    const left = Math.min(Math.max(8, centeredLeft), maxLeft);

    selectionActionsEl.style.top = `${top}px`;
    selectionActionsEl.style.left = `${left}px`;
  }

  function updateSelectionActions() {
    const sel = window.getSelection();
    highlightedLineIds = getHighlightedLineIds();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || highlightedLineIds.length === 0) {
      hideSelectionActions();
      return;
    }

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hideSelectionActions();
      return;
    }

    selectionActionsEl.classList.add('visible');
    selectionActionsEl.setAttribute('aria-hidden', 'false');
    positionSelectionActions(rect);
  }

  /**
   * @param {DOMRect | { width: number, height: number }} rect
   * @returns {boolean}
   */
  function rectHasVisibleArea(rect) {
    return rect.width > 0 || rect.height > 0;
  }

  /**
   * @param {DOMRect | { top: number, right: number, bottom: number, left: number }} a
   * @param {DOMRect | { top: number, right: number, bottom: number, left: number }} b
   * @returns {boolean}
   */
  function rectsIntersect(a, b) {
    return a.top < b.bottom &&
           a.bottom > b.top &&
           a.left < b.right &&
           a.right > b.left;
  }

  /**
   * Check whether a row intersects any selection client rect.
   * @param {HTMLElement} el
   * @param {(DOMRect | { top: number, right: number, bottom: number, left: number, width: number, height: number })[]} selectionRects
   * @returns {boolean}
   */
  function rowIntersectsSelection(el, selectionRects) {
    const rowRect = el.getBoundingClientRect();
    return selectionRects.some((selectionRect) => rectsIntersect(rowRect, selectionRect));
  }

  /**
   * Toggle the given line IDs to a specific checked state, updating UI and notifying the host.
   * @param {string[]} ids
   * @param {boolean} checked
   */
  function batchToggleLines(ids, checked) {
    if (ids.length === 0) return;

    for (const id of ids) {
      if (checked) selectedIds.add(id);
      else selectedIds.delete(id);
      const entry = lineCheckboxMap.get(id);
      if (entry) {
        entry.cb.checked = checked;
        entry.row.classList.toggle('deselected', !checked);
      }
    }

    // Update any parent hunk checkboxes that may be affected
    document.querySelectorAll('.diff-hunk').forEach((hunkEl) => {
      const hunkCb = /** @type {HTMLInputElement | null} */ (
        hunkEl.querySelector('.hunk-cb-cell input[type=checkbox]')
      );
      if (!hunkCb) return;
      const hunkLineIds = Array.from(
        /** @type {NodeListOf<HTMLInputElement>} */ (
          hunkEl.querySelectorAll('.line-cb-cell input[type=checkbox]')
        ),
      )
        .map((cb) => cb.dataset.id)
        .filter(Boolean);
      if (hunkLineIds.some((lid) => ids.includes(/** @type {string} */ (lid)))) {
        updateHunkCheckbox(hunkCb, /** @type {string[]} */ (hunkLineIds));
      }
    });

    vscode.postMessage({ type: 'batchToggle', lineIds: ids, checked });
  }

  /**
   * @param {boolean} checked
   */
  function applyHighlightedSelection(checked) {
    const ids = highlightedLineIds.length > 0 ? [...highlightedLineIds] : getHighlightedLineIds();
    batchToggleLines(ids, checked);
    highlightedLineIds = [];
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    hideSelectionActions();
  }

  // ── Button handlers ────────────────────────────────────────────────────────

  btnSelect.addEventListener('click', () => {
    const ids = getHighlightedLineIds();
    batchToggleLines(ids, true);
  });

  btnDeselect.addEventListener('click', () => {
    const ids = getHighlightedLineIds();
    batchToggleLines(ids, false);
  });

  for (const btn of [popupSelectBtn, popupDeselectBtn]) {
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
  }

  popupSelectBtn.addEventListener('click', () => {
    applyHighlightedSelection(true);
  });

  popupDeselectBtn.addEventListener('click', () => {
    applyHighlightedSelection(false);
  });

  // ── Keyboard shortcuts (Ctrl+Shift+S / Ctrl+Shift+D) ──────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey) {
      if (e.key === 'S' || e.key === 's') {
        e.preventDefault();
        const ids = getHighlightedLineIds();
        batchToggleLines(ids, true);
      } else if (e.key === 'D' || e.key === 'd') {
        e.preventDefault();
        const ids = getHighlightedLineIds();
        batchToggleLines(ids, false);
      }
    }
  });

  document.addEventListener('selectionchange', () => {
    updateSelectionActions();
  });

  document.addEventListener('scroll', () => {
    if (selectionActionsEl.classList.contains('visible')) updateSelectionActions();
  }, true);

  window.addEventListener('resize', () => {
    if (selectionActionsEl.classList.contains('visible')) updateSelectionActions();
  });
})();
