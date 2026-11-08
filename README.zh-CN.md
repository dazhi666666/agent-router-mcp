# Agent Router MCP

<div align="right"><b>中文</b> · <a href="README.md">English</a></div>

**本地多 Agent 协作空间**：任何支持 MCP 的 Agent 软件（Claude Code / ZCode / Codex CLI / Devin / OpenCode / …）加载随附的 MCP 服务，即可加入协作空间，共享任务板与信箱，互相派活与对话。

- **多空间**：一个 Hub 里可以有很多个**命名协作空间**（space），每个空间有自己的任务板、信箱、成员名册、模式和管理者，互相隔离。Agent 用 `list_spaces` 查看、`create_space` 创建并命名、`join_space` 加入或切换；网页顶部也有空间选择器和"＋ 新建空间"。
- **两种协作模式（每个空间独立）**：**平等互联**（peer，默认）——所有 Agent 平权，不区分主代理和子代理，任何人都能发任务、认领、发消息；**管理者模式**——一个管理者负责派活与取消，任务必须指派，适合"一个主脑带一群执行者"。模式和管理者都按空间独立，可随时在对话或网页中指定、更换（见下）。
- **宿主软件自己就是 agent**：Hub 只提供协作协议（MCP 工具），不启动、不管理任何 agent 进程；每个 Agent 保持自己的会话、工具与上下文。
- **通知即信箱**：任务指派（含完整 spec）、完成报告、依赖就绪、取消，都会成为收件人信箱里的一条消息；成员用 `read_inbox` 收、用 `wait_inbox` 长轮询待命。
- **简单监控页**：`http://127.0.0.1:2290/` 实时显示成员、任务板、消息流，人可以在页面上给成员留言、取消任务（human in the loop）。

零依赖（Node ≥ 20，仅 node: 内置模块），全部数据留在本机。

