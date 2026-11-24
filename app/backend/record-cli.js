'use strict';
/**
 * 【已完成区】· 命令行写入口
 *
 * 这是干什么的：给我（AI）用的同步通道。每轮「记了」之后只调一条命令，
 * 代码自己解析、去重、写 C_DONE.jsonl、生成索引与详情；
 * 对话里不再输出大段汇总，省 token（她 2026-11-09 定的硬限制）。
 *
 * 用法（mac，路径含空格要加引号）：
 *   node app/backend/record-cli.js --mine "我记的" --quote "她原话" --files "MEMORY.md:8" --kind rule
 *   node app/backend/record-cli.js --from-log "/abs/path/.workbuddy/memory/2026-11-09.md"
 *   node app/backend/record-cli.js --scan "/abs/path/.workbuddy/memory"
 *   node app/backend/record-cli.js --list
 *   node app/backend/record-cli.js --rebuild
 *   node app/backend/record-cli.js --cleanup "L0022" --reason "名词解释误归档，移出已完成区"
 *
 * --from-log / --scan 走 parseLogText：有「- 她原话要点：」记三字段；没有就按她 2026-11-09
 * 定的规矩直接记「AI已完成」两段式（我记的 / 对应文件），不跳过。
 * 小节里没带行号引用时，CLI 用日志路径兜底当第二段；已同步过的按字段去重，不产生幽灵条。
 * 名词解释等非项目级操作不进提词器已完成区：parseLogText 已跳过引用名词解释/名词表的小节；
 * 已误归档的条目用 --cleanup <id> 追加 ai_cleanup 指令移除（不改动旧行）。
 * --kind 只接受 rule / ai；传 noun 会被 append 拒绝（名词解释不进提词器，走 xuhuan mac 名词体系）。
 */
const fs = require('fs');
const path = require('path');
const { RecordBook, parseLogText } = require('./records');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}
function has(name) { return process.argv.includes('--' + name); }

function syncText(book, text, fallbackRef) {
  const items = parseLogText(text, fallbackRef);
  let added = 0, duplicated = 0, failed = 0;
  items.forEach(it => {
    try {
      const r = book.append(it);
      if (r.duplicate) duplicated += 1; else added += 1;
    } catch (e) { failed += 1; }
  });
  return { parsed: items.length, added: added, duplicated: duplicated, failed: failed };
}

function main() {
  const appRoot = path.resolve(arg('app-root', path.join(__dirname, '..', '..')));
  const book = new RecordBook(appRoot);

  if (has('list')) {
    const s = book.state();
    process.stdout.write(JSON.stringify({ total: s.total, counts: s.counts, dir: s.dir,
      items: s.items.map(x => ({ id: x.id, kind: x.kind, summary: x.summary })) }, null, 2) + '\n');
    return;
  }
  if (has('rebuild')) {
    process.stdout.write(JSON.stringify(book.rebuild()) + '\n');
    return;
  }

  let result;
  if (has('cleanup')) {
    const ids = arg('cleanup', '');
    const r = book.cleanup(ids, arg('reason', '清理非项目级条目'));
    process.stdout.write(JSON.stringify(Object.assign({ mode: 'cleanup' }, r, { total: book.state().total })) + '\n');
    return;
  }
  const logFile = arg('from-log', '');
  const scanDir = arg('scan', '');
  if (logFile) {
    const abs = path.resolve(logFile);
    const text = fs.readFileSync(abs, 'utf8');
    result = Object.assign({ mode: 'from-log', source: logFile }, syncText(book, text, abs + ':1'));
  } else if (scanDir) {
    const dir = path.resolve(scanDir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    let parsed = 0, added = 0, duplicated = 0, failed = 0;
    files.forEach(f => {
      const p = path.join(dir, f);
      const r = syncText(book, fs.readFileSync(p, 'utf8'), p + ':1');
      parsed += r.parsed; added += r.added; duplicated += r.duplicated; failed += r.failed;
    });
    result = { mode: 'scan', source: dir, files: files.length, parsed: parsed,
      added: added, duplicated: duplicated, failed: failed };
  } else {
    const r = book.append({
      mine: arg('mine', ''), quote: arg('quote', ''), files: arg('files', ''),
      kind: arg('kind', 'rule'), summary: arg('summary', ''), reason: arg('reason', ''),
    });
    result = Object.assign({ mode: 'append' }, r);
  }
  process.stdout.write(JSON.stringify(Object.assign(result, { total: book.state().total })) + '\n');
}

try { main(); }
catch (e) {
  process.stderr.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exitCode = 1;
}
