'use strict';

let cycleCardIds = new Set();

// ── Render board ───────────────────────────────────────────────────────────
function renderBoard(b) {
  cycleCardIds = findCycleCardIds();
  const scrollPositions = new Map();
  boardEl.querySelectorAll('.cards-list').forEach(function(cl) {
    var colId = cl.dataset.colId;
    if (colId) scrollPositions.set(colId, cl.scrollTop);
  });

  const currentSearchValue = searchInput.value;

  board = b;
  if (Array.isArray(b.runningCards)) {
    runningCards.clear();
    b.runningCards.forEach(id => runningCards.add(id));
  }
  if (Array.isArray(b.queuedCards)) {
    queuedCards.clear();
    b.queuedCards.forEach(id => queuedCards.add(id));
  }

  // Destroy scroll listeners + Map entries before nuking the DOM,
  // otherwise detached cardsList nodes are kept alive by virtualizedColumns.
  virtualizedColumns.forEach((_, colId) => destroyVirtualization(colId));
  boardEl.innerHTML = '';
  board.columns.forEach(col => boardEl.appendChild(buildColumn(col)));

  requestAnimationFrame(function() {
    scrollPositions.forEach(function(top, colId) {
      var cl = boardEl.querySelector('.cards-list[data-col-id="' + colId + '"]');
      if (cl && top > 0) cl.scrollTop = top;
    });
  });

  document.body.classList.toggle('vb-show-descriptions', getShowDescriptions());

  renderLog(board.agentLog || []);
  searchInput.value = currentSearchValue;
  applySearch();
  updateBoardProgress(board);
}

// ── Board progress summary ──────────────────────────────────────────────────
// At-a-glance "done / total" in the sticky header. Recomputed from the same
// board object that drives the column render, so any change that flows through
// renderBoard (initial load, SSE update, drag/move) refreshes it automatically.
const boardProgressBtn  = document.getElementById('board-progress-btn');
const boardProgressText = document.getElementById('board-progress-text');
const boardProgressFill = document.getElementById('board-progress-fill');

function updateBoardProgress(b) {
  if (!boardProgressBtn || !boardProgressText || !boardProgressFill) return;
  const cols = (b && b.columns) || [];
  let total = 0, done = 0, hasDone = false;
  cols.forEach(col => {
    const n = (col.cards || []).length;
    total += n;
    if (col.title === 'Done') { hasDone = true; done += n; }
  });
  if (total === 0) { boardProgressBtn.hidden = true; return; }
  boardProgressBtn.hidden = false;
  boardProgressText.textContent = `${done}/${total}`;
  boardProgressFill.style.width = Math.min(100, Math.max(0, Math.round((done / total) * 100))) + '%';
  boardProgressBtn.classList.toggle('complete', done === total);
}


// ── Card search ─────────────────────────────────────────────────────────────
const searchInput = document.getElementById('board-search');
const searchClear = document.getElementById('board-search-clear');
const searchCount = document.getElementById('board-search-count');

let searchDebounceTimer = null;

function applySearch() {
  const q = searchInput.value.trim().toLowerCase();

  boardEl.querySelectorAll('.search-empty-state').forEach(el => el.remove());

  if (!q) {
    virtualizedColumns.forEach((state, colId) => {
      if (state.searchActive) {
        state.searchActive = false;
        updateVisibleRange(state);
      }
    });

    searchClear.style.display = 'none';
    if (typeof applyFilters === 'function') {
      applyFilters();
    } else {
      const cards = boardEl.querySelectorAll('.card');
      cards.forEach(c => c.style.display = '');
      searchCount.style.display = 'none';
    }
    return;
  }

  virtualizedColumns.forEach((state, colId) => {
    state.searchActive = true;
    temporarilyRenderAllCards(colId);
  });

  searchClear.style.display = 'inline-block';

  if (typeof applyFilters === 'function') {
    applyFilters();
  } else {
    const cards = boardEl.querySelectorAll('.card');
    let total = 0, visible = 0;
    cards.forEach(c => {
      total++;
      const match = (c.dataset.searchTitle || '').includes(q);
      c.style.display = match ? '' : 'none';
      if (match) visible++;
    });

    boardEl.querySelectorAll('.cards-list').forEach(cardsList => {
      const visibleInCol = Array.from(cardsList.querySelectorAll('.card')).filter(c => c.style.display !== 'none').length;
      if (visibleInCol === 0) {
        const empty = document.createElement('div');
        empty.className = 'search-empty-state';
        empty.textContent = 'No results';
        cardsList.appendChild(empty);
      }
    });

    searchCount.style.display = 'inline-block';
    searchCount.textContent = `${visible} of ${total}`;
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(applySearch, 150);
});
searchClear.addEventListener('click', () => { searchInput.value = ''; applySearch(); searchInput.focus(); });