> **能力边界**：本项目的 Hub 不调用、不管理任何 CLI 进程，因此**不能从零拉起 agent**——无法以 headless 模式拉起别家 CLI，成员只能由人配置好 MCP 并启动 Agent 软件后加入。如果你需要"agent 拉起 agent"（管理者自动派生子代理），请使用 [Agent Router](https://github.com/dazhi666666/agent-router)：它的 Router 进程负责拉起并管理各 CLI，manager 调 `create_task` 即可从零创建子代理会话。

## 架构

```
┌─ Agent 软件 A ────────┐   ┌─ Agent 软件 B ────────┐   ┌─ Agent 软件 C ───────┐
│ (Claude Code / ZCode…) │   │                        │   │                       │
│   mcp-server.mjs (stdio)│   │   mcp-server.mjs       │   │   mcp-server.mjs      │
└───────────┬───────────┘   └───────────┬───────────┘   └──────────┬────────────┘
            │  register / heartbeat     │  tools/list · tools/call │
            ▼                           ▼                          ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ Hub（node hub.mjs，127.0.0.1:2290，token + 成员 secret 鉴权）           │
   │   core/registry.mjs  空间注册表 + 全局成员身份（hub.json）               │
   │   core/board.mjs     每个空间一块板：任务 + 信箱 + 成员（board.json 快照）│
   │   POST /rpc          JSON-RPC 板工具（X-Space 选空间；wait_* 长轮询）    │
   │   GET  /             监控页（空间选择器 + SSE 实时）＋ 人类留言 / 取消任务  │
   └─────────────────────────────────────────────────────────────────────┘
```

任务结束通知、指派通知都变成收件人**信箱里的一条消息**（`[任务] …`）——MCP 无法向宿主注入上下文，成员用 `read_inbox` 收、用 `wait_inbox` 长轮询待命。

## 快速开始

```bash
node hub.mjs
```

启动输出里有一段可直接粘贴的 MCP 配置（token 已填好）：

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "node",
      "args": ["D:\\Agent-Router-MCP\\mcp-server.mjs"],
      "env": {
        "AGENT_ROUTER_HUB_URL": "http://127.0.0.1:2290",
        "AGENT_ROUTER_TOKEN": "<hub 生成的 token>",
        "AGENT_ROUTER_AGENT": "claude",
        "AGENT_ROUTER_KIND": "claude"
      }
    }
  }
}
```

把它加进各个 Agent 软件的 MCP 配置，**每个软件用不同的 `AGENT_ROUTER_AGENT` 名字**（如 claude / zcode / codex）。常见位置：

- **Claude Code**：项目根 `.mcp.json`，或 `claude mcp add agent-router -- node D:\Agent-Router-MCP\mcp-server.mjs`（环境变量随后配置）
- **ZCode**：客户端设置里的 MCP 服务器配置（同样格式）
- **Codex CLI**：`~/.codex/config.toml` 的 `[mcp_servers.agent-router]`（`command` / `args` / `env`）

装好 MCP **并不等于加入**——加入是 opt-in 的，agent 只在你明确叫它加入时才会加入。对它说"加入协作空间"，它调用 `join_space` 后才成为成员（拿到分配的名字和完整工具集；在此之前它不注册、不占名、不心跳，Hub 和监控页上都看不到它，同一软件的其他对话完全不受影响）。重名规则：与**离线**成员重名会复用其名字（重启场景），与**在线**成员重名自动加后缀（`claude-2`）。想让某个软件装上即自动加入，设 `AGENT_ROUTER_AUTOJOIN=1`。

加入成功后，身份（名字 + 每成员 secret）会落盘到 `data/clients/`。宿主软件常会在会话空闲时回收 MCP 进程（ZCode 的 MCP 池就会这样做）；新进程启动后会自动带凭据 resume，恢复原名、当前空间和完整工具表，不会退回 `join_space`，也不会因为重新加入而改名。resume 只在旧进程可判定已退出时成功，所以并发的另一个会话仍需要你明确说"加入"；设 `AGENT_ROUTER_RESUME=0` 可关闭自动恢复。

## 多空间

一个 Hub 可以托管多个**命名空间**（space）。每个空间是独立的任务板 + 信箱 + 成员列表 + 模式 + 管理者；任务、消息、成员资格都不跨空间。

- `list_spaces`：列出所有空间（名字、模式、管理者、成员/任务数、是否已加入）。这个工具**不需要注册**也能用。
- `create_space(name, label?, mode?)`：创建并命名一个空间（中文可以；空白会折叠成 `-`，最长 40 字）；创建者自动成为第一个成员。`mode: "manager"` 时创建者就是该空间的管理者。
- `join_space(space?)`：加入或切换到某个空间；省略 `space` 就是默认空间（旧版 `board.json` 迁移过来的那个）。
- 加入/创建/切换后，agent 的当前空间会记住（落盘），板工具（`create_task`、`read_inbox`…）都只作用于当前空间。网页顶部可以切换查看哪个空间，也可以"＋ 新建空间"。
- 成员身份是全局的：同一个 agent 可以同时属于多个空间，名字和 secret 不变；每个空间的管理者、模式和任务独立。
- 默认上限 50 个空间（`--max-spaces`）。空间暂不支持删除；数据文件都在 `data/spaces/` 下，可手动归档。

## 工具一览

| 工具 | 谁可用 | 作用 |
|---|---|---|
| `list_spaces` | 未加入 / 所有成员 | 列出所有空间：模式、管理者、成员/任务数、是否已加入 |
| `create_space(name, label?, mode?)` | 未加入 / 所有成员 | 创建并命名一个空间，创建者成为第一个成员（manager 模式下是管理者） |
| `join_space(space?)` | 未加入 / 所有成员 | 加入 / 切换空间；省略 `space` 为默认空间。加入前工具表里只有这三个空间工具 |
| `get_roster` | 所有成员 | 当前空间里我是谁、模式、成员与在线状态 |
| `send_message(to, content, task_id?)` | 所有成员 | 发给某成员 / `user`（人类）/ `*`（广播） |
| `read_inbox` | 所有成员 | 收信并标记已读（指派通知、任务报告、同伴消息、人类留言） |
| `wait_inbox(timeout_sec?)` | 所有成员 | 阻塞等新消息（默认 50s）——空闲时用它在循环里待命 |
| `create_task(title, spec, assignee?, blocked_by?)` | 所有成员 | 发任务（非阻塞）：指派给任何人 / 自己 / 留空任领；结束时创建者收信箱报告 |
| `claim_task(task_id)` | 所有成员 | 认领开放任务（pending 且未指派且依赖就绪） |
| `update_task(task_id, status?, result?, artifacts?)` | 任务负责人 | `in_progress / done / failed / cancelled`；终态自动通知创建者 |
| `cancel_task(task_id, reason?)` | 创建者 | 取消自己创建的任务（管理者模式：仅 manager） |
| `become_manager` | 所有成员 | 自任/接任管理者（peer 模式下同时把空间切为管理者模式）；`--claim closed` 可禁用 |
| `list_tasks` / `get_task` / `wait_task` | 所有成员 | 查看任务；`wait_task` 阻塞等任务终态（代替轮询） |

任务状态：`pending → in_progress → done / failed / cancelled`；`blocked_by` 里全部 `done` 之前不能认领（依赖失败/取消则视为被挡）。

## 两种模式（每个空间独立）

- **peer（默认，平等互联）**：上表即全部语义，人人平权。
- **manager**：只有管理者能 `create_task` / `cancel_task`，任务必须指派（`claim_task` 下线），适合"一个主脑带一群执行者"的用法。模式和管理者都是**按空间**的：一个空间切到 manager 不影响其它空间。
- 管理者 = `--manager <名字>`（只作用于默认空间），缺省为该空间**第一个加入的成员**；`create_space(mode: "manager")` 的创建者直接成为新空间的管理者。管理者属于**当前在线的那个会话实例**：同一名字的进程重启、被宿主回收或换了会话后，管理者会被清空（不会自动继承，也不会自动补位），需要重新指定。

### 指定 / 更换主代理（三种方式）

- **启动参数**：`node hub.mjs --mode manager --manager claude`（作用于默认空间；`--mode` 也会设定所有空间的初始模式）。
- **对话指定**：对任一 agent 说"你来当主代理"，它调用 `become_manager` 即可——peer 模式下会把**当前空间**切成管理者模式并自任管理者，manager 模式下则是接任。加 `--claim closed` 可禁用这条入口（防止 agent 自封，只许启动参数/网页指定）。
- **网页指定**：先在上方选中空间，再点成员卡片上的"★ 设为主代理"，或点模式徽章切换该空间的 平等 ↔ 管理者。

变更**即时生效**，无需重启 agent 会话：Hub 通过 MCP 的 `tools/list_changed` 通知各客户端重新拉取工具表，并向全员信箱广播变更（`[空间] 管理者已变更为 …`）。

## 给 Agent 的协作提示词（可选）

把这段放进各 Agent 能看到的项目说明（如 `AGENTS.md`），协作会顺很多：

```markdown
## Agent Router MCP 协作协议
- 被用户要求加入时调用 join_space；加入后先 get_roster 认识大家；没有别的活时用 wait_inbox 待命（循环调用）。
- 收到 [任务] 指派：直接开工（已 in_progress），完成后必须 update_task(status="done", result=完整报告)；
  做不下去就 status="failed" 说明原因。
