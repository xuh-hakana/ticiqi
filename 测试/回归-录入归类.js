'use strict';
/**
 * 回归-录入归类.js —— 「原始内容 → 功能树/六段/断言/文件/联动 → 写入 → 待确认区」回归
 *
 * 跑法：node 测试/回归-录入归类.js
 * 只用临时库和临时 .ticiqi，跑完自动清理；不碰真实 ctodo.db、不碰 .ticiqi 正本。
 * 夹具：测试/fixtures/录入-虚幻全流程.txt（主人 2026-11-22 贴的真实虚幻项目原文，逐字）
 *       测试/fixtures/录入-用户原话.txt（有用户原话的一条，验证不会误判成 AI新增）
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { CTodoCore } = require('../app/backend/ctodo-core');
const ingest = require('../app/backend/ingest');

const ROOT = path.dirname(__dirname);
const FIXTURE = path.join(__dirname, 'fixtures', '录入-虚幻全流程.txt');
const FIXTURE_USER = path.join(__dirname, 'fixtures', '录入-用户原话.txt');
const XUHBOT = '/Volumes/980/xuhuan mac/xuhbot';
const HAS_XUHBOT = fs.existsSync(path.join(XUHBOT, 'src', 'people.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-reg-'));
const dbPath = path.join(tmp, 'ctodo.db');
const appRoot = path.join(tmp, 'app');
fs.mkdirSync(appRoot, { recursive: true });
const core = new CTodoCore(dbPath, appRoot);

let pass = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log('  ✓ ' + msg); }
  else { console.error('  ✗ ' + msg); process.exitCode = 1; }
}
const squeeze = s => String(s || '').replace(/\s+/g, '');
const has = (arr, kw) => (arr || []).some(x => squeeze(x).includes(squeeze(kw)));

const raw = fs.readFileSync(FIXTURE, 'utf8');

// 按真实数据形状播种：项目 虚幻 / xuhbot + 4 个节点 + 3 条 ai_done
function seed() {
  const p = core.createProject('虚幻', 'xuhbot');
  const root = core.addNode(p.id, '人物识别与建档', null, 'feature');
  const qq = core.addNode(p.id, 'QQ 群聊', root.nodeId, 'feature');
  const dm = core.addNode(p.id, 'QQ 私聊', root.nodeId, 'feature');
  const bili = core.addNode(p.id, 'B站（评论 / 私信）', root.nodeId, 'feature');
  const add = (text, title) => core.addRequirement(p.id, text, {
    title, status: 'ai_done', source: 'ai', nodeId: qq.nodeId,
    doneReport: { summary: title, files: [], evidence: [], time: Date.now() },
  });
  add('QQ 群聊：说话就建档', 'QQ 群聊：说话就建档');
  add('QQ 私聊：说话就建档', 'QQ 私聊：说话就建档');
  add('B站：回复成功才建档', 'B站：回复成功才建档');
  if (HAS_XUHBOT) core.setProjectRoot(p.id, XUHBOT);
  return { p, root, qq, dm, bili };
}

console.log('录入归类回归（临时库：' + dbPath + '）');
const seeded = seed();
const project = seeded.p;

const opts = () => ({
  projectId: project.id,
  projectRoot: HAS_XUHBOT ? XUHBOT : '',
  existingProjects: core.listProjects(true),
  nodes: core.listNodes(project.id),
  existingTexts: core.listRequirements(project.id).filter(r => !r.archived).map(r => r.text),
});

const analyzed = ingest.analyze(raw, opts());
const P = analyzed.proposals;

// 1 夹具逐字
ok(P.length === 5, '2 拆条：①~⑤ 拆成 5 条（不是 1 条、不是 11+）');
const joined = P.map(p => p.text).join('\n');
const missingLines = raw.split('\n').map(s => s.trim()).filter(Boolean).filter(line => !joined.includes(line));
ok(missingLines.length === 0, '1 原文逐字：夹具每个非空行都还在 5 条 text 里' + (missingLines.length ? '（缺：' + missingLines.length + ' 行）' : ''));
const titles = P.map(p => p.title);
ok(JSON.stringify(titles) === JSON.stringify(['陌生人在群里说话', '她回了他 → 建档', '陌生人 → 认识的人', '认识的人 → 朋友', '全资料什么时候写']), '2 标题逐字：' + titles.join(' / '));

// 3 项目 / 节点
ok(analyzed.stats.projectName === '虚幻', '3 项目识别：虚幻');
const rootNode = core.listNodes(project.id).find(n => n.name === '人物识别与建档');
ok(P.every(p => p.parentNodeId === rootNode.nodeId), '3 父节点：复用已有「人物识别与建档」，不重建');
ok(P.every(p => p.nodePathFull.startsWith('人物识别与建档/全流程：陌生人 → 认识的人 → 朋友/')), '3 节点全路径：人物识别与建档/全流程…/<标题>');
ok(P.every(p => p.nodePath[0] === '全流程：陌生人 → 认识的人 → 朋友'), '3 一级标题作功能父节点：全流程：陌生人 → 认识的人 → 朋友');

// 4 大类 / 来源
ok(P.every(p => p.status === 'ai_done'), '4 大类：5 条全是 AI新增（没有用户原话的 AI 功能描述）');
ok(P.every(p => p.source === 'xuhbot-impl'), '4 来源：xuhbot-impl');
ok(P.slice(0, 4).every(p => p.priority === 'high') && P[4].priority === 'medium', '4 优先级：①~④ 高、⑤ 中');

// 5 六段 + 表格
ok(P.every(p => p.segCount >= 3), '5 六段：每条至少 3 段有内容（' + P.map(p => p.segCount).join('/') + '）');
const table = P[4].table;
ok(!!table && table.rows.length === 11, '5 扁平表格还原成 11 行');
const fx = table ? table.markdown : '';
ok(['真名', 'QQ 昵称', '群名片', 'B站昵称', '性别', '身份', '好感', '喜好·事实·约定·话题', '第一次相遇', '代称（别人喊的）', '曾用名'].every(w => fx.includes(w)), '5 字段表 11 个字段齐全');
ok(String(P[4].segments['数据来源'] || '').includes('| 字段 | 来源 | 时机 |'), '5 表格落在⑤「数据来源」段');

// 6 断言关键词
ok(has(P[0].acceptance, '上限 500') || has(P[0].acceptance, '500'), '6 ① 断言：seen 上限 500');
ok(has(P[0].acceptance, '重启清空'), '6 ① 断言：重启清空');
ok(has(P[0].acceptance, '不写 people.json'), '6 ① 断言：不写 people.json');
ok(has(P[0].acceptance, '未建档直接返回昵称不落盘'), '6 ① 断言：未建档只返回昵称不落盘');
ok(has(P[1].acceptance, "role = stranger") && has(P[1].acceptance, 'sexSrc = guess') && has(P[1].acceptance, 'favor = 0'), '6 ② 断言：role/sexSrc/favor');
ok(has(P[1].acceptance, 'r2.text') && has(P[1].acceptance, 'turnCtx.aimUid'), '6 ② 断言：r2.text 与 turnCtx.aimUid');
ok(has(P[2].acceptance, '现算') && has(P[2].acceptance, '不写字段') && has(P[2].acceptance, '好感=0'), '6 ③ 断言：现算 / 不写字段 / 好感=0');
ok(has(P[2].acceptance, '好感 > 0'), '6 ③ 断言：好感 > 0');
ok(has(P[3].acceptance, 'FRIEND_AT') && has(P[3].acceptance, 'favor > 20') && has(P[3].acceptance, '被夸 +1'), '6 ④ 断言：FRIEND_AT / favor > 20 / 被夸 +1');
ok(has(P[4].acceptance, '变了才写') && has(P[4].acceptance, 'card 空不覆盖') && has(P[4].acceptance, '现算不落盘'), '6 ⑤ 断言：变了才写 / card 空不覆盖 / 现算不落盘');

// 7 文件
const seenRef = P[0].files.find(f => f.ref === 'seen.js');
ok(!!seenRef && seenRef.exists === false, '7 文件：seen.js 标「待核实」（xuhbot 已删）');
if (HAS_XUHBOT) {
  ok(P[0].files.some(f => f.ref === 'people.json' && f.resolved === 'src/data/people.json'), '7 文件：people.json → src/data/people.json');
  ok(P[0].files.some(f => f.ref === 'qq.js' && f.resolved === 'src/connectors/qq.js'), '7 文件：qq.js → src/connectors/qq.js');
  ok(P[0].files.some(f => f.ref === 'people.js' && f.resolved === 'src/people.js'), '7 文件：people.js → src/people.js');
  ok(P[4].files.some(f => f.ref === 'panel.js' && f.resolved === 'src/server/panel.js'), '7 文件：panel.js → src/server/panel.js');
} else {
  console.log('  · 跳过文件存在性断言（xuhbot 根不存在）');
  ok(P[0].files.some(f => f.ref === 'people.json'), '7 文件：people.json 引用被提取');
}

// 8 联动 / 复用
const reqLinks = p => p.links.filter(l => l.kind === '联动' && l.ref.startsWith('req:'));
ok(P.slice(0, 4).every(p => reqLinks(p).length >= 1), '8 联动：①~④ 各有步骤联动');
ok(P[4].links.filter(l => l.kind === '联动' && l.ref.startsWith('req:')).length === 4, '8 联动：⑤ 关联 ①~④');
ok(P.slice(0, 5).some(p => p.links.some(l => l.ref.startsWith('node:node_00'))), '8 联动：连到平台节点');
ok(P.some(p => p.links.some(l => l.kind === '复用')), '8 复用：至少 1 条（FRIEND_AT / people.json 同用）');

// 9 去重
const again = ingest.analyze(raw, Object.assign(opts(), { existingTexts: [] , nodes: core.listNodes(project.id) }));
ok(again.stats.entries === 5, '9 空库再分析：仍 5 条');
const dedupedAway = ingest.analyze(raw, Object.assign(opts(), { existingTexts: P.map(p => p.text) }));
ok(dedupedAway.stats.entries === 0 && dedupedAway.stats.deduped === 5, '9 去重：同样内容第二次 → 0 条、跳过 5 条');

// 10 commit
const beforeNodes = core.listNodes(project.id).length;
const beforeReqs = core.listRequirements(project.id).length;
const commitOut = ingest.commit(core, project.id, P);
ok(commitOut.createdIds.length === 5 && commitOut.createdIds[0] === 'req_004', '10 写入：5 条需求，id 从 req_004 起');
ok(core.listNodes(project.id).length === beforeNodes + 6, '10 写入：新建 6 个节点（1 父 + 5 子），已有节点不重建');
const reqs = core.listRequirements(project.id).filter(r => commitOut.createdIds.includes(r.id));
ok(reqs.every(r => r.status === 'ai_done' && r.version === 1 && r.viewed === false), '10 写入：状态 AI新增 / version 1 / 未过目');
ok(reqs.every(r => r.treePath === '人物识别与建档/全流程：陌生人 → 认识的人 → 朋友/' + r.title), '10 写入：treePath 正确');
ok(reqs.every(r => Array.isArray(r.doneReport.files) && r.doneReport.files.length > 0), '10 写入：doneReport.files 非空（实际代码文件）');
ok(reqs.every(r => Array.isArray(r.changes) && r.changes[0] && r.changes[0].field === 'ingest'), '10 写入：changes 留归类依据');
const todoMd = fs.readFileSync(path.join(appRoot, '.ticiqi', 'C_TODO.md'), 'utf8');
const aiTodoCount = (todoMd.match(/^### req_/gm) || []).length;
ok(aiTodoCount === 5 && todoMd.includes('### ' + commitOut.createdIds[0]), '10 C_TODO.md：AI待办区满 5 条且含新写入的 req_' + commitOut.createdIds[0].slice(4));
const detailDir = path.join(appRoot, '.ticiqi', 'C_DETAIL');
ok(commitOut.createdIds.filter(id => fs.existsSync(path.join(detailDir, id))).length >= 2, '10 C_DETAIL：本轮排进 AI待办的新条目都有分段目录');

// 11 待确认区 → 转正 / 改归属 / 标错
const queue = core.confirmQueue(project.id);
ok(queue.count === 8, '11 待确认区：3 条播种 + 5 条新写入 = 8 条');
const q5 = queue.items.filter(i => commitOut.createdIds.includes(i.id));
ok(q5.every(i => i.confidence && i.evidence.length > 0 && i.segCount >= 3), '11 待确认区：带置信度/依据/六段计数');
core.confirmAiNewBatch(commitOut.createdIds);
ok(core.listRequirements(project.id).filter(r => commitOut.createdIds.includes(r.id)).every(r => r.status === 'done_ai'), '11 全部确认转正 → 5 条 AI转正');
const misFile = path.join(appRoot, '.ticiqi', 'C_MISCLASSIFIED.jsonl');
const misBefore = fs.existsSync(misFile) ? fs.readFileSync(misFile, 'utf8').split('\n').filter(Boolean).length : 0;
core.moveRequirement(commitOut.createdIds[0], seeded.qq.nodeId, '测试：改到 QQ 群聊');
const moved = core.getRequirement(commitOut.createdIds[0]);
ok(moved.treePath === '人物识别与建档/QQ 群聊' && moved.nodeId === seeded.qq.nodeId, '11 改归属：节点与 treePath 跟着改');
const misAfter = fs.readFileSync(misFile, 'utf8').split('\n').filter(Boolean).length;
ok(misAfter === misBefore + 1, '11 改归属：C_MISCLASSIFIED.jsonl 追加 1 行审计');
core.markWrong(commitOut.createdIds[1], '改写后的原文（测试）', '测试标错');
const wrong = core.getRequirement(commitOut.createdIds[1]);
ok(wrong.status === 'todo' && wrong.doneHistory.length > 0, '11 标错：回待办且原记录进 doneHistory');

// 12 事务回滚
const nBefore = core.listNodes(project.id).length;
const rBefore = core.listRequirements(project.id).length;
let threw = false;
try {
  ingest.commit(core, project.id, [P[0], Object.assign({}, P[1], { text: '' })]);
} catch (e) { threw = true; }
ok(threw, '12 事务：空原文的 proposal 写入抛错');
ok(core.listNodes(project.id).length === nBefore && core.listRequirements(project.id).length === rBefore, '12 事务：失败后节点/需求一条都没多');

// 13 用户原话不被误判
const userText = fs.readFileSync(FIXTURE_USER, 'utf8');
const userProj = core.createProject('提词器', 'ticiqi');
const ua = ingest.analyze(userText, {
  projectId: userProj.id, existingProjects: core.listProjects(true),
  nodes: core.listNodes(userProj.id), existingTexts: [],
});
ok(ua.stats.profile === 'user-requirement', '13 用户原话：识别为 user-requirement');
ok(ua.proposals.length >= 1 && ua.proposals.every(p => p.status === 'todo' || p.status === 'idea'), '13 用户原话：进待办/想法，不是 AI新增');
ok(ua.proposals.every(p => p.kind === 'user-requirement' && p.nodePath.length === 0), '13 用户原话：不建功能节点、不拆细');
const userNodesBefore = core.listNodes(userProj.id).length;
ingest.commit(core, userProj.id, ua.proposals);
ok(core.listNodes(userProj.id).length === userNodesBefore, '13 用户原话：写入后仍没有新增节点');

// 14 既有回归
const regressions = [
  '回归-C_TODO地基.js', '回归-C_TODO主干.js', '回归-已完成区录入.js', '回归-遗留问题状态机.js',
];
let regOk = 0;
for (const f of regressions) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, f)], { cwd: ROOT, stdio: 'pipe' });
    regOk += 1;
    console.log('  ✓ 14 既有回归通过：' + f);
  } catch (e) {
    console.error('  ✗ 14 既有回归失败：' + f + ' — ' + String(e.stdout || e.message).slice(-300));
    process.exitCode = 1;
  }
}
ok(regOk === regressions.length, '14 既有 4 个回归全过');

// 15 CLI
let cliJson = null;
try {
  const out = execFileSync(process.execPath, [
    path.join(ROOT, 'app', 'backend', 'ingest-cli.js'), '--file', FIXTURE,
    '--root', HAS_XUHBOT ? XUHBOT : '', '--analyze', '--json',
  ], { cwd: ROOT, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
  cliJson = JSON.parse(String(out));
} catch (e) {
  console.error('  ✗ CLI --analyze 失败：' + String(e.stderr || e.message).slice(-300));
  process.exitCode = 1;
}
ok(!!cliJson && cliJson.proposals.length === 5, '15 CLI：--analyze --json 输出 5 条且可解析');
try {
  const out = execFileSync(process.execPath, [
    path.join(ROOT, 'app', 'backend', 'ingest-cli.js'), '--file', FIXTURE, '--commit',
  ], { cwd: ROOT, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
  ok(String(out).includes('已写入：需求 5 条'), '15 CLI：--commit 真写入 5 条');
} catch (e) {
  console.error('  ✗ CLI --commit 失败：' + String(e.stderr || e.message).slice(-300));
  process.exitCode = 1;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n录入归类回归：' + pass + ' 项通过' + (process.exitCode ? '（有失败）' : '，全绿'));
