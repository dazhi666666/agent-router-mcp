// Agent Router MCP 测试：node --test test.mjs
// 覆盖：任务板单元 / 工具权限（peer 与 manager 模式）/ Hub HTTP（注册命名、全流程、SSE）/ MCP stdio 端到端
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Board } from './core/board.mjs';
import { toolsFor, callTool, wakeWaiters } from './core/tools.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TRACE = !!process.env.ARM_TRACE;
const trace = (...m) => { if (TRACE) console.error('[trace]', ...m); };
const tmp = (t, clean = true) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-'));
  if (clean) t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
};

// ---------- 单元：任务板 ----------
test('board：创建/认领/终止/信箱广播已读/持久化', t => {
  const file = path.join(tmp(t), 'board.json');
  const board = new Board(file);
  board.registerPeer({ name: 'alice', kind: 'claude' });
  board.registerPeer({ name: 'bob', kind: 'zcode' });

  const t1 = board.createTask({ title: '实现 X', spec: '做 X', assignee: 'bob' }, 'alice');
  assert.equal(t1.id, 'T1');
  assert.equal(board.task('T1').status, 'pending');

  assert.match(board.claimTask('T1', 'alice').error, /assigned to bob/);
  const claimed = board.claimTask('T1', 'bob');
  assert.equal(claimed.status, 'in_progress');
  assert.equal(claimed.assignee, 'bob');
  assert.ok(claimed.started_at);

  board.createTask({ title: '开放任务 Y' }, 'alice'); // T2 未指派
  board.createTask({ title: 'Z', blocked_by: ['T1'] }, 'alice'); // T3
  assert.match(board.claimTask('T3', 'alice').error, /blocked/);
  assert.equal(board.deps('T3').ready, false);
  assert.deepEqual(board.deps('T3').open, ['T1']);

  board.updateTask('T1', { status: 'done', result: 'X done', artifacts: ['x.js'] }, 'bob');
  assert.ok(board.task('T1').finished_at);
  assert.equal(board.deps('T3').ready, true);
  assert.match(board.claimTask('T1', 'alice').error, /not claimable/);

  board.sendMessage({ from: 'alice', to: '*', content: 'hi all' });
  const bobInbox = board.inbox('bob');
  assert.equal(bobInbox.length, 1);
  assert.equal(bobInbox[0].content, 'hi all');
  assert.equal(board.inbox('bob').length, 1);
  assert.equal(board.inbox('bob', { unreadOnly: true }).length, 0);
  assert.equal(board.inbox('alice').length, 0); // 自己的广播自己看不到

  board.updateTask('T2', { status: 'cancelled', result: 'no need' }, 'alice');
  assert.ok(board.task('T2').finished_at); // cancelled 也是终态

  const board2 = new Board(file); // 重启续接
  assert.equal(board2.task('T1').status, 'done');
  assert.equal(board2.seq.task, 3);
  assert.deepEqual(board2.peers.map(p => p.name), ['alice', 'bob']);
});

// ---------- 单元：工具（peer / manager 模式） ----------
test('tools：peer 模式——人人可发任务、认领开放任务、越权被拒、创建者才能取消', t => {
  const board = new Board(path.join(tmp(t), 'b.json'));
  for (const n of ['alice', 'bob', 'carol']) board.registerPeer({ name: n });
  const ctx = { mode: 'peer', manager: null };

  const open = callTool(board, 'alice', 'create_task', { title: '开放任务', spec: '谁都能做' }, ctx);
  assert.equal(open.id, 'T1');
  assert.match(open.note, /open task/);
  const assigned = callTool(board, 'alice', 'create_task', { title: '指派任务', assignee: 'bob' }, ctx);
  assert.equal(assigned.id, 'T2');
  assert.match(callTool(board, 'alice', 'create_task', { title: 'x', assignee: 'nobody' }, ctx).error, /has never joined/);
  assert.match(callTool(board, 'alice', 'create_task', { title: 'x', blocked_by: ['T99'] }, ctx).error, /unknown blocked_by/);

  assert.equal(callTool(board, 'carol', 'claim_task', { task_id: 'T1' }, ctx).status, 'in_progress');
  assert.match(callTool(board, 'carol', 'claim_task', { task_id: 'T2' }, ctx).error, /assigned to bob/);
  assert.equal(callTool(board, 'bob', 'update_task', { task_id: 'T2', status: 'done', result: 'r' }, ctx).status, 'done');

  assert.match(callTool(board, 'alice', 'update_task', { task_id: 'T1', status: 'done' }, ctx).error, /owned by carol/);
  callTool(board, 'carol', 'update_task', { task_id: 'T1', status: 'done', result: 'ok' }, ctx);
  assert.match(callTool(board, 'carol', 'update_task', { task_id: 'T1', status: 'done' }, ctx).error, /already done/);

  callTool(board, 'bob', 'create_task', { title: '临时' }, ctx); // T3
  assert.match(callTool(board, 'alice', 'cancel_task', { task_id: 'T3' }, ctx).error, /created by bob/);
  assert.equal(callTool(board, 'bob', 'cancel_task', { task_id: 'T3', reason: '不用了' }, ctx).status, 'cancelled');

  assert.match(callTool(board, 'alice', 'send_message', { to: 'ghost', content: 'x' }, ctx).error, /unknown recipient/);
  assert.equal(callTool(board, 'alice', 'send_message', { to: 'user', content: '在吗' }, ctx).ok, true);
  assert.equal(callTool(board, 'alice', 'read_inbox', {}, ctx).length, 0);

  const list = callTool(board, 'alice', 'list_tasks', {}, ctx);
  assert.equal(list.length, 3);
  assert.equal(list.find(x => x.id === 'T1').ready, true);
  const full = callTool(board, 'alice', 'get_task', { task_id: 'T2' }, ctx);
  assert.equal(full.result, 'r');
});

