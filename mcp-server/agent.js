const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getCard, getColumn, getWorkspace, updateCard, addCardNote, addAgentLog, getCardNotes, DATA_DIR } = require('./db');
const wt = require('./worktree');
const { verifySpawnDir } = require('./path-guard');
const { sanitizeForPrompt, wrapCardData } = require('./prompt-sanitize');

const activeAgents = new Map();

// Cards whose agent was moved (via move_card) to a new spawnable column while
// the agent was still running. When the current agent exits, agentDone dequeues
// the next entry and re-spawns for that phase. Using an array queue per card
// ensures rapid successive moves don't silently clobber earlier respawn targets.
const pendingRespawn = new Map(); // cardId -> [{ workspaceId, agentType }, ...]

// Cap on simultaneously running agents. Spawn requests beyond the cap are queued
// (FIFO) and started automatically as running agents finish. In-memory like
// activeAgents — both live in the single HTTP-server process that owns lifecycles.
const MAX_CONCURRENT = parseInt(process.env.VB_MAX_AGENTS || '', 10) || 3;
const agentQueue = []; // [{ cardId, workspaceId, agentType }]

// Debounce timers for user-triggered spawns (drag-and-drop / MCP move_card).
// Gives the user a 1.5 s window to undo an accidental move before an agent
// is spawned and starts consuming tokens. Internal spawns (dequeueNext,
// Review-phase respawn) bypass this and call spawnAgent() directly.
const SPAWN_DEBOUNCE_MS = 1500;
const spawnTimers = new Map(); // cardId -> timeoutId

function scheduleSpawn(cardId, workspaceId, agentType, emitSSE, modelOverride, skipPermissionsOverride) {
  if (spawnTimers.has(cardId)) {
    clearTimeout(spawnTimers.get(cardId));
    spawnTimers.delete(cardId);
  }
  const tid = setTimeout(() => {
    spawnTimers.delete(cardId);
    spawnAgent(cardId, workspaceId, agentType, emitSSE, modelOverride, skipPermissionsOverride);
  }, SPAWN_DEBOUNCE_MS);
  spawnTimers.set(cardId, tid);
}

function cancelScheduledSpawn(cardId) {
  if (spawnTimers.has(cardId)) {
    clearTimeout(spawnTimers.get(cardId));
    spawnTimers.delete(cardId);
  }
}

// Agent prompt/output files can contain source code and secrets from a session,
// so keep them in the user-scoped data dir rather than world-readable os.tmpdir().
const AGENT_IO_DIR = path.join(DATA_DIR, 'agent-io');
try { fs.mkdirSync(AGENT_IO_DIR, { recursive: true }); } catch (_) {}

const PORT = process.env.PORT || 7341;
const AGENT_TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || '') || 30 * 60 * 1000;

// Retry wrapper for the agent-done HTTP notify. If the HTTP server is temporarily
// unavailable, silent swallowing would leave the card stuck in "In Progress" forever.
async function fetchWithRetry(url, options, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return;
    } catch (err) {
      if (i === attempts - 1) {
        process.stderr.write(`[agent] agent-done notify failed after ${attempts} attempts: ${err.message}\n`);
        return;
      }
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

// Per-card PID files so agents spawned by MCP subprocess instances (which have
// their own in-process activeAgents map) are still reachable on SIGTERM.
function getPidFile(cardId) { return path.join(DATA_DIR, `agent-pid-${cardId}`); }
function writePid(cardId, pid) {
  try { fs.writeFileSync(getPidFile(cardId), String(pid)); } catch (_) {}
}
function removePid(cardId) {
  try { fs.unlinkSync(getPidFile(cardId)); } catch (_) {}
}
function killAllRegisteredPids() {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('agent-pid-'));
    for (const file of files) {
      try {
        const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'), 10);
        if (pid > 0) process.kill(pid, 'SIGTERM');
        fs.unlinkSync(path.join(DATA_DIR, file));
      } catch (_) {}
    }
  } catch (_) {}
}

function isQueued(cardId) { return agentQueue.some(q => q.cardId === cardId); }
function getQueuedCardIds() { return agentQueue.map(q => q.cardId); }
function dequeueCard(cardId) {
  const i = agentQueue.findIndex(q => q.cardId === cardId);
  if (i !== -1) agentQueue.splice(i, 1);
}