function buildColumn(col) {
  const colEl = document.createElement('div');
  colEl.className = 'column'; colEl.dataset.colId = col.id;
  if (col.color) colEl.style.setProperty('--col-accent', col.color);

  const accent = document.createElement('div'); accent.className = 'col-accent-line';
  colEl.appendChild(accent);

  const hdr = document.createElement('div'); hdr.className = 'col-header';

  const title = document.createElement('span');
  title.className = 'col-title';
  title.textContent = col.title;

  const limit = Number.isInteger(col.wip_limit) && col.wip_limit > 0 ? col.wip_limit : null;
  const count = document.createElement('span'); count.className = 'col-count';
  count.textContent = limit ? `${col.cards.length}/${limit}` : `${col.cards.length}`;
  if (limit) count.classList.add('wip-set');
  if (limit && col.cards.length > limit) count.classList.add('over');
  count.title = limit ? `WIP limit: ${limit} cards` : '';

  const WIP_COLUMNS = ['In Progress', 'Review'];
  let wipBtn = null;
  if (WIP_COLUMNS.includes(col.title)) {
    wipBtn = document.createElement('button');
    wipBtn.className = 'col-wip-btn';
    wipBtn.title = 'Set WIP limit';
    wipBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M12.5 8a4.5 4.5 0 0 0-.4-1.8l1.5-.9-1-1.7-1.7.4a4.5 4.5 0 0 0-1.4-1.4l.4-1.7-1.7-1-.9 1.5A4.5 4.5 0 0 0 8 1a4.5 4.5 0 0 0-1.8.4L5.3.9l-1.7 1 .4 1.7a4.5 4.5 0 0 0-1.4 1.4l-1.7-.4-1 1.7 1.5.9A4.5 4.5 0 0 0 1 8a4.5 4.5 0 0 0 .4 1.8l-1.5.9 1 1.7 1.7-.4a4.5 4.5 0 0 0 1.4 1.4l-.4 1.7 1.7 1 .9-1.5A4.5 4.5 0 0 0 8 15a4.5 4.5 0 0 0 1.8-.4l.9 1.5 1.7-1-.4-1.7a4.5 4.5 0 0 0 1.4-1.4l1.7.4 1-1.7-1.5-.9A4.5 4.5 0 0 0 12.5 8z"/></svg>';
    wipBtn.addEventListener('click', async () => {
      const cur = col.wip_limit ? String(col.wip_limit) : '';
      const input = await vbPrompt(`Set a WIP limit for "${col.title}". Leave blank to clear it.`, {
        title: 'WIP limit', value: cur, placeholder: 'e.g. 3', confirmText: 'Set limit',
      });
      if (input === null) return;
      const n = parseInt(input, 10);
      col.wip_limit = (Number.isInteger(n) && n > 0) ? n : null;
      renderBoard(board); postBoard();
    });
  }

  hdr.appendChild(title); if (wipBtn) hdr.appendChild(wipBtn); hdr.appendChild(count);
  colEl.appendChild(hdr);

  const cardsList = document.createElement('div');
  cardsList.className = 'cards-list'; cardsList.dataset.colId = col.id;

  if (col.cards.length === 0) cardsList.dataset.empty = '';

  // Must be in colEl before virtualizeColumn calls querySelector('.cards-list')
  colEl.appendChild(cardsList);

  const reversedCards = [...col.cards].reverse();
  if (reversedCards.length >= VIRTUALIZE_THRESHOLD) {
    virtualizeColumn(colEl, reversedCards);
  } else {
    reversedCards.forEach(card => cardsList.appendChild(buildCard(card, col.id)));
  }

  cardsList.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; cardsList.classList.add('drag-over'); });
  cardsList.addEventListener('dragleave', e => { if (!cardsList.contains(e.relatedTarget)) cardsList.classList.remove('drag-over'); });
  cardsList.addEventListener('drop', async e => {
    e.preventDefault(); cardsList.classList.remove('drag-over');
    if (!draggingCard) return;
    const tCol = board.columns.find(c => c.id === cardsList.dataset.colId);
    const sCol = board.columns.find(c => c.id === draggingFromCol);
    if (!tCol || !sCol) return;
    const idx = sCol.cards.findIndex(c => c.id === draggingCard);
    if (idx === -1) return;

    // Enforce WIP limit: block moving a card into a different column that is
    // already at capacity. Reordering within the same column is always allowed.
    const movingColumns = sCol.id !== tCol.id;
    const wip = Number.isInteger(tCol.wip_limit) && tCol.wip_limit > 0 ? tCol.wip_limit : null;
    if (movingColumns && wip && tCol.cards.length >= wip) {
      showToast(`"${tCol.title}" is at its WIP limit (${wip}) - move blocked`, 4000);
      draggingCard = null; draggingFromCol = null;
      return;
    }

    // Enforce dependencies: can't start a card (move to In Progress) while it has
    // unfinished blockers.
    if (movingColumns && tCol.title === 'In Progress') {
      const cardObj = sCol.cards[idx];
      const blockers = unfinishedBlockersUI(cardObj);
      if (blockers.length) {
        showToast(`"${cardObj.title}" is blocked by: ${blockers.map(c => c.title).join(', ')}`, 4500);
        draggingCard = null; draggingFromCol = null;
        return;
      }
    }

    const willSpawnAgent = sCol.cards[idx].agent && movingColumns && (tCol.title === 'In Progress' || tCol.title === 'Review');
    let runSkipPermissions = true;
    if (willSpawnAgent) {
      const choice = await vbConfirmRunAgent(sCol.cards[idx].title, board.skip_permissions === undefined ? true : !!board.skip_permissions);
      if (!choice) { draggingCard = null; draggingFromCol = null; return; }
      runSkipPermissions = choice.skipPermissions;
    }

    const [card] = sCol.cards.splice(idx, 1);
    const over = e.target.closest('.card');
    if (over?.dataset.cardId) {
      const oi = tCol.cards.findIndex(c => c.id === over.dataset.cardId);
      if (oi !== -1) tCol.cards.splice(oi + 1, 0, card); else tCol.cards.push(card);
    } else { tCol.cards.push(card); }
    draggingCard = null; draggingFromCol = null;

    const spawnsAgent = willSpawnAgent;
    if (spawnsAgent) {
      const agentStatus = mcpStatusCache?.agents?.[card.agent];
      if (agentStatus?.installed && !agentStatus?.configured) {
        renderBoard(board); postBoard();
        openMcpModal();
        showToast('Agent queued - set up MCP first for full board interaction', 5000);
        return;
      }
    }
    renderBoard(board);
    await postBoard();
    if (spawnsAgent) {
      fetch(`/api/cards/${card.id}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skipPermissions: runSkipPermissions }),
      }).catch(() => {});
    }
  });

  const NO_ADD_COLS = ['In Progress', 'Review', 'Done'];
  if (NO_ADD_COLS.includes(col.title)) {
    const spacer = document.createElement('div'); spacer.className = 'add-card-spacer';
    colEl.appendChild(spacer);
  } else {
    colEl.appendChild(buildAddCardArea(col));
  }
  return colEl;
}

function buildCard(card, colId) {
  const el = document.createElement('div');
  el.className = 'card'; el.draggable = true; el.dataset.cardId = card.id;
  el.dataset.searchTitle = [card.title || '', (card.tags || []).join(' '), card.description || ''].join(' ').toLowerCase();
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Open card: ${card.title || card.text || 'Untitled'}`);

  el.addEventListener('dragstart', e => {
    draggingCard = card.id; draggingFromCol = colId;
    e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging');
    if (typeof notifyDragStart === 'function') notifyDragStart();
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    if (typeof notifyDragEnd === 'function') notifyDragEnd();
  });
  el.addEventListener('click', () => openCardModal(card.id, colId));
  el.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); openCardModal(card.id, colId); }
  });

  // Title row: optional priority dot + title text
  const titleRow = document.createElement('div'); titleRow.className = 'card-title-row';
  if (card.priority) {
    const dot = document.createElement('span'); dot.className = `card-priority-dot ${card.priority}`;
    titleRow.appendChild(dot);
  }
  const text = document.createElement('div'); text.className = 'card-text'; text.textContent = card.title || card.text;
  titleRow.appendChild(text);

  const footer = document.createElement('div'); footer.className = 'card-footer';

  // Row 1 — tags
  if ((card.tags || []).length) {
    const tagsRow = document.createElement('div'); tagsRow.className = 'card-tags';
    card.tags.forEach(tag => {
      const pill = document.createElement('span'); pill.className = 'tag'; pill.textContent = tag; pill.style.background = tagColor(tag);
      pill.addEventListener('click', (e) => { e.stopPropagation(); if (typeof addFilter === 'function') addFilter('tag', tag); });
      pill.style.cursor = 'pointer'; pill.title = 'Click to filter by this tag';
      tagsRow.appendChild(pill);
    });
    footer.appendChild(tagsRow);
  }

  // Row 2 — meta: running/queued · agent · due date · blocked · merged/need-merge
  const metaRow = document.createElement('div'); metaRow.className = 'card-meta';

  if (runningCards.has(card.id)) {
    const dot = document.createElement('span'); dot.className = 'card-running-dot'; dot.title = 'Agent running…';
    metaRow.appendChild(dot);
  } else if (queuedCards.has(card.id)) {
    const queueWrap = document.createElement('span'); queueWrap.className = 'card-queued-wrap';
    const q = document.createElement('span'); q.className = 'card-queued-pill'; q.textContent = 'queued'; q.title = 'Agent queued - waiting for a free slot';
    const cancelBtn = document.createElement('button'); cancelBtn.className = 'card-cancel-queue-btn'; cancelBtn.textContent = '×'; cancelBtn.title = 'Cancel queued agent';
    cancelBtn.onclick = async function(e) {
      e.stopPropagation();
      if (!confirm('Cancel this queued agent?')) return;
      try {
        const res = await fetch('/api/cards/' + card.id + '/stop', { method: 'POST' });
        if (!res.ok) throw new Error('Failed to cancel agent');
        showToast('Agent cancelled', 2000);
      } catch (err) {
        showToast('Failed to cancel agent: ' + err.message, 3000, 'error');
      }
    };
    queueWrap.appendChild(q); queueWrap.appendChild(cancelBtn);
    metaRow.appendChild(queueWrap);
  }

  if (card.agent) {
    const badge = document.createElement('span'); badge.className = `card-agent-badge ${card.agent}`;
    badge.textContent = { 'claude-code': 'Claude', 'opencode': 'OpenCode', 'codex': 'Codex', 'command-code': 'Command' }[card.agent] || card.agent;
    badge.title = AGENT_LABELS[card.agent] || card.agent;
    badge.addEventListener('click', (e) => { e.stopPropagation(); if (typeof addFilter === 'function') addFilter('agent', card.agent); });
    badge.style.cursor = 'pointer';
    metaRow.appendChild(badge);
  }

  if (card.due_date) {
    const db = document.createElement('span'); db.className = 'due-date-badge' + (isOverdue(card.due_date) ? ' overdue' : ''); db.textContent = card.due_date;
    db.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof addFilter === 'function') {
        if (isOverdue(card.due_date)) addFilter('dueDate', 'overdue');
        else if (isDueToday(card.due_date)) addFilter('dueDate', 'today');
        else if (isDueThisWeek(card.due_date)) addFilter('dueDate', 'week');
      }
    });
    db.style.cursor = 'pointer'; db.title = 'Click to filter by due date';
    metaRow.appendChild(db);
  }

  const blockers = unfinishedBlockersUI(card);
  if (blockers.length) {
    const bl = document.createElement('span'); bl.className = 'blocked-badge'; bl.textContent = 'blocked';
    bl.title = 'Blocked by: ' + blockers.map(c => c.title).join(', ');
    metaRow.appendChild(bl);
  }

  if (card.merged_at) {
    const m = document.createElement('span'); m.className = 'merged-badge'; m.textContent = '✓ merged'; m.title = 'Merged: ' + fmtTime(card.merged_at);
    metaRow.appendChild(m);
  } else if (card.branch && card.has_branch_changes) {
    const col = board.columns.find(c => c.id === colId);
    if (col && col.title === 'Done') {
      const n = document.createElement('span'); n.className = 'need-merge-badge'; n.textContent = '! merge'; n.title = 'Branch ' + card.branch + ' has not been merged';
      metaRow.appendChild(n);
    }
  }
  if (card.review_issue) {
    const col = board.columns.find(c => c.id === colId);
    if (col && col.title === 'Review') {
      const b = document.createElement('span'); b.className = 'review-issue-badge'; b.textContent = '! issue'; b.title = 'Review agent found issues — check card notes';
      metaRow.appendChild(b);
    }
  }

  if (metaRow.children.length) footer.appendChild(metaRow);

  const delBtn = document.createElement('button'); delBtn.className = 'card-del-btn'; delBtn.textContent = '×';
  delBtn.setAttribute('aria-label', 'Delete card');
  delBtn.addEventListener('click', e => { e.stopPropagation(); deleteCard(card.id, colId); });

  el.appendChild(delBtn);
  el.appendChild(titleRow);
  if (card.description) { const d = document.createElement('div'); d.className = 'card-desc-preview'; d.textContent = card.description; el.appendChild(d); }
  if (footer.children.length) el.appendChild(footer);
  return el;
}

