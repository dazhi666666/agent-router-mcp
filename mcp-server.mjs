#!/usr/bin/env node
// Agent Router MCP — stdio MCP 服务：Agent 软件加载它后，被用户要求时即可加入协作空间。
// 轻量代理：tools/list、tools/call 转发到 Hub 的 /rpc（带 X-Space 指定当前空间），
// 任务板状态只存在于 Hub；加入时注册身份，之后每 15s 心跳，stdin 关闭时告别。
//
// 多空间：一个 Hub 里有多个命名空间（space），每个空间独立的任务板/信箱/成员/管理者。
// 本进程记住“当前空间”，所有板工具都发到它；join_space / create_space 负责加入、创建和切换，
// list_spaces 列出所有空间（未加入也能看，不需要注册）。
//
// 加入是 opt-in 的：装上本 MCP 并不等于加入。未加入时 tools/list 只返回 join_space / create_space /
// list_spaces 三个工具，调用 join_space（用户明确要求加入时）才注册成为成员；AGENT_ROUTER_AUTOJOIN=1
// 改为装上即加入默认空间。
//
// 加入之后身份和当前空间会落盘（AGENT_ROUTER_STATE_DIR，默认 data/clients/）。宿主的 MCP 池在会话
// 空闲时会回收 stdio 进程；新进程启动后带凭据静默 resume，恢复原名、空间和完整工具表，不会退回
// join_space。resume 只在旧进程可判定已退出时成功；并发的新会话仍需要用户明确说「加入」。
// 想禁用自动 resume：AGENT_ROUTER_RESUME=0。
//
// 环境变量（Hub 启动时会打印一份可粘贴的配置）：
//   AGENT_ROUTER_HUB_URL  Hub 地址（默认 http://127.0.0.1:2290）
//   AGENT_ROUTER_TOKEN    连接令牌（必填；Hub 数据目录里的 data/token）
//   AGENT_ROUTER_AGENT    本成员的名字（默认 agent；与在线成员重名自动加后缀，离线重名则复用）
//   AGENT_ROUTER_KIND     类型标签（可选：claude / zcode / codex / …）
//   AGENT_ROUTER_LABEL    展示名（可选）
//   AGENT_ROUTER_AUTOJOIN 设为 1：MCP 一连上就自动加入默认空间（默认关闭：用户说了才 join_space）
//   AGENT_ROUTER_RESUME   设为 0：不自动恢复上次的身份和空间（默认开启）
//   AGENT_ROUTER_STATE_DIR 身份文件目录（默认 ./data/clients，测试用）
// stdout 只走 MCP 协议，日志写 stderr。
import readline from 'node:readline';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TOOL_SCHEMAS, PRE_JOIN_TOOLS } from './core/tools.mjs';

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const HUB = (process.env.AGENT_ROUTER_HUB_URL || 'http://127.0.0.1:2290').replace(/\/$/, '');
const TOKEN = process.env.AGENT_ROUTER_TOKEN || '';
const BASE_NAME = process.env.AGENT_ROUTER_AGENT || 'agent';
const KIND = process.env.AGENT_ROUTER_KIND || '';
const LABEL = process.env.AGENT_ROUTER_LABEL || '';
const AUTOJOIN = /^(1|true|yes)$/i.test(process.env.AGENT_ROUTER_AUTOJOIN || '');
const RESUME = !/^(0|false|no)$/i.test(process.env.AGENT_ROUTER_RESUME || '');
const STATE_DIR = process.env.AGENT_ROUTER_STATE_DIR || path.join(PROJECT_ROOT, 'data', 'clients');
const STATE_FILE = path.join(STATE_DIR, `${crypto.createHash('sha256').update(`${HUB}|${BASE_NAME}`).digest('hex').slice(0, 16)}.json`);
const SERVER_INFO = { name: 'agent-router-mcp', version: '0.3.0' };

if (!TOKEN) console.error('[agent-router-mcp] AGENT_ROUTER_TOKEN 未设置：先启动 hub.mjs，用它输出/数据目录 data/token 里的令牌。');

