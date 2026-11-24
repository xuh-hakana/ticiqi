'use strict';
/**
 * ctodo-db.js —— C_TODO 统一需求内核 · 阶段 0（spec_00）数据地基
 *
 * 这是干什么的：把提词器原先拆成三块的需求库 / 遗留问题 / 已完成区，统一到
 * 一棵 SQLite 树上。本文件只做地基：10 张表 + WAL + req_/node_ id 生成 +
 * 内置接入规则读取。状态机 / 三视图 / C_TODO.md 生成等后续阶段在此之上加。
 *
 * 技术选型：Node 22 内置 node:sqlite（实测 WAL + 事务可用，零依赖）。
 * 不复制接入规则原文——只读 需求/文档一-AI接入规则.md 这份正本。
 *
 * 规格出处：需求/文档三….zip 内《文档四·MVP spec》spec_00，及
 * 《软件本身应有内容》状态定义 / 数据字段 / 存储 / id 生成。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/** 与 server.js defaultDataDir 同一约定：C_TODO 库放数据目录下，与 prompts.json 同级。 */
function defaultDataDir() {
  /* 2026-11-22：提词器用**自己的**数据目录，不再和命令方块共用。
   * 原来这里返回 CommandBlock，导致提词器读的是命令方块的 state.json / prompts.json，
   * 一打开就像「命令方块被改名成提词器」。数据已按原样迁移过来（prompts/state/ctodo.db）。 */
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TiciqiPrompter');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TiciqiPrompter');
  }
  return path.join(os.homedir(), '.config', 'ticiqi');
}
function defaultDbPath() {
  return path.join(defaultDataDir(), 'ctodo.db');
}

// 规格 10 张表（逐字：projects / requirements / nodes / pending / settings /
// fileStates / aiCleanupLog / projectSnapshots / reclassifyPending / movePending）。
const TABLES = [
  'projects',
  'requirements',
  'nodes',
  'pending',
  'settings',
  'fileStates',
  'aiCleanupLog',
  'projectSnapshots',
  'reclassifyPending',
  'movePending',
];

// settings 默认键（规格 settings 字段 + id 计数器）。value 一律存 JSON 字符串。
const DEFAULT_SETTINGS = {
  currentProjectId: null,
  workspaceHandle: null,
  accessRuleConfigured: false,
  lastTodoIds: [],
  rejectedReports: [],
  pluginList: [],
  ticiqiVersion: '2.8.0',
};

// 六段字段名（C_DETAIL 的六段：application-scene / background / frontend /
// backend / data-source / frontend-layout；规格“数据字段”写“六段字段”）。
const SEGMENT_COLUMNS = [
  'applicationScene',
  'background',
  'frontend',
  'backend',
  'dataSource',
  'frontendLayout',
];

