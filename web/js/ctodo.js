'use strict';
/**
 * 【C_TODO 统一需求内核】· 界面层
 *
 * 这是干什么的：提词器里打开 C_TODO 弹层，能在客户端内看到并操作整棵需求树——
 * 项目切换/新建/改名、任意深度节点树、三区分组（待办/已完成三子标签/失效）、
 * 需求新增、状态流转（完成/转正/重开/标错/AI新增确认/清理/归档恢复）、同步待办生成 C_TODO.md。
 * 她「只认客户端」：数据必须在这里能看能改，不只是躺在 SQLite 文件里。
 *
 * 沿用 issues.js / records.js 的独立脚本写法与现成 issue-* 样式，不碰 app.js。
 * CSP script-src 'self'，必须是同源外部脚本。
 */
(function () {
  var selectedNode = null;   // 当前选中节点 nodeId
  var subTab = 'user';       // 已完成区子标签：user / ai / aiNew
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg) {
    var el = $('ctodoToast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3400);
    el.onclick = function () { el.hidden = true; };
  }

  // ===== 非阻塞输入/确认弹窗（2026-11-17 替换原生 prompt/confirm）=====
  // 原生 prompt/confirm 冻结整页、样式和主题不一致。这里用现成 issue-* 样式自建，走 Promise，
  // 语义和原生「等用户输入完再继续」一致。CSP 禁 inline 事件，全部用 addEventListener。
  var dlgOpen = false;
  function closeDlg(layer, val, resolve) {
    if (!layer || !layer.parentNode) return;
    if (layer.__key) document.removeEventListener('keydown', layer.__key);
    layer.parentNode.removeChild(layer);
    dlgOpen = false;
    resolve(val);
  }
  function dlgShell(inner) {
    var layer = document.createElement('div');
    layer.className = 'issue-overlay';
    layer.style.zIndex = '200';
    layer.innerHTML = '<div class="issue-panel" style="width:min(440px,92vw);height:auto;padding:0">' + inner + '</div>';
    document.body.appendChild(layer);
    return layer;
  }
  function askPrompt(label, def) {
    return new Promise(function (resolve) {
      if (dlgOpen) { resolve(null); return; }
      dlgOpen = true;
      var layer = dlgShell(
        '<div style="padding:18px 20px">' +
          '<div style="font-size:12px;color:var(--muted,#7a8699);margin-bottom:8px">请输入</div>' +
          '<div style="font-size:13px;margin-bottom:12px">' + esc(label) + '</div>' +
          '<input class="ctodo-dlg-input" type="text" style="width:100%;box-sizing:border-box;border:1px solid var(--line,#dfe6f0);border-radius:8px;padding:9px 10px;font:inherit;font-size:12px;background:var(--card,#fff);color:var(--text,#1b2333)" value="' + esc(def == null ? '' : def) + '">' +
          '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">' +
            '<button class="ghost-btn ctodo-dlg-cancel" type="button">取消</button>' +
            '<button class="primary-btn ctodo-dlg-ok" type="button">确定</button>' +
          '</div>' +
        '</div>');
      var input = layer.querySelector('.ctodo-dlg-input');
      function ok() { closeDlg(layer, input.value, resolve); }
      function cancel() { closeDlg(layer, null, resolve); }
      layer.__key = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); ok(); }
      };
      document.addEventListener('keydown', layer.__key);
      layer.querySelector('.ctodo-dlg-ok').addEventListener('click', ok);
      layer.querySelector('.ctodo-dlg-cancel').addEventListener('click', cancel);
      layer.addEventListener('click', function (e) { if (e.target === layer) cancel(); });
      setTimeout(function () { try { input.focus(); input.select(); } catch (_) {} }, 0);
    });
  }
  function askConfirm(msg) {
    return new Promise(function (resolve) {
      if (dlgOpen) { resolve(false); return; }
      dlgOpen = true;
      var layer = dlgShell(
        '<div style="padding:18px 20px">' +
          '<div style="font-size:13px;margin-bottom:16px">' + esc(msg) + '</div>' +
          '<div style="display:flex;justify-content:flex-end;gap:8px">' +
            '<button class="ghost-btn ctodo-dlg-cancel" type="button">取消</button>' +
            '<button class="primary-btn ctodo-dlg-ok" type="button">确定</button>' +
          '</div>' +
        '</div>');
      function ok() { closeDlg(layer, true, resolve); }
      function cancel() { closeDlg(layer, false, resolve); }
      layer.__key = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        else if (e.key === 'Enter') { e.preventDefault(); ok(); }
      };
      document.addEventListener('keydown', layer.__key);
      layer.querySelector('.ctodo-dlg-ok').addEventListener('click', ok);
      layer.querySelector('.ctodo-dlg-cancel').addEventListener('click', cancel);
      layer.addEventListener('click', function (e) { if (e.target === layer) cancel(); });
      setTimeout(function () { try { layer.querySelector('.ctodo-dlg-ok').focus(); } catch (_) {} }, 0);
    });
  }

  function api(path, body) {
    var init = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch('/api/ctodo/' + path, init).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || (j && j.error)) throw new Error((j && (j.message || j.error)) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  var STATUS_LABEL = {
    todo: '待办', idea: '想法', done_user: '已完成', done_ai: 'AI转正', ai_done: 'AI新增'
  };
  var AGG_CLS = { '待办': 'agg-todo', '半完成': 'agg-half', '已完成': 'agg-done', '失效': 'agg-invalid' };
  var PRIO_CLS = { high: 'prio-high', medium: 'prio-medium', low: 'prio-low' };

  // -------------------------------------------------------------------------
  // 加载 / 渲染
  // -------------------------------------------------------------------------
  function loadOverview() {
    return api('overview').then(function (data) {
      renderProjects(data.projects || [], data.currentProjectId, data.archivedProjects || []);
      window.__ctodoTree = data.tree;   // 供树点击 / 子标签切换 / 状态操作取需求版本
      // 首次打开（未选节点）自动选中第一个有需求的节点，避免右侧空白。
      if (!selectedNode && data.tree && data.tree.nodes && data.tree.nodes.length) {
        var withReq = data.tree.nodes.find(function (n) {
          var g = n.groups;
          return g.todo.length || g.done.user.length || g.done.ai.length || g.done.aiNew.length;
        });
        if (withReq) selectedNode = withReq.nodeId;
      }
      renderTree(data.tree);
      var st = data.state || {};
      var counts = st.counts || {};
      var stat = $('ctodoStats');
      if (stat) {
        stat.textContent = '项目 ' + (data.projects || []).length + ' · 节点 ' + (counts.nodes || 0) +
          ' · 需求 ' + (counts.requirements || 0) + ' · 未处理报告 ' + (data.pending || 0) +
          ' · 库 ' + (st.journal || '?') + ' · ' + (st.dbPath || '');
      }
      return data;
    });
  }

  function renderProjects(projects, currentId, archivedProjects) {
    var sel = $('ctodoProject');
    if (!sel) return;
    sel.innerHTML = projects.length
      ? projects.map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (p.id === currentId ? ' selected' : '') + '>' + esc(p.name) + '</option>';
        }).join('')
      : '<option value="">（无项目，点 + 项目）</option>';
    // 恢复区：软删的项目从这里找回（数据不丢）。
    var wrap = $('ctodoRestoreWrap');
    var rsel = $('ctodoRestoreSel');
    if (wrap && rsel) {
      var arch = archivedProjects || [];
      wrap.hidden = arch.length === 0;
      rsel.innerHTML = '<option value="">选已删项目…</option>' +
        arch.map(function (p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
        }).join('');
    }
  }

  function renderTree(tree) {
    var box = $('ctodoTree');
    if (!box) return;
    if (!tree || !tree.nodes || !tree.nodes.length) {
      box.innerHTML = '<p class="issue-empty">还没有节点。点上方「+ 节点」建第一个分组；需求也可以先建在根节点下。</p>';
      renderReqList(tree);
      return;
    }
    var byParent = {};
    tree.nodes.forEach(function (n) {
      var k = n.parentId || '__root__';
      (byParent[k] = byParent[k] || []).push(n);
    });
    function nodeHtml(n) {
      var cls = AGG_CLS[n.aggregateStatus] || '';
      var agg = n.aggregateStatus ? '<span class="ctodo-agg ' + cls + '">' + esc(n.aggregateStatus) + '</span>' : '';
      var kids = byParent[n.nodeId] || [];
      var inner = kids.map(nodeHtml).join('');
      return '<div class="ctodo-tnode">' +
        '<div class="ctodo-trow' + (selectedNode === n.nodeId ? ' is-sel' : '') + '" data-node="' + esc(n.nodeId) + '">' +
          '<span class="ctodo-tcaret">' + (kids.length ? '▾' : '') + '</span>' +
          '<span>' + esc(n.name) + '</span>' + agg +
        '</div>' +
        (kids.length ? '<div class="ctodo-tkids">' + inner + '</div>' : '') +
      '</div>';
    }
    var roots = (byParent['__root__'] || []).map(nodeHtml).join('');
    var rootRow = '<div class="ctodo-trow' + (selectedNode === null ? ' is-sel' : '') + '" data-node="">' +
      '<span class="ctodo-tcaret"></span><span>（根节点 · 未归属）</span></div>';
    box.innerHTML = rootRow + roots;
    renderReqList(tree);
  }

  function findNode(nodes, id) {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeId === id) return nodes[i];
    }
    return null;
  }

  function reqCard(r) {
    var ops = [];
    if (r.status === 'todo' || r.status === 'idea') {
      ops.push('<button class="ghost-btn" data-op="complete" data-id="' + r.id + '">手动完成</button>');
      ops.push('<button class="ghost-btn" data-op="confirm-ai" data-id="' + r.id + '">确认转正</button>');
      ops.push('<button class="ghost-btn" data-op="status" data-id="' + r.id + '" data-to="' +
        (r.status === 'todo' ? 'idea' : 'todo') + '">转' + (r.status === 'todo' ? '想法' : '待办') + '</button>');
    } else {
      ops.push('<button class="ghost-btn" data-op="reopen" data-id="' + r.id + '">重开</button>');
      ops.push('<button class="ghost-btn" data-op="mark-wrong" data-id="' + r.id + '">标记错误</button>');
      if (r.status === 'ai_done') {
        ops.push('<button class="ghost-btn" data-op="ai-confirm" data-id="' + r.id + '">AI新增确认</button>');
        ops.push('<button class="ghost-btn" data-op="ai-cleanup" data-id="' + r.id + '">清理</button>');
      }
    }
    ops.push('<button class="ghost-btn" data-op="supplement" data-id="' + r.id + '">补充</button>');
    ops.push('<button class="ghost-btn" data-op="archive" data-id="' + r.id + '">归档</button>');
    var history = r.doneHistory && r.doneHistory.length
      ? '<p class="issue-note">完成历史 ' + r.doneHistory.length + ' 条 · 最近：' +
        esc((r.doneHistory[r.doneHistory.length - 1] || {}).type || '') + '</p>' : '';
    return '<article class="ctodo-req">' +
      '<div class="ctodo-req-head">' +
        '<span class="ctodo-rid">' + esc(r.id) + '</span>' +
        '<span class="ctodo-rstatus st-' + esc(r.status) + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>' +
        '<span class="' + PRIO_CLS[r.priority] + '" style="font-size:10px;">' +
          ({ high: '高', medium: '中', low: '低' }[r.priority] || '中') + '优先' +
        '</span>' +
        (r.archived ? '<span class="ctodo-rstatus agg-invalid">已归档</span>' : '') +
        '<span class="ctodo-rid">v' + r.version + ' · ' + esc(r.treePath || '根节点') + '</span>' +
      '</div>' +
      '<p class="ctodo-rtext">' + esc(r.text) + '</p>' +
      (r.supplements && r.supplements.length
        ? '<p class="issue-note">补充 ' + r.supplements.length + ' 条：' +
          esc(r.supplements[r.supplements.length - 1].text) + '</p>' : '') +
      history +
      '<div class="ctodo-rops">' + ops.join('') + '</div>' +
    '</article>';
  }

  function renderReqList(tree) {
    var box = $('ctodoReqList');
    if (!box) return;
    if (!tree) { box.innerHTML = '<p class="issue-empty">先建项目。</p>'; return; }
    var reqs;
    if (selectedNode === null) reqs = (tree.root && tree.root.todo) || [];
    else {
      var n = findNode(tree.nodes || [], selectedNode);
      reqs = n ? n.groups.todo : [];
    }
    var done = selectedNode === null
      ? { user: [], ai: [], aiNew: [] }
      : (findNode(tree.nodes || [], selectedNode) || {}).groups.done || { user: [], ai: [], aiNew: [] };
    var html = '<div class="ctodo-gsect">' +
      '<div class="ctodo-ghead">待办区 <span class="cnt">' + reqs.length + ' 条</span></div>' +
      (reqs.length ? reqs.map(reqCard).join('') : '<p class="issue-empty">（无）</p>') + '</div>';
    html += '<div class="ctodo-gsect">' +
      '<div class="ctodo-ghead">已完成区</div>' +
      '<div class="ctodo-subtabs">' +
        '<span class="ctodo-subtab' + (subTab === 'user' ? ' is-on' : '') + '" data-sub="user">已完成 ' + done.user.length + '</span>' +
        '<span class="ctodo-subtab' + (subTab === 'ai' ? ' is-on' : '') + '" data-sub="ai">AI转正 ' + done.ai.length + '</span>' +
        '<span class="ctodo-subtab' + (subTab === 'aiNew' ? ' is-on' : '') + '" data-sub="aiNew">AI新增 ' + done.aiNew.length + '</span>' +
      '</div>' +
      (done[subTab].length ? done[subTab].map(reqCard).join('') : '<p class="issue-empty">（无）</p>') +
      '</div>';
    box.innerHTML = html;
  }

  // -------------------------------------------------------------------------
  // 交互：树点击 / 子标签
  // -------------------------------------------------------------------------
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  ready(function () {
    var entry = $('ctodoEntryBtn');
    var overlay = $('ctodoOverlay');
    if (!entry || !overlay) return;

    function open() {
      overlay.hidden = false;
      loadOverview().catch(function (e) { toast('读不到 C_TODO：' + e.message); });
    }
    entry.addEventListener('click', open);
    // 验收/调试入口：?ctodo=1 自动打开弹层（不碰 app.js，不改默认行为）。
    try {
      if (new URLSearchParams(location.search).get('ctodo') === '1') open();
    } catch (_) { /* ignore */ }
    $('ctodoCloseBtn').addEventListener('click', function () { overlay.hidden = true; });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.hidden = true; });

    // 项目切换
    $('ctodoProject').addEventListener('change', function (e) {
      var id = e.target.value;
      if (!id) return;
      api('project/switch', { id: id })
        .then(function () { selectedNode = null; return loadOverview(); })
        .catch(function (err) { toast('切换失败：' + err.message); });
    });

    // 新建项目
    $('ctodoProjNewBtn').addEventListener('click', async function () {
      var name = await askPrompt('新项目名');
      if (!name || !name.trim()) return;
      api('project/create', { name: name.trim(), folderName: name.trim() })
        .then(function () { selectedNode = null; return loadOverview(); })
        .then(function () { toast('项目已建'); })
        .catch(function (err) { toast('新建失败：' + err.message); });
    });

    // 改名当前项目
    $('ctodoProjRenameBtn').addEventListener('click', async function () {
      var sel = $('ctodoProject');
      var id = sel.value;
      if (!id) { toast('先建项目'); return; }
      var cur = sel.options[sel.selectedIndex].text;
      var name = await askPrompt('重命名项目', cur);
      if (!name || !name.trim()) return;
      api('project/rename', { id: id, name: name.trim() })
        .then(function () { return loadOverview(); })
        .then(function () { toast('已改名'); })
        .catch(function (err) { toast('改名失败：' + err.message); });
    });

    // 删除当前项目（软删：归档，数据不丢，可从恢复区找回）
    $('ctodoProjDeleteBtn').addEventListener('click', async function () {
      var sel = $('ctodoProject');
      var id = sel.value;
      if (!id) { toast('先建项目'); return; }
      var cur = sel.options[sel.selectedIndex].text;
      var ok = await askConfirm('删除项目「' + cur + '」？\n数据不会丢，可从「恢复」下拉找回。');
      if (!ok) return;
      api('project/delete', { id: id })
        .then(function () { selectedNode = null; return loadOverview(); })
        .then(function () { toast('项目已删除（可恢复）'); })
        .catch(function (err) { toast('删除失败：' + err.message); });
    });

    // 恢复已删项目
    $('ctodoRestoreSel').addEventListener('change', function (e) {
      var id = e.target.value;
      if (!id) return;
      api('project/restore', { id: id })
        .then(function () { return loadOverview(); })
        .then(function () { toast('项目已恢复'); })
        .catch(function (err) { toast('恢复失败：' + err.message); });
    });

    // 新建节点（选中节点下；未选中则根节点）
    $('ctodoNodeAddBtn').addEventListener('click', async function () {
      var name = await askPrompt('新节点名（可任意深度：先建父节点，选中它再建子节点）');
      if (!name || !name.trim()) return;
      api('node/add', { name: name.trim(), parentId: selectedNode || null, type: 'feature' })
        .then(function (n) { selectedNode = n.nodeId; return loadOverview(); })
        .then(function () { toast('节点已建'); })
        .catch(function (err) { toast('建节点失败：' + err.message); });
    });

    // 新建需求：inline 表单
    $('ctodoReqAddBtn').addEventListener('click', function () {
      var box = $('ctodoReqList');
      var form = document.createElement('div');
      form.className = 'ctodo-form';
      form.innerHTML =
        '<textarea id="ctodoNewText" placeholder="需求原文（必填）"></textarea>' +
        '<input id="ctodoNewTitle" type="text" placeholder="标题（可选，空则显示原文前16字）">' +
        '<select id="ctodoNewPrio" aria-label="优先级">' +
          '<option value="high">高</option><option value="medium" selected>中</option><option value="low">低</option>' +
        '</select>' +
        '<button class="primary-btn" id="ctodoNewSave" type="button">保存</button>' +
        '<button class="ghost-btn" id="ctodoNewCancel" type="button">取消</button>';
      box.insertBefore(form, box.firstChild);
      $('ctodoNewText').focus();
      $('ctodoNewCancel').addEventListener('click', function () { form.remove(); });
      $('ctodoNewSave').addEventListener('click', function () {
        var text = $('ctodoNewText').value.trim();
        if (!text) { toast('原文不能为空'); return; }
        api('req/add', {
          text: text, title: $('ctodoNewTitle').value.trim() || null,
          priority: $('ctodoNewPrio').value, nodeId: selectedNode || null,
        }).then(function () { return loadOverview(); })
          .then(function () { toast('需求已录入'); })
          .catch(function (err) { toast('录入失败：' + err.message); });
      });
    });

    // 树节点点击 + 子标签点击（事件委托）
    $('ctodoTree').addEventListener('click', function (e) {
      var row = e.target.closest('[data-node]');
      if (!row) return;
      selectedNode = row.getAttribute('data-node') || null;
      Array.prototype.forEach.call(this.querySelectorAll('.ctodo-trow'), function (r) {
        r.classList.toggle('is-sel', r === row);
      });
      var tree = window.__ctodoTree;
      renderReqList(tree);
    });
    $('ctodoReqList').addEventListener('click', function (e) {
      var sub = e.target.closest('[data-sub]');
      if (sub) {
        subTab = sub.getAttribute('data-sub');
        renderReqList(window.__ctodoTree);
        return;
      }
      var btn = e.target.closest('[data-op]');
      if (!btn) return;
      handleOp(btn.getAttribute('data-op'), btn.getAttribute('data-id'), btn);
    });

    // 状态流转操作
    async function handleOp(op, id, btn) {
      var req = findReq(window.__ctodoTree, id);
      var v = req ? req.version : undefined;
      var case1, case2;
      switch (op) {
        case 'complete':
          case1 = await askPrompt('完成改动位置 / 说明（可空）：', req && req.summary ? req.summary : '');
          if (case1 === null) return;
          api('req/complete', { id: id, version: v, reason: case1, time: Date.now() })
            .then(done).catch(fail);
          break;
        case 'confirm-ai':
          api('req/confirm-ai', { id: id, version: v }).then(done).catch(fail);
          break;
        case 'status':
          api('req/status', { id: id, status: btn.getAttribute('data-to') }).then(done).catch(fail);
          break;
        case 'reopen':
          if (!await askConfirm('重新打开不可撤回，确定？')) return;
          api('req/reopen', { id: id }).then(done).catch(fail);
          break;
        case 'mark-wrong':
          case1 = await askPrompt('改写后的正确原文：', req ? req.text : '');
          if (!case1 || !case1.trim()) return;
          case2 = await askPrompt('标错原因（可空）：', '');
          api('req/mark-wrong', { id: id, text: case1.trim(), reason: case2 || '' }).then(done).catch(fail);
          break;
        case 'ai-confirm':
          api('req/ai-confirm', { id: id }).then(done).catch(fail);
          break;
        case 'ai-cleanup':
          if (!await askConfirm('永久清理这条 AI新增（不进失效、不可恢复），确定？')) return;
          api('req/ai-cleanup', { id: id, reason: '客户端清理' }).then(done).catch(fail);
          break;
        case 'supplement':
          case1 = await askPrompt('补充内容（追加，不改原文）：');
          if (!case1 || !case1.trim()) return;
          api('req/supplement', { id: id, text: case1.trim() }).then(done).catch(fail);
          break;
        case 'archive':
          if (!await askConfirm('归档这条需求？归档后可从恢复入口还原。')) return;
          api('req/archive', { id: id }).then(done).catch(fail);
          break;
        default: return;
      }
      function done() { loadOverview().then(function () { toast('已更新'); }).catch(function () {}); }
      function fail(err) { toast('操作失败：' + err.message); }
    }

    // 同步待办 + 看 C_TODO.md
    $('ctodoSyncBtn').addEventListener('click', function () {
      api('sync', { node: selectedNode || null })
        .then(function (r) {
          toast('已生成 C_TODO.md：用户待办 ' + r.userCount + ' 条 · AI待办 ' + r.aiCount + ' 条' +
            (r.pending ? ' · 有 ' + r.pending + ' 条报告未处理' : '') +
            (r.notes && r.notes.length ? ' · ' + r.notes.join('；') : ''));
          return showTodo();
        })
        .catch(function (err) { toast('同步失败：' + err.message); });
    });
    $('ctodoShowTodoBtn').addEventListener('click', function () {
      showTodo().catch(function (err) { toast('读取失败：' + err.message); });
    });
    $('ctodoTodoCloseBtn').addEventListener('click', function () { $('ctodoTodo').hidden = true; });

    function showTodo() {
      return api('todo-md').then(function (r) {
        var box = $('ctodoTodo');
        box.hidden = false;
        $('ctodoTodoText').textContent = r.md || '（还没有生成，点「同步待办」）';
      });
    }
  });

  function findReq(tree, id) {
    if (!tree) return null;
    var all = [];
    function collect(list) { if (list) all = all.concat(list); }
    if (tree.root) {
      collect(tree.root.todo);
      collect(tree.root.invalid);
    }
    (tree.nodes || []).forEach(function (n) {
      collect(n.groups.todo);
      collect(n.groups.invalid);
      ['user', 'ai', 'aiNew'].forEach(function (k) { collect(n.groups.done[k]); });
    });
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
})();
