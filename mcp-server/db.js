const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function getUserDataDir() {
  let base;
  if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else if (process.platform === 'win32') {
    base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else {
    // Linux / other: follow the XDG Base Directory spec.
    base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
  return path.join(base, 'vibeboard');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const DATA_DIR = getUserDataDir();
if (!process.env.VB_DB_PATH) ensureDir(DATA_DIR);

// Lazy-required to avoid pulling child_process at module load and to keep the
// db<->worktree boundary one-directional (worktree.js never requires db.js).
let _wt = null;
function cleanupWorktree(workspacePath, worktreePath, branch) {
  if (!workspacePath) return;
  if (worktreePath) {
    try {
      if (!_wt) _wt = require('./worktree');
      _wt.removeWorktree(workspacePath, worktreePath);
    } catch (_) { /* best-effort cleanup */ }
  }
  if (branch) {
    try {
      if (!_wt) _wt = require('./worktree');
      _wt.deleteBranch(workspacePath, branch);
    } catch (_) { /* best-effort cleanup */ }
  }
}

const DB_PATH = process.env.VB_DB_PATH || path.join(DATA_DIR, 'vibeboard.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema migrations
db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS columns (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    color TEXT NOT NULL,
    position INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    column_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    agent TEXT,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS card_notes (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS agent_log (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS card_templates (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title_pattern TEXT,
    tags TEXT,
    agent TEXT,
    model TEXT,
    priority TEXT,
    custom_prompt TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_columns_workspace ON columns(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_cards_column ON cards(column_id);
  CREATE INDEX IF NOT EXISTS idx_cards_workspace ON cards(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_cards_created_at ON cards(created_at);
  CREATE INDEX IF NOT EXISTS idx_cards_updated_at ON cards(updated_at);
  CREATE INDEX IF NOT EXISTS idx_card_notes_card ON card_notes(card_id);
  CREATE INDEX IF NOT EXISTS idx_agent_log_workspace ON agent_log(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_card_templates_workspace ON card_templates(workspace_id);
`);

// Column migrations for existing databases — all in one transaction so a
// mid-run failure doesn't leave the schema half-migrated.
(function migrate() {
  const cardCols = db.pragma('table_info(cards)').map(r => r.name);
  const wsCols   = db.pragma('table_info(workspaces)').map(r => r.name);
  const colCols  = db.pragma('table_info(columns)').map(r => r.name);
  const logCols  = db.pragma('table_info(agent_log)').map(r => r.name);

  db.transaction(() => {
    if (!cardCols.includes('branch'))          db.prepare('ALTER TABLE cards ADD COLUMN branch TEXT').run();
    if (!cardCols.includes('worktree_path'))   db.prepare('ALTER TABLE cards ADD COLUMN worktree_path TEXT').run();
    if (!cardCols.includes('requires_review')) db.prepare('ALTER TABLE cards ADD COLUMN requires_review INTEGER DEFAULT 0').run();
    if (!cardCols.includes('priority'))        db.prepare('ALTER TABLE cards ADD COLUMN priority TEXT').run();
    if (!cardCols.includes('custom_prompt'))   db.prepare('ALTER TABLE cards ADD COLUMN custom_prompt TEXT').run();
    if (!cardCols.includes('due_date'))        db.prepare('ALTER TABLE cards ADD COLUMN due_date TEXT').run();
    if (!cardCols.includes('agent_ran_at'))    db.prepare('ALTER TABLE cards ADD COLUMN agent_ran_at TEXT').run();
    if (!cardCols.includes('model'))           db.prepare('ALTER TABLE cards ADD COLUMN model TEXT').run();
    if (!cardCols.includes('last_exit_code'))  db.prepare('ALTER TABLE cards ADD COLUMN last_exit_code INTEGER').run();
    if (!cardCols.includes('last_duration'))   db.prepare('ALTER TABLE cards ADD COLUMN last_duration INTEGER').run();
    if (!cardCols.includes('last_cost'))       db.prepare('ALTER TABLE cards ADD COLUMN last_cost REAL').run();
    if (!cardCols.includes('last_tokens'))     db.prepare('ALTER TABLE cards ADD COLUMN last_tokens INTEGER').run();
    if (!cardCols.includes('blocked_by'))      db.prepare('ALTER TABLE cards ADD COLUMN blocked_by TEXT').run();
    if (!cardCols.includes('merged_at'))       db.prepare('ALTER TABLE cards ADD COLUMN merged_at TEXT').run();
    if (!cardCols.includes('review_agent'))          db.prepare('ALTER TABLE cards ADD COLUMN review_agent TEXT').run();
    if (!cardCols.includes('review_model'))          db.prepare('ALTER TABLE cards ADD COLUMN review_model TEXT').run();
    if (!cardCols.includes('in_progress_base_sha'))  db.prepare('ALTER TABLE cards ADD COLUMN in_progress_base_sha TEXT').run();
    if (!cardCols.includes('review_issue'))           db.prepare('ALTER TABLE cards ADD COLUMN review_issue INTEGER DEFAULT 0').run();
    if (!cardCols.includes('has_branch_changes'))     db.prepare('ALTER TABLE cards ADD COLUMN has_branch_changes INTEGER DEFAULT 0').run();

    if (!wsCols.includes('use_worktree')) db.prepare('ALTER TABLE workspaces ADD COLUMN use_worktree INTEGER DEFAULT 0').run();
    // Default 1 preserves existing behavior for workspaces created before this
    // setting existed (agents ran with permissions skipped unconditionally).
    if (!wsCols.includes('skip_permissions')) db.prepare('ALTER TABLE workspaces ADD COLUMN skip_permissions INTEGER DEFAULT 1').run();

    if (!colCols.includes('wip_limit')) db.prepare('ALTER TABLE columns ADD COLUMN wip_limit INTEGER').run();

    if (!logCols.includes('card_id')) db.prepare('ALTER TABLE agent_log ADD COLUMN card_id TEXT').run();
  })();
})();

function getActiveWorkspaceId() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('active_workspace_id');
  return row ? row.value : null;
}

function setActiveWorkspaceId(id) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('active_workspace_id', id);
}

function listWorkspaces() {
  return db.prepare('SELECT id, name, path, description, use_worktree, skip_permissions FROM workspaces ORDER BY created_at DESC').all();
}

function getWorkspace(id) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
}

function createWorkspace(name, wsPath, description = '', useWorktree = 0, skipPermissions = 1) {
  const { validateWorkspacePath } = require('./path-guard');
  validateWorkspacePath(wsPath);
  const id = 'ws-' + crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO workspaces (id, name, path, description, use_worktree, skip_permissions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, wsPath, description, useWorktree ? 1 : 0, skipPermissions ? 1 : 0, now, now);
  
  const defaultColumns = [
    { id: 'col-' + crypto.randomUUID(), title: 'Backlog', color: '#6b6860', position: 0 },
    { id: 'col-' + crypto.randomUUID(), title: 'In Progress', color: '#2563eb', position: 1 },
    { id: 'col-' + crypto.randomUUID(), title: 'Review', color: '#d97706', position: 2 },
    { id: 'col-' + crypto.randomUUID(), title: 'Done', color: '#16a34a', position: 3 },
  ];
  
  const insertCol = db.prepare('INSERT INTO columns (id, workspace_id, title, color, position) VALUES (?, ?, ?, ?, ?)');
  for (const col of defaultColumns) {
    insertCol.run(col.id, id, col.title, col.color, col.position);
  }
  
  return { id, name, path: wsPath, description };
}

function updateWorkspace(id, updates) {
  const fields = [];
  const values = [];

  if (updates.name !== undefined)         { fields.push('name = ?');         values.push(updates.name); }
  if (updates.path !== undefined) {
    const { validateWorkspacePath } = require('./path-guard');
    validateWorkspacePath(updates.path);
    fields.push('path = ?'); values.push(updates.path);
  }
  if (updates.description !== undefined)  { fields.push('description = ?');  values.push(updates.description); }
  if (updates.use_worktree !== undefined) { fields.push('use_worktree = ?'); values.push(updates.use_worktree ? 1 : 0); }
  if (updates.skip_permissions !== undefined) { fields.push('skip_permissions = ?'); values.push(updates.skip_permissions ? 1 : 0); }

  if (fields.length === 0) return;
  
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  
  db.prepare(`UPDATE workspaces SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function deleteWorkspace(id) {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  if (!ws) return false;

  const worktrees = db.prepare('SELECT worktree_path FROM cards WHERE workspace_id = ? AND worktree_path IS NOT NULL').all(id);

  const del = db.transaction(() => {
    db.prepare('DELETE FROM card_notes WHERE card_id IN (SELECT id FROM cards WHERE workspace_id = ?)').run(id);
    db.prepare('DELETE FROM agent_log WHERE workspace_id = ?').run(id);
    db.prepare('DELETE FROM cards WHERE workspace_id = ?').run(id);
    db.prepare('DELETE FROM columns WHERE workspace_id = ?').run(id);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  });

  del();

  if (ws.path) for (const row of worktrees) cleanupWorktree(ws.path, row.worktree_path);

  return true;
}

function getBoard(workspaceId) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return null;
  
  const columns = db.prepare(`
    SELECT id, title, color, position, wip_limit FROM columns
    WHERE workspace_id = ?
    ORDER BY position
  `).all(workspaceId);
  
  const cards = db.prepare(`
    SELECT id, column_id, title, description, tags, agent, model, branch, worktree_path, requires_review, priority, custom_prompt, due_date, agent_ran_at, last_exit_code, last_duration, last_cost, last_tokens, blocked_by, merged_at, review_agent, review_model, review_issue, has_branch_changes, in_progress_base_sha, position, created_at
    FROM cards
    WHERE workspace_id = ?
    ORDER BY position
  `).all(workspaceId);
  
  const agentLog = db.prepare(`
    SELECT id, timestamp, agent, action, detail, card_id as cardId
    FROM agent_log
    WHERE workspace_id = ?
    ORDER BY timestamp DESC
  `).all(workspaceId);
  
  const columnsWithCards = columns.map(col => ({
    ...col,
    cards: cards
      .filter(c => c.column_id === col.id)
      .map(c => ({
        ...c,
        tags: c.tags ? JSON.parse(c.tags) : [],
        createdAt: c.created_at,
        worktreePath: c.worktree_path,
        requires_review: !!c.requires_review,
        priority: c.priority || null,
        custom_prompt: c.custom_prompt || '',
        due_date: c.due_date || null,
        agent_ran_at: c.agent_ran_at || null,
        model: c.model || null,
        last_exit_code: c.last_exit_code,
        last_duration: c.last_duration,
        last_cost: c.last_cost,
        last_tokens: c.last_tokens,
        merged_at: c.merged_at || null,
        blocked_by: c.blocked_by ? JSON.parse(c.blocked_by) : [],
        review_agent: c.review_agent || null,
        review_model: c.review_model || null,
        review_issue: !!c.review_issue,
        has_branch_changes: !!c.has_branch_changes,
        in_progress_base_sha: c.in_progress_base_sha || null,
      }))
  }));
  
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    description: workspace.description,
    use_worktree: workspace.use_worktree || 0,
    skip_permissions: workspace.skip_permissions === undefined ? 1 : (workspace.skip_permissions || 0),
    columns: columnsWithCards,
    agentLog,
  };
}

function createCard(workspaceId, columnId, title, options = {}) {
  const id = 'card-' + crypto.randomUUID();
  const now = new Date().toISOString();
  const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM cards WHERE column_id = ?').get(columnId).pos;
  // Default review OFF unless explicitly enabled, matching the new-card UI
  // (`#nc-needs-review` is unchecked by default). The card-sidebar toggle
  // shows up checked for legacy cards but new cards now consistently start
  // with requires_review = 0 across all entry points (UI, MCP, sync).
  const requiresReview = options.requires_review === true ? 1 : 0;
  const priority = options.priority || null;
  const customPrompt = options.custom_prompt || null;
  const dueDate = options.due_date || null;
  const model = options.model || null;
  const blockedByArr = Array.isArray(options.blocked_by) && options.blocked_by.length ? options.blocked_by : [];
  if (blockedByArr.length) {
    const { wouldCreateCycle } = require('./cycle-detection');
    const allCards = db.prepare('SELECT id, blocked_by FROM cards WHERE workspace_id = ?').all(workspaceId);
    const parsed = allCards.map(c => ({ id: c.id, blocked_by: c.blocked_by ? JSON.parse(c.blocked_by) : [] }));
    const cyclePath = wouldCreateCycle(id, blockedByArr, parsed);
    if (cyclePath) throw new Error(`Cyclic dependency detected, cycle: [${cyclePath.join(', ')}]`);
  }
  const blockedBy = blockedByArr.length ? JSON.stringify(blockedByArr) : null;
  const mergedAt = options.merged_at || null;
  const reviewAgent = options.review_agent || null;
  const reviewModel = options.review_model || null;

  db.prepare(`
    INSERT INTO cards (id, column_id, workspace_id, title, description, tags, agent, model, requires_review, priority, custom_prompt, due_date, merged_at, blocked_by, review_agent, review_model, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, columnId, workspaceId, title,
    options.description || null,
    options.tags ? JSON.stringify(options.tags) : null,
    options.agent || null,
    model,
    requiresReview,
    priority, customPrompt, dueDate, mergedAt, blockedBy, reviewAgent, reviewModel,
    position, now, now
  );

  return { id, title, tags: options.tags || [], requires_review: requiresReview !== 0, priority, custom_prompt: customPrompt || '', due_date: dueDate, model, merged_at: mergedAt, blocked_by: options.blocked_by || [], review_agent: reviewAgent, review_model: reviewModel, createdAt: now, ...options };
}

function updateCard(cardId, updates) {
  const fields = [];
  const values = [];
  
  if (updates.title !== undefined)           { fields.push('title = ?');           values.push(updates.title); }
  if (updates.description !== undefined)     { fields.push('description = ?');      values.push(updates.description || null); }
  if (updates.tags !== undefined)            { fields.push('tags = ?');             values.push(JSON.stringify(updates.tags)); }
  if (updates.agent !== undefined)           { fields.push('agent = ?');            values.push(updates.agent || null); }
  if (updates.model !== undefined)           { fields.push('model = ?');            values.push(updates.model || null); }
  if (updates.branch !== undefined)          { fields.push('branch = ?');           values.push(updates.branch || null); }
  if (updates.worktreePath !== undefined)    { fields.push('worktree_path = ?');    values.push(updates.worktreePath || null); }
  if (updates.requires_review !== undefined) { fields.push('requires_review = ?'); values.push(updates.requires_review ? 1 : 0); }
  if (updates.priority !== undefined)        { fields.push('priority = ?');        values.push(updates.priority || null); }
  if (updates.custom_prompt !== undefined)   { fields.push('custom_prompt = ?');   values.push(updates.custom_prompt || null); }
  if (updates.due_date !== undefined)        { fields.push('due_date = ?');        values.push(updates.due_date || null); }
  if (updates.agent_ran_at !== undefined)   { fields.push('agent_ran_at = ?');   values.push(updates.agent_ran_at || null); }
  if (updates.last_exit_code !== undefined) { fields.push('last_exit_code = ?'); values.push(updates.last_exit_code); }
  if (updates.last_duration !== undefined)  { fields.push('last_duration = ?');  values.push(updates.last_duration); }
  if (updates.last_cost !== undefined)      { fields.push('last_cost = ?');      values.push(updates.last_cost); }
  if (updates.last_tokens !== undefined)    { fields.push('last_tokens = ?');    values.push(updates.last_tokens); }
  if (updates.blocked_by !== undefined) {
    const cardData = db.prepare('SELECT workspace_id FROM cards WHERE id = ?').get(cardId);
    if (cardData) {
      const { wouldCreateCycle } = require('./cycle-detection');
      const allCards = db.prepare('SELECT id, blocked_by FROM cards WHERE workspace_id = ?').all(cardData.workspace_id);
      const parsed = allCards.map(c => ({ id: c.id, blocked_by: c.blocked_by ? JSON.parse(c.blocked_by) : [] }));
      const newBlockedBy = Array.isArray(updates.blocked_by) ? updates.blocked_by : [];
      const cyclePath = wouldCreateCycle(cardId, newBlockedBy, parsed);
      if (cyclePath) throw new Error(`Cyclic dependency detected, cycle: [${cyclePath.join(', ')}]`);
    }
    fields.push('blocked_by = ?');
    values.push(Array.isArray(updates.blocked_by) && updates.blocked_by.length ? JSON.stringify(updates.blocked_by) : null);
  }
  if (updates.merged_at !== undefined)     { fields.push('merged_at = ?');     values.push(updates.merged_at || null); }
  if (updates.review_agent !== undefined)  { fields.push('review_agent = ?');  values.push(updates.review_agent || null); }
  if (updates.review_model !== undefined)  { fields.push('review_model = ?');  values.push(updates.review_model || null); }
  if (updates.review_issue !== undefined)       { fields.push('review_issue = ?');        values.push(updates.review_issue ? 1 : 0); }
  if (updates.has_branch_changes !== undefined) { fields.push('has_branch_changes = ?');   values.push(updates.has_branch_changes ? 1 : 0); }

  if (fields.length === 0) return;
  
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(cardId);
  
  db.prepare(`UPDATE cards SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function moveCard(cardId, toColumnId) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return null;

  const toColumn = db.prepare('SELECT workspace_id FROM columns WHERE id = ?').get(toColumnId);
  if (!toColumn) throw new Error('Destination column not found');
  if (toColumn.workspace_id !== card.workspace_id) {
    throw new Error('Cannot move card to a column in a different workspace');
  }

  const fromColumnId = card.column_id;

  const fromColumn = db.prepare('SELECT title FROM columns WHERE id = ?').get(fromColumnId);

  return db.transaction(() => {
    db.prepare('UPDATE cards SET position = position - 1 WHERE column_id = ? AND position > ?').run(fromColumnId, card.position);
    const newPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 as pos FROM cards WHERE column_id = ?').get(toColumnId).pos;
    const now = new Date().toISOString();
    db.prepare('UPDATE cards SET column_id = ?, position = ?, updated_at = ? WHERE id = ?')
      .run(toColumnId, newPosition, now, cardId);
    // Clear review_issue when card leaves Review
    if (fromColumn?.title === 'Review' && card.review_issue) {
      db.prepare('UPDATE cards SET review_issue = 0, updated_at = ? WHERE id = ?').run(now, cardId);
    }
    return { cardId, fromColumnId, toColumnId };
  })();
}


function deleteCard(cardId) {
  const card = db.prepare('SELECT column_id, position, worktree_path, workspace_id, branch FROM cards WHERE id = ?').get(cardId);
  if (!card) return false;

  db.transaction(() => {
    // Rebalance sibling positions before removing the card so a failed DELETE
    // doesn't leave a permanent gap in the column order.
    db.prepare('UPDATE cards SET position = position - 1 WHERE column_id = ? AND position > ?').run(card.column_id, card.position);
    db.prepare('DELETE FROM cards WHERE id = ?').run(cardId);
  })();

  if (card.branch || card.worktree_path) {
    const ws = getWorkspace(card.workspace_id);
    cleanupWorktree(ws?.path, card.worktree_path, card.branch);
  }

  return true;
}

function addCardNote(cardId, content) {
  const id = 'note-' + crypto.randomUUID();
  const now = new Date().toISOString();
  
  db.prepare('INSERT INTO card_notes (id, card_id, content, created_at) VALUES (?, ?, ?, ?)')
    .run(id, cardId, content, now);
  
  return { id, cardId, content, createdAt: now };
}

function getCardNotes(cardId) {
  return db.prepare('SELECT id, content, created_at as createdAt FROM card_notes WHERE card_id = ? ORDER BY created_at')
    .all(cardId);
}

function addAgentLog(workspaceId, agent, action, detail, cardId = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare('INSERT INTO agent_log (id, workspace_id, timestamp, agent, action, detail, card_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, workspaceId, now, agent, action, detail, cardId);

  const logLimit = parseInt(process.env.VB_LOG_LIMIT || '', 10) || 500;
  db.prepare(`
    DELETE FROM agent_log WHERE workspace_id = ? AND id NOT IN (
      SELECT id FROM agent_log WHERE workspace_id = ? ORDER BY timestamp DESC LIMIT ?
    )
  `).run(workspaceId, workspaceId, logLimit);

  return { id, timestamp: now, agent, action, detail, cardId };
}

function clearLog(workspaceId) {
  db.prepare('DELETE FROM agent_log WHERE workspace_id = ?').run(workspaceId);
}

// Serialize concurrent syncBoard calls so two simultaneous POST /board requests
// from different tabs can't read stale state and overwrite each other's changes.
let _syncBoardTail = Promise.resolve();

function syncBoard(workspaceId, columns) {
  const result = _syncBoardTail.then(() => _syncBoardImpl(workspaceId, columns));
  // Swallow errors on the chain tail so a failed sync doesn't permanently jam the queue.
  _syncBoardTail = result.catch(() => {});
  return result;
}

function _syncBoardImpl(workspaceId, columns) {
  const { findCycleIds } = require('./cycle-detection');
  const incomingCards = columns.flatMap(c => (c.cards || []).map(card => ({
    id: card.id,
    blocked_by: Array.isArray(card.blocked_by) ? card.blocked_by : [],
  })));
  const cycleIds = findCycleIds(incomingCards);
  if (cycleIds.length) {
    throw new Error(`Cyclic dependency detected, cards in cycle: [${cycleIds.join(', ')}]`);
  }

  const existingRows = db.prepare('SELECT id, worktree_path, branch FROM cards WHERE workspace_id = ?').all(workspaceId);
  const existingCards = existingRows.map(r => r.id);
  const incomingCardIds = columns.flatMap(c => (c.cards || []).map(card => card.id));
  const removedWorktrees = existingRows.filter(r => (r.worktree_path || r.branch) && !incomingCardIds.includes(r.id));
  const removedCardIds = existingCards.filter(id => !incomingCardIds.includes(id));

  // Stop running agents for cards about to be deleted so they don't orphan.
  if (removedCardIds.length) {
    let ar = null;
    try { ar = require('./agent-routing'); } catch (_) {}
    if (ar) for (const id of removedCardIds) ar.routeStopAgent(id);
  }

  const sync = db.transaction(() => {
    // Update existing columns only (no create/delete — columns are fixed)
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci];
      const wipLimit = Number.isInteger(col.wip_limit) && col.wip_limit > 0 ? col.wip_limit : null;
      db.prepare('UPDATE columns SET title = ?, color = ?, position = ?, wip_limit = ? WHERE id = ? AND workspace_id = ?')
        .run(col.title, col.color || '#6b6860', ci, wipLimit, col.id, workspaceId);

      for (let ki = 0; ki < (col.cards || []).length; ki++) {
        const card = col.cards[ki];
        const now  = new Date().toISOString();
        const tags = JSON.stringify(card.tags || []);
        const rr = card.requires_review !== false ? 1 : 0;
        const priority = card.priority || null;
        const customPrompt = card.custom_prompt || null;
        const dueDate = card.due_date || null;
        const model = card.model || null;
        const blockedBy = Array.isArray(card.blocked_by) && card.blocked_by.length ? JSON.stringify(card.blocked_by) : null;
        const reviewAgent = card.review_agent || null;
        const reviewModel = card.review_model || null;
        if (existingCards.includes(card.id)) {
          db.prepare('UPDATE cards SET column_id=?, title=?, description=?, tags=?, agent=?, model=?, requires_review=?, priority=?, custom_prompt=?, due_date=?, blocked_by=?, review_agent=?, review_model=?, position=?, updated_at=? WHERE id=?')
            .run(col.id, card.title, card.description || null, tags, card.agent || null, model, rr, priority, customPrompt, dueDate, blockedBy, reviewAgent, reviewModel, ki, now, card.id);
        } else {
          const mergedAt = card.merged_at || null;
          db.prepare('INSERT INTO cards (id, column_id, workspace_id, title, description, tags, agent, model, requires_review, priority, custom_prompt, due_date, merged_at, blocked_by, review_agent, review_model, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(card.id, col.id, workspaceId, card.title, card.description || null, tags, card.agent || null, model, rr, priority, customPrompt, dueDate, mergedAt, blockedBy, reviewAgent, reviewModel, ki, now, now);
        }
      }
    }

    // Remove deleted cards
    for (const id of existingCards) {
      if (!incomingCardIds.includes(id))
        db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    }
  });

  sync();

  // Remove orphaned git worktrees and local branches outside the transaction (git calls aren't db ops).
  if (removedWorktrees.length) {
    const ws = getWorkspace(workspaceId);
    if (ws?.path) for (const row of removedWorktrees) cleanupWorktree(ws.path, row.worktree_path, row.branch);
  }
}

function getCard(cardId) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return null;
  
  return {
    ...card,
    tags: card.tags ? JSON.parse(card.tags) : [],
    createdAt: card.created_at,
    requires_review: !!card.requires_review,
    priority: card.priority || null,
    custom_prompt: card.custom_prompt || '',
    due_date: card.due_date || null,
    agent_ran_at: card.agent_ran_at || null,
    model: card.model || null,
    last_exit_code: card.last_exit_code,
    last_duration: card.last_duration,
    last_cost: card.last_cost,
    last_tokens: card.last_tokens,
    merged_at: card.merged_at || null,
    blocked_by: card.blocked_by ? JSON.parse(card.blocked_by) : [],
    review_agent: card.review_agent || null,
    review_model: card.review_model || null,
  };
}

function getColumn(columnId) {
  return db.prepare('SELECT * FROM columns WHERE id = ?').get(columnId);
}

function searchCards(workspaceId, filters = {}) {
  const { query, tag, column, agent, status, limit, offset } = filters;
  const conditions = ['c.workspace_id = ?'];
  const params = [workspaceId];

  if (query) {
    conditions.push('(c.title LIKE ? OR c.description LIKE ? OR EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value LIKE ?))');
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  if (tag) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?)");
    params.push(tag);
  }

  if (column) {
    conditions.push('col.title = ?');
    params.push(column);
  }

  if (agent) {
    conditions.push('c.agent = ?');
    params.push(agent);
  }

  if (status) {
    const statusMap = {
      'has_branch': 'c.branch IS NOT NULL',
      'unmerged': 'c.merged_at IS NULL',
      'blocked': 'c.blocked_by IS NOT NULL',
    };
    if (statusMap[status]) {
      conditions.push(statusMap[status]);
    }
  }

  const countSql = `SELECT COUNT(*) as total FROM cards c JOIN columns col ON c.column_id = col.id WHERE ${conditions.join(' AND ')}`;
  const total = db.prepare(countSql).get(...params).total;

  const sql = `SELECT c.*, col.title as column_title FROM cards c JOIN columns col ON c.column_id = col.id WHERE ${conditions.join(' AND ')} ORDER BY c.position LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit || 50, offset || 0);

  return {
    total,
    cards: rows.map(c => ({
      id: c.id,
      column_id: c.column_id,
      column_title: c.column_title,
      workspace_id: c.workspace_id,
      title: c.title,
      description: c.description,
      tags: c.tags ? JSON.parse(c.tags) : [],
      agent: c.agent,
      model: c.model,
      branch: c.branch,
      worktreePath: c.worktree_path,
      requires_review: !!c.requires_review,
      priority: c.priority || null,
      custom_prompt: c.custom_prompt || '',
      due_date: c.due_date || null,
      agent_ran_at: c.agent_ran_at || null,
      last_exit_code: c.last_exit_code,
      last_duration: c.last_duration,
      last_cost: c.last_cost,
      last_tokens: c.last_tokens,
      blocked_by: c.blocked_by ? JSON.parse(c.blocked_by) : [],
      merged_at: c.merged_at || null,
      review_agent: c.review_agent || null,
      review_model: c.review_model || null,
      position: c.position,
      createdAt: c.created_at,
    }))
  };
}

function exportWorkspace(workspaceId) {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return null;
  const columns = db.prepare('SELECT * FROM columns WHERE workspace_id = ? ORDER BY position').all(workspaceId);
  const cards = db.prepare('SELECT * FROM cards WHERE workspace_id = ? ORDER BY position').all(workspaceId);
  const notes = db.prepare('SELECT * FROM card_notes WHERE card_id IN (SELECT id FROM cards WHERE workspace_id = ?) ORDER BY created_at').all(workspaceId);
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    workspace: { name: workspace.name, path: workspace.path, description: workspace.description, use_worktree: workspace.use_worktree, skip_permissions: workspace.skip_permissions === undefined ? 1 : workspace.skip_permissions },
    columns: columns.map(col => ({
      title: col.title, color: col.color, position: col.position, wip_limit: col.wip_limit,
      cards: cards.filter(c => c.column_id === col.id).map(c => ({
        title: c.title, description: c.description,
        tags: c.tags ? JSON.parse(c.tags) : [],
        agent: c.agent, model: c.model, priority: c.priority,
        custom_prompt: c.custom_prompt, due_date: c.due_date,
        merged_at: c.merged_at || null,
        requires_review: !!c.requires_review,
        notes: notes.filter(n => n.card_id === c.id).map(n => ({ content: n.content, created_at: n.created_at })),
      })),
    })),
  };
}

function importWorkspace(data) {
  if (!data?.workspace || !Array.isArray(data.columns)) throw new Error('Invalid export format');
  const ws = createWorkspace(data.workspace.name || 'Imported', data.workspace.path || '', data.workspace.description || '', data.workspace.use_worktree || 0, data.workspace.skip_permissions === undefined ? 1 : data.workspace.skip_permissions);
  const existingCols = db.prepare('SELECT * FROM columns WHERE workspace_id = ? ORDER BY position').all(ws.id);
  const colMap = {};
  existingCols.forEach(col => { colMap[col.title] = col.id; });
  for (const colData of data.columns) {
    const colId = colMap[colData.title];
    if (!colId) continue;
    if (Number.isInteger(colData.wip_limit) && colData.wip_limit > 0) {
      db.prepare('UPDATE columns SET wip_limit = ? WHERE id = ?').run(colData.wip_limit, colId);
    }
    for (const cardData of (colData.cards || [])) {
      const card = createCard(ws.id, colId, cardData.title || 'Untitled', {
        description: cardData.description, tags: cardData.tags,
        agent: cardData.agent, model: cardData.model, priority: cardData.priority,
        custom_prompt: cardData.custom_prompt, due_date: cardData.due_date,
        merged_at: cardData.merged_at || null,
        requires_review: cardData.requires_review,
      });
      for (const note of (cardData.notes || [])) {
        addCardNote(card.id, note.content);
      }
    }
  }
  return ws;
}

function listCards(workspaceId, filters = {}) {
  const { column, tag, agent, limit, offset } = filters;
  const conditions = ['c.workspace_id = ?'];
  const params = [workspaceId];

  if (column) {
    conditions.push('col.title = ?');
    params.push(column);
  }

  if (tag) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?)");
    params.push(tag);
  }

  if (agent) {
    conditions.push('c.agent = ?');
    params.push(agent);
  }

  const countSql = `SELECT COUNT(*) as total FROM cards c JOIN columns col ON c.column_id = col.id WHERE ${conditions.join(' AND ')}`;
  const total = db.prepare(countSql).get(...params).total;

  const sql = `SELECT c.id, c.title, col.title as column_title, c.priority, c.agent, c.tags, c.due_date FROM cards c JOIN columns col ON c.column_id = col.id WHERE ${conditions.join(' AND ')} ORDER BY c.position LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit || 50, offset || 0);

  return {
    total,
    cards: rows.map(c => ({
      id: c.id,
      title: c.title,
      column: c.column_title,
      priority: c.priority || null,
      agent: c.agent || null,
      tags: c.tags ? JSON.parse(c.tags) : [],
      due_date: c.due_date || null,
    }))
  };
}

function getAgentStatus(cardId) {
  const { isAgentRunning, isQueued, getQueuedCardIds } = require('./agent');
  const card = getCard(cardId);
  if (!card) return { error: 'Card not found' };

  const running = isAgentRunning(cardId);
  const queued = isQueued(cardId);
  const notes = db.prepare('SELECT content, created_at FROM card_notes WHERE card_id = ? ORDER BY created_at DESC LIMIT 1').get(cardId);
  
  return {
    cardId,
    running,
    queued,
    lastNote: notes ? notes.content : null,
    lastNoteAt: notes ? notes.created_at : null,
    lastExitCode: card.last_exit_code,
    lastDuration: card.last_duration,
    lastCost: card.last_cost,
    lastTokens: card.last_tokens,
    agentRanAt: card.agent_ran_at,
  };
}

function createTemplate(workspaceId, name, options = {}) {
  const id = 'tpl-' + crypto.randomUUID();
  const now = new Date().toISOString();
  
  db.prepare(`
    INSERT INTO card_templates (id, workspace_id, name, title_pattern, tags, agent, model, priority, custom_prompt, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, workspaceId, name,
    options.title_pattern || null,
    options.tags ? JSON.stringify(options.tags) : null,
    options.agent || null,
    options.model || null,
    options.priority || null,
    options.custom_prompt || null,
    now
  );
  
  return { id, name, ...options, createdAt: now };
}

function listTemplates(workspaceId) {
  const rows = db.prepare('SELECT * FROM card_templates WHERE workspace_id = ? ORDER BY created_at').all(workspaceId);
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    title_pattern: r.title_pattern,
    tags: r.tags ? JSON.parse(r.tags) : [],
    agent: r.agent,
    model: r.model,
    priority: r.priority,
    custom_prompt: r.custom_prompt,
    createdAt: r.created_at,
  }));
}

function getTemplate(templateId) {
  const row = db.prepare('SELECT * FROM card_templates WHERE id = ?').get(templateId);
  if (!row) return null;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    title_pattern: row.title_pattern,
    tags: row.tags ? JSON.parse(row.tags) : [],
    agent: row.agent,
    model: row.model,
    priority: row.priority,
    custom_prompt: row.custom_prompt,
    createdAt: row.created_at,
  };
}

function updateTemplate(templateId, updates) {
  const fields = [];
  const values = [];
  
  if (updates.name !== undefined)          { fields.push('name = ?');          values.push(updates.name); }
  if (updates.title_pattern !== undefined) { fields.push('title_pattern = ?'); values.push(updates.title_pattern || null); }
  if (updates.tags !== undefined)          { fields.push('tags = ?');          values.push(updates.tags ? JSON.stringify(updates.tags) : null); }
  if (updates.agent !== undefined)         { fields.push('agent = ?');         values.push(updates.agent || null); }
  if (updates.model !== undefined)         { fields.push('model = ?');         values.push(updates.model || null); }
  if (updates.priority !== undefined)      { fields.push('priority = ?');      values.push(updates.priority || null); }
  if (updates.custom_prompt !== undefined) { fields.push('custom_prompt = ?'); values.push(updates.custom_prompt || null); }
  
  if (fields.length === 0) return;
  
  values.push(templateId);
  db.prepare(`UPDATE card_templates SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function deleteTemplate(templateId) {
  const result = db.prepare('DELETE FROM card_templates WHERE id = ?').run(templateId);
  return result.changes > 0;
}

module.exports = {
  db,
  DATA_DIR,
  getUserDataDir,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  getBoard,
  createCard,
  updateCard,
  moveCard,
  deleteCard,

  addCardNote,
  getCardNotes,
  addAgentLog,
  clearLog,
  syncBoard,
  getCard,
  getColumn,
  searchCards,
  exportWorkspace,
  importWorkspace,
  listCards,
  getAgentStatus,
  
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
};