test('tools：wait_task / wait_inbox 长轮询（异步路径 + 超时）', async t => {
  const board = new Board(path.join(tmp(t), 'b.json'));
  for (const n of ['alice', 'bob']) board.registerPeer({ name: n });
  const ctx = { mode: 'peer', waiters: new Set() };

  const t1 = board.createTask({ title: '慢任务', assignee: 'bob' }, 'alice');
  const waitP = callTool(board, 'alice', 'wait_task', { task_id: 'T1', timeout_sec: 10 }, ctx);
  await sleep(50);
  assert.equal(ctx.waiters.size, 1);
  board.updateTask('T1', { status: 'done', result: 'ok' }, 'bob');
  wakeWaiters(ctx.waiters); // Hub 会在任何板事件后调用；这里模拟
  const done = await waitP;
  assert.equal(done.timeout, false);
  assert.equal(done.task.status, 'done');
  await sleep(20);
  assert.equal(ctx.waiters.size, 0);

  // 已是终态 → 立即返回；一直未完成 → 超时返回
  const immediate = await callTool(board, 'alice', 'wait_task', { task_id: 'T1', timeout_sec: 5 }, ctx);
  assert.equal(immediate.timeout, false);
  assert.equal(immediate.task.status, 'done');
  board.createTask({ title: '没人做的任务' }, 'alice');
  const timeout = await callTool(board, 'alice', 'wait_task', { task_id: 'T2', timeout_sec: 1 }, ctx);
  assert.equal(timeout.timeout, true);
  assert.equal(timeout.task.status, 'pending');

  const msgP = callTool(board, 'bob', 'wait_inbox', { timeout_sec: 10 }, ctx);
  await sleep(50);
  board.sendMessage({ from: 'alice', to: 'bob', content: 'hello' });
  wakeWaiters(ctx.waiters);
  const got = await msgP;
  assert.equal(got.timeout, false);
  assert.equal(got.messages[0].content, 'hello');
  assert.equal(board.inbox('bob', { unreadOnly: true }).length, 0); // wait_inbox 顺手标记已读
});

test('tools：become_manager——peer 自任并切模式、接任、幂等、--claim closed 拒绝', t => {
  const board = new Board(path.join(tmp(t), 'b.json'));
  board.registerPeer({ name: 'alice' });
  board.registerPeer({ name: 'bob' });

  const r1 = callTool(board, 'alice', 'become_manager', {}, { mode: 'peer', manager: null });
  assert.equal(r1.ok, true);
  assert.equal(r1.mode, 'manager');
  assert.equal(board.mode, 'manager');
  assert.equal(board.manager, 'alice');

  const r2 = callTool(board, 'bob', 'become_manager', {}, { mode: 'manager', manager: 'alice' });
  assert.equal(r2.manager, 'bob');
  assert.equal(board.manager, 'bob');

  const r3 = callTool(board, 'bob', 'become_manager', {}, { mode: 'manager', manager: 'bob' });
  assert.match(r3.note, /already/);

  const r4 = callTool(board, 'alice', 'become_manager', {}, { mode: 'peer', manager: null, claimClosed: true });
  assert.match(r4.error, /--claim closed/);

  assert.ok(toolsFor('alice', { mode: 'manager', manager: 'bob' }).some(x => x.name === 'become_manager'));
});

test('hub：网页指定主代理 / 切换模式 / become_manager 接任，广播与工具表即时过滤', async t => {
  const hub = await startHub(t);
  await reg(hub, 'alice');
  await reg(hub, 'bob');

  // 网页一键：设 alice 为主代理（同时切管理者模式）
  assert.equal((await post(hub.url, '/api/manager', { name: 'alice' })).status, 200);
  let state = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.equal(state.mode, 'manager');
  assert.equal(state.manager, 'alice');
  let names = (await rpc(hub, 'bob', 'tools/list')).tools.map(x => x.name);
  assert.ok(!names.includes('create_task') && names.includes('become_manager'));

  // 变更广播进 bob 信箱
  const inbox = await call(hub, 'bob', 'read_inbox', {});
  assert.ok(inbox.some(m => /管理者已变更为 alice/.test(m.content)));

  // 对话指定：bob 经 become_manager 接任
  await call(hub, 'bob', 'become_manager', {});
  state = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.equal(state.manager, 'bob');

  // 网页切回平等模式：bob 的工具表恢复 create_task
  assert.equal((await post(hub.url, '/api/mode', { mode: 'peer' })).status, 200);
  state = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.equal(state.mode, 'peer');
  names = (await rpc(hub, 'bob', 'tools/list')).tools.map(x => x.name);
  assert.ok(names.includes('create_task'));

  assert.equal((await post(hub.url, '/api/manager', { name: 'ghost' })).status, 400);
  assert.equal((await post(hub.url, '/api/mode', { mode: 'chaos' })).status, 400);

  // --claim closed：自封被拒
  const hub2 = await startHub(t, ['--claim', 'closed']);
  await reg(hub2, 'alice');
  const res = await post(hub2.url, '/rpc', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'become_manager', arguments: {} } }, { ...auth(hub2), 'X-Agent': 'alice', 'X-Agent-Secret': hub2.secrets.get('alice') });
  assert.match(JSON.parse(res.json.result.content[0].text).error, /--claim closed/);
});

