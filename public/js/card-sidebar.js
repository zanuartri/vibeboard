'use strict';

// ── Card Sidebar ──────────────────────────────────────────────────────────
const cardSidebar        = document.getElementById('card-sidebar');
const cardModalTitleEl   = document.getElementById('card-modal-title-input');
const cardModalColBadge  = document.getElementById('card-modal-col-badge');
const cardModalClose     = document.getElementById('card-modal-close');
const cardModalDesc      = document.getElementById('card-modal-desc');
const cardModalTagPicker = document.getElementById('card-modal-tag-picker');
const cardModalPromptTxt = document.getElementById('card-modal-prompt-text');
const cardModalCopyBtn   = document.getElementById('card-modal-copy-btn');

let modalCardId = null, modalColId = null, newCardColId = null;
let ncBlockedBy = []; // blocked_by being assembled in the New Card modal

function sanitizeOutput(str) {
  if (!str) return str;
  return str
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

async function loadAgentContext(agent) {
  const tabsEl  = document.getElementById('context-sidebar-tabs');
  const pre     = document.getElementById('context-file-content');
  const emptyEl = document.getElementById('context-file-empty');
  tabsEl.innerHTML = '';
  pre.innerHTML = '';

  if (!agent) {
    document.getElementById('context-file-empty-msg').textContent = 'Select an agent on the Agent tab to see its context file.';
    emptyEl.style.display = '';
    return;
  }

  const wsId = activeWsId || board?.id;
  if (!wsId) { emptyEl.style.display = ''; return; }

  const target = agent === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
  emptyEl.style.display = 'none';

  try {
    const resp = await fetch(`/api/workspaces/${wsId}/agent-context`);
    if (resp.ok) {
      const data = await resp.json();
      const file = (data.files || []).find(f => f.filename === target);
      if (file) {
        pre.innerHTML = renderMarkdown(file.content);
        return;
      }
    }
  } catch (_) {}

  document.getElementById('context-file-empty-msg').textContent = `${target} not found in this workspace.`;
  emptyEl.style.display = '';
}

async function loadCardNotes(cardId) {
  try {
    const resp = await fetch(`/api/cards/${cardId}/notes`);
    if (resp.ok) {
      const data = await resp.json();
      return data.notes || [];
    }
  } catch(_) {}
  return [];
}

function renderCardNotes(notes) {
  const notesList = document.getElementById('card-notes-list');
  const notesSection = document.getElementById('card-notes-section');
  const divider = document.getElementById('card-activity-divider');

  if (!notes || notes.length === 0) {
    notesSection.style.display = 'none';
    return;
  }

  notesSection.style.display = 'block';
  if (divider) divider.style.display = '';
  notesList.innerHTML = '';
  
  notes.forEach((note, idx) => {
    const noteEl = document.createElement('div');
    noteEl.className = 'card-note';
    
    const headerEl = document.createElement('div');
    headerEl.className = 'card-note-header';
    
    const timeEl = document.createElement('div');
    timeEl.className = 'card-note-time';
    timeEl.textContent = fmtTime(note.createdAt);
    
    const chevronEl = document.createElement('span');
    chevronEl.className = 'card-note-chevron';
    chevronEl.textContent = '\u25B6';
    
    headerEl.appendChild(timeEl);
    headerEl.appendChild(chevronEl);
    
    // Strip BOM and non-printable control chars that may have leaked from old terminal output
    const clean = note.content
      .replace(/﻿/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
      .trim();
    
    const previewEl = document.createElement('div');
    previewEl.className = 'card-note-preview';
    const firstLine = clean.split('\n')[0] || clean;
    const truncated = firstLine.length > 80 ? firstLine.slice(0, 80) + '\u2026' : firstLine;
    previewEl.textContent = truncated;
    previewEl.title = clean;
    
    const contentEl = document.createElement('div');
    contentEl.className = 'card-note-content';
    contentEl.textContent = clean;
    
    const bodyEl = document.createElement('div');
    bodyEl.className = 'card-note-body';
    bodyEl.appendChild(previewEl);
    bodyEl.appendChild(contentEl);
    
    // All notes start collapsed; user clicks header to expand
    noteEl.classList.add('note-collapsed');
    contentEl.style.display = 'none';
    
    headerEl.addEventListener('click', () => {
      const isCollapsed = noteEl.classList.contains('note-collapsed');
      if (isCollapsed) {
        noteEl.classList.remove('note-collapsed');
        noteEl.classList.add('note-expanded');
        previewEl.style.display = 'none';
        contentEl.style.display = '';
      } else {
        noteEl.classList.remove('note-expanded');
        noteEl.classList.add('note-collapsed');
        previewEl.style.display = '';
        contentEl.style.display = 'none';
      }
    });
    
    noteEl.appendChild(headerEl);
    noteEl.appendChild(bodyEl);
    notesList.appendChild(noteEl);
  });
}

function agentUnavailableReason(agent) {
  if (!agent) return null;
  if (!agentsAvailable[agent]) return 'not installed';
  const s = mcpStatusCache?.agents?.[agent];
  if (s?.installed && !s?.configured) return 'MCP not configured';
  return null;
}

function buildAgentOptions() {
  const base = [
    { value: '', label: 'None' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'opencode', label: 'OpenCode' },
    { value: 'codex', label: 'Codex CLI' },
    { value: 'command-code', label: 'Command Code' },
  ];
  return base.map(o => {
    if (!o.value) return { ...o, hint: undefined, disabled: false };
    const reason = agentUnavailableReason(o.value);
    return { ...o, disabled: !!reason, hint: reason || undefined };
  });
}

function openCardModal(cardId, colId) {
  logSidebar.classList.remove('open');
  const col = board.columns.find(c => c.id === colId);
  const card = col?.cards.find(c => c.id === cardId);
  if (!card) return;
  modalCardId = cardId; modalColId = colId;

  // Reset merge/PR buttons in case stale state leaked from previous card
  document.getElementById('card-merge-btn').disabled = false;
  document.getElementById('card-merge-btn').textContent = 'Merge';
  document.getElementById('card-pr-btn').disabled = false;
  document.getElementById('card-pr-btn').textContent = 'Create PR';

  cardModalTitleEl.value = card.title || card.text || '';
  cardModalColBadge.textContent = col.title; cardModalColBadge.style.background = col.color || '#6b6860';
  const branchBadge = document.getElementById('card-modal-branch-badge');
  if (card.branch) {
    branchBadge.textContent = card.branch + (card.merged_at ? ' (merged ' + fmtTime(card.merged_at) + ')' : '');
    branchBadge.style.display = '';
  } else { branchBadge.style.display = 'none'; }
  cardModalDesc.value = card.description || '';

  cardModalTagPicker.innerHTML = '';
  TAGS.forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'tag-pick-btn'; btn.dataset.tag = tag; btn.textContent = tag; btn.type = 'button';
    const active = (card.tags||[]).includes(tag);
    if (active) { btn.classList.add('active'); btn.style.backgroundColor = tagColor(tag); btn.style.color = 'white'; }
    else { btn.style.color = tagColor(tag); btn.style.opacity = '0.45'; }
    btn.addEventListener('click', () => {
      const tags = card.tags||[];
      if (tags.includes(tag)) { card.tags = tags.filter(t=>t!==tag); btn.classList.remove('active'); btn.style.backgroundColor=''; btn.style.color=tagColor(tag); btn.style.opacity='0.45'; }
      else { card.tags=[...tags,tag]; btn.classList.add('active'); btn.style.backgroundColor=tagColor(tag); btn.style.color='white'; btn.style.opacity='1'; }
      saveModal(card);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (typeof addFilter === 'function') addFilter('tag', tag);
    });
    cardModalTagPicker.appendChild(btn);
  });

  const agentMount = document.getElementById('card-agent-mount');
  agentMount.innerHTML = '';
  agentMount._agentSelect = vbSelect({
    options: buildAgentOptions(),
    value: card.agent || '',
    placeholder: 'Select agent',
    ariaLabel: 'Agent',
    onChange: value => {
      card.agent = value || undefined;
      updatePromptBox(card); saveModal(card);
      updateRunAgentBtn(card);
      document.getElementById('card-review-toggle-row').style.display = card.agent ? '' : 'none';
      document.getElementById('card-custom-prompt-section').style.display = card.agent ? '' : 'none';
      document.getElementById('card-review-agent-section').style.display = (card.agent && card.requires_review) ? '' : 'none';
      updateModelDropdown('card', card.agent || '', card.model);
      const activeTab = document.querySelector('.sidebar-tab.active');
      if (activeTab?.dataset.tab === 'context') loadAgentContext(card.agent);
    },
  });
  agentMount.appendChild(agentMount._agentSelect.el);

  updateModelDropdown('card', card.agent || '', card.model);

  const reviewToggleRow = document.getElementById('card-review-toggle-row');
  const reviewToggle = document.getElementById('card-needs-review-toggle');
  reviewToggleRow.style.display = card.agent ? '' : 'none';
  reviewToggle.checked = !!card.requires_review;
  reviewToggle.onchange = () => {
    card.requires_review = reviewToggle.checked;
    updatePromptBox(card);
    saveModal(card);
    const reviewAgentSection = document.getElementById('card-review-agent-section');
    reviewAgentSection.style.display = (card.agent && reviewToggle.checked) ? '' : 'none';
  };

  const reviewAgentSection = document.getElementById('card-review-agent-section');
  reviewAgentSection.style.display = (card.agent && card.requires_review) ? '' : 'none';

  const reviewAgentMount = document.getElementById('card-review-agent-mount');
  reviewAgentMount.innerHTML = '';
  reviewAgentMount._reviewAgentSelect = vbSelect({
    options: buildAgentOptions(),
    value: card.review_agent || '',
    placeholder: 'Same as main agent',
    ariaLabel: 'Review agent',
    onChange: value => {
      card.review_agent = value || undefined;
      saveModal(card);
      updateModelDropdown('card-review', card.review_agent || '', card.review_model);
    },
  });
  reviewAgentMount.appendChild(reviewAgentMount._reviewAgentSelect.el);

  updateModelDropdown('card-review', card.review_agent || '', card.review_model);

  // Priority dropdown
  const cardPriorityMount = document.getElementById('card-priority-mount');
  cardPriorityMount.innerHTML = '';
  const cardPrioritySel = vbSelect({
    options: [
      { value: '', label: 'None' },
      { value: 'high', label: 'High' },
      { value: 'medium', label: 'Medium' },
      { value: 'low', label: 'Low' },
    ],
    value: card.priority || '',
    placeholder: 'None',
    ariaLabel: 'Priority',
    onChange: value => {
      card.priority = value || null;
      saveModal(card);
    },
  });
  cardPriorityMount.appendChild(cardPrioritySel.el);

  // Due date
  const dueDateEl = document.getElementById('card-due-date');
  dueDateEl.value = card.due_date || '';
  dueDateEl.classList.toggle('overdue', isOverdue(card.due_date));
  dueDateEl.onchange = () => {
    card.due_date = dueDateEl.value || null;
    dueDateEl.classList.toggle('overdue', isOverdue(card.due_date));
    saveModal(card);
  };

  // Blocked-by dependency picker
  renderDepPicker(card);

  // Custom prompt textarea
  const customPromptSection = document.getElementById('card-custom-prompt-section');
  const customPromptEl = document.getElementById('card-custom-prompt');
  customPromptSection.style.display = card.agent ? '' : 'none';
  customPromptEl.value = card.custom_prompt || '';
  customPromptEl.onchange = () => {
    card.custom_prompt = customPromptEl.value;
    updatePromptBox(card);
    saveModal(card);
  };

  // Duplicate button
  const dupBtn = document.getElementById('card-duplicate-btn');
  dupBtn.style.display = '';
  dupBtn.onclick = async () => {
    dupBtn.disabled = true; dupBtn.textContent = '…';
    try {
      await fetch(`/api/cards/${cardId}/duplicate`, { method: 'POST' });
      showToast('Card duplicated', 3000, 'success');
    } catch(err) { showToast('Duplicate failed: ' + err.message, 3000, 'error'); }
    dupBtn.disabled = false; dupBtn.textContent = 'Duplicate';
  };

  document.getElementById('card-sidebar-footer').classList.add('visible');
  updatePromptBox(card);
  showChangesSection(card);
  updateRunAgentBtn(card);
  updateMoveButtons(card, col.title);

  const outputSection = document.getElementById('card-output-section');
  const outputPre = document.getElementById('card-output-content');
  const outputToggle = document.getElementById('card-output-toggle');
  outputSection.style.display = 'none';
  outputPre.textContent = '';
  outputToggle.style.display = 'none';
  outputToggle.textContent = 'Show full output';
  outputToggle.onclick = () => {
    const visible = outputSection.style.display === 'block';
    outputSection.style.display = visible ? 'none' : 'block';
    outputToggle.textContent = visible ? 'Show full output' : 'Hide full output';
    if (!visible) outputPre.scrollTop = outputPre.scrollHeight;
  };
  // Always fetch on card open — restores live output after a card switch or page
  // reload without relying on runningCards being pre-seeded.
  fetch(`/api/cards/${cardId}/output`).then(r => r.json()).then(d => {
    if (d.output && d.output.trim()) {
      outputPre.textContent = sanitizeOutput(d.output);
      outputToggle.style.display = 'inline-block';
      outputToggle.textContent = 'Hide full output';
      outputSection.style.display = 'block';
      outputPre.scrollTop = outputPre.scrollHeight;
    } else if (runningCards.has(cardId)) {
      outputToggle.style.display = 'inline-block';
    }
  }).catch(() => {
    if (runningCards.has(cardId)) outputToggle.style.display = 'inline-block';
  });

  const savedTab = localStorage.getItem('vb_sidebar_tab');
  switchSidebarTab(savedTab || 'details');

  cardSidebar.classList.add('open');
  cardModalTitleEl.focus();
  syncAriaPressed(cardSidebar);

  loadCardNotes(cardId).then(notes => {
    renderCardNotes(notes);
    const hasActivity = notes.length > 0 || card.branch;
    const actDivider = document.getElementById('card-activity-divider');
    if (actDivider) actDivider.style.display = hasActivity ? '' : 'none';
  });

  if (savedTab === 'context') loadAgentContext(card.agent);
}

