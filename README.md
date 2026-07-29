<div align="center">

# ⚡ VibeBoard

### The kanban board that runs your AI coding agents.

Move a card to **In Progress** → VibeBoard spawns Claude Code, OpenCode, or Codex
in your repo, hands it the task, and streams its progress back to the board in
real time. You and your agents drive the same board - through the UI and through
MCP - at the same time.

[![npm](https://img.shields.io/npm/v/@zanuartri/vibeboard?color=5e6ad2&label=npm)](https://www.npmjs.com/package/@zanuartri/vibeboard)
[![license](https://img.shields.io/badge/license-MIT-5e6ad2)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-5e6ad2)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-5e6ad2)](CONTRIBUTING.md)

```bash
npx @zanuartri/vibeboard
```

</div>

---

## Why VibeBoard

AI coding agents are great at *doing the work* - but you still need somewhere to
**plan it, track it, and watch it happen.** Chat windows aren't that place.

VibeBoard makes a kanban board the control surface for your agents:

- **You** plan on the board like normal - columns, cards, priorities, tags, due dates.
- **Move a card to "In Progress"** and the assigned agent launches *in your project
  directory* with the card as its brief.
- **The agent** reports back through MCP tools - posting checkpoints, moving its
  own card, opening a PR - so the board is always the source of truth.

It's local-first, self-hosted, and dependency-free to run. One command, no account,
no cloud.

## Demo

> _Screenshots / GIF coming soon._ Run `npx @zanuartri/vibeboard` and open
> **http://localhost:7341** to try it in under a minute.

```text
  Backlog            In Progress              Review            Done
 ┌──────────┐      ┌────────────────┐      ┌──────────┐     ┌──────────┐
 │ Fix login│      │ Add OAuth   ⚡ │      │ Refactor │     │ Landing  │
 │ Add tests│  →   │ ● agent running│  →   │ db layer │  →  │ page  ✓ │
 └──────────┘      └────────────────┘      └──────────┘     └──────────┘
                     ↑ card moved here → Claude Code spawned in ./my-repo
```

## Quick start

```bash
# Run instantly (no install)
npx @zanuartri/vibeboard

# …or install the CLI globally
npm install -g @zanuartri/vibeboard
vibeboard
```

Then open **http://localhost:7341**, create a workspace pointing at a project
directory, and start adding cards.

Prefer to hack on it?

```bash
git clone https://github.com/zanuartri/vibeboard.git
cd vibeboard && npm install && npm start
```

> **Requirements:** Node.js 18+. VibeBoard uses
> [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), which ships
> prebuilt binaries for common platforms - most installs need no compiler. On an
> unsupported platform/Node it builds from source (needs standard build tools).

## How it works

```
   ┌─────────────┐         move card to "In Progress"         ┌──────────────┐
   │   You (UI)  │ ───────────────────────────────────────►   │   VibeBoard  │
   └─────────────┘                                             │   server     │
          ▲                                                    └──────┬───────┘
          │ live SSE updates (notes, status, moves)                   │ spawns
          │                                                           ▼
   ┌──────┴───────┐         MCP tools (get_board, move_card,   ┌──────────────┐
   │  The board   │ ◄────── add_card_note, complete_card …) ── │  Agent in    │
   │ (shared)     │                                            │  your repo   │
   └──────────────┘                                            └──────────────┘
```

1. **Create a workspace** - link a project directory. VibeBoard detects the git
   repo and can isolate each agent in its own **git worktree / branch**.
2. **Add a card** - title, description, tags, priority, due date, and an agent
   (Claude Code, OpenCode, or Codex CLI).
3. **Move it to In Progress** - the agent spawns in your repo with full card
   context and starts working autonomously.
4. **Watch it live** - the agent posts checkpoints, you stream its output, and
   the card shows run status, duration, and cost when it finishes.
5. **Ship it** - review the diff in the card, then **Merge** or **Create PR**
   right from the board.

## Features

- ⚡ **Auto-spawn agents** - moving a card to In Progress launches its assigned
  agent in your project directory. No copy-pasting prompts.
- 🛂 **Per-task permission choice** - every manual move to In Progress/Review
  (drag, sidebar, or Run agent) asks whether to skip permission prompts for
  that run, pre-filled from the workspace default. Turn it off to have the
  agent stop and wait on its normal tool-use approvals instead of running
  fully unattended.
- 🔄 **Bidirectional MCP** - you and the agent control the same board in real
  time. Agents read state, post progress, move cards, and mark work done.
- 🧵 **Git worktree isolation** - each agent works on its own branch; review the
  diff and merge or open a PR from the card.
- 📊 **Run visibility** - live output stream, agent checkpoints, plus exit code,
  duration, and token/cost per run.
- 🚦 **Flow controls** - WIP limits per column, card dependencies (`blocked_by`),
  and a concurrency cap with an automatic agent queue.
- 🗂️ **Multiple workspaces** - one board per project, switch instantly.
- 🎨 **ClickUp-inspired UI** - clean white surfaces, colorful column accents, vibrant workspace icons, skeleton loading, full light & dark theme.
- 🔒 **Local-first** - SQLite on your machine. No cloud, no account, no tracking.

## Connect your agents

Open the in-app **MCP Setup** dialog to auto-configure each agent's global MCP
config in one click - or wire them up manually:

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add -s user vibeboard -- node /path/to/vibeboard/mcp-server/index.js
```
(The repo's `.claude/mcp.json` is also auto-detected when working inside it.)
</details>

<details>
<summary><b>OpenCode</b></summary>

```json
{
  "mcp": {
    "vibeboard": { "type": "local", "command": ["node", "/path/to/vibeboard/mcp-server/index.js"] }
  }
}
```
</details>

<details>
<summary><b>Codex CLI</b></summary>

Add a `vibeboard` entry under `mcpServers` in `~/.codex/config.json`:
```json
{ "mcpServers": { "vibeboard": { "command": "node", "args": ["/path/to/vibeboard/mcp-server/index.js"] } } }
```
</details>

### MCP tools agents can call

`get_board` · `get_column` · `list_cards` · `search_cards` ·
`list_workspaces` · `create_workspace` · `switch_workspace` · `set_workspace` ·
`create_card` · `update_card` · `move_card` · `complete_card` · `delete_card` ·
`add_card_note` · `get_card_notes` · `get_agent_status` ·
`list_models` · `refresh_models` · `list_templates` · `create_template`

`get_board` supports `columnsOnly`, `excludeLogs`, and `columnTitle` filters to reduce payload size. `search_cards` and `list_cards` support `limit`/`offset` pagination.

## Configuration

All optional - set as environment variables (a `.env` file works too):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7341` | HTTP/UI port. |
| `VB_HOST` | `127.0.0.1` | Bind address. Loopback only by default. |
| `VB_TOKEN` | _(random)_ | Shared token required for **remote** clients when `VB_HOST` is non-loopback. Auto-generated and printed at startup if unset. |
| `VB_MAX_AGENTS` | `3` | Max agents running at once; extra spawns are queued. |
| `AGENT_TIMEOUT_MS` | `1800000` | Per-agent run timeout (30 min). |

> ⚠️ **Network exposure is opt-in and powerful.** Agents run with elevated
> permissions in your project directories. When `VB_HOST` is non-loopback,
> VibeBoard requires a token for off-machine requests - open it via
> `http://<host>:7341/?token=<token>`. Only expose it on a trusted network. See
> the [security notes](#security) before exposing anything.

## Data & storage

Everything lives in a local SQLite database:

- **Windows:** `%APPDATA%\vibeboard\vibeboard.db`
- **macOS:** `~/Library/Application Support/vibeboard/vibeboard.db`
- **Linux:** `~/.local/share/vibeboard/vibeboard.db`

Export/import any workspace as JSON from its settings.

## Security

VibeBoard spawns coding agents with permissions skipped so they can work
unattended - so **only point it at projects you trust**, and keep it on
loopback unless you've read the network notes above. Mutating requests are
guarded against CSRF / DNS-rebinding, and agents are terminated on server
shutdown. It's early software (pre-1.0); review before using on sensitive code.

## Architecture

No build step. Plain Node.js (CommonJS) server, plain HTML/CSS/vanilla-JS client.

```
mcp-server/   Node server - index.js wires http-routes.js (REST+SSE),
              mcp-tools.js (MCP), agent.js (spawn/queue), worktree.js,
              db.js (SQLite), auth.js, events.js, models.js, migrate.js
public/       index.html + styles.css + ordered js/*.js classic scripts
              (no bundler), and landing.html
```

See [`DESIGN.md`](DESIGN.md) for the UI design system and [`CLAUDE.md`](CLAUDE.md)
/ [`AGENTS.md`](AGENTS.md) for agent-facing context.

## Contributing

Contributions are welcome - see [`CONTRIBUTING.md`](CONTRIBUTING.md). In short:
fork → branch → `npm test` → PR. Please keep Windows/macOS/Linux compatibility,
don't break MCP tool signatures, and stay backward-compatible with existing
workspaces.

See [`CHANGELOG.md`](CHANGELOG.md) for release history.

## License

[MIT](LICENSE) © VibeBoard contributors