function buildAddCardArea(col) {
  const area = document.createElement('div'); area.className = 'add-card-area';
  const trigger = document.createElement('button'); trigger.className = 'add-card-trigger'; trigger.textContent = 'Add card';
  trigger.addEventListener('click', () => openNewCardModal(col.id));
  area.appendChild(trigger);
  return area;
}

// ── Board mutations ────────────────────────────────────────────────────────
async function deleteCard(cardId, colId) {
  const col = board.columns.find(c => c.id === colId); if (!col) return;
  const card = col.cards.find(c => c.id === cardId);
  if (!card) return;

  // Show confirmation for cards with unmerged branch changes
  if (card.branch && !card.merged_at) {
    const branchLabel = card.branch.replace(/^vb\//, '');
    const worktreeLabel = card.worktree_path
      ? card.worktree_path.split(/[\\/]/).pop()
      : branchLabel;
    const html = `
      <p>This card has unmerged code changes on branch:</p>
      <span class="vb-dialog-code-block">${escHtml(card.branch)}</span>
      <p>Deleting it will:</p>
      <ul>
        <li>Permanently delete the git worktree at:<br><span class="vb-dialog-code-block">.vb-worktrees/${escHtml(worktreeLabel)}</span></li>
        <li>Delete the local branch ${escHtml(card.branch)}</li>
        <li>Remove the card from the board</li>
      </ul>
      <p><strong>This cannot be undone.</strong></p>
    `.trim();
    const ok = await vbConfirm('', {
      title: `Delete Card "${card.title || 'Untitled'}"?`,
      messageHtml: html,
      confirmText: 'Delete anyway',
      cancelText: 'Cancel',
      danger: true,
    });
    if (!ok) return;
  } else {
    const ok = await vbConfirm(
      `Delete card "${card.title || 'Untitled'}"? This cannot be undone.`,
      { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
    );
    if (!ok) return;
  }

  col.cards = col.cards.filter(c => c.id !== cardId);
  renderBoard(board); postBoard();
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Agent Log ──────────────────────────────────────────────────────────────
function renderLog(entries) {
  if (!entries?.length) { logEntries.innerHTML = '<p class="log-empty">No activity yet.</p>'; return; }
  logEntries.innerHTML = '';
  entries.forEach(e => logEntries.appendChild(buildLogEntry(e)));
}
function buildLogEntry(entry) {
  const el = document.createElement('div'); el.className = 'log-entry';
  const action = entry.action || 'event';
  el.dataset.action = action.toLowerCase();
  if (entry.cardId) {
    el.dataset.cardId = entry.cardId;
    el.style.cursor = 'pointer';
    el.title = 'Click to open card';
    el.addEventListener('click', () => {
      const cardEntry = findCardEntry(entry.cardId);
      if (cardEntry) {
        openCardModal(entry.cardId, cardEntry.column.id);
      } else {
        showToast('Card not found on the board', 2000);
      }
    });
  }

  const top = document.createElement('div'); top.className = 'log-entry-top';
  const chip = document.createElement('span'); chip.className = 'log-entry-action'; chip.textContent = action.replace(/_/g, ' ');
  top.appendChild(chip);
  if (entry.agent) {
    const ag = document.createElement('span'); ag.className = 'log-entry-agent';
    ag.textContent = AGENT_LABELS[entry.agent] || entry.agent;
    top.appendChild(ag);
  }
  const time = document.createElement('span'); time.className = 'log-entry-time'; time.textContent = fmtTime(entry.timestamp || new Date().toISOString());
  top.appendChild(time);

  const detail = document.createElement('div'); detail.className = 'log-entry-detail'; detail.textContent = entry.detail || '';
  el.appendChild(top); el.appendChild(detail);
  return el;
}
function prependLogEntry(entry) {
  logEntries.querySelectorAll('.log-empty').forEach(e => e.remove());
  logEntries.insertBefore(buildLogEntry(entry), logEntries.firstChild);
}

logToggleBtn.addEventListener('click', () => {
  const logOpen = logSidebar.classList.contains('open');
  if (logOpen) {
    logSidebar.classList.remove('open');
  } else {
    cardSidebar.classList.remove('open');
    logSidebar.classList.add('open');
  }
});

document.getElementById('log-sidebar-close').addEventListener('click', () => {
  logSidebar.classList.remove('open');
});

document.getElementById('log-clear-btn').addEventListener('click', async () => {
  const ok = await vbConfirm('Clear all activity log entries? This cannot be undone.', {
    title: 'Clear activity log', confirmText: 'Clear', danger: true,
  });
  if (!ok) return;
  try {
    await fetch('/api/agent-log', { method: 'DELETE' });
    logEntries.innerHTML = '<p class="log-empty">No activity yet.</p>';
  } catch(err) { showToast('Failed to clear log: ' + err.message); }
});

document.getElementById('mcp-btn').addEventListener('click', () => {
  openMcpModal();
});

document.getElementById('mobile-menu-btn').addEventListener('click', () => {
  document.getElementById('workspace-sidebar').classList.toggle('mobile-open');
});

// ── Collapsible workspace rail (desktop) ─────────────────────────────────────
const SIDEBAR_COLLAPSE_KEY = 'vb_sidebar_collapsed';
function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const btn = document.getElementById('sidebar-toggle-btn');
  if (btn) {
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.title = collapsed ? 'Show sidebar' : 'Collapse sidebar';
  }
}
document.getElementById('sidebar-toggle-btn').addEventListener('click', () => {
  const next = !document.body.classList.contains('sidebar-collapsed');
  applySidebarCollapsed(next);
  try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, next ? '1' : '0'); } catch (_) {}
});
// Apply persisted state immediately (scripts run before first paint → no flash).
applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1');