// Start queued agents while there is free capacity. Called after each agentDone.
// Sorts the queue by card priority (high → medium → low → null) before dequeuing,
// with FIFO as a tiebreaker within the same priority level.
function dequeueNext(emitSSE) {
  while (agentQueue.length && activeAgents.size < MAX_CONCURRENT) {
    sortQueueByPriority();
    const next = agentQueue.shift();
    if (activeAgents.has(next.cardId)) continue; // already started elsewhere
    emitSSE('agent_dequeued', { cardId: next.cardId });
    spawnAgent(next.cardId, next.workspaceId, next.agentType, emitSSE, undefined, next.skipPermissionsOverride);
  }
}

function sortQueueByPriority() {
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  agentQueue.sort((a, b) => {
    const cardA = getCard(a.cardId);
    const cardB = getCard(b.cardId);
    const prioA = cardA?.priority ? priorityOrder[cardA.priority] : 3;
    const prioB = cardB?.priority ? priorityOrder[cardB.priority] : 3;
    return prioA - prioB;
  });
}

// Build a shell command string for each agent that reads the prompt from a temp file.
// Using a shell command string (not arg array) avoids quoting issues with multiline prompts.
// Model ids look like `claude-sonnet-4-6` or `provider/model-name`. Anything
// outside this charset is rejected so a model value can't break out of the shell
// command string (the command runs with shell: true).
function isSafeModel(model) {
  if (typeof model !== 'string') return false;
  if (!/^[A-Za-z0-9._:/-]+$/.test(model)) return false;
  if (model.includes('..')) return false;
  if (/\/\/+/.test(model)) return false;
  return true;
}

// Per-agent flag that bypasses tool-use approval prompts. Only applied when
// the workspace's skip_permissions setting is on (the historical default, to
// stay backward-compatible with workspaces created before this setting
// existed). Turning it off means the agent stops and waits on its normal
// permission prompts, same as running it yourself in a terminal.
function skipPermissionsFlag(agentType) {
  switch (agentType) {
    case 'claude-code': return '--dangerously-skip-permissions';
    case 'opencode': return '--dangerously-skip-permissions';
    case 'codex': return '--dangerously-bypass-approvals-and-sandbox';
    case 'command-code': return '--yolo';
    default: return '';
  }
}

function buildShellCmd(agentType, promptFile, model, skipPermissions = true) {
  const win = process.platform === 'win32';
  let modelFlag = '';

  if (model && isSafeModel(model)) {
    if (agentType === 'claude-code' || agentType === 'opencode' || agentType === 'codex' || agentType === 'command-code') {
      modelFlag = ` --model ${model}`;
    }
  } else if (model) {
    process.stderr.write(`Ignoring unsafe model value: ${JSON.stringify(model)}\n`);
  }

  const permFlag = skipPermissions ? ` ${skipPermissionsFlag(agentType)}` : '';

  switch (agentType) {
    case 'claude-code':
      return win
        ? `type "${promptFile}" | claude --print --verbose${permFlag} --effort medium --output-format stream-json${modelFlag}`
        : `claude --print --verbose${permFlag} --effort medium --output-format stream-json${modelFlag} < "${promptFile}"`;
    case 'opencode':
      return win
        ? `type "${promptFile}" | opencode run${permFlag}${modelFlag}`
        : `opencode run${permFlag}${modelFlag} < "${promptFile}"`;
    case 'codex':
      return win
        ? `type "${promptFile}" | codex exec${permFlag}${modelFlag}`
        : `codex exec${permFlag}${modelFlag} < "${promptFile}"`;
    case 'command-code':
      return win
        ? `type "${promptFile}" | command-code -p${permFlag} --skip-onboarding --max-turns 60${modelFlag}`
        : `command-code -p${permFlag} --skip-onboarding --max-turns 60${modelFlag} < "${promptFile}"`;

    default:
      return win
        ? `type "${promptFile}" | ${agentType}`
        : `${agentType} < "${promptFile}"`;
  }
}

