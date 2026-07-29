const { spawn } = require('child_process');
const express = require('express');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const wt = require('./worktree');
const { PUBLIC_DIR, VERSION } = require('./config');
const { sseClients, emitSSE, broadcast } = require('./events');
const { authMiddleware, rotateToken, getAuthToken, NETWORK_MODE } = require('./auth');
const { getAgentMcpConfigs, isAgentInstalled, readAgentMcpStatus } = require('./mcp-config');
const { refreshAvailableModels, getAvailableModels } = require('./models');
const {
  agentDone, spawnAgent, scheduleSpawn, cancelScheduledSpawn, stopAgent,
  isAgentRunning, isAgentActive,
  getRunningCardIds, getQueuedCardIds, getPendingRespawnCardIds, getOutputFile,
} = require('./agent');

// Register every HTTP/REST + SSE endpoint on the given Express app. /health is
// mounted before the auth gate so it stays reachable without a token.
module.exports = function registerRoutes(app) {
  app.get('/health', (_req, res) => res.json({ status: 'ok', version: VERSION }));

  app.use(authMiddleware);

  // Serve static UI assets (styles.css, js/*.js) behind the auth gate. index.html
  // is served explicitly below so the root path stays an exact, intentional route.
  app.use(express.static(PUBLIC_DIR, { index: false }));

  app.get('/workspaces', (_req, res) => {
    const active = db.getActiveWorkspaceId();
    const list = db.listWorkspaces().map(w => ({ ...w, active: w.id === active }));
    res.json(list);
  });

  app.post('/workspaces', (req, res) => {
    const { name = '', path: wsPath = '', description = '', use_worktree = 0, skip_permissions = 1 } = req.body;
    let ws;
    try { ws = db.createWorkspace(name, wsPath, description, use_worktree, skip_permissions); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    if (!db.getActiveWorkspaceId()) {
      db.setActiveWorkspaceId(ws.id);
      emitSSE('workspace_switch', { board: db.getBoard(ws.id), workspaceId: ws.id });
    }
    const active = db.getActiveWorkspaceId();
    emitSSE('workspace_list', db.listWorkspaces().map(w => ({ ...w, active: w.id === active })));
    res.json(ws);
  });

  app.post('/workspaces/:id/switch', (req, res) => {
    const { id } = req.params;
    const ws = db.getWorkspace(id);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    db.setActiveWorkspaceId(id);
    const board = db.getBoard(id);
    emitSSE('workspace_switch', { board, workspaceId: id });
    res.json({ ok: true, workspaceId: id });
  });

  app.patch('/workspaces/:id', (req, res) => {
    const { id } = req.params;
    const ws = db.getWorkspace(id);
    if (!ws) return res.status(404).json({ error: 'Not found' });
    try {
      db.updateWorkspace(id, req.body);
      const active = db.getActiveWorkspaceId();
      emitSSE('workspace_list', db.listWorkspaces().map(w => ({ ...w, active: w.id === active })));
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/workspaces/:id', (req, res) => {
    const { id } = req.params;
    const list = db.listWorkspaces();
    if (list.length <= 1) return res.status(400).json({ error: 'Cannot delete the only workspace' });
    if (!db.deleteWorkspace(id)) return res.status(404).json({ error: 'Not found' });

    if (db.getActiveWorkspaceId() === id) {
      const next = list.find(w => w.id !== id);
      if (next) {
        db.setActiveWorkspaceId(next.id);
      } else {
        db.db.prepare('DELETE FROM settings WHERE key = ?').run('active_workspace_id');
      }
    }

    const active = db.getActiveWorkspaceId();
    const newList = db.listWorkspaces().map(w => ({ ...w, active: w.id === active }));
    emitSSE('workspace_switch', { board: active ? db.getBoard(active) : null, workspaceId: active });
    emitSSE('workspace_list', newList);
    res.json({ ok: true });
  });

  app.get('/api/git-status', (req, res) => {
    const { path: wsPath } = req.query;
    if (!wsPath) return res.status(400).json({ error: 'path required' });
    const { execSync } = require('child_process');
    try {
      execSync('git rev-parse --git-dir', { cwd: wsPath, stdio: 'ignore' });
      let branch = '';
      try {
        branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: wsPath, stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
      } catch(_) {}
      res.json({ isGit: true, branch });
    } catch(_) {
      res.json({ isGit: false, branch: null });
    }
  });

  app.post('/api/git-init', (req, res) => {
    const { path: wsPath } = req.body || {};
    if (!wsPath) return res.status(400).json({ error: 'path required' });
    const { execSync } = require('child_process');
    try {
      execSync('git init', { cwd: wsPath, stdio: 'ignore' });
      let branch = 'main';
      try {
        branch = execSync('git symbolic-ref --short HEAD', {
          cwd: wsPath, stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim() || 'main';
      } catch(_) {}
      res.json({ ok: true, branch });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/folder-dialog', (_req, res) => {
    if (process.platform === 'darwin') {
      const child = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select project folder:")'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => out += d);
      child.on('close', () => {
        const p = out.trim().replace(/[/\\]+$/, '');
        res.json(p ? { path: p } : { path: null, cancelled: true });
      });
    } else {
      const tmpdir = process.env.TEMP || 'C:\\Windows\\Temp';
      const psPath = path.join(tmpdir, `folder-dialog-${Date.now()}.ps1`);
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.Form',
        '$f.StartPosition = "CenterScreen"',
        '$f.WindowState = "Minimized"',
        '$f.ShowInTaskbar = $false',
        '$f.TopMost = $true',
        '$f.Show()',
        '$f.TopMost = $false',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        '$d.ValidateNames = $false',
        '$d.CheckFileExists = $false',
        '$d.CheckPathExists = $true',
        "$d.FileName = 'Folder Selection'",
        "$d.Filter = 'Folders|*.none'",
        "$d.Title = 'Select project folder'",
        "if ($d.ShowDialog($f) -eq 'OK') {",
        '  Split-Path $d.FileName',
        '}',
        '$f.Close()',
      ].join('\n');
      fs.writeFileSync(psPath, psScript, 'utf8');
      const child = spawn('powershell', [
        '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', psPath
      ], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', d => out += d);
      child.stderr.on('data', d => err += d);
      child.on('close', () => {
        try { fs.unlinkSync(psPath); } catch(_) {}
        if (err) process.stderr.write('folder-dialog: ' + err + '\n');
        const p = out.trim().replace(/[/\\]+$/, '');
        res.json(p ? { path: p } : { path: null, cancelled: true });
      });
    }
  });

  app.post('/api/agent-done/:cardId', (req, res) => {
    const { cardId } = req.params;
    const code = parseInt(req.body?.code ?? 0, 10);
    agentDone(cardId, code, emitSSE);
    res.json({ ok: true });
  });

  app.post('/api/cards/:cardId/note', (req, res) => {
    const card = db.getCard(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const note = db.addCardNote(card.id, req.body?.content || '');
    db.addAgentLog(card.workspace_id, card.agent || 'system', 'add_note', `Added note to '${card.title}'`, card.id);
    emitSSE('board_update', db.getBoard(card.workspace_id));
    res.json(note);
  });

  app.post('/api/cards/:cardId/move', (req, res) => {
    const card = db.getCard(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const { toColumnTitle } = req.body || {};
    const board = db.getBoard(card.workspace_id);
    const toColumn = board?.columns.find(c => c.title === toColumnTitle);
    if (!toColumn) return res.status(404).json({ error: `Column not found: ${toColumnTitle}` });
    db.moveCard(card.id, toColumn.id);
    db.addAgentLog(card.workspace_id, card.agent || 'system', 'move_card', `Moved '${card.title}' → ${toColumnTitle}`, card.id);
    emitSSE('board_update', db.getBoard(card.workspace_id));
    res.json({ ok: true });
  });

  app.post('/api/cards/:cardId/complete', (req, res) => {
    const card = db.getCard(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const board = db.getBoard(card.workspace_id);
    const doneColumn = board?.columns.find(c => c.title === 'Done');
    if (!doneColumn) return res.status(404).json({ error: 'Done column not found' });
    db.moveCard(card.id, doneColumn.id);
    db.addAgentLog(card.workspace_id, card.agent || 'system', 'complete_card', `Completed '${card.title}'`, card.id);
    emitSSE('board_update', db.getBoard(card.workspace_id));
    emitSSE('trigger', { card, toColumn: 'Done' });
    res.json({ ok: true });
  });

  app.post('/api/cards/:cardId/run', (req, res) => {
    const { cardId } = req.params;
    const card = db.getCard(cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    if (!card.agent) return res.status(400).json({ error: 'Card has no assigned agent' });
    if (isAgentActive(cardId)) return res.status(409).json({ error: 'Agent already running or queued' });
    // skipPermissions is optional: the UI asks the user on every manual
    // move-to-In-Progress/Review and forwards their per-run choice here.
    // Omitted (e.g. programmatic callers) falls back to the workspace default.
    const { skipPermissions } = req.body || {};
    scheduleSpawn(cardId, card.workspace_id, card.agent, emitSSE, undefined, skipPermissions);
    res.json({ ok: true });
  });

  // Called by routeSpawnAgent in MCP-subprocess mode after a move_card.
  // Unlike /run, this does NOT reject when the agent is already active — it
  // lets spawnAgent queue a pendingRespawn so the review phase starts as soon
  // as the current agent exits.
  app.post('/api/cards/:cardId/spawn-or-queue', (req, res) => {
    const { cardId } = req.params;
    const card = db.getCard(cardId);
    if (!card || (!card.agent && !card.review_agent)) return res.json({ ok: true });
    spawnAgent(cardId, card.workspace_id, card.agent || card.review_agent, emitSSE);
    res.json({ ok: true });
  });

  app.post('/api/cards/:cardId/stop', (req, res) => {
    const { cardId } = req.params;
    cancelScheduledSpawn(cardId);
    if (!isAgentActive(cardId)) return res.status(409).json({ error: 'No agent running or queued' });
    const wasRunning = isAgentRunning(cardId);
    stopAgent(cardId);
    const card = db.getCard(cardId);
    // Only running agents emit a completion; a purely-queued cancel just clears state.
    if (card && wasRunning) emitSSE('agent_completed', { cardId, agentType: card.agent, code: 130, duration: 0 });
    else emitSSE('agent_dequeued', { cardId });
    res.json({ ok: true });
  });

  app.get('/api/agents/available', (_req, res) => {
    res.json({
      'claude-code':   isAgentInstalled('claude'),
      'opencode':      isAgentInstalled('opencode'),
      'codex':         isAgentInstalled('codex'),
      'command-code':  isAgentInstalled('command-code'),
    });
  });

  app.get('/api/models', (_req, res) => {
    res.json(getAvailableModels());
  });

  app.post('/api/models/refresh', (_req, res) => {
    const models = refreshAvailableModels();
    emitSSE('models_updated', models);
    res.json(models);
  });

  app.get('/api/info', (_req, res) => {
    res.json({
      dataDir: db.DATA_DIR,
      platform: process.platform,
      version: VERSION,
      storage: 'sqlite',
    });
  });

  // Version + update check. The latest published version is looked up from the
  // npm registry and cached in-memory for 6h so we never hammer it. Fails soft:
  // if the registry is unreachable (offline / firewall), latest is null and the
  // UI simply shows the current version with no update prompt.
  let _latestVer = null, _latestAt = 0;
  const semverGt = (a, b) => {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
    return false;
  };
  app.get('/api/version', async (_req, res) => {
    const now = Date.now();
    if (!_latestVer || now - _latestAt > 6 * 3600 * 1000) {
      try {
        const r = await fetch('https://registry.npmjs.org/@zanuartri%2Fvibeboard/latest', {
          headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000),
        });
        if (r.ok) { const j = await r.json(); if (j.version) { _latestVer = j.version; _latestAt = now; } }
      } catch (_) { /* offline — leave _latestVer as-is */ }
    }
    res.json({
      current: VERSION,
      latest: _latestVer,
      updateAvailable: _latestVer ? semverGt(_latestVer, VERSION) : false,
      package: '@zanuartri/vibeboard',
    });
  });

  app.get('/board', (_req, res) => {
    const activeId = db.getActiveWorkspaceId();
    if (!activeId) return res.json(null);
    const board = db.getBoard(activeId);
    board.runningCards = getRunningCardIds();
    board.queuedCards = getQueuedCardIds();
    board.pendingRespawnCards = getPendingRespawnCardIds();
    res.json(board);
  });

  app.get('/api/cards/:cardId/output', (req, res) => {
    const { cardId } = req.params;
    const outputFile = getOutputFile(cardId);
    try {
      const raw = fs.readFileSync(outputFile, 'utf8');
      res.json({ cardId, output: raw });
    } catch (_) {
      res.json({ cardId, output: '' });
    }
  });

  app.post('/board', async (req, res) => {
    const activeId = db.getActiveWorkspaceId();
    if (!activeId) return res.status(400).json({ error: 'No active workspace' });

    const body = req.body;

    // Enforce WIP limits server-side before accepting mutations
    if (Array.isArray(body.columns)) {
      const currentBoard = db.getBoard(activeId);
      if (currentBoard) {
        for (const col of body.columns) {
          if (Number.isInteger(col.wip_limit) && col.wip_limit > 0) {
            const currentCol = currentBoard.columns.find(c => c.id === col.id);
            const currentCount = currentCol ? currentCol.cards.length : 0;
            const incomingCount = (col.cards || []).length;
            if (incomingCount > col.wip_limit && incomingCount > currentCount) {
              return res.status(400).json({ error: 'WIP limit exceeded', column: col.title, limit: col.wip_limit });
            }
          }
        }
      }
    }

    if (body.name !== undefined || body.path !== undefined || body.description !== undefined || body.use_worktree !== undefined || body.skip_permissions !== undefined) {
      try {
        db.updateWorkspace(activeId, { name: body.name, path: body.path, description: body.description, use_worktree: body.use_worktree, skip_permissions: body.skip_permissions });
      } catch (err) { return res.status(400).json({ error: err.message }); }
    }
    if (Array.isArray(body.columns)) {
      try {
        await db.syncBoard(activeId, body.columns);
      } catch (err) {
        const freshBefore = db.getBoard(activeId);
        emitSSE('board_update', { ...freshBefore, _tabId: body._tabId });
        return res.status(400).json({ error: err.message });
      }
    }

    const fresh = db.getBoard(activeId);
    emitSSE('board_update', { ...fresh, _tabId: body._tabId });
    res.json({ ok: true });
  });

  app.get('/api/mcp-status', (_req, res) => {
    const configs = getAgentMcpConfigs();
    const agents = {};
    for (const [key, info] of Object.entries(configs)) {
      agents[key] = readAgentMcpStatus(key, info);
    }
    const anyUnconfigured = Object.values(agents).some(a => a.installed && !a.configured);
    res.json({ agents, anyUnconfigured });
  });

  app.post('/api/mcp-setup', (req, res) => {
    const { agent } = req.body || {};
    const configs = getAgentMcpConfigs();
    const targets = agent && agent !== 'all' ? [agent] : Object.keys(configs);
    const results = {};

    for (const key of targets) {
      const info = configs[key];
      if (!info) { results[key] = { ok: false, error: 'Unknown agent' }; continue; }
      if (!isAgentInstalled(info.cmd)) { results[key] = { ok: false, error: 'Not installed' }; continue; }
      try {
        fs.mkdirSync(path.dirname(info.configPath), { recursive: true });
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(info.configPath, 'utf8')); } catch (_) {}
        const updated = info.write(existing, info.configPath);
        // null means the write function handled it directly (e.g. via CLI)
        if (updated !== null) {
          fs.writeFileSync(info.configPath, JSON.stringify(updated, null, 2), 'utf8');
        }
        results[key] = { ok: true, configPath: info.configPath };
      } catch (err) {
        results[key] = { ok: false, error: err.message };
      }
    }

    refreshAvailableModels();
    emitSSE('models_updated', getAvailableModels());
    emitSSE('mcp_configured', { results });
    res.json({ ok: true, results });
  });

  app.get('/api/cards/:cardId/diff', (req, res) => {
    const card = db.getCard(req.params.cardId);
    if (!card?.worktree_path) return res.json({ diff: '', commits: '' });
    const wsId = db.getActiveWorkspaceId();
    const workspace = db.getWorkspace(wsId);
    if (!workspace) return res.json({ diff: '', commits: '' });
    const base = wt.getBaseBranch(workspace.path);
    res.json({
      diff:    wt.getDiff(card.worktree_path, base),
      commits: wt.getCommits(card.worktree_path, base),
      branch:  card.branch,
      base,
    });
  });

  app.post('/api/cards/:cardId/discard', (req, res) => {
    const card = db.getCard(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    if (!card.branch) return res.status(400).json({ error: 'Card has no branch to discard' });
    const wsId = db.getActiveWorkspaceId();
    const workspace = db.getWorkspace(wsId);
    if (!workspace) return res.status(400).json({ error: 'No active workspace' });
    try {
      const { execFileSync } = require('child_process');
      if (card.worktree_path) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', card.worktree_path], { cwd: workspace.path, stdio: 'ignore' });
        } catch (_) {
          try { fs.rmSync(card.worktree_path, { recursive: true, force: true }); } catch (_) {}
        }
        try { execFileSync('git', ['worktree', 'prune'], { cwd: workspace.path, stdio: 'ignore' }); } catch (_) {}
      }
      try {
        execFileSync('git', ['branch', '-D', card.branch], { cwd: workspace.path, stdio: 'ignore' });
      } catch (_) {}
      db.updateCard(card.id, { branch: null, worktreePath: null });
      const fresh = db.getCard(card.id);
      emitSSE('card_updated', fresh);
      const board = db.getBoard(wsId);
      emitSSE('board_update', board);
      res.json({ ok: true, card: fresh });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/cards/:cardId/merge', (req, res) => {
    const card = db.getCard(req.params.cardId);
    if (!card?.branch) return res.status(400).json({ error: 'Card has no branch' });
    const wsId = db.getActiveWorkspaceId();
    const workspace = db.getWorkspace(wsId);
    if (!workspace) return res.status(400).json({ error: 'No active workspace' });
    try {
      wt.mergeBranch(workspace.path, card.branch, card.worktree_path);
      db.updateCard(card.id, { merged_at: new Date().toISOString(), worktreePath: null, has_branch_changes: false });
      const fresh = db.getBoard(wsId);
      emitSSE('board_update', fresh);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/cards/:cardId/mark-merged', (req, res) => {
    const card = db.getCard(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const wsId = db.getActiveWorkspaceId();
    const workspace = db.getWorkspace(wsId);
    if (!workspace) return res.status(400).json({ error: 'No active workspace' });
    const { execFileSync } = require('child_process');
    if (card.worktree_path) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', card.worktree_path], { cwd: workspace.path, stdio: 'ignore' });
      } catch (_) {
        try { fs.rmSync(card.worktree_path, { recursive: true, force: true }); } catch (_) {}
      }
      try { execFileSync('git', ['worktree', 'prune'], { cwd: workspace.path, stdio: 'ignore' }); } catch (_) {}
    }
    db.updateCard(card.id, { merged_at: new Date().toISOString(), worktreePath: null, has_branch_changes: false });
    const fresh = db.getBoard(wsId);
    emitSSE('board_update', fresh);
    res.json({ ok: true });
  });

  app.post('/api/cards/:cardId/pr', (req, res) => {
    const card = db.getCard(req.params.cardId);
    if (!card?.worktree_path) return res.status(400).json({ error: 'Card has no worktree' });
    try {
      const url = wt.pushAndCreatePR(card.worktree_path, card.title);
      res.json({ ok: true, url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/workspaces/:id/agent-context', (req, res) => {
    const workspace = db.getWorkspace(req.params.id);
    if (!workspace?.path) return res.status(404).json({ error: 'Workspace not found' });

    const candidates = [
      'CLAUDE.md',
      'AGENTS.md',
      'OPENCODE.md',
      'CODEX.md',
      'DESIGN.md',
      '.claude/CLAUDE.md',
    ];

    const files = [];
    for (const rel of candidates) {
      try {
        const content = fs.readFileSync(path.join(workspace.path, rel), 'utf8');
        files.push({ filename: rel, content });
      } catch (_) {}
    }
    res.json({ files });
  });

  app.get('/api/workspaces/:id/export', (req, res) => {
    const data = db.exportWorkspace(req.params.id);
    if (!data) return res.status(404).json({ error: 'Workspace not found' });
    res.setHeader('Content-Disposition', `attachment; filename="vibeboard-export-${Date.now()}.json"`);
    res.json(data);
  });

  app.post('/api/workspaces/import', (req, res) => {
    try {
      const ws = db.importWorkspace(req.body);
      if (!db.getActiveWorkspaceId()) {
        db.setActiveWorkspaceId(ws.id);
        emitSSE('workspace_switch', { board: db.getBoard(ws.id), workspaceId: ws.id });
      }
      const active = db.getActiveWorkspaceId();
      emitSSE('workspace_list', db.listWorkspaces().map(w => ({ ...w, active: w.id === active })));
      res.json(ws);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/agent-log', (_req, res) => {
    const activeId = db.getActiveWorkspaceId();
    if (!activeId) return res.status(400).json({ error: 'No active workspace' });
    db.clearLog(activeId);
    emitSSE('board_update', db.getBoard(activeId));
    res.json({ ok: true });
  });

  app.post('/api/cards/:cardId/duplicate', (req, res) => {
    const card = db.getCard(req.params.cardId);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const copy = db.createCard(card.workspace_id, card.column_id, card.title + ' (copy)', {
      description: card.description,
      tags: card.tags,
      agent: card.agent,
      requires_review: card.requires_review,
      priority: card.priority,
      custom_prompt: card.custom_prompt,
      due_date: card.due_date,
    });
    db.addAgentLog(card.workspace_id, 'system', 'duplicate_card', `Duplicated '${card.title}'`, copy.id);
    emitSSE('board_update', db.getBoard(card.workspace_id));
    res.json(copy);
  });

  app.get('/api/cards/:cardId/notes', (req, res) => {
    const { cardId } = req.params;
    try {
      const notes = db.getCardNotes(cardId);
      res.json({ cardId, notes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/cards/search', (req, res) => {
    const workspaceId = db.getActiveWorkspaceId();
    if (!workspaceId) return res.status(400).json({ error: 'No active workspace' });
    const result = db.searchCards(workspaceId, req.query);
    res.json(result);
  });

  app.get('/api/workspaces/:id/templates', (req, res) => {
    const { id } = req.params;
    const templates = db.listTemplates(id);
    res.json(templates);
  });

  app.post('/api/workspaces/:id/templates', (req, res) => {
    const { id } = req.params;
    const { name, title_pattern, tags, agent, model, priority, custom_prompt } = req.body;
    if (!name) return res.status(400).json({ error: 'Template name is required' });
    try {
      const template = db.createTemplate(id, name, { title_pattern, tags, agent, model, priority, custom_prompt });
      emitSSE('templates_updated', { workspaceId: id, templates: db.listTemplates(id) });
      res.json(template);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/templates/:id', (req, res) => {
    const { id } = req.params;
    const template = db.getTemplate(id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    try {
      db.updateTemplate(id, req.body);
      emitSSE('templates_updated', { workspaceId: template.workspace_id, templates: db.listTemplates(template.workspace_id) });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/templates/:id', (req, res) => {
    const { id } = req.params;
    const template = db.getTemplate(id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    db.deleteTemplate(id);
    emitSSE('templates_updated', { workspaceId: template.workspace_id, templates: db.listTemplates(template.workspace_id) });
    res.json({ ok: true });
  });

  app.post('/api/sse-emit', (req, res) => {
    const { type, data } = req.body || {};
    if (type) broadcast(type, data);
    res.json({ ok: true });
  });

  app.post('/admin/rotate-token', (req, res) => {
    if (!NETWORK_MODE) return res.status(400).json({ error: 'Token rotation only available in network mode' });
    const newToken = rotateToken();
    process.stderr.write(`Token rotated: ${newToken}\n`);
    res.json({ ok: true, token: newToken });
  });

  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    const hb = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
  });

  app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));
  app.get('/app', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
};