function renderTagPicker(container, selectedTags) {
  container.innerHTML = '';
  TAGS.forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'tag-pick-btn'; btn.dataset.tag = tag; btn.textContent = tag; btn.type = 'button';
    const active = (selectedTags || []).includes(tag);
    if (active) { btn.classList.add('active'); btn.style.backgroundColor = tagColor(tag); btn.style.color = 'white'; }
    else { btn.style.color = tagColor(tag); btn.style.opacity = '0.45'; }
    btn.addEventListener('click', () => {
      const isActive = btn.classList.toggle('active');
      btn.style.backgroundColor = isActive ? tagColor(tag) : '';
      btn.style.color = isActive ? 'white' : tagColor(tag);
      btn.style.opacity = isActive ? '1' : '0.45';
    });
    container.appendChild(btn);
  });
}

function openNewCardModal(colId) {
  newCardColId = colId;
  const col = board.columns.find(c => c.id === colId);
  if (!col) return;
  
  document.getElementById('nc-col-badge').textContent = col.title;
  document.getElementById('nc-col-badge').style.background = col.color || '#6b6860';
  document.getElementById('nc-title-input').value = '';
  document.getElementById('nc-desc').value = '';
  document.getElementById('nc-due-date').value = '';
  document.getElementById('nc-needs-review').checked = false;
  document.getElementById('nc-review-agent-section').style.display = 'none';

  renderTagPicker(document.getElementById('nc-tag-picker'), []);

  function syncNcReviewSection() {
    const hasAgent = !!window._ncAgentSelect?.getValue();
    const needsReview = document.getElementById('nc-needs-review').checked;
    document.getElementById('nc-review-agent-section').style.display = (hasAgent && needsReview) ? '' : 'none';
  }

  const ncAgentOpts = [
    { value: '', label: 'None' },
    ...['claude-code', 'opencode', 'codex', 'command-code'].map(k => {
      const reason = agentUnavailableReason(k);
      return { value: k, label: AGENT_LABELS[k] || k, disabled: !!reason, hint: reason || undefined };
    }),
  ];
  if (!window._ncAgentSelect) {
    window._ncAgentSelect = vbSelect({
      options: ncAgentOpts,
      value: '',
      placeholder: 'Select agent',
      ariaLabel: 'Agent',
      onChange: val => {
        const warning = document.getElementById('nc-agent-warning');
        const modelRow = document.getElementById('nc-model-row');
        if (val) {
          warning.style.display = 'flex';
          modelRow.style.display = 'block';
          updateModelDropdown('nc', val);
        } else {
          warning.style.display = 'none';
          modelRow.style.display = 'none';
        }
        syncNcReviewSection();
      },
    });
    document.getElementById('nc-agent-mount').appendChild(window._ncAgentSelect.el);
  } else {
    window._ncAgentSelect.setOptions(ncAgentOpts);
    window._ncAgentSelect.setValue('');
  }

  const ncReviewAgentOpts = [
    { value: '', label: 'Same as main agent' },
    ...['claude-code', 'opencode', 'codex', 'command-code'].map(k => {
      const reason = agentUnavailableReason(k);
      return { value: k, label: AGENT_LABELS[k] || k, disabled: !!reason, hint: reason || undefined };
    }),
  ];
  if (!window._ncReviewAgentSelect) {
    window._ncReviewAgentSelect = vbSelect({
      options: ncReviewAgentOpts,
      value: '',
      placeholder: 'Same as main agent',
      ariaLabel: 'Review agent',
      onChange: val => updateModelDropdown('nc-review', val),
    });
    document.getElementById('nc-review-agent-mount').appendChild(window._ncReviewAgentSelect.el);
  } else {
    window._ncReviewAgentSelect.setOptions(ncReviewAgentOpts);
    window._ncReviewAgentSelect.setValue('');
  }

  document.getElementById('nc-review-model-row').style.display = 'none';
  document.getElementById('nc-needs-review').onchange = syncNcReviewSection;

  if (!window._ncPrioritySelect) {
    window._ncPrioritySelect = vbSelect({
      options: [
        { value: '', label: 'None' },
        { value: 'high', label: 'High' },
        { value: 'medium', label: 'Medium' },
        { value: 'low', label: 'Low' },
      ],
      value: '',
      placeholder: 'Priority',
      ariaLabel: 'Priority',
    });
    document.getElementById('nc-priority-mount').appendChild(window._ncPrioritySelect.el);
  } else {
    window._ncPrioritySelect.setValue('');
  }
  
  document.getElementById('nc-agent-warning').style.display = 'none';
  document.getElementById('nc-model-row').style.display = 'none';
  
  ncBlockedBy = [];
  renderBlockedByControl(
    document.getElementById('nc-dep-list'),
    () => ncBlockedBy,
    ids => { ncBlockedBy = ids; },
    null,
  );

  loadTemplatesForNewCard();

  document.getElementById('nc-modal-overlay').classList.add('open');
  document.getElementById('nc-title-input').focus();
  syncAriaPressed(document.getElementById('nc-modal-overlay'));
}

