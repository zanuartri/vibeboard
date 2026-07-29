'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// agent.js transitively requires db.js — point it at a throwaway DB so requiring
// the module never touches the real one.
const TMP_DB = path.join(os.tmpdir(), `vb-agent-test-${Date.now()}.db`);
process.env.VB_DB_PATH = TMP_DB;

const { buildShellCmd, isSafeModel, parseUsage, buildPrompt } = require('../mcp-server/agent');

test.after?.(() => { try { fs.unlinkSync(TMP_DB); } catch (_) {} });

// ── isSafeModel ───────────────────────────────────────────────────────────────

test('isSafeModel accepts well-formed model ids', () => {
  assert.equal(isSafeModel('claude-opus-4-8'), true);
  assert.equal(isSafeModel('anthropic/claude-sonnet-4-6'), true);
  assert.equal(isSafeModel('gpt-5-codex'), true);
  assert.equal(isSafeModel('opencode/grok-code-fast-1'), true);
});

test('isSafeModel rejects shell metacharacters and bad types', () => {
  assert.equal(isSafeModel('model; rm -rf /'), false);
  assert.equal(isSafeModel('model$(whoami)'), false);
  assert.equal(isSafeModel('model && echo pwned'), false);
  assert.equal(isSafeModel('model`id`'), false);
  assert.equal(isSafeModel(''), false);
  assert.equal(isSafeModel(undefined), false);
  assert.equal(isSafeModel(null), false);
  assert.equal(isSafeModel(42), false);
});

// ── buildShellCmd ─────────────────────────────────────────────────────────────

test('buildShellCmd references the prompt file for each known agent', () => {
  const pf = '/tmp/prompt.txt';
  for (const agent of ['claude-code', 'opencode', 'codex']) {
    const cmd = buildShellCmd(agent, pf);
    assert.ok(cmd.includes(pf), `${agent} command should reference the prompt file`);
  }
});

test('buildShellCmd adds --model flag only for safe models', () => {
  const pf = '/tmp/prompt.txt';
  assert.ok(buildShellCmd('claude-code', pf, 'claude-opus-4-8').includes('--model claude-opus-4-8'));
  assert.ok(buildShellCmd('opencode', pf, 'anthropic/claude-sonnet-4-6').includes('--model anthropic/claude-sonnet-4-6'));
  assert.ok(buildShellCmd('codex', pf, 'gpt-5-codex').includes('--model gpt-5-codex'));
});

test('buildShellCmd drops unsafe model values (no injection)', () => {
  const pf = '/tmp/prompt.txt';
  const cmd = buildShellCmd('claude-code', pf, 'evil; rm -rf /');
  assert.ok(!cmd.includes('rm -rf'), 'unsafe model must not be interpolated into the command');
  assert.ok(!cmd.includes('--model'), 'unsafe model must not produce a --model flag');
});

test('buildShellCmd omits --model when no model given', () => {
  const cmd = buildShellCmd('claude-code', '/tmp/prompt.txt');
  assert.ok(!cmd.includes('--model'));
  assert.ok(cmd.includes('--dangerously-skip-permissions'));
});

test('buildShellCmd defaults to skipping permissions when the flag is omitted', () => {
  assert.ok(buildShellCmd('claude-code', '/tmp/prompt.txt').includes('--dangerously-skip-permissions'));
  assert.ok(buildShellCmd('opencode', '/tmp/prompt.txt').includes('--dangerously-skip-permissions'));
  assert.ok(buildShellCmd('codex', '/tmp/prompt.txt').includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(buildShellCmd('command-code', '/tmp/prompt.txt').includes('--yolo'));
});

test('buildShellCmd drops the skip-permissions flag when explicitly disabled', () => {
  const pf = '/tmp/prompt.txt';
  assert.ok(!buildShellCmd('claude-code', pf, null, false).includes('--dangerously-skip-permissions'));
  assert.ok(!buildShellCmd('opencode', pf, null, false).includes('--dangerously-skip-permissions'));
  assert.ok(!buildShellCmd('codex', pf, null, false).includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!buildShellCmd('command-code', pf, null, false).includes('--yolo'));
  // The prompt file and command should still be present — only the permission flag is dropped.
  assert.ok(buildShellCmd('claude-code', pf, null, false).includes(pf));
});

// ── parseUsage ────────────────────────────────────────────────────────────────

test('parseUsage extracts a labelled cost and token count', () => {
  const { cost, tokens } = parseUsage('Total cost: $0.0123\nUsed 4,500 tokens this session');
  assert.equal(cost, 0.0123);
  assert.equal(tokens, 4500);
});

test('parseUsage returns nulls when nothing recognizable is present', () => {
  const { cost, tokens } = parseUsage('Implemented the feature and committed the changes.');
  assert.equal(cost, null);
  assert.equal(tokens, null);
});

test('parseUsage picks the largest token mention', () => {
  const { tokens } = parseUsage('input 1200 tokens, output 800 tokens, total 2000 tokens');
  assert.equal(tokens, 2000);
});

// ── buildPrompt ───────────────────────────────────────────────────────────────

const fakeCard = { id: 'card-123', title: 'Test', description: '', tags: [], priority: null, due_date: null, custom_prompt: '', requires_review: false };
const fakeColumn = { title: 'In Progress' };
const fakeWorkspace = { id: 'ws-456', path: '/home/user/project' };

test('buildPrompt uses workspace path when no worktree path given', () => {
  const prompt = buildPrompt(fakeCard, fakeColumn, fakeWorkspace, null, null);
  assert.ok(prompt.includes('Work in: /home/user/project'), 'should reference workspace path');
  assert.ok(!prompt.includes('NOT to the workspace root'), 'should not include worktree warning');
});

test('buildPrompt uses worktree path when worktree path is set', () => {
  const prompt = buildPrompt(fakeCard, fakeColumn, fakeWorkspace, 'vb/my-task-a1b2c3d4', '/home/user/project/.vb-worktrees/my-task-a1b2c3d4');
  assert.ok(prompt.includes('Work in: /home/user/project/.vb-worktrees/my-task-a1b2c3d4'), 'should reference worktree path');
  assert.ok(!prompt.includes('Work in: /home/user/project$'), 'should not reference bare workspace path');
});

test('buildPrompt adds worktree isolation warning when worktree path is set', () => {
  const prompt = buildPrompt(fakeCard, fakeColumn, fakeWorkspace, 'vb/my-task-a1b2c3d4', '/home/user/project/.vb-worktrees/my-task-a1b2c3d4');
  assert.ok(prompt.includes('NOT to the workspace root at /home/user/project'), 'should warn against writing to workspace root');
  assert.ok(prompt.includes('git worktree'), 'should mention worktree in warning');
});

test('buildPrompt includes git branch line when branch is set', () => {
  const prompt = buildPrompt(fakeCard, fakeColumn, fakeWorkspace, 'vb/my-task-a1b2c3d4', null);
  assert.ok(prompt.includes('Git branch: vb/my-task-a1b2c3d4'), 'should include branch line');
});

test('buildPrompt omits git branch line when branch is null', () => {
  const prompt = buildPrompt(fakeCard, fakeColumn, fakeWorkspace, null, null);
  assert.ok(!prompt.includes('Git branch:'), 'should not include branch line');
});

test('buildPrompt mentions card ID and workspace ID', () => {
  const prompt = buildPrompt(fakeCard, fakeColumn, fakeWorkspace, null, null);
  assert.ok(prompt.includes('Card ID: card-123'));
  assert.ok(prompt.includes('Workspace ID: ws-456'));
});
