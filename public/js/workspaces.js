'use strict';

// ── Workspace list ─────────────────────────────────────────────────────────
function renderWorkspaceListSkeleton() {
  wsListEl.innerHTML = '';
  [55, 70, 62].forEach(w => {
    const item = document.createElement('div');
    item.className = 'ws-item ws-item-skel';
    item.innerHTML = `
      <div class="skeleton" style="width:28px;height:28px;border-radius:6px;flex-shrink:0"></div>
      <div class="ws-item-info">
        <div class="skeleton" style="height:11px;width:${w}%;border-radius:3px"></div>
        <div class="skeleton" style="height:9px;width:55%;border-radius:2px"></div>
      </div>`;
    wsListEl.appendChild(item);
  });
}

function renderHeaderSkeleton() {
  if (!headerWorkspace) return;
  headerWorkspace.classList.add('header-workspace-skel');
  headerWorkspace.hidden = false;
}

async function loadWorkspaces() {
  renderWorkspaceListSkeleton();
  renderHeaderSkeleton();
  try {
    const resp = await fetch('/workspaces');
    if (resp.ok) {
      workspaces = await resp.json();
      activeWsId = (workspaces.find(w => w.active) || workspaces[0])?.id || null;
      renderWorkspaceList();
      setEmptyState(workspaces.length === 0);
    }
  } catch(_){}
}

function renderWorkspaceList() {
  wsListEl.innerHTML = '';
  workspaces.forEach(ws => {
    const item = document.createElement('div');
    item.className = 'ws-item' + (ws.active ? ' active' : '');

    const icon = document.createElement('div');
    icon.className = 'ws-item-icon';
    icon.textContent = (ws.name || folderName(ws.path) || 'W')[0].toUpperCase();
    icon.style.background = wsColor(ws.name || folderName(ws.path) || 'W');
    item.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'ws-item-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'ws-item-name';
    nameEl.textContent = ws.name || folderName(ws.path) || 'Untitled';
    info.appendChild(nameEl);

    if (ws.path) {
      const pathEl = document.createElement('div');
      pathEl.className = 'ws-item-path';
      pathEl.textContent = ws.path;
      pathEl.title = ws.path;
      info.appendChild(pathEl);
    }

    const editBtn = document.createElement('button');
    editBtn.className = 'ws-item-edit';
    editBtn.textContent = '···';
    editBtn.title = 'Edit workspace';
    editBtn.addEventListener('click', e => { e.stopPropagation(); openWsModal(ws.id); });

    item.appendChild(info);
    item.appendChild(editBtn);

    if (!ws.active) item.addEventListener('click', () => switchWorkspace(ws.id));
    wsListEl.appendChild(item);
  });
  updateHeaderWorkspace();
}

function updateHeaderWorkspace() {
  const activeWs = workspaces.find(w => w.active);
  if (!activeWs || !headerWorkspace) return;
  
  const wsName = activeWs.name || folderName(activeWs.path) || 'Untitled';
  const initial = wsName.charAt(0).toUpperCase();
  
  headerWorkspace.classList.remove('header-workspace-skel');
  headerWorkspaceName.textContent = wsName;
  headerWorkspaceIcon.textContent = initial;
  headerWorkspaceIcon.style.background = wsColor(wsName);
  headerWorkspace.hidden = false;
  headerWorkspace.title = `Active workspace: ${wsName}`;
}

async function switchWorkspace(id) {
  try { await fetch(`/workspaces/${id}/switch`, { method: 'POST' }); } catch(_){}
}

// ── New workspace modal ────────────────────────────────────────────────────
function openNewWsModal() {
  wsNewPath.value = '';
  wsNewName.value = '';
  wsNewPath.placeholder = 'e.g. C:\\Projects\\myapp';
  wsNewName.placeholder = 'Optional, inferred from folder name';
  wsNewPath.classList.remove('error');
  document.getElementById('ws-new-git-status').style.display = 'none';
  document.getElementById('ws-new-use-worktree').checked = false;
  document.getElementById('ws-new-skip-permissions').checked = true;
  document.getElementById('ws-new-overlay').classList.add('open');
  wsNewPath.focus();
}

function closeNewWsModal() {
  document.getElementById('ws-new-overlay').classList.remove('open');
}

wsNewBtn.addEventListener('click', openNewWsModal);
document.getElementById('ws-new-close').addEventListener('click', closeNewWsModal);
document.getElementById('ws-new-cancel').addEventListener('click', closeNewWsModal);
document.getElementById('ws-new-overlay').addEventListener('click', e => {
  if (e.target.id === 'ws-new-overlay') closeNewWsModal();
});