async function loadTemplatesForNewCard() {
  if (!board?.id) return;
  try {
    const resp = await fetch(`/api/workspaces/${board.id}/templates`);
    if (resp.ok) {
      const templates = await resp.json();
      if (templates.length > 0) {
        renderTemplateSelect(templates);
        document.getElementById('nc-template-row').style.display = 'block';
      } else {
        document.getElementById('nc-template-row').style.display = 'none';
      }
    }
  } catch(_){
    document.getElementById('nc-template-row').style.display = 'none';
  }
}

function renderTemplateSelect(templates) {
  if (!window._ncTemplateSelect) {
    window._ncTemplateSelect = vbSelect({
      options: [{ value: '', label: 'None' }],
      value: '',
      placeholder: 'Select template',
      ariaLabel: 'Template',
      onChange: val => {
        if (val) applyTemplate(val, templates);
      },
    });
    document.getElementById('nc-template-mount').appendChild(window._ncTemplateSelect.el);
  }
  
  const opts = [
    { value: '', label: 'None' },
    ...templates.map(t => ({ value: t.id, label: t.name }))
  ];
  window._ncTemplateSelect.setOptions(opts);
  window._ncTemplateSelect.setValue('');
}

function applyTemplate(templateId, templates) {
  const tpl = templates.find(t => t.id === templateId);
  if (!tpl) return;
  
  if (tpl.title_pattern) {
    document.getElementById('nc-title-input').value = tpl.title_pattern;
  }
  
  if (tpl.tags?.length) {
    renderTagPicker(document.getElementById('nc-tag-picker'), tpl.tags);
  }
  
  if (tpl.agent) {
    window._ncAgentSelect?.setValue(tpl.agent);
    document.getElementById('nc-agent-warning').style.display = 'flex';
    document.getElementById('nc-model-row').style.display = 'block';
    if (tpl.model) {
      updateModelDropdown('nc', tpl.agent);
      setTimeout(() => modelSelects['nc']?.setValue(tpl.model), 100);
    }
  }
  
  if (tpl.priority) {
    window._ncPrioritySelect?.setValue(tpl.priority);
  }
  
  if (tpl.custom_prompt) {
    document.getElementById('nc-desc').value = tpl.custom_prompt;
  }
  
  document.getElementById('nc-title-input').focus();
  document.getElementById('nc-title-input').select();
}

