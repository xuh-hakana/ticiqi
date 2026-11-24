'use strict';
/**
 * 【遗留问题】· 后端数据层
 *
 * 这是干什么的：把「要她一一回复的问题」逐条落成文件；回答由代码自动记成原始需求，
 * 她确认后才算解决；按状态机管理 ai待办 / 已解决 / 已失效 / 返工顶替。
 *
 * 数据落点：{appRoot}/需求/遗留问题/
 *   _index.json        索引（状态、层级、来源、回答文件名）
 *   {id}.md            问题文件（登记后只读，回答后不改）
 *   {id}-回答-{n}.md   回答文件（代码自动记 = 原始需求；每次另开新文件）
 *
 * 规则（她 2026-11-06 原话，逐条对应）：
 *   - 【遗留问题】= 新的、未完成的、ai 层级；回答前视为【ai待办】
 *   - 完成状态变【已解决】，在【已完成】层级；【已解决】视为【ai新增】
 *   - 【ai转正】视为【已完成】，与【ai新增】做区分（layer 字段区分）
 *   - 回答后的文件，读取优先度介于【待办】和【ai待办】之间（exportText 顺序）
 *   - 回答后 ai 已读取、且未解决时又要新增 → 另开新文件，不改已被回答的文件
 *   - 返工：新【返工完成】→【已完成】；被顶替的旧【完成】→【已失效】；其他需求不动
 */
const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z0-9_-]+$/i;

