'use strict';
/**
 * 【已完成区】· 后端数据层
 *
 * 这是干什么的：把 AI 每轮「记了」的内容写进已完成区。
 *   有她原话 → 三字段（我记的 / 她原话 / 对应文件哪几行），按规矩或名词分节；
 *   没有她原话 → 直接按「AI已完成」记两段式（我记的 / 对应文件哪几行），不跳过、不报错。
 *   名词解释本身及其文件（`名词解释/` / `名词表/` 归属 xuhuan mac 体系）不进提词器已完成区：
 *   parseLogText 只在「小节文件全是名词体系文件」时才跳过（见 parseLogText 内注释）；
 *   被解释名词对应的 ticiqi / xuhbot 功能与文件（只是顺带改到名词文件作证据）仍正常归档。
 *   `--kind noun` 直接写会被 append() 拒绝；已误归档的条目用 ai_cleanup 追加清理指令移除
 *   （见 cleanup()），不改动旧行。
 * 她 2026-11-09 原话：「以后这种如记了，就同步写到提词器，此功能优先靠代码实现，
 * 不然每轮都要废token，（名词解释也一样）」；同日追加：「没有我原话的时候直接按ai已完成记两段式」。
 *
 * 规格依据（不改原文、只补字段）：
 *   需求/文档一-AI接入规则.md:65  AI 只写 C_DONE.jsonl / C_ISSUES.jsonl，
 *                                索引与详情由软件生成 → 本类就是那个「软件」。
 *   :81-87  六种行格式（ai_new / ai_cleanup / complete / partial / reclassify / fix_move）；
 *   :105-123 字段约束；:107-109 与 :123 「只追加，不改旧行」保护的是 C_TODO.md 里的
 *   用户原文待办行（complete / partial），不是 AI 自己写的 ai_new 行；AI 自己的条目用 ai_cleanup 清理。
 *   需求/用户原始需求-逐字原文.txt:77  「AI新增归已完成区」。
 *   额外字段 quote（她原话）、kind（规矩 / 名词 / AI已完成）、shape（three 三字段 / two 两段式）
 *   按她 2026-11-09 要求追加；规格只要求「每行必须有 type」且软件按 type 分派，
 *   未禁止补充字段，原有字段一个不动。
 *
 * 数据落点：{appRoot}/.ticiqi/
 *   C_DONE.jsonl       只追加的 ai_new 行 + ai_cleanup 清理指令（AI 侧写的文件）
 *   C_DONE_INDEX.md    由代码生成的索引，按 kind 分节（规矩 / 名词 / AI已完成不混记）
 *   C_DONE/L0001.md    由代码生成的逐条详情，含三字段原文或两段式
 *
 * id 不写进 jsonl（规格 :111「ai_new 行不写 id，软件自动生成」）：
 * 用行号 L0001… 作 id，软件生成详情与索引时使用。
 */
const fs = require('fs');
const path = require('path');

const KIND_LABEL = { rule: '规矩', noun: '名词', ai: 'AI已完成' };
const LIMIT = { newText: 200, summary: 100, reason: 100, quote: 2000 };