function getModalTags() {
  return Array.from(cardModalTagPicker.querySelectorAll('.tag-pick-btn.active')).map(b => b.dataset.tag);
}

function getModalAgent() {
  // Card sidebar uses vbSelect dropdown
  const sidebarMount = document.getElementById('card-agent-mount');
  if (sidebarMount?._agentSelect) return sidebarMount._agentSelect.getValue() || undefined;
  // New card modal uses vbSelect dropdown
  return window._ncAgentSelect?.getValue() || undefined;
}


// Reusable "blocked by" control: a dropdown to add a blocker + removable chips
// for the current selections. getBlocked()/setBlocked() own persistence so the
// same control works for an existing card (saves immediately) and the New Card
// modal (buffers into ncBlockedBy until create). excludeId hides the card itself.
function renderBlockedByControl(containerEl, getBlocked, setBlocked, excludeId) {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  const candidates = [];
  for (const col of (board?.columns || [])) {
    if (col.title === 'Done') continue; // Done cards can't block anything
    for (const c of col.cards) {
      if (c.id !== excludeId) candidates.push({ card: c, column: col });
    }
  }

  // Sort: In Progress first, then Review, then Backlog, then remaining columns
  const colRank = {};
  (board.columns || []).forEach((col, i) => { colRank[col.title] = i; });
  const COL_SORT = { 'In Progress': 0, 'Review': 1, 'Backlog': 2 };
  candidates.sort((a, b) => {
    const ra = COL_SORT[a.column.title] ?? (3 + (colRank[a.column.title] ?? 99));
    const rb = COL_SORT[b.column.title] ?? (3 + (colRank[b.column.title] ?? 99));
    return ra - rb;
  });

  const chips = document.createElement('div');
  chips.className = 'dep-chips';

  const ctrl = vbSelect({
    options: [], value: '', placeholder: '+ Add a blocker\u2026', ariaLabel: 'Add a blocker',
    onChange: id => {
      if (!id) return;
      const cur = getBlocked();
      if (!cur.includes(id)) {
        const proposed = [...cur, id];
        if (excludeId) {
          const cyclePath = detectCycleUI(excludeId, proposed);
          if (cyclePath) {
            const titles = cyclePathTitles(cyclePath);
            showToast('Circular dependency: ' + titles.join(' \u2192 ') + ' \u2014 choose a different blocker', 5000, 'error');
            ctrl.setValue('');
            return;
          }
        }
        setBlocked(proposed);
      }
      ctrl.setValue('');
      repaint();
    },
  });

  function repaint() {
    const blocked = getBlocked();
    const available = candidates.filter(({ card }) => !blocked.includes(card.id));
    ctrl.setOptions(available.map(({ card, column }) => ({
      value: card.id,
      label: card.title,
      hint: column.title,
    })));
    ctrl.setValue('');
    ctrl.setPlaceholder(!candidates.length ? 'No available blockers'
      : (!available.length ? 'All cards selected' : '+ Add a blocker…'));

    chips.innerHTML = '';
    blocked.forEach(id => {
      const entry = findCardEntry(id);
      const done = entry && entry.column.title === 'Done';
      const chip = document.createElement('span');
      chip.className = 'dep-chip' + (done ? ' done' : '');
      const label = document.createElement('span');
      label.className = 'dep-chip-label';
      label.textContent = entry ? entry.card.title : '(deleted card)';
      chip.title = done ? 'Satisfied - already in Done' : (entry ? entry.column.title : 'No longer on the board');
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'dep-chip-x'; x.textContent = '×';
      x.setAttribute('aria-label', 'Remove blocker');
      x.addEventListener('click', () => { setBlocked(getBlocked().filter(b => b !== id)); repaint(); });
      chip.appendChild(label); chip.appendChild(x);
      chips.appendChild(chip);
    });
  }

  containerEl.appendChild(ctrl.el);
  containerEl.appendChild(chips);
  repaint();
}

function renderDepPicker(card) {
  renderBlockedByControl(
    document.getElementById('card-dep-list'),
    () => card.blocked_by || [],
    ids => { card.blocked_by = ids; saveModal(card); },
    card.id,
  );
}

function updateRunAgentBtn(card) {
  const btn = document.getElementById('card-run-agent-btn');
  const section = document.getElementById('card-agent-run-section');
  const lastRunEl = document.getElementById('card-agent-last-run');
  if (!card || !card.agent) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = '';
  const running = runningCards.has(card.id);
  const AGENT_RUNNABLE_COLUMNS = ['In Progress', 'Review'];
  const col = board.columns.find(c => c.id === modalColId);
  const canRunAgent = AGENT_RUNNABLE_COLUMNS.includes(col?.title);
  if (btn) {
    if (!canRunAgent && !running) {
      btn.disabled = true;
      btn.title = 'Move card to In Progress or Review to run the agent';
      btn.textContent = 'Run agent';
    } else {
      btn.disabled = running;
      btn.title = '';
      btn.textContent = running ? 'Running\u2026' : 'Run agent';
    }
  }
  const stopBtn = document.getElementById('card-stop-agent-btn');
  if (stopBtn) { stopBtn.style.display = running ? '' : 'none'; stopBtn.disabled = false; stopBtn.textContent = 'Stop agent'; }
  if (lastRunEl) {
    if (card.agent_ran_at) {
      const bits = ['Last run: ' + timeAgo(card.agent_ran_at)];
      if (card.last_exit_code !== null && card.last_exit_code !== undefined) {
        bits.push(card.last_exit_code === 0 ? '✓ ok' : `✗ exit ${card.last_exit_code}`);
      }
      if (card.last_duration != null) bits.push(fmtDuration(card.last_duration));
      const usage = [];
      if (card.last_cost != null) usage.push('$' + Number(card.last_cost).toFixed(card.last_cost < 1 ? 3 : 2));
      if (card.last_tokens != null) usage.push(fmtTokens(card.last_tokens) + ' tok');
      if (usage.length) bits.push(usage.join(' · '));
      lastRunEl.textContent = bits.join('  ·  ');
    } else {
      lastRunEl.textContent = '';
    }
  }
}