// ── Version badge + update check ─────────────────────────────────────────────
async function checkVersion() {
  const badge = document.getElementById('version-badge');
  const label = document.getElementById('version-update-label');
  if (!badge) return;
  try {
    const r = await fetch('/api/version');
    if (!r.ok) return;
    const v = await r.json();
    badge.textContent = 'v' + v.current;
    badge.title = `VibeBoard v${v.current}`;
    if (v.updateAvailable && v.latest) {
      badge.classList.add('update');
      badge.title = `v${v.current} installed`;
      const cmd = `npm i -g ${v.package}@latest`;
      if (label) {
        label.hidden = false;
        label.textContent = `v${v.latest} available`;
        label.title = 'Click to copy update command';
        label.onclick = () => {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(cmd).then(
              () => showToast(`Copied: ${cmd}`, 4000, 'success'),
              () => showToast(`Run: ${cmd}`, 6000)
            );
          } else { showToast(`Run: ${cmd}`, 6000); }
        };
      }
    } else {
      if (label) label.hidden = true;
    }
  } catch (_) {}
}
checkVersion();

// ── Workspace AI context files modal ──────────────────────────────────────
let _contextFiles = [];

async function loadContextPanel(wsId) {
  const btn = document.getElementById('ws-context-btn');
  if (!wsId) { if (btn) btn.style.display = 'none'; return; }
  try {
    const resp = await fetch(`/api/workspaces/${wsId}/agent-context`);
    if (resp.ok) {
      const data = await resp.json();
      _contextFiles = data.files || [];
      if (btn) btn.style.display = _contextFiles.length ? '' : 'none';
      return;
    }
  } catch (_) {}
  _contextFiles = [];
  if (btn) btn.style.display = 'none';
}

