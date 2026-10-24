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
  const res = await post(hub2.url, '/rpc', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'become_manager', arguments: {} } }, { ...auth(hub2), 'X-Agent': 'alice' });
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
  return { child, dataDir, url: c.url, token: c.token, stderr: () => stderr };
};

const auth = hub => ({ Authorization: `Bearer ${hub.token}` });
const post = (url, p, bodyObj, headers = {}) =>
  fetch(new URL(p, url), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(bodyObj) })
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const reg = (hub, name, kind = '') => post(hub.url, '/register', { name, kind }, auth(hub));
const rpc = async (hub, agent, method, params = {}) => {
  const r = await post(hub.url, '/rpc', { jsonrpc: '2.0', id: 1, method, params }, { ...auth(hub), 'X-Agent': agent });
  assert.equal(r.status, 200, `rpc ${method} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.result;
};
const call = async (hub, agent, name, args = {}) => {
  const res = await rpc(hub, agent, 'tools/call', { name, arguments: args });
  assert.equal(res.isError, undefined, `${name} → ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
};

// 起 mcp-server.mjs 子进程，返回逐行读 stdout 的句柄（MCP stdio 端到端用）
const spawnMcp = (t, hub, name = 'claude-dev', kind = 'claude') => {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server.mjs')], {
    env: { ...process.env, AGENT_ROUTER_HUB_URL: hub.url, AGENT_ROUTER_TOKEN: hub.token, AGENT_ROUTER_AGENT: name, AGENT_ROUTER_KIND: kind },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const waiters = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  t.after(() => { try { child.kill(); } catch {} });
  return { child, nextLine: () => new Promise(resolve => waiters.push(resolve)), send: obj => child.stdin.write(JSON.stringify(obj) + '\n'), stderr: () => stderr };
};

test('hub：注册命名——新名字、在线重名加后缀、离线重名回收、token/身份校验', async t => {
  const hub = await startHub(t);
  const a1 = await reg(hub, 'claude', 'claude');
  assert.equal(a1.json.name, 'claude');
  assert.equal(a1.json.mode, 'peer');
  assert.equal((await reg(hub, 'claude')).json.name, 'claude-2'); // 在线重名 → 后缀
  await post(hub.url, '/heartbeat', { name: 'claude' }, auth(hub));
  await post(hub.url, '/leave', { name: 'claude' }, auth(hub));
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

test('hub：manager 模式——第一个加入者成为管理者，工具按身份过滤', async t => {
  const hub = await startHub(t, ['--mode', 'manager']);
  assert.equal((await reg(hub, 'zcode-main')).json.manager, 'zcode-main');
  assert.equal((await reg(hub, 'codex-helper')).json.manager, 'zcode-main');

  const names = (await rpc(hub, 'codex-helper', 'tools/list')).tools.map(x => x.name);
  assert.ok(!names.includes('create_task') && !names.includes('claim_task'));
  const errRes = await post(hub.url, '/rpc', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'x', assignee: 'codex-helper' } } }, { ...auth(hub), 'X-Agent': 'codex-helper' });
  assert.match(JSON.parse(errRes.json.result.content[0].text).error, /only the manager/);
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
test('MCP stdio 端到端：initialize → tools/list → tools/call → Hub 上可见；stdin 关闭即退出', async t => {
  const hub = await startHub(t);
  const mcp = spawnMcp(t, hub, 'claude-dev');
  const send = mcp.send, nextLine = mcp.nextLine;

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const init = JSON.parse(await nextLine());
  assert.equal(init.result.serverInfo.name, 'agent-router-mcp');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = JSON.parse(await nextLine());
  const names = list.result.tools.map(x => x.name);
  assert.ok(names.includes('create_task') && names.includes('wait_inbox') && names.includes('claim_task'));

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_task', arguments: { title: '来自 MCP 的任务', spec: '验证 MCP 链路' } } });
  const created = JSON.parse(await nextLine());
  assert.equal(JSON.parse(created.result.content[0].text).id, 'T1');

  const state = await (await fetch(new URL('/api/state', hub.url))).json();
  assert.ok(state.peers.some(p => p.name === 'claude-dev' && p.kind === 'claude'));
  assert.equal(state.tasks[0].created_by, 'claude-dev');

  mcp.child.stdin.end();
  const closed = await Promise.race([new Promise(r => mcp.child.once('exit', r)), sleep(4000).then(() => 'timeout')]);
  assert.notEqual(closed, 'timeout', `stdin 关闭后未退出；stderr: ${mcp.stderr()}`);
  assert.match(mcp.stderr(), /joined as "claude-dev"/);
});

test('MCP：管理者/模式变更 → 宿主收到 tools/list_changed 推送（权限即时生效）', async t => {
  const hub = await startHub(t);
  const mcp = spawnMcp(t, hub, 'claude-dev');

  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const init = JSON.parse(await mcp.nextLine());
  assert.equal(init.result.capabilities.tools.listChanged, true);
  mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await mcp.nextLine(); // 触发注册，watcher 以 peer 基线启动
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