function getOutputFile(cardId) {
  return path.join(AGENT_IO_DIR, `vb-output-${cardId}.txt`);
}

function stripAnsi(str) {
  return str
    .replace(/\uFEFF/g, '')                          // UTF-8/UTF-16 BOM
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')           // CSI sequences
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC sequences
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '')      // other ESC sequences
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // control chars except \t \n \r
}

// Parse claude --output-format stream-json events into readable lines.
// Each line is a JSON object; we extract assistant text and tool names.
// Non-JSON lines (e.g. from stderr) are passed through unchanged.
function parseClaudeStreamJson(rawLines) {
  const out = [];
  for (const line of rawLines) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('{')) { out.push(line); continue; }
    try {
      const ev = JSON.parse(t);
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) out.push(...block.text.split('\n'));
          else if (block.type === 'tool_use') out.push(`[tool: ${block.name}]`);
        }
      } else if (ev.type === 'result' && ev.total_cost != null) {
        out.push(`\nSession cost: $${Number(ev.total_cost).toFixed(4)}`);
      }
      // skip system / user / other event types
    } catch { out.push(line); }
  }
  return out.filter(l => l.trim());
}

function startOutputWatcher(cardId, outputFile, emitSSE, transform) {
  let position = 0;
  return setInterval(() => {
    try {
      const stat = fs.statSync(outputFile);
      if (stat.size <= position) return;
      const buf = Buffer.alloc(stat.size - position);
      const fd = fs.openSync(outputFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, position);
      fs.closeSync(fd);
      position = stat.size;
      const raw = stripAnsi(buf.toString('utf8')).split('\n');
      const lines = transform ? transform(raw) : raw.filter(l => l.trim());
      if (lines.length) emitSSE('agent_output', { cardId, lines });
    } catch (_) {}
  }, 500);
}

function buildPriorContext(cardId) {
  let notes;
  try { notes = getCardNotes(cardId); } catch (_) { return ''; }
  if (!notes || !notes.length) return '';
  // Exclude full session output dumps (large, low signal for retry context).
  // Keep short progress notes written by the agent via add_card_note.
  const progress = notes
    .filter(n => !n.content.startsWith('Agent session output') && n.content.length < 600)
    .slice(-5);
  if (!progress.length) return '';
  return `Prior work (previous session):\n${progress.map(n => `- ${n.content.trim()}`).join('\n')}`;
}

const MAX_DESC_CHARS = 2000;