(function initContextModal() {
  const btn     = document.getElementById('ws-context-btn');
  const overlay = document.getElementById('context-modal-overlay');
  const tabsEl  = document.getElementById('context-modal-tabs');
  const contentEl = document.getElementById('context-modal-content');
  const emptyEl   = document.getElementById('context-modal-empty');
  const closeBtn  = document.getElementById('context-modal-close');
  if (!btn || !overlay) return;

  function openContextModal() {
    tabsEl.innerHTML = '';
    if (!_contextFiles.length) {
      contentEl.style.display = 'none';
      emptyEl.style.display = '';
      overlay.classList.add('open');
      return;
    }
    emptyEl.style.display = 'none';
    contentEl.style.display = '';

    let active = 0;
    _contextFiles.forEach((f, i) => {
      const tab = document.createElement('button');
      tab.className = 'sidebar-tab' + (i === 0 ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      tab.textContent = f.filename;
      tab.addEventListener('click', () => {
        tabsEl.querySelectorAll('.sidebar-tab').forEach((t, j) => {
          t.classList.toggle('active', j === i);
          t.setAttribute('aria-selected', j === i ? 'true' : 'false');
        });
        contentEl.innerHTML = renderMarkdown(_contextFiles[i].content);
        contentEl.scrollTop = 0;
      });
      tabsEl.appendChild(tab);
    });
    contentEl.innerHTML = renderMarkdown(_contextFiles[0].content);
    overlay.classList.add('open');
  }

  btn.addEventListener('click', openContextModal);
  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) overlay.classList.remove('open');
  });
})();
