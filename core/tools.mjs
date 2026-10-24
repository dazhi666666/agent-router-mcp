// 任务板工具：定义 + 权限 + 实现。所有 agent 经各自加载的 MCP 服务（mcp-server.mjs）把调用
// 转发到 Hub 的 /rpc，caller 由 Hub 根据注册身份鉴别（不信任参数里的身份）。
//
// 协作协议（没有 Router 注入提示词，工具描述就是协议本身）：
//   peer 模式（默认，平等互联）：所有成员平权 —— 任何人都能发任务（指派给任何人/留空任领）、
//   认领开放任务、给任何人发消息；任务的开始与结束都由成员自己用 claim_task / update_task 标记。
//   manager 模式：create_task / cancel_task 仅管理者可用，任务必须指派，其余与 peer 相同。
//
// 通知不走推送：指派/完成/取消/依赖就绪都会变成收件人信箱里的一条消息，
// 成员用 read_inbox 读、用 wait_inbox 长轮询等（MCP 无法向宿主注入上下文，靠成员主动收）。

import { TERMINAL } from './board.mjs';

export const TOOL_SCHEMAS = {
  get_roster: {
    description: `List the collaboration space: who you are (me), the mode (peer: everyone is equal / manager: only the manager creates and cancels tasks), and every member with kind, label, and online state. Call this first when you join, and whenever you need to know who to ask or assign work to.`,
    inputSchema: { type: 'object', properties: {} }
  },
  send_message: {
    description: `Send a message to a member, to "user" (the human watching the board page), or "*" (everyone except you). It lands in the recipient's inbox — messaging is how peers coordinate, ask questions, hand over context, or answer each other.`,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient: a member name, "user", or "*"' },
        content: { type: 'string' },
        task_id: { type: 'string', description: 'Optional. Related task ID' }
      },
      required: ['to', 'content']
    }
  },
  read_inbox: {
    description: `Read your inbox and mark it read. You receive: task assignments (with the full spec), task reports when work you dispatched ends, replies from teammates, and notes from the human. Call it when you join, right after wait_inbox returns, and before you finish a work session.`,
    inputSchema: { type: 'object', properties: {} }
  },
  wait_inbox: {
    description: `Block until a new message arrives in your inbox, then return and mark it read. This is the polite way to stay reachable without burning turns: when you have nothing else to do, call wait_inbox in a loop instead of polling. timeout_sec 1-600, default 50.`,
    inputSchema: {
      type: 'object',
      properties: { timeout_sec: { type: 'number', description: 'Give up after this many seconds (1-600, default 50) and return with timeout: true' } }
    }
  },
  create_task: {
    description: `Publish a task on the shared board (non-blocking — it runs inside the assignee's own agent software, not yours). In peer mode everyone is equal: assign it to any member, to yourself, or omit assignee to leave it open for anyone to claim_task. The assignee receives the spec as an inbox message; you receive an inbox message with the report when the task ends. Write the spec like a brief for a capable colleague with no context: goal, relevant files, constraints, and how to verify. Launch independent tasks together so they run concurrently; use blocked_by to order dependent ones. (manager mode: only the manager can create tasks and assignee is required.)`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short (3-10 word) title for the task' },
        spec: { type: 'string', description: 'Complete instructions: goal, relevant files and context, constraints, and how to verify the result' },
        assignee: { type: 'string', description: 'Optional in peer mode. Member name (see get_roster), or yourself. Omit it to publish an open task any member can claim' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Optional. IDs of tasks that must finish successfully before this one may start' }
      },
      required: ['title']
    }
  },
  claim_task: {
    description: `Claim an open task (pending, unassigned) and start working on it: it becomes yours (in_progress). Tasks whose blocked_by dependencies have not finished cannot be claimed yet.`,
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
  },
  update_task: {
    description: `Report on a task you own (assigned to or claimed by you): set status in_progress / done / failed / cancelled, attach result (what changed, which files, how it was verified — or why it failed) and artifacts (paths of key files). The creator is notified in their inbox automatically when the task ends, so a full result here is your report. Setting status cancelled hands the task back.`,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['in_progress', 'done', 'failed', 'cancelled'] },
        result: { type: 'string', description: 'Report: what changed, which files, and how it was verified (or why it failed / was cancelled)' },
        artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths of key files produced or changed' }
      },
      required: ['task_id']
    }
  },
  cancel_task: {
    description: `Cancel a pending or running task you created (manager mode: the manager only). The task is marked cancelled and its assignee is notified. Work already done stays in place.`,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string', description: 'Optional. Why the task is cancelled' }
      },
      required: ['task_id']
    }
  },
  become_manager: {
    description: `Take over as the manager of this space. In peer mode this switches the whole space to manager mode with you as manager; in manager mode it transfers manager-ship to you (or confirms you already have it). Only call this when the user explicitly asks you to lead ("you are the main agent") — never on your own initiative.`,
    inputSchema: { type: 'object', properties: {} }
  },
  list_tasks: {
    description: 'List every task on the board with status, assignee, ready (dependencies satisfied), and a result preview.',
    inputSchema: { type: 'object', properties: {} }
  },
  get_task: {
    description: 'Full details of one task: spec, status, result, artifacts, and timestamps.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
  },
  wait_task: {
    description: `Block until a task reaches a terminal status (done / failed / cancelled) or timeout, then return its full state. Use this instead of polling list_tasks/get_task while waiting for work you dispatched. timeout_sec 1-600, default 50.`,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        timeout_sec: { type: 'number', description: 'Give up after this many seconds (1-600, default 50) and return with timeout: true' }
      },
      required: ['task_id']
    }
  }
};

