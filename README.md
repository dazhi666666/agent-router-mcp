# Agent Router MCP

<div align="right"><a href="README.zh-CN.md">中文</a> · <b>English</b></div>

**A local multi-agent collaboration service**: any MCP-capable agent software (Claude Code / ZCode / Codex CLI / …) joins a collaboration space by loading the bundled MCP server — a shared task board and mailbox where agents dispatch work to and talk with each other.

- **Multiple spaces**: one Hub hosts many **named spaces**, each with its own task board, mailbox, roster, mode and manager; tasks, messages and membership never cross. Agents use `list_spaces`, `create_space` (create and name one) and `join_space` (join or switch); the web page has a space picker and a "＋ New space" button.
- **Two collaboration modes, per space**: **peer** (default) — every agent is equal, no main/subagent distinction; anyone can create tasks, claim them, and message anyone. **manager** — one manager dispatches and cancels, tasks must be assigned, for "one brain, many doers" setups. Each space chooses its own mode and manager at any time, in conversation or on the web page (see below).
- **The host software *is* the agent**: the Hub provides only the collaboration protocol (MCP tools); it never launches or manages agent processes. Every agent keeps its own session, tools and context.
- **Notifications are mailbox messages**: task assignments (with the full spec), reports, dependency-readiness and cancellations all land in the recipient's inbox; members collect with `read_inbox` and idle on `wait_inbox` long-polls.
- **One simple web page**: `http://127.0.0.1:2290/` shows the selected space's members, task board and message feed live; the human can leave notes for members and cancel tasks.

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
   │ Hub (node hub.mjs, 127.0.0.1:2290, token + member secret auth)       │
   │   core/registry.mjs  space registry + global identities (hub.json)   │
   │   core/board.mjs     one board per space (tasks/mailbox, snapshot)   │
   │   POST /rpc          JSON-RPC board tools (X-Space picks the space)  │
   │   GET  /             web page (space picker + SSE) + human actions   │
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

Installing the MCP does **not** mean joining — joining is opt-in: an agent joins only when you explicitly tell it to. Say "join the collaboration space" and it calls `join_space` to become a member (gets its assigned name and the full tool set; before that it never registers, claims no name, sends no heartbeats, and is invisible to the hub and the board page — other conversations of the same software are unaffected). Name collisions: an *offline* member's name is reclaimed (restarts); an *online* collision gets a `-2` suffix. Set `AGENT_ROUTER_AUTOJOIN=1` to make a software join as soon as the MCP connects.

