'use strict';
/**
 * 回归：C_TODO 阶段 1~3 主干 + 状态机 + C_TODO.md 生成。
 * 用临时目录 + 临时 appRoot，不碰正式 SQLite / .ticiqi。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CTodoCore } = require('../app/backend/ctodo-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctodo-core-test-'));
const dbPath = path.join(tmp, 'test.db');
const core = new CTodoCore(dbPath, tmp);
let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; console.log('  ✓ ' + msg); }

try {
  // 项目
  const p = core.createProject('回归项目', 'regress');
  ok(p && p.id, '建项目');
  core.switchProject(p.id);
  ok(core.currentProjectId() === p.id, '切当前项目');
  ok(core.listProjects().length === 1, '列项目');

  // 节点树
  const root = core.addNode(p.id, '根模块', null, 'project');
  const child = core.addNode(p.id, '子功能', root.nodeId, 'feature');
  ok(core.getNode(child.nodeId).path === '根模块/子功能', 'treePath 自动计算');
  let rejected = false;
  try { core.addNode(p.id, '三级', child.nodeId); } catch (_) {}
  ok(core.getNode(core.addNode(p.id, '三级', child.nodeId).nodeId).path === '根模块/子功能/三级', '任意深度三级节点');

  // 需求 CRUD
  const r1 = core.addRequirement(p.id, '原文一：做拆分', { nodeId: child.nodeId, title: '拆分', priority: 'high' });
  const r2 = core.addRequirement(p.id, '原文二：做搜索', { nodeId: child.nodeId, priority: 'low' });
  ok(r1.id === 'req_001' && r2.id === 'req_002', 'req_ id 递增');
  ok(r1.displayTitle === '拆分', '有 title 显示 title');
  const r3 = core.addRequirement(p.id, '这是一段很长的需求原文用于测试默认标题截断显示是否正确');
  ok(r3.displayTitle.length === 16, '无 title 显示原文前 16 字');
  ok(r1.treePath === '根模块/子功能', '需求继承 treePath');

  // 编辑 / 补充 / changes
  const e1 = core.editRequirement(r1.id, { priority: 'medium', applicationScene: '命令行' });
  ok(e1.version === 2 && e1.changes.some(c => c.field === 'priority'), '编辑记 changes + version+1');
  ok(e1.segments.applicationScene === '命令行', '六段字段写入');
  ok(core.supplement(r1.id, '补充内容').supplements.length === 1, '补充只追加');

  // 三区 + 聚合
  const tree = core.tree(p.id, false);
  const childNode = tree.nodes.find(n => n.nodeId === child.nodeId);
  ok(childNode.groups.todo.length === 2, '三区：待办区 2 条');
  ok(childNode.aggregateStatus === '待办', '聚合状态=待办（全 todo）');

  // 想法↔待办
  ok(core.setStatusSimple(r2.id, 'idea').status === 'idea', '待办转想法');
  ok(core.setStatusSimple(r2.id, 'todo').status === 'todo', '想法转回待办');

  // 手动完成 + summary 规则
  const done = core.completeManual(r1.id, { version: r1.version + 1, files: ['a.js'], evidence: ['a.js:1'] });
  ok(done.status === 'done_user' && done.doneReport.summary === '拆分', '手动完成 done_user + summary=title');
  ok(fs.existsSync(path.join(tmp, '.ticiqi', 'C_DONE', r1.id + '.md')), 'C_DONE/{id}.md 生成');

  // version 并发校验
  let invalidated = false;
  try { core.completeManual(r2.id, { version: 1 }); } catch (e) { invalidated = /作废|version/.test(e.message); }
  ok(invalidated, 'version 不一致作废');

  // 重开 + 确认转正 + 标错
  ok(core.reopen(done.id).doneHistory.length === 1, '重开回 todo + 完成历史');
  ok(core.confirmAi(r2.id, { version: core.getRequirement(r2.id).version }).status === 'done_ai', '确认转正 done_ai');
  const wrong = core.markWrong(core.getRequirement(r2.id).id, '改写原文', '错误');
  ok(wrong.status === 'todo' && wrong.text === '改写原文' && wrong.doneHistory.length === 1, '标错改写原文');

  // AI 新增 + 确认 + 清理
  const aiNew = core.addRequirement(p.id, 'AI建议', { status: 'ai_done' });
  ok(aiNew.status === 'ai_done', 'AI新增 ai_done');
  ok(core.confirmAiNew(aiNew.id).status === 'done_ai', 'AI新增确认转正');
  const aiNew2 = core.addRequirement(p.id, 'AI建议2', { status: 'ai_done' });
  ok(core.aiCleanup(aiNew2.id, '测试清理').ok && !core.getRequirement(aiNew2.id), 'AI清理物理删除');

  // 归档 / 恢复
  const arch = core.archiveRequirement(r1.id);
  ok(arch.archived && arch.archivedFrom, '归档快照');
  const restored = core.restoreRequirement(r1.id);
  ok(!restored.archived && restored.status === arch.archivedFrom.status, '恢复整体还原');

  // 搜索
  ok(core.search(p.id, '拆分').length >= 1, '搜索命中');

  // 同步待办 / C_TODO.md 三区
  const sync = core.sync(p.id, null);
  ok(sync.ok && sync.userCount >= 1, '同步待办返回成功');
  const md = fs.readFileSync(path.join(tmp, '.ticiqi', 'C_TODO.md'), 'utf8');
  ok(md.includes('## 用户待办') && md.includes('## AI待办') && md.includes('## 待修复'), 'C_TODO.md 三区齐全');
  ok(md.includes('版本') === false && md.includes('version:'), 'C_TODO.md 含 version 行');

  // 写操作失败不留失效：重复归档应抛错且不改状态
  core.archiveRequirement(r1.id);              // 先归档（此时 r1 已恢复，为未归档）
  const before = core.getRequirement(r1.id);  // archived=true
  let threw = false;
  try { core.archiveRequirement(r1.id); } catch (e) { threw = true; }
  ok(threw && core.getRequirement(r1.id).archived === before.archived, '非法写操作抛错且不破坏状态');

  console.log('\n回归-C_TODO主干：' + pass + ' 项全过');
} finally {
  core.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
