'use strict';
/**
 * 回归-C_TODO地基.js —— 阶段 0（spec_00）回归测试
 * 跑法：node 测试/回归-C_TODO地基.js
 * 只用临时库，跑完自动清理；不碰默认 ctodo.db。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { CTodoDB, TABLES, DEFAULT_SETTINGS, SEGMENT_COLUMNS } = require('../app/backend/ctodo-db');

const appRoot = path.dirname(__dirname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctodo-reg-'));
const dbPath = path.join(dir, 'ctodo.db');
let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + ' — ' + e.message); process.exitCode = 1; }
}

console.log('C_TODO 地基回归（临时库：' + dbPath + '）');
const db = new CTodoDB(dbPath, appRoot);

ok('WAL 生效', () => assert.strictEqual(db.state().journal, 'wal'));
ok('版本 2.8.0', () => assert.strictEqual(db.state().version, '2.8.0'));
ok('10 张表齐全且计数可读', () => {
  const s = db.state();
  assert.strictEqual(s.tables.length, 10);
  assert.strictEqual(Object.keys(s.counts).length, 10);
  for (const t of TABLES) assert.ok(t in s.counts, '缺计数 ' + t);
});
ok('requirements 六段字段列存在', () => {
  const cols = db.db.prepare('PRAGMA table_info(requirements)').all().map((c) => c.name);
  for (const seg of SEGMENT_COLUMNS) assert.ok(cols.includes(seg), '缺列 ' + seg);
});
ok('settings 默认键齐全', () => {
  for (const k of Object.keys(DEFAULT_SETTINGS)) assert.ok(db.getSetting(k, '__MISS__') !== '__MISS__', '缺键 ' + k);
});
ok('init 幂等（二次建表不报错、计数不翻倍）', () => {
  const before = db.state().counts.settings;
  db.init();
  assert.strictEqual(db.state().counts.settings, before);
});
ok('req_ id 连续生成', () => {
  assert.strictEqual(db.nextId('req', 'p1'), 'req_001');
  assert.strictEqual(db.nextId('req', 'p1'), 'req_002');
});
ok('node_ id 独立序列', () => assert.strictEqual(db.nextId('node', 'p1'), 'node_001'));
ok('不同项目 id 各自独立', () => assert.strictEqual(db.nextId('req', 'p2'), 'req_001'));
ok('物理删除后 id 不复用', () => {
  const id = db.nextId('req', 'p3'); // req_001 (p3)
  db.db.prepare('INSERT INTO requirements(id,projectId,text,createdAt,updatedAt) VALUES(?,?,?,?,?)').run(id, 'p3', 't', 0, 0);
  db.db.prepare('DELETE FROM requirements WHERE id=?').run(id);
  assert.strictEqual(db.nextId('req', 'p3'), 'req_002');
});
ok('表内现存大 id 不回退（计数器丢失兜底）', () => {
  db.db.prepare('INSERT INTO requirements(id,projectId,text,createdAt,updatedAt) VALUES(?,?,?,?,?)').run('req_009', 'p4', 't', 0, 0);
  assert.strictEqual(db.nextId('req', 'p4'), 'req_010');
});
ok('非法 kind 被拒', () => {
  let threw = false;
  try { db.nextId('bad', 'p1'); } catch (_) { threw = true; }
  assert.ok(threw);
});
ok('接入规则读到正本（含“提词器接入规则”标题）', () => {
  const rule = db.accessRule();
  assert.ok(rule.includes('# 提词器接入规则'));
  assert.ok(rule.length > 1000);
});
ok('getSetting/setSetting 往返', () => {
  db.setSetting('custom', { a: 1 });
  assert.deepStrictEqual(db.getSetting('custom'), { a: 1 });
});

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
console.log('通过 ' + pass + ' 项' + (process.exitCode ? '（有失败）' : '，全过'));