document.getElementById('ws-new-submit').addEventListener('click', async () => {
  const wsPath = wsNewPath.value.trim();
  if (!wsPath) { wsNewPath.classList.add('error'); wsNewPath.focus(); return; }
  if (!isAbsolutePath(wsPath)) {
    wsNewPath.classList.add('error');
    showToast('Path must be absolute (e.g., C:\\Projects\\myapp or /home/user/myapp)');
    wsNewPath.focus();
    return;
  }
  wsNewPath.classList.remove('error');
  const name = wsNewName.value.trim() || folderName(wsPath) || '';
  const use_worktree = document.getElementById('ws-new-use-worktree').checked ? 1 : 0;
  const skip_permissions = document.getElementById('ws-new-skip-permissions').checked ? 1 : 0;
  const submitBtn = document.getElementById('ws-new-submit');
  submitBtn.disabled = true; submitBtn.textContent = 'Creating…';
  try {
    const resp = await fetch('/workspaces', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name, path: wsPath, use_worktree, skip_permissions }),
    });
    const ws = await resp.json();
    closeNewWsModal();
    if (!activeWsId) await fetch(`/workspaces/${ws.id}/switch`, { method: 'POST' });
    await loadWorkspaces();
  } catch(_){ showToast('Failed to create workspace', 3000, 'error'); }
  submitBtn.disabled = false; submitBtn.textContent = 'Create workspace';
});

wsNewPath.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeNewWsModal();
  if (e.key === 'Enter') wsNewName.focus();
});
wsNewName.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeNewWsModal();
  if (e.key === 'Enter') document.getElementById('ws-new-submit').click();
});

// ── Workspace detail modal ─────────────────────────────────────────────────
function openWsModal(wsId) {
  const ws = workspaces.find(w => w.id === wsId);
  if (!ws) return;
  editingWsId = wsId;

  document.getElementById('ws-modal-name').value = ws.name || folderName(ws.path) || '';
  document.getElementById('ws-modal-path').value = ws.path || '';
  document.getElementById('ws-modal-desc').value = ws.description || '';
  document.getElementById('ws-modal-use-worktree').checked = !!(ws.use_worktree || (wsId === activeWsId && board.use_worktree));
  document.getElementById('ws-modal-skip-permissions').checked = ws.skip_permissions !== undefined
    ? !!ws.skip_permissions
    : ((wsId === activeWsId && board.skip_permissions !== undefined) ? !!board.skip_permissions : true);

  const stats = document.getElementById('ws-modal-stats');
  stats.innerHTML = '';
  if (wsId === activeWsId && board.columns?.length) {
    board.columns.forEach(col => {
      const chip = document.createElement('div');
      chip.className = 'ws-stat-chip';
      chip.innerHTML = `<span class="ws-stat-dot" style="background:${col.color||'#6b6860'}"></span>${col.title}<span class="ws-stat-count">${col.cards.length}</span>`;
      stats.appendChild(chip);
    });
  } else {
    const hint = document.createElement('p');
    hint.style.cssText = 'font-size:12px;color:var(--text-muted);font-weight:300';
    hint.textContent = wsId === activeWsId ? 'No columns yet.' : 'Switch to this workspace to see stats.';
    stats.appendChild(hint);
  }

  loadTemplates(wsId);

  document.getElementById('ws-modal-overlay').classList.add('open');
  document.getElementById('ws-modal-name').focus();
}

async function loadTemplates(wsId) {
  try {
    const resp = await fetch(`/api/workspaces/${wsId}/templates`);
    if (resp.ok) {
      const templates = await resp.json();
      renderTemplates(templates, wsId);
    }
  } catch(_){}
}

function renderTemplates(templates, wsId) {
  const list = document.getElementById('ws-templates-list');
  list.innerHTML = '';
  templates.forEach(tpl => {
    const item = document.createElement('div');
    item.className = 'ws-template-item';
    
    const name = document.createElement('div');
    name.className = 'ws-template-name';
    name.textContent = tpl.name;
    
    const meta = document.createElement('div');
    meta.className = 'ws-template-meta';
    const parts = [];
    if (tpl.agent) parts.push(AGENT_LABELS[tpl.agent] || tpl.agent);
    if (tpl.tags?.length) parts.push(tpl.tags.join(', '));
    if (tpl.priority) parts.push(tpl.priority);
    meta.textContent = parts.join(' · ') || 'No defaults';
    
    const actions = document.createElement('div');
    actions.className = 'ws-template-actions';
    
    const editBtn = document.createElement('button');
    editBtn.className = 'ws-template-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => editTemplate(tpl, wsId));
    
    const delBtn = document.createElement('button');
    delBtn.className = 'ws-template-btn delete';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      const ok = await vbConfirm(`Delete template "${tpl.name}"?`, { title: 'Delete template', confirmText: 'Delete', danger: true });
      if (!ok) return;
      try {
        await fetch(`/api/templates/${tpl.id}`, { method: 'DELETE' });
        loadTemplates(wsId);
      } catch(_){}
    });
    
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    
    item.appendChild(name);
    item.appendChild(meta);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

async function editTemplate(tpl, wsId) {
  const name = await vbPrompt('Template name', { value: tpl.name, title: 'Edit template' });
  if (!name) return;
  
  try {
    await fetch(`/api/templates/${tpl.id}`, {
      method: 'PATCH',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name }),
    });
    loadTemplates(wsId);
  } catch(_){}
}