function updateMoveButtons(card, currentColTitle) {
  const moveSection = document.getElementById('card-move-actions');
  const moveButtons = document.getElementById('card-move-buttons');

  if (!card) { moveSection.style.display = 'none'; return; }

  const targets = board.columns.filter(c => c.title !== currentColTitle);
  if (targets.length === 0) { moveSection.style.display = 'none'; return; }

  moveSection.style.display = 'block';
  moveButtons.innerHTML = '';

  const blockers = unfinishedBlockersUI(card);

  targets.forEach(targetCol => {
    const btn = document.createElement('button');
    btn.className = 'card-move-btn';
    btn.textContent = `→ ${targetCol.title}`;
    // Block starting a card (move to In Progress) while it has unfinished blockers.
    if (targetCol.title === 'In Progress' && blockers.length) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
      btn.title = 'Blocked by: ' + blockers.map(c => c.title).join(', ');
      moveButtons.appendChild(btn);
      return;
    }
    btn.onclick = async () => {
      const tc = board.columns.find(c => c.id === targetCol.id);
      if (!tc) return;
      const sourceCol = board.columns.find(c => c.id === modalColId);
      if (!sourceCol) return;
      const cardIdx = sourceCol.cards.findIndex(c => c.id === card.id);
      if (cardIdx === -1) return;

      const willSpawnAgent = card.agent && (targetCol.title === 'In Progress' || targetCol.title === 'Review');
      let runSkipPermissions = true;
      if (willSpawnAgent) {
        const choice = await vbConfirmRunAgent(card.title || card.text, board.skip_permissions === undefined ? true : !!board.skip_permissions);
        if (!choice) return;
        runSkipPermissions = choice.skipPermissions;
      }

      const [movedCard] = sourceCol.cards.splice(cardIdx, 1);
      tc.cards.push(movedCard);
      renderBoard(board);
      closeCardModal();
      await postBoard();
      if (willSpawnAgent) {
        showToast(`Starting ${AGENT_LABELS[card.agent] || card.agent} on "${card.title || card.text}"`, 4000);
        try {
          await fetch(`/api/cards/${card.id}/run`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skipPermissions: runSkipPermissions }),
          });
        }
        catch (err) { showToast('Failed to start agent: ' + err.message, 3000, 'error'); }
      } else {
        showToast(`Moved to ${targetCol.title}`);
      }
    };
    moveButtons.appendChild(btn);
  });
}

function updatePromptBox(card) {
  const promptSection = document.getElementById('card-prompt-section');
  const promptText = document.getElementById('card-modal-prompt-text');
  if (!card.agent) {
    promptSection.style.display = 'none';
  } else {
    const wasHidden = promptSection.style.display === 'none';
    const col = board.columns.find(c => c.id === modalColId);
    const desc = card.description ? `\nDescription: ${card.description}` : '';
    const tags = (card.tags||[]).length ? `\nTags: ${card.tags.join(', ')}` : '';
    
    let columnContext = '';
    const colTitle = col?.title || '';
    const needsReview = !!card.requires_review;
    if (colTitle === 'In Progress') {
      const next = needsReview ? 'call move_card to Review' : 'call complete_card (no review needed)';
      columnContext = `\nIN PROGRESS: implement the task, commit all changes, then ${next}.
- Use add_card_note to log progress
- Commit before moving: \`git add -A && git commit -m "..."\``;
    } else if (colTitle === 'Review') {
      columnContext = `\nREVIEW: verify changes, run tests, check for bugs.
- Use add_card_note to log findings
- Issues found → commit fixes, then move_card to In Progress
- All good → commit and call complete_card`;
    } else if (colTitle === 'Done') {
      columnContext = `\nDONE: work is complete. User merges manually.`;
    } else {
      columnContext = `\nColumn: ${colTitle}`;
    }

    promptText.value = `VibeBoard task: "${card.title||card.text}"${desc}${tags}${columnContext}
Card ID: ${card.id} | Workspace ID: ${activeWsId||''}${card.custom_prompt ? '\n\n' + card.custom_prompt : ''}`;
    promptSection.style.display = 'block';
    if (wasHidden) {
      promptText.classList.remove('collapsed');
      promptToggle.textContent = 'Hide \u25B4';
    }
  }
}

function showChangesSection(card) {
  const section  = document.getElementById('card-changes-section');
  const actions  = document.getElementById('card-merge-actions');
  const badge    = document.getElementById('card-branch-badge');
  const meta     = document.getElementById('card-changes-meta');
  const diffView = document.getElementById('card-diff-view');
  const toggleBtn = document.getElementById('card-diff-toggle');
  const mergedInfo = document.getElementById('card-merged-info');
  const mergedDate = document.getElementById('card-merged-date');

  if (!card.branch && !card.merged_at) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';

  if (card.merged_at) {
    actions.style.display = 'none';
    mergedInfo.style.display = 'flex';
    mergedDate.textContent = fmtTime(card.merged_at);
    badge.textContent = card.branch || '(no branch)';
    meta.textContent = '';
    diffView.style.display = 'none';
    diffView.innerHTML = '';
    toggleBtn.style.display = 'none';
    document.getElementById('card-diff-expand').style.display = 'none';
    return;
  }

  mergedInfo.style.display = 'none';
  const inDone = board.columns.find(c => c.id === modalColId)?.title === 'Done';
  actions.style.display = inDone ? 'flex' : 'none';
  toggleBtn.style.display = '';
  document.getElementById('card-diff-expand').style.display = '';
  const mergeBtn = document.getElementById('card-merge-btn');
  const prBtn    = document.getElementById('card-pr-btn');
  mergeBtn.disabled = true; mergeBtn.title = 'No commits on this branch yet'; mergeBtn.textContent = 'Merge';
  prBtn.disabled    = true; prBtn.title    = 'No commits on this branch yet'; prBtn.textContent    = 'Create PR';
  badge.textContent = card.branch;
  meta.textContent = '';
  diffView.style.display = 'none';
  diffView.innerHTML = '';
  toggleBtn.textContent = 'Show diff';
  toggleBtn._diffData = null;

  fetch(`/api/cards/${card.id}/diff`)
    .then(r => r.json())
    .then(data => {
      const count = data.commits ? data.commits.split('\n').filter(Boolean).length : 0;
      const hasChanges = !!(data.diff && data.diff.trim());
      meta.textContent = count ? `${count} commit${count > 1 ? 's' : ''}` : 'no commits yet';
      toggleBtn._diffData = data;
      const mb = document.getElementById('card-merge-btn');
      const pb = document.getElementById('card-pr-btn');
      const disabledTitle = !count ? 'No commits on this branch yet' : 'No file changes to merge';
      mb.disabled = !hasChanges; mb.title = hasChanges ? '' : disabledTitle;
      pb.disabled = !hasChanges; pb.title = hasChanges ? '' : disabledTitle;
    })
    .catch(() => { meta.textContent = ''; });
}

function saveModal(card) {
  card.title = cardModalTitleEl.value.trim() || card.title;
  renderBoard(board); postBoard();
}

cardModalTitleEl.addEventListener('input', () => {
  const col = board.columns.find(c=>c.id===modalColId);
  const card = col?.cards.find(c=>c.id===modalCardId);
  if (card) { card.title = cardModalTitleEl.value; updatePromptBox(card); }
});
cardModalTitleEl.addEventListener('change', () => saveModal(board.columns.find(c=>c.id===modalColId)?.cards.find(c=>c.id===modalCardId)));
cardModalDesc.addEventListener('input', () => {
  const col = board.columns.find(c=>c.id===modalColId);
  const card = col?.cards.find(c=>c.id===modalCardId);
  if (card) { card.description = cardModalDesc.value; updatePromptBox(card); }
});
cardModalDesc.addEventListener('change', () => saveModal(board.columns.find(c=>c.id===modalColId)?.cards.find(c=>c.id===modalCardId)));