function buildPrompt(card, column, workspace, branch, worktreePath, agentType) {
  const desc = card.description && card.description.length > MAX_DESC_CHARS
    ? card.description.slice(0, MAX_DESC_CHARS) + `\n[description truncated — ${card.description.length - MAX_DESC_CHARS} chars omitted]`
    : card.description;

  const dataBlock = wrapCardData([
    { label: 'Title',       value: card.title },
    { label: 'Description', value: desc },
    { label: 'Tags',        value: (card.tags || []).join(', ') },
    { label: 'Priority',    value: card.priority },
    { label: 'Due',         value: card.due_date },
  ]);

  const branchLine = branch ? `Git branch: ${sanitizeForPrompt(branch)} (commit here as you work)\n` : '';

  const colTitle = column?.title || '';
  let phase;
  if (colTitle === 'In Progress') {
    const next = card.requires_review
      ? 'call move_card to "Review"'
      : 'call complete_card (this card skips Review)';
    phase = `Phase: IN PROGRESS - implement the task, then commit ALL changes with git and ${next}.`;
  } else if (colTitle === 'Review') {
    const diffCmd = branch
      ? `git log --oneline main..HEAD && git diff main..HEAD`
      : card.in_progress_base_sha
        ? `git log --oneline ${card.in_progress_base_sha}..HEAD && git diff ${card.in_progress_base_sha}..HEAD`
        : `git log --oneline -10 && git diff HEAD~1`;
    phase = `Phase: REVIEW
1. Run: ${diffCmd}
2. Verify implementation matches the task. Run existing tests.
3. Trivial issues (typo, off-by-one): fix, commit, complete_card.
4. Significant issues (wrong logic, broken tests): update_card({review_issue:true}), add_card_note with details, stop — do NOT complete_card.
5. All good: complete_card.
Do not re-implement from scratch.`;
  } else if (colTitle === 'Done') {
    phase = `Phase: DONE - work is complete; ensure everything is committed. The user merges manually.`;
  } else {
    phase = `Phase: ${sanitizeForPrompt(colTitle)}`;
  }

  const custom = card.custom_prompt
    ? `\n\nUser instructions (also untrusted):\n<user-instructions>\n${sanitizeForPrompt(card.custom_prompt)}\n</user-instructions>`
    : '';

  const workIn = worktreePath || workspace.path;
  const worktreeWarning = worktreePath
    ? `\nIMPORTANT: Your shell cwd is a git worktree at ${sanitizeForPrompt(worktreePath)}. Write ALL files there, NOT to the workspace root at ${sanitizeForPrompt(workspace.path)}. The workspace root must remain clean.`
    : '';

  const boardApi = agentType === 'command-code'
    ? `Use the VibeBoard HTTP API to update the board (MCP not available in this mode):
- Progress note: POST http://localhost:${PORT}/api/cards/${card.id}/note   body: {"content":"your note"}
- Move column:   POST http://localhost:${PORT}/api/cards/${card.id}/move    body: {"toColumnTitle":"Done"}
- Complete:      POST http://localhost:${PORT}/api/cards/${card.id}/complete (no body)
Call these often to log progress, and call complete at the end.
Do NOT run taste commands or create/update any taste.md files.`
    : `Use VibeBoard MCP tools: get_card(cardId) to read your full task description, add_card_note to log progress, move_card / complete_card to change status. When reading the board use get_board({compact:true}) or get_column/list_cards — never plain get_board which loads all descriptions.`;

  // Workspace description — placed first so it forms a stable cached prefix
  // for Claude (prompt caching requires a long identical prefix). All agents
  // benefit from having project context before the task details.
  const MAX_WS_DESC = 1000;
  const wsDesc = workspace.description
    ? sanitizeForPrompt(workspace.description).slice(0, MAX_WS_DESC) +
      (workspace.description.length > MAX_WS_DESC ? `\n[workspace description truncated — ${workspace.description.length - MAX_WS_DESC} chars omitted]` : '')
    : '';
  const wsContext = wsDesc
    ? `Workspace: ${sanitizeForPrompt(workspace.name || '')}\n${wsDesc}\n\n`
    : '';

  const priorContext = buildPriorContext(card.id);
  const priorSection = priorContext ? `\n${priorContext}\n` : '';

  return `${wsContext}Task on VibeBoard.
${dataBlock ? dataBlock + '\n\n' : ''}Card ID: ${card.id} - Workspace ID: ${workspace.id}
Work in: ${workIn}
${branchLine}
${phase}
${worktreeWarning}
${priorSection}
${boardApi} Commit with git as you go.${custom}`;
}

function killProcessTree(child) {
  if (process.platform === 'win32' && child.pid) {
    // On Windows, child.kill() only kills the cmd.exe shell, not the agent
    // grandchild it spawned. The grandchild keeps the stdout pipe open, so
    // child.on('close') never fires and outStream leaks. taskkill /T /F kills
    // the entire process tree rooted at the shell.
    try { execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore', timeout: 5000 }); } catch (_) {}
  } else {
    try { child.kill(); } catch (_) {}
  }
}

function launchAgent(agentType, prompt, outputFile, workspaceDir, cardId, model, skipPermissions = true) {
  const outStream = fs.createWriteStream(outputFile, { flags: 'w' });

  // Without an error handler, a write failure (disk full, bad path, etc.)
  // throws an uncaught exception and crashes the server.
  outStream.on('error', (err) => {
    process.stderr.write(`[agent] output stream error for card ${cardId}: ${err.message}\n`);
    outStream.destroy();
  });

  const promptFile = path.join(AGENT_IO_DIR, `vb-prompt-${cardId}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  const cmd = buildShellCmd(agentType, promptFile, model, skipPermissions);
  const child = spawn(cmd, [], {
    cwd: workspaceDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: true,
  });

  if (child.pid) writePid(cardId, child.pid);

  child.stdout.pipe(outStream, { end: false });
  child.stderr.pipe(outStream, { end: false });

  let doneFired = false;
  function notifyDone(code) {
    if (doneFired) return;
    doneFired = true;
    if (!outStream.destroyed) outStream.end();
    try { fs.unlinkSync(promptFile); } catch (_) {}
    const agentInfo = activeAgents.get(cardId);
    if (agentInfo?.timeoutId) clearTimeout(agentInfo.timeoutId);
    removePid(cardId);
    fetchWithRetry(`http://localhost:${PORT}/api/agent-done/${cardId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code ?? 1 }),
    });
  }

  child.on('close', (code) => notifyDone(code));
  child.on('error', (err) => {
    if (!outStream.destroyed) outStream.write(`\n[error: ${err.message}]\n`);
    notifyDone(1);
  });

  return { child, outStream };
}

