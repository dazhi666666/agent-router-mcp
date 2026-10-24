#!/usr/bin/env node
// Agent Router MCP — 协作 Hub。
//
// 一个 Hub = 一个本地协作空间：任务板 + 信箱 + 成员名册（core/board.mjs，内存中唯一状态源，
// board.json 只是快照）。各 Agent 软件（Claude Code / ZCode / Codex / …）通过加载 mcp-server.mjs
// 加入；Hub 不启动、不管理任何 agent 进程——宿主 Agent 软件自己就是 agent。
//
//   POST /register /heartbeat /leave   MCP 服务注册身份、保活、告别（Bearer token 鉴权）
//   POST /rpc                          JSON-RPC tools/list、tools/call（同 Agent-Router 的板协议）
//   GET  /                             简单监控页（public/index.html）：成员、任务、消息流，SSE 实时
//   POST /api/message /api/cancel      页面上的人给成员留言 / 取消任务（human in the loop）
//   GET  /api/state /api/events        页面数据与 SSE 事件流
//   GET  /connect.json                 { url, token }，给 MCP 配置用
//
// 两种模式（--mode）：
//   peer（默认，平等互联）  所有成员平权：任何人都能 create_task（指派给任何人或留空任领）、
//                          claim_task、给任何人发消息、取消自己创建的任务
//   manager                管理者模式（同 Agent-Router）：create_task / cancel_task 仅管理者可用，
//                          任务必须指派；管理者 = --manager 指定的名字，否则第一个加入的成员
//
// 用法:
//   node hub.mjs [--port 2290] [--data <dir>] [--mode peer|manager] [--manager <name>] [--reset]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Board } from './core/board.mjs';
import { toolsFor, callTool, wakeWaiters } from './core/tools.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';
const HEARTBEAT_TTL = 45_000;   // 超过这么久没有心跳/调用视为离线
const C = { b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m` };

// ---------- 参数 ----------
function parseArgs(argv) {
  const args = { port: Number(process.env.AGENT_ROUTER_MCP_PORT) || 2290, data: null, mode: null, manager: null, reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--data') args.data = argv[++i];
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--manager') args.manager = argv[++i];
    else if (a === '--reset') args.reset = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`未知参数: ${a}`); usage(); process.exit(2); }
  }
  if (!['peer', 'manager'].includes(args.mode || 'peer')) { console.error(`--mode 只能是 peer 或 manager`); process.exit(2); }
  return args;
}
function usage() {
  console.log(`Agent Router MCP — 协作 Hub

  node hub.mjs [--port 2290] [--data <dir>] [--mode peer|manager] [--manager <name>] [--reset]

  --port <n>       监听端口（默认 2290，只绑定 127.0.0.1；0 = 随机端口，测试用）
  --data <dir>     数据目录（默认 ./data；board.json 快照 + token）
  --mode <m>       peer（默认，平等互联）| manager（管理者模式）
  --manager <name> manager 模式下指定管理者名字（缺省：第一个加入的成员）
  --reset          清空任务板重新开始（token 保留，MCP 配置不用改）`);
}

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.data || path.join(PROJECT_ROOT, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
if (args.reset) { try { fs.unlinkSync(path.join(dataDir, 'board.json')); console.log(C.yellow('已清空任务板（board.json）')); } catch {} }

const board = new Board(path.join(dataDir, 'board.json'));
if (args.mode) { board.mode = args.mode; board.save(); }
if (args.manager) { board.setManager(args.manager); if (board.mode !== 'manager') { board.mode = 'manager'; board.save(); } }
const hubName = `hub-${path.basename(dataDir)}`;
let hubUrl = ''; // listen 后赋值（connect.json / 页面用）

// ---------- 连接令牌（data/token；--reset 保留，MCP 配置不用改） ----------
const tokenFile = path.join(dataDir, 'token');
let token = null;
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
if (!token) { token = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(tokenFile, token + '\n'); }

// ---------- 在线状态（内存）与长轮询等待者 ----------
const online = new Map();     // name -> lastSeenMs
const waiters = new Set();    // { check(): boolean }，由 callTool 的 wait_inbox / wait_task 注册
const isOnline = name => Date.now() - (online.get(name) || 0) < HEARTBEAT_TTL;
const touch = name => online.set(name, Date.now());

setInterval(() => {
  for (const [name, seen] of online) if (Date.now() - seen >= HEARTBEAT_TTL) online.delete(name);
}, 10_000).unref();

// ---------- 事件桥接：板事件 → 信箱通知（没有进程可注入，通知就是消息） ----------
// 成员从信箱收到：任务指派（含完整 spec）、任务结束报告、取消、依赖就绪。
const STATUS_LABEL = { done: '已完成', failed: '失败', cancelled: '已取消' };

board.on('task:created', task => {
  const spec = task.spec ? `\n\n${task.spec}` : '';
  const tail = `\n\n（get_task("${task.id}") 查看详情与状态）`;
  if (task.assignee && task.assignee !== task.created_by) {
    board.sendMessage({ from: task.created_by, to: task.assignee, task_id: task.id, content:
      `[任务] ${task.id}「${task.title}」已指派给你。${spec}${tail}\n（开工后 status=in_progress；完成后 update_task 把 ${task.id} 标记 done 并附上报告。）` });
  } else if (!task.assignee) {
    board.sendMessage({ from: task.created_by, to: '*', task_id: task.id, content:
      `[任务] ${task.id}「${task.title}」已发布（未指派，任意成员可认领）。${spec}${tail}\n（claim_task("${task.id}") 认领后开工。）` });
  }
});

board.on('task:updated', (task, prev) => {
  if (task.status !== prev && STATUS_LABEL[task.status]) {
    const label = STATUS_LABEL[task.status];
    const detail = task.result ? `\n\n${task.result}` : '';
    if (task.created_by !== task.updated_by && task.created_by !== 'user')
      board.sendMessage({ from: 'hub', to: task.created_by, task_id: task.id, content:
        `[任务] ${task.id}「${task.title}」${label}（by ${task.updated_by}）。${detail}` });
    if (task.assignee && task.assignee !== task.updated_by && task.assignee !== task.created_by)
      board.sendMessage({ from: 'hub', to: task.assignee, task_id: task.id, content:
        `[任务] ${task.id}「${task.title}」${label}（${task.status}）。` });
  }
  // 依赖就绪：某任务完成后，通知所有被它挡住、且已有指派对象的任务
  if (task.status === 'done') {
    for (const t of board.tasks) {
      if (t.status !== 'pending' || !(t.blocked_by || []).includes(task.id)) continue;
      if (board.deps(t).ready && t.assignee)
        board.sendMessage({ from: 'hub', to: t.assignee, task_id: t.id, content:
          `[任务] ${t.id}「${t.title}」的依赖已全部完成，可以开始。` });
    }
  }
});

// 板事件 / 成员事件 → 唤醒长轮询 + 通知页面（SSE）
let sseScheduled = false;
function onChange() {
  setImmediate(() => wakeWaiters(waiters));
  if (!sseScheduled) {
    sseScheduled = true;
    setImmediate(() => { sseScheduled = false; sseSend({ type: 'change' }); });
  }
}
for (const ev of ['task:created', 'task:updated', 'message', 'peers', 'manager']) board.on(ev, onChange);

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const reply = (status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(typeof value === 'string' ? value : JSON.stringify(value));
  };
  const body = async () => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('body too large'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  };
  const authed = () => req.headers.authorization === `Bearer ${token}`;

  try {
    // ---- MCP 服务通道（token 鉴权） ----
    if (req.method === 'POST' && url.pathname === '/register') {
      if (!authed()) return reply(401, { error: 'unauthorized: token mismatch（hub 的 data/token）' });
      const b = await body();
      const name = assignPeerName(String(b.name || 'agent'));
      board.registerPeer({ name, kind: String(b.kind || ''), label: String(b.label || '') });
      touch(name);
      if (board.mode === 'manager' && !board.manager) board.setManager(name);
      console.log(`${C.cyan('＋')} 成员加入: ${name}${b.kind ? ` (${b.kind})` : ''}${name !== b.name ? `，申请名 "${b.name}" 已被占用` : ''}`);
      sseSend({ type: 'change' });
      return reply(200, { name, mode: board.mode, manager: board.manager });
    }
    if (req.method === 'POST' && url.pathname === '/heartbeat') {
      if (!authed()) return reply(401, { error: 'unauthorized' });
      const b = await body();
      if (!board.peer(b.name)) return reply(404, { error: `unknown peer ${b.name}` });
      touch(b.name);
      return reply(200, { ok: true, mode: board.mode, manager: board.manager });
    }
    if (req.method === 'POST' && url.pathname === '/leave') {
      if (!authed()) return reply(401, { error: 'unauthorized' });
      const b = await body();
      online.delete(b.name);
      console.log(`${C.dim('－')} 成员离开: ${b.name}`);
      sseSend({ type: 'change' });
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      if (!authed()) return reply(401, { error: 'unauthorized' });
      const caller = String(req.headers['x-agent'] || '');
      if (!board.peer(caller)) return reply(403, { error: `unregistered agent "${caller}" — 先 /register` });
      touch(caller);
      const msg = await body();
      return reply(200, await handleRpc(caller, msg));
    }

    // ---- 页面 / 人通道（仅本机可访问，不鉴权） ----
    if (req.method === 'GET' && url.pathname === '/connect.json')
      return reply(200, { url: hubUrl, token });
    if (req.method === 'GET' && url.pathname === '/api/state')
      return reply(200, stateView());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/message') {
      const b = await body();
      if (!b.content) return reply(400, { error: 'content is required' });
      const valid = [...board.peers.map(p => p.name), '*', 'user'];
      if (!valid.includes(b.to)) return reply(400, { error: `unknown recipient "${b.to}"` });
      const m = board.sendMessage({ from: 'user', to: b.to, content: String(b.content), task_id: b.task_id ?? null });
      console.log(`${C.cyan('◆ 用户')} → ${b.to}: ${String(b.content).replace(/\s+/g, ' ').slice(0, 120)}`);
      return reply(200, { ok: true, id: m.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const b = await body();
      const t = board.task(b.task_id);
      if (!t) return reply(404, { error: `task ${b.task_id} not found` });
      if (['done', 'failed', 'cancelled'].includes(t.status)) return reply(400, { error: `task ${t.id} is already ${t.status}` });
      board.updateTask(t.id, { status: 'cancelled', result: `Cancelled by user: ${b.reason || 'from the board page'}` }, 'user');
      console.log(`${C.cyan('◆ 用户')} 取消 ${t.id}`);
      return reply(200, { ok: true });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    return reply(404, { error: 'not found' });
  } catch (e) {
    return reply(e instanceof SyntaxError ? 400 : 500, { error: String(e.message || e) });
  }
});

/** 处理一条 MCP 转发来的 JSON-RPC 请求（tools/list / tools/call；wait_* 可能长轮询数分钟） */
async function handleRpc(caller, msg) {
  const ok = result => ({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'tools/list') return ok({ tools: toolsFor(caller, { mode: board.mode, manager: board.manager }) });
  if (msg.method === 'tools/call') {
    const name = msg.params?.name, rpcArgs = msg.params?.arguments ?? {};
    let value;
    try { value = await callTool(board, caller, name, rpcArgs, { mode: board.mode, manager: board.manager, waiters, onlineInfo: isOnline }); }
    catch (e) { value = { error: String(e.message || e) }; }
    console.log(`${C.dim(`  [${caller}] ⚙ ${name} ${JSON.stringify(rpcArgs).replace(/\s+/g, ' ').slice(0, 120)}`)}`);
    return ok({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }], ...(value?.error ? { isError: true } : {}) });
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
}

/** 注册名分配：空位用申请名；被在线成员占用则加后缀；被离线成员占用则回收 */
function assignPeerName(requested) {
  let name = requested.trim().replace(/[\s"':;,<>|*?\\/]+/g, '-').slice(0, 40) || 'agent';
  const taken = board.peer(name);
  if (!taken || !isOnline(name)) return name;
  for (let i = 2; ; i++) if (!board.peer(`${name}-${i}`)) return `${name}-${i}`;
}

function stateView() {
  return {
    name: hubName, version: VERSION, mode: board.mode, manager: board.manager,
    peers: board.peers.map(p => ({ ...p, online: isOnline(p.name) })),
    tasks: board.tasks.map(t => ({ ...t, ready: board.deps(t).ready })),
    messages: board.messages.slice(-500)
  };
}

// ---------- SSE ----------
const sseClients = new Set();
function sseSend(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { sseClients.delete(res); } }
}
setInterval(() => sseSend({ type: 'ping' }), 15_000).unref();

// ---------- 启动 ----------
server.once('error', e => {
  if (e.code === 'EADDRINUSE') { console.error(`端口 ${args.port} 已被占用（可能已有一个 Hub 在跑）。换一个：node hub.mjs --port <n>`); process.exit(1); }
  throw e;
});
server.listen(args.port, '127.0.0.1', () => {
  const port = server.address().port;
  hubUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(dataDir, 'connect.json'), JSON.stringify({ url: hubUrl, token }, null, 1));
  const mcpServerPath = path.join(PROJECT_ROOT, 'mcp-server.mjs');
  const sampleEnv = { AGENT_ROUTER_HUB_URL: hubUrl, AGENT_ROUTER_TOKEN: token, AGENT_ROUTER_AGENT: '<每个 agent 软件起一个名字，如 claude / zcode>', AGENT_ROUTER_KIND: '<可选，类型标签>' };
  console.log(`${C.b(`Agent Router MCP Hub（${board.mode === 'manager' ? '管理者模式' : '平等互联模式'}${board.manager ? ` · manager: ${board.manager}` : ''}）`)}`);
  console.log(`${C.dim(`空间 ${hubName} · 数据 ${dataDir} · ${hubUrl}`)}`);
  console.log(`\n把下面这段加进各 Agent 软件的 MCP 配置（每个软件改一个不同的 AGENT_ROUTER_AGENT）：\n`);
  console.log(JSON.stringify({ mcpServers: { 'agent-router': { command: 'node', args: [mcpServerPath], env: sampleEnv } } }, null, 2));
  console.log(`\n${C.dim(`监控页: ${hubUrl} · token: ${tokenFile} · connect.json 已写好`)}`);
});

process.on('SIGINT', () => process.exit(0));