cardModalClose.addEventListener('click', closeCardModal);

// Resize handle for card sidebar
const resizeHandle = document.getElementById('card-sidebar-resize-handle');
let isResizing = false;
let startX = 0;
let startWidth = 0;

const CARD_SIDEBAR_MIN_WIDTH = 400;
const CARD_SIDEBAR_MAX_WIDTH = 800;
const CARD_SIDEBAR_DEFAULT_WIDTH = 480;

// Load saved width from localStorage
const savedWidth = localStorage.getItem('vb_card_sidebar_width');
if (savedWidth) {
  const width = parseInt(savedWidth, 10);
  if (width >= CARD_SIDEBAR_MIN_WIDTH && width <= CARD_SIDEBAR_MAX_WIDTH) {
    cardSidebar.style.width = width + 'px';
  }
}

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  startX = e.clientX;
  startWidth = cardSidebar.offsetWidth;
  document.body.style.cursor = 'ew-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const deltaX = startX - e.clientX;
  const newWidth = Math.max(CARD_SIDEBAR_MIN_WIDTH, Math.min(CARD_SIDEBAR_MAX_WIDTH, startWidth + deltaX));
  cardSidebar.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('vb_card_sidebar_width', cardSidebar.offsetWidth);
  }
});

// ── Tab switching ──────────────────────────────────────────────────────────
function switchSidebarTab(tabId) {
  document.querySelectorAll('.sidebar-tab').forEach(btn => {
    const isActive = btn.dataset.tab === tabId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive);
  });
  document.querySelectorAll('.sidebar-panel').forEach(panel => {
    panel.hidden = panel.dataset.panel !== tabId;
  });
  localStorage.setItem('vb_sidebar_tab', tabId);
}

document.querySelectorAll('.sidebar-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    switchSidebarTab(btn.dataset.tab);
    if (btn.dataset.tab === 'context') {
      const col = board.columns.find(c => c.id === modalColId);
      const card = col?.cards.find(c => c.id === modalCardId);
      loadAgentContext(card?.agent);
    }
  });
});

function closeCardModal() {
  document.getElementById('card-prompt-section').style.display = 'none';
  document.getElementById('card-agent-run-section').style.display = 'none';
  document.getElementById('card-review-toggle-row').style.display = 'none';
  document.getElementById('card-custom-prompt-section').style.display = 'none';
  document.getElementById('card-duplicate-btn').style.display = 'none';
  document.getElementById('card-move-actions').style.display = 'none';
  document.getElementById('card-modal-branch-badge').style.display = 'none';
  document.getElementById('card-merge-actions').style.display = 'none';
  document.getElementById('card-merged-info').style.display = 'none';
  document.getElementById('card-changes-section').style.display = 'none';
  const actDivider = document.getElementById('card-activity-divider');
  if (actDivider) actDivider.style.display = 'none';
  document.getElementById('card-notes-section').style.display = 'none';
  const outToggle = document.getElementById('card-output-toggle');
  if (outToggle) { outToggle.style.display = 'none'; outToggle.textContent = 'Show full output'; }
  document.getElementById('card-output-section').style.display = 'none';
  document.getElementById('card-output-content').textContent = '';
  document.getElementById('card-sidebar-footer').classList.remove('visible');
  newCardColId = null;
  cardSidebar.classList.remove('open');
  modalCardId = null;
  modalColId = null;
}

cardModalCopyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(cardModalPromptTxt.value).then(() => {
    cardModalCopyBtn.textContent = 'Copied!'; cardModalCopyBtn.classList.add('copied');
    setTimeout(() => { cardModalCopyBtn.textContent = 'Copy'; cardModalCopyBtn.classList.remove('copied'); }, 2000);
  });
});

// ── Agent prompt toggle (collapsed by default) ──────────────────────────────
const promptToggle = document.getElementById('card-prompt-toggle');
const promptTextarea = document.getElementById('card-modal-prompt-text');
promptToggle.addEventListener('click', () => {
  const collapsed = promptTextarea.classList.contains('collapsed');
  if (collapsed) {
    promptTextarea.classList.remove('collapsed');
    promptToggle.textContent = 'Hide \u25B4';
  } else {
    promptTextarea.classList.add('collapsed');
    promptToggle.textContent = 'Show \u25BE';
  }
});

// ── Diff rendering ─────────────────────────────────────────────────────────
function parseDiff(diffStr) {
  const files = [];
  let f = null, h = null;
  for (const line of diffStr.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (h && f) { f.hunks.push(h); h = null; }
      if (f) files.push(f);
      f = { header: [line], hunks: [] };
    } else if (f && !h && /^(index |--- |\+\+\+ )/.test(line)) {
      f.header.push(line);
    } else if (line.startsWith('@@')) {
      if (h && f) f.hunks.push(h);
      h = { header: line, lines: [] };
    } else if (h) {
      h.lines.push(line);
    }
  }
  if (h && f) f.hunks.push(h);
  if (f) files.push(f);
  return files;
}

function diffFilename(hdr) {
  const p = hdr.find(l => l.startsWith('+++ '));
  if (p && !p.includes('/dev/null')) return p.startsWith('+++ b/') ? p.slice(6) : p.slice(4);
  const d = hdr.find(l => l.startsWith('diff --git '));
  if (d) { const m = d.match(/b\/(.+)$/); if (m) return m[1]; }
  return hdr[0] || '';
}

function hunkNums(hdr) {
  const m = hdr.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return m ? [+m[1], +m[2]] : [1, 1];
}

function groupHunk(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const c = lines[i] ? lines[i][0] : ' ';
    if (c === '-') {
      const del = [], add = [];
      while (i < lines.length && lines[i][0] === '-') del.push(lines[i++].slice(1));
      while (i < lines.length && lines[i][0] === '+') add.push(lines[i++].slice(1));
      out.push({ del, add });
    } else if (c === '+') {
      const add = [];
      while (i < lines.length && lines[i][0] === '+') add.push(lines[i++].slice(1));
      out.push({ del: [], add });
    } else {
      out.push({ ctx: (lines[i++] || ' ').slice(1) });
    }
  }
  return out;
}

function wordDiff(a, b) {
  const aw = a.split(/(\s+)/), bw = b.split(/(\s+)/);
  const dp = Array.from({ length: aw.length + 1 }, () => new Array(bw.length + 1).fill(0));
  for (let i = 1; i <= aw.length; i++)
    for (let j = 1; j <= bw.length; j++)
      dp[i][j] = aw[i-1] === bw[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const oR = [], nR = [];
  let i = aw.length, j = bw.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aw[i-1] === bw[j-1]) {
      oR.unshift({ text: aw[--i], type: 'same' }); nR.unshift({ text: bw[--j], type: 'same' });
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      nR.unshift({ text: bw[--j], type: 'add' });
    } else {
      oR.unshift({ text: aw[--i], type: 'del' });
    }
  }
  return { oldResult: oR, newResult: nR };
}

