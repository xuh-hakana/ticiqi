'use strict';
/**
 * 【已完成区】· 界面层
 *
 * 这是干什么的：点分组栏的「已完成区」按钮，列出 AI 每轮同步进来的记录。
 * 有她原话 → 三字段（我记的 / 她原话 / 对应文件哪几行）；没有她原话 → 「AI已完成」两段式
 * （我记的 / 对应文件哪几行），她 2026-11-09 定。可按规矩 / 名词 / AI已完成过滤，能在访达里打开数据文件。
 * 她「只认客户端」：数据必须在这里能看，不能只躺在文件里。
 *
 * 沿用 issues.js 的独立脚本写法与现成 issue-* 样式，不碰 app.js、不新建 CSS。
 * CSP 是 script-src 'self'，所以必须是同源外部脚本，内联脚本不执行。
 */
(function () {
  var KIND = { rule: '规矩', noun: '名词', ai: 'AI已完成' };
  var filter = 'all';

  // 大分区（主人 2026-11-18 逐字原文 117 行）：workbuddy / xuhbot / 提词器 / 命令方块 /
  // seach（她原拼写照留）/ 两个消耗。项目归属从每条记录的 files 路径自动推断，一条可属多个项目
  // （重叠项目，如「提词器↔命令方块」「workbuddy规则↔其他任务指向」）→ 合并看时任一命中即显示。
  var PROJECTS = [
    { key: 'workbuddy', label: 'workbuddy', test: /workbuddy/i },
    // xuhbot：带前缀的路径 + 早期记录里的裸文件名/内部相对路径（机器人主程就是这些文件）
    { key: 'xuhbot', label: 'xuhbot', test: /(^|[\s\/])xuhbot(\/|\s|$)|(^|[\s\/])(qq|core|app|panel|memory|bot-out|soul)\.(js|log|css)|(^|[\s\/])src\/(data|connectors|scripts|memory|config|server|soul|docs)\//i },
    { key: 'ticiqi', label: '提词器', test: /(^|\/)(ticiqi|ticiqi-app)(\/|$)|提词器/i },
    { key: 'cmd', label: '命令方块', test: /命令方块|commandblock/i },
    { key: 'search', label: 'seach', test: /(^|\/)(search|seach)(\/|$)/i },
    { key: 'cost', label: '两个消耗', test: /消耗|消耗记录|消耗统计/i }
  ];
  // 当前选中的项目 key 集合：空 = 看全部；多个 = 合并看。
  var projectSel = Object.create(null);
  var allItems = [];

  function itemProjects(it) {
    var s = (it.files || []).join(' ') + ' ' + (it.evidence || []).join(' ');
    var hits = PROJECTS.filter(function (p) { return p.test.test(s); }).map(function (p) { return p.key; });
    return hits.length ? hits : ['__other__']; // 无可判定归属的归入「其它」
  }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('recordsToast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
    el.onclick = function () { el.hidden = true; };
  }

  function render(data) {
    allItems = data.items || [];
    var stats = $('recordsStats');
    if (stats) stats.textContent = '共 ' + data.total + ' 条 · 规矩 ' +
      (data.counts.rule || 0) + ' · 名词 ' + (data.counts.noun || 0) +
      ' · AI已完成 ' + (data.counts.ai || 0);
    var pathEl = $('recordsPath');
    if (pathEl) pathEl.textContent = '数据落点：' + (data.jsonl || '') +
      '（索引与详情由代码生成，勿手改）';
    renderProjectNav();
    renderList();
  }

  // 单一数据源：一张卡片怎么渲染，只在这里写一次
  function cardHtml(it) {
    return '<article class="issue-card">' +
      '<header class="issue-card-head">' +
        '<span class="issue-id">' + esc(it.id) + '</span>' +
        '<span class="issue-status">' + esc(KIND[it.kind] || it.kind) + ' · ' + esc(it.time) + '</span>' +
      '</header>' +
      '<h3>' + esc(it.summary) + '</h3>' +
      '<p class="issue-source"><strong>我记的：</strong>' + esc(it.mine) + '</p>' +
      (it.shape === 'two' || !it.quote ? '' :
        '<p class="issue-source"><strong>她原话：</strong>' + esc(it.quote) + '</p>') +
      '<p class="issue-files"><strong>对应文件（哪几行）：</strong>' +
        esc((it.evidence || []).join('、') || '（无）') + '</p>' +
      '<p class="issue-note">详情：' + esc(it.detailFile) + ' · ' + esc(it.reason) + '</p>' +
    '</article>';
  }

  // 按「项目 + 状态」双条件过滤后重绘列表（看全部=项目空集）
  function renderList() {
    var list = $('recordsList');
    if (!list) return;
    var selKeys = Object.keys(projectSel);
    var items = allItems.filter(function (it) {
      if (filter !== 'all' && it.kind !== filter) return false;
      if (!selKeys.length) return true;                       // 看全部
      var ips = itemProjects(it);
      return selKeys.some(function (k) { return ips.indexOf(k) >= 0; }); // 单看/合并看
    });
    list.innerHTML = items.length
      ? items.map(cardHtml).join('')
      : '<p class="issue-empty">暂无记录（当前项目/状态筛选下）。</p>';
  }

  function renderProjectNav() {
    var box = $('recordsProjects');
    if (!box) return;
    var selKeys = Object.keys(projectSel);
    // 每个项目的条数（按 files 推断，多归属条目在各项目都计数）
    function countFor(key) {
      return allItems.filter(function (it) { return itemProjects(it).indexOf(key) >= 0; }).length;
    }
    var html = '<span class="tc-projnav-label" style="font-size:11px;color:var(--muted,#6E788B);">项目</span>';
    html += '<button class="ghost-btn tc-proj-chip' + (!selKeys.length ? ' is-active' : '') +
      '" type="button" data-proj="__all__">看全部 ' + allItems.length + '</button>';
    PROJECTS.forEach(function (p) {
      var n = countFor(p.key);
      if (!n) return; // 没条目的项目不显示chip，保持干净
      html += '<button class="ghost-btn tc-proj-chip' + (projectSel[p.key] ? ' is-active' : '') +
        '" type="button" data-proj="' + p.key + '">' + esc(p.label) + ' ' + n + '</button>';
    });
    // 「其它」：无项目归属的条目，避免它们在选择单项目时消失
    var otherN = countFor('__other__');
    if (otherN) html += '<button class="ghost-btn tc-proj-chip' + (projectSel['__other__'] ? ' is-active' : '') +
      '" type="button" data-proj="__other__">其它 ' + otherN + '</button>';
    html += '<span style="font-size:11px;color:var(--muted,#6E788B);margin-left:4px;">可多选合并看 · 再点取消</span>';
    box.innerHTML = html;
  }

  function fetchRecords() {
    return fetch('/api/records').then(function (r) { return r.json(); });
  }

  function reload() {
    return fetchRecords().then(render);
  }

  // 主视图第一屏分组（她 2026-11-18 逐字原文 111-117，前几轮我全漏了）：
  //   ① 状态可切换 + 看全部（规矩/名词/AI已完成/全部）；
  //   ② 按项目大分区分开看，重叠项目可多选合并看、可单看（workbuddy/xuhbot/提词器/命令方块/seach/两个消耗）；
  //   ③ 结果直接画在主视图里的 #tcMainRules，不再点了就弹弹层。
  function mountMainProjectNav() {
    var box = $('tcMainProjNav');
    if (!box) return;
    function countFor(key) {
      return allItems.filter(function (it) { return itemProjects(it).indexOf(key) >= 0; }).length;
    }
    function countKind(k) {
      return k === 'all' ? allItems.length : allItems.filter(function (it) { return it.kind === k; }).length;
    }
    function paint() {
      // 保留两块固定 label，其余动态重建
      var keep = box.querySelectorAll('.tc-mainprojnav-label,.tc-mainprojnav-hint');
      Array.prototype.forEach.call(box.querySelectorAll('button,.tc-mainprojnav-sep'), function (n) { n.remove(); });
      var hint = box.querySelector('.tc-mainprojnav-hint');
      function chip(cls, key, label, n, attr) {
        var b = document.createElement('button');
        b.className = 'ghost-btn tc-proj-chip ' + cls + ((attr === 'proj' ? (!Object.keys(projectSel).length && key === '__all__') || (key !== '__all__' && projectSel[key]) : (attr === 'kind' && filter === key)) ? ' is-active' : '');
        b.type = 'button';
        b.setAttribute(attr === 'kind' ? 'data-kind' : 'data-proj', key);
        b.textContent = label + ' ' + n;
        box.insertBefore(b, hint);
        return b;
      }
      // 状态组（第一组）：看全部/规矩/名词/AI已完成
      chip('tc-kind-chip', 'all', '全部状态', countKind('all'), 'kind');
      Object.keys(KIND).forEach(function (k) { chip('tc-kind-chip', k, KIND[k], countKind(k), 'kind'); });
      var sep = document.createElement('span');
      sep.className = 'tc-mainprojnav-sep';
      sep.textContent = '│';
      box.insertBefore(sep, hint);
      // 项目组（第二组）
      chip('tc-proj-chip', '__all__', '全部项目', allItems.length, 'proj');
      PROJECTS.forEach(function (p) { var n = countFor(p.key); if (n) chip('tc-proj-chip', p.key, p.label, n, 'proj'); });
      var on = countFor('__other__');
      if (on) chip('tc-proj-chip', '__other__', '其它', on, 'proj');
      paintMainRules();
    }

    // 把筛选结果直接画进主视图（不是弹层）
    function paintMainRules() {
      var list = $('tcMainRules');
      if (!list) return;
      var selKeys = Object.keys(projectSel);
      var items = allItems.filter(function (it) {
        if (filter !== 'all' && it.kind !== filter) return false;
        if (!selKeys.length) return true;
        var ips = itemProjects(it);
        return selKeys.some(function (k) { return ips.indexOf(k) >= 0; });
      });
      list.innerHTML = items.length
        ? '<div class="tc-mainrules-count">显示 ' + items.length + ' / ' + allItems.length + ' 条规则</div>' + items.map(cardHtml).join('')
        : '<p class="issue-empty">当前状态/项目筛选下暂无规则。</p>';
    }

    box.addEventListener('click', function (e) {
      var kc = e.target.closest('[data-kind]');
      if (kc) {
        filter = kc.getAttribute('data-kind');
        Array.prototype.forEach.call(box.querySelectorAll('[data-kind]'), function (b) { b.classList.toggle('is-active', b === kc); });
        paintMainRules();
        return;
      }
      var pc = e.target.closest('[data-proj]');
      if (!pc) return;
      var key = pc.getAttribute('data-proj');
      if (key === '__all__') projectSel = Object.create(null);
      else if (projectSel[key]) delete projectSel[key];
      else projectSel[key] = true;
      renderProjectNav(); // 弹层里的导航同步
      renderList();       // 弹层列表同步
      paintMainRules();   // 主视图直接更新
      paint();
    });

    // 数据加载完成后渲染
    return fetchRecords().then(function (data) { allItems = data.items || []; paint(); }).catch(function () {});
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  ready(function () {
    var btn = $('tcDoneBtn');
    var overlay = $('recordsOverlay');
    // 主页面项目分区导航独立挂载（不依赖已完成区按钮是否存在）
    mountMainProjectNav();
    if (!btn || !overlay) return;

    btn.addEventListener('click', function () {
      overlay.hidden = false;
      reload().catch(function () { toast('读不到已完成区索引'); });
    });
    var close = $('recordsCloseBtn');
    if (close) close.addEventListener('click', function () { overlay.hidden = true; });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.hidden = true;
    });

    var projNav = $('recordsProjects');
    if (projNav) projNav.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-proj]');
      if (!chip) return;
      var key = chip.getAttribute('data-proj');
      if (key === '__all__') projectSel = Object.create(null);
      else if (projectSel[key]) delete projectSel[key];
      else projectSel[key] = true;
      renderProjectNav();
      renderList(); // 用已缓存数据重绘，不重新 fetch
    });

    var filters = $('recordsFilters');
    if (filters) filters.addEventListener('click', function (e) {
      var target = e.target.closest('[data-kind]');
      if (!target) return;
      filter = target.getAttribute('data-kind');
      Array.prototype.forEach.call(filters.querySelectorAll('[data-kind]'), function (b) {
        b.classList.toggle('is-active', b === target);
      });
      reload().catch(function () { toast('过滤失败'); });
    });

    var sync = $('recordsSyncBtn');
    if (sync) sync.addEventListener('click', function () {
      fetch('/api/records/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }).then(function (r) { return r.json(); }).then(function (r) {
        toast('同步完成：新增 ' + (r.added || 0) + ' 条 · 重复 ' + (r.duplicated || 0) + ' 条');
        reload();
      }).catch(function (e) { toast('同步失败：' + e.message); });
    });

    var reveal = $('recordsRevealBtn');
    if (reveal) {
      if (!(window.cbNative && window.cbNative.reveal)) { reveal.hidden = true; }
      else reveal.addEventListener('click', function () {
        window.cbNative.reveal('.ticiqi/C_DONE_INDEX.md')
          .then(function () { toast('已在访达里显示索引文件'); })
          .catch(function () { toast('打不开，路径见上方「数据落点」'); });
      });
    }

    var clBtn = $('recordsCleanupBtn');
    var clInput = $('recordsCleanupInput');
    if (clBtn && clInput) clBtn.addEventListener('click', function () {
      var v = clInput.value.trim();
      if (!v) { toast('先填要清理的 id，如 L0022'); return; }
      fetch('/api/records/cleanup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: v.split(/[\s,，]+/).filter(Boolean), reason: '客户端清理' })
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (!r.ok) { toast('清理失败：' + (r.error || '')); return; }
        toast('已清理：' + (r.ids || []).join('、'));
        reload();
      }).catch(function (e) { toast('清理失败：' + e.message); });
    });

    // 接入规则：面板上查看 + 复制（主人 2026-11-18 要求）。读现成接口，不造新接口。
    var arBtn = $('tcAccessRuleBtn');
    var arOverlay = $('accessRuleOverlay');
    var arText = $('accessRuleText');
    var arToast = $('accessRuleToast');
    function arToastMsg(msg) {
      if (!arToast) return;
      arToast.textContent = msg; arToast.hidden = false;
      setTimeout(function () { arToast.hidden = true; }, 2600);
    }
    if (arBtn && arOverlay) {
      arBtn.addEventListener('click', function () {
        arOverlay.hidden = false;
        fetch('/api/ctodo/access-rule').then(function (r) { return r.json(); })
          .then(function (j) { arText.textContent = j.text || '（接入规则为空）'; })
          .catch(function () { arText.textContent = '读不到接入规则，检查服务。'; });
      });
      var arClose = $('accessRuleCloseBtn');
      if (arClose) arClose.addEventListener('click', function () { arOverlay.hidden = true; });
      arOverlay.addEventListener('click', function (e) { if (e.target === arOverlay) arOverlay.hidden = true; });
      var arCopy = $('accessRuleCopyBtn');
      if (arCopy) arCopy.addEventListener('click', function () {
        var text = arText.textContent || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text)
            .then(function () { arToastMsg('接入规则已复制'); })
            .catch(function () { arToastMsg('复制失败，请手动选中'); });
        } else { arToastMsg('浏览器不支持自动复制，请手动选中'); }
      });
    }
  });
})();
