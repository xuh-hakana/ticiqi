'use strict';
/**
 * 命令方块 · Node 本地服务层
 *
 * 从 server/server.py 移植而来（路由、返回结构、SSE 事件名逐条对齐），
 * 目的是让客户端在 Windows / macOS 上都不依赖 Python。
 * 前端 web/js/app.js 不需要任何改动即可直接连这套接口。
 *
 * 对外：createApp(options) -> App 实例；app.listen(port) -> Promise<port>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const scanner = require('./scanner');
const { Store } = require('./store');
const { PromptBook, health } = require('./promptbook');
const { parseAndClassify } = require('./importer');
const { IssueBook } = require('./issues');
const { RecordBook } = require('./records');   // 【已完成区】数据层：AI 只写 C_DONE.jsonl，索引由本类生成
const memoryArchive = require('./memory-archive'); // 【workbuddy 记忆区】只读检索：原话/落点/案例，不搬移源文件
const { CTodoCore } = require('./ctodo-core'); // 【C_TODO】阶段 0 地基 + 阶段 1~3：主干/状态机/C_TODO.md 生成

const VERSION_FALLBACK = '0.1.0';
const MAX_BODY_BYTES = 1_500_000;
const API_PROBE_TIMEOUT = 8000;

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

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function posixNorm(rel) {
  const p = path.posix.normalize(String(rel || '').replace(/\\/g, '/'));
  return p;
}

/**
 * 两次扫描之间「内容变了」的文件。
 * 判据用 mtime + size：内容改动这两个至少变一个，比逐字节比对便宜。
 * 只报旧索引里也有的文件——纯新增文件由「新」标记负责，不重复打点。
 * 上限 200 条，防止一次批量操作把 SSE 帧撑大（前端只用来点小圆点，不需要全量）。
 */
function diffFileState(before, after) {
  const out = [];
  if (!before || !after) return out;
  for (const [rel, meta] of after) {
    const old = before.get(rel);
    if (!old) continue;
    if (old.mtime !== meta.mtime || old.size !== meta.size) {
      out.push(rel);
      if (out.length >= 200) break;
    }
  }
  return out;
}