class IssueBook {
  constructor(appRoot) {
    this.root = appRoot;
    this.dir = path.join(appRoot, '需求', '遗留问题');
    this.reqDir = path.join(appRoot, '需求');
    this.indexPath = path.join(this.dir, '_index.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _readIndex() {
    try {
      const j = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      return Array.isArray(j.items) ? j : { version: 1, items: [] };
    } catch (e) {
      return { version: 1, items: [] };
    }
  }

  _writeIndex(j) {
    const tmp = this.indexPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
    fs.renameSync(tmp, this.indexPath);
  }

  _safeId(v) {
    const s = String(v || '');
    if (!ID_RE.test(s)) throw new Error('非法 id：' + s);
    return s;
  }

  _read(file, fallback) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return fallback || ''; }
  }

  _now() { return new Date().toISOString(); }

  state() {
    const j = this._readIndex();
    const counts = { ai_todo: 0, answered: 0, resolved: 0, invalidated: 0 };
    for (const it of j.items) if (counts[it.status] !== undefined) counts[it.status] += 1;
    return {
      items: j.items.map(it => ({
        id: it.id,
        title: it.title,
        source: it.source || '',
        status: it.status,
        layer: it.layer || '',
        confirmed: !!it.confirmed,
        createdAt: it.createdAt || '',
        questionFile: it.questionFile || (it.id + '.md'),
        answerFile: it.answerFile || '',
        answerFiles: Array.isArray(it.answerFiles) ? it.answerFiles : (it.answerFile ? [it.answerFile] : []),
        reworkOf: it.reworkOf || '',
        supersededBy: it.supersededBy || '',
      })),
      counts: counts,
      total: j.items.length,
    };
  }

  question(id) {
    const it = this._readIndex().items.find(x => x.id === this._safeId(id));
    if (!it) return { ok: false, error: '条目不存在' };
    return {
      ok: true,
      text: this._read(path.join(this.dir, it.questionFile || (it.id + '.md')), '（问题文件缺失）'),
    };
  }

  /** 新增【遗留问题】：永远另开新文件，不改任何已有文件。 */
  add(body) {
    const j = this._readIndex();
    const title = String(body.title || '').trim().slice(0, 200);
    if (!title) throw new Error('标题不能为空');
    let n = j.items.length + 1;
    let id = 'issue_' + String(n).padStart(3, '0');
    while (j.items.some(x => x.id === id)) { n += 1; id = 'issue_' + String(n).padStart(3, '0'); }
    const qf = id + '.md';
    fs.writeFileSync(path.join(this.dir, qf),
      '# ' + title + '\n\n' +
      '这是干什么的：【遗留问题】条目。回答前视为【ai待办】；回答后本文件不改。\n\n' +
      '- 来源：' + String(body.source || '（未填）') + '\n' +
      '- 状态：ai待办（未回答）\n' +
      '- 规则：回答时另开新文件，本文件保持原样。\n',
      'utf8');
    j.items.push({
      id: id, title: title, source: String(body.source || ''),
      status: 'ai_todo', layer: 'ai_todo', confirmed: false,
      createdAt: this._now(), questionFile: qf, answerFile: '', answerFiles: [],
      reworkOf: '', supersededBy: '',
    });
    this._writeIndex(j);
    return { ok: true, id: id };
  }

  /** 回答：代码自动记为原始需求，另开新文件；不修改问题文件，也不修改已有回答文件。 */
  answer(body) {
    const j = this._readIndex();
    const id = this._safeId(body.id);
    const it = j.items.find(x => x.id === id);
    if (!it) return { ok: false, error: '条目不存在' };
    const text = String(body.text || '').trim();
    if (!text) return { ok: false, error: '回答不能为空' };
    let n = 1;
    let af = id + '-回答-' + n + '.md';
    while (fs.existsSync(path.join(this.dir, af))) { n += 1; af = id + '-回答-' + n + '.md'; }
    fs.writeFileSync(path.join(this.dir, af),
      '# 回答 · ' + it.title + '\n\n' +
      '这是干什么的：她对本条【遗留问题】的回答；代码自动记为**原始需求**，需她确认。\n\n' +
      '- 问题：' + it.title + '\n' +
      '- 来源：' + it.source + '\n' +
      '- 回答时间：' + this._now() + '\n' +
      '- 状态：已回答 / 待用户确认\n' +
      '- 读取优先度：介于【待办】和【ai待办】之间\n\n' +
      '## 原始需求（逐字，不改）\n\n' + text + '\n',
      'utf8');
    it.status = 'answered';
    it.layer = 'answered';
    it.confirmed = false;
    // 一份回答 = 一个文件；旧回答文件保留并可被导出，绝不被覆盖丢失。
    it.answerFiles = Array.isArray(it.answerFiles) ? it.answerFiles : (it.answerFile ? [it.answerFile] : []);
    it.answerFiles.push(af);
    it.answerFile = af;   // 最新一份，界面显示用
    this._writeIndex(j);
    return { ok: true, id: id, answerFile: af };
  }

  /** 用户确认：状态变【已解决】，落在【已完成】层级，且视为【ai新增】。 */
  confirm(body) {
    const j = this._readIndex();
    const id = this._safeId(body.id);
    const it = j.items.find(x => x.id === id);
    if (!it) return { ok: false, error: '条目不存在' };
    if (it.status !== 'answered') return { ok: false, error: '只有已回答、未确认的条目能确认' };
    it.status = 'resolved';
    it.layer = 'ai_new';
    it.confirmed = true;
    this._writeIndex(j);
    return { ok: true, id: id, status: 'resolved', layer: 'ai_new' };
  }

  /** ai转正：视为【已完成】，与【已解决】的 ai_new 做区分。 */
  promote(body) {
    const j = this._readIndex();
    const id = this._safeId(body.id);
    const it = j.items.find(x => x.id === id);
    if (!it) return { ok: false, error: '条目不存在' };
    it.status = 'resolved';
    it.layer = 'ai_promoted';
    it.confirmed = true;
    this._writeIndex(j);
    return { ok: true, id: id, layer: 'ai_promoted' };
  }

  /**
   * 返工：
   *   1) 被【返工完成】顶替的旧【完成】 -> 【已失效】（只改这一条）
   *   2) 新的【返工完成】另开新条目，状态【已完成】
   *   3) 其他条目一个都不动（不静默顶替）
   */
  rework(body) {
    const j = this._readIndex();
    const id = this._safeId(body.id);
    const old = j.items.find(x => x.id === id);
    if (!old) return { ok: false, error: '条目不存在' };
    if (old.status !== 'resolved') return { ok: false, error: '只有【已完成】层级的条目能返工' };
    let n = 1;
    let newId = id + '-rework' + n;
    while (j.items.some(x => x.id === newId)) { n += 1; newId = id + '-rework' + n; }
    const qf = newId + '.md';
    const note = String(body.note || '').trim();
    fs.writeFileSync(path.join(this.dir, qf),
      '# 返工完成 · ' + old.title + '\n\n' +
      '这是干什么的：返工产生的新结果，状态【已完成】；旧完成记录已变【已失效】。\n\n' +
      '- 被顶替的旧完成：' + id + '\n' +
      '- 说明：' + (note || '（未填）') + '\n' +
      '- 时间：' + this._now() + '\n',
      'utf8');
    old.status = 'invalidated';
    old.layer = 'invalid';
    old.supersededBy = newId;
    j.items.push({
      id: newId, title: '返工完成 · ' + old.title, source: old.source,
      status: 'resolved', layer: 'done', confirmed: true,
      createdAt: this._now(), questionFile: qf, answerFile: '', answerFiles: [],
      reworkOf: id, supersededBy: '',
    });
    this._writeIndex(j);
    return { ok: true, invalidated: id, completed: newId };
  }

  /** 本轮给 Agent 的需求文本：待办 > 回答后的文件 > ai待办。 */
  exportText() {
    const j = this._readIndex();
    const out = [];
    out.push('# 提词器 · 本轮给 Agent 的需求');
    out.push('');
    out.push('读取优先度由高到低：待办 > 回答后的文件 > ai待办。');
    out.push('');
    out.push('## 1 待办（最高）');
    out.push('');
    const todo = this._read(path.join(this.reqDir, '用户原需求.md'), '');
    out.push(todo.indexOf('空置占位') >= 0 ? '（用户原需求区空置，等「原需求整理功能」写好后再逐字导入）' : todo.trim());
    out.push('');
    out.push('## 2 回答后的文件（介于待办与 ai待办之间）');
    out.push('');
    let answerCount = 0;
    for (const it of j.items) {
      const files = Array.isArray(it.answerFiles) ? it.answerFiles : (it.answerFile ? [it.answerFile] : []);
      for (const af of files) {
        answerCount += 1;
        out.push('### ' + it.id + ' · ' + af + ' [' + it.status + ' / ' + it.layer + ']');
        out.push('');
        out.push(this._read(path.join(this.dir, af), '（回答文件缺失）').trim());
        out.push('');
      }
    }
    if (!answerCount) out.push('（暂无回答文件）');
    out.push('## 3 ai待办（最低）');
    out.push('');
    out.push(this._read(path.join(this.reqDir, 'ai待办.md'), '（暂无 ai 待办登记）').trim());
    return out.join('\n');
  }
}

module.exports = { IssueBook };