test('tools：manager 模式——create/cancel 仅管理者，任务必须指派，claim 不可用', t => {
  const board = new Board(path.join(tmp(t), 'b.json'));
  board.registerPeer({ name: 'alice' });
  board.registerPeer({ name: 'bob' });
  const ctx = { mode: 'manager', manager: 'alice' };

  const bobTools = toolsFor('bob', ctx).map(x => x.name);
  assert.ok(!bobTools.includes('create_task') && !bobTools.includes('cancel_task') && !bobTools.includes('claim_task'));
  assert.ok(toolsFor('alice', ctx).map(x => x.name).includes('create_task'));

  assert.match(callTool(board, 'bob', 'create_task', { title: 'x', assignee: 'bob' }, ctx).error, /only the manager/);
  assert.match(callTool(board, 'bob', 'claim_task', { task_id: 'T1' }, ctx).error, /only available in peer mode/);
  assert.match(callTool(board, 'alice', 'create_task', { title: '缺 assignee' }, ctx).error, /assignee is required/);

  assert.equal(callTool(board, 'alice', 'create_task', { title: '做 A', assignee: 'bob' }, ctx).id, 'T1');
  assert.equal(callTool(board, 'bob', 'update_task', { task_id: 'T1', status: 'done', result: 'ok' }, ctx).status, 'done');
  callTool(board, 'alice', 'create_task', { title: 'B', assignee: 'bob' }, ctx);
  assert.equal(callTool(board, 'alice', 'update_task', { task_id: 'T2', status: 'cancelled' }, ctx).status, 'cancelled');
});

// ---------- Hub HTTP ----------
const startHub = async (t, extraArgs = []) => {
  const dataDir = tmp(t, false);
  const child = spawn(process.execPath, [path.join(ROOT, 'hub.mjs'), '--port', '0', '--data', dataDir, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  t.after(async () => { child.kill(); await sleep(250); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });
  const connect = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'connect.json'), 'utf8')); } catch { return null; } };
  for (let i = 0; i < 80 && !connect(); i++) {
    if (child.exitCode !== null) throw new Error(`hub 提前退出(${child.exitCode}): ${stderr}`);
    await sleep(100);
  }
  const c = connect();
  if (!c) throw new Error(`hub 未启动: ${stderr}`);
  const spaces = await (await fetch(new URL('/api/spaces', c.url))).json().catch(() => ({}));
  return { child, dataDir, url: c.url, token: c.token, stderr: () => stderr, secrets: new Map(), agentSpace: new Map(), defaultSpace: spaces.default || 'main' };
};

