#!/usr/bin/env node
// Agent Router MCP — 协作 Hub（多空间版）。
//
// 一个 Hub = 一个协作服务，里面可以有很多个**命名空间**（space）：每个空间有自己的任务板、信箱、
// 成员名册、模式和管理者，互相隔离。成员身份（名字 + secret）是 Hub 全局的，可以同时属于多个空间；
// 成员资格按空间计算。Agent 通过 create_space / join_space / list_spaces 创建、命名、切换空间。
//
//   POST /register /heartbeat /leave   MCP 服务注册身份、保活、告别（Bearer token + 成员 secret 鉴权）
//   POST /rpc                          JSON-RPC tools/list、tools/call（X-Space 指定当前空间）
//   GET  /                             监控页（public/index.html）：空间选择器、成员、任务、消息流，SSE 实时
//   GET  /api/spaces                  空间列表；POST /api/spaces 人类从页面新建空间
//   POST /api/message /api/cancel     页面上的人给成员留言 / 取消任务（human in the loop，body 可带 space）
//   GET  /api/state?space=<name>      页面数据（默认空间可省略）
//   GET  /api/events                  SSE 事件流（change 事件带 space）
//   GET  /connect.json                { url, token }，给 MCP 配置用
//
// 两种模式（--mode，作用于所有空间，单个空间可用页面/接口切换）：
//   peer（默认，平等互联）  所有成员平权：任何人都能 create_task、claim_task、给任何人发消息
//   manager                管理者模式：create_task / cancel_task 仅管理者可用，任务必须指派；
//                          管理者属于“当前在线的那个会话实例”，进程换代后清空，需重新指定
//
// 用法:
//   node hub.mjs [--port 2290] [--data <dir>] [--mode peer|managed] [--manager <name>] [--space <default>] [--reset]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Registry, sanitizeSpaceName } from './core/registry.mjs';
import { normalizeMode } from './core/board.mjs';
import { toolsFor, callTool, wakeWaiters, SPACE_AGNOSTIC_TOOLS } from './core/tools.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.3.0';
const HEARTBEAT_TTL = 45_000;   // 超过这么久没有心跳/调用视为离线
const MAX_SPACES = 50;
const C = { b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m` };

// ---------- 参数 ----------
function parseArgs(argv) {
  const args = { port: Number(process.env.AGENT_ROUTER_MCP_PORT) || 2290, data: null, mode: null, manager: null, claim: 'open', space: 'main', maxSpaces: MAX_SPACES, reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--data') args.data = argv[++i];
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--manager') args.manager = argv[++i];
    else if (a === '--claim') args.claim = argv[++i];
    else if (a === '--space') args.space = argv[++i];
    else if (a === '--max-spaces') args.maxSpaces = Math.max(1, parseInt(argv[++i], 10) || MAX_SPACES);
    else if (a === '--reset') args.reset = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`未知参数: ${a}`); usage(); process.exit(2); }
  }
  if (args.mode) { args.mode = normalizeMode(args.mode); if (!args.mode) { console.error(`--mode 只能是 peer 或 managed（manager 是旧别名）`); process.exit(2); } }
  if (!['open', 'closed'].includes(args.claim)) { console.error(`--claim 只能是 open 或 closed`); process.exit(2); }
  if (!sanitizeSpaceName(args.space)) { console.error(`--space 需要非空名字（可中文，不能含路径字符）`); process.exit(2); }
  return args;
}
function usage() {
  console.log(`Agent Router MCP — 多空间协作 Hub

  node hub.mjs [--port 2290] [--data <dir>] [--mode peer|managed] [--manager <name>]
               [--space <default>] [--max-spaces <n>] [--reset]

  --port <n>       监听端口（默认 2290，只绑定 127.0.0.1；0 = 随机端口，测试用）
  --data <dir>     数据目录（默认 ./data；hub.json + 各空间的板文件 + token）
  --mode <m>       peer（默认，平等互联）| managed（有管理者），作用于所有空间
  --manager <name> manager 模式下指定默认空间的管理者名字（不指定就没有管理者，需在网页/对话中显式指定）
  --claim <o|c>    open（默认：成员可经 become_manager 自任管理者）| closed（只许启动参数/网页指定）
  --space <name>   默认空间名（默认 main；旧版 board.json 会成为这个空间）
  --max-spaces <n> 最多允许创建多少个空间（默认 ${MAX_SPACES}）
  --reset          清空所有空间、成员身份和任务（token 保留，MCP 配置不用改）`);
}

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.data || path.join(PROJECT_ROOT, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
if (args.reset) {
  for (const f of ['board.json', 'hub.json']) { try { fs.unlinkSync(path.join(dataDir, f)); } catch {} }
  try { fs.rmSync(path.join(dataDir, 'spaces'), { recursive: true, force: true }); } catch {}
  console.log(C.yellow('已清空所有空间、成员身份和任务（token 保留）'));
}

const hubName = `hub-${path.basename(dataDir)}`;
let hubUrl = ''; // listen 后赋值（connect.json / 页面用）

// ---------- 连接令牌（data/token；--reset 保留，MCP 配置不用改） ----------
const tokenFile = path.join(dataDir, 'token');
let token = null;
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
if (!token) { token = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(tokenFile, token + '\n'); }

// ---------- 在线状态（内存，全局）与长轮询等待者 ----------
const online = new Map();     // name -> lastSeenMs
const waiters = new Set();    // { check(): boolean }，由 callTool 的 wait_inbox / wait_task 注册
const isOnline = name => Date.now() - (online.get(name) || 0) < HEARTBEAT_TTL;
const touch = name => online.set(name, Date.now());

// ---------- SSE ----------
const sseClients = new Set();
function sseSend(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { sseClients.delete(res); } }
}
setInterval(() => sseSend({ type: 'ping' }), 15_000).unref();

let ssePending = new Set();
let sseScheduled = false;
function onChange(spaceName) {
  setImmediate(() => wakeWaiters(waiters));
  ssePending.add(spaceName || '');
  if (!sseScheduled) {
    sseScheduled = true;
    setImmediate(() => {
      sseScheduled = false;
      const names = [...ssePending]; ssePending.clear();
      for (const n of names) sseSend({ type: 'change', ...(n ? { space: n } : {}) });
    });
  }
}

// ---------- 空间事件 → 该空间内的信箱通知 / SSE ----------
const STATUS_LABEL = { done: '已完成', failed: '失败', cancelled: '已取消' };

function wireSpace(space) {
  const board = space.board;

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
    if (task.status === 'done') {
      for (const t of board.tasks) {
        if (t.status !== 'pending' || !(t.blocked_by || []).includes(task.id)) continue;
        if (board.deps(t).ready && t.assignee)
          board.sendMessage({ from: 'hub', to: t.assignee, task_id: t.id, content:
            `[任务] ${t.id}「${t.title}」的依赖已全部完成，可以开始。` });
      }
    }
  });

  for (const ev of ['task:created', 'task:updated', 'message', 'peers', 'manager', 'mode']) board.on(ev, () => onChange(space.name));

  board.on('manager', name => {
    if (!board.peers.length) return;
    board.sendMessage({ from: 'hub', to: '*', content: name ? `[空间 ${space.name}] 管理者已变更为 ${name}。` : `[空间 ${space.name}] 管理者已卸任（当前无管理者）。` });
  });
  board.on('mode', mode => {
    if (!board.peers.length) return;
    board.sendMessage({ from: 'hub', to: '*', content: mode === 'managed'
      ? `[空间 ${space.name}] 已切换为管理者模式${board.manager ? `（管理者：${board.manager}）` : '（尚未指定管理者）'}。`
      : `[空间 ${space.name}] 已切回平等互联模式（人人可派活/认领）。` });
  });
}

// ---------- 注册表：空间 + 全局身份 ----------
const registry = new Registry(dataDir, {
  defaultSpace: args.space,
  maxSpaces: args.maxSpaces,
  onlineInfo: isOnline,
  onSpace: wireSpace
});
if (args.mode) { for (const s of registry.boards.values()) if (s.board.mode !== args.mode) { s.board.mode = args.mode; s.board.save(); } }
if (args.manager) {
  const def = registry.space(registry.defaultSpace);
  if (def) { def.board.mode = 'managed'; def.board.manager = args.manager; def.board.managerInstance = null; def.board.managerPending = true; def.board.save(); }
}

// 旧版的 manager 只是一个名字、没有会话凭据：升级后无法认证，直接清空（每个空间都查一遍）
for (const s of registry.boards.values()) {
  if (s.board.manager && !s.board.managerInstance && !s.board.managerPending) {
    console.log(C.yellow(`! 空间 "${s.name}" 的管理者 "${s.board.manager}" 没有会话凭据（升级前指定），已清空；请重新指定`));
    s.board.manager = null;
    s.board.save();
  }
}

// ---------- 身份鉴权：每个成员一个 secret（注册时下发，只在成员进程内保存） ----------
const hashSecret = secret => crypto.createHash('sha256').update(String(secret)).digest('hex');
/** HTTP header 只能是 Latin-1：成员名/空间名可能含中文，约定 URL 编码后放进 X-Agent / X-Space */
function decodeHeader(value) {
  const raw = String(value || '');
  try { return decodeURIComponent(raw); } catch { return raw; }
}
function secretMatches(secret, hash) {
  if (!secret || !hash) return false;
  const a = Buffer.from(hashSecret(secret), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** 校验 X-Agent / X-Agent-Secret */
function authenticate(req, name) {
  const p = name ? registry.identity(name) : null;
  if (!p) return { status: 403, error: `unregistered agent "${name}" — 先 /register` };
  if (!p.secret_hash) return { status: 401, error: `agent "${name}" has no credential (registered before auth was enabled) — re-register` };
  if (!secretMatches(String(req.headers['x-agent-secret'] || ''), p.secret_hash))
    return { status: 401, error: `identity mismatch for "${name}" — this name is held by another session; re-register` };
  return { peer: p };
}
/** 这个名字现在能不能被 resume：旧进程必须基本可以判定已退出（心跳每 15s，超过 20s 没心跳即视为已死） */
function canResume(name) {
  const p = registry.identity(name);
  if (!p || !p.secret_hash) return false;
  const seen = online.get(name) || 0;
  return !isOnline(name) || (Date.now() - seen > 20_000);
}
/** 加入空间时的管理者生命周期：绝不自动产生管理者；--manager 指定的名字在加入时授予；换实例则作废 */
function settleManagerOnJoin(space, name, instance) {
  const board = space.board;
  if (board.manager !== name) return;
  if (board.managerPending) { board.setManager(name, instance, false); return; }
  if (board.managerInstance !== instance) {
    console.log(`${C.yellow('!')} 空间 "${space.name}" 的管理者 ${name} 的会话已更换，管理者已清空`);
    board.setManager(null);
  }
}

setInterval(() => {
  for (const [name, seen] of online) if (Date.now() - seen >= HEARTBEAT_TTL) online.delete(name);
}, 10_000).unref();

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
  /** 页面/人通道的空间解析：body.space 或 ?space=，缺省为默认空间 */
  const pickSpace = b => {
    const name = String(b?.space || url.searchParams.get('space') || registry.defaultSpace).trim();
    return registry.space(name) || registry.space(sanitizeSpaceName(name)) || null;
  };

  try {
    // ---- MCP 服务通道（token + 成员 secret 鉴权） ----
    if (req.method === 'POST' && url.pathname === '/register') {
      if (!authed()) return reply(401, { error: 'unauthorized: token mismatch（hub 的 data/token）' });
      const b = await body();
      const requested = String(b.name || 'agent');
      const kind = String(b.kind || ''), label = String(b.label || '');
      const resume = b.resume && typeof b.resume === 'object' ? b.resume : null;
      const instance = crypto.randomUUID();
      let name = null, secret = null, resumed = false;

      // 1) 带凭据的 resume：MCP 进程被宿主回收后重新连上，恢复原身份（空间成员资格还在板上）
      if (resume && (resume.name || resume.secret)) {
        const target = String(resume.name || '');
        const p = registry.identity(target);
        const reason = !p ? 'unknown identity'
          : !p.secret_hash ? 'identity has no credential (registered before auth was enabled)'
          : !secretMatches(String(resume.secret || ''), p.secret_hash) ? 'credential mismatch'
          : !canResume(target) ? 'old session is still online'
          : null;
        if (reason) {
          console.log(`${C.dim('·')} resume 失败: ${target || '(empty)'} — ${reason}`);
          return reply(409, { error: 'resume_failed', reason });
        }
        name = p.name;
        secret = crypto.randomBytes(16).toString('hex'); // 轮换：旧进程即使还活着也会在下次调用收到 401
        registry.registerIdentity({ name, kind, label, secretHash: hashSecret(secret), instance });
        resumed = true;
      }

      // 2) 新注册（含离线名字回收）
      if (!name) {
        name = assignPeerName(requested);
        const existing = registry.identity(name);
        secret = crypto.randomBytes(16).toString('hex');
        registry.registerIdentity({ name, kind, label, secretHash: hashSecret(secret), instance, recycled: !!existing });
      }

      touch(name);
      console.log(`${C.cyan('＋')} 成员${resumed ? '恢复' : '加入'}: ${name}${kind ? ` (${kind})` : ''}${!resumed && name !== requested ? `，申请名 "${requested}" 已被占用` : ''}`);
      return reply(200, {
        name, secret, instance, resumed,
        defaultSpace: registry.defaultSpace,
        spaces: registry.spaceList.map(s => s.name)
      });
    }
    if (req.method === 'POST' && url.pathname === '/heartbeat') {
      if (!authed()) return reply(401, { error: 'unauthorized' });
      const b = await body();
      const a = authenticate(req, String(b.name || ''));
      if (a.error) return reply(a.status, { error: a.error });
      touch(a.peer.name);
      return reply(200, { ok: true, defaultSpace: registry.defaultSpace });
    }
    if (req.method === 'POST' && url.pathname === '/leave') {
      if (!authed()) return reply(401, { error: 'unauthorized' });
      const b = await body();
      const a = authenticate(req, String(b.name || ''));
      if (a.error) return reply(a.status, { error: a.error });
      online.delete(a.peer.name);
      console.log(`${C.dim('－')} 成员离开: ${a.peer.name}`);
      sseSend({ type: 'change' });
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      if (!authed()) return reply(401, { error: 'unauthorized' });
      const caller = decodeHeader(req.headers['x-agent']);
      const a = authenticate(req, caller);
      if (a.error) return reply(a.status, { error: a.error });
      touch(caller);
      const requested = decodeHeader(req.headers['x-space']).trim();
      let space = null, spaceError = null;
      if (requested) {
        space = registry.space(requested) || registry.space(sanitizeSpaceName(requested));
        if (!space) spaceError = `unknown space "${requested}" — call list_spaces to see what exists`;
      } else {
        space = registry.space(registry.defaultSpace);
      }
      const msg = await body();
      return reply(200, await handleRpc(caller, msg, a.peer.instance || null, space, spaceError));
    }

    // ---- 页面 / 人通道（仅本机可访问，不鉴权） ----
    if (req.method === 'GET' && url.pathname === '/connect.json')
      return reply(200, { url: hubUrl, token });
    if (req.method === 'GET' && url.pathname === '/api/spaces')
      return reply(200, { default: registry.defaultSpace, spaces: registry.listSpaces(url.searchParams.get('agent') || null) });
    if (req.method === 'POST' && url.pathname === '/api/spaces') {
      const b = await body();
      const r = registry.createSpace({ name: b.name, label: b.label ?? '', mode: b.mode || 'peer' }, 'user', null);
      if (r.error) return reply(400, { error: r.error });
      console.log(`${C.cyan('◆ 用户')} 新建空间 ${r.space.name}`);
      return reply(200, { ok: true, name: r.space.name, ...registry.spaceInfo(r.space, null) });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const s = pickSpace(null);
      if (!s) return reply(404, { error: `unknown space "${url.searchParams.get('space') || registry.defaultSpace}"` });
      return reply(200, stateView(s));
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      res.write(`data: ${JSON.stringify({ type: 'hello', space: registry.defaultSpace })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/message') {
      const b = await body();
      const space = pickSpace(b);
      if (!space) return reply(404, { error: `unknown space "${b.space || registry.defaultSpace}"` });
      if (!b.content) return reply(400, { error: 'content is required' });
      const valid = [...space.board.peers.map(p => p.name), '*', 'user'];
      if (!valid.includes(b.to)) return reply(400, { error: `unknown recipient "${b.to}" in space ${space.name}` });
      const m = space.board.sendMessage({ from: 'user', to: b.to, content: String(b.content), task_id: b.task_id ?? null });
      console.log(`${C.cyan('◆ 用户')} [${space.name}] → ${b.to}: ${String(b.content).replace(/\s+/g, ' ').slice(0, 120)}`);
      return reply(200, { ok: true, id: m.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const b = await body();
      const space = pickSpace(b);
      if (!space) return reply(404, { error: `unknown space "${b.space || registry.defaultSpace}"` });
      const t = space.board.task(b.task_id);
      if (!t) return reply(404, { error: `task ${b.task_id} not found in space ${space.name}` });
      if (['done', 'failed', 'cancelled'].includes(t.status)) return reply(400, { error: `task ${t.id} is already ${t.status}` });
      space.board.updateTask(t.id, { status: 'cancelled', result: `Cancelled by user: ${b.reason || 'from the board page'}` }, 'user');
      console.log(`${C.cyan('◆ 用户')} [${space.name}] 取消 ${t.id}`);
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/manager') {
      const b = await body();
      const space = pickSpace(b);
      if (!space) return reply(404, { error: `unknown space "${b.space || registry.defaultSpace}"` });
      const board = space.board;
      if (b.name) {
        const ident = registry.identity(b.name);
        if (!ident) return reply(400, { error: `unknown peer "${b.name}"` });
        if (!isOnline(ident.name)) return reply(400, { error: `peer "${b.name}" is offline — let that session (re)join first, then designate it` });
        if (board.mode !== 'managed') board.setMode('managed');
        if (board.manager !== b.name || board.managerInstance !== ident.instance) board.setManager(b.name, ident.instance || null);
        console.log(`${C.cyan('◆ 用户')} [${space.name}] 设 ${b.name} 为主代理`);
      } else if (board.manager) {
        board.setManager(null);
        console.log(`${C.cyan('◆ 用户')} [${space.name}] 卸任管理者`);
      }
      return reply(200, { ok: true, space: space.name, mode: board.mode, manager: board.manager });
    }
    if (req.method === 'POST' && url.pathname === '/api/mode') {
      const b = await body();
      const space = pickSpace(b);
      if (!space) return reply(404, { error: `unknown space "${b.space || registry.defaultSpace}"` });
      const nextMode = normalizeMode(b.mode);
      if (!nextMode) return reply(400, { error: 'mode must be peer or managed (manager is the legacy alias)' });
      if (space.board.mode !== nextMode) space.board.setMode(nextMode);
      console.log(`${C.cyan('◆ 用户')} [${space.name}] 切换模式 → ${b.mode}`);
      return reply(200, { ok: true, space: space.name, mode: space.board.mode, manager: space.board.manager });
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
async function handleRpc(caller, msg, instance, space, spaceError) {
  const ok = result => ({ jsonrpc: '2.0', id: msg.id, result });
  const inSpace = !!(space && !spaceError && space.board.peer(caller));

  if (msg.method === 'tools/list') {
    const tools = toolsFor(caller, {
      mode: inSpace ? space.board.mode : 'peer',
      manager: inSpace ? space.board.manager : null,
      inSpace
    });
    return ok({ tools, ...(inSpace ? { space: space.name } : {}) });
  }

  if (msg.method === 'tools/call') {
    const name = msg.params?.name, rpcArgs = msg.params?.arguments ?? {};
    let value;
    try {
      if (SPACE_AGNOSTIC_TOOLS.has(name)) {
        value = await callTool(space?.board || null, caller, name, rpcArgs, { registry, callerInstance: instance, waiters, onlineInfo: isOnline });
        if (name === 'join_space' && !value.error && value.space) {
          const sp = registry.space(value.space);
          if (sp) {
            settleManagerOnJoin(sp, caller, instance);
            value.mode = sp.board.mode;
            value.manager = sp.board.manager || null;
            value.members = sp.board.peers.length;
            value.joined = true;
          }
        }
      } else if (spaceError) value = { error: spaceError };
      else if (!space) value = { error: 'no space selected — call join_space or create_space first' };
      else if (!space.board.peer(caller)) value = { error: `not a member of space "${space.name}" — call join_space("${space.name}") first` };
      else value = await callTool(space.board, caller, name, rpcArgs, {
        mode: space.board.mode, manager: space.board.manager, waiters, onlineInfo: isOnline,
        claimClosed: args.claim === 'closed', registry, callerInstance: instance, space: space.name
      });
    } catch (e) { value = { error: String(e.message || e) }; }
    console.log(`${C.dim(`  [${caller}${space ? ` @${space.name}` : ''}] ⚙ ${name} ${JSON.stringify(rpcArgs).replace(/\s+/g, ' ').slice(0, 120)}`)}`);
    return ok({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }], ...(value?.error ? { isError: true } : {}) });
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
}

/** 注册名分配：空位用申请名；被在线成员占用则加后缀；离线成员的名字（含后缀）优先回收 */
function assignPeerName(requested) {
  const base = sanitizeSpaceName(requested) || 'agent'; // 同一条规则：去掉控制/路径字符
  const taken = n => !!registry.identity(n);
  if (!taken(base) || !isOnline(base)) return base;
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`;
    if (!taken(cand) || !isOnline(cand)) return cand;
  }
}

function stateView(space) {
  const board = space.board;
  const peerView = p => ({ name: p.name, kind: p.kind || null, label: p.label || null, joined_at: p.joined_at, registered_at: p.registered_at || null });
  return {
    name: hubName, version: VERSION, space: space.name, label: space.label || null,
    default: registry.defaultSpace, mode: board.mode, manager: board.manager,
    peers: board.peers.map(p => ({ ...peerView(p), online: isOnline(p.name) })),
    tasks: board.tasks.map(t => ({ ...t, ready: board.deps(t).ready })),
    messages: board.messages.slice(-500)
  };
}

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
  const spaces = registry.listSpaces(null).map(s => s.name);
  console.log(`${C.b(`Agent Router MCP Hub（多空间 · ${registry.space(registry.defaultSpace).board.mode === 'managed' ? '管理者模式' : '平等互联模式'}）`)}`);
  console.log(`${C.dim(`空间 ${hubName} · 默认空间 "${registry.defaultSpace}" · ${spaces.length} 个空间 [${spaces.join(', ')}] · 数据 ${dataDir} · ${hubUrl}`)}`);
  console.log(`\n把下面这段加进各 Agent 软件的 MCP 配置（每个软件改一个不同的 AGENT_ROUTER_AGENT）：\n`);
  console.log(JSON.stringify({ mcpServers: { 'agent-router': { command: 'node', args: [mcpServerPath], env: sampleEnv } } }, null, 2));
  console.log(`\n${C.dim('成员是 opt-in 的：对 agent 说「加入协作空间」它才加入；agent 也可以 list_spaces / create_space / join_space 管理和切换空间')}`);
  console.log(`${C.dim(`监控页: ${hubUrl} · token: ${tokenFile} · connect.json 已写好`)}`);
  if (args.claim === 'closed') console.log(C.dim('（--claim closed：成员不能经 become_manager 自任管理者，只能由启动参数/网页指定）'));
});

process.on('SIGINT', () => process.exit(0));