function makeDsvRow(type, ln, sign, parts) {
  const row = document.createElement('div');
  row.className = 'dsv-row dsv-' + type;
  const lnEl = document.createElement('span');
  lnEl.className = 'dsv-ln'; lnEl.textContent = ln !== '' ? String(ln) : '';
  const signEl = document.createElement('span');
  signEl.className = 'dsv-sign'; signEl.textContent = sign;
  const codeEl = document.createElement('span');
  codeEl.className = 'dsv-code';
  if (parts) for (const p of parts) {
    if (p.mark) {
      const s = document.createElement('span');
      s.className = 'dsv-w-' + p.mark; s.textContent = p.text;
      codeEl.appendChild(s);
    } else codeEl.appendChild(document.createTextNode(p.text));
  }
  row.appendChild(lnEl); row.appendChild(signEl); row.appendChild(codeEl);
  return row;
}

function renderDiffInto(container, diffStr) {
  container.innerHTML = '';
  if (!diffStr) {
    const e = document.createElement('div');
    e.className = 'diff-empty'; e.textContent = 'No changes yet.';
    container.appendChild(e); return;
  }
  if (container.classList.contains('diff-expand-body') && window.innerWidth >= 768) {
    renderSplitDiff(container, diffStr);
  } else {
    renderUnifiedDiff(container, diffStr);
  }
}

function renderUnifiedDiff(container, diffStr) {
  const wrap = document.createElement('div'); wrap.className = 'diff-view';
  diffStr.split('\n').forEach(line => {
    const el = document.createElement('span'); el.className = 'diff-line';
    if (line.startsWith('+') && !line.startsWith('+++'))      el.classList.add('add');
    else if (line.startsWith('-') && !line.startsWith('---')) el.classList.add('del');
    else if (line.startsWith('@@'))                           el.classList.add('hunk');
    else if (/^(diff |index |--- |\+\+\+ )/.test(line))      el.classList.add('meta');
    el.textContent = line || ' ';
    wrap.appendChild(el);
  });
  container.appendChild(wrap);
}

function renderSplitDiff(container, diffStr) {
  const files = parseDiff(diffStr);
  const view = document.createElement('div');
  view.className = 'dsv';

  // Two global columns spanning all files — single vertical scroll on right, horizontal per pane
  const layout = document.createElement('div');
  layout.className = 'dsv-layout';

  const leftCol = document.createElement('div');
  leftCol.className = 'dsv-col dsv-col-l';
  const leftInner = document.createElement('div');
  leftInner.className = 'dsv-col-inner';
  leftCol.appendChild(leftInner);

  const rightCol = document.createElement('div');
  rightCol.className = 'dsv-col dsv-col-r';
  const rightInner = document.createElement('div');
  rightInner.className = 'dsv-col-inner';
  rightCol.appendChild(rightInner);

  layout.appendChild(leftCol);
  layout.appendChild(rightCol);
  view.appendChild(layout);

  files.forEach(file => {
    const mkFileBar = () => {
      const fbar = document.createElement('div');
      fbar.className = 'dsv-file';
      const arrow = document.createElement('span');
      arrow.className = 'dsv-arrow'; arrow.textContent = '▾';
      const fname = document.createElement('span');
      fname.textContent = diffFilename(file.header);
      fbar.appendChild(arrow); fbar.appendChild(fname);
      return { fbar, arrow };
    };

    const { fbar: lbar, arrow: larrow } = mkFileBar();
    const { fbar: rbar, arrow: rarrow } = mkFileBar();

    const lbody = document.createElement('div');
    lbody.className = 'dsv-file-body';
    const rbody = document.createElement('div');
    rbody.className = 'dsv-file-body';

    const toggleCollapse = () => {
      const c = lbody.classList.toggle('dsv-body-collapsed');
      rbody.classList.toggle('dsv-body-collapsed', c);
      larrow.textContent = c ? '▸' : '▾';
      rarrow.textContent = c ? '▸' : '▾';
    };
    lbar.addEventListener('click', toggleCollapse);
    rbar.addEventListener('click', toggleCollapse);

    leftInner.appendChild(lbar);
    leftInner.appendChild(lbody);
    rightInner.appendChild(rbar);
    rightInner.appendChild(rbody);

    file.hunks.forEach(hunk => {
      const mkHunk = () => {
        const h = document.createElement('div');
        h.className = 'dsv-hunk'; h.textContent = hunk.header; return h;
      };
      lbody.appendChild(mkHunk()); rbody.appendChild(mkHunk());

      let [oLn, nLn] = hunkNums(hunk.header);

      groupHunk(hunk.lines).forEach(g => {
        if ('ctx' in g) {
          lbody.appendChild(makeDsvRow('ctx', oLn, ' ', [{ text: g.ctx }]));
          rbody.appendChild(makeDsvRow('ctx', nLn, ' ', [{ text: g.ctx }]));
          oLn++; nLn++;
        } else {
          const max = Math.max(g.del.length, g.add.length);
          for (let k = 0; k < max; k++) {
            const hasDel = k < g.del.length, hasAdd = k < g.add.length;
            if (hasDel && hasAdd) {
              const { oldResult, newResult } = wordDiff(g.del[k], g.add[k]);
              lbody.appendChild(makeDsvRow('del', oLn++, '−',
                oldResult.map(p => ({ text: p.text, mark: p.type === 'del' ? 'del' : null }))));
              rbody.appendChild(makeDsvRow('add', nLn++, '+',
                newResult.map(p => ({ text: p.text, mark: p.type === 'add' ? 'add' : null }))));
            } else if (hasDel) {
              lbody.appendChild(makeDsvRow('del', oLn++, '−', [{ text: g.del[k] }]));
              rbody.appendChild(makeDsvRow('empty', '', '', null));
            } else {
              lbody.appendChild(makeDsvRow('empty', '', '', null));
              rbody.appendChild(makeDsvRow('add', nLn++, '+', [{ text: g.add[k] }]));
            }
          }
        }
      });
    });
  });

  // Single horizontal sync (left↔right) + vertical sync (right→left)
  leftCol.addEventListener('scroll', () => {
    rightCol.scrollLeft = leftCol.scrollLeft;
  }, { passive: true });
  rightCol.addEventListener('scroll', () => {
    leftCol.scrollLeft = rightCol.scrollLeft;
    leftCol.scrollTop = rightCol.scrollTop;
  }, { passive: true });
  // Forward vertical wheel on left pane to right pane (left has overflow-y: hidden)
  leftCol.addEventListener('wheel', e => {
    if (e.deltaY !== 0) rightCol.scrollTop += e.deltaY;
  }, { passive: true });

  container.appendChild(view);
}

// ── Diff toggle ────────────────────────────────────────────────────────────
document.getElementById('card-diff-toggle').addEventListener('click', async function() {
  const diffView = document.getElementById('card-diff-view');
  if (diffView.style.display !== 'none') {
    diffView.style.display = 'none'; this.textContent = 'Show diff'; return;
  }
  if (!this._diffData) {
    this.textContent = 'Loading…';
    try {
      this._diffData = await fetch(`/api/cards/${modalCardId}/diff`).then(r => r.json());
    } catch(_) { this.textContent = 'Show diff'; return; }
  }
  renderDiffInto(diffView, this._diffData.diff);
  diffView.style.display = 'block'; this.textContent = 'Hide diff';
});

