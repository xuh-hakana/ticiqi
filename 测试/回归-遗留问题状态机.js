'use strict';
/**
 * 回归测试 · 【遗留问题】状态机
 * 这是干什么的：逐条验证她 2026-11-06 给的规则；在 /tmp 临时副本上跑，不碰项目数据。
 * 跑法：node 测试/回归-遗留问题状态机.js
 * 来历：首轮验证发现「同一条多次回答时旧回答文件不进导出」，修根因后把该用例留在这里。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const PROJECT = path.resolve(__dirname, '..');
const { IssueBook } = require(path.join(PROJECT, 'app/backend/issues.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ticiqi-regress-'));
try {
  fs.cpSync(path.join(PROJECT, '需求'), path.join(tmp, '需求'), { recursive: true });
  const dir = path.join(tmp, '需求', '遗留问题');
  const b = new IssueBook(tmp);
  let passed = 0;
  const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); passed += 1; console.log('PASS ' + m); };

  let s = b.state();
  ok(s.total === 2 && s.counts.ai_todo === 2, '初始 2 条，回答前全是【ai待办】');

  let r = b.answer({ id: 'issue_001', text: '测试回答一' });
  ok(r.ok && r.answerFile === 'issue_001-回答-1.md', '回答自动记为原始需求，另开新文件');
  const f1 = fs.readFileSync(path.join(dir, 'issue_001-回答-1.md'), 'utf8');
  ok(f1.includes('测试回答一'), '回答文件含逐字原文');
  const q1 = fs.readFileSync(path.join(dir, 'issue_001.md'), 'utf8');

  let r2 = b.answer({ id: 'issue_001', text: '测试回答二' });
  ok(r2.answerFile === 'issue_001-回答-2.md', '再次回答另开 -回答-2.md');
  ok(fs.readFileSync(path.join(dir, 'issue_001-回答-1.md'), 'utf8') === f1, '已回答文件一字未改');
  ok(fs.readFileSync(path.join(dir, 'issue_001.md'), 'utf8') === q1, '问题文件一字未改');
  ok(b.state().items[0].answerFiles.length === 2, '两份回答文件都在索引里（回归：旧文件不被覆盖丢失）');
  ok(b.state().items[1].status === 'ai_todo', '其他需求不被静默顶替');

  ok(b.confirm({ id: 'issue_001' }).layer === 'ai_new', '【已解决】视为【ai新增】');
  ok(b.promote({ id: 'issue_001' }).layer === 'ai_promoted', '【ai转正】与【ai新增】做区分');

  const before002 = JSON.stringify(b.state().items.find(x => x.id === 'issue_002'));
  const rw = b.rework({ id: 'issue_001', note: '测试返工' });
  ok(rw.ok && rw.invalidated === 'issue_001' && rw.completed === 'issue_001-rework1', '返工：旧完成被顶替 + 新结果另开');
  const after = b.state().items;
  ok(after.find(x => x.id === 'issue_001').status === 'invalidated', '被顶替的旧【完成】变【已失效】');
  ok(after.find(x => x.id === 'issue_001').supersededBy === 'issue_001-rework1', '旧记录指向顶替它的新条目');
  ok(after.find(x => x.id === 'issue_001-rework1').layer === 'done', '新【返工完成】是【已完成】');
  ok(JSON.stringify(after.find(x => x.id === 'issue_002')) === before002, '返工后其他需求一个都不动');
  ok(fs.existsSync(path.join(dir, 'issue_001-rework1.md')), '返工新条目有独立文件');

  const t = b.exportText();
  const i1 = t.indexOf('## 1 待办'), i2 = t.indexOf('## 2 回答后的文件'), i3 = t.indexOf('## 3 ai待办');
  ok(i1 >= 0 && i1 < i2 && i2 < i3, '读取优先度：待办 > 回答后的文件 > ai待办');
  ok(t.includes('用户原需求区空置'), '用户原需求空置占位如实标注');
  ok(t.includes('测试回答一') && t.includes('测试回答二'), '两份回答文件都进导出（回归用例）');

  const add = b.add({ title: '测试新增', source: '测试来源' });
  ok(add.ok && fs.existsSync(path.join(dir, add.id + '.md')), '新增【遗留问题】另开新文件');
  console.log('=== 全部通过：' + passed + ' 项 ===');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
