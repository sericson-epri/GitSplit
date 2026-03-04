// @ts-check
/// <reference lib="dom" />

(function () {
  'use strict';

  // ── VS Code API ─────────────────────────────────────────────────────────
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── State ───────────────────────────────────────────────────────────────
  /** @type {import('../../git/diffParser').DiffFile[]} */
  let diffFiles = [];
  /** Set of selected line IDs */
  const selectedIds = new Set();
  /** Currently visible file index */
  let activeFileIndex = 0;

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const fileListEl = /** @type {HTMLElement} */ (document.getElementById('file-list'));
  const diffContentEl = /** @type {HTMLElement} */ (document.getElementById('diff-content'));
  const btnCreate = /** @type {HTMLButtonElement} */ (document.getElementById('btn-create'));
  const btnSelectAll = /** @type {HTMLButtonElement} */ (document.getElementById('btn-select-all'));
  const btnDeselectAll = /** @type {HTMLButtonElement} */ (document.getElementById('btn-deselect-all'));
  const modalOverlay = /** @type {HTMLElement} */ (document.getElementById('modal-overlay'));
  const inputBranch = /** @type {HTMLInputElement} */ (document.getElementById('input-branch'));
  const inputMessage = /** @type {HTMLTextAreaElement} */ (document.getElementById('input-message'));
  const btnModalCancel = /** @type {HTMLButtonElement} */ (document.getElementById('btn-modal-cancel'));
  const btnModalConfirm = /** @type {HTMLButtonElement} */ (document.getElementById('btn-modal-confirm'));
  const statusText = /** @type {HTMLElement} */ (document.getElementById('status-text'));
  const selectionCount = /** @type {HTMLElement} */ (document.getElementById('selection-count'));

  // ── Event wiring ─────────────────────────────────────────────────────────
  btnCreate.addEventListener('click', openModal);
  btnSelectAll.addEventListener('click', () => selectAllLines(true));
  btnDeselectAll.addEventListener('click', () => selectAllLines(false));
  btnModalCancel.addEventListener('click', closeModal);
  btnModalConfirm.addEventListener('click', confirmCreate);

  // Close modal on overlay click
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) closeModal();
  });

  // ── Message handling ──────────────────────────────────────────────────────
  window.addEventListener('message', (/** @type {MessageEvent} */ e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'loading':
        showBanner('info', '⏳ Loading diff…', true);
        break;
      case 'diffData':
        renderDiff(msg.files, msg.baseBranch);
        break;
      case 'progress':
        showBanner('info', msg.message, true);
        setStatus(msg.message);
        break;
      case 'error':
        showBanner('error', msg.message, false);
        setStatus('Error — see details above.');
        btnModalConfirm.disabled = false;
        break;
      case 'success':
        closeModal();
        showBanner('success', msg.message + (msg.prUrl ? `\n<a href="${msg.prUrl}" target="_blank">Open PR →</a>` : ''), false);
        setStatus('Done!');
        break;
    }
  });

  // Signal ready to extension host
  vscode.postMessage({ type: 'ready' });

  // ── Render ────────────────────────────────────────────────────────────────

  /**
   * @param {import('../../git/diffParser').DiffFile[]} files
   * @param {string} baseBranch
   */
  function renderDiff(files, baseBranch) {
    diffFiles = files;
    selectedIds.clear();

    // Pre-select ALL changed lines
    for (const file of files) {
      if (file.isBinary) continue;
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type !== 'context') selectedIds.add(line.id);
        }
      }
    }

    renderFileList();
    if (files.length > 0) {
      showFile(0);
    } else {
      diffContentEl.innerHTML = '<div class="placeholder">No changes found between HEAD and ' + escHtml(baseBranch) + '.</div>';
    }

    updateUI();
    setStatus('Diff loaded. Review and select the changes for your PR.');
  }

  function renderFileList() {
    fileListEl.innerHTML = '';
    for (const file of diffFiles) {
      const div = document.createElement('div');
      div.className = 'file-item' + (file.index === activeFileIndex ? ' active' : '');
      div.dataset.fileIndex = String(file.index);

      const badge = fileBadge(file);
      const name = file.newPath || file.oldPath;
      const shortName = name.split('/').pop() || name;
      const dirPart = name.includes('/') ? name.substring(0, name.lastIndexOf('/') + 1) : '';

      div.innerHTML = `<span class="file-badge ${badge.cls}">${badge.label}</span>
        <span class="file-name" title="${escHtml(name)}">${escHtml(dirPart)}<strong>${escHtml(shortName)}</strong></span>
        <span class="file-sel-count" id="fsc-${file.index}"></span>`;

      div.addEventListener('click', () => showFile(file.index));
      fileListEl.appendChild(div);
    }
    updateSelectionCounts();
  }

  /** @param {number} idx */
  function showFile(idx) {
    activeFileIndex = idx;

    // Update active state in file list
    for (const el of fileListEl.querySelectorAll('.file-item')) {
      el.classList.toggle('active', /** @type {HTMLElement} */(el).dataset.fileIndex === String(idx));
    }

    const file = diffFiles[idx];
    if (!file) return;

    if (file.isBinary) {
      diffContentEl.innerHTML = `<div class="placeholder">⚠️ Binary file — <code>${escHtml(file.newPath || file.oldPath)}</code> — cannot be diff-selected.</div>`;
      return;
    }

    if (file.hunks.length === 0) {
      diffContentEl.innerHTML = `<div class="placeholder">No text changes in this file.</div>`;
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'diff-file';

    // File header
    const { label: badgeLabel, cls: badgeCls } = fileBadge(file);
    const headerDiv = document.createElement('div');
    headerDiv.className = 'diff-file-header';
    headerDiv.innerHTML = `<span class="file-badge ${badgeCls}">${badgeLabel}</span>
      <span>${escHtml(file.newPath || file.oldPath)}</span>
      <button class="hunk-select-all" data-fi="${file.index}" data-all="true">Select all in file</button>`;
    headerDiv.querySelector('.hunk-select-all')?.addEventListener('click', (e) => {
      const btn = /** @type {HTMLButtonElement} */(e.currentTarget);
      const all = btn.dataset.all === 'true';
      toggleFile(file, all);
      btn.dataset.all = all ? 'false' : 'true';
      btn.textContent = all ? 'Deselect all in file' : 'Select all in file';
    });
    wrapper.appendChild(headerDiv);

    // Hunks
    for (const hunk of file.hunks) {
      wrapper.appendChild(buildHunkEl(file, hunk));
    }

    diffContentEl.innerHTML = '';
    diffContentEl.appendChild(wrapper);

    // Re-apply selected state to checkboxes after DOM update
    syncCheckboxes();
  }

  /**
   * @param {import('../../git/diffParser').DiffFile} file
   * @param {import('../../git/diffParser').DiffHunk} hunk
   */
  function buildHunkEl(file, hunk) {
    const hunkDiv = document.createElement('div');
    hunkDiv.className = 'diff-hunk';
    hunkDiv.dataset.fileIndex = String(file.index);
    hunkDiv.dataset.hunkIndex = String(hunk.index);

    // Hunk header row
    const hunkHeader = document.createElement('div');
    hunkHeader.className = 'hunk-header';
    hunkHeader.innerHTML = `<span>@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</span>
      ${hunk.contextLabel ? `<span>${escHtml(hunk.contextLabel)}</span>` : ''}
      <button class="hunk-toggle-all" data-fi="${file.index}" data-hi="${hunk.index}" data-all="true">Select hunk</button>`;
    hunkHeader.querySelector('.hunk-toggle-all')?.addEventListener('click', (e) => {
      const btn = /** @type {HTMLButtonElement} */(e.currentTarget);
      const all = btn.dataset.all === 'true';
      toggleHunk(hunk, all);
      btn.dataset.all = all ? 'false' : 'true';
      btn.textContent = all ? 'Deselect hunk' : 'Select hunk';
      syncCheckboxes();
      updateUI();
    });
    hunkDiv.appendChild(hunkHeader);

    // Lines
    for (const line of hunk.lines) {
      hunkDiv.appendChild(buildLineEl(line));
    }

    return hunkDiv;
  }

  /** @param {import('../../git/diffParser').DiffLine} line */
  function buildLineEl(line) {
    const div = document.createElement('div');
    const isChange = line.type !== 'context';
    div.className = `diff-line ${line.type}${isChange ? ' selectable' : ''}`;
    div.dataset.lineId = line.id;

    const oldNum = line.oldLineNum != null ? String(line.oldLineNum) : '';
    const newNum = line.newLineNum != null ? String(line.newLineNum) : '';
    const sign = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';

    if (isChange) {
      div.innerHTML = `<div class="line-checkbox-cell"><input type="checkbox" data-id="${escHtml(line.id)}" /></div>
        <div class="line-num" title="old">${escHtml(oldNum)}</div>
        <div class="line-num" title="new">${escHtml(newNum)}</div>
        <div class="line-sign">${sign}</div>
        <div class="line-content">${escHtml(line.content)}</div>`;

      const cb = /** @type {HTMLInputElement} */ (div.querySelector('input[type=checkbox]'));
      cb.checked = selectedIds.has(line.id);
      if (cb.checked) div.classList.add('selected');

      cb.addEventListener('change', () => {
        toggleLine(line.id, cb.checked);
        div.classList.toggle('selected', cb.checked);
        updateUI();
      });
      div.addEventListener('click', (e) => {
        if (e.target !== cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      });
    } else {
      div.innerHTML = `<div class="line-checkbox-cell"></div>
        <div class="line-num">${escHtml(oldNum)}</div>
        <div class="line-num">${escHtml(newNum)}</div>
        <div class="line-sign"> </div>
        <div class="line-content">${escHtml(line.content)}</div>`;
    }

    return div;
  }

  // ── Selection helpers ─────────────────────────────────────────────────────

  /** @param {string} id @param {boolean} checked */
  function toggleLine(id, checked) {
    if (checked) selectedIds.add(id);
    else selectedIds.delete(id);
    updateSelectionCounts();
  }

  /**
   * @param {import('../../git/diffParser').DiffFile} file
   * @param {boolean} select
   */
  function toggleFile(file, select) {
    for (const hunk of file.hunks) {
      toggleHunk(hunk, select);
    }
    syncCheckboxes();
    updateUI();
  }

  /**
   * @param {import('../../git/diffParser').DiffHunk} hunk
   * @param {boolean} select
   */
  function toggleHunk(hunk, select) {
    for (const line of hunk.lines) {
      if (line.type !== 'context') {
        if (select) selectedIds.add(line.id);
        else selectedIds.delete(line.id);
      }
    }
    updateSelectionCounts();
  }

  /** @param {boolean} select */
  function selectAllLines(select) {
    for (const file of diffFiles) {
      if (!file.isBinary) toggleFile(file, select);
    }
    if (activeFileIndex != null) showFile(activeFileIndex);
    updateUI();
  }

  /** Re-sync checkbox checked state from `selectedIds` (after DOM rebuild). */
  function syncCheckboxes() {
    /** @type {NodeListOf<HTMLInputElement>} */
    const checkboxes = diffContentEl.querySelectorAll('input[type=checkbox]');
    for (const cb of checkboxes) {
      const checked = selectedIds.has(cb.dataset.id || '');
      cb.checked = checked;
      const lineDiv = cb.closest('.diff-line');
      if (lineDiv) lineDiv.classList.toggle('selected', checked);
    }
    updateSelectionCounts();
  }

  function updateSelectionCounts() {
    for (const file of diffFiles) {
      const el = document.getElementById(`fsc-${file.index}`);
      if (!el) continue;
      let total = 0, selected = 0;
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type !== 'context') {
            total++;
            if (selectedIds.has(line.id)) selected++;
          }
        }
      }
      el.textContent = total > 0 ? `${selected}/${total}` : '';
    }
  }

  function updateUI() {
    const totalSelected = selectedIds.size;
    btnCreate.disabled = totalSelected === 0;
    selectionCount.textContent = `${totalSelected} line${totalSelected !== 1 ? 's' : ''} selected`;
  }

  // ── Modal ────────────────────────────────────────────────────────────────

  function openModal() {
    modalOverlay.classList.remove('hidden');
    inputBranch.focus();
  }

  function closeModal() {
    modalOverlay.classList.add('hidden');
    btnModalConfirm.disabled = false;
  }

  function confirmCreate() {
    const branchName = inputBranch.value.trim();
    const commitMessage = inputMessage.value.trim();

    if (!branchName) { inputBranch.focus(); return; }
    if (!commitMessage) { inputMessage.focus(); return; }

    btnModalConfirm.disabled = true;
    setStatus('Creating branch…');

    vscode.postMessage({
      type: 'createBranch',
      branchName,
      commitMessage,
      selectedLineIds: Array.from(selectedIds),
    });
  }

  // ── Status / banners ──────────────────────────────────────────────────────

  /** @param {string} text */
  function setStatus(text) {
    statusText.textContent = text;
  }

  /**
   * @param {'info'|'error'|'success'} kind
   * @param {string} message
   * @param {boolean} replace
   */
  function showBanner(kind, message, replace) {
    const banner = document.createElement('div');
    banner.className = `banner ${kind}`;
    banner.innerHTML = `<pre>${message}</pre>`;

    if (replace) {
      // Remove previous banners of same kind
      for (const el of diffContentEl.querySelectorAll(`.banner.${kind}`)) el.remove();
      diffContentEl.prepend(banner);
    } else {
      diffContentEl.prepend(banner);
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /** @param {string} s */
  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * @param {import('../../git/diffParser').DiffFile} file
   * @returns {{ label: string, cls: string }}
   */
  function fileBadge(file) {
    if (file.isBinary) return { label: 'BIN', cls: 'bin' };
    if (file.isNew) return { label: 'NEW', cls: 'new' };
    if (file.isDeleted) return { label: 'DEL', cls: 'del' };
    return { label: 'MOD', cls: 'mod' };
  }
})();