const auth = hub => ({ Authorization: `Bearer ${hub.token}` });
const post = (url, p, bodyObj, headers = {}) =>
  fetch(new URL(p, url), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(bodyObj) })
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
/** 注册身份并默认加入默认空间（join:false 时只注册，供多空间测试用） */
const reg = async (hub, name, kind = '', { join = true } = {}) => {
  const r = await post(hub.url, '/register', { name, kind }, auth(hub));
  if (r.json?.name && r.json?.secret) hub.secrets.set(r.json.name, r.json.secret);
  if (join && r.json?.name) r.join = await call(hub, r.json.name, 'join_space', {});
  return r;
};
const rpc = async (hub, agent, method, params = {}, space = null) => {
  const sp = space || hub.agentSpace.get(agent) || hub.defaultSpace;
  const headers = {
    ...auth(hub), 'X-Agent': encodeURIComponent(agent), 'X-Agent-Secret': hub.secrets.get(agent) || '',
    ...(sp ? { 'X-Space': encodeURIComponent(sp) } : {})
  };
  const r = await post(hub.url, '/rpc', { jsonrpc: '2.0', id: 1, method, params }, headers);
  assert.equal(r.status, 200, `rpc ${method} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.result;
};
/** 工具调用：返回 { isError, value }；value 保持工具原始类型（数组/对象） */
const callRaw = async (hub, agent, name, args = {}, space = null) => {
  const res = await rpc(hub, agent, 'tools/call', { name, arguments: args }, space);
  const value = JSON.parse(res.content[0].text);
  if ((name === 'join_space' || name === 'create_space') && value.space) hub.agentSpace.set(agent, value.space);
  return { isError: !!res.isError, value };
};
const call = async (hub, agent, name, args = {}, space = null) => {
  const { isError, value } = await callRaw(hub, agent, name, args, space);
  assert.ok(!isError, `${name} → ${value.error || JSON.stringify(value)}`);
  return value;
};

// 起 mcp-server.mjs 子进程，返回逐行读 stdout 的句柄（MCP stdio 端到端用）
// stateDir 默认每个实例一个临时目录；需要跨进程 resume 的测试传同一个目录
const spawnMcp = (t, hub, name = 'claude-dev', kind = 'claude', stateDir = null) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server.mjs')], {
    env: {
      ...process.env, AGENT_ROUTER_HUB_URL: hub.url, AGENT_ROUTER_TOKEN: hub.token,
      AGENT_ROUTER_AGENT: name, AGENT_ROUTER_KIND: kind, AGENT_ROUTER_STATE_DIR: stateDir || tmp(t)
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; if (TRACE) console.error('[mcp.stderr]', String(d).trim()); });
  // 行队列式读取：一个 data 块可能含多行（如 join 响应 + list_changed 通知同一 tick 写出），
  // 先到的行进队列，绝不能因为还没人 await 就丢掉
  const lines = [];
  const pending = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const p = pending.shift();
      if (p) p(line);
      else lines.push(line);
    }
  });
  t.after(() => { try { child.kill(); } catch {} });
  return {
    child,
    nextLine: () => new Promise(resolve => { if (lines.length) resolve(lines.shift()); else pending.push(resolve); }),
    send: obj => child.stdin.write(JSON.stringify(obj) + '\n'),
    stderr: () => stderr
  };
};

test('hub：注册命名——新名字、在线重名加后缀、离线重名回收、token/身份校验', async t => {
  const hub = await startHub(t);
  const a1 = await reg(hub, 'claude', 'claude');
  assert.equal(a1.json.name, 'claude');
  assert.equal(a1.join.mode, 'peer');
  assert.equal((await reg(hub, 'claude')).json.name, 'claude-2'); // 在线重名 → 后缀
  await post(hub.url, '/heartbeat', { name: 'claude' }, { ...auth(hub), 'X-Agent': 'claude', 'X-Agent-Secret': hub.secrets.get('claude') });
  await post(hub.url, '/leave', { name: 'claude' }, { ...auth(hub), 'X-Agent': 'claude', 'X-Agent-Secret': hub.secrets.get('claude') });
  assert.equal((await reg(hub, 'claude')).json.name, 'claude');   // 离线重名 → 回收
  assert.equal((await post(hub.url, '/register', { name: 'x' }, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(hub.url, '/rpc', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...auth(hub), 'X-Agent': 'ghost' })).status, 403);
  assert.equal((await post(hub.url, '/api/state', {}, { Authorization: `Bearer ${hub.token}` })).status, 404); // POST 到 GET 路由
});

test('hub：平等互联全流程——指派通知→wait_inbox→认领→wait_task→报告回创建者；人类留言', async t => {
  const hub = await startHub(t);
  await reg(hub, 'alice');
  await reg(hub, 'bob');

  // bob 先挂起等信箱；alice 创建指派任务 → bob 被唤醒并收到完整 spec
  const waitP = call(hub, 'bob', 'wait_inbox', { timeout_sec: 10 });
  await sleep(200);
  const created = await call(hub, 'alice', 'create_task', { title: '实现加法', spec: '在 math.js 里实现 add(a,b)', assignee: 'bob' });
  assert.equal(created.id, 'T1');
  const got = await waitP;
  assert.equal(got.timeout, false);
  assert.equal(got.messages.length, 1);
  assert.match(got.messages[0].content, /已指派给你/);
  assert.match(got.messages[0].content, /math\.js/);

  // bob 认领并完成；alice 用 wait_task 等结果
  assert.equal((await call(hub, 'bob', 'claim_task', { task_id: 'T1' })).status, 'in_progress');
  const doneP = call(hub, 'alice', 'wait_task', { task_id: 'T1', timeout_sec: 10 });
  await sleep(200);
  await call(hub, 'bob', 'update_task', { task_id: 'T1', status: 'done', result: '已实现 add() 并通过 3 个用例', artifacts: ['math.js'] });
  const done = await doneP;
  assert.equal(done.timeout, false);
  assert.equal(done.task.status, 'done');

  const inbox = await call(hub, 'alice', 'read_inbox', {});
  const report = inbox.find(m => m.task_id === 'T1');
  assert.ok(report, '创建者应收到完成通知');
  assert.match(report.content, /已完成/);
  assert.match(report.content, /add\(\)/);

  // 人类从页面留言（user 身份）；wait_inbox 空转超时
  await post(hub.url, '/api/message', { to: 'alice', content: '辛苦了，今晚发布' });
  assert.ok((await call(hub, 'alice', 'read_inbox', {})).some(m => m.from === 'user' && /发布/.test(m.content)));
  const idle = await call(hub, 'bob', 'wait_inbox', { timeout_sec: 1 });
  assert.equal(idle.timeout, true);
  assert.deepEqual(idle.messages, []);

  const state = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].status, 'done');
  assert.ok(state.peers.every(p => typeof p.online === 'boolean'));
  assert.equal(state.mode, 'peer');
});

test('hub：开放任务广播、依赖就绪通知、页面取消', async t => {
  const hub = await startHub(t);
  await reg(hub, 'alice');
  await reg(hub, 'bob');

  // 未指派任务 → 广播给所有人（alice 自己看不到自己的广播）
  await call(hub, 'alice', 'create_task', { title: '开放任务', spec: '任意成员可认领' });
  const bobGot = await call(hub, 'bob', 'wait_inbox', { timeout_sec: 5 });
  assert.match(bobGot.messages[0].content, /已发布/);
  assert.equal((await call(hub, 'bob', 'claim_task', { task_id: 'T1' })).status, 'in_progress');

  // 依赖：T2 blocked_by T1；T1 完成 → 通知 T2 的负责人
  await call(hub, 'alice', 'create_task', { title: '依赖任务', assignee: 'bob', blocked_by: ['T1'] });
  await call(hub, 'bob', 'update_task', { task_id: 'T1', status: 'done', result: 'ok' });
  const notices = await call(hub, 'bob', 'wait_inbox', { timeout_sec: 5 });
  assert.ok(notices.messages.some(m => m.task_id === 'T2' && /依赖已全部完成/.test(m.content)));

  // 页面取消 T2（user 身份）→ bob 收到取消通知
  await post(hub.url, '/api/cancel', { task_id: 'T2', reason: '改需求了' });
  const cancel = await call(hub, 'bob', 'wait_inbox', { timeout_sec: 5 });
  assert.ok(cancel.messages.some(m => m.task_id === 'T2' && /已取消/.test(m.content)));
  const state = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.equal(state.tasks.find(x => x.id === 'T2').status, 'cancelled');
});

test('hub：manager 模式——第一个加入不自动成为管理者，需显式指定', async t => {
  const hub = await startHub(t, ['--mode', 'manager']);
  const first = await reg(hub, 'zcode-main');
  assert.equal(first.join.manager, null); // 第一个加入不会自动成为管理者
  const second = await reg(hub, 'codex-helper');
  assert.equal(second.join.manager, null);

  const names = (await rpc(hub, 'codex-helper', 'tools/list')).tools.map(x => x.name);
  assert.ok(!names.includes('create_task') && !names.includes('claim_task'));
  const errRes = await post(hub.url, '/rpc', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'x', assignee: 'codex-helper' } } }, { ...auth(hub), 'X-Agent': 'codex-helper', 'X-Agent-Secret': hub.secrets.get('codex-helper') });
  assert.match(JSON.parse(errRes.json.result.content[0].text).error, /no manager has joined yet/);

  // 用户明确要求后才由成员自己接管；不做任何自动指定
  const became = await call(hub, 'zcode-main', 'become_manager');
  assert.equal(became.manager, 'zcode-main');
  await call(hub, 'zcode-main', 'create_task', { title: '总控任务', assignee: 'codex-helper' });
});

test('hub：SSE 推送变更', async t => {
  const hub = await startHub(t);
  await reg(hub, 'alice');
  let resolveSSE;
  const sseP = new Promise((resolve, reject) => {
    const req = http.get(new URL('/api/events', hub.url), res => {
      let buf = '';
      res.on('data', d => { buf += d; if (buf.includes('"type":"change"')) resolve(buf); });
      res.on('error', reject);
    });
    req.on('error', reject);
    t.after(() => req.destroy());
  });
  await sleep(200);
  await reg(hub, 'bob'); // 触发 change
  const buf = await Promise.race([sseP, sleep(4000).then(() => { throw new Error('SSE 未收到 change 事件'); })]);
  assert.ok(buf.includes('retry: 3000'));
  assert.ok(buf.includes('"type":"change"'));
});

// ---------- MCP stdio 端到端 ----------
test('MCP stdio 端到端：opt-in 加入 → 工具表变更 → 派活全链路；stdin 关闭即退出', async t => {
  const hub = await startHub(t);
  const mcp = spawnMcp(t, hub, 'claude-dev');
  const send = mcp.send, nextLine = mcp.nextLine;

  trace('send initialize');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const init = JSON.parse(await nextLine());
  trace('init ok');
  assert.equal(init.result.serverInfo.name, 'agent-router-mcp');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // 未加入：工具表只有 join_space，Hub 上没有这个成员，调用板工具被拒
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const preList = JSON.parse(await nextLine());
  trace('pre-list ok');
  assert.deepEqual(preList.result.tools.map(x => x.name), ['join_space', 'create_space', 'list_spaces']);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_roster', arguments: {} } });
  const denied = JSON.parse(await nextLine());
  trace('denied ok');
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /join_space/);
  let state = await (await fetch(new URL('/api/state', hub.url))).json();
  trace('state1 ok');
  assert.deepEqual(state.peers, []);

  // 用户发话：join_space 加入 → 拿到身份和空间信息，工具表变更通知
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'join_space', arguments: {} } });
  const joinedRes = JSON.parse(await nextLine());
  trace('join-resp ok');
  assert.equal(joinedRes.result.isError, undefined);
  const joinedVal = JSON.parse(joinedRes.result.content[0].text);
  assert.equal(joinedVal.ok, true);
  assert.equal(joinedVal.name, 'claude-dev');
  assert.equal(joinedVal.mode, 'peer');
  const joinNotify = JSON.parse(await nextLine());
  trace('join-notify ok');
  assert.equal(joinNotify.method, 'notifications/tools/list_changed');

  send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  const full = JSON.parse(await nextLine());
  trace('post-list ok');
  const names = full.result.tools.map(x => x.name);
  assert.ok(names.includes('create_task') && names.includes('wait_inbox') && names.includes('join_space'));

  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_task', arguments: { title: '来自 MCP 的任务', spec: '验证 MCP 链路' } } });
  const created = JSON.parse(await nextLine());
  trace('created ok');
  assert.equal(JSON.parse(created.result.content[0].text).id, 'T1');

  state = await (await fetch(new URL('/api/state', hub.url))).json();
  trace('state2 ok');
  assert.ok(state.peers.some(p => p.name === 'claude-dev' && p.kind === 'claude'));
  assert.equal(state.tasks[0].created_by, 'claude-dev');

  trace('stdin.end, wait exit');
  mcp.child.stdin.end();
  const closed = await Promise.race([new Promise(r => mcp.child.once('exit', r)), sleep(4000).then(() => 'timeout')]);
  assert.notEqual(closed, 'timeout', `stdin 关闭后未退出；stderr: ${mcp.stderr()}`);
  assert.match(mcp.stderr(), /joined as "claude-dev"/);
});

test('MCP：未加入不注册、不占名；两个实例按加入顺序分配名字', async t => {
  const hub = await startHub(t);
  const mcp = spawnMcp(t, hub, 'zcode');
  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await mcp.nextLine();
  mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  JSON.parse(await mcp.nextLine());
  await sleep(300);
  let state = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.deepEqual(state.peers, []); // 没注册、没占名

  // 另一个实例先加入，拿走 "zcode"
  const mcp2 = spawnMcp(t, hub, 'zcode');
  mcp2.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await mcp2.nextLine();
  mcp2.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'join_space', arguments: {} } });
  const first = JSON.parse(await mcp2.nextLine());
  assert.equal(JSON.parse(first.result.content[0].text).name, 'zcode');

  // 第一个实例现在才加入 → 排到 zcode-2
  mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'join_space', arguments: {} } });
  const second = JSON.parse(await mcp.nextLine());
  assert.equal(JSON.parse(second.result.content[0].text).name, 'zcode-2');

  state = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.deepEqual(state.peers.map(p => p.name).sort(), ['zcode', 'zcode-2']);
});

test('MCP：加入后管理者/模式变更 → 宿主收到 tools/list_changed 推送（权限即时生效）', async t => {
  const hub = await startHub(t);
  const mcp = spawnMcp(t, hub, 'claude-dev');

  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const init = JSON.parse(await mcp.nextLine());
  assert.equal(init.result.capabilities.tools.listChanged, true);
  mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'join_space', arguments: {} } });
  await mcp.nextLine(); // join 响应
  await mcp.nextLine(); // join 触发的 list_changed
  await sleep(300);
  await post(hub.url, '/api/manager', { name: 'claude-dev' });

  const deadline = Date.now() + 5000;
  let seen = null;
  while (!seen && Date.now() < deadline) {
    const line = await Promise.race([mcp.nextLine(), sleep(400).then(() => null)]);
    if (line?.includes('tools/list_changed')) seen = line;
  }
  assert.ok(seen, '未收到 tools/list_changed 推送');
  const state = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.equal(state.mode, 'manager');
  assert.equal(state.manager, 'claude-dev');
});

test('hub：per-peer secret —— 共享 token 也不能冒充别人（尤其 manager）', async t => {
  const hub = await startHub(t);
  await reg(hub, 'alice');
  await reg(hub, 'bob');
  const aliceSecret = hub.secrets.get('alice');
  const bobSecret = hub.secrets.get('bob');
  assert.ok(aliceSecret && bobSecret && aliceSecret !== bobSecret);

  const rpcAs = (agent, secret) => post(hub.url, '/rpc',
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { ...auth(hub), 'X-Agent': agent, ...(secret === undefined ? {} : { 'X-Agent-Secret': secret }) });

  assert.equal((await rpcAs('alice', aliceSecret)).status, 200);
  assert.equal((await rpcAs('alice', bobSecret)).status, 401);   // 用 bob 的 secret 冒充 alice
  assert.equal((await rpcAs('alice', undefined)).status, 401);   // 没带 secret
  assert.equal((await rpcAs('ghost', 'whatever')).status, 403);  // 没注册

  const hb = await post(hub.url, '/heartbeat', { name: 'alice' }, { ...auth(hub), 'X-Agent': 'alice', 'X-Agent-Secret': bobSecret });
  assert.equal(hb.status, 401);
  const lv = await post(hub.url, '/leave', { name: 'alice' }, { ...auth(hub), 'X-Agent': 'alice', 'X-Agent-Secret': bobSecret });
  assert.equal(lv.status, 401);

  const st = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.ok(st.peers.find(p => p.name === 'alice').online);          // 伪造的 leave 没生效
  assert.equal(st.peers.find(p => p.name === 'alice').secret_hash, undefined); // 不泄露凭据
});

test('hub：resume 恢复原名；管理者随会话换代清空，不自动补位', async t => {
  const hub = await startHub(t, ['--mode', 'manager']);
  const first = await reg(hub, 'lead');
  assert.equal(first.join.manager, null); // 不会自动产生管理者
  const became = await call(hub, 'lead', 'become_manager'); // 显式接管
  assert.equal(became.manager, 'lead');
  assert.equal(first.json.resumed, false);
  const leadSecret = hub.secrets.get('lead');

  // 宿主回收会话（等价于 MCP 进程退出时的 /leave）
  await post(hub.url, '/leave', { name: 'lead' }, { ...auth(hub), 'X-Agent': 'lead', 'X-Agent-Secret': leadSecret });

  // 新进程带凭据 resume → 同名（凭据轮换）；管理者属于旧会话，重新加入时清空
  const r = await post(hub.url, '/register', { name: 'lead', resume: { name: 'lead', secret: leadSecret } }, auth(hub));
  assert.equal(r.status, 200);
  assert.equal(r.json.resumed, true);
  assert.equal(r.json.name, 'lead');
  assert.ok(r.json.secret && r.json.secret !== leadSecret, 'resume 应轮换 secret');
  hub.secrets.set('lead', r.json.secret);
  const rejoin = await call(hub, 'lead', 'join_space', {});
  assert.equal(rejoin.manager, null);

  // 后续成员加入不会被自动补位成管理者
  const other = await reg(hub, 'worker');
  assert.equal(other.join.manager, null);
  const st = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.equal(st.mode, 'manager');
  assert.equal(st.manager, null);
});

test('hub：离线的后缀名优先复用，名字不再只增不减', async t => {
  const hub = await startHub(t);
  await reg(hub, 'z');
  assert.equal((await reg(hub, 'z')).json.name, 'z-2'); // z 在线 → 后缀
  await post(hub.url, '/leave', { name: 'z-2' }, { ...auth(hub), 'X-Agent': 'z-2', 'X-Agent-Secret': hub.secrets.get('z-2') });
  assert.equal((await reg(hub, 'z')).json.name, 'z-2'); // z-2 离线 → 复用，而不是 z-3
});

test('MCP：宿主回收进程后，新进程静默 resume，工具表不退回 join_space', async t => {
  const hub = await startHub(t);
  const stateDir = tmp(t);
  const m1 = spawnMcp(t, hub, 'claude-dev', 'claude', stateDir);
  m1.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await m1.nextLine();
  m1.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'join_space', arguments: {} } });
  const joined = JSON.parse(JSON.parse(await m1.nextLine()).result.content[0].text);
  assert.equal(joined.name, 'claude-dev');
  await m1.nextLine(); // join 触发的 list_changed

  m1.child.stdin.end(); // 触发 /leave 后退出
  const closed = await Promise.race([new Promise(r => m1.child.once('exit', r)), sleep(4000).then(() => 'timeout')]);
  assert.notEqual(closed, 'timeout', `m1 未退出；stderr: ${m1.stderr()}`);
  await sleep(500);

  const m2 = spawnMcp(t, hub, 'claude-dev', 'claude', stateDir);
  m2.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await m2.nextLine();
  m2.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); // 没有 join_space，直接 tools/list
  const tools = JSON.parse(await m2.nextLine()).result.tools.map(x => x.name);
  assert.ok(tools.includes('list_tasks') && tools.includes('wait_inbox') && tools.length > 3, `tools: ${tools}`);
  assert.match(m2.stderr(), /resumed as "claude-dev"/);

  m2.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_roster', arguments: {} } });
  const roster = JSON.parse(JSON.parse(await m2.nextLine()).result.content[0].text);
  assert.equal(roster.me, 'claude-dev');
});

test('MCP：wait_inbox 的 timeout_sec 大于 10 秒时不再误报 hub unavailable', async t => {
  const hub = await startHub(t);
  const mcp = spawnMcp(t, hub, 'idle-peer', 'zcode');
  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await mcp.nextLine();
  mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'join_space', arguments: {} } });
  await mcp.nextLine();
  await mcp.nextLine();
  mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_inbox', arguments: {} } });
  await mcp.nextLine();

  const t0 = Date.now();
  mcp.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wait_inbox', arguments: { timeout_sec: 12 } } });
  const res = JSON.parse(await mcp.nextLine());
  const elapsed = Date.now() - t0;
  assert.equal(res.result.isError, undefined, JSON.stringify(res));
  const val = JSON.parse(res.result.content[0].text);
  assert.equal(val.timeout, true);
  assert.ok(elapsed >= 11_500, `elapsed ${elapsed}ms — 仍在 10s 处提前返回`);
});

test('hub：--manager 指定的名字在下一次注册时获得管理者，随后换代即清空', async t => {
  const hub = await startHub(t, ['--manager', 'lead']);
  const first = await reg(hub, 'lead');
  assert.equal(first.join.manager, 'lead');

  await post(hub.url, '/leave', { name: 'lead' }, { ...auth(hub), 'X-Agent': 'lead', 'X-Agent-Secret': hub.secrets.get('lead') });
  const second = await reg(hub, 'lead');
  assert.equal(second.join.manager, null);
});

// ---------- 多空间 ----------
test('spaces：agent 创建并命名空间，任务/消息按空间隔离', async t => {
  const hub = await startHub(t);
  await reg(hub, 'alice'); // 默认空间 main

  const created = await call(hub, 'alice', 'create_space', { name: '火星基地', label: 'Mars base' });
  assert.equal(created.space, '火星基地');
  assert.equal(created.created, true);
  assert.equal(created.joined, true);
  assert.equal(created.mode, 'peer');

  // create_space 后当前空间已经切过去
  const task = await call(hub, 'alice', 'create_task', { title: '火星任务', assignee: 'alice' });
  assert.equal(task.id, 'T1');
  assert.equal((await call(hub, 'alice', 'list_tasks')).length, 1);

  // 切回 main：另一块板，互不可见
  const back = await call(hub, 'alice', 'join_space', { space: 'main' });
  assert.equal(back.space, 'main');
  assert.deepEqual(await call(hub, 'alice', 'list_tasks'), []);

  const ls = await call(hub, 'alice', 'list_spaces');
  assert.equal(ls.default, 'main');
  assert.deepEqual(ls.spaces.map(s => s.name).sort(), ['main', '火星基地'].sort());
  assert.ok(ls.spaces.every(s => s.joined === true));

  const dup = await callRaw(hub, 'alice', 'create_space', { name: '火星基地' });
  assert.equal(dup.isError, true);
  assert.match(dup.value.error, /already exists/);

  const spaced = await call(hub, 'alice', 'create_space', { name: 'Mars Base' });
  assert.equal(spaced.space, 'Mars-Base'); // 空白折叠成 '-'

  const stMars = await (await fetch(new URL('/api/state?space=' + encodeURIComponent('火星基地'), hub.url))).json();
  assert.equal(stMars.space, '火星基地');
  assert.deepEqual(stMars.tasks.map(x => x.id), ['T1']);
  const stMain = await (await fetch(new URL('/api/state?space=main', hub.url))).json();
  assert.deepEqual(stMain.tasks, []);
});

test('spaces：成员资格按空间隔离；manager 只属于创建它的空间', async t => {
  const hub = await startHub(t);
  await reg(hub, 'alice');
  await reg(hub, 'bob'); // 两人都在 main

  const ops = await call(hub, 'alice', 'create_space', { name: 'ops', mode: 'manager' });
  assert.equal(ops.mode, 'manager');
  assert.equal(ops.manager, null); // 创建者不会自动成为管理者
  assert.match(ops.note, /no manager yet/);
  const became = await call(hub, 'alice', 'become_manager');
  assert.equal(became.manager, 'alice');

  // bob 不是 ops 成员：工具表退回 3 个空间工具，板工具被拒
  const names0 = (await rpc(hub, 'bob', 'tools/list', {}, 'ops')).tools.map(x => x.name);
  assert.deepEqual(names0, ['join_space', 'create_space', 'list_spaces']);
  const denied = await callRaw(hub, 'bob', 'list_tasks', {}, 'ops');
  assert.equal(denied.isError, true);
  assert.match(denied.value.error, /not a member of space "ops"/);

  // bob 加入 ops：看到 alice 是 manager，自己不是 → 没有 create_task / claim_task
  const joined = await call(hub, 'bob', 'join_space', { space: 'ops' });
  assert.equal(joined.manager, 'alice');
  const names = (await rpc(hub, 'bob', 'tools/list', {}, 'ops')).tools.map(x => x.name);
  assert.ok(!names.includes('create_task') && !names.includes('claim_task'));
  const denied2 = await callRaw(hub, 'bob', 'create_task', { title: 'x', assignee: 'bob' }, 'ops');
  assert.equal(denied2.isError, true);
  assert.match(denied2.value.error, /only the manager \(alice\)/);

  const task = await call(hub, 'alice', 'create_task', { title: 'ops task', assignee: 'bob' }, 'ops');
  assert.equal(task.id, 'T1');
  assert.deepEqual(await call(hub, 'bob', 'list_tasks', {}, 'main'), []); // main 不受影响
});

test('spaces：名字校验 / 数量上限 / 页面新建', async t => {
  const hub = await startHub(t, ['--max-spaces', '2']);
  await reg(hub, 'alice');
  const bad = await callRaw(hub, 'alice', 'create_space', {});
  assert.equal(bad.isError, true);
  assert.match(bad.value.error, /name is required/);
  assert.equal((await call(hub, 'alice', 'create_space', { name: 'a' })).space, 'a');
  const over = await callRaw(hub, 'alice', 'create_space', { name: 'b' });
  assert.equal(over.isError, true);
  assert.match(over.value.error, /limit reached/);

  // 人类从页面新建：空空间，等 agent 加入
  const hub2 = await startHub(t);
  const r = await post(hub2.url, '/api/spaces', { name: 'page-space' });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'page-space');
  const pub = await (await fetch(new URL('/api/spaces', hub2.url))).json();
  assert.deepEqual(pub.spaces.map(s => s.name).sort(), ['main', 'page-space']);
  assert.equal(pub.spaces.find(s => s.name === 'page-space').members, 0);
});

test('MCP：list_spaces 不注册；create_space 自动切换；两个空间互不可见', async t => {
  const hub = await startHub(t);
  const a = spawnMcp(t, hub, 'alice-mcp', 'zcode');
  a.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await a.nextLine();
  a.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(JSON.parse(await a.nextLine()).result.tools.map(x => x.name), ['join_space', 'create_space', 'list_spaces']);
  // list_spaces 不需要注册
  a.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_spaces', arguments: {} } });
  const ls = JSON.parse(JSON.parse(await a.nextLine()).result.content[0].text);
  assert.deepEqual(ls.spaces.map(s => s.name), ['main']);
  let st = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.deepEqual(st.peers, []); // 没有注册、没有占名、没有成员

  // 加入 main，然后创建并命名新空间
  a.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'join_space', arguments: {} } });
  await a.nextLine(); await a.nextLine(); // 响应 + list_changed
  a.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_space', arguments: { name: 'mcp-space' } } });
  const created = JSON.parse(JSON.parse(await a.nextLine()).result.content[0].text);
  assert.equal(created.space, 'mcp-space');
  await a.nextLine(); // list_changed
  a.send({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
  const names = JSON.parse(await a.nextLine()).result.tools.map(x => x.name);
  assert.ok(names.includes('create_task') && names.includes('list_tasks'));

  a.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'inside', assignee: 'alice-mcp' } } });
  assert.equal(JSON.parse(JSON.parse(await a.nextLine()).result.content[0].text).id, 'T1');

  // 另一个 agent 在 main 看不到；加入 mcp-space 后能看到
  const b = spawnMcp(t, hub, 'bob-mcp', 'zcode');
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await b.nextLine();
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'join_space', arguments: {} } });
  await b.nextLine(); await b.nextLine();
  b.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
  assert.deepEqual(JSON.parse(JSON.parse(await b.nextLine()).result.content[0].text), []);
  b.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'join_space', arguments: { space: 'mcp-space' } } });
  await b.nextLine(); await b.nextLine();
  b.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
  const bobTasks = JSON.parse(JSON.parse(await b.nextLine()).result.content[0].text);
  assert.deepEqual(bobTasks.map(x => x.id), ['T1']);
});