/** 把「MEMORY.md:8」拆成 files 用的纯路径与 evidence 用的带行号引用。 */
function splitRef(ref) {
  const s = String(ref || '').trim().replace(/^`|`$/g, '');
  const m = /^(.*?)(?::(\d+(?:-\d+)?))?$/.exec(s);
  return { file: (m[1] || '').trim(), ref: s };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

class RecordBook {
  constructor(appRoot) {
    this.dir = path.join(path.resolve(appRoot), '.ticiqi');
    this.detailDir = path.join(this.dir, 'C_DONE');
    this.jsonl = path.join(this.dir, 'C_DONE.jsonl');
    this.index = path.join(this.dir, 'C_DONE_INDEX.md');
    fs.mkdirSync(this.detailDir, { recursive: true });
  }

  _lines() {
    let raw = '';
    try { raw = fs.readFileSync(this.jsonl, 'utf8'); } catch (e) { return []; }
    const out = [];
    raw.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try { out.push({ n: i + 1, row: JSON.parse(line) }); }
      catch (e) { /* 坏行跳过：只追加、不改旧行 */ }
    });
    return out;
  }

  _id(n) { return 'L' + String(n).padStart(4, '0'); }

  /** 收集所有 ai_cleanup 指令里列出的 id（行号 L0001…），用于 state/rebuild 过滤。 */
  _cleanedSet(lines) {
    const ls = lines || this._lines();
    const set = new Set();
    ls.forEach(x => {
      if (x.row && x.row.type === 'ai_cleanup' && Array.isArray(x.row.ids)) {
        x.row.ids.forEach(id => set.add(String(id)));
      }
    });
    return set;
  }

  /** 追加一条 ai_new。相同字段重复调用直接跳过（幂等，不产生幽灵条）。
   *  2026-11-09：没有「她原话」时不再报错，直接按 AI已完成两段式写入。 */
  append(body) {
    const b = body || {};
    const mine = String(b.mine || b.newText || '').trim();
    const quote = String(b.quote || '').trim();
    const two = !quote;                              // 两段式：我记的 + 对应文件（哪几行）
    if (b.kind === 'noun') throw new Error('名词解释不进提词器（走 xuhuan mac 名词体系）');
    const kind = two ? 'ai' : 'rule';
    const refs = (Array.isArray(b.files) ? b.files : String(b.files || '').split(/[,，\n]/))
      .map(splitRef).filter(x => x.file);
    if (!mine) throw new Error('「我记的」不能为空');
    if (!refs.length) throw new Error('「对应文件」不能为空');   // 两段式的第二段

    const lines = this._lines();
    const files = refs.map(x => x.file);
    const dup = lines.find(x => x.row.newText === mine && x.row.quote === quote &&
      JSON.stringify(x.row.files) === JSON.stringify(files));
    if (dup) return { ok: true, duplicate: true, id: this._id(dup.n) };

    const row = {
      type: 'ai_new',
      fromReq: b.fromReq === undefined ? null : b.fromReq,
      newText: mine.slice(0, LIMIT.newText),
      quote: quote.slice(0, LIMIT.quote),
      kind: kind,
      shape: two ? 'two' : 'three',
      summary: String(b.summary || b.title || mine).trim().slice(0, LIMIT.summary),
      files: files,
      evidence: refs.map(x => x.ref),
      reason: String(b.reason || (two ? '无她原话：按 AI已完成两段式自动同步' : '按 §1-6 记录归位，自动同步')).trim().slice(0, LIMIT.reason),
      time: new Date().toISOString(),
    };
    fs.appendFileSync(this.jsonl, JSON.stringify(row) + '\n', 'utf8');
    const lineNo = lines.length + 1;
    const id = this._id(lineNo);
    this._writeDetail(id, row);
    this.rebuild();
    return { ok: true, duplicate: false, id: id };
  }

  _writeDetail(id, row) {
    const two = row.shape === 'two' || !row.quote;
    const fields = two
      ? '## 两段式（AI已完成，没有她原话）\n\n' +
        '1. **我记的**：' + row.newText + '\n' +
        '2. **对应文件（哪几行）**：' + (row.evidence || []).join('、') + '\n\n'
      : '## 三字段\n\n' +
        '1. **我记的**：' + row.newText + '\n' +
        '2. **她原话**：' + row.quote + '\n' +
        '3. **对应文件（哪几行）**：' + (row.evidence || []).join('、') + '\n\n';
    const text =
      '# ' + id + ' · ' + (KIND_LABEL[row.kind] || '规矩') + ' · ' + esc(row.summary) + '\n\n' +
      '这是干什么的：已完成区条目详情。由代码从 `C_DONE.jsonl` 生成，勿手改；改原文只追加新行。\n\n' +
      fields +
      '## 规格字段\n\n' +
      '- type：`ai_new`（AI 新增归已完成区）\n' +
      '- fromReq：' + (row.fromReq === null ? 'null' : esc(row.fromReq)) + '\n' +
      '- kind / shape：' + esc(row.kind) + ' / ' + esc(row.shape || (two ? 'two' : 'three')) + '\n' +
      '- files：' + (row.files || []).join('、') + '\n' +
      '- reason：' + esc(row.reason) + '\n' +
      '- time：' + row.time + '\n';
    fs.writeFileSync(path.join(this.detailDir, id + '.md'), text, 'utf8');
  }

  /** 由代码重建索引与全部详情文件；规格 :65 这两个文件「由软件生成」。 */
  rebuild() {
    const lines = this._lines();
    const cleaned = this._cleanedSet(lines);
    // 被清理的条目：删掉其生成的详情文件（详情是软件生成物，可删可重建）
    cleaned.forEach(id => { try { fs.unlinkSync(path.join(this.detailDir, id + '.md')); } catch (e) {} });
    const effective = lines.filter(x => x.row.type !== 'ai_cleanup' && !cleaned.has(this._id(x.n)));
    effective.forEach(x => this._writeDetail(this._id(x.n), x.row));
    const groups = { rule: [], noun: [], ai: [] };
    effective.forEach(x => {
      const k = KIND_LABEL[x.row.kind] ? x.row.kind : 'rule';
      groups[k].push({ id: this._id(x.n), row: x.row });
    });
    let md = '# 已完成区 · 索引（由代码生成，勿手改）\n\n' +
      '这是干什么的：把 AI 每轮「记了」的记录列成索引；' +
      '规矩与名词按类别分节，不混记（她 2026-11-08 定的名词分类规则）；' +
      '没有她原话的按「AI已完成」两段式记（她 2026-11-09 定）。\n\n' +
      '- 数据正本：`.ticiqi/C_DONE.jsonl`（只追加）\n' +
      '- 共 ' + effective.length + ' 条 · 规矩 ' + groups.rule.length + ' · 名词 ' + groups.noun.length +
      ' · AI已完成 ' + groups.ai.length + '\n\n';
    Object.keys(groups).forEach(k => {
      md += '## ' + KIND_LABEL[k] + '\n\n';
      if (!groups[k].length) { md += '（暂无）\n\n'; return; }
      md += '| id | 时间 | 摘要 | 我记的 | 对应文件（哪几行） | 详情 |\n' +
        '| --- | --- | --- | --- | --- | --- |\n';
      groups[k].forEach(x => {
        md += '| ' + x.id + ' | ' + esc(x.row.time) + ' | ' + esc(x.row.summary) +
          ' | ' + esc(x.row.newText) + ' | ' + esc((x.row.evidence || []).join('、')) +
          ' | `C_DONE/' + x.id + '.md` |\n';
      });
      md += '\n';
    });
    const tmp = this.index + '.tmp';
    fs.writeFileSync(tmp, md, 'utf8');
    fs.renameSync(tmp, this.index);
    return { total: effective.length, rule: groups.rule.length, noun: groups.noun.length, ai: groups.ai.length };
  }

  /**
   * 这是干什么的：按规格 :85-87 的 ai_cleanup 行，追加一条「清理自己 ai_done 条目」的指令，
   * 把指定 id（行号 L0001…）的 ai_new 条目从已完成区视图中移除。
   * 不改动旧行、不删 jsonl 里的 ai_new 旧行（遵守 :123 只追加、不改旧行）——只是追加一条清理指令，
   * 由 state()/rebuild() 在生成索引与详情时过滤掉被清理的 id；被清理条目的详情文件一并删除
   * （详情是软件生成物，可删可重建）。
   */
  cleanup(ids, reason) {
    const list = (Array.isArray(ids) ? ids : String(ids || '').split(/[,，\s]+/))
      .map(s => String(s).trim()).filter(Boolean);
    if (!list.length) throw new Error('cleanup 需要至少一个 id');
    list.forEach(id => { if (!/^L\d{4}$/.test(id)) throw new Error('id 格式应为 L0001：' + id); });
    const existing = this._cleanedSet();
    if (list.every(id => existing.has(id))) {     // 已清理过 → 不重复追加指令（避免残渣）
      this.rebuild();
      return { ok: true, ids: list, duplicate: true };
    }
    const row = {
      type: 'ai_cleanup',
      ids: list,
      reason: String(reason || '清理 AI 自身条目').slice(0, LIMIT.reason),
      time: new Date().toISOString(),
    };
    fs.appendFileSync(this.jsonl, JSON.stringify(row) + '\n', 'utf8');
    this.rebuild();
    return { ok: true, ids: list };
  }

  state() {
    const lines = this._lines();
    const cleaned = this._cleanedSet(lines);
    const counts = { rule: 0, noun: 0, ai: 0 };
    const items = lines
      .filter(x => x.row.type !== 'ai_cleanup' && !cleaned.has(this._id(x.n)))
      .map(x => {
        const k = KIND_LABEL[x.row.kind] ? x.row.kind : 'rule';
        counts[k] += 1;
        return {
          id: this._id(x.n), time: x.row.time, kind: k, kindLabel: KIND_LABEL[k],
          shape: x.row.shape || (x.row.quote ? 'three' : 'two'),
          summary: x.row.summary || '', mine: x.row.newText || '',
          quote: x.row.quote || '', files: x.row.files || [],
          evidence: x.row.evidence || [], reason: x.row.reason || '',
          detailFile: 'C_DONE/' + this._id(x.n) + '.md',
        };
      });
    return {
      dir: this.dir, jsonl: this.jsonl, index: this.index,
      total: items.length, counts: counts, items: items,
    };
  }

  detail(id) {
    if (!/^L\d{4}$/.test(String(id || ''))) return { ok: false, error: 'id 不正确' };
    try {
      return { ok: true, id: id, text: fs.readFileSync(path.join(this.detailDir, id + '.md'), 'utf8') };
    } catch (e) { return { ok: false, error: '详情文件不存在' }; }
  }

  /**
   * 这是干什么的：提词器启动时自动把最近的工作区日志同步进已完成区。
   * 她 2026-11-09「此功能优先靠代码实现，不然每轮都要废token」——
   * 有了这个，AI 每轮不必调命令、也不必在提示词里记「记得同步」。
   * 只扫各根下的 .workbuddy/memory/*.md 且 mtime 在 maxAgeDays 内，不递归全盘；
   * 三字段相同的小节自动去重。
   *
   * 2026-11-09 她定「按用户/ai分别记，记到 ticiqi」后补：
   * logRoot 支持数组 / 逗号分隔多个根，且认三种形状——
   *   ① 根 = 装着多个会话目录的父目录（原行为：<根>/<会话>/.workbuddy/memory）
   *   ② 根 = 某个工作区目录本身（<根>/.workbuddy/memory）
   *   ③ 根 = memory 目录本身（<根>/*.md）
   * 只写 logRoot 一个的旧配置照样能用。
   */
  syncRecent(logRoot, maxAgeDays) {
    const out = { files: 0, parsed: 0, added: 0, duplicated: 0, failed: 0, skippedOld: 0, roots: 0 };
    const roots = (Array.isArray(logRoot) ? logRoot : String(logRoot || '').split(','))
      .map(s => String(s || '').trim()).filter(Boolean);
    if (!roots.length) return out;
    const cutoff = Date.now() - (Number(maxAgeDays) || 2) * 86400000;

    const dirs = [];
    roots.forEach(root => {
      out.roots += 1;
      if (path.basename(root) === 'memory') { dirs.push(root); return; }
      const self = path.join(root, '.workbuddy', 'memory');
      if (fs.existsSync(self)) dirs.push(self);
      let subs = [];
      try {
        subs = fs.readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory()).map(d => d.name);
      } catch (e) { return; }
      subs.forEach(name => dirs.push(path.join(root, name, '.workbuddy', 'memory')));
    });

    [...new Set(dirs)].forEach(dir => {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); }
      catch (e) { return; }
      files.forEach(f => {
        const p = path.join(dir, f);
        let st;
        try { st = fs.statSync(p); } catch (e) { return; }
        if (st.mtimeMs < cutoff) { out.skippedOld += 1; return; }
        out.files += 1;
        const items = parseLogText(fs.readFileSync(p, 'utf8'));
        out.parsed += items.length;
        items.forEach(it => {
          try {
            const r = this.append(it);
            if (r.duplicate) out.duplicated += 1; else out.added += 1;
          } catch (e) { out.failed += 1; }
        });
      });
    });
    return out;
  }
}