function spawnAgent(cardId, workspaceId, agentType, emitSSE, modelOverride, skipPermissionsOverride) {
  if (activeAgents.has(cardId)) {
    // Card was moved to a new column while the agent was still running.
    // If the target column is one we auto-spawn for, schedule a respawn
    // that fires once the current agent exits.
    const card = getCard(cardId);
    if (card) {
      const col = getColumn(card.column_id);
      if (col && (col.title === 'In Progress' || col.title === 'Review')) {
        if (!pendingRespawn.has(cardId)) pendingRespawn.set(cardId, []);
        const queue = pendingRespawn.get(cardId);
        if (queue.length > 0) {
          process.stderr.write(`[agent] Warning: card ${cardId} already has ${queue.length} pending respawn(s); queuing another (previous targets will run first)\n`);
        }
        queue.push({ workspaceId, agentType, skipPermissionsOverride });
        addAgentLog(workspaceId, agentType, 'agent_pending_respawn', `Queued respawn #${queue.length} after current agent exits for card ${cardId}`, cardId);
        emitSSE('agent_pending_respawn', { cardId, agentType });
      }
    }
    return;
  }

  // At capacity: queue this request instead of spawning. dequeueNext()
  // will start it when a running agent finishes.
  if (activeAgents.size >= MAX_CONCURRENT) {
    if (!isQueued(cardId)) {
      agentQueue.push({ cardId, workspaceId, agentType, skipPermissionsOverride });
      addAgentLog(workspaceId, agentType, 'agent_queued', `Queued at capacity (${MAX_CONCURRENT} running) for card ${cardId}`, cardId);
      const queuePos = agentQueue.length;
      addCardNote(cardId, `Agent queued — ${activeAgents.size} agent(s) already running (max ${MAX_CONCURRENT}). Position in queue: ${queuePos}. Starts automatically when a slot frees up.`);
      emitSSE('agent_queued', { cardId, agentType, position: queuePos });
    }
    return;
  }

  const card = getCard(cardId);
  if (!card) { process.stderr.write(`Card ${cardId} not found\n`); return; }

  const column = getColumn(card.column_id);

  // For Review column, prefer card.review_agent/review_model when defined.
  // This makes all spawn paths (direct, queued, pending respawn) consistent.
  if (column?.title === 'Review' && card.review_agent) {
    agentType = card.review_agent;
  }
  const modelToUse = (column?.title === 'Review' && card.review_agent)
    ? (card.review_model || card.model)
    : (modelOverride !== undefined ? modelOverride : card.model);

  const workspace = getWorkspace(workspaceId);
  if (!workspace?.path) { process.stderr.write(`Workspace ${workspaceId} has no path\n`); return; }

  let branch = null, worktreePath = null, spawnDir = workspace.path;
  if (workspace.use_worktree) {
    try {
      const wtResult = wt.createWorktree(workspace.path, cardId, card.title);
      if (wtResult) {
        branch = wtResult.branch;
        worktreePath = wtResult.worktreePath;
        spawnDir = wtResult.worktreePath;
        updateCard(cardId, { branch, worktreePath });
        emitSSE('board_update', require('./db').getBoard(workspaceId));
      } else {
        addCardNote(cardId, 'Worktree skipped: repo has no commits yet. Agent will run in the workspace directory directly.');
      }
    } catch (err) {
      process.stderr.write(`Worktree creation failed (running in workspace dir): ${err.message}\n`);
      addCardNote(cardId, `Worktree creation failed: ${err.message}. Agent running in workspace directory.`);
    }
  } else if (column?.title === 'In Progress') {
    // No worktree — snapshot HEAD so the Review agent can diff exactly what changed.
    try {
      const sha = execSync('git rev-parse HEAD', { cwd: workspace.path, encoding: 'utf8', timeout: 3000 }).trim();
      if (sha) updateCard(cardId, { in_progress_base_sha: sha });
    } catch (_) {}
  }

  // Verify the spawn directory immediately before launching: catches deleted
  // workspaces, symlink swaps, and worktrees that escaped the workspace root.
  // Logged + recorded as a card note so the failure is visible on the board.
  try {
    spawnDir = verifySpawnDir(spawnDir, workspace.use_worktree && worktreePath ? workspace.path : null);
  } catch (err) {
    process.stderr.write(`Refusing to spawn agent: ${err.message}\n`);
    addAgentLog(workspaceId, agentType, 'agent_error', `Spawn dir rejected: ${err.message}`, cardId);
    addCardNote(cardId, `Agent failed to start: spawn directory rejected (${err.message}).`);
    emitSSE('agent_error', { cardId, agentType, error: err.message });
    return;
  }

  const prompt = buildPrompt(card, column, workspace, branch, worktreePath, agentType);
  const outputFile = getOutputFile(cardId);
  try { fs.unlinkSync(outputFile); } catch (_) {}

  try {
    // Per-run choice (from the UI's confirm-on-move prompt) takes precedence
    // over the workspace default. Automatic continuations that have no live
    // user interaction to ask (queue dequeue, Review-phase respawn) fall back
    // to the workspace default when no override was captured at queue time.
    const skipPermissions = skipPermissionsOverride !== undefined
      ? !!skipPermissionsOverride
      : (workspace.skip_permissions === undefined ? true : !!workspace.skip_permissions);
    const { child, outStream } = launchAgent(agentType, prompt, outputFile, spawnDir, cardId, modelToUse, skipPermissions);
    const transform = agentType === 'claude-code' ? parseClaudeStreamJson : null;
    const watchInterval = startOutputWatcher(cardId, outputFile, emitSSE, transform);

    const timeoutId = setTimeout(() => {
      if (!activeAgents.has(cardId)) return;
      process.stderr.write(`Agent timeout (${AGENT_TIMEOUT_MS / 60000}min) for card ${cardId}\n`);
      addCardNote(cardId, `Agent timed out after ${AGENT_TIMEOUT_MS / 60000} minutes and was stopped.`);
      addAgentLog(workspaceId, agentType, 'agent_timeout', `Timed out for card ${cardId}`, cardId);
      killProcessTree(child);
      agentDone(cardId, 1, emitSSE);
    }, AGENT_TIMEOUT_MS);

    const startTime = new Date().toISOString();
    activeAgents.set(cardId, {
      cardId, workspaceId, agentType, child, outStream,
      startTime, outputFile, watchInterval, timeoutId,
      workspacePath: workspace.path,
      worktreePath,
    });

    updateCard(cardId, { agent_ran_at: startTime });
    addAgentLog(workspaceId, agentType, 'agent_started', `Started ${agentType} for: ${card.title}`, cardId);
    emitSSE('agent_started', { cardId, agentType, title: card.title });
    process.stderr.write(`Started ${agentType} (background) for card ${cardId}\n`);
  } catch (err) {
    // If activeAgents was set before the error (e.g. updateCard threw), clean it up
    // so the map doesn't leak a reference to a running child with no cleanup path.
    const leaked = activeAgents.get(cardId);
    if (leaked) {
      if (leaked.watchInterval) clearInterval(leaked.watchInterval);
      if (leaked.timeoutId) clearTimeout(leaked.timeoutId);
      killProcessTree(leaked.child);
      try { leaked.outStream?.destroy(); } catch (_) {}
      activeAgents.delete(cardId);
      removePid(cardId);
    }
    process.stderr.write(`Failed to start agent: ${err.message}\n`);
    addAgentLog(workspaceId, agentType, 'agent_error', `Failed to start: ${err.message}`, cardId);
    addCardNote(cardId, `Agent failed to start: ${err.message}`);
    emitSSE('agent_error', { cardId, agentType, error: err.message });
  }
}

