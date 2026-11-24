'use strict';
/**
 * ctodo-cli.js —— C_TODO 地基命令行入口（阶段 0）
 *
 * 这是干什么的：不启客户端就能验证/查看 C_TODO 数据库地基。
 * 用法：
 *   node ctodo-cli.js --init
 *   node ctodo-cli.js --state
 *   node ctodo-cli.js --access-rule
 *   node ctodo-cli.js --next-id req --project p1
 * 可选 --db <路径> 覆盖默认库路径。
 */

const path = require('path');
const { CTodoDB, defaultDbPath } = require('./ctodo-db');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--init' || a === '--state' || a === '--access-rule' || a === '--next-id') {
      out[a.slice(2)] = true;
    } else if (a === '--db' || a === '--project' || a === '--app-root') {
      out[a.slice(2)] = argv[++i];
    } else if (a === '--kind') {
      out.kind = argv[++i];
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const appRoot = args['app-root'] || path.dirname(path.dirname(__dirname));
  const db = new CTodoDB(args.db || defaultDbPath(), appRoot);
  try {
    if (args.init) {
      console.log(JSON.stringify({ ok: true, state: db.state() }, null, 2));
    } else if (args.state) {
      console.log(JSON.stringify(db.state(), null, 2));
    } else if (args['access-rule']) {
      process.stdout.write(db.accessRule());
    } else if (args['next-id']) {
      const kind = args.kind || 'req';
      const project = args.project || '';
      console.log(db.nextId(kind, project));
    } else {
      console.log('C_TODO 地基 CLI：--init | --state | --access-rule | --next-id [--kind req|node] [--project ID] [--db 路径]');
    }
  } finally {
    db.close();
  }
}

if (require.main === module) main();
module.exports = { main, parseArgs };