let me = null;            // Hub 分配的身份（重名时会加后缀）
let secret = null;        // 本成员的凭据（Hub 只存 sha256；每次注册/恢复都会轮换）
let instance = null;      // 本次进程实例 id（诊断用）
let currentSpace = null;  // 当前空间名；板工具都发到这里
let joined = false;       // 是否已注册（有身份）；没有当前空间时工具表仍只有 join/create/list
let registering = null;
let resuming = null;
let heartbeat = null;
let watchStarted = false;
let everAdopted = false;  // 本进程是否已经成功注册过（用于中途掉线后的 tools/list_changed）
let lastIdentity = null;  // { mode, manager }，用于检测当前空间的权限变化 → tools/list_changed

// ---------- 身份落盘（宿主回收进程后 resume 用） ----------
function readState() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(o.identities)) return o;
  } catch {}
  return { identities: [] };
}
function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}
/** 记住（或更新）一个身份；同一个 agent 名可能对应多个历史身份，resume 时逐个试 */
function remember(id) {
  const state = readState();
  const rec = { name: id.name, secret: id.secret, ...(id.space ? { space: id.space } : {}) };
  const i = state.identities.findIndex(x => x && x.name === id.name);
  if (i >= 0) state.identities[i] = rec;
  else state.identities.push(rec);
  writeState(state);
}

function httpGetJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${HUB}${p}`, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('socket', s => s.unref());
  });
}

const listChanged = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');

/** 当前空间的模式 / 管理者变了 → 通知宿主重拉工具表 */
async function syncIdentity() {
  if (!currentSpace) { lastIdentity = null; return; }
  try {
    const s = await httpGetJson(`/api/state?space=${encodeURIComponent(currentSpace)}`);
    if (s.space !== currentSpace) return;
    lastIdentity = { mode: s.mode, manager: s.manager || null };
  } catch {}
}

async function checkIdentityChange() {
  if (!currentSpace) return;
  try {
    const s = await httpGetJson(`/api/state?space=${encodeURIComponent(currentSpace)}`);
    if (s.space !== currentSpace) return;
    const cur = { mode: s.mode, manager: s.manager || null };
    if (lastIdentity && (cur.mode !== lastIdentity.mode || cur.manager !== lastIdentity.manager)) listChanged();
    lastIdentity = cur;
  } catch {}
}

function startWatcher() {
  if (watchStarted) return;
  watchStarted = true;
  const schedule = () => { const t = setTimeout(connect, 5000); t.unref?.(); };
  const connect = () => {
    if (!watchStarted) return;
    const req = http.get(`${HUB}/api/events`, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.type === 'hello') checkIdentityChange();
            else if (ev.type === 'change' && (!ev.space || ev.space === currentSpace)) checkIdentityChange();
          } catch {}
        }
      });
      res.on('end', schedule);
      res.on('error', schedule);
    });
    req.on('error', schedule);
    req.on('socket', s => s.unref());
  };
  connect();
}

/** wait_* 是长轮询：HTTP 超时必须覆盖工具自己的 timeout_sec，否则每次都会在 10s 处误报 hub 掉线 */
function timeoutFor(msg) {
  if (msg?.method === 'tools/call') {
    const tool = String(msg.params?.name || '');
    if (tool === 'wait_inbox' || tool === 'wait_task') {
      const sec = Math.min(Math.max(Number(msg.params?.arguments?.timeout_sec) || 50, 1), 600);
      return sec * 1000 + 5000;
    }
  }
  return 10_000;
}

function post(p, bodyObj, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = http.request(`${HUB}${p}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${TOKEN}`, 'X-Agent': encodeURIComponent(me || BASE_NAME),
        ...(secret ? { 'X-Agent-Secret': secret } : {}),
        ...(currentSpace ? { 'X-Space': encodeURIComponent(currentSpace) } : {})
      }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

/** 采用 Hub 下发的身份；space 非 null 时同时切换到该空间 */
function adopt(j, space = null) {
  me = j.name;
  secret = j.secret || null;
  instance = j.instance || null;
  joined = true;
  if (space !== null) currentSpace = space;
  try { remember({ name: me, secret, space: currentSpace }); } catch (e) { console.error(`[agent-router-mcp] could not save identity: ${e.message}`); }
  lastIdentity = null;
  if (everAdopted) listChanged();
  everAdopted = true;
  if (!heartbeat) {
    heartbeat = setInterval(async () => {
      const who = me;
      try {
        const r = await post('/heartbeat', { name: who }, 5000);
        if (me !== who) return;
        if (r.status === 401 || r.status === 403 || r.status === 409) await reidentify();
      } catch {}
    }, 15_000);
    heartbeat.unref?.();
  }
  startWatcher();
  console.error(`[agent-router-mcp] ${j.resumed ? 'resumed' : 'joined'} as "${me}"${currentSpace ? ` @${currentSpace}` : ''}${j.resumed ? ' — tools restored' : ''} → ${HUB}`);
  return j;
}

/** 只尝试恢复已落盘的身份，绝不因此新注册（避免新会话被悄悄拉进空间） */
async function resumeExisting() {
  for (const id of readState().identities) {
    if (!id?.name || !id?.secret) continue;
    try {
      const r = await post('/register', { name: BASE_NAME, kind: KIND, label: LABEL, resume: { name: id.name, secret: id.secret } });
      if (r.status === 200 && r.json?.resumed === true && r.json?.name && r.json?.secret) {
        const j = adopt(r.json, id.space || null);
        // 兼容升级前（单空间）的身份：没有记录空间时恢复进默认空间
        if (!currentSpace) {
          try {
            const v = await callAgnostic('join_space', {});
            if (!v.error && v.space) { currentSpace = v.space; try { remember({ name: me, secret, space: currentSpace }); } catch {} }
          } catch {}
        }
        await syncIdentity();
        return j;
      }
    } catch {}
  }
  return null;
}
function ensureResumed() {
  if (me) return Promise.resolve();
  if (!RESUME || !readState().identities.length) return Promise.resolve();
  return (resuming ||= resumeExisting().finally(() => { resuming = null; }));
}

async function register() {
  if (!joined) await ensureResumed();
  if (joined) return { name: me, resumed: true };
  const r = await post('/register', { name: BASE_NAME, kind: KIND, label: LABEL });
  if (r.status !== 200) throw new Error(r.json?.error || `HTTP ${r.status}`);
  return adopt(r.json, null);
}

function ensureRegistered() {
  if (me) return Promise.resolve();
  return (registering ||= register().catch(e => { registering = null; throw e; }));
}

/** 身份被 Hub 判为过期（名字被别的会话接管 / hub 重启后不认）：清空本地身份重新注册一次 */
async function reidentify() {
  currentSpace = null; lastIdentity = null;
  me = null; joined = false; secret = null; instance = null; registering = null; resuming = null;
  try { await ensureRegistered(); } catch (e) { console.error(`[agent-router-mcp] re-identify failed: ${e.message}`); }
}

async function forward(msg) {
  const timeout = timeoutFor(msg);
  try {
    await ensureRegistered();
    let r = await post('/rpc', msg, timeout);
    if (r.status === 401 || r.status === 403) {
      await reidentify();
      r = await post('/rpc', msg, timeout);
    }
    if (r.status !== 200 || !r.json) throw new Error(r.json?.error || `HTTP ${r.status}`);
    return r.json;
  } catch (e) {
    const text = `agent-router hub unavailable: ${e.message}`;
    // Hub 暂不可达：tools/list 回兜底全集（权限 Hub 在 call 时还会再校验），tools/call 报错
    if (msg.method === 'tools/list')
      return { jsonrpc: '2.0', id: msg.id, result: { tools: Object.entries(TOOL_SCHEMAS).map(([name, def]) => ({ name, ...def })) } };
    if (msg.method === 'tools/call')
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: text }, null, 1) }], isError: true } };
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: text } };
  }
}

/** 调一次 Hub 的 agnostic 工具（join_space / create_space），返回解析后的值 */
async function callAgnostic(name, args) {
  const r = await post('/rpc', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 10_000);
  const text = r.json?.result?.content?.[0]?.text;
  let val = null;
  try { val = JSON.parse(text); } catch {}
  if (r.status !== 200 || !val) return { error: `hub returned HTTP ${r.status}${text ? '' : ' (no body)'}` };
  return val;
}

/** join_space：注册（如需）→ 加入/切换空间 → 更新落盘身份 + 工具表变更通知 */
async function handleJoin(msg) {
  const replyOut = result => ({ jsonrpc: '2.0', id: msg.id, result });
  const want = String(msg.params?.arguments?.space || '').trim();
  if (joined && currentSpace && (!want || want === currentSpace))
    return replyOut({ content: [{ type: 'text', text: JSON.stringify({ ok: true, name: me, space: currentSpace, mode: lastIdentity?.mode ?? null, manager: lastIdentity?.manager ?? null, note: 'already joined' }, null, 1) }] });
  try { await ensureRegistered(); } catch (e) {
    return replyOut({ content: [{ type: 'text', text: JSON.stringify({ error: `join failed: ${e.message}` }, null, 1) }], isError: true });
  }
  const val = await callAgnostic('join_space', want ? { space: want } : {});
  if (val.error) return replyOut({ content: [{ type: 'text', text: JSON.stringify(val, null, 1) }], isError: true });
  currentSpace = val.space;
  try { remember({ name: me, secret, space: currentSpace }); } catch {}
  await syncIdentity();
  setImmediate(listChanged);
  return replyOut({ content: [{ type: 'text', text: JSON.stringify({ ...val, ok: true, name: me }, null, 1) }] });
}

/** create_space：创建并命名一个空间 → 自动切换过去 */
async function handleCreate(msg) {
  const replyOut = result => ({ jsonrpc: '2.0', id: msg.id, result });
  try { await ensureRegistered(); } catch (e) {
    return replyOut({ content: [{ type: 'text', text: JSON.stringify({ error: `create failed: ${e.message}` }, null, 1) }], isError: true });
  }
  const val = await callAgnostic('create_space', msg.params?.arguments || {});
  if (val.error) return replyOut({ content: [{ type: 'text', text: JSON.stringify(val, null, 1) }], isError: true });
  currentSpace = val.space;
  try { remember({ name: me, secret, space: currentSpace }); } catch {}
  await syncIdentity();
  setImmediate(listChanged);
  return replyOut({ content: [{ type: 'text', text: JSON.stringify({ ...val, ok: true, name: me }, null, 1) }] });
}

/** list_spaces：只读，不注册也能看 */
async function handleListSpaces(msg) {
  const replyOut = result => ({ jsonrpc: '2.0', id: msg.id, result });
  try {
    const s = await httpGetJson('/api/spaces' + (me ? `?agent=${encodeURIComponent(me)}` : ''));
    return replyOut({ content: [{ type: 'text', text: JSON.stringify({ default: s.default, spaces: s.spaces, me }, null, 1) }] });
  } catch (e) {
    return replyOut({ content: [{ type: 'text', text: JSON.stringify({ error: `agent-router hub unavailable: ${e.message}` }, null, 1) }], isError: true });
  }
}

async function handleMessage(msg) {
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return null;
  if (msg.method === 'initialize')
    return { jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: SERVER_INFO
    } };
  if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
  if (msg.method === 'tools/list') {
    if (!joined) { try { await ensureResumed(); } catch {} }
    if (AUTOJOIN && !currentSpace) { try { await ensureRegistered(); const v = await callAgnostic('join_space', {}); if (!v.error && v.space) { currentSpace = v.space; await syncIdentity(); } } catch {} }
    if (!joined || !currentSpace) return { jsonrpc: '2.0', id: msg.id, result: { tools: PRE_JOIN_TOOLS } };
    return forward(msg);
  }
  if (msg.method === 'tools/call') {
    const tool = msg.params?.name;
    if (tool === 'join_space') return handleJoin(msg);
    if (tool === 'create_space') return handleCreate(msg);
    if (tool === 'list_spaces') return handleListSpaces(msg);
    if (!joined) { try { await ensureResumed(); } catch {} }
    if (AUTOJOIN && !currentSpace) { try { await ensureRegistered(); const v = await callAgnostic('join_space', {}); if (!v.error && v.space) { currentSpace = v.space; await syncIdentity(); } } catch {} }
    if (!joined)
      return { jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: JSON.stringify({ error: 'not a member of the collaboration space yet — call join_space or create_space first (the user must explicitly ask to join)' }, null, 1) }],
        isError: true
      } };
    if (!currentSpace)
      return { jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: JSON.stringify({ error: 'no space selected — call list_spaces, then join_space(<name>) or create_space(<name>)' }, null, 1) }],
        isError: true
      } };
    return forward(msg);
  }
  if (msg.id === undefined) return null; // notifications/initialized 等
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handleMessage(msg).then(out => { if (out) process.stdout.write(JSON.stringify(out) + '\n'); })
    .catch(e => console.error(`[agent-router-mcp] handler error: ${e.message}`));
});
rl.on('close', async () => {
  if (me) { try { await Promise.race([post('/leave', { name: me }, 800), new Promise(r => setTimeout(r, 500))]); } catch {} }
  process.exit(0);
});