// ── Diff expand dialog ─────────────────────────────────────────────────────
document.getElementById('card-diff-expand').addEventListener('click', async function() {
  const toggleBtn = document.getElementById('card-diff-toggle');
  if (!toggleBtn._diffData) {
    try {
      toggleBtn._diffData = await fetch(`/api/cards/${modalCardId}/diff`).then(r => r.json());
    } catch(_) { return; }
  }

  const col = board.columns.find(c => c.id === modalColId);
  const card = col?.cards.find(c => c.id === modalCardId);
  const branchName = card?.branch || 'Diff';

  const existing = document.querySelector('.diff-expand-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'diff-expand-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'diff-expand-dialog';

  const header = document.createElement('div');
  header.className = 'diff-expand-header';
  const title = document.createElement('span');
  title.className = 'diff-expand-title';
  title.textContent = branchName;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'diff-expand-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close diff dialog');
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'diff-expand-body';
  renderDiffInto(body, toggleBtn._diffData.diff);

  dialog.appendChild(header);
  dialog.appendChild(body);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function closeDialog() {
    overlay.remove();
  }

  closeBtn.addEventListener('click', closeDialog);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeDialog();
  });
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape' && document.body.contains(overlay)) {
      closeDialog();
      document.removeEventListener('keydown', handler);
    }
  });
});

// ── Run agent ──────────────────────────────────────────────────────────────
document.getElementById('card-run-agent-btn').addEventListener('click', async function() {
  if (!modalCardId) return;
  const col = board.columns.find(c => c.id === modalColId);
  if (!['In Progress', 'Review'].includes(col?.title || '')) {
    showToast('Move card to In Progress or Review to run the agent', 3000, 'error');
    updateRunAgentBtn(col.cards.find(c => c.id === modalCardId));
    return;
  }
  const cardObj = col.cards.find(c => c.id === modalCardId);
  const choice = await vbConfirmRunAgent(cardObj?.title || cardObj?.text || '', board.skip_permissions === undefined ? true : !!board.skip_permissions);
  if (!choice) return;
  this.disabled = true; this.textContent = 'Starting\u2026';
  const toggle = document.getElementById('card-output-toggle');
  const outputPre = document.getElementById('card-output-content');
  outputPre.textContent = '';
  try {
    const resp = await fetch(`/api/cards/${modalCardId}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipPermissions: choice.skipPermissions }),
    });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { const d = await resp.json(); msg = d.error || msg; } catch(_) { msg = await resp.text().catch(() => msg); }
      throw new Error(msg);
    }
    await resp.json();
    this.textContent = 'Running…';
    if (toggle) {
      toggle.style.display = 'inline-block';
      toggle.textContent = 'Show full output';
    }
  } catch(err) {
    this.disabled = false; this.textContent = 'Run agent';
    showToast('Failed to run agent: ' + err.message, 3000, 'error');
  }
});

document.getElementById('card-stop-agent-btn').addEventListener('click', async function() {
  if (!modalCardId) return;
  this.disabled = true; this.textContent = 'Stopping…';
  try {
    const resp = await fetch(`/api/cards/${modalCardId}/stop`, { method: 'POST' });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { const d = await resp.json(); msg = d.error || msg; } catch(_) {}
      throw new Error(msg);
    }
    const col = board.columns.find(c => c.cards?.some(c2 => c2.id === modalCardId));
    const card = col?.cards.find(c => c.id === modalCardId);
    if (card) updateRunAgentBtn(card);
  } catch(err) {
    this.disabled = false; this.textContent = 'Stop agent';
    showToast('Failed to stop agent: ' + err.message, 3000, 'error');
  }
});

// ── Merge ──────────────────────────────────────────────────────────────────
document.getElementById('card-merge-btn').addEventListener('click', async function() {
  if (!modalCardId) return;
  this.disabled = true; this.textContent = 'Merging…';
  try {
    const resp = await fetch(`/api/cards/${modalCardId}/merge`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Merge failed');
    showToast('Merged successfully', 3000, 'success');
    this.disabled = false; this.textContent = 'Merge';
    closeCardModal();
  } catch(err) {
    showToast('Merge failed: ' + err.message, 3000, 'error');
    this.disabled = false; this.textContent = 'Merge';
  }
});

document.getElementById('card-mark-merged-btn').addEventListener('click', async function() {
  if (!modalCardId) return;
  this.disabled = true;
  const originalText = this.textContent;
  this.textContent = 'Marking…';
  try {
    const resp = await fetch(`/api/cards/${modalCardId}/mark-merged`, { method: 'POST' });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(resp.status === 404 ? 'Endpoint not found, restart the server' : (JSON.parse(text).error || text));
    }
    const data = await resp.json();
    const col = board.columns.find(c => c.id === modalColId);
    const card = col?.cards.find(c => c.id === modalCardId);
    if (card) { card.merged_at = new Date().toISOString(); card.worktree_path = null; }
    renderBoard(board);
    openCardModal(modalCardId, modalColId);
    showToast('Marked as merged', 3000, 'success');
  } catch(err) {
    showToast('Failed: ' + err.message, 3000, 'error');
    this.disabled = false;
    this.textContent = originalText;
  }
});

// ── Discard changes ─────────────────────────────────────────────────────────
document.getElementById('card-discard-btn').addEventListener('click', async function() {
  if (!modalCardId) return;
  const col = board.columns.find(c => c.id === modalColId);
  const card = col?.cards.find(c => c.id === modalCardId);
  if (!card) return;
  const ok = await vbConfirm(
    `This will permanently delete branch '${card.branch}' and its worktree. The agent's code changes will be lost. This cannot be undone.`,
    { confirmText: 'Discard changes', danger: true }
  );
  if (!ok) return;
  this.disabled = true;
  this.textContent = 'Discarding\u2026';
  try {
    const resp = await fetch(`/api/cards/${modalCardId}/discard`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Discard failed');
    card.branch = null;
    card.worktree_path = null;
    card.worktreePath = null;
    showChangesSection(card);
    renderBoard(board);
    showToast('Changes discarded', 3000, 'success');
  } catch (err) {
    showToast('Discard failed: ' + err.message, 3000, 'error');
  }
  this.disabled = false;
  this.textContent = 'Discard changes';
});

// ── Create PR ──────────────────────────────────────────────────────────────
document.getElementById('card-pr-btn').addEventListener('click', async function() {
  if (!modalCardId) return;
  this.disabled = true; this.textContent = 'Creating…';
  try {
    const resp = await fetch(`/api/cards/${modalCardId}/pr`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'PR creation failed');
    showToast('PR created: ' + data.url, 3000, 'success');
    if (data.url?.startsWith('http')) window.open(data.url, '_blank');
  } catch(err) {
    showToast('PR failed: ' + err.message, 3000, 'error');
  }
  this.disabled = false; this.textContent = 'Create PR';
});
