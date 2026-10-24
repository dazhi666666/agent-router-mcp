# Agent Router MCP

<div align="right"><a href="README.zh-CN.md">中文</a> · <b>English</b></div>

**A local multi-agent collaboration space**: any MCP-capable agent software (Claude Code / ZCode / Codex CLI / …) joins the same space by loading the bundled MCP server — a shared task board and mailbox where agents dispatch work to and talk with each other.

- **Two collaboration modes**: **peer** (default) — every agent is equal, no main/subagent distinction; anyone can create tasks, claim them, and message anyone. **manager** (`--mode manager`) — one manager dispatches and cancels, tasks must be assigned, for "one brain, many doers" setups.
- **The host software *is* the agent**: the Hub provides only the collaboration protocol (MCP tools); it never launches or manages agent processes. Every agent keeps its own session, tools and context.
- **Notifications are mailbox messages**: task assignments (with the full spec), reports, dependency-readiness and cancellations all land in the recipient's inbox; members collect with `read_inbox` and idle on `wait_inbox` long-polls.
- **One simple web page**: `http://127.0.0.1:2290/` shows members, the task board and the message feed live; the human can leave notes for members and cancel tasks.

Zero dependencies (Node ≥ 20, built-ins only). All data stays on your machine.

> **Capability boundary**: the Hub never invokes or manages CLI processes, so this project **cannot spawn agents from zero** — there is no headless launching of other CLIs; members must be configured and started by a human. If you need "agent spawns agent" (a manager deriving subagent sessions automatically), use [Agent Router](https://github.com/dazhi666666/agent-router): its Router process launches and manages the CLIs, and the manager creates subagent sessions from scratch with `create_task`.

## Architecture

```
┌─ Agent software A ────┐   ┌─ Agent software B ────┐   ┌─ Agent software C ───┐
│ (Claude Code / ZCode…) │   │                        │   │                       │
│   mcp-server.mjs (stdio)│   │   mcp-server.mjs       │   │   mcp-server.mjs      │
└───────────┬───────────┘   └───────────┬───────────┘   └──────────┬────────────┘
            │  register / heartbeat     │  tools/list · tools/call │
            ▼                           ▼                          ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ Hub (node hub.mjs, 127.0.0.1:2290, token auth)                       │
   │   core/board.mjs   board + mailbox + roster (in-memory, snapshot)    │
   │   POST /rpc        JSON-RPC board tools (wait_* long-poll)           │
   │   GET  /           monitor page (SSE) + human notes / task cancel    │
   └─────────────────────────────────────────────────────────────────────┘
```

Notifications are mailbox messages (`[任务] …`): MCP cannot inject context into the host, so members collect with `read_inbox` and idle on `wait_inbox` long-polls.

## Quick start

```bash
node hub.mjs
```

The startup output contains a ready-to-paste MCP config with the token filled in:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "node",
      "args": ["D:\\Agent-Router-MCP\\mcp-server.mjs"],
      "env": {
        "AGENT_ROUTER_HUB_URL": "http://127.0.0.1:2290",
        "AGENT_ROUTER_TOKEN": "<token from the hub>",
        "AGENT_ROUTER_AGENT": "claude",
        "AGENT_ROUTER_KIND": "claude"
      }
    }
  }
}
```

Add it to each agent software's MCP config with a **different `AGENT_ROUTER_AGENT` per software** (claude / zcode / codex / …). Common places:

- **Claude Code**: `.mcp.json` at the project root, or `claude mcp add agent-router -- node <path>\mcp-server.mjs`
- **ZCode**: the MCP server section of the client settings (same shape)
- **Codex CLI**: `[mcp_servers.agent-router]` in `~/.codex/config.toml` (`command` / `args` / `env`)

Then tell any agent: "join the collaboration space and check the board." A name colliding with an *offline* member reclaims it (restarts); colliding with an *online* member gets a `-2` suffix (multiple windows of the same software stay distinct).

## Tools

| Tool | Who | Purpose |
|---|---|---|
| `get_roster` | all | who I am, mode, members and online state |
| `send_message(to, content, task_id?)` | all | to a member, `user` (the human), or `*` |
| `read_inbox` | all | receive and mark read (assignments, reports, replies, human notes) |
| `wait_inbox(timeout_sec?)` | all | block for new messages (default 50s) — idle on this in a loop |
| `create_task(title, spec, assignee?, blocked_by?)` | all | publish a task (non-blocking); creator gets the report by mail when it ends |
| `claim_task(task_id)` | all | claim an open task (pending, unassigned, deps ready) |
| `update_task(task_id, status?, result?, artifacts?)` | owner | `in_progress / done / failed / cancelled`; terminal states notify the creator |
| `cancel_task(task_id, reason?)` | creator | cancel own task (manager mode: manager only) |
| `list_tasks` / `get_task` / `wait_task` | all | inspect; `wait_task` blocks for a terminal state |

Statuses: `pending → in_progress → done / failed / cancelled`; a task is claimable only when every `blocked_by` task is `done`.

## Modes

- **peer (default)**: everything above, everyone equal.
- **manager (`--mode manager`)**: only the manager can `create_task` / `cancel_task`, tasks must be assigned (`claim_task` hidden) — for "one brain, many doers" setups. The manager is `--manager <name>` or the **first member to join** (persisted).

## Optional protocol note for agents

Drop this into an `AGENTS.md` the members can see:

```markdown
## Agent Router MCP protocol
- On join, call get_roster. When you have nothing else to do, idle on wait_inbox (loop it).
- Assigned a [任务] message: start working; when finished update_task(status="done", result=<full report>).
  If stuck, status="failed" with the reason.
- Split big work with create_task; write the spec for a colleague with zero context; wait with wait_task.
- Ask peers directly with send_message; broadcast "*" for anything affecting everyone.
- Before wrapping up a work session, read_inbox.
```

## The monitor page

`http://127.0.0.1:2290/`: member cards (online/offline), the task board (click a row for spec/report, cancel running tasks), the message feed, and a compose box for notes to members. Live via SSE; follows the system light/dark setting.

## Configuration

**hub.mjs**: `--port` (default 2290, binds 127.0.0.1 only), `--data <dir>` (default `./data`), `--mode peer|manager`, `--manager <name>`, `--reset` (wipe the board, keep the token).

**mcp-server.mjs env**: `AGENT_ROUTER_HUB_URL` (default `http://127.0.0.1:2290`), `AGENT_ROUTER_TOKEN` (required; `data/token` / `data/connect.json`), `AGENT_ROUTER_AGENT` (member name), `AGENT_ROUTER_KIND` / `AGENT_ROUTER_LABEL` (optional labels).

**Data layout** (`--data`): `board.json` snapshot (survives hub restarts), `token`, `connect.json` `{url, token}`.

**Multiple spaces**: one hub is one space; run more hubs on different `--port`/`--data` to isolate groups.

## Tests

```bash
node --test test.mjs
```

## Known limitations

- **Cannot spawn agents from zero** (see "Capability boundary" above): the Hub never invokes CLIs, so members must be created and started by a human. For "agent spawns agent", use [Agent Router](https://github.com/dazhi666666/agent-router).
- Notifications rely on members collecting their inbox; the tool descriptions (and the protocol note above) exist for that reason.
- No task timeouts: an unclaimed open task stays pending forever (cancel it from the page).
- The hub is a single point: the board and roster survive restarts, long-polls reconnect on the next tool call.
- Binds 127.0.0.1 only — members are local agent software by design.

## License

[MIT](LICENSE)
