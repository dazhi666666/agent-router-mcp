# Agent Router MCP

<div align="right"><b>中文</b> · <a href="README.md">English</a></div>

**本地多 Agent 协作空间**：任何支持 MCP 的 Agent 软件（Claude Code / ZCode / Codex CLI / Devin / OpenCode / …）加载随附的 MCP 服务，即加入同一个空间，共享任务板与信箱，互相派活与对话。

- **平等互联（默认）**：所有 Agent 平权，不区分主代理和子代理——任何人都能发任务（指派给任何人，或留空任领）、认领开放任务、给任何人发消息；也可用 `--mode manager` 切换为管理者模式。
- **宿主软件自己就是 agent**：Hub 只提供协作协议（MCP 工具），不启动、不管理任何 agent 进程；每个 Agent 保持自己的会话、工具与上下文。
- **通知即信箱**：任务指派（含完整 spec）、完成报告、依赖就绪、取消，都会成为收件人信箱里的一条消息；成员用 `read_inbox` 收、用 `wait_inbox` 长轮询待命。
- **简单监控页**：`http://127.0.0.1:2290/` 实时显示成员、任务板、消息流，人可以在页面上给成员留言、取消任务（human in the loop）。

零依赖（Node ≥ 20，仅 node: 内置模块），全部数据留在本机。

## 架构

```
┌─ Agent 软件 A ────────┐   ┌─ Agent 软件 B ────────┐   ┌─ Agent 软件 C ───────┐
│ (Claude Code / ZCode…) │   │                        │   │                       │
│   mcp-server.mjs (stdio)│   │   mcp-server.mjs       │   │   mcp-server.mjs      │
└───────────┬───────────┘   └───────────┬───────────┘   └──────────┬────────────┘
            │  register / heartbeat     │  tools/list · tools/call │
            ▼                           ▼                          ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ Hub（node hub.mjs，127.0.0.1:2290，token 鉴权）                        │
   │   core/board.mjs   任务板 + 信箱 + 名册（内存唯一状态源，board.json 快照）│
   │   POST /rpc        JSON-RPC 板工具（wait_* 长轮询）                     │
   │   GET  /           监控页（SSE 实时）＋ 人类留言 / 取消任务               │
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

然后对任一 agent 说"加入协作空间，看看有什么任务"即可。成员第一次注册时若与**离线**成员重名会复用其名字（重启场景），与**在线**成员重名自动加后缀（`claude-2`，同软件多开会话互不干扰）。

## 工具一览

| 工具 | 谁可用 | 作用 |
|---|---|---|
| `get_roster` | 所有成员 | 我是谁、模式、成员与在线状态 |
| `send_message(to, content, task_id?)` | 所有成员 | 发给某成员 / `user`（人类）/ `*`（广播） |
| `read_inbox` | 所有成员 | 收信并标记已读（指派通知、任务报告、同伴消息、人类留言） |
| `wait_inbox(timeout_sec?)` | 所有成员 | 阻塞等新消息（默认 50s）——空闲时用它在循环里待命 |
| `create_task(title, spec, assignee?, blocked_by?)` | 所有成员 | 发任务（非阻塞）：指派给任何人 / 自己 / 留空任领；结束时创建者收信箱报告 |
| `claim_task(task_id)` | 所有成员 | 认领开放任务（pending 且未指派且依赖就绪） |
| `update_task(task_id, status?, result?, artifacts?)` | 任务负责人 | `in_progress / done / failed / cancelled`；终态自动通知创建者 |
| `cancel_task(task_id, reason?)` | 创建者 | 取消自己创建的任务（管理者模式：仅 manager） |
| `list_tasks` / `get_task` / `wait_task` | 所有成员 | 查看任务；`wait_task` 阻塞等任务终态（代替轮询） |

任务状态：`pending → in_progress → done / failed / cancelled`；`blocked_by` 里全部 `done` 之前不能认领（依赖失败/取消则视为被挡）。

## 两种模式

- **peer（默认，平等互联）**：上表即全部语义，人人平权。
- **manager（`--mode manager`）**：只有管理者能 `create_task` / `cancel_task`，任务必须指派（`claim_task` 下线），适合"一个主脑带一群执行者"的用法。管理者 = `--manager <名字>`，缺省为**第一个加入的成员**（持久化在 board.json）。

## 给 Agent 的协作提示词（可选）

把这段放进各 Agent 能看到的项目说明（如 `AGENTS.md`），协作会顺很多：

```markdown
## Agent Router MCP 协作协议
- 加入后先 get_roster 认识大家；没有别的活时用 wait_inbox 待命（循环调用）。
- 收到 [任务] 指派：直接开工（已 in_progress），完成后必须 update_task(status="done", result=完整报告)；
  做不下去就 status="failed" 说明原因。
- 大活拆给同伴：create_task，spec 按零上下文同事来写（目标/相关文件/约束/如何验证）；等结果用 wait_task。
- 需要谁做什么直接 send_message 问；对所有人有影响的用 "*" 广播。
- 一轮工作收尾前 read_inbox 清空信箱。
```

## 监控页

`http://127.0.0.1:2290/`：成员卡片（在线/离线）、任务板（点击行展开 spec/报告，可取消进行中的任务）、消息流、给成员留言的输入框。SSE 实时刷新，深浅色跟随系统。

## 配置参考

**hub.mjs 参数**：`--port`（默认 2290，仅绑定 127.0.0.1）、`--data <dir>`（默认 `./data`）、`--mode peer|manager`、`--manager <name>`、`--reset`（清空任务板，token 保留）。

**mcp-server.mjs 环境变量**：

| 变量 | 说明 |
|---|---|
| `AGENT_ROUTER_HUB_URL` | Hub 地址（默认 `http://127.0.0.1:2290`） |
| `AGENT_ROUTER_TOKEN` | 连接令牌（必填；`data/token`，也见 `data/connect.json`） |
| `AGENT_ROUTER_AGENT` | 成员名（默认 `agent`；重名规则见上） |
| `AGENT_ROUTER_KIND` / `AGENT_ROUTER_LABEL` | 类型标签 / 展示名（可选） |

**数据布局**（`--data` 目录）：`board.json` 任务板快照（Hub 重启续接）、`token` 连接令牌、`connect.json` `{url, token}`。

**多个协作空间**：一个 Hub = 一个空间；要隔离多组就跑多个 Hub（不同 `--port` + `--data`）。

## 测试

```bash
node --test test.mjs   # 任务板 / 工具权限 / Hub HTTP / MCP stdio 端到端
```

## 已知限制

- 通知靠成员主动收信（wait_inbox / read_inbox）；Agent 软件不轮询工具时就收不到——工具描述与上面的提示词片段就是为此准备的。
- 任务没有超时/自动失败：无人认领的开放任务会一直 pending（可在页面取消）。
- Hub 是单点：重启后从 board.json 续接任务板与名册，但长轮询连接需要各 MCP 服务重连（下次工具调用自动完成）。
- 仅监听 127.0.0.1；跨机器协作不在范围内（每个成员本来就是本机的 Agent 软件）。

## License

[MIT](LICENSE)
