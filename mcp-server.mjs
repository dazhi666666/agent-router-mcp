#!/usr/bin/env node
// Agent Router MCP — stdio MCP 服务：Agent 软件加载它即加入协作空间。
// 轻量代理（同 Agent-Router 的板协议）：tools/list、tools/call 转发到 Hub 的 /rpc，
// 任务板状态只存在于 Hub；启动时注册身份，之后每 15s 心跳，stdin 关闭时告别。
//
// 环境变量（Hub 启动时会打印一份可粘贴的配置）：
//   AGENT_ROUTER_HUB_URL  Hub 地址（默认 http://127.0.0.1:2290）
//   AGENT_ROUTER_TOKEN    连接令牌（必填；Hub 数据目录里的 data/token）
//   AGENT_ROUTER_AGENT    本成员的名字（默认 agent；与在线成员重名自动加后缀，离线重名则复用）
//   AGENT_ROUTER_KIND     类型标签（可选：claude / zcode / codex / …）
//   AGENT_ROUTER_LABEL    展示名（可选）
// stdout 只走 MCP 协议，日志写 stderr。
import readline from 'node:readline';
import http from 'node:http';
import { TOOL_SCHEMAS } from './core/tools.mjs';

const HUB = (process.env.AGENT_ROUTER_HUB_URL || 'http://127.0.0.1:2290').replace(/\/$/, '');
const TOKEN = process.env.AGENT_ROUTER_TOKEN || '';
const BASE_NAME = process.env.AGENT_ROUTER_AGENT || 'agent';
const KIND = process.env.AGENT_ROUTER_KIND || '';
const LABEL = process.env.AGENT_ROUTER_LABEL || '';
const SERVER_INFO = { name: 'agent-router-mcp', version: '0.1.0' };

if (!TOKEN) console.error('[agent-router-mcp] AGENT_ROUTER_TOKEN 未设置：先启动 hub.mjs，用它输出/数据目录 data/token 里的令牌。');

let me = null;            // Hub 分配的身份（重名时会加后缀）
let registering = null;
let heartbeat = null;
let watchStarted = false;
let lastIdentity = null;  // { mode, manager }，用于检测权限变化 → tools/list_changed

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

/** 管理者 / 模式变更 → 通知宿主重拉工具表（权限即时生效，不用重启会话） */
async function checkIdentityChange() {
  if (!lastIdentity) return;
  try {
    const s = await httpGetJson('/api/state');
    const cur = { mode: s.mode, manager: s.manager || null };
    if (cur.mode !== lastIdentity.mode || cur.manager !== lastIdentity.manager)
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
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
          try { const ev = JSON.parse(line.slice(5).trim()); if (ev.type === 'change' || ev.type === 'hello') checkIdentityChange(); } catch {}
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

function post(p, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const req = http.request(`${HUB}${p}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${TOKEN}`, 'X-Agent': me || BASE_NAME
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
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function register() {
  const r = await post('/register', { name: BASE_NAME, kind: KIND, label: LABEL });
  if (r.status !== 200) throw new Error(r.json?.error || `HTTP ${r.status}`);
  me = r.json.name;
  if (!heartbeat) heartbeat = setInterval(() => { post('/heartbeat', { name: me }).catch(() => {}); }, 15_000);
  heartbeat.unref?.();
  lastIdentity = { mode: r.json.mode, manager: r.json.manager || null };
  startWatcher();
  console.error(`[agent-router-mcp] joined as "${me}" (${r.json.mode} mode${r.json.manager ? `, manager: ${r.json.manager}` : ''}) → ${HUB}`);
  return r.json;
}

function ensureRegistered() {
  if (me) return Promise.resolve();
  return (registering ||= register().catch(e => { registering = null; throw e; }));
}

async function forward(msg) {
  try {
    await ensureRegistered();
    const r = await post('/rpc', msg);
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

async function handleMessage(msg) {
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return null;
  if (msg.method === 'initialize')
    return { jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: SERVER_INFO
    } };
  if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
  if (msg.method === 'tools/list' || msg.method === 'tools/call') return forward(msg);
  if (msg.id === undefined) return null; // notifications/initialized 等
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handleMessage(msg).then(out => { if (out) process.stdout.write(JSON.stringify(out) + '\n'); });
});
rl.on('close', async () => {
  if (me) { try { await Promise.race([post('/leave', { name: me }), new Promise(r => setTimeout(r, 500))]); } catch {} }
  process.exit(0);
});
