// 多空间注册表：一个 Hub 进程托管多个命名协作空间。
//
//   data/hub.json                 注册表：空间元数据 + 全局成员身份（名字 / secret hash / 实例）
//   data/board.json               默认空间的板文件（兼容旧版单空间数据）
//   data/spaces/<sha1(name)>.json 其它空间的板文件（任务 / 消息 / 成员 / 模式 / 管理者）
//
// 身份是全局的（一个成员在 Hub 里只有一个名字和 secret）；成员资格是按空间的
// （每个空间的 Board.peers 就是该空间的成员列表）。所以同名成员可以同时属于多个空间。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Board, normalizeMode } from './board.mjs';

const now = () => new Date().toISOString();
const hashName = name => crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 12);

/** 空间名：允许中文；去掉路径/控制字符，空白折叠成 '-'，最长 40 字符 */
export function sanitizeSpaceName(raw) {
  return String(raw ?? '')
    .normalize('NFC')
    .trim()
    .replace(/[\s"'`<>|*?\\/:;,]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export class Registry {
  /**
   * @param {string} dataDir
   * @param {{ defaultSpace?: string, maxSpaces?: number, onlineInfo?: (name: string) => boolean, onSpace?: (space: any) => void }} opts
   */
  constructor(dataDir, { defaultSpace = 'main', maxSpaces = 50, onlineInfo = () => false, onSpace = null } = {}) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'hub.json');
    this.defaultSpace = sanitizeSpaceName(defaultSpace) || 'main';
    this.maxSpaces = maxSpaces;
    this.onlineInfo = onlineInfo;
    this.onSpace = onSpace;
    this.identities = [];   // { name, kind, label, secret_hash, instance, registered_at, joined_at }
    this.spaceList = [];    // { name, label, created_by, created_at, file(abs) }
    this.boards = new Map(); // name -> space { name, label, created_by, created_at, file, board }
    this.load();
  }

  // ---------- 载入 / 迁移 / 持久化 ----------
  load() {
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}

    if (meta && Array.isArray(meta.spaces) && meta.spaces.length) {
      this.identities = Array.isArray(meta.identities) ? meta.identities : [];
      this.defaultSpace = sanitizeSpaceName(meta.default) || this.defaultSpace;
      for (const s of meta.spaces) {
        const name = sanitizeSpaceName(s.name);
        if (!name) continue;
        const rel = String(s.file || path.join('spaces', `${hashName(name)}.json`));
        this.spaceList.push({
          name, label: String(s.label || ''), created_by: String(s.created_by || 'hub'),
          created_at: s.created_at || now(), file: path.resolve(this.dataDir, rel)
        });
      }
    }

    // 旧版单空间数据：board.json 变成默认空间
    if (!this.spaceList.length) {
      const legacy = path.join(this.dataDir, 'board.json');
      this.spaceList.push({ name: this.defaultSpace, label: '', created_by: 'hub', created_at: now(), file: legacy });
      try {
        const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        this.identities = (data.peers || []).map(p => ({
          name: p.name, kind: p.kind || '', label: p.label || '',
          ...(p.secret_hash ? { secret_hash: p.secret_hash } : {}),
          ...(p.instance ? { instance: p.instance } : {}),
          joined_at: p.joined_at || now(), registered_at: p.registered_at || p.joined_at || now()
        }));
      } catch {}
    }

    // 默认空间必须存在（注册表里没有就补一个；旧 board.json 在就用它）
    if (!this.spaceList.some(s => s.name === this.defaultSpace)) {
      const legacy = path.join(this.dataDir, 'board.json');
      const file = fs.existsSync(legacy) ? legacy : path.join(this.dataDir, 'spaces', `${hashName(this.defaultSpace)}.json`);
      this.spaceList.unshift({ name: this.defaultSpace, label: '', created_by: 'hub', created_at: now(), file });
    }

    for (const s of this.spaceList) this.openBoard(s);
    this.save();
  }

  openBoard(meta) {
    const existing = this.boards.get(meta.name);
    if (existing) return existing;
    fs.mkdirSync(path.dirname(meta.file), { recursive: true });
    const board = new Board(meta.file);
    const space = { name: meta.name, label: meta.label, created_by: meta.created_by, created_at: meta.created_at, file: meta.file, board };
    this.boards.set(meta.name, space);
    this.onSpace?.(space);
    return space;
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const rel = file => path.relative(this.dataDir, file).split(path.sep).join('/');
    const data = {
      version: 2,
      default: this.defaultSpace,
      spaces: this.spaceList.map(s => ({ name: s.name, label: s.label, created_by: s.created_by, created_at: s.created_at, file: rel(s.file) })),
      identities: this.identities
    };
    const tmp = `${this.file}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, this.file); return; }
      catch (e) { if (i >= 20) { try { fs.unlinkSync(tmp); } catch {} throw e; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
    }
  }

  // ---------- 成员身份（全局） ----------
  identity(name) { return this.identities.find(p => p.name === name) || null; }

  /** 新注册 / resume 都走这里；recycled=true 表示复用了离线旧名字 */
  registerIdentity({ name, kind = '', label = '', secretHash = null, instance = null, recycled = false }) {
    let p = this.identity(name);
    if (p) {
      if (kind) p.kind = kind;
      if (label) p.label = label;
      if (recycled) p.joined_at = now();
    } else {
      p = { name, kind, label, joined_at: now() };
      this.identities.push(p);
    }
    if (secretHash) p.secret_hash = secretHash;
    if (instance) p.instance = instance;
    p.registered_at = now();
    this.save();
    return p;
  }

  // ---------- 空间 ----------
  space(name) { return this.boards.get(name) || null; }
  get defaultBoard() { return this.space(this.defaultSpace)?.board || null; }

  /** 创建并加入一个命名空间；manager 模式下创建者成为该空间的管理者 */
  createSpace({ name, label = '', mode = 'peer' }, by, instance = null) {
    const clean = sanitizeSpaceName(name);
    if (!clean) return { error: 'space name is required (letters/numbers/Chinese, up to 40 chars; no path characters)' };
    if (this.space(clean)) return { error: `space "${clean}" already exists` };
    if (this.spaceList.length >= this.maxSpaces) return { error: `space limit reached (${this.maxSpaces})` };
    const normalizedMode = normalizeMode(mode);
    if (!normalizedMode) return { error: 'mode must be peer or managed' };

    const file = path.join(this.dataDir, 'spaces', `${hashName(clean)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const board = new Board(file);
    const meta = { name: clean, label: String(label || '').slice(0, 80), created_by: by, created_at: now(), file };
    const space = { ...meta, board };
    const ident = this.identity(by);
    board.mode = normalizedMode;
    // 注意：创建者不会自动成为管理者。manager 模式只是设定该空间的规则，
    // 管理者必须由人类（--manager / 网页）或成员在用户明确要求下 become_manager 显式指定。
    board.save();
    if (ident) board.registerPeer({ name: by, kind: ident.kind || '', label: ident.label || '' });
    this.spaceList.push(meta);
    this.boards.set(clean, space);
    this.save();
    this.onSpace?.(space);
    return { space };
  }

  /** 加入空间（幂等）；返回 { space, joined } */
  joinSpace(name, member) {
    const clean = String(name || '').trim();
    const space = this.space(clean) || this.space(sanitizeSpaceName(clean));
    if (!space) return { error: `unknown space "${name}" — call list_spaces to see what exists` };
    const ident = this.identity(member);
    if (!ident) return { error: `unregistered agent "${member}"` };
    const existed = !!space.board.peer(member);
    space.board.registerPeer({ name: member, kind: ident.kind || '', label: ident.label || '' });
    return { space, joined: !existed };
  }

  spaceInfo(space, caller = null) {
    const b = space.board;
    return {
      space: space.name, label: space.label || null, mode: b.mode, manager: b.manager || null,
      members: b.peers.length, online: b.peers.filter(p => this.onlineInfo(p.name)).length,
      tasks: b.tasks.length, joined: caller ? !!b.peer(caller) : null
    };
  }

  listSpaces(caller = null) {
    return this.spaceList.map(s => {
      const space = this.boards.get(s.name);
      return {
        name: s.name,
        ...this.spaceInfo(space, caller),
        created_by: s.created_by, created_at: s.created_at,
        is_default: s.name === this.defaultSpace
      };
    });
  }
}