function loadRelease(appRoot) {
  const raw = { version: VERSION_FALLBACK, sections: [], candidates: [] };
  try {
    Object.assign(raw, JSON.parse(fs.readFileSync(path.join(appRoot, '版本公告.json'), 'utf8')));
  } catch (e) { /* 没有公告文件：用兜底 */ }
  // 公告页「复制需求原文」显示最新一轮；上一轮原文仍在 docs/用户需求-本轮.md，不覆盖。
  try {
    raw.requirement = fs.readFileSync(path.join(appRoot, 'docs', '用户需求-v2原文.md'), 'utf8');
  } catch (e) {
    try { raw.requirement = fs.readFileSync(path.join(appRoot, 'docs', '用户需求-本轮.md'), 'utf8'); }
    catch (e2) { raw.requirement = ''; }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// RepoService：当前打开的只读根目录 + 内存扫描状态
// ---------------------------------------------------------------------------
class RepoService {
  constructor(appRoot, dataDir) {
    this.appRoot = path.resolve(appRoot);
    this.dataDir = path.resolve(dataDir);
    this.root = '';
    this.tree = null;
    this.filesByRel = new Map();
    this.baseNames = new Set();
    this.newPaths = new Set();
    this.indexCache = null;
    this.indexSignature = '';
  }

  validateRoot(raw) {
    let text = String(raw == null ? '' : raw).trim();
    if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[0] === text[text.length - 1]) {
      text = text.slice(1, -1);
    }
    if (!text) throw new Error('请填写文件夹路径');
    let expanded = text;
    if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
      expanded = path.join(os.homedir(), text.slice(2));
    }
    let resolved;
    try {
      resolved = fs.realpathSync(expanded);
    } catch (e) {
      throw new Error('文件夹不存在或无权访问');
    }
    if (!fs.statSync(resolved).isDirectory()) throw new Error('这个路径不是文件夹');
    if (path.resolve(resolved) === this.dataDir || inside(resolved, this.dataDir)) {
      throw new Error('命令方块的配置目录含密钥，不能作为浏览根目录');
    }
    return resolved;
  }

  hasRoot() { return !!this.root; }
  rootDisplay() { return this.root || ''; }

  ignoredPaths() {
    const list = [this.dataDir];
    for (const name of ['.data', 'data']) {
      const candidate = path.join(this.appRoot, name);
      try {
        if (fs.existsSync(candidate) && fs.realpathSync(candidate) !== this.dataDir) list.push(fs.realpathSync(candidate));
      } catch (e) { /* 忽略无权访问的目录 */ }
    }
    return list;
  }

  scanLocked() {
    if (!this.root) throw new Error('尚未打开文件夹');
    const result = scanner.scanTree(this.root, this.appRoot, this.ignoredPaths());
    const map = new Map();
    for (const item of result.files) {
      item.new = false;
      map.set(String(item.path), item);
    }
    this.filesByRel = map;
    if (this.baseNames.size) {
      for (const k of [...this.newPaths]) if (!map.has(k)) this.newPaths.delete(k);
      for (const k of map.keys()) if (!this.baseNames.has(k)) this.newPaths.add(k);
    }
    for (const rel of this.newPaths) if (map.has(rel)) map.get(rel).new = true;
    result.files = [...map.keys()].sort().map(k => map.get(k));
    result.newFiles = [...this.newPaths].sort();
    result.newCount = this.newPaths.size;
    result.indexedAt = Date.now();
    return result;
  }

  setRoot(rootPath) {
    this.root = rootPath;
    this.tree = null;
    this.filesByRel = new Map();
    this.baseNames = new Set();
    this.newPaths = new Set();
    this.indexCache = null;
    this.indexSignature = '';
    const result = this.scanLocked();
    this.baseNames = new Set(this.filesByRel.keys());
    this.newPaths = new Set();
    result.newFiles = [];
    result.newCount = 0;
    for (const item of result.files) item.new = false;
    this.tree = result;
    return result;
  }

  getTree(force) {
    if (!this.root) throw new Error('尚未打开文件夹');
    if (force || !this.tree) this.tree = this.scanLocked();
    return this.tree;
  }

  refreshIfChanged() {
    if (!this.root) return { changed: false, tree: null };
    const previous = this.tree ? this.tree.signature : '';
    // 旧索引必须在 scanLocked 覆盖 filesByRel 之前留住，否则没得比。
    const before = this.filesByRel;
    const fresh = this.scanLocked();
    this.tree = fresh;
    if (fresh.signature === previous) return { changed: false, tree: null };
    this.indexCache = null;
    this.indexSignature = '';
    return { changed: true, tree: fresh, changedPaths: diffFileState(before, this.filesByRel) };
  }

  readFile(rel) {
    const norm = posixNorm(rel);
    if (norm === '..' || norm.startsWith('../') || norm.startsWith('/')) {
      const e = new Error('路径越界'); e.code = 'EACCES'; throw e;
    }
    if (!this.filesByRel.has(norm)) {
      if (!this.root) { const e = new Error(norm); e.code = 'ENOENT'; throw e; }
      this.tree = this.scanLocked();
      if (!this.filesByRel.has(norm)) { const e = new Error(norm); e.code = 'ENOENT'; throw e; }
    }
    const meta = this.filesByRel.get(norm);
    const data = scanner.readVisibleFile(this.root, norm, meta);
    data.new = this.newPaths.has(norm);
    return data;
  }

  buildIndex(force) {
    if (!this.root) throw new Error('尚未打开文件夹');
    if (!this.tree) this.tree = this.scanLocked();
    const signature = this.tree.signature;
    if (!force && this.indexCache && this.indexSignature === signature) return this.indexCache;
    const root = this.root;
    const files = [...this.tree.files];
    const result = scanner.buildSymbolIndex(root, files);
    result.signature = signature;
    if (this.root !== root) throw new Error('工作区已切换，请重新加载索引');
    this.indexCache = result;
    this.indexSignature = signature;
    return result;
  }

  acknowledgeNew() {
    this.newPaths = new Set();
    this.baseNames = new Set(this.filesByRel.keys());
    for (const item of this.filesByRel.values()) item.new = false;
    if (this.tree) {
      this.tree.newCount = 0;
      this.tree.newFiles = [];
      for (const item of this.tree.files) item.new = false;
    }
    return { newCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// App：状态容器 + watcher + SSE 广播
// ---------------------------------------------------------------------------
class App {
  constructor(options) {
    const opts = options || {};
    this.verbose = !!opts.verbose;
    this.appRoot = path.resolve(opts.appRoot || path.join(__dirname, '..', '..'));
    this.webDir = path.resolve(opts.webDir || path.join(this.appRoot, 'web'));
    this.dataDir = path.resolve(opts.dataDir || defaultDataDir());
    fs.mkdirSync(this.dataDir, { recursive: true });
    // ticiqi 独立项目写 port-ticiqi，不覆盖命令方块的 port / port-prompter。
    // 需求库仍共用同一份（联动功能，归命令方块侧维护），本侧不复制第二份。
    this.portFileName = opts.portFile || 'port';
    // 剪贴板捕获会写需求库，只让提词器那个进程跑，避免两个进程同时写同一份 json。
    this.enablePrompts = opts.enablePrompts !== false;

    this.store = new Store(this.dataDir);
    this.prompts = new PromptBook(this.dataDir, {
      readClipboard: opts.readClipboard,
    });
    this.issues = new IssueBook(this.appRoot);   // 【遗留问题】数据层
    this.records = new RecordBook(this.appRoot); // 【已完成区】数据层（记录归位，见 说明.md 第 7 节）
    // 【C_TODO】统一需求内核（spec_00 地基 + 阶段 1~3 主干/状态机）。db 跟随 dataDir，不碰 prompts.json。
    this.ctodo = new CTodoCore(opts.ctodoDbPath || path.join(this.dataDir, 'ctodo.db'), this.appRoot);
    this.repo = new RepoService(this.appRoot, this.dataDir);
    this.release = loadRelease(this.appRoot);
    this.sseClients = new Set();
    this.apiStatus = { state: 'unchecked', latency: null, checkedAt: null, message: '尚未检测' };
    this.pickFolder = opts.pickFolder || null;      // Electron 注入：async () => string
    this.watcherTimer = null;
    this.server = null;
    this.port = 0;

    this.openInitialRoot(opts.rootOverride);
  }

  openInitialRoot(rootOverride) {
    const candidates = [];
    if (rootOverride) candidates.push(rootOverride);
    const saved = this.store.currentRoot();
    if (saved) candidates.push(saved);
    candidates.push(path.dirname(this.appRoot), this.appRoot);
    for (const candidate of candidates) {
      try {
        const valid = this.repo.validateRoot(candidate);
        this.repo.setRoot(valid);
        this.store.setCurrentRoot(valid);
        return;
      } catch (e) {
        if (this.verbose) console.error('[command-block] 根目录不可用', candidate, e.message);
      }
    }
    if (this.verbose) console.error('[command-block] 没有可读的初始根目录');
  }

  // -- SSE -----------------------------------------------------------------
  broadcast(event, payload) {
    const line = 'event: ' + event + '\ndata: ' + JSON.stringify(payload || {}) + '\n\n';
    for (const res of this.sseClients) {
      try { res.write(line); } catch (e) { /* 客户端断开，下方 close 会清掉 */ }
    }
  }

  startWatcher() {
    const tick = () => {
      const delay = this.sseClients.size ? 2000 : 10000;
      this.watcherTimer = setTimeout(() => {
        try {
          if (this.sseClients.size && this.repo.hasRoot()) {
            const r = this.repo.refreshIfChanged();
            if (r.changed && r.tree) {
              this.broadcast('tree', {
                at: Date.now(),
                signature: r.tree.signature,
                counts: r.tree.counts,
                newCount: r.tree.newCount,
                changed: r.changedPaths || [],
              });
            }
          }
        } catch (e) {
          if (this.verbose) console.error('[command-block] watch', e);
        }
        tick();
      }, delay);
      if (this.watcherTimer.unref) this.watcherTimer.unref();
    };
    tick();
  }

  stop() {
    if (this.watcherTimer) clearTimeout(this.watcherTimer);
    this.watcherTimer = null;
    if (this.enablePrompts) { try { this.prompts.stop(); } catch (e) { /* 忽略 */ } }
    for (const res of this.sseClients) { try { res.end(); } catch (e) {} }
    this.sseClients.clear();
  }

  publicApi() { return Object.assign({}, this.store.publicApiConfig(), { status: Object.assign({}, this.apiStatus) }); }

  async testApi() {
    const cfg = this.store.apiConfig();
    if (!cfg.baseUrl) {
      this.apiStatus = { state: 'unconfigured', latency: null, checkedAt: Date.now(), message: '请先填写 API 地址' };
      return Object.assign({}, this.apiStatus);
    }
    const started = Date.now();
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/models';
    const key = this.store.apiKey();
    const result = { state: 'error', latency: null, checkedAt: Date.now(), message: '' };
    try {
      const target = new URL(url);
      const mod = target.protocol === 'https:' ? https : http;
      await new Promise((resolve, reject) => {
        const req = mod.request(target, {
          method: 'GET',
          headers: Object.assign({ Accept: 'application/json', 'User-Agent': 'CommandBlock/0.1' }, key ? { Authorization: 'Bearer ' + key } : {}),
        }, res => {
          let body = '';
          res.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
          res.on('end', () => {
            const ms = Date.now() - started;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              result.state = 'ok'; result.latency = ms; result.message = '连接正常';
            } else if (res.statusCode === 401 || res.statusCode === 403) {
              result.state = 'unauthorized'; result.latency = ms; result.message = '密钥无效或权限不足';
            } else {
              result.state = 'error'; result.latency = ms; result.message = 'HTTP ' + res.statusCode;
            }
            resolve();
          });
        });
        req.on('error', reject);
        req.setTimeout(API_PROBE_TIMEOUT, () => { const e = new Error('连接超时'); req.destroy(e); });
        req.end();
      });
    } catch (e) {
      result.latency = Date.now() - started;
      result.message = e && e.message ? e.message : '连接失败';
    }
    result.checkedAt = Date.now();
    this.apiStatus = Object.assign({}, result);
    return Object.assign({}, result);
  }

  statePayload() {
    const root = this.repo.rootDisplay();
    const exists = !!(root && fs.existsSync(root) && fs.statSync(root).isDirectory());
    return {
      version: this.release.version || VERSION_FALLBACK,
      appRoot: this.appRoot,
      root: {
        path: root,
        name: root ? path.basename(root) : '',
        exists,
        isAppRoot: !!(root && path.resolve(root) === this.appRoot),
      },
      favorites: root ? this.store.favorites(root) : [],
      notes: root ? this.store.notes(root) : {},
      recent: this.store.recentRoots(),
      api: this.publicApi(),
      safety: {
        readOnly: true,
        excluded: ['.env / 密钥 / 证书', '日志与缓存', '构建产物与依赖目录', '符号链接不跟随', '插件配置数据'],
        dataDir: this.store.dataDirDisplay(),
      },
    };
  }

  treePayload(tree) {
    return Object.assign({}, tree, {
      files: [...(tree.files || [])],
      newFiles: [...(tree.newFiles || [])],
      newCount: Number(tree.newCount || 0),
      rootName: tree.rootName || path.basename(String(tree.root || '')),
    });
  }

  /** 这是干什么的：按 record-sources.json 自动同步最近日志；配置读不到也不影响服务启动。 */
  autoSyncRecords() {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'record-sources.json'), 'utf8'));
      if (cfg.enabled === false) return { skipped: true };
      const r = this.records.syncRecent(cfg.logRoots || cfg.logRoot, cfg.maxAgeDays);
      if (r.added) this.broadcast('records', this.records.state());
      return r;
    } catch (e) { return { error: e.message }; }
  }

  // -- HTTP ----------------------------------------------------------------
  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', reject);
      server.listen(port || 0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        try { fs.writeFileSync(path.join(this.dataDir, this.portFileName), String(this.port), 'utf8'); } catch (e) {}
        this.startWatcher();
        if (this.enablePrompts) this.prompts.start();
        this.autoSyncRecords();   // 【已完成区】启动时自动同步日志，AI 每轮零调用（说明.md 第 7 节）
        resolve(this.port);
      });
    });
  }

  close() {
    this.stop();
    try { fs.unlinkSync(path.join(this.dataDir, this.portFileName)); } catch (e) {}
    if (this.server) { try { this.server.close(); } catch (e) {} }
  }

  sendJson(res, payload, status) {
    const body = Buffer.from(JSON.stringify(payload === undefined ? {} : payload), 'utf8');
    res.writeHead(status || 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(reqMethod(res) === 'HEAD' ? undefined : body);
  }

  sendError(res, status, message, code) {
    this.sendJson(res, { error: message, code: code || 'error' }, status);
  }

  hostOk(req) {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  }

  mutationOk(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
    } catch (e) { return false; }
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 格式不正确')); }
      });
      req.on('error', reject);
    });
  }

  async handle(req, res) {
    if (!this.hostOk(req)) return this.sendError(res, 403, '只允许通过 127.0.0.1 或 localhost 访问', 'host');
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return this.sendError(res, 400, '地址不正确', 'bad_request'); }
    const p = url.pathname;
    const q = url.searchParams;
    try {
      if (req.method === 'GET') return await this.handleGet(req, res, p, q);
      if (req.method === 'HEAD') return await this.handleGet(req, res, p, q, true);
      // PUT / PATCH 与 POST 同义：网页端保存收藏夹用的是 PUT，早期只放行 POST，
      // 结果「保存收藏」一律 405，收藏夹看起来完全不可用。三条一起放行。
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        if (!this.mutationOk(req)) return this.sendError(res, 403, '来源不被允许', 'origin');
        return await this.handlePost(req, res, p);
      }
      return this.sendError(res, 405, '不支持的请求方法', 'method');
    } catch (e) {
      if (this.verbose) console.error('[command-block]', e);
      const msg = e && e.message || '服务器内部错误';
      const known = /格式不正确|路径越界|不正确|不能|上限|请填写|不存在|不是文件夹|未打开|已切换/.test(msg);
      return this.sendError(res, known ? 400 : 500, known ? msg : '服务器内部错误', known ? 'bad_request' : 'internal');
    }
  }

  async handleGet(req, res, p, q, headOnly) {
    res.__headOnly = !!headOnly;
    if (p === '/api/health') return this.sendJson(res, { ok: true, version: this.release.version || VERSION_FALLBACK, appRoot: this.appRoot, root: this.repo.rootDisplay() });
    if (p === '/api/state') return this.sendJson(res, this.statePayload());
    if (p === '/api/tree') return this.sendJson(res, this.treePayload(this.repo.getTree(q.get('refresh') === '1')));
    if (p === '/api/file') {
      const rel = q.get('path') || '';
      if (!rel) return this.sendError(res, 400, '缺少文件路径', 'missing_path');
      try { return this.sendJson(res, this.repo.readFile(rel)); }
      catch (e) {
        if (e.code === 'EACCES') return this.sendError(res, 403, '路径不在当前文件夹内', 'forbidden');
        return this.sendError(res, 404, '文件不在当前只读镜像中，或已被排除', 'not_found');
      }
    }
    if (p === '/api/index') return this.sendJson(res, this.repo.buildIndex(q.get('refresh') === '1'));
    if (p === '/api/favorites') {
      const root = this.repo.rootDisplay();
      return this.sendJson(res, { root, categories: this.store.favorites(root) });
    }
    if (p === '/api/prompts') return this.sendJson(res, this.prompts.state());
    if (p === '/api/issues') return this.sendJson(res, this.issues.state());
    if (p === '/api/issues/question') return this.sendJson(res, this.issues.question(q.get('id')));
    if (p === '/api/issues/export') return this.sendJson(res, { text: this.issues.exportText() });
    if (p === '/api/records') return this.sendJson(res, this.records.state());
    if (p === '/api/records/detail') return this.sendJson(res, this.records.detail(q.get('id')));
    if (p === '/api/ctodo/state') return this.sendJson(res, this.ctodo.db.state());
    if (p === '/api/ctodo/access-rule') return this.sendJson(res, { text: this.ctodo.db.accessRule() });
    if (p === '/api/ctodo/overview') {
      return this.sendJson(res, this.ctodo.overview(q.get('project') || null));
    }
    if (p === '/api/ctodo/tree') {
      return this.sendJson(res, this.ctodo.tree(q.get('project') || this.ctodo.currentProjectId(), q.get('invalid') === '1'));
    }
    if (p === '/api/ctodo/search') {
      return this.sendJson(res, { items: this.ctodo.search(this.ctodo.currentProjectId(), q.get('q')) });
    }
    if (p === '/api/ctodo/todo-preview') {
      try {
        const built = this.ctodo.buildTodoMd(this.ctodo.currentProjectId(), q.get('node') || null);
        return this.sendJson(res, { md: built.md, notes: built.notes, pending: built.pending,
          userCount: built.userTodos.length, aiCount: built.aiTodos.length });
      } catch (e) { return this.sendError(res, 400, e.message || '生成失败', 'ctodo_error'); }
    }
    if (p === '/api/ctodo/todo-md') {
      const fs = require('fs');
      try { return this.sendJson(res, { md: fs.readFileSync(this.ctodo.todoMd, 'utf8') }); }
      catch (e) { return this.sendJson(res, { md: '', empty: true }); }
    }
    if (p === '/api/ctodo/confirm-queue') {
      const pid = q.get('project') || this.ctodo.currentProjectId();
      try { return this.sendJson(res, this.ctodo.confirmQueue(pid)); }
      catch (e) { return this.sendError(res, 400, e.message || '读取失败', 'ctodo_error'); }
    }
    if (p === '/api/ctodo/project/root') {
      const id = q.get('id') || this.ctodo.currentProjectId();
      return this.sendJson(res, { id, root: this.ctodo.getProjectRoot(id) });
    }
    if (p === '/api/memory-archive') {
      const op = q.get('op') || 'list';
      if (op === 'find') return this.sendJson(res, memoryArchive.find(q.get('q'), q.get('limit')));
      if (op === 'get') return this.sendJson(res, memoryArchive.get(q.get('name')));
      if (op === 'rebuild') return this.sendJson(res, memoryArchive.rebuild());
      return this.sendJson(res, memoryArchive.list());
    }
    if (p === '/api/api') return this.sendJson(res, this.publicApi());
    if (p === '/api/new/ack') return this.sendError(res, 405, '请使用 POST', 'method');
    if (p === '/api/release') return this.sendJson(res, this.release);
    if (p === '/api/events') return this.serveEvents(req, res);
    if (p.startsWith('/api/')) return this.sendError(res, 404, '接口不存在', 'no_route');
    return this.serveStatic(res, p);
  }

  async handlePost(req, res, p) {
    const body = await this.readBody(req);
    if (p === '/api/root') {
      let valid;
      try { valid = this.repo.validateRoot(body.path); }
      catch (e) { return this.sendError(res, 400, e.message, 'invalid_root'); }
      const tree = this.repo.setRoot(valid);
      this.store.setCurrentRoot(valid);
      return this.sendJson(res, { root: valid, tree: this.treePayload(tree), state: this.statePayload() });
    }
    if (p === '/api/rescan') return this.sendJson(res, this.treePayload(this.repo.getTree(true)));
    if (p === '/api/new/ack') return this.sendJson(res, this.repo.acknowledgeNew());
    if (p === '/api/favorites') {
      const root = this.repo.rootDisplay();
      if (!root) return this.sendError(res, 409, '尚未打开文件夹', 'no_root');
      if (body.root && body.root !== root) return this.sendError(res, 409, '工作区已切换，请重新操作收藏夹', 'root_changed');
      const categories = this.store.saveFavorites(root, body.categories);
      return this.sendJson(res, { root, categories });
    }
    if (p === '/api/api') {
      const config = this.store.updateApiConfig(body);
      this.apiStatus = { state: 'unchecked', latency: null, checkedAt: null, message: '配置已保存，等待检测' };
      this.broadcast('api-status', { state: 'unchecked', message: '配置已保存' });
      return this.sendJson(res, Object.assign({}, config, { status: this.publicApi().status }));
    }
    if (p === '/api/api/test') {
      const result = await this.testApi();
      this.broadcast('api-status', result);
      return this.sendJson(res, result);
    }
    if (p === '/api/issues/add' || p === '/api/issues/answer' || p === '/api/issues/confirm' ||
        p === '/api/issues/promote' || p === '/api/issues/rework') {
      try {
        if (p === '/api/issues/add') return this.sendJson(res, this.issues.add(body));
        if (p === '/api/issues/answer') return this.sendJson(res, this.issues.answer(body));
        if (p === '/api/issues/confirm') return this.sendJson(res, this.issues.confirm(body));
        if (p === '/api/issues/promote') return this.sendJson(res, this.issues.promote(body));
        return this.sendJson(res, this.issues.rework(body));
      } catch (e) { return this.sendError(res, 400, e.message || '操作失败', 'issue_error'); }
    }
    if (p === '/api/records/add') {
      try { return this.sendJson(res, this.records.append(body)); }
      catch (e) { return this.sendError(res, 400, e.message || '写入失败', 'record_error'); }
    }
    if (p === '/api/records/cleanup') {
      try { return this.sendJson(res, this.records.cleanup(body.ids, body.reason)); }
      catch (e) { return this.sendError(res, 400, e.message || '清理失败', 'record_error'); }
    }
    if (p === '/api/records/rebuild') return this.sendJson(res, this.records.rebuild());
    if (p === '/api/records/sync') return this.sendJson(res, this.autoSyncRecords());
    if (p === '/api/ctodo/next-id') {
      try { return this.sendJson(res, { id: this.ctodo.db.nextId(body.kind || 'req', String(body.project || '')) }); }
      catch (e) { return this.sendError(res, 400, e.message || 'id 生成失败', 'ctodo_error'); }
    }
    if (p === '/api/ctodo/ingest/analyze') {
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return this.sendError(res, 400, '原文为空', 'missing_text');
      try {
        const core = this.ctodo;
        const pid = body.projectId || core.currentProjectId();
        const proj = pid ? core.getProject(pid) : null;
        const nodes = pid ? core.listNodes(pid) : [];
        const existingTexts = pid ? core.listRequirements(pid).filter(r => !r.archived).map(r => r.text) : [];
        const ingest = require('./ingest');
        const out = ingest.analyze(text, {
          source: body.source || '', fileName: body.fileName || '',
          projectId: pid, projectRoot: pid ? core.getProjectRoot(pid) : '',
          existingProjects: core.listProjects(true), nodes, existingTexts,
        });
        return this.sendJson(res, out);
      } catch (e) { return this.sendError(res, 400, e.message || '识别失败', 'ingest_error'); }
    }
    if (p === '/api/ctodo/ingest/commit') {
      const list = Array.isArray(body.proposals) ? body.proposals : [];
      if (!list.length) return this.sendError(res, 400, '没有可写入的条目', 'empty_proposals');
      try {
        const core = this.ctodo;
        const pid = body.projectId || core.currentProjectId();
        const ingest = require('./ingest');
        const first = list[0] || {};
        const isAnalyzeShape = first.segments && typeof first.segments === 'object' && !Array.isArray(first.segments)
          && Array.isArray(first.files) && (first.files.length === 0 || (first.files[0] && typeof first.files[0] === 'object'));
        const payload = isAnalyzeShape ? ingest.proposalsToCore(list) : list;
        return this.sendJson(res, core.ingestCommit(pid, payload, {}));
      } catch (e) { return this.sendError(res, 400, e.message || '写入失败', 'ingest_error'); }
    }
    // 【C_TODO 阶段 1~3】写操作统一走 ctodoCore，失败 400 + 中文原因（事务已在 core 内回滚）。
    if (p.startsWith('/api/ctodo/')) {
      try {
        const core = this.ctodo;
        const pid = body.project || core.currentProjectId();
        let out;
        switch (p) {
          case '/api/ctodo/project/create':   out = core.createProject(body.name, body.folderName); break;
          case '/api/ctodo/project/switch':   out = core.switchProject(body.id); break;
          case '/api/ctodo/project/rename':   out = core.renameProject(body.id, body.name); break;
          case '/api/ctodo/project/archive':  out = core.archiveProject(body.id, body.archived !== false); break;
          case '/api/ctodo/project/delete':   out = core.deleteProject(body.id); break;
          case '/api/ctodo/project/restore':  out = core.restoreProject(body.id); break;
          case '/api/ctodo/node/add':         out = core.addNode(pid, body.name, body.parentId || null, body.type); break;
          case '/api/ctodo/node/rename':      out = core.renameNode(body.nodeId, body.name); break;
          case '/api/ctodo/node/delete':      out = core.deleteNode(body.nodeId); break;
          case '/api/ctodo/req/add':          out = core.addRequirement(pid, body.text, body); break;
          case '/api/ctodo/req/edit':         out = core.editRequirement(body.id, body.patch || {}); break;
          case '/api/ctodo/req/supplement':   out = core.supplement(body.id, body.text); break;
          case '/api/ctodo/req/archive':      out = core.archiveRequirement(body.id); break;
          case '/api/ctodo/req/restore':      out = core.restoreRequirement(body.id); break;
          case '/api/ctodo/req/status':       out = core.setStatusSimple(body.id, body.status); break;
          case '/api/ctodo/req/complete':     out = core.completeManual(body.id, body); break;
          case '/api/ctodo/req/confirm-ai':   out = core.confirmAi(body.id, body); break;
          case '/api/ctodo/req/reopen':       out = core.reopen(body.id); break;
          case '/api/ctodo/req/mark-wrong':   out = core.markWrong(body.id, body.text, body.reason); break;
          case '/api/ctodo/req/ai-confirm':   out = core.confirmAiNew(body.id); break;
          case '/api/ctodo/req/ai-confirm-batch': out = core.confirmAiNewBatch(body.ids || []); break;
          case '/api/ctodo/req/move':         out = core.moveRequirement(body.id, body.nodeId || null, body.reason); break;
          case '/api/ctodo/project/root':     out = core.setProjectRoot(body.id, body.root); break;
          case '/api/ctodo/req/ai-cleanup':   out = core.aiCleanup(body.id, body.reason); break;
          case '/api/ctodo/sync':             out = core.sync(pid, body.node || null); break;
          default: return this.sendError(res, 404, '接口不存在', 'no_route');
        }
        return this.sendJson(res, out);
      } catch (e) { return this.sendError(res, 400, e.message || '操作失败', 'ctodo_error'); }
    }
    if (p === '/api/prompts') return this.sendJson(res, this.prompts.upsert(body));
    if (p === '/api/prompts/check') return this.sendJson(res, { health: health(typeof body.text === 'string' ? body.text : '') });
    if (p === '/api/prompts/delete') return this.sendJson(res, this.prompts.delete(String(body.id || '')));
    if (p === '/api/prompts/accept') {
      const accepted = this.prompts.acceptPending(String(body.id || ''));
      this.broadcast('prompts', this.prompts.state());
      return this.sendJson(res, accepted);
    }
    if (p === '/api/prompts/dismiss') return this.sendJson(res, this.prompts.dismissPending(String(body.id || '')));
    if (p === '/api/prompts/capture') return this.sendJson(res, { capture: this.prompts.setCapture(body) });
    if (p === '/api/import') {
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return this.sendError(res, 400, '导入内容为空', 'empty_import');
      const existing = new Set(
        (this.prompts.data.items || []).map((it) => String(it.text || '').trim()).filter(Boolean)
      );
      const parsed = parseAndClassify(text, { dedupe: existing });
      if (!parsed.length) {
        // 全部与库里重复：不算错，回 200 + created:0，前端给友好提示。
        return this.sendJson(res, { created: 0, items: [], skippedAll: true, message: '没有解析出新的需求条目（可能都已存在）' });
      }
      const created = this.prompts.importItems(parsed);
      this.broadcast('prompts', this.prompts.state());
      return this.sendJson(res, { created: created.length, items: created });
    }
    if (p === '/api/notes') {
      const root = this.repo.rootDisplay();
      if (!root) return this.sendError(res, 409, '尚未打开文件夹', 'no_root');
      return this.sendJson(res, { notes: this.store.saveNote(root, String(body.path || ''), String(body.text || '')) });
    }
    if (p === '/api/pick-folder') {
      if (!this.pickFolder) return this.sendJson(res, { cancelled: true, path: '', unsupported: true });
      const picked = await this.pickFolder();
      return this.sendJson(res, picked ? { cancelled: false, path: picked } : { cancelled: true, path: '' });
    }
    if (p === '/api/folder-stats') {
      // 扇形图「可直接拖入」用的：扫描任意外部文件夹，只回文件清单（相对路径 + 字节数）。
      // 只读、排除规则与文件树完全一致，不写、不改、不外传。
      let dir;
      try { dir = fs.realpathSync(String(body.path || '').trim() || '\u0000'); }
      catch (e) { return this.sendError(res, 400, '文件夹不存在或无权访问', 'invalid_folder'); }
      if (!fs.statSync(dir).isDirectory()) return this.sendError(res, 400, '这个路径不是文件夹', 'invalid_folder');
      if (dir === this.dataDir) return this.sendError(res, 400, '命令方块的配置目录含密钥，不能统计', 'forbidden_dir');
      let result;
      try { result = scanner.scanTree(dir, this.appRoot, [this.dataDir]); }
      catch (e) { return this.sendError(res, 400, '这个文件夹读不了：' + (e.message || '无权访问'), 'scan_failed'); }
      let total = 0;
      const files = [];
      for (const item of result.files) {
        total += Number(item.size) || 0;
        files.push({ path: String(item.path), size: Number(item.size) || 0 });
      }
      return this.sendJson(res, {
        path: dir,
        name: path.basename(dir),
        files,
        total,
        count: files.length,
        counts: result.counts,
        excluded: result.excluded,
        truncated: !!result.truncated,
        signature: result.signature,
      });
    }
    if (p === '/api/focus') {
      // 虚幻客户端「看原文」复用窗口的入口，语义与 Python 版一致。
      let rel = String(body.path || '').trim();
      if (!rel) return this.sendError(res, 400, '缺少文件路径', 'missing_path');
      rel = posixNorm(rel);
      if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return this.sendError(res, 400, '路径越界', 'bad_path');
      const root = this.repo.root;
      if (!root) return this.sendError(res, 409, '尚未打开文件夹', 'no_root');
      let full;
      try { full = fs.realpathSync(path.join(root, rel)); } catch (e) { full = ''; }
      if (!full || full === root || !inside(full, root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return this.sendError(res, 404, '文件不在当前根目录内或不存在', 'not_found');
      }
      let line = 0;
      try { line = Math.floor(Number(body.line || 0)) || 0; } catch (e) { line = 0; }
      this.broadcast('focus', { path: rel, line });
      return this.sendJson(res, { ok: true, path: rel, line });
    }
    return this.sendError(res, 404, '接口不存在', 'no_route');
  }

  serveEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2500\n\n');
    res.write('event: hello\ndata: {"ok":true}\n\n');
    this.sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    if (ping.unref) ping.unref();
    req.on('close', () => { clearInterval(ping); this.sseClients.delete(res); });
  }

  serveStatic(res, urlPath) {
    let rel;
    try { rel = decodeURIComponent(urlPath.replace(/^\/+/, '')); } catch (e) { rel = ''; }
    if (!rel) rel = 'index.html';
    if (rel.indexOf('\0') !== -1) return this.sendError(res, 400, '非法路径', 'bad_path');
    const candidate = path.resolve(this.webDir, rel);
    if (!inside(candidate, this.webDir) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      return this.sendError(res, 404, '页面不存在', 'not_found');
    }
    const ext = path.extname(candidate).toLowerCase();
    const mimeMap = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      '.md': 'text/markdown; charset=utf-8',
    };
    const body = fs.readFileSync(candidate);
    res.writeHead(200, {
      'Content-Type': mimeMap[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // img-src 的 blob: 是雨夜玻璃库要的：raindrop-fx 把内嵌纹理转成 blob: URL 再解码，
      // 少了它 onload 永不触发、整个雨天层静默不出现。
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(res.__headOnly ? undefined : body);
  }
}

function reqMethod(res) { return res.req ? res.req.method : 'GET'; }

function createApp(options) { return new App(options); }

module.exports = { createApp, App, RepoService, defaultDataDir, VERSION_FALLBACK };

// 允许 `node app/backend/server.js --port 8809 --root <dir>` 独立跑（验证/调试用）。
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const app = createApp({
    rootOverride: get('--root', ''),
    dataDir: get('--data-dir', '') || undefined,
    portFile: get('--port-file', '') || undefined,
    verbose: argv.includes('--verbose'),
  });
  app.listen(Number(get('--port', 0)) || 0).then(port => {
    console.log('[command-block] http://127.0.0.1:' + port + '  root=' + app.repo.rootDisplay());
  }).catch(e => { console.error('启动失败：' + e.message); process.exit(1); });
}
