'use strict';
/**
 * 【workbuddy 记忆区】· 命令行读取入口
 *
 * 这是干什么的：给我（AI）用的只读通道。要调取她的原话 / 落点 / 案例时不搬文件、不手写汇总，
 * 直接一条命令拿结果。不联网、不调模型、不耗积分。
 *
 * 用法（mac，路径含空格加引号）：
 *   node "ticiqi/app/backend/memory-archive-cli.js" --list
 *   node "ticiqi/app/backend/memory-archive-cli.js" --find "多源一致"
 *   node "ticiqi/app/backend/memory-archive-cli.js" --find "好功能" --limit 80
 *   node "ticiqi/app/backend/memory-archive-cli.js" --get 原话逐字.md
 *   node "ticiqi/app/backend/memory-archive-cli.js" --rebuild
 */
const path = require('path');
const arc = require('./memory-archive');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}
function has(name) { return process.argv.includes('--' + name); }

function main() {
  let r;
  if (has('rebuild')) r = arc.rebuild();
  else if (has('find')) r = arc.find(arg('find', ''), arg('limit', 40));
  else if (has('get')) r = arc.get(arg('get', ''));
  else r = arc.list();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  if (r && r.error) process.exitCode = 1;
}

try { main(); }
catch (e) {
  process.stderr.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exitCode = 1;
}
