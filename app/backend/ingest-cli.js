'use strict';
/**
 * ingest-cli.js —— 「录入」归类引擎的命令行入口
 *
 * 这是干什么的：不经过前端，直接拿一个文本文件跑一遍 analyze（只算）或 commit（真写），
 * 用来验证归类结果、生成设计稿演示数据。默认用临时库 + 临时 .ticiqi，跑完不碰真实数据。
 *
 * 用法：
 *   node app/backend/ingest-cli.js --file 测试/fixtures/录入-虚幻全流程.txt --analyze
 *   node app/backend/ingest-cli.js --file ... --root "/Volumes/980/xuhuan mac/xuhbot" --analyze --json --out /tmp/analyze.json
 *   node app/backend/ingest-cli.js --file ... --commit --json
 *   可选：--project <id或名> --db <库路径> --app-root <目录>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CTodoCore } = require('./ctodo-core');
const ingest = require('./ingest');

function arg(argv, name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

function seed(core) {
  const proj = core.createProject('虚幻', 'xuhbot');
  const root = core.addNode(proj.id, '人物识别与建档', null, 'feature');
  core.addNode(proj.id, 'QQ 群聊', root.nodeId, 'feature');
  core.addNode(proj.id, 'QQ 私聊', root.nodeId, 'feature');
  core.addNode(proj.id, 'B站（评论 / 私信）', root.nodeId, 'feature');
  const done = (text, title) => core.addRequirement(proj.id, text, {
    title, status: 'ai_done', source: 'ai', nodeId: root.nodeId,
    doneReport: { summary: title, files: [], evidence: [], time: Date.now() },
  });
  done('QQ 群聊：说话就建档（群名片/资料卡只认真实值，变了才写盘）', 'QQ 群聊：说话就建档');
  done('QQ 私聊：说话就建档（资料卡名 + 首见）', 'QQ 私聊：说话就建档');
  done('B站：回复成功才建档（AstrBot 插件 → /api/enroll）', 'B站：回复成功才建档');
  return proj;
}

function findProject(core, key) {
  if (!key) return core.getProject(core.currentProjectId());
  const list = core.listProjects(true);
  return list.find(p => p.id === key) || list.find(p => p.name === key) || list.find(p => p.folderName === key) || null;
}

function main() {
  const argv = process.argv.slice(2);
  const file = arg(argv, 'file', '');
  if (!file) { console.error('缺少 --file <文本文件>'); process.exit(2); }
  const text = fs.readFileSync(file, 'utf8');
  const doCommit = !!arg(argv, 'commit', false);
  const asJson = !!arg(argv, 'json', false);
  const outPath = arg(argv, 'out', '');

  let tmp = null;
  let dbPath = arg(argv, 'db', '');
  let appRoot = arg(argv, 'app-root', '');
  if (!dbPath) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-cli-'));
    dbPath = path.join(tmp, 'ctodo.db');
    if (!appRoot) appRoot = path.join(tmp, 'app');
  }
  fs.mkdirSync(appRoot, { recursive: true });

  const core = new CTodoCore(dbPath, appRoot);
  const project = findProject(core, arg(argv, 'project', '')) || seed(core);
  const nodes = core.listNodes(project.id);
  const existingTexts = core.listRequirements(project.id).filter(r => !r.archived).map(r => r.text);
  const projectRoot = arg(argv, 'root', '') || core.getProjectRoot(project.id);
  if (projectRoot) core.setProjectRoot(project.id, projectRoot);

  const result = ingest.analyze(text, {
    projectId: project.id, projectRoot,
    existingProjects: core.listProjects(true), nodes, existingTexts,
  });

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  if (asJson) {
    const payload = doCommit ? null : result;
    if (doCommit) {
      const committed = ingest.commit(core, project.id, result.proposals);
      console.log(JSON.stringify({ stats: result.stats, committed }, null, 2));
    } else {
      console.log(JSON.stringify(payload, null, 2));
    }
    return;
  }

  const st = result.stats;
  console.log('【录入识别】' + (st.profile === 'feature-doc' ? '功能文档' : '用户原话')
    + ' · 拆出 ' + st.entries + ' 条 · 表格 ' + st.tables + ' 个 · 去重 ' + st.deduped
    + ' · 待核实文件 ' + st.unresolvedFiles + ' · 置信度 ' + st.confidence);
  console.log('项目：' + (st.projectName || '（未判断）') + '（' + (st.projectId || '—') + '）');
  result.proposals.forEach((p, i) => {
    const files = p.files.map(f => f.ref + (f.exists === false ? '（待核实）' : f.resolved ? ' → ' + f.resolved : '')).join('、');
    console.log('\n' + (i + 1) + '. ' + p.title + '   [' + p.status + ' / ' + p.priority + ' / ' + p.confidence + ']');
    console.log('   节点：' + (p.nodePath.length ? p.nodePath.join(' / ') : '（不建节点）'));
    console.log('   六段：' + p.segCount + '/6 · 断言 ' + p.acceptance.length + ' 条 · 联动/复用 ' + p.links.length + ' 条');
    console.log('   文件：' + (files || '（无）'));
    console.log('   依据：' + p.evidence.join('；'));
  });

  if (doCommit) {
    const out = ingest.commit(core, project.id, result.proposals);
    console.log('\n已写入：需求 ' + out.createdIds.length + ' 条（' + out.createdIds.join('、') + '）');
    console.log('新建节点：' + out.nodes.length + ' 个（' + out.nodes.map(n => n.name).join('、') + '）');
    console.log('C_TODO.md：' + out.todo.file + ' · 用户待办 ' + out.todo.userCount + ' · AI待办 ' + out.todo.aiCount);
    console.log('待确认区：' + core.confirmQueue(project.id).count + ' 条');
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

main();