document.getElementById('ws-add-template-btn').addEventListener('click', async () => {
  if (!editingWsId) return;
  const name = await vbPrompt('Template name (e.g., "Add API endpoint")', { title: 'New template', placeholder: 'Template name' });
  if (!name) return;
  
  try {
    await fetch(`/api/workspaces/${editingWsId}/templates`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name }),
    });
    loadTemplates(editingWsId);
  } catch(_){}
});

function openWsModal(wsId) {
  const ws = workspaces.find(w => w.id === wsId);
  if (!ws) return;
  editingWsId = wsId;

  document.getElementById('ws-modal-name').value = ws.name || folderName(ws.path) || '';
  document.getElementById('ws-modal-path').value = ws.path || '';
  document.getElementById('ws-modal-desc').value = ws.description || '';
  document.getElementById('ws-modal-use-worktree').checked = !!(ws.use_worktree || (wsId === activeWsId && board.use_worktree));
  document.getElementById('ws-modal-skip-permissions').checked = ws.skip_permissions !== undefined
    ? !!ws.skip_permissions
    : ((wsId === activeWsId && board.skip_permissions !== undefined) ? !!board.skip_permissions : true);

  const stats = document.getElementById('ws-modal-stats');
  stats.innerHTML = '';
  if (wsId === activeWsId && board.columns?.length) {
    board.columns.forEach(col => {
      const chip = document.createElement('div');
      chip.className = 'ws-stat-chip';
      chip.innerHTML = `<span class="ws-stat-dot" style="background:${col.color||'#6b6860'}"></span>${col.title}<span class="ws-stat-count">${col.cards.length}</span>`;
      stats.appendChild(chip);
    });
  } else {
    const hint = document.createElement('p');
    hint.style.cssText = 'font-size:12px;color:var(--text-muted);font-weight:300';
    hint.textContent = wsId === activeWsId ? 'No columns yet.' : 'Switch to this workspace to see stats.';
    stats.appendChild(hint);
  }

  loadTemplates(wsId);

  document.getElementById('ws-modal-overlay').classList.add('open');
  document.getElementById('ws-modal-name').focus();
}

function closeWsModal() {
  document.getElementById('ws-modal-overlay').classList.remove('open');
  editingWsId = null;
}

document.getElementById('ws-modal-close').addEventListener('click', closeWsModal);
document.getElementById('ws-modal-overlay').addEventListener('click', e => { if (e.target.id === 'ws-modal-overlay') closeWsModal(); });

document.getElementById('ws-modal-save').addEventListener('click', async () => {
  if (!editingWsId) return;
  const name = document.getElementById('ws-modal-name').value.trim();
  const wsPath = document.getElementById('ws-modal-path').value.trim();
  const description = document.getElementById('ws-modal-desc').value.trim();
  const useWorktree = document.getElementById('ws-modal-use-worktree').checked;
  const skipPermissions = document.getElementById('ws-modal-skip-permissions').checked;

  if (wsPath && !isAbsolutePath(wsPath)) {
    showToast('Path must be absolute (e.g., C:\\Projects\\myapp or /home/user/myapp)');
    document.getElementById('ws-modal-path').focus();
    return;
  }

  try {
    if (editingWsId === activeWsId) {
      board.name = name; board.path = wsPath; board.description = description; board.use_worktree = useWorktree ? 1 : 0; board.skip_permissions = skipPermissions ? 1 : 0;
      await postBoard();
    } else {
      await fetch(`/workspaces/${editingWsId}`, {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name, path: wsPath, description, use_worktree: useWorktree ? 1 : 0, skip_permissions: skipPermissions ? 1 : 0 }),
      });
    }
    const ws = workspaces.find(w => w.id === editingWsId);
    if (ws) { ws.name = name; ws.path = wsPath; ws.description = description; ws.use_worktree = useWorktree ? 1 : 0; ws.skip_permissions = skipPermissions ? 1 : 0; }
    renderWorkspaceList();
  } catch(_){}
  closeWsModal();
});