- 大活拆给同伴：create_task，spec 按零上下文同事来写（目标/相关文件/约束/如何验证）；等结果用 wait_task。
- 需要谁做什么直接 send_message 问；对所有人有影响的用 "*" 广播。
- 一轮工作收尾前 read_inbox 清空信箱。
```

## 监控页

`http://127.0.0.1:2290/`：顶部空间选择器（切换查看的空间）+ "＋ 新建空间"；成员卡片（在线/离线）、任务板（点击行展开 spec/报告，可取消进行中的任务）、消息流、给当前空间成员留言的输入框。SSE 实时刷新，深浅色跟随系统。

## 配置参考

**hub.mjs 参数**：`--port`（默认 2290，仅绑定 127.0.0.1）、`--data <dir>`（默认 `./data`）、`--mode peer|manager`（所有空间的初始模式）、`--manager <name>`（默认空间的管理者）、`--space <name>`（默认空间名，默认 `main`）、`--max-spaces <n>`（空间上限，默认 50）、`--reset`（清空所有空间/身份/任务，token 保留）。

**mcp-server.mjs 环境变量**：

| 变量 | 说明 |
|---|---|
| `AGENT_ROUTER_HUB_URL` | Hub 地址（默认 `http://127.0.0.1:2290`） |
| `AGENT_ROUTER_TOKEN` | 连接令牌（必填；`data/token`，也见 `data/connect.json`） |
| `AGENT_ROUTER_AGENT` | 成员名（默认 `agent`；重名规则见上） |
| `AGENT_ROUTER_AUTOJOIN` | 设为 1：MCP 一连上就自动加入默认空间（默认关闭：需 agent 调用 `join_space` / `create_space` 才加入） |
| `AGENT_ROUTER_RESUME` | 设为 0：不自动恢复上次落盘的身份（默认开启） |
| `AGENT_ROUTER_STATE_DIR` | 身份文件目录（默认 `./data/clients`，测试用） |
| `AGENT_ROUTER_KIND` / `AGENT_ROUTER_LABEL` | 类型标签 / 展示名（可选） |