/**
 * 这是干什么的：把工作区日志（markdown 小节）解析成已完成区条目，
 * 让 CLI 一条命令就能同步整份日志，AI 每轮不必在对话里手写汇总（省 token）。
 * 2026-11-09 她定：没有「- 她原话要点：」的小节不再跳过，直接按「AI已完成」两段式记。
 * fallbackRef 由 CLI 传入（日志路径 + 行号）：小节里没有带行号引用时，用它当第二段的定位。
 */
function parseLogText(text, fallbackRef) {
  const chunks = String(text || '').split(/^## /m).slice(1);
  const out = [];
  chunks.forEach(chunk => {
    const lines = chunk.split(/\r?\n/);
    const title = (lines.shift() || '').trim();
    let note = '', quote = '', extra = [];
    const refs = [];
    lines.forEach(line => {
      const t = line.trim();
      const mNote = /^这是干什么的：(.+)$/.exec(t);
      const mQuote = /^- 她原话要点：(.+)$/.exec(t);
      const mRef = /`([^`]+:\d+(?:-\d+)?)`/.exec(t);
      if (mNote) note = mNote[1].trim();
      else if (mQuote) quote = mQuote[1].trim();
      else if (/^- (改动|检索结论|未做|查重结论|本轮自测|核查|她纠正|真实根因|代码|数据|验证|文档|待办)/.test(t)) extra.push(t.replace(/^- /, ''));
      if (mRef) refs.push(mRef[1]);
      // 一条「改动」行里可能有多个反引号引用
      const all = t.match(/`([^`]+:\d+(?:-\d+)?)`/g) || [];
      all.forEach(s => { const v = s.replace(/`/g, ''); if (!refs.includes(v)) refs.push(v); });
    });
    // 名词解释本身（`名词解释/` / `名词表/` 归属 xuhuan mac 体系）不进提词器已完成区；
    // 仅当「小节所有文件都是名词体系文件」时才跳过——被解释名词对应的 ticiqi / xuhbot 功能
    // 与文件（只是顺带改到名词文件作证据）仍正常归档。「标题含名词」不跳过（2026-11-09 她豁免）。
    if (refs.length && refs.every(r => /名词解释|名词表/.test(r))) return;
    if (!refs.length && fallbackRef) refs.push(fallbackRef);
    if (!refs.length) return;                      // 连兜底都没有 → 两段式缺第二段，跳过
    const two = !quote;
    const mine = [title, note].filter(Boolean).concat(extra).join('；').slice(0, LIMIT.newText);
    out.push({
      mine: mine, quote: quote.slice(0, LIMIT.quote), files: refs,
      kind: two ? 'ai' : 'rule',
      shape: two ? 'two' : 'three',
      summary: title.slice(0, LIMIT.summary),
      reason: two ? '按 §1-6 无她原话：AI已完成两段式，日志自动同步' : '按 §1-6 记录归位，日志自动同步',
    });
  });
  return out;
}

module.exports = { RecordBook, parseLogText, splitRef, KIND_LABEL, LIMIT };
