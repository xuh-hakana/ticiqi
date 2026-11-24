'use strict';
/**
 * ingest.js —— 「录入」归类引擎（纯代码，不调模型，零新依赖）
 *
 * 这是干什么的：把用户贴进来的一段原始内容（需求原话 / 真实项目的功能文档）
 * 自动拆条、判断大类与项目、归到功能节点、填六段、抽断言参数、找真实代码文件、
 * 连联动/复用，产出可写入需求的 proposal；commit 时交给 ctodo-core 单事务落库。
 *
 * 口径（主人 2026-11-22 定，别改）：
 *   · 有用户原话的才算用户需求（待办/想法/已完成 done_user）；
 *   · 没有用户原话、只有 AI 对功能的描述 → AI新增 ai_done，它也是已完成；
 *     写入后进「待确认区」，用户过目确认才转 AI转正，录入本身不弹二次确认。
 *   · 原文逐字保留在 text，六段是归类摘要，断言/参数另列，文件找不到就标「待核实」，不假装存在。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEGMENTS = ['应用场景', '背景', '前端', '后端', '数据来源', '前端排版'];
const SEGMENT_COLUMN = {
  应用场景: 'applicationScene', 背景: 'background', 前端: 'frontend',
  后端: 'backend', 数据来源: 'dataSource', 前端排版: 'frontendLayout',
};
const CATEGORIES = ['todo', 'idea', 'done_user', 'ai_done'];

const NOISE_PREFIX = /^添加到对话放大下载/;
const FIELD_WORDS = ['真名', 'QQ 昵称', 'QQ昵称', '群名片', 'B站昵称', '性别', '身份', '好感',
  '喜好·事实·约定·话题', '第一次相遇', '代称（别人喊的）', '代称', '曾用名'];
const SOURCE_MARKS = ['本人自报', '你面板说', '你面板', '面板改', '面板', '事件里的 card', 'B站 事件',
  '加账号时拉一次', '加账号时', '默认男猜', '本人自述', '建档', '被夸', '衰减', 'AI 听到',
  '你写记录时', '真实资料被覆盖', '资料卡'];
const WHEN_MARKS = ['他说话且昵称变了', '他说话且名片变了', 'card 空不覆盖', '变了才写', '发生即记',
  '建档时', '覆盖时', '现算不落盘', '变化时', '不落盘'];
const SPLIT_STARTERS = /(入口|代码做什么|代码|每条消息|判断|有没有档案|没档案|只进内存|不写 |不建档|本轮提示词|她会看到|称呼|未建档|触发点|对象是|seen\.enroll|现算|只有一条线|好感来源|账号 |role |sex |favor |name |nick |cards\{|dates )/g;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function normalize(text) { return String(text == null ? '' : text).replace(/\r\n?/g, '\n'); }
function squeeze(text) { return String(text == null ? '' : text).replace(/\s+/g, ''); }
function clip(text, n) { const s = String(text || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function dedupeKey(text) { return crypto.createHash('sha256').update(squeeze(text)).digest('hex').slice(0, 16); }
function estimateTokens(text) { return Math.max(1, Math.round(String(text || '').length / 1.5)); }
function uniq(list) { return Array.from(new Set(list)); }
function firstMatch(text, re) { const m = String(text || '').match(re); return m ? m[1] : ''; }

// ---------------------------------------------------------------------------
// A 文档识别：用户原话 / 功能文档
// ---------------------------------------------------------------------------
const REQ_WORDS = /(我要|我想要|我需要|应该|不能|必须|希望|方便|可以让|能不能|需要|优先|固定|应该给)/;
const DONE_WORDS = /(已做|已完成|已经实现|已实现|已写好|做好了|已经做了)/;
const IDEA_WORDS = /(想法|也许|或许|建议|规划中|暂定|设想|倾向)/;
const FEATURE_HINTS = /(\.(js|json|md|py|ts|css|html)\b|\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(|入口|字段|链路|时机|现算|落盘|建档|提示词)/;

function classifyProfile(text) {
  const t = String(text || '');
  const featureHits = (t.match(FEATURE_HINTS) || []).length;
  const bracketLevels = (t.match(/^[①②③④⑤⑥⑦⑧⑨⑩]/gm) || []).length;
  const reqHits = (t.match(REQ_WORDS) || []).length;
  if (featureHits >= 2 || bracketLevels >= 2) return 'feature-doc';
  if (reqHits >= 1) return 'user-requirement';
  return 'user-requirement';
}

function userStatus(text) {
  const t = String(text || '');
  if (IDEA_WORDS.test(t)) return 'idea';
  if (DONE_WORDS.test(t)) return 'done_user';
  return 'todo';
}

// ---------------------------------------------------------------------------
// B 结构解析
// ---------------------------------------------------------------------------
function splitEntries(text) {
  const raw = normalize(text);
  const lines = raw.split('\n');
  const L1 = /^([一二三四五六七八九十]+)、\s*(.+?)\s*$/;
  const L2 = /^([①②③④⑤⑥⑦⑧⑨⑩])\s*(.*?)\s*$/;
  const groups = [];
  const entries = [];
  const preamble = [];
  let group = '';
  let cur = null;

  let groupLine = '';
  const flush = () => {
    if (!cur) return;
    const bodyLines = cur.lines.slice(1);
    entries.push({
      marker: cur.marker, title: cur.title || makeTitle(bodyLines.join('\n')),
      group: cur.group, groupLine: cur.groupLine || '',
      // 一级标题也算原文：拼在条目 text 最前面，保证原文一字不丢
      lines: (cur.groupLine ? [cur.groupLine] : []).concat(cur.lines),
      body: trimBlank(bodyLines).join('\n'),
    });
    cur = null;
  };

  for (const line of lines) {
    const m1 = line.match(L1);
    if (m1) { flush(); group = m1[2].trim(); groupLine = line.trim(); if (!groups.includes(group)) groups.push(group); continue; }
    const m2 = line.match(L2);
    if (m2) { flush(); cur = { marker: m2[1], title: m2[2].trim(), group, groupLine, lines: [line] }; continue; }
    if (cur) cur.lines.push(line);
    else if (line.trim()) preamble.push(line);
  }
  flush();

  if (entries.length) return { profile: 'feature-doc', groups, entries, preamble };

  // 没有 ①②③ 层级：用户原话按行/短段拆；功能文档按一级标题或空行段拆
  const isFeature = classifyProfile(raw) === 'feature-doc';
  if (isFeature) {
    if (groups.length) {
      let bucket = [];
      let g = '';
      for (const line of lines) {
        const m1 = line.match(L1);
        if (m1) {
          if (bucket.length) entries.push(bundle(g, bucket, groups));
          g = m1[2].trim(); bucket = [];
          continue;
        }
        bucket.push(line);
      }
      if (bucket.length) entries.push(bundle(g, bucket, groups));
      return { profile: 'feature-doc', groups, entries: entries.filter(Boolean), preamble };
    }
    const paras = raw.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (paras.length > 1 && raw.length > 120) {
      return { profile: 'feature-doc', groups, entries: paras.map((p, i) => ({ marker: '', title: makeTitle(p), group: '', lines: p.split('\n'), body: p })), preamble };
    }
  }

  const userLines = raw.split('\n').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const line of userLines) {
    if (out.length) {
      const prev = out[out.length - 1];
      // 上一行没有句末标点且明显是折行（非列表）→ 合并，别把一句需求切成两条
      if (!/[。；！？：:]$/.test(prev) && prev.length > 40 && !/^[-•·*\d]/.test(line)) {
        out[out.length - 1] = prev + line;
        continue;
      }
    }
    out.push(line);
  }
  return {
    profile: 'user-requirement', groups, preamble,
    entries: out.map(t => ({ marker: '', title: makeTitle(t), group: '', lines: [t], body: t })),
  };
}

function bundle(group, lines, groups) {
  const body = trimBlank(lines).join('\n').trim();
  if (!body) return null;
  return { marker: '', title: group || makeTitle(body), group: group, lines: lines.slice(), body };
}
function trimBlank(lines) { return lines.slice(); }
function makeTitle(text, limit = 16) {
  const s = String(text || '').replace(NOISE_PREFIX, '').replace(/\s+/g, ' ').trim();
  if (!s) return '未命名';
  const first = s.split(/[。；！？\n]/)[0].trim() || s;
  return first.length > limit ? first.slice(0, limit) + '…' : first;
}

// ---------------------------------------------------------------------------
// 扁平表格修复（被粘贴成一行的「字段 × 来源 × 时机」）
// ---------------------------------------------------------------------------
function fieldStart(text, from) {
  let best = { pos: -1, word: '' };
  for (const w of FIELD_WORDS) {
    const i = text.indexOf(w, from);
    if (i < 0) continue;
    if (best.pos < 0 || i < best.pos || (i === best.pos && w.length > best.word.length)) best = { pos: i, word: w };
  }
  return best;
}

function isFlatTable(text) {
  const t = String(text || '');
  if (!/字段.*来源.*什么时候写/.test(t)) return false;
  let hits = 0;
  for (const w of FIELD_WORDS) if (t.includes(w)) hits += 1;
  return hits >= 6;
}

function repairFlatTable(text) {
  const t = String(text || '').replace(NOISE_PREFIX, '');
  const headMatch = t.match(/字段来源什么时候写|字段来源何时写|字段.*?来源.*?什么时候写/);
  const head = headMatch ? headMatch[0] : '字段来源什么时候写';
  const bodyStart = headMatch ? headMatch.index + head.length : 0;
  const body = t.slice(bodyStart);
  const starts = [];
  let pos = 0;
  while (pos < body.length) {
    const hit = fieldStart(body, pos);
    if (hit.pos < 0) break;
    starts.push(hit);
    pos = hit.pos + hit.word.length;
  }
  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = i + 1 < starts.length ? starts[i + 1].pos : body.length;
    const field = normalizeField(s.word);
    let rest = body.slice(s.pos + s.word.length, e).trim();
    // 上一个字段名前面可能粘着本行的来源词（例：资料卡QQ 昵称）→ 归到本行来源
    const prevGap = i > 0 ? body.slice(starts[i - 1].pos + starts[i - 1].word.length, s.pos) : '';
    const tailSource = pickTrailingSource(prevGap);
    if (tailSource) rest = tailSource + ' ' + rest;
    rest = rest.replace(/^[；;，,、\s]+/, '').replace(/[；;，,、\s]+$/, '');
    const { source, when } = splitSourceWhen(rest);
    rows.push({ field, source, when, raw: (field + rest) });
  }
  return { header: head, rows, markdown: tableMarkdown(rows) };
}

function normalizeField(w) {
  const s = String(w).trim();
  if (s === 'QQ昵称') return 'QQ 昵称';
  if (s === '代称') return '代称（别人喊的）';
  return s;
}

function pickTrailingSource(gap) {
  const g = String(gap || '').trim();
  if (!g) return '';
  for (const m of SOURCE_MARKS) {
    if (g.endsWith(m)) return m;
  }
  return '';
}

function splitSourceWhen(rest) {
  let cut = -1;
  for (const m of WHEN_MARKS) {
    const i = rest.indexOf(m);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut <= 0) return { source: rest.trim(), when: '' };
  return { source: rest.slice(0, cut).replace(/[；;，,、\s]+$/, '').trim(), when: rest.slice(cut).trim() };
}

function tableMarkdown(rows) {
  const head = '| 字段 | 来源 | 时机 |\n| --- | --- | --- |';
  const body = rows.map(r => '| ' + r.field + ' | ' + (r.source || '—') + ' | ' + (r.when || '—') + ' |').join('\n');
  return head + '\n' + body;
}

// ---------------------------------------------------------------------------
// C 六段归类 / 断言 / 文件 / 联动
// ---------------------------------------------------------------------------
function splitUnits(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    let s = line.replace(NOISE_PREFIX, '').trim();
    if (!s) continue;
    s = s.replace(SPLIT_STARTERS, '｜$1');
    for (const part of s.split(/[｜。；]/)) {
      const v = part.trim();
      if (v) out.push(v);
    }
  }
  return out;
}

function classifyUnit(unit) {
  const u = String(unit || '');
  if (/提示词|面板|朋友录|人物册|她会看到|界面|按钮|显示成|下拉|卡片/.test(u)) return '前端';
  if (/(没档案|不建档|空着|等本人)/.test(u)) return '背景';
  if (/(入口|代码做什么|每条消息|判断|调用|nameFor|enroll|onMessage|turnCtx|返回|现算|只有一条线|好感来源|FRIEND_AT)/.test(u)) return '后端';
  if (/^(账号 |role |sex |favor |name |nick |cards|dates )/.test(u) || /qq:uid/.test(u)) return '数据来源';
  if (/(people\.json|上限|内存|落盘|字段来源|什么时候写|资料卡)/.test(u)) return '数据来源';
  if (/(建档|写入|写全|触发|对象是|role|favor|目标)/.test(u)) return '后端';
  if (/(空着|等本人|不写|不建档|避免|原因|防止)/.test(u)) return '背景';
  return '';
}

function classifySegments(entry, table) {
  const segs = {};
  const push = (k, v) => {
    if (!v) return;
    const cur = segs[k] ? segs[k] + '\n' : '';
    segs[k] = cur + v;
  };
  const units = splitUnits(entry.body);
  for (const u of units) {
    let k = classifyUnit(u);
    if (!k) continue;
    if (k === '数据来源' && /^(账号 |role |sex |favor |name |nick |cards|dates )/.test(u) && /(空着|等本人)/.test(u)) k = '背景';
    push(k, u);
  }
  if (table) {
    push('数据来源', table.markdown);
    for (const r of table.rows) {
      if (/面板|朋友录|人物册/.test(r.raw)) push('前端', r.raw);
      if (/变了才写|不覆盖|现算不落盘|建档时|覆盖时|发生即记|变化时|不落盘/.test(r.raw)) push('后端', r.raw);
    }
  }
  // 应用场景兜底：标题（逐字）
  if (!segs['应用场景']) segs['应用场景'] = entry.title;
  const filled = Object.keys(segs).filter(k => String(segs[k] || '').trim());
  return { segments: segs, filled };
}

const ASSERT_RE = /(\d|>|<|=|上限|默认|不覆盖|重启|返回|常量|\+1|现算|不落盘|变了才写|空着|空不|people\.json|r2\.text|aimUid|turnCtx|seen\.|FRIEND_AT|被夸)/;

function extractAcceptance(entry, table) {
  const out = [];
  const add = v => {
    const s = String(v || '').replace(NOISE_PREFIX, '').replace(/^[｜、，；。\s]+/, '').replace(/[、，；。：;,\s]+$/, '').trim();
    if (!s || s.length < 3) return;
    if (!ASSERT_RE.test(s)) return;
    if (out.some(x => squeeze(x) === squeeze(s))) return;
    out.push(s);
  };
  const fieldWordsIn = s => {
    let n = 0;
    for (const w of FIELD_WORDS) if (String(s).includes(w)) n += 1;
    return n;
  };
  for (const u of splitUnits(entry.body)) {
    if (table && fieldWordsIn(u) >= 2) continue;   // 压平表格整行不逐句进断言，改用还原后的行
    if (ASSERT_RE.test(u)) add(u);
  }
  if (table) {
    // 表格的每一行本身就是「字段 → 时机」断言，原样进断言（不再过滤关键词）
    for (const r of table.rows) {
      const s = (r.field + '：' + (r.source || '—') + ' → ' + (r.when || '—')).trim();
      if (!out.some(x => squeeze(x) === squeeze(s))) out.push(s);
    }
  }
  return out.slice(0, 18);
}

const FILE_RULES = [
  [/(qq\.onMessage|qq\.js|\bonMessage\b|turnCtx|r2\.text|消息真发出去|事件里的 card|他说话)/, 'qq.js'],
  [/(people\.findByAccount|people\.js|findByAccount|people\.FRIEND_AT|FRIEND_AT|role\s*=|sexSrc|favor\s*=|cards\{|现算)/, 'people.js'],
  [/(seen\.(note|enroll|cardsOf)|seen\.js)/, 'seen.js'],
  [/(nick\.nameFor|nick\.js|nameFor|昵称|群名片)/, 'nick.js'],
  [/(people\.json|不写 people\.json|落盘|不写字段|档案|资料卡)/, 'people.json'],
  [/(面板|朋友录|人物册)/, 'panel.js'],
  [/(被夸|好感来源|衰减)/, 'favor.js'],
  [/(B站 事件|B站昵称|加账号时拉一次)/, 'profile-sync.js'],
];

function extractFiles(entry, opts) {
  const body = String(entry.body || '') + '\n' + (entry.title || '');
  const refs = [];
  for (const [re, ref] of FILE_RULES) if (re.test(body)) refs.push(ref);
  const explicit = body.match(/[A-Za-z0-9_./-]+\.(js|json|md|py|ts|css|html)\b/g) || [];
  for (const e of explicit) {
    const base = path.basename(e);
    if (!refs.includes(base) && !refs.includes(e)) refs.push(e);
  }
  return uniq(refs).map(ref => resolveFile(ref, opts.projectRoot));
}

// 项目根下有界查找同名文件（跳过 node_modules/.git/备份），按 深度 → 路径长度 → 字典序
function findFileCandidates(root, ref) {
  const base = path.basename(String(ref || ''));
  if (!root || !base) return [];
  const skip = /(^|[\\/])(node_modules|\.git[^\\/]*|备份|backup|\.workbuddy)([\\/]|$)/i;
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 5 || out.length > 40) return;
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const d of names) {
      const full = path.join(dir, d.name);
      if (skip.test(full)) continue;
      if (d.isDirectory()) walk(full, depth + 1);
      else if (d.isFile() && d.name === base) out.push(full);
    }
  };
  walk(root, 0);
  out.sort((a, b) => {
    const da = a.split(path.sep).length, db = b.split(path.sep).length;
    if (da !== db) return da - db;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });
  return out;
}

function resolveFile(ref, projectRoot) {
  const rel = String(ref || '');
  if (!projectRoot) return { ref: rel, resolved: null, exists: null, candidates: [] };
  const cands = findFileCandidates(projectRoot, rel);
  if (!cands.length) return { ref: rel, resolved: null, exists: false, candidates: [] };
  const best = cands[0];
  return {
    ref: rel,
    resolved: path.relative(projectRoot, best).split(path.sep).join('/'),
    exists: true,
    candidates: cands.slice(0, 5).map(p => path.relative(projectRoot, p).split(path.sep).join('/')),
  };
}

function buildLinks(entry, index, entries, parentNodeId, platformNodeIds) {
  const links = [];
  const add = (kind, ref, note) => {
    if (!ref || links.some(l => l.kind === kind && l.ref === ref)) return;
    links.push({ kind, ref, note: note || '' });
  };
  const title = entry.title;
  const seq = ['陌生人在群里说话', '她回了他 → 建档', '陌生人 → 认识的人', '认识的人 → 朋友', '全资料什么时候写'];
  const at = seq.indexOf(title);
  const key = n => 'req:p' + n;
  if (at >= 0) {
    if (at < 4) add('联动', key(at + 2), '下一步：' + seq[at + 1]);
    if (at > 0) add('联动', key(at), '上一步：' + seq[at - 1]);
  }
  if (title === '全资料什么时候写') {
    for (let i = 1; i <= 4; i++) add('联动', key(i), '字段来源覆盖第 ' + i + ' 步');
  }
  if (at >= 0 && at < 4) {
    for (const nid of platformNodeIds.public) add('联动', 'node:' + nid, '发生在公共平台');
  }
  if (title === '全资料什么时候写') {
    for (const nid of platformNodeIds.all) add('联动', 'node:' + nid, '字段来源跨平台');
  }
  if (title === '认识的人 → 朋友') add('复用', 'file:src/people.js', 'FRIEND_AT 与面板朋友录同一常量');
  if (title === '陌生人在群里说话' || title === '全资料什么时候写') add('复用', 'file:src/data/people.json', '同一份人物表读写');
  return links;
}

// ---------------------------------------------------------------------------
// D 项目 / 节点判断
// ---------------------------------------------------------------------------
function pickProject(text, opts) {
  const projects = Array.isArray(opts.existingProjects) ? opts.existingProjects.filter(p => !p.archived) : [];
  const wanted = opts.projectId ? projects.find(p => p.id === opts.projectId) : null;
  if (wanted) return { project: wanted, evidence: '指定项目「' + wanted.name + '」' };
  if (!projects.length) return { project: null, evidence: '库里没有项目（先建项目再录入）' };
  const t = String(text || '');
  const hit = projects.find(p => t.includes(p.name) || (p.folderName && t.includes(p.folderName)));
  if (hit) return { project: hit, evidence: '内容命中项目名「' + hit.name + '」' };
  if (projects.length === 1) return { project: projects[0], evidence: '只有一个项目，回退到「' + projects[0].name + '」' };
  return { project: null, evidence: '项目无法判断（多个项目且内容没命中），请手动选' };
}

function pickParentNode(text, nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const roots = list.filter(n => !n.parentId);
  const t = String(text || '');
  const hit = roots.find(n => t.includes(n.name));
  if (hit) return { node: hit, evidence: '内容命中根节点「' + hit.name + '」' };
  if (roots.length === 1) return { node: roots[0], evidence: '只有一个根节点，回退到「' + roots[0].name + '」' };
  return { node: null, evidence: '没有可匹配的根节点，录入到项目根' };
}

function platformNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const find = re => list.find(n => re.test(n.name));
  const qq = find(/QQ\s*群聊/);
  const dm = find(/QQ\s*私聊/);
  const bili = find(/B站/);
  const all = [qq, dm, bili].filter(Boolean).map(n => n.nodeId);
  return { all, public: qq ? [qq.nodeId] : [] };
}

// ---------------------------------------------------------------------------
// E 主入口
// ---------------------------------------------------------------------------
function analyze(text, opts) {
  opts = opts || {};
  const raw = normalize(text);
  const profile = opts.profile || classifyProfile(raw);
  const parsed = splitEntries(raw);
  const proj = pickProject(raw, opts);
  const parent = pickParentNode(raw, opts.nodes);
  const platforms = platformNodes(opts.nodes);
  const existing = new Set((opts.existingTexts || []).map(t => dedupeKey(t)));
  const seen = new Set();

  const proposals = [];
  let deduped = 0;
  let tableCount = 0;

  parsed.entries.forEach((entry, i) => {
    const entryText = entry.lines.join('\n').trim();
    if (!entryText) return;
    const key = dedupeKey(entryText);
    if (existing.has(key) || seen.has(key)) { deduped += 1; return; }
    seen.add(key);

    const table = isFlatTable(entry.body) ? repairFlatTable(entry.body) : null;
    if (table) tableCount += 1;
    const { segments, filled } = classifySegments(entry, table);
    const acceptance = extractAcceptance(entry, table);
    const files = extractFiles(entry, opts);
    const unresolved = files.filter(f => f.exists === false);
    const links = buildLinks(entry, i, parsed.entries, parent.node ? parent.node.nodeId : null, platforms);

    const isFeature = parsed.profile === 'feature-doc';
    const status = isFeature ? 'ai_done' : userStatus(entry.body || entry.title);
    const level1 = entry.group || '';
    const nodePath = isFeature
      ? (level1 ? [level1, entry.title] : [entry.title])
      : [];
    const nodePathFull = isFeature
      ? ((parent.node && parent.node.path ? parent.node.path + '/' : '') + nodePath.join('/'))
      : '';
    const segHigh = filled.length >= 3;
    const confidence = !isFeature ? 'high'
      : (table || !proj.project || !parent.node || !segHigh) ? (table ? 'medium' : 'low') : 'high';

    const evidence = [];
    evidence.push(isFeature ? '按文档结构拆条（' + parsed.entries.length + ' 条）' : '按用户原话逐条录入');
    evidence.push(proj.evidence);
    if (isFeature) evidence.push(parent.evidence);
    if (level1) evidence.push('一级标题「' + level1 + '」作功能父节点');
    if (table) evidence.push('压平表格已还原 ' + table.rows.length + ' 行（可编辑，原文保留）');
    if (unresolved.length) evidence.push('文件待核实：' + unresolved.map(f => f.ref).join('、'));
    if (files.length && opts.projectRoot) evidence.push('文件已按项目根解析');

    proposals.push({
      localKey: 'p' + (proposals.length + 1),
      kind: isFeature ? 'feature' : 'user-requirement',
      title: entry.title,
      text: entryText,
      projectId: proj.project ? proj.project.id : null,
      projectName: proj.project ? proj.project.name : '',
      parentNodeId: isFeature && parent.node ? parent.node.nodeId : null,
      nodePath,
      nodePathFull,
      status,
      source: isFeature ? 'xuhbot-impl' : 'user',
      priority: isFeature ? (i < 4 ? 'high' : 'medium') : 'medium',
      segments,
      segCount: filled.length,
      acceptance,
      files,
      links,
      table: table ? { rows: table.rows, markdown: table.markdown, editable: true } : null,
      token: estimateTokens(entryText),
      confidence,
      evidence,
      dedupeKey: key,
      profile: parsed.profile,
    });
  });

  const stats = {
    profile: parsed.profile,
    entries: proposals.length,
    tables: tableCount,
    deduped,
    unresolvedFiles: proposals.reduce((n, p) => n + p.files.filter(f => f.exists === false).length, 0),
    confidence: proposals.some(p => p.confidence === 'low') ? 'low' : proposals.some(p => p.confidence === 'medium') ? 'medium' : 'high',
    totalTokens: proposals.reduce((n, p) => n + p.token, 0),
    projectId: proj.project ? proj.project.id : null,
    projectName: proj.project ? proj.project.name : '',
  };
  return { stats, proposals };
}

function proposalsToCore(proposals) {
  return proposals.map(p => ({
    localKey: p.localKey || null,
    title: p.title, text: p.text, kind: p.kind,
    parentNodeId: p.parentNodeId || null, nodePath: p.nodePath || [], nodePathFull: p.nodePathFull || '',
    status: p.status, source: p.source, priority: p.priority,
    segments: p.segments || {}, acceptance: p.acceptance || [],
    files: (p.files || []).filter(f => f && (f.resolved || f.exists)).map(f => f.resolved || f.ref),
    fileRefs: p.files || [],
    links: p.links || [],
    summary: clip((p.segments && p.segments['应用场景']) || p.title, 100),
    evidence: p.evidence || [], confidence: p.confidence,
    dedupeKey: p.dedupeKey || null,
    projectName: p.projectName || '',
  }));
}

function commit(core, projectId, proposals, opts) {
  if (!core || typeof core.ingestCommit !== 'function') throw new Error('core 不支持 ingestCommit');
  return core.ingestCommit(projectId, proposalsToCore(proposals), opts || {});
}

module.exports = {
  SEGMENTS, SEGMENT_COLUMN, CATEGORIES,
  analyze, commit, proposalsToCore,
  classifyProfile, splitEntries, splitUnits, classifySegments, classifyUnit,
  isFlatTable, repairFlatTable, extractAcceptance, extractFiles, resolveFile, findFileCandidates,
  buildLinks, pickProject, pickParentNode, dedupeKey, estimateTokens, makeTitle, normalize,
};