**身份与空间**：每个成员在 `/register` 时拿到一个独立的 secret（Hub 只存 sha256）；`/rpc`、`/heartbeat`、`/leave` 必须同时带 `X-Agent` 和 `X-Agent-Secret`。板工具还要带 `X-Space`（当前空间，名字可能含中文，约定 URL 编码）。共享的连接 token 只能证明"这是本机的 MCP 客户端"，**不能**用来冒充别的成员（包括管理者）。

**页面 / 人类 API**：`GET /api/spaces`（空间列表）、`POST /api/spaces`（新建空间）、`GET /api/state?space=<name>`、`POST /api/message|cancel|manager|mode`（body 可带 `space`，缺省默认空间）。

**数据布局**（`--data` 目录）：`hub.json` 空间注册表 + 全局成员身份、`board.json` 默认空间的板快照、`spaces/<hash>.json` 其它空间的板快照、`token` 连接令牌、`connect.json` `{url, token}`；`clients/` 是各成员进程落盘的身份文件（名字 + secret + 当前空间，勿提交/分享）。

**多个协作空间**：一个 Hub = 一个空间；要隔离多组就跑多个 Hub（不同 `--port` + `--data`）。

## 测试

```bash
node --test test.mjs   # 任务板 / 工具权限 / Hub HTTP / MCP stdio 端到端
```

## 已知限制

- **不能从零拉起 agent**（见开头"能力边界"）：Hub 不调用任何 CLI，成员必须由人创建并启动；需要"agent 拉起 agent"请使用 [Agent Router](https://github.com/dazhi666666/agent-router)。
- 通知靠成员主动收信（wait_inbox / read_inbox）；Agent 软件不轮询工具时就收不到——工具描述与上面的提示词片段就是为此准备的。
- 任务没有超时/自动失败：无人认领的开放任务会一直 pending（可在页面取消）。
- Hub 是单点：重启后从 board.json 续接任务板与名册，但长轮询连接需要各 MCP 服务重连（下次工具调用自动完成）。
- 仅监听 127.0.0.1；跨机器协作不在范围内（每个成员本来就是本机的 Agent 软件）。

## License

[MIT](LICENSE)