// Best-effort scrape of cost/token usage from an agent's session output. Agents
// don't emit a stable machine-readable summary in text mode, so this looks for
// common labelled patterns and stays null when nothing recognizable is present.
function parseUsage(text) {
  let cost = null, tokens = null;
  const costLabeled = text.match(/(?:total\s*cost|cost|api\s*cost)[^\n$]*\$\s*([0-9]+(?:\.[0-9]+)?)/i);
  const costAny = text.match(/\$\s*([0-9]+\.[0-9]{2,})/);
  if (costLabeled) cost = parseFloat(costLabeled[1]);
  else if (costAny) cost = parseFloat(costAny[1]);

  const tokMatches = [...text.matchAll(/([0-9][0-9,]*)\s*tokens?/gi)]
    .map(m => parseInt(m[1].replace(/,/g, ''), 10))
    .filter(n => Number.isFinite(n));
  if (tokMatches.length) tokens = Math.max(...tokMatches);

  return { cost, tokens };
}

function agentDone(cardId, code, emitSSE) {
  const info = activeAgents.get(cardId);
  if (!info) return;
  activeAgents.delete(cardId);
  removePid(cardId);

  if (info.watchInterval) clearInterval(info.watchInterval);
  if (info.timeoutId) clearTimeout(info.timeoutId);

  let usage = { cost: null, tokens: null };
  if (info.outputFile) {
    try {
      const raw = fs.readFileSync(info.outputFile, 'utf8');
      const text = stripAnsi(raw).trim();
      if (text) {
        usage = parseUsage(text);
        const MAX = 3000;
        const snippet = text.length > MAX ? '[\u2026output truncated, showing last 3000 chars]\n' + text.slice(-MAX) : text;
        addCardNote(cardId, `Agent session output (exit ${code}):\n\`\`\`\n${snippet}\n\`\`\``);
      }
    } catch (_) {}
    try { fs.unlinkSync(info.outputFile); } catch (_) {}
  }

  const duration = Math.round((Date.now() - new Date(info.startTime).getTime()) / 1000);

  // If the agent used a worktree but made no commits, clean it up so the card
  // doesn't show a stale branch, ! merge badge, or enabled merge button.
  if (info.worktreePath) {
    try {
      const base = wt.getBaseBranch(info.workspacePath);
      const commits = wt.getCommits(info.worktreePath, base);
      const diff = commits ? wt.getDiff(info.worktreePath, base) : '';
      if (!commits || !diff.trim()) {
        wt.removeWorktree(info.workspacePath, info.worktreePath);
        updateCard(cardId, { branch: null, worktreePath: null, has_branch_changes: false });
        process.stderr.write(`[agent] Worktree removed — no file changes for card ${cardId}\n`);
      } else {
        updateCard(cardId, { has_branch_changes: true });
      }
    } catch (_) {}
  }

  // Sanity check: if the workspace uses a worktree, verify the workspace root
  // is clean. Agent writes leaking outside the worktree should be visible here.
  if (info.worktreePath) {
    try {
      const status = execSync('git status --porcelain', {
        cwd: info.workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }).toString().trim();
      if (status) {
        const msg = `Worktree leak detected: workspace root (${info.workspacePath}) has dirty files after agent completed:\n${status.slice(0, 2000)}`;
        process.stderr.write(`[agent_warning] ${msg}\n`);
        addAgentLog(info.workspaceId, info.agentType, 'agent_warning', msg, cardId);
        addCardNote(cardId, `[WARN] ${msg}`);
      }
    } catch (_) {
      // git not available or not a repo; skip check silently
    }
  }

  // Persist the run outcome on the card so it survives refresh (shown as a badge).
  updateCard(cardId, {
    last_exit_code: code,
    last_duration: duration,
    last_cost: usage.cost,
    last_tokens: usage.tokens,
  });

  const status = code === 0 ? 'completed' : 'failed';
  addAgentLog(info.workspaceId, info.agentType, `agent_${status}`,
    `${info.agentType} ${status} for card ${cardId} (${duration}s, exit ${code})`, cardId);
  emitSSE('agent_completed', { cardId, agentType: info.agentType, code, duration, cost: usage.cost, tokens: usage.tokens });

  // Free capacity may now let a queued agent start.
  dequeueNext(emitSSE);

  // If this card has queued respawns (e.g. agent moved itself to Review while
  // the previous agent was running), start the next queued phase now.
  if (pendingRespawn.has(cardId)) {
    const queue = pendingRespawn.get(cardId);
    const pending = queue.shift();
    if (queue.length === 0) pendingRespawn.delete(cardId);
    if (pending) spawnAgent(cardId, pending.workspaceId, pending.agentType, emitSSE, undefined, pending.skipPermissionsOverride);
  }
}

