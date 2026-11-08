// 任务板：Hub 进程内存中的唯一状态源，board.json 只是原子写的快照。
// 所有 agent 通过各自加载的 MCP 服务（mcp-server.mjs）把板工具调用转发到 Hub 的 /rpc，
// 每次变更以事件广播给 Hub（→ 信箱通知、长轮询唤醒、SSE）。Hub 重启时从 board.json 续接。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const now = () => new Date().toISOString();
export const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const MAX_MESSAGES = 2000;   // 消息只保留最近这么多条，防止 board.json 无限增长

export class Board extends EventEmitter {
  /** @param {string} file board.json 路径；已存在则载入（Hub 重启续接） */
  constructor(file) {
    super();
    this.file = file;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.seq = data?.seq || { task: 0, msg: 0 };
    this.tasks = data?.tasks || [];
    this.messages = data?.messages || [];
    this.peers = data?.peers || [];        // { name, kind, label, joined_at }；在线状态由 Hub 内存持有，不持久化
    this.mode = data?.mode || 'peer';      // peer（平等互联）| manager（管理者模式）
    this.manager = data?.manager || null;  // manager 模式下唯一能 create_task / cancel_task 的成员
    // 管理者绑定到“当前在线的那个会话”：manager_instance 是成为管理者时的进程实例 id。
    // 同一名字重新注册（进程重启、空闲回收、换会话）时实例变化，管理者会被清空，必须由人/成员重新指定。
    this.managerInstance = data?.manager_instance || null;
    this.managerPending = data?.manager_pending || false; // --manager 指定的名字：等它下一次注册时授予
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    const data = { seq: this.seq, tasks: this.tasks, messages: this.messages, peers: this.peers, mode: this.mode };
    if (this.manager) Object.assign(data, { manager: this.manager, manager_instance: this.managerInstance, manager_pending: this.managerPending });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, this.file); return; }
      catch (e) { if (i >= 20) { try { fs.unlinkSync(tmp); } catch {} throw e; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
    }
  }

  task(id) { return this.tasks.find(t => t.id === id) || null; }
  peer(name) { return this.peers.find(p => p.name === name) || null; }

  /** 依赖状态：ready=全部依赖已 done；failed=有依赖失败/取消；open=尚未就绪的依赖 id */
  deps(taskOrId) {
    const task = typeof taskOrId === 'string' ? this.task(taskOrId) : taskOrId;
    const blockers = (task.blocked_by || []).map(id => this.task(id));
    const failed = blockers.find(b => !b || b.status === 'failed' || b.status === 'cancelled') || null;
    const ready = blockers.every(b => b && b.status === 'done');
    const open = blockers.filter(b => !b || b.status !== 'done').map(b => b?.id || '?');
    return { ready, failed, open };
  }

  createTask({ title, spec = '', assignee = null, blocked_by = [] }, by) {
    const task = {
      id: `T${++this.seq.task}`, title, spec, assignee, blocked_by,
      status: 'pending', result: null, artifacts: [], created_by: by,
      created_at: now(), updated_at: now(), updated_by: by
    };
    this.tasks.push(task);
    this.save();
    this.emit('task:created', task);
    return task;
  }

  /** 认领一个任务：pending 且（未指派或指派给自己）且依赖就绪 → in_progress、归自己 */
  claimTask(id, by) {
    const task = this.task(id);
    if (!task) return { error: `task ${id} not found` };
    if (task.status !== 'pending') return { error: `task ${task.id} is ${task.status}, not claimable` };
    if (task.assignee && task.assignee !== by) return { error: `task ${task.id} is assigned to ${task.assignee}` };
    const { ready, failed, open } = this.deps(task);
    if (failed) return { error: `task ${task.id} is blocked: dependency ${failed.id} ended as ${failed.status}` };
    if (!ready) return { error: `task ${task.id} is still blocked by: ${open.join(', ')}` };
    this.updateTask(id, { status: 'in_progress', assignee: by }, by);
    return this.task(id);
  }

  /** 更新任务字段；by 记录是谁改的（agent 名 / hub / user） */
  updateTask(id, patch, by = 'hub') {
    const task = this.task(id);
    if (!task) return null;
    const prev = task.status;
    Object.assign(task, patch, { updated_at: now(), updated_by: by });
    if (patch.status === 'in_progress' && !task.started_at) task.started_at = now();
    if (TERMINAL.has(patch.status) && prev !== patch.status) task.finished_at = now();
    this.save();
    this.emit('task:updated', task, prev);
    return task;
  }

  setManager(name, instance = null, pending = false) {
    this.manager = name;
    this.managerInstance = instance;
    this.managerPending = pending;
    this.save();
    this.emit('manager', name);
  }

  setMode(mode) {
    this.mode = mode;
    this.save();
    this.emit('mode', mode);
  }

  /** 注册/更新成员：secretHash + instance 是本次进程的凭据；recycled=true 表示复用了离线成员的旧名字 */
  registerPeer({ name, kind = '', label = '', secretHash = null, instance = null, recycled = false }) {
    let p = this.peer(name);
    if (p) {
      if (kind) p.kind = kind; if (label) p.label = label;
      if (recycled) p.joined_at = now();
    } else {
      p = { name, kind, label, joined_at: now() };
      this.peers.push(p);
    }
    if (secretHash) p.secret_hash = secretHash;
    if (instance) p.instance = instance;
    p.registered_at = now();
    this.save();
    this.emit('peers', p);
    return p;
  }

  sendMessage({ from, to, content, task_id = null }) {
    const msg = { id: `M${++this.seq.msg}`, from, to, task_id, content, read: false, ts: now() };
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.save();
    this.emit('message', msg);
    return msg;
  }

  /** 取出发给 name 的消息；广播（to="*"）按收件人分别记录已读（readBy） */
  inbox(name, { unreadOnly = false, markRead = true } = {}) {
    const isRead = m => m.to === '*' ? (m.readBy || []).includes(name) : m.read;
    const mine = this.messages.filter(m => (m.to === name || m.to === '*') && m.from !== name && (!unreadOnly || !isRead(m)));
    if (markRead && mine.some(m => !isRead(m))) {
      for (const m of mine) {
        if (m.to === '*') m.readBy = [...new Set([...(m.readBy || []), name])];
        else m.read = true;
      }
      this.save();
    }
    return mine;
  }
}