document.getElementById('ws-modal-delete').addEventListener('click', async () => {
  if (!editingWsId) return;
  const ws = workspaces.find(w => w.id === editingWsId);
  const ok = await vbConfirm(`Delete workspace "${ws?.name || 'Untitled'}"? Its board and cards will be removed. This cannot be undone.`, {
    title: 'Delete workspace', confirmText: 'Delete', danger: true,
  });
  if (!ok) return;
  const id = editingWsId;
  closeWsModal();
  try {
    const resp = await fetch(`/workspaces/${id}`, { method: 'DELETE' });
    if (!resp.ok) showToast('Delete failed', 3000, 'error');
  } catch(_){}
});

// ── Settings modal ─────────────────────────────────────────────────────────
const settingsOverlay = document.getElementById('settings-overlay');

document.getElementById('settings-btn').addEventListener('click', async () => {
  settingsOverlay.classList.add('open');
  // Load data path
  try {
    const resp = await fetch('/api/info');
    if (resp.ok) {
      const info = await resp.json();
      document.getElementById('settings-data-path').textContent = info.dataDir;
    }
  } catch(_) {}
});

document.getElementById('settings-close').addEventListener('click', () => settingsOverlay.classList.remove('open'));
settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) settingsOverlay.classList.remove('open'); });

document.querySelectorAll('.theme-opt').forEach(btn => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.t));
});

document.getElementById('theme-btn').addEventListener('click', () => {
  const cur = localStorage.getItem(THEME_KEY) || 'system';
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length];
  applyTheme(next);
});

// ── Card description toggle ────────────────────────────────────────────────
const descToggle = document.getElementById('setting-show-descriptions');
if (descToggle) {
  descToggle.checked = getShowDescriptions();
  descToggle.addEventListener('change', () => {
    setShowDescriptions(descToggle.checked);
    document.body.classList.toggle('vb-show-descriptions', descToggle.checked);
  });
}

document.getElementById('settings-copy-path').addEventListener('click', function() {
  const p = document.getElementById('settings-data-path').textContent;
  navigator.clipboard.writeText(p).then(() => {
    this.textContent = 'Copied!'; this.classList.add('copied');
    setTimeout(() => { this.textContent = 'Copy'; this.classList.remove('copied'); }, 2000);
  });
});

// ── New Card Modal ────────────────────────────────────────────────────────
function closeNewCardModal() {
  document.getElementById('nc-modal-overlay').classList.remove('open');
  newCardColId = null;
}

function submitNewCard() {
  const title = document.getElementById('nc-title-input').value.trim();
  if (!title) { showToast('Card title is required'); return; }
  const col = board.columns.find(c => c.id === newCardColId);
  if (!col) return;
  const tags = Array.from(document.querySelectorAll('#nc-tag-picker .tag-pick-btn.active')).map(b => b.dataset.tag);
  const agent = window._ncAgentSelect?.getValue() || undefined;
  const model = modelSelects['nc']?.getValue() || undefined;
  const description = document.getElementById('nc-desc').value.trim() || undefined;
  const requires_review = document.getElementById('nc-needs-review').checked;
  const priority = window._ncPrioritySelect?.getValue() || undefined;
  const due_date = document.getElementById('nc-due-date').value || null;
  const review_agent = window._ncReviewAgentSelect?.getValue() || undefined;
  const review_model = modelSelects['nc-review']?.getValue() || undefined;
  col.cards.push({
    id: uid(), title, tags, requires_review, priority: priority || null, due_date,
    ...(description && { description }),
    ...(agent && { agent }),
    ...(model && { model }),
    ...(requires_review && review_agent && { review_agent }),
    ...(requires_review && review_model && { review_model }),
    ...(ncBlockedBy.length && { blocked_by: [...ncBlockedBy] })
  });
  closeNewCardModal();
  renderBoard(board); postBoard();
}

document.getElementById('nc-close').addEventListener('click', closeNewCardModal);
document.getElementById('nc-cancel').addEventListener('click', closeNewCardModal);
document.getElementById('nc-create').addEventListener('click', submitNewCard);
document.getElementById('nc-modal-overlay').addEventListener('click', e => { if (e.target.id === 'nc-modal-overlay') closeNewCardModal(); });
document.getElementById('nc-title-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('nc-desc').focus();
  if (e.key === 'Escape') closeNewCardModal();
});
