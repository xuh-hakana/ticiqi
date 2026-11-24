'use strict';
/**
 * 【workbuddy 记忆区】· 只读检索
 *
 * 这是干什么的：让 ticiqi 能读取记忆里被摘出的「不常看」内容（她的原话逐字、文件落点、
 * 正面案例、多轮案例索引、本轮任务原话）。personal 区的源文件不搬移、不删除、不改名，
 * 这里只按内容归档提供检索，后续需要调取时正常读取即可（她 2026-11-11 定）。
 *
 * 只读：唯一会写的是派生文件 索引.md（由 rebuild() 生成，不手写）。
 * 不联网、不调模型、不耗积分。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', '..', 'workbuddy记忆区');
const INDEX = path.join(DIR, '索引.md');
const GENERATED = '索引.md';

function files() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter(f => f.endsWith('.md') && f !== GENERATED)
    .sort()
    .map(f => {
      const text = fs.readFileSync(path.join(DIR, f), 'utf8');
      const lines = text.split('\n');
      const first = lines.find(l => l.trim() && !l.startsWith('#')) || '';
      return { name: f, lines: lines.length, desc: first.trim().slice(0, 120) };
    });
}

function safeName(name) {
  if (!name || !name.endsWith('.md') || name.includes('/') || name.includes('..')) return null;
  const p = path.join(DIR, name);
  return fs.existsSync(p) ? p : null;
}

function list() {
  return { dir: DIR, count: files().length, files: files() };
}

function get(name) {
  const p = safeName(name);
  if (!p) return { error: '文件不存在或名称不合法' };
  return { name, text: fs.readFileSync(p, 'utf8') };
}

function find(q, limit) {
  const kw = String(q || '').trim();
  if (!kw) return { q: kw, hits: [] };
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 200);
  const out = [];
  for (const f of files()) {
    const lines = fs.readFileSync(path.join(DIR, f.name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (out.length < cap && line.includes(kw)) {
        out.push({ file: f.name, line: i + 1, text: line.trim().slice(0, 200) });
      }
    });
  }
  return { q: kw, hits: out, capped: out.length >= cap };
}

function rebuild() {
  const listFiles = files();
  const buf = [
    '# 索引 · workbuddy 记忆区',
    '',
    '这是干什么的：本区文件清单与章节目录，由 memory-archive.js 自动生成，不要手写。',
    '',
    '生成时间：' + new Date().toISOString(),
    '',
    '## 文件',
    '',
  ];
  listFiles.forEach(f => {
    buf.push('- `' + f.name + '`（' + f.lines + ' 行）' + (f.desc ? ' — ' + f.desc : ''));
    const text = fs.readFileSync(path.join(DIR, f.name), 'utf8');
    const heads = text.split('\n').filter(l => /^#{2,3}\s/.test(l));
    heads.forEach(h => buf.push('  - ' + h.replace(/^#+\s*/, '').trim()));
  });
  buf.push('');
  buf.push('读取：客户端 `GET /api/memory-archive?op=list`，或 `node app/backend/memory-archive-cli.js --find "关键词"`。');
  buf.push('');
  fs.writeFileSync(INDEX, buf.join('\n'), 'utf8');
  return { ok: true, file: INDEX, files: listFiles.length };
}

module.exports = { DIR, files, list, get, find, rebuild };

if (require.main === module) {
  const op = (process.argv.find(a => a.startsWith('--op=')) || '--op=list').slice(5);
  const q = (process.argv.find(a => a.startsWith('--q=')) || '').slice(4);
  const name = (process.argv.find(a => a.startsWith('--name=')) || '').slice(7);
  const r = op === 'find' ? find(q) : op === 'get' ? get(name) : op === 'rebuild' ? rebuild() : list();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
}