function stopAgent(cardId, emitSSE) {
  // Cancel any pending debounced spawn for this card.
  cancelScheduledSpawn(cardId);

  // Drop it from the queue first, in case it was waiting rather than running.
  let dequeued = false;
  if (isQueued(cardId)) {
    dequeueCard(cardId);
    dequeued = true;
    const card = getCard(cardId);
    if (card) {
      addAgentLog(card.workspace_id, card.agent || 'system', 'agent_cancelled', `Cancelled queued agent for card ${cardId}`, cardId);
      if (emitSSE) emitSSE('agent_cancelled', { cardId });
    }
  }

  // Clear any pending respawn — the user explicitly stopped this card.
  pendingRespawn.delete(cardId);

  const info = activeAgents.get(cardId);
  if (!info) return dequeued;
  if (info.watchInterval) clearInterval(info.watchInterval);
  if (info.timeoutId) clearTimeout(info.timeoutId);
  // Unpipe first so the dying grandchild can't write to a closed stream,
  // then kill the process tree (taskkill /T on Windows, kill on POSIX),
  // then destroy the output stream to release the file handle immediately.
  try { info.child?.stdout?.unpipe(); } catch (_) {}
  try { info.child?.stderr?.unpipe(); } catch (_) {}
  killProcessTree(info.child);
  try { info.outStream?.destroy(); } catch (_) {}
  activeAgents.delete(cardId);
  removePid(cardId);
  addAgentLog(info.workspaceId, info.agentType, 'agent_stopped', `Stopped agent for card ${cardId}`, cardId);
  return true;
}