/**
 * 某个成员可见的工具定义。
 * @param {string} caller  成员名
 * @param {{ mode?: string, manager?: string|null }} opts
 */
export function toolsFor(caller, { mode = 'peer', manager = null } = {}) {
  return Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => {
      if (mode === 'manager') {
        if (name === 'claim_task') return false;
        if ((name === 'create_task' || name === 'cancel_task') && caller !== manager) return false;
      }
      return true;
    })
    .map(([name, def]) => ({ name, ...def }));
}

/**
 * 执行一次工具调用。权限在调用时再次校验（tools/list 可能是 Hub 掉线时的兜底全集）。
 * @param {import('./board.mjs').Board} board
 * @param {string} caller
 * @param {string} name
 * @param {object} args
 * @param {{ mode?: string, manager?: string|null, waiters?: Set<{check():boolean}>, onlineInfo?: (name:string)=>boolean }} ctx
 * @returns {object | Promise<object>}  wait_* 工具是异步的
 */
export function callTool(board, caller, name, args = {}, ctx = {}) {
  const mode = ctx.mode || board.mode;
  const manager = ctx.manager !== undefined ? ctx.manager : board.manager;
  const peerNames = board.peers.map(p => p.name);
  const gate = () => {
    if (mode !== 'manager') return null;
    if ((name === 'create_task' || name === 'cancel_task') && caller !== manager)
      return { error: manager ? `only the manager (${manager}) can call ${name} in manager mode` : `manager mode: no manager has joined yet, so ${name} is unavailable` };
    if (name === 'claim_task') return { error: 'claim_task is only available in peer mode; in manager mode the manager assigns every task' };
    return null;
  };
  if (!TOOL_SCHEMAS[name]) return { error: `unknown tool ${name}` };
  const gated = gate();
  if (gated) return gated;
  const denyWaiter = w => { ctx.waiters?.delete(w); };

  switch (name) {
    case 'get_roster':
      return {
        me: caller,
        mode,
        ...(mode === 'manager' ? { manager } : {}),
        roster: board.peers.map(p => ({
          name: p.name, kind: p.kind || null, label: p.label || null,
          role: mode === 'manager' && p.name === manager ? 'manager' : 'peer',
          online: ctx.onlineInfo ? !!ctx.onlineInfo(p.name) : null,
          joined_at: p.joined_at
        }))
      };
    case 'send_message': {
      if (!args.to || !args.content) return { error: 'to and content are required' };
      const valid = [...peerNames, 'user', '*'];
      if (!valid.includes(args.to)) return { error: `unknown recipient "${args.to}" (members: ${peerNames.join(', ') || 'none yet'}; also "user" or "*")` };
      const m = board.sendMessage({ from: caller, to: args.to, content: String(args.content), task_id: args.task_id ?? null });
      return { ok: true, id: m.id };
    }
    case 'read_inbox':
      return board.inbox(caller).map(m => ({ id: m.id, from: m.from, to: m.to, task_id: m.task_id, content: m.content, ts: m.ts }));
    case 'wait_inbox': {
      const timeout = clampTimeout(args.timeout_sec);
      if (board.inbox(caller, { unreadOnly: true, markRead: false }).length)
        return { messages: board.inbox(caller).map(inboxView), timeout: false };
      return new Promise(resolve => {
        const w = {
          check: () => {
            if (!board.inbox(caller, { unreadOnly: true, markRead: false }).length) return false;
            denyWaiter(w);
            resolve({ messages: board.inbox(caller).map(inboxView), timeout: false });
            return true;
          }
        };
        const timer = setTimeout(() => { denyWaiter(w); resolve({ messages: [], timeout: true }); }, timeout);
        timer.unref?.();
        ctx.waiters?.add(w);
      });
    }
    case 'create_task': {
      if (!args.title) return { error: 'title is required' };
      if (mode === 'manager' && !args.assignee) return { error: 'assignee is required in manager mode' };
      if (args.assignee && !peerNames.includes(args.assignee)) return { error: `assignee "${args.assignee}" has never joined this space (members: ${peerNames.join(', ') || 'none yet'}) — publish an open task (omit assignee) or wait for them to join` };
      const missing = (args.blocked_by || []).filter(id => !board.task(id));
      if (missing.length) return { error: `unknown blocked_by task(s): ${missing.join(', ')}` };
      const t = board.createTask({ title: args.title, spec: args.spec ?? '', assignee: args.assignee ?? null, blocked_by: args.blocked_by ?? [] }, caller);
      return { id: t.id, title: t.title, assignee: t.assignee, status: t.status, note: t.assignee ? `assignment notice sent to ${t.assignee}'s inbox; you will be notified when it ends` : 'published as an open task; any member can claim_task it' };
    }
    case 'claim_task': {
      if (!args.task_id) return { error: 'task_id is required' };
      const r = board.claimTask(args.task_id, caller);
      return r.error ? r : { id: r.id, title: r.title, status: r.status, assignee: r.assignee };
    }
    case 'update_task': {
      const t = board.task(args.task_id);
      if (!t) return { error: `task ${args.task_id} not found` };
      const owner = t.assignee || null;
      const mayUpdate = caller === owner || (!owner && caller === t.created_by) || (mode === 'manager' && caller === manager);
      if (!mayUpdate) return { error: owner ? `task ${t.id} is owned by ${owner}` : `task ${t.id} is unassigned; claim_task it first` };
      if (args.status && !['in_progress', 'done', 'failed', 'cancelled'].includes(args.status)) return { error: 'status must be in_progress, done, failed or cancelled' };
      if (TERMINAL.has(args.status) && TERMINAL.has(t.status)) return { error: `task ${t.id} is already ${t.status}` };
      const patch = {};
      if (args.status) patch.status = args.status;
      if (args.result !== undefined) patch.result = args.result;
      if (args.artifacts !== undefined) patch.artifacts = args.artifacts;
      board.updateTask(t.id, patch, caller);
      return { ok: true, id: t.id, status: board.task(t.id).status };
    }
    case 'cancel_task': {
      const t = board.task(args.task_id);
      if (!t) return { error: `task ${args.task_id} not found` };
      if (mode !== 'manager' && caller !== t.created_by) return { error: `task ${t.id} was created by ${t.created_by}; only the creator can cancel it (to drop your own work, update_task it cancelled)` };
      if (TERMINAL.has(t.status)) return { error: `task ${t.id} is already ${t.status}` };
      board.updateTask(t.id, { status: 'cancelled', result: `Cancelled: ${args.reason || `by ${caller}`}` }, caller);
      return { ok: true, id: t.id, status: 'cancelled' };
    }
    case 'become_manager': {
      if (ctx.claimClosed) return { error: 'manager self-claim is disabled on this hub (--claim closed); ask the human to designate the manager on the board page or via --manager' };
      if (mode === 'manager') {
        if (caller === manager) return { ok: true, mode, manager: caller, note: 'you are already the manager' };
        board.setManager(caller);
        return { ok: true, mode, manager: caller, note: `you are now the manager (took over from ${manager || 'nobody'})` };
      }
      board.setMode('manager');
      board.setManager(caller);
      return { ok: true, mode: 'manager', manager: caller, note: 'space switched to manager mode with you as manager; other members can no longer create tasks' };
    }
    case 'list_tasks':
      return board.tasks.map(t => ({
        id: t.id, title: t.title, assignee: t.assignee, status: t.status, blocked_by: t.blocked_by,
        ready: board.deps(t).ready, created_by: t.created_by,
        result: t.result ? String(t.result).slice(0, 500) : null
      }));
    case 'get_task': {
      const t = board.task(args.task_id);
      if (!t) return { error: `task ${args.task_id} not found` };
      const { ready, open } = board.deps(t);
      return { ...t, ready, deps_open: open };
    }
    case 'wait_task': {
      const t = board.task(args.task_id);
      if (!t) return { error: `task ${args.task_id} not found` };
      const view = () => ({ ...board.task(t.id), ready: board.deps(t).ready });
      if (TERMINAL.has(t.status)) return { task: view(), timeout: false };
      return new Promise(resolve => {
        const w = {
          check: () => {
            const cur = board.task(t.id);
            if (!TERMINAL.has(cur.status)) return false;
            denyWaiter(w);
            resolve({ task: view(), timeout: false });
            return true;
          }
        };
        const timer = setTimeout(() => { denyWaiter(w); resolve({ task: view(), timeout: true }); }, clampTimeout(args.timeout_sec));
        timer.unref?.();
        ctx.waiters?.add(w);
      });
    }
  }
  return { error: `unknown tool ${name}` };
}

const inboxView = m => ({ id: m.id, from: m.from, to: m.to, task_id: m.task_id, content: m.content, ts: m.ts });
const clampTimeout = s => Math.min(Math.max(Number(s) || 50, 1), 600) * 1000;

/** 唤醒等待者（wait_inbox / wait_task 的长轮询）。Hub 在任何板事件后调用；测试里手工调用模拟。 */
export function wakeWaiters(waiters) {
  for (const w of [...waiters]) { try { w.check(); } catch {} }
}