const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  folderName    TEXT,
  createdAt     INTEGER NOT NULL,
  updatedAt     INTEGER NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0,
  meta          TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS requirements (
  id            TEXT PRIMARY KEY,
  projectId     TEXT NOT NULL,
  nodeId        TEXT,
  treePath      TEXT,
  title         TEXT,
  text          TEXT NOT NULL,
  supplements   TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'todo',
  source        TEXT,
  priority      TEXT NOT NULL DEFAULT 'medium',
  summary       TEXT,
  acceptance    TEXT,
  applicationScene TEXT,
  background    TEXT,
  frontend      TEXT,
  backend       TEXT,
  dataSource    TEXT,
  frontendLayout TEXT,
  relatedIds    TEXT NOT NULL DEFAULT '[]',
  fromReq       TEXT,
  changes       TEXT NOT NULL DEFAULT '[]',
  archived      INTEGER NOT NULL DEFAULT 0,
  archivedFrom  TEXT,
  createdAt     INTEGER NOT NULL,
  updatedAt     INTEGER NOT NULL,
  syncCount     INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  viewed        INTEGER NOT NULL DEFAULT 0,
  doneReport    TEXT,
  doneHistory   TEXT NOT NULL DEFAULT '[]',
  partialReport TEXT,
  partialAbandoned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nodes (
  nodeId         TEXT PRIMARY KEY,
  projectId      TEXT NOT NULL,
  parentId       TEXT,
  type           TEXT NOT NULL DEFAULT 'feature',
  name           TEXT,
  path           TEXT,
  aggregateStatus TEXT,
  snapshotId     TEXT
);

CREATE TABLE IF NOT EXISTS pending (
  id         TEXT PRIMARY KEY,
  projectId  TEXT,
  reqId      TEXT,
  payload    TEXT NOT NULL DEFAULT '{}',
  state      TEXT NOT NULL DEFAULT 'pending',
  createdAt  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fileStates (
  id        TEXT PRIMARY KEY,
  projectId TEXT,
  rel       TEXT NOT NULL,
  hash      TEXT,
  size      INTEGER,
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS aiCleanupLog (
  id        TEXT PRIMARY KEY,
  projectId TEXT,
  reqId     TEXT,
  reason    TEXT,
  time      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projectSnapshots (
  id        TEXT PRIMARY KEY,
  projectId TEXT,
  type      TEXT,
  payload   TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reclassifyPending (
  id         TEXT PRIMARY KEY,
  projectId  TEXT,
  reqId      TEXT,
  suggestion TEXT,
  state      TEXT NOT NULL DEFAULT 'pending',
  time       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS movePending (
  nodeId    TEXT PRIMARY KEY,
  projectId TEXT,
  payload   TEXT,
  state     TEXT NOT NULL DEFAULT 'pending',
  time      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_req_project ON requirements(projectId);
CREATE INDEX IF NOT EXISTS idx_req_node ON requirements(nodeId);
CREATE INDEX IF NOT EXISTS idx_req_status ON requirements(status);
CREATE INDEX IF NOT EXISTS idx_node_project ON nodes(projectId);
CREATE INDEX IF NOT EXISTS idx_node_parent ON nodes(parentId);
`;

function _json(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function _parse(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

class CTodoDB {
  /**
   * @param {string} dbPath SQLite 文件绝对路径
   * @param {string} appRoot 项目根目录（用于读 需求/文档一-AI接入规则.md）
   */
  constructor(dbPath, appRoot) {
    this.dbPath = path.resolve(dbPath);
    this.appRoot = path.resolve(appRoot || path.dirname(path.dirname(__dirname)));
    this.accessRulePath = path.join(this.appRoot, '需求', '文档一-AI接入规则.md');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.init();
  }

  /** 建表 + WAL + 默认 settings。幂等，可重复调用。 */
  init() {
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('BEGIN');
    try {
      this.db.exec(DDL);
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(key, _json(value));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.state();
  }

  /** 只读概览：表计数、journal 模式、版本。给 /api/ctodo/state 用。 */
  state() {
    const counts = {};
    for (const table of TABLES) {
      counts[table] = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    let journal = '';
    try { journal = this.db.prepare('PRAGMA journal_mode').get().journal_mode; } catch (_) { /* ignore */ }
    return {
      dbPath: this.dbPath,
      journal,
      version: this.getSetting('ticiqiVersion'),
      tables: TABLES.slice(),
      counts,
    };
  }

  getSetting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? _parse(row.value, fallback) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ).run(key, _json(value));
    return value;
  }

  /**
   * id 生成：prefix + 3 位数字，取“当前项目所有出现过的最大编号 + 1”，永不复用。
   * 计数器存 settings（counter:<kind>:<projectId>），物理删除后仍单调；
   * 同时与表内现存最大编号取大，防止计数器丢失时回退复用。
   * @param {'req'|'node'} kind
   * @param {string} projectId
   */
  nextId(kind, projectId) {
    if (kind !== 'req' && kind !== 'node') throw new Error('kind 只能是 req 或 node');
    const proj = String(projectId || '');
    const counterKey = `counter:${kind}:${proj}`;
    const counter = Number(this.getSetting(counterKey, 0)) || 0;

    const table = kind === 'req' ? 'requirements' : 'nodes';
    const col = kind === 'req' ? 'id' : 'nodeId';
    const prefix = kind + '_';
    const row = this.db.prepare(
      `SELECT ${col} AS id FROM ${table} WHERE ${col} LIKE ? AND projectId=?`
    ).all(prefix + '%', proj);
    let maxInTable = 0;
    for (const r of row) {
      const n = Number(String(r.id).slice(prefix.length));
      if (Number.isFinite(n) && n > maxInTable) maxInTable = n;
    }

    // id 是全局主键：多项目时各自的计数器会撞号，这里跳过已被别的项目占用的号。
    let next = Math.max(counter, maxInTable) + 1;
    const taken = this.db.prepare(`SELECT 1 FROM ${table} WHERE ${col}=?`);
    while (taken.get(prefix + String(next).padStart(3, '0'))) next += 1;
    this.setSetting(counterKey, next);
    return prefix + String(next).padStart(3, '0');
  }

  /**
   * 内置接入规则：只读正本 需求/文档一-AI接入规则.md，去掉头部说明，
   * 从「# 提词器接入规则」起返回正文。不复制、不改写。文件缺失返回空串。
   */
  accessRule() {
    let raw;
    try { raw = fs.readFileSync(this.accessRulePath, 'utf8'); } catch (_) { return ''; }
    const marker = '# 提词器接入规则';
    const at = raw.indexOf(marker);
    return at >= 0 ? raw.slice(at).trim() + '\n' : raw.trim() + '\n';
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; }
  }
}

module.exports = { CTodoDB, TABLES, DEFAULT_SETTINGS, SEGMENT_COLUMNS, defaultDataDir, defaultDbPath };