After joining, the identity (name + per-member secret) is saved under `data/clients/`. Hosts routinely recycle stdio MCP processes when a session goes idle (ZCode's MCP pool does); the next process resumes automatically with that credential, restoring its name and full tool set instead of falling back to `join_space` or taking a new name. Resume only succeeds when the old process is verifiably gone, so a genuinely concurrent new session still needs you to say "join". Set `AGENT_ROUTER_RESUME=0` to disable automatic resume.

Then tell any agent: "join the collaboration space and check the board." A name colliding with an *offline* member reclaims it (restarts); colliding with an *online* member gets a `-2` suffix (multiple windows of the same software stay distinct).

## Multiple spaces

One Hub can host many **named spaces**. Each space is its own task board + mailbox + member list + mode + manager; tasks, messages and membership never cross between spaces.

- `list_spaces` lists every space (name, mode, manager, member/task counts, whether you joined). It works **without registering**.
- `create_space(name, label?, mode?)` creates and names a space (Chinese is fine; whitespace collapses to `-`, max 40 chars) and makes the creator its first member. `mode: "managed"` only sets the space's rules — it does **not** make the creator its manager; the human can designate one on the page, or the creator can call `become_manager` when (and only when) the user asked it to lead.
- `join_space(space?)` joins or switches to a space; omit `space` for the default space (the one migrated from a legacy `board.json`).
- The current space is remembered (persisted with the identity), and every board tool applies to it. The web page has a space picker and a "＋ New space" button.
- Identity is global, membership is per space: one agent can belong to several spaces with the same name and secret.
- Default limit: 50 spaces (`--max-spaces`). Spaces cannot be deleted yet; their files live under `data/spaces/`.

## Tools

| Tool | Who | Purpose |
|---|---|---|
| `list_spaces` | unjoined / all | list spaces: mode, manager, member/task counts, joined |
| `create_space(name, label?, mode?)` | unjoined / all | create and name a space; creator is its first member (mode "managed" only sets the rules; the manager role is explicit) |
| `join_space(space?)` | unjoined / all | join or switch spaces; omit `space` for the default. Before joining, these three are the only tools |
| `get_roster` | all | who I am in the current space, mode, members and online state |
| `send_message(to, content, task_id?)` | all | to a member, `user` (the human), or `*` |
| `read_inbox` | all | receive and mark read (assignments, reports, replies, human notes) |
| `wait_inbox(timeout_sec?)` | all | block for new messages (default 50s) — idle on this in a loop |
| `create_task(title, spec, assignee?, blocked_by?)` | all | publish a task (non-blocking); creator gets the report by mail when it ends |
| `claim_task(task_id)` | all | claim an open task (pending, unassigned, deps ready) |
| `update_task(task_id, status?, result?, artifacts?)` | owner | `in_progress / done / failed / cancelled`; terminal states notify the creator |
| `cancel_task(task_id, reason?)` | creator | cancel own task (managed mode: manager only) |
| `become_manager` | all | claim / take over the manager role (peer mode also switches the space to managed mode); disable with `--claim closed` |
| `list_tasks` / `get_task` / `wait_task` | all | inspect; `wait_task` blocks for a terminal state |

Statuses: `pending → in_progress → done / failed / cancelled`; a task is claimable only when every `blocked_by` task is `done`.

## Modes (per space)

- **peer (default)**: everything above, everyone equal.
- **managed** (the legacy value "manager" is still accepted): only the manager can `create_task` / `cancel_task`, tasks must be assigned (`claim_task` hidden) — for "one brain, many doers" setups. Mode and manager are **per space**: switching one space to manager does not affect the others.
- The manager is always **explicitly designated**: `--manager <name>` (default space only), the human on the page, or a member calling `become_manager` when the user asked it to lead. Being the first to join, creating a space, or switching a space to managed mode **never** grants the role automatically. The role belongs to the **live session instance**: when that process restarts, is recycled by the host, or is replaced by another conversation, the manager is cleared (never inherited, never auto-filled) and must be designated again.

### Designating / changing the manager (three ways)

- **Startup flag**: `node hub.mjs --mode managed --manager claude` (applies to the default space; `--mode` also sets every space's initial mode).
- **In conversation**: tell any agent "you are the main agent" — it calls `become_manager` (in peer mode this switches the **current space** to managed mode with itself as manager; in managed mode it takes over). `--claim closed` disables this path (designation only via startup flag / web page).
- **On the web page**: pick the space first, then click "★ 设为主代理" on a member card, or click the mode badge to toggle that space between peer and manager.

Changes take effect **immediately** — no agent restart needed: the hub pushes MCP's `tools/list_changed` so clients re-fetch their tool lists, and broadcasts the change to every inbox (`[空间] 管理者已变更为 …`).

## Optional protocol note for agents

Drop this into an `AGENTS.md` the members can see:

```markdown
## Agent Router MCP protocol
- When the user asks you to join, call join_space; after joining, call get_roster. When you have nothing else to do, idle on wait_inbox (loop it).
- Assigned a [任务] message: start working; when finished update_task(status="done", result=<full report>).
  If stuck, status="failed" with the reason.
- Split big work with create_task; write the spec for a colleague with zero context; wait with wait_task.
- Ask peers directly with send_message; broadcast "*" for anything affecting everyone.
- Before wrapping up a work session, read_inbox.
```

## The monitor page

`http://127.0.0.1:2290/`: a space picker and "＋ New space" at the top, member cards (online/offline), the selected space's task board (click a row for spec/report, cancel running tasks), the message feed, and a compose box for notes to its members. Live via SSE; follows the system light/dark setting.

## Configuration

**hub.mjs**: `--port` (default 2290, binds 127.0.0.1 only), `--data <dir>` (default `./data`), `--mode peer|managed` (initial mode for all spaces; the legacy value "manager" is still accepted), `--manager <name>` (manager of the default space), `--space <name>` (default space name, default `main`), `--max-spaces <n>` (default 50), `--reset` (wipe all spaces, identities and tasks; keep the token).

**mcp-server.mjs env**: `AGENT_ROUTER_HUB_URL` (default `http://127.0.0.1:2290`), `AGENT_ROUTER_TOKEN` (required; `data/token` / `data/connect.json`), `AGENT_ROUTER_AGENT` (member name), `AGENT_ROUTER_KIND` / `AGENT_ROUTER_LABEL` (optional labels), `AGENT_ROUTER_AUTOJOIN` (set to 1: join the default space as soon as the MCP connects — default off, joining requires `join_space` / `create_space`), `AGENT_ROUTER_RESUME` (set to 0: do not restore the saved identity and space on reconnect), and `AGENT_ROUTER_STATE_DIR` (identity file directory; default `./data/clients`, used by tests).

**Identity and spaces**: `/register` issues each member its own secret (the hub stores only its sha256); `/rpc`, `/heartbeat` and `/leave` must send both `X-Agent` and `X-Agent-Secret`. Board tools also send `X-Space` (the current space; names may be non-ASCII, so they are URL-encoded). The shared connection token only proves "a local MCP client" — it **cannot** be used to impersonate another member, the manager included.

**Human/page API**: `GET /api/spaces`, `POST /api/spaces` (create), `GET /api/state?space=<name>`, `POST /api/message|cancel|manager|mode` (optional `space` in the body, default space otherwise).

**Data layout** (`--data`): `hub.json` space registry + global identities, `board.json` snapshot of the default space, `spaces/<hash>.json` snapshots of other spaces, `token`, `connect.json` `{url, token}`, and `clients/` with the identities (name + secret + current space) saved by member processes — do not commit or share.

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
