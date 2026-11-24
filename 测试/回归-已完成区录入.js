'use strict';
/**
 * 【已完成区】· 回归测试
 *
 * 这是干什么的：真跑数据层 / CLI / 日志解析，验证三字段与「AI已完成」两段式写入、幂等去重、
 * 索引与详情生成、规格字段约束；跑完自动清理临时副本，不留残渣。
 * 用法：node 测试/回归-已完成区录入.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { RecordBook, parseLogText } = require('../app/backend/records');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'app', 'backend', 'record-cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ticiqi-records-'));
let n = 0;
function ok(label, fn) { fn(); n += 1; console.log('  ✓ ' + label); }

const LOG = [
  '# 2026-11-09 工作日志', '',
  '## 05:57 小白定义纠偏',
  '这是干什么的：记她定的小白定义，供后续核对。',
  '- 她原话要点：「不知道市面上哪些插件/软件早就实现了我想要的功能」',
  '- 改动（用户级正本）：',
  '  - `USER.md:2-3`、`MEMORY.md:8`',
  '- 未做：本轮没有录入提词器。', '',
  '## 06:13 名词归档',
  '这是干什么的：记一个新名词。',
  '- 她原话要点：「这是新名词」',
  '- 改动：`名词解释/名词解释.md:2914`', '',
].join('\n');

try {
  const book = new RecordBook(tmp);
  const dot = path.join(tmp, '.ticiqi');

  ok('数据目录与详情目录自动建立', () => {
    assert.ok(fs.existsSync(path.join(dot, 'C_DONE')));
  });
  ok('缺「我记的」时报错', () => {
    assert.throws(() => book.append({ quote: 'x', files: 'MEMORY.md:8' }), /不能为空/);
  });
  ok('缺「她原话」时按 AI已完成两段式写入，不报错、不跳过', () => {
    const twoRoot = path.join(tmp, 'two');
    const b2 = new RecordBook(twoRoot);
    const r = b2.append({ mine: 'AI 自己做的事', files: 'MEMORY.md:8' });
    assert.strictEqual(r.ok, true);
    const s2 = b2.state();
    assert.strictEqual(s2.counts.ai, 1);
    assert.strictEqual(s2.items[0].shape, 'two');
    assert.strictEqual(s2.items[0].kind, 'ai');
    const d2 = fs.readFileSync(path.join(twoRoot, '.ticiqi', 'C_DONE', 'L0001.md'), 'utf8');
    assert.ok(d2.includes('两段式') && !d2.includes('**她原话**'));
    const i2 = fs.readFileSync(path.join(twoRoot, '.ticiqi', 'C_DONE_INDEX.md'), 'utf8');
    assert.ok(i2.includes('## AI已完成'));
  });
  ok('缺「对应文件」时报错', () => {
    assert.throws(() => book.append({ mine: 'x', quote: 'y' }), /不能为空/);
  });

  const r1 = book.append({ mine: '小白＝信息差', quote: '不知道现成插件',
    files: 'MEMORY.md:30', kind: 'rule', summary: '小白定义' });
  ok('写入一条规矩返回 id', () => {
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.duplicate, false);
    assert.strictEqual(r1.id, 'L0001');
  });

  const lines1 = fs.readFileSync(path.join(dot, 'C_DONE.jsonl'), 'utf8').trim().split('\n');
  ok('jsonl 恰好一行且是 ai_new', () => {
    assert.strictEqual(lines1.length, 1);
    assert.strictEqual(JSON.parse(lines1[0]).type, 'ai_new');
  });
  ok('规格字段齐全：fromReq 为 null、files 非空、evidence 非空', () => {
    const row = JSON.parse(lines1[0]);
    assert.strictEqual(row.fromReq, null);
    assert.deepStrictEqual(row.files, ['MEMORY.md']);
    assert.deepStrictEqual(row.evidence, ['MEMORY.md:30']);
    assert.ok(row.time);
  });
  ok('额外字段 quote / kind 不覆盖规格字段', () => {
    const row = JSON.parse(lines1[0]);
    assert.strictEqual(row.quote, '不知道现成插件');
    assert.strictEqual(row.kind, 'rule');
    assert.ok('summary' in row && 'newText' in row && 'reason' in row);
  });
  ok('行里不写 id（规格 :111 由软件自动生成）', () => {
    assert.ok(!('id' in JSON.parse(lines1[0])));
  });

  const r2 = book.append({ mine: '小白＝信息差', quote: '不知道现成插件',
    files: 'MEMORY.md:30', kind: 'rule', summary: '小白定义' });
  ok('同三字段重复写入被去重，不产生幽灵条', () => {
    assert.strictEqual(r2.duplicate, true);
    assert.strictEqual(fs.readFileSync(path.join(dot, 'C_DONE.jsonl'), 'utf8').trim().split('\n').length, 1);
  });

  ok('名词解释不进提词器：--kind noun 被拒，不产生 noun 记录', () => {
    assert.throws(() => book.append({ mine: '引用归属＝QQ 引用消息归属', quote: '这是新名词',
      files: '名词解释/名词解释.md:2914', kind: 'noun', summary: '引用归属' }),
      /名词解释不进提词器/);
    const s = book.state();
    assert.strictEqual(s.total, 1);
    assert.strictEqual(s.counts.rule, 1);
    assert.strictEqual(s.counts.noun, 0);
  });

  const idx = fs.readFileSync(path.join(dot, 'C_DONE_INDEX.md'), 'utf8');
  ok('索引由代码生成且含规矩/名词分节（名词为空）', () => {
    assert.ok(idx.includes('## 规矩') && idx.includes('## 名词'));
    assert.ok(idx.includes('L0001') && !idx.includes('L0002'));
  });

  const detail = fs.readFileSync(path.join(dot, 'C_DONE', 'L0001.md'), 'utf8');
  ok('详情含三字段与「这是干什么的」', () => {
    assert.ok(detail.includes('这是干什么的'));
    assert.ok(detail.includes('我记的') && detail.includes('她原话') && detail.includes('对应文件（哪几行）'));
    assert.ok(detail.includes('MEMORY.md:30'));
  });

  ok('字段长度约束生效（newText ≤200）', () => {
    const r = book.append({ mine: 'x'.repeat(500), quote: 'y'.repeat(3000),
      files: 'MEMORY.md:8', kind: 'rule' });
    assert.strictEqual(r.ok, true);
    const rows = fs.readFileSync(path.join(dot, 'C_DONE.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const last = rows[rows.length - 1];
    assert.strictEqual(last.newText.length, 200);
    assert.strictEqual(last.quote.length, 2000);
  });

  const parsed = parseLogText(LOG);
  ok('日志解析跳过非项目级（名词解释）小节，仅剩 1 个', () => {
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].kind, 'rule');
    assert.ok(!parsed.some(x => x.kind === 'noun'));
  });
  ok('日志抽取多个带行号引用', () => {
    assert.ok(parsed[0].files.includes('USER.md:2-3'));
    assert.ok(parsed[0].files.includes('MEMORY.md:8'));
  });
  ok('豁免：小节标题含「名词」但无 名词解释/名词表 引用 → 不跳过，按 rule 归档', () => {
    const t = parseLogText('## 12:00 名词对照整理\n这是干什么的：项目内术语整理。\n- 她原话要点：「整理术语」\n- 改动：`MEMORY.md:8`\n');
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].kind, 'rule');
    assert.ok(!t.some(x => x.kind === 'noun'));
  });
  ok('混合引用（名词文件 + 项目文件）不误伤，按 rule 保留', () => {
    // 这是 some→every 修复要保住的场景：L0002/L0013/L0015 这类小节既引了名词表、又是 ticiqi 功能改动
    const t = parseLogText('## 12:30 改 xuhbot 引用归属名词\n这是干什么的：改了引用归属功能，名词文件顺带改到。\n- 她原话要点：「改功能」\n- 改动：`xuhbot/app/ref.js:120`、`名词表/名词表.md:364`\n');
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].kind, 'rule');
  });
  ok('无原话小节按两段式解析；无引用且无兜底时才跳过', () => {
    const a = parseLogText('## 空节\n这是干什么的：没写原话。\n', '2026-11-09.md:1');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].kind, 'ai');
    assert.strictEqual(a[0].shape, 'two');
    assert.deepStrictEqual(a[0].files, ['2026-11-09.md:1']);
    assert.strictEqual(parseLogText('## 空节\n这是干什么的：没写原话。\n').length, 0);
  });

  const logFile = path.join(tmp, 'sample.md');
  fs.writeFileSync(logFile, LOG, 'utf8');
  const out = JSON.parse(execFileSync(process.execPath,
    [CLI, '--app-root', tmp, '--from-log', logFile], { encoding: 'utf8' }));
  ok('CLI --from-log 端到端：名词小节被跳过，仅同步 1 条', () => {
    assert.strictEqual(out.parsed, 1);
    assert.strictEqual(out.added, 1);
    assert.strictEqual(out.total, 3);
  });

  const out2 = JSON.parse(execFileSync(process.execPath,
    [CLI, '--app-root', tmp, '--from-log', logFile], { encoding: 'utf8' }));
  ok('同一日志再跑一次全部去重', () => {
    assert.strictEqual(out2.added, 0);
    assert.strictEqual(out2.duplicated, 1);
    assert.strictEqual(out2.total, 3);
  });

  const scanDir = path.join(tmp, 'logs');
  fs.mkdirSync(scanDir);
  fs.writeFileSync(path.join(scanDir, '2026-11-09.md'), LOG, 'utf8');
  const out3 = JSON.parse(execFileSync(process.execPath,
    [CLI, '--app-root', tmp, '--scan', scanDir], { encoding: 'utf8' }));
  ok('CLI --scan 扫目录且不重复写入', () => {
    assert.strictEqual(out3.files, 1);
    assert.strictEqual(out3.added, 0);
    assert.strictEqual(out3.duplicated, 1);
  });

  const list = JSON.parse(execFileSync(process.execPath,
    [CLI, '--app-root', tmp, '--list'], { encoding: 'utf8' }));
  ok('CLI --list 读回条数一致', () => { assert.strictEqual(list.total, 3); });

  const rebuilt = JSON.parse(execFileSync(process.execPath,
    [CLI, '--app-root', tmp, '--rebuild'], { encoding: 'utf8' }));
  ok('CLI --rebuild 重建索引不丢条', () => { assert.strictEqual(rebuilt.total, 3); });

  ok('重建后详情文件数与行数一致', () => {
    assert.strictEqual(fs.readdirSync(path.join(dot, 'C_DONE')).filter(f => f.endsWith('.md')).length, 3);
  });

  // 用一份全新日志：LOG 在前面的 --from-log / --scan 已入库，再扫只会命中去重。
  const LOG_AUTO = [
    '# 2026-11-09 工作日志', '',
    '## 07:00 启动自动同步校验 A',
    '这是干什么的：验证提词器启动自动同步能写入新小节。',
    '- 她原话要点：「启动时就该自动同步」',
    '- 改动：`MEMORY.md:17`', '',
    '## 07:01 启动自动同步校验 B（无原话走 AI已完成两段式）',
    '这是干什么的：验证两段式小节也能自动同步。',
    '- 改动：`说明.md:116`', '',
  ].join('\n');
  const logRoot = path.join(tmp, 'WorkBuddy');
  const session = path.join(logRoot, '2026-11-09-05-57-30', '.workbuddy', 'memory');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, '2026-11-09.md'), LOG_AUTO, 'utf8');
  const auto1 = book.syncRecent(logRoot, 2);
  ok('启动时自动同步扫到最近日志并写入（含两段式）', () => {
    assert.strictEqual(auto1.files, 1);
    assert.strictEqual(auto1.parsed, 2);
    assert.strictEqual(auto1.added, 2);
    assert.strictEqual(auto1.duplicated, 0);
  });
  const auto2 = book.syncRecent(logRoot, 2);
  ok('重复启动自动同步全部去重', () => {
    assert.strictEqual(auto2.added, 0);
    assert.strictEqual(auto2.duplicated, 2);
  });
  const auto3 = book.syncRecent(logRoot, -1);
  ok('超过天数的旧日志被跳过，不扫全盘', () => {
    assert.strictEqual(auto3.files, 0);
    assert.strictEqual(auto3.skippedOld, 1);
  });
  ok('日志根不存在时返回零值且不抛错', () => {
    assert.strictEqual(book.syncRecent(path.join(tmp, 'nope'), 2).files, 0);
  });

  // CLI --cleanup 端到端：跑完清理后必须 return，不能再落进 append 空值分支
  {
    const cbRoot = path.join(tmp, 'cli-cleanup');
    fs.mkdirSync(cbRoot, { recursive: true });
    execFileSync(process.execPath, [CLI, '--app-root', cbRoot, '--mine', '待清理',
      '--quote', 'q', '--files', 'MEMORY.md:8', '--kind', 'rule'], { encoding: 'utf8' });
    const out = JSON.parse(execFileSync(process.execPath,
      [CLI, '--app-root', cbRoot, '--cleanup', 'L0001', '--reason', '测试'], { encoding: 'utf8' }));
    ok('CLI --cleanup 端到端：返回 ok 且不再跑 append（无「不能为空」报错）', () => {
      assert.strictEqual(out.ok, true);
      assert.strictEqual(out.ids[0], 'L0001');
      assert.strictEqual(out.total, 0);
    });
  }

  // ai_cleanup（规格 :85-87）：追加清理指令后，被清理 id 从视图消失，但 jsonl 旧行不动
  {
    const cbRoot = path.join(tmp, 'cleanup');
    const cb = new RecordBook(cbRoot);
    const a = cb.append({ mine: '待清理的条目', quote: '原话', files: 'MEMORY.md:8', kind: 'rule' });
    const before = cb.state();
    cb.cleanup([a.id], '测试清理');
    const after = cb.state();
    ok('ai_cleanup：清理后视图条数 -1 且被清理 id 消失', () => {
      assert.strictEqual(before.total, 1);
      assert.strictEqual(after.total, 0);
      assert.ok(!after.items.some(x => x.id === a.id));
    });
    ok('ai_cleanup：jsonl 旧行仍在（只追加，不改旧行）', () => {
      const lines = fs.readFileSync(path.join(cbRoot, '.ticiqi', 'C_DONE.jsonl'), 'utf8').trim().split('\n');
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(JSON.parse(lines[0]).type, 'ai_new');
      assert.strictEqual(JSON.parse(lines[1]).type, 'ai_cleanup');
    });
    ok('ai_cleanup：被清理条目详情文件已删除', () => {
      assert.ok(!fs.existsSync(path.join(cbRoot, '.ticiqi', 'C_DONE', a.id + '.md')));
    });
  }

  console.log('\n' + n + ' 项全过；临时副本已清理：' + tmp);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