// Best-effort kill of every running agent's child process, used on server
// shutdown so agents don't outlive the server. Synchronous (no SSE/requeue) —
// the process is exiting. Note: with shell:true this kills the shell; a deeply
// nested grandchild may survive on some platforms, but the common case is covered.
function killAllAgents() {
  for (const info of activeAgents.values()) {
    if (info.watchInterval) clearInterval(info.watchInterval);
    if (info.timeoutId) clearTimeout(info.timeoutId);
    try { info.child?.stdout?.unpipe(); } catch (_) {}
    try { info.child?.stderr?.unpipe(); } catch (_) {}
    killProcessTree(info.child);
    try { info.outStream?.destroy(); } catch (_) {}
  }
  activeAgents.clear();
  agentQueue.length = 0;
  pendingRespawn.clear();
  // Also kill agents spawned by other process instances (e.g. MCP subprocesses)
  // that aren't in this process's activeAgents map.
  killAllRegisteredPids();
}

function isAgentRunning(cardId) {
  return activeAgents.has(cardId);
}

function isAgentActive(cardId) {
  return activeAgents.has(cardId) || isQueued(cardId);
}

function getRunningCardIds() {
  return Array.from(activeAgents.keys());
}

function isPendingRespawn(cardId) {
  return pendingRespawn.has(cardId);
}

function getPendingRespawnCardIds() {
  return Array.from(pendingRespawn.keys());
}

module.exports = { spawnAgent, scheduleSpawn, cancelScheduledSpawn, agentDone, stopAgent, killAllAgents, isAgentRunning, isAgentActive, getRunningCardIds, getQueuedCardIds, getPendingRespawnCardIds, isPendingRespawn, getOutputFile, buildShellCmd, isSafeModel, parseUsage, buildPrompt, isQueued };
