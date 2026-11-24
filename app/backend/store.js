'use strict';

/**
 * store.js —— Node.js (CommonJS) 移植版，直接对应 server/store.py。
 *
 * 移植来源：/server/store.py（Python 3，只读原件，不得修改）。
 * 对应关系：
 *   store.Store          -> Store
 *   store.validate_base_url -> validateBaseUrl
 *   store.normalize_rel_path -> normalizeRelPath
 *   store._clean_text    -> cleanText
 *   store.DEFAULT_API    -> DEFAULT_API
 *
 * 两边必须保持一致：
 *   - 对外抛出的错误文案（中文原文照抄，一字不改）；
 *   - state.json / secrets.json 的字段结构、默认值合并规则、写入方式（原子写 + 0600）;
 *   - publicApiConfig() 的字段集合，任何返回给前端的字段都不得包含完整 API Key。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_API = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  autoCheck: true,
};

const MAX_CATEGORIES = 60;
const MAX_ITEMS_PER_CATEGORY = 300;
const MAX_FAVORITES = 1500;
const MAX_ROOTS = 12;
const ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

// -- Python 内建语义的最小模拟 ------------------------------------------------

// Python 的 str()：None -> 'None'，True -> 'True'。
function _rawStr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value)) return '[' + value.map(_rawStr).join(', ') + ']';
  return String(value);
}

// Python 惯用的 `str(x or "")`：空值一律变空串。
function _text(value) {
  if (!value) return '';
  return _rawStr(value);
}

// Python 的 bool()。
function _pyBool(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

// Python 的 str.strip() 的空白集合（与 JS trim 略有差别，这里对齐 Python）。
const PY_SPACE = /[\t\n\v\f\r \x1c-\x1f\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
function _pyStrip(value) {
  let start = 0;
  let end = value.length;
  while (start < end && PY_SPACE.test(value[start])) start += 1;
  while (end > start && PY_SPACE.test(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

// 按码点切片（Python 的 str 切片语义，不是 UTF-16 码元）。
function _pySlice(value, limit) {
  const points = Array.from(value);
  if (points.length <= limit) return points.join('');
  return points.slice(0, limit).join('');
}

// 按码点计数（Python 的 len()）。
function _pyLen(value) {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

// 取末尾 n 个码点（Python 的 value[-n:]）。
function _pyTail(value, n) {
  const points = Array.from(value);
  if (points.length <= n) return points.join('');
  return points.slice(points.length - n).join('');
}

// Python 的 str.splitlines()（含 \r\n / \r / \v / \f / \x1c-\x1e / \x85 / \u2028 / \u2029）。
function _pySplitLines(value) {
  return value.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
}

function _has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 避免 "__proto__" 之类的键污染原型链（Python 的 dict 没有这个问题）。
function _safeSet(obj, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, {
      value: value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

function _isDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Python 的 str(Path)：去掉多余斜杠，保留根目录。
function _normalizeDir(value) {
  const raw = String(value === null || value === undefined ? '' : value);
  if (!raw) return '.';
  const absolute = raw.startsWith('/');
  const parts = raw.split('/').filter((part) => part.length > 0);
  const joined = parts.join('/');
  if (absolute) return '/' + joined;
  return joined || '.';
}

// -- 原子写 ------------------------------------------------------------------

function _atomicJson(target, payload, mode) {
  const perm = mode === undefined ? 0o600 : mode;
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    path.basename(target) + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
  );
  const body = JSON.stringify(payload, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w', perm);
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, perm);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
}

// -- 纯函数 ------------------------------------------------------------------

// 对应 Python 的 _clean_text()：非字符串返回 ''，去掉 \0，trim，截断。
function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/\u0000/g, '').trim();
  return _pySlice(cleaned, limit);
}

// 近似 Python urllib.parse.urlsplit()：只取 scheme / netloc / query / fragment。
function _urlsplit(url) {
  let rest = url.replace(/[\t\r\n]/g, '');
  rest = rest.replace(/^[\u0000-\u0020]+/, '');
  let scheme = '';
  let rest2 = rest;
  const colon = rest.indexOf(':');
  if (colon > 0 && /^[A-Za-z]/.test(rest[0]) && /^[A-Za-z0-9+\-.]+$/.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest2 = rest.slice(colon + 1);
  }
  let netloc = '';
  if (rest2.slice(0, 2) === '//') {
    const after = rest2.slice(2);
    let end = after.length;
    for (const ch of ['/', '?', '#']) {
      const idx = after.indexOf(ch);
      if (idx !== -1 && idx < end) end = idx;
    }
    netloc = after.slice(0, end);
    rest2 = after.slice(end);
  }
  let fragment = '';
  const hash = rest2.indexOf('#');
  if (hash !== -1) {
    fragment = rest2.slice(hash + 1);
    rest2 = rest2.slice(0, hash);
  }
  let query = '';
  const q = rest2.indexOf('?');
  if (q !== -1) {
    query = rest2.slice(q + 1);
    rest2 = rest2.slice(0, q);
  }
  return { scheme: scheme, netloc: netloc, query: query, fragment: fragment };
}

// netloc 里的 user:pass@。
function _urlUserInfo(netloc) {
  const at = netloc.lastIndexOf('@');
  if (at === -1) return { username: null, password: null };
  const userinfo = netloc.slice(0, at);
  const colon = userinfo.indexOf(':');
  if (colon === -1) return { username: userinfo, password: null };
  return { username: userinfo.slice(0, colon), password: userinfo.slice(colon + 1) };
}

// 对应 Python 的 validate_base_url()，错误文案照抄。
function validateBaseUrl(value) {
  const url = cleanText(value, 500);
  if (!url) return '';
  const parsed = _urlsplit(url);
  if ((parsed.scheme !== 'http' && parsed.scheme !== 'https') || !parsed.netloc) {
    throw new Error('API 地址必须是 http(s) 网址');
  }
  const info = _urlUserInfo(parsed.netloc);
  if (info.username || info.password) {
    throw new Error('API 地址不能包含账号密码');
  }
  if (parsed.query || parsed.fragment) {
    throw new Error('API 地址不能包含查询参数或锚点');
  }
  return url.replace(/\/+$/, '');
}

// 对应 Python 的 normalize_rel_path()，错误文案照抄。
function normalizeRelPath(value) {
  let rel = cleanText(value, 900).replace(/\\/g, '/');
  if (
    rel.startsWith('/') ||
    rel.startsWith('../') ||
    rel.indexOf('/../') !== -1 ||
    rel === '..' ||
    rel === '.'
  ) {
    throw new Error('路径越界');
  }
  while (rel.startsWith('./')) {
    rel = rel.slice(2);
  }
  return rel;
}

// -- Store -------------------------------------------------------------------

class Store {
  constructor(dataDir) {
    this.dataDir = _normalizeDir(dataDir);
    this.statePath = path.join(this.dataDir, 'state.json');
    this.secretPath = path.join(this.dataDir, 'secrets.json');
    this.state = this._loadState();
    this.secret = this._loadSecret();
    // Python 版把 api 状态放在 server.py 的 App 里；这里以实例字段承载，
    // updateApiConfig() 之后重置为「未检测」，与 /api/api 的行为一致。
    this.apiStatus = {
      state: 'unchecked',
      latency: null,
      checkedAt: null,
      message: '尚未检测',
    };
  }

  // -- persistence -----------------------------------------------------

  _loadState() {
    const defaults = {
      schema: 1,
      currentRoot: '',
      recentRoots: [],
      roots: {},
      api: Object.assign({}, DEFAULT_API),
    };
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (err) {
      return defaults;
    }
    if (!_isDict(raw)) return defaults;
    const merged = Object.assign({}, defaults, raw);
    merged.api = Object.assign(
      {},
      defaults.api,
      _isDict(raw.api) ? raw.api : {}
    );
    merged.roots = _isDict(raw.roots) ? raw.roots : {};
    merged.recentRoots = Array.isArray(raw.recentRoots) ? raw.recentRoots : [];
    return merged;
  }

  _loadSecret() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.secretPath, 'utf8'));
      return _isDict(raw) ? raw : {};
    } catch (err) {
      return {};
    }
  }

  save() {
    _atomicJson(this.statePath, this.state);
  }

  _saveSecret() {
    _atomicJson(this.secretPath, this.secret);
    try {
      fs.chmodSync(this.secretPath, 0o600);
    } catch (err) {
      /* ignore */
    }
  }

  // -- roots -----------------------------------------------------------

  currentRoot() {
    return _text(this.state.currentRoot);
  }

  setCurrentRoot(rootPath) {
    const recent = (this.state.recentRoots || []).filter(
      (item) => _isDict(item) && item.path !== rootPath
    );
    recent.unshift({ path: rootPath, at: Date.now() });
    this.state.recentRoots = recent.slice(0, MAX_ROOTS);
    if (!this.state.roots || typeof this.state.roots !== 'object') this.state.roots = {};
    if (!Object.prototype.hasOwnProperty.call(this.state.roots, rootPath)) {
      _safeSet(this.state.roots, rootPath, { favorites: [] });
    }
    this.save();
  }

  recentRoots() {
    return (this.state.recentRoots || []).slice();
  }

  rootState(root) {
    if (!this.state.roots || typeof this.state.roots !== 'object') this.state.roots = {};
    if (!Object.prototype.hasOwnProperty.call(this.state.roots, root)) {
      _safeSet(this.state.roots, root, { favorites: [] });
    }
    const entry = this.state.roots[root];
    if (!Array.isArray(entry.favorites)) entry.favorites = [];
    return entry;
  }

  favorites(root) {
    const entry = this.rootState(root);
    return JSON.parse(JSON.stringify(entry.favorites || []));
  }

  saveFavorites(root, categories) {
    const clean = this._validateCategories(categories);
    this.rootState(root).favorites = clean;
    this.save();
    return clean;
  }

  _validateCategories(categories) {
    if (!Array.isArray(categories)) {
      throw new Error('收藏夹格式不正确');
    }
    if (categories.length > MAX_CATEGORIES) {
      throw new Error('分类不能超过 ' + MAX_CATEGORIES + ' 个');
    }
    const result = [];
    const seenIds = new Set();
    let total = 0;
    for (const rawCategory of categories) {
      if (!_isDict(rawCategory)) {
        throw new Error('分类格式不正确');
      }
      const name = cleanText(rawCategory.name, 40);
      if (!name) {
        throw new Error('分类名称不能为空');
      }
      let categoryId = cleanText(rawCategory.id, 48);
      if (!ID_RE.test(categoryId)) {
        categoryId = crypto.randomBytes(6).toString('hex');
      }
      if (seenIds.has(categoryId)) {
        categoryId = crypto.randomBytes(6).toString('hex');
      }
      seenIds.add(categoryId);
      const items = [];
      const seenPaths = new Set();
      let rawItems = rawCategory.items;
      if (!Array.isArray(rawItems)) rawItems = [];
      if (rawItems.length > MAX_ITEMS_PER_CATEGORY) {
        throw new Error('单个分类不能超过 ' + MAX_ITEMS_PER_CATEGORY + ' 项');
      }
      for (const rawItem of rawItems) {
        if (!_isDict(rawItem)) continue;
        let rel = '';
        try {
          rel = normalizeRelPath(rawItem.path);
        } catch (err) {
          continue;
        }
        if (!rel || seenPaths.has(rel)) continue;
        seenPaths.add(rel);
        const kind = rawItem.kind === 'folder' ? 'folder' : 'file';
        items.push({
          path: rel,
          kind: kind,
          name: rel.split('/').pop(),
        });
        total += 1;
        if (total >= MAX_FAVORITES) break;
      }
      result.push({ id: categoryId, name: name, items: items });
      if (total >= MAX_FAVORITES) break;
    }
    return result;
  }

  // -- file notes ------------------------------------------------------

  notes(root) {
    const entry = this.rootState(root);
    const notes = entry.notes;
    if (!_isDict(notes)) return {};
    return JSON.parse(JSON.stringify(notes));
  }

  saveNote(root, rel, text) {
    const normalized = normalizeRelPath(rel);
    if (!normalized) {
      throw new Error('缺少文件路径');
    }
    const body = cleanText(text, 2000);
    const entry = this.rootState(root);
    let notes = entry.notes;
    if (!_isDict(notes)) {
      notes = {};
      entry.notes = notes;
    }
    if (body) {
      const count = Object.keys(notes).length;
      if (count >= 4000 && !Object.prototype.hasOwnProperty.call(notes, normalized)) {
        throw new Error('文件用途说明已达上限 4000 条');
      }
      _safeSet(notes, normalized, { text: body, at: Date.now() });
    } else {
      delete notes[normalized];
    }
    this.save();
    return JSON.parse(JSON.stringify(notes));
  }

  // -- API config ------------------------------------------------------

  apiConfig() {
    const api = Object.assign(
      {},
      DEFAULT_API,
      _isDict(this.state.api) ? this.state.api : {}
    );
    return {
      baseUrl: _text(api.baseUrl),
      model: _text(api.model),
      autoCheck: _pyBool(_has(api, 'autoCheck') ? api.autoCheck : true),
    };
  }

  publicApiConfig() {
    const cfg = this.apiConfig();
    const key = _text(this.secret.apiKey);
    const hint = _pyLen(key) >= 4 ? _pyTail(key, 4) : '';
    return Object.assign({}, cfg, {
      hasKey: _pyBool(key),
      keyHint: hint,
      maskedKey: key ? '••••' + hint : '',
    });
  }

  apiKey() {
    return _text(this.secret.apiKey);
  }

  updateApiConfig(payload) {
    if (!_isDict(payload)) {
      throw new Error('参数格式不正确');
    }
    const base = validateBaseUrl(_has(payload, 'baseUrl') ? payload.baseUrl : '');
    const model = cleanText(payload.model, 120) || DEFAULT_API.model;
    const autoCheck = _pyBool(_has(payload, 'autoCheck') ? payload.autoCheck : true);
    const clearKey = _pyBool(_has(payload, 'clearKey') ? payload.clearKey : false);
    const newKey = payload.apiKey;
    let keyToSave = '';
    if (!clearKey && typeof newKey === 'string' && newKey.trim()) {
      keyToSave = newKey.trim();
      if (keyToSave.length > 800 || keyToSave.indexOf('\n') !== -1 || keyToSave.indexOf('\r') !== -1) {
        throw new Error('API Key 格式不正确');
      }
    }
    this.state.api = { baseUrl: base, model: model, autoCheck: autoCheck };
    if (clearKey) {
      delete this.secret.apiKey;
      this._saveSecret();
    } else if (keyToSave) {
      this.secret.apiKey = keyToSave;
      this._saveSecret();
    }
    this.save();
    this.apiStatus = {
      state: 'unchecked',
      latency: null,
      checkedAt: null,
      message: '配置已保存，等待检测',
    };
    return this.publicApiConfig();
  }

  dataDirDisplay() {
    return this.dataDir;
  }
}

module.exports = { Store, validateBaseUrl, normalizeRelPath, cleanText, DEFAULT_API };
