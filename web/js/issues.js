'use strict';
/**
 * 【遗留问题】· 界面层（ticiqi 提词器独立项目）
 *
 * 这是干什么的：软件面板里的【遗留问题】入口。逐条列出要她回复的问题，
 * 她的回答由代码自动记成原始需求，她点确认才算解决；状态按状态机走。
 *
 * 必须是同源外部脚本：本地服务 CSP 是 script-src 'self'，内联脚本不执行。
 * 不修改 app.js：本模块独立挂事件，避免碰 139 KB 的主逻辑。
 */
(function () {
  var STATUS = {
    ai_todo: '【ai待办】',
    answered: '【已回答·待确认】',
    resolved: '【已解决】',
    invalidated: '【已失效】'
  };
  var LAYER = {
    ai_new: '视为【ai新增】',
    ai_promoted: '【ai转正】视为【已完成】',
    done: '【已完成】',
    invalid: '【已失效】',
    answered: '读取优先度：待办 > 本文件 > ai待办',
    ai_todo: '回答前视为【ai待办】'
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function post(url, body) {
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('issueToast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
    el.onclick = function () { el.hidden = true; };
  }

  function label(it) {
    var s = STATUS[it.status] || it.status;
    var l = LAYER[it.layer] || '';
    return esc(s) + (l ? ' <span class="issue-layer">' + esc(l) + '</span>' : '');
  }

  function render(data) {
    var badge = $('issueBadge');
    if (badge) badge.textContent = String(data.counts.ai_todo + data.counts.answered);
    var stats = $('issueStats');
    if (stats) {
      stats.textContent = '待回复 ' + data.counts.ai_todo +
        ' · 待确认 ' + data.counts.answered +
        ' · 已解决 ' + data.counts.resolved +
        ' · 已失效 ' + data.counts.invalidated +
        ' · 共 ' + data.total + ' 条';
    }
    var list = $('issueList');
    if (!list) return;
    if (!data.items.length) { list.innerHTML = '<p class="issue-empty">暂无【遗留问题】条目。</p>'; return; }
    list.innerHTML = data.items.map(function (it) {
      var canAnswer = it.status === 'ai_todo' || it.status === 'answered';
      var canConfirm = it.status === 'answered';
      var canDone = it.status === 'resolved';
      return '<article class="issue-card" data-id="' + esc(it.id) + '">' +
        '<header class="issue-card-head">' +
          '<span class="issue-id">' + esc(it.id) + '</span>' +
          '<span class="issue-status st-' + esc(it.status) + '">' + label(it) + '</span>' +
        '</header>' +
        '<h3>' + esc(it.title) + '</h3>' +
        '<p class="issue-source">来源：' + esc(it.source || '（未填）') + '</p>' +
        '<p class="issue-files">问题文件：' + esc(it.questionFile) +
          ((it.answerFiles && it.answerFiles.length) ? ' · 回答文件：' + esc(it.answerFiles.join('、')) :
          (it.answerFile ? ' · 回答文件：' + esc(it.answerFile) : ' · 回答文件：无')) + '</p>' +
        (canAnswer ?
          '<div class="issue-answer">' +
            '<textarea class="issue-input" placeholder="在这里回复；代码自动记为原始需求，需你确认" rows="3"></textarea>' +
            '<div class="issue-actions">' +
              '<button type="button" class="primary-btn" data-act="answer">记为原始需求</button>' +
              (canConfirm ? '<button type="button" class="ghost-btn" data-act="confirm">确认解决</button>' : '') +
            '</div>' +
          '</div>' : '') +
        (canDone ?
          '<div class="issue-actions">' +
            '<input class="issue-rework-note" placeholder="返工说明（可留空）">' +
            '<button type="button" class="ghost-btn" data-act="promote">标为 ai转正</button>' +
            '<button type="button" class="ghost-btn" data-act="rework">返工</button>' +
          '</div>' : '') +
        (it.supersededBy ? '<p class="issue-note">被 ' + esc(it.supersededBy) + ' 顶替，本条已失效</p>' : '') +
        (it.reworkOf ? '<p class="issue-note">返工自 ' + esc(it.reworkOf) + '</p>' : '') +
      '</article>';
    }).join('');
  }

  function reload() {
    return fetch('/api/issues').then(function (r) { return r.json(); }).then(render);
  }

  function act(card, action) {
    var id = card.getAttribute('data-id');
    var input = card.querySelector('.issue-input');
    var body = { id: id };
    if (action === 'answer') {
      body.text = input ? input.value : '';
      if (!body.text.trim()) { toast('先写回复内容'); return; }
    }
    if (action === 'rework') {
      var note = card.querySelector('.issue-rework-note');
      body.note = note ? note.value : '';
    }
    post('/api/issues/' + action, body).then(function (r) {
      if (!r.ok) { toast(r.error || '操作没成功'); return; }
      if (action === 'answer') toast('已记为原始需求：' + r.answerFile + '（待你确认）');
      else if (action === 'confirm') toast('已解决，视为【ai新增】');
      else if (action === 'promote') toast('标为【ai转正】，视为【已完成】');
      else if (action === 'rework') toast('返工完成 ' + r.completed + '；被顶替的 ' + r.invalidated + ' 变【已失效】');
      else toast('已新增');
      reload();
    }).catch(function (e) { toast('请求失败：' + e.message); });
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  ready(function () {
    var btn = $('issueEntryBtn');
    var overlay = $('issueOverlay');
    if (!btn || !overlay) return;

    btn.addEventListener('click', function () {
      overlay.hidden = false;
      reload().catch(function () { toast('读不到【遗留问题】索引'); });
    });
    var close = $('issueCloseBtn');
    if (close) close.addEventListener('click', function () { overlay.hidden = true; });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.hidden = true;
    });

    var list = $('issueList');
    if (list) list.addEventListener('click', function (e) {
      var target = e.target.closest('[data-act]');
      if (!target) return;
      var card = target.closest('.issue-card');
      if (card) act(card, target.getAttribute('data-act'));
    });

    var add = $('issueAddBtn');
    if (add) add.addEventListener('click', function () {
      var title = $('issueNewTitle').value.trim();
      if (!title) { toast('先写标题'); return; }
      post('/api/issues/add', { title: title, source: $('issueNewSource').value.trim() })
        .then(function (r) {
          if (!r.ok) { toast(r.error || '新增失败'); return; }
          $('issueNewTitle').value = '';
          $('issueNewSource').value = '';
          toast('已另开新文件：' + r.id + '.md');
          reload();
        }).catch(function (e) { toast('请求失败：' + e.message); });
    });

    var exp = $('issueExportBtn');
    if (exp) exp.addEventListener('click', function () {
      fetch('/api/issues/export').then(function (r) { return r.json(); }).then(function (r) {
        var box = $('issueExportText');
        box.value = r.text || '';
        box.hidden = false;
        var copy = $('issueCopyBtn');
        if (copy) copy.hidden = false;
        toast('已按「待办 > 回答后的文件 > ai待办」排好');
      }).catch(function (e) { toast('导出失败：' + e.message); });
    });
    var copy = $('issueCopyBtn');
    if (copy) copy.addEventListener('click', function () {
      var box = $('issueExportText');
      box.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(box.value).then(function () { toast('已复制'); });
      } else { toast('请手动复制选中的文字'); }
    });
  });
})();
