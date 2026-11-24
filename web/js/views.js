'use strict';
/**
 * 提词器 · 三视图就地互切（星图选星星 / 文件夹 / 文字）—— ticiqi 独立项目
 *
 * 基准：用户逐字原文 需求/用户原始需求-逐字原文.txt 第 57/59/61 行：
 *   57 树状图和文字视图可在正在改动的位置上互相切换显示，都附带可打开的文件/文件夹。
 *   59 树状图要游戏感、炫酷、像星图里选星星，外部看标题、点击看内容，不要一板一眼文件夹、不要真做树和叶。
 *   61 星图展开预览后点击变文字；文字能看父级/同级/子级并点切、可回星图、可切文件夹；三模式都显示、都能打开文件/文件夹；星图仅展开预览才显示文件/文件夹；能拖拽；背景小星星移动，要炫酷。
 *
 * 约束（她定的）：
 *   - 剪贴板「只同步最近一条」本文件不碰。
 *   - 原有功能/入口/预留位零删除；位置开发时固定，运行时不自动重排（51 行）。
 *   - 同源外部脚本（CSP script-src 'self'），不 import app.js（module 闭包）。
 *   - 与 app.js 通过 window.cbPrompter 桥接：items/get/select/open/toast/saveStar/relatives。
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;

  function bridge() { return window.cbPrompter || null; }

  function request(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 就地互切：保留选中需求 ---------------- */
  var VIEW_KEY = 'ticiqi:view';
  var VIEWS = ['text', 'star', 'folder'];
  var currentId = null;   // 当前选中的需求 id，切视图不丢（57/61 行"正在改动的位置"）

  function readView() {
    try {
      var v = localStorage.getItem(VIEW_KEY);
      return VIEWS.indexOf(v) >= 0 ? v : 'star';
    } catch (e) { return 'star'; }
  }

  function setView(name, opts) {
    if (VIEWS.indexOf(name) < 0) name = 'star';
    root.setAttribute('data-tc-mainview', name);
    try { localStorage.setItem(VIEW_KEY, name); } catch (e) { /* 无痕 */ }

    var btns = document.querySelectorAll('[data-tc-mainview-btn]');
    for (var i = 0; i < btns.length; i += 1) {
      var on = btns[i].getAttribute('data-tc-mainview-btn') === name;
      btns[i].classList.toggle('is-active', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var panes = document.querySelectorAll('[data-tc-mainview-pane]');
    for (var j = 0; j < panes.length; j += 1) {
      panes[j].hidden = panes[j].getAttribute('data-tc-mainview-pane') !== name;
    }
    hidePreview();
    if (name === 'star') renderStar();
    if (name === 'folder') renderFolder();
    if (name === 'text') renderContextNav();
    if (!opts || !opts.quiet) {
      var label = { text: '文字视图', star: '星图', folder: '文件夹视图' }[name];
      if (window.cbPrompter && window.cbPrompter.toast) window.cbPrompter.toast('已切到' + label);
    }
  }

  function rememberSelection(id) {
    if (id) currentId = id;
  }

  function selectInText(id) {
    var b = bridge();
    if (!b || !b.select) return;
    rememberSelection(id);
    b.select(id);            // app.js 选中同一条，位置不丢
    setView('text');
    renderContextNav();
  }

  /* ---------------- 父级 / 同级 / 子级（逐字原文 61 行） ---------------- */
  // 数据结构：后端 prompts.json 每条有 category/segment/star，没有显式 parent。
  // 层级按「分类 → 六段」两级推导：父级=分类节点（用同类第一条代表），同级=同 category，子级=同 category+segment。
  // 桥接 cbPrompter.relatives(id) 若存在则优先用它，保证与后端真实树一致。
  function relativesOf(id) {
    var b = bridge();
    var items = b && b.items ? b.items() : [];
    var me = items.find(function (x) { return x.id === id; });
    if (!me) return { parent: null, prev: null, next: null, child: null };
    if (b && b.relatives) {
      var r = b.relatives(id);
      if (r) return r;
    }
    var sameCat = items.filter(function (x) { return (x.category || 'todo') === (me.category || 'todo'); });
    var idx = sameCat.findIndex(function (x) { return x.id === id; });
    var children = sameCat.filter(function (x) { return (x.segment || '') === (me.segment || '') && x.id !== id; });
    return {
      parent: sameCat[0] && sameCat[0].id !== id ? sameCat[0] : null,
      prev: idx > 0 ? sameCat[idx - 1] : null,
      next: idx >= 0 && idx < sameCat.length - 1 ? sameCat[idx + 1] : null,
      child: children.length ? children[0] : null,
    };
  }

  function renderContextNav() {
    var nav = $('tcContextNav');
    if (!nav) return;
    if (!currentId) { nav.hidden = true; return; }
    var b = bridge();
    var items = b && b.items ? b.items() : [];
    var me = items.find(function (x) { return x.id === currentId; });
    if (!me) { nav.hidden = true; return; }
    var rel = relativesOf(currentId);
    nav.hidden = false;
    var cur = $('tcCtxCurrent');
    if (cur) cur.textContent = me.title || (me.text || '').slice(0, 16) || '未命名';
    // 不可用方向禁用，避免点空
    var map = { parent: rel.parent, 'sibling-prev': rel.prev, 'sibling-next': rel.next, child: rel.child };
    Object.keys(map).forEach(function (k) {
      var btn = nav.querySelector('[data-ctx="' + k + '"]');
      if (btn) btn.disabled = !map[k];
      if (btn && map[k]) btn.setAttribute('data-ctx-id', map[k].id);
    });
  }

  function bindContextNav() {
    var nav = $('tcContextNav');
    if (!nav) return;
    nav.addEventListener('click', function (e) {
      var viewBtn = e.target.closest ? e.target.closest('[data-ctx-view]') : null;
      if (viewBtn) { setView(viewBtn.getAttribute('data-ctx-view')); return; }
      var btn = e.target.closest ? e.target.closest('[data-ctx]') : null;
      if (!btn || btn.disabled) return;
      var id = btn.getAttribute('data-ctx-id');
      if (id) selectInText(id);
    });
  }

  /* ---------------- 星图：选星星（59/61 行） ---------------- */
  var star = {
    zoom: 1, tx: 0, ty: 0, ready: false, autoFitDone: false,
    panning: false, panStart: null, dragCard: null, cards: [],
  };
  var WORLD_W = 2400, WORLD_H = 1600;
  function projX(x) { return x * WORLD_W / 2; }
  function projY(y) { return y * WORLD_H / 2; }

  function applyCam() {
    var world = $('starWorld');
    if (!world) return;
    world.style.transform = 'translate(' + star.tx + 'px,' + star.ty + 'px) scale(' + star.zoom + ')';
    var z = $('starZoomText');
    if (z) z.textContent = Math.round(star.zoom * 100) + '%';
  }

  function cardColor(cat) {
    return { todo: 'amber', idea: 'purple', done: 'teal', ai: 'blue', ai_done: 'teal', invalid: 'gray' }[cat] || 'amber';
  }

  function buildStarSky() {
    var sky = $('starSky');
    if (!sky || sky.childNodes.length) return;
    var html = '';
    // 三层大小/速度不同的小星星，CSS 缓慢横向漂移，形成"背景滑动有小星星移动"
    for (var layer = 0; layer < 3; layer += 1) {
      var count = [26, 18, 10][layer];
      for (var i = 0; i < count; i += 1) {
        var x = (i * 37 + layer * 13) % 100;
        var y = (i * 53 + layer * 29) % 100;
        var sz = [1, 2, 3][layer];
        html += '<i class="sky-star sky-l' + layer + '" style="left:' + x + '%;top:' + y + '%;width:' + sz + 'px;height:' + sz + 'px"></i>';
      }
    }
    sky.innerHTML = html;
  }

  function renderStar() {
    var layer = $('starCards');
    var links = $('starLinks');
    if (!layer) return;
    buildStarSky();
    var b = bridge();
    var items = b && b.items ? b.items() : [];

    if (!b || !items.length) {
      layer.innerHTML = '<div class="star-empty">星图尚无星星 · 先在文字视图新建需求，或点剪贴板同步</div>';
      star.ready = false;
      return;
    }
    star.ready = true;

    var html = '';
    star.cards = [];
    items.forEach(function (it) {
      var p = it.star && typeof it.star.x === 'number' ? { x: it.star.x, y: it.star.y } : { x: 0, y: 0 };
      var px = projX(p.x), py = projY(p.y);
      star.cards.push({ id: it.id, x: px, y: py, cat: it.category || 'todo' });
      var title = it.title || (it.text || '').slice(0, 16) || '未命名';  // 65 行：可自设标题，也可前 16 字
      var health = it.health && typeof it.health.total === 'number' ? it.health.total : '—';
      // 外部看标题：星星节点 = 发光圆点 + 标题，不做一板一眼的矩形卡片
      html += '<div class="star-node star-c-' + esc(cardColor(it.category)) + (it.id === currentId ? ' is-selected' : '') + '"'
        + ' data-star-id="' + esc(it.id) + '" style="left:' + px + 'px;top:' + py + 'px"'
        + ' role="button" tabindex="0" title="点开看内容 · 拖动移动">'
        + '<span class="star-dot"><i></i></span>'
        + '<span class="star-node-label">' + esc(title) + '</span>'
        + '<span class="star-node-score">' + esc(health) + '</span>'
        + '</div>';
    });
    layer.innerHTML = html;

    if (links) {
      var byCat = {};
      star.cards.forEach(function (c) { (byCat[c.cat] = byCat[c.cat] || []).push(c); });
      var lines = '';
      Object.keys(byCat).forEach(function (cat) {
        var group = byCat[cat];
        for (var i = 1; i < group.length; i += 1) {
          var a = group[i - 1], c = group[i];
          lines += '<line x1="' + (a.x + 14) + '" y1="' + (a.y + 14) + '" x2="' + (c.x + 14) + '" y2="' + (c.y + 14) + '"'
            + ' class="star-line star-l-' + esc(cardColor(cat)) + '"/>';
        }
      });
      links.innerHTML = lines;
    }
    if (!star.autoFitDone) { star.autoFitDone = true; fitStar(); }
  }

  function zoomBy(factor) {
    star.zoom = Math.min(2.5, Math.max(0.25, star.zoom * factor));
    applyCam();
  }

  function fitStar() {
    if (!star.cards.length) { star.zoom = 1; star.tx = 0; star.ty = 0; applyCam(); return; }
    var stage = $('starStage');
    if (!stage) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    star.cards.forEach(function (c) {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + 170); maxY = Math.max(maxY, c.y + 60);
    });
    var w = maxX - minX, h = maxY - minY;
    var z = Math.min((stage.clientWidth - 100) / w, (stage.clientHeight - 100) / h, 1.4);
    star.zoom = Math.max(0.25, Math.min(2.5, z));
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    star.tx = -cx * star.zoom;
    star.ty = -cy * star.zoom;
    applyCam();
  }

  /* ---------------- 展开预览：星图里点星星先展开，再点进文字（61 行） ---------------- */
  function showPreview(id) {
    var b = bridge();
    var it = b && b.get ? b.get(id) : null;
    var box = $('starPreview');
    if (!box || !it) return;
    rememberSelection(id);
    var catLabel = { todo: '待办区', idea: '想法区', done: '已完成', ai: 'AI 新增', ai_done: 'AI 转正', invalid: '失效区' }[it.category || 'todo'] || (it.category || '');
    $('spCat').textContent = catLabel + (it.segment ? ' · ' + it.segment : '');
    $('spTitle').textContent = it.title || (it.text || '').slice(0, 16) || '未命名';
    $('spText').textContent = (it.text || '').slice(0, 220) + ((it.text || '').length > 220 ? '…' : '');
    // 只有展开预览才显示文件/文件夹（61 行）
    var files = it.linkedFiles || [];
    var fhtml = '';
    if (files.length) {
      files.forEach(function (f) {
        fhtml += '<button type="button" class="sp-file" data-file="' + esc(typeof f === 'string' ? f : (f.path || '')) + '">'
          + '<svg class="icon"><use href="#i-file"/></svg>' + esc(typeof f === 'string' ? f : (f.name || f.path || '')) + '</button>';
      });
    } else {
      fhtml = '<span class="sp-file-none">这条需求还没关联文件/文件夹</span>';
    }
    $('spFiles').innerHTML = '<div class="sp-files-label">关联文件 / 文件夹</div>' + fhtml;
    box.hidden = false;
    $('spOpenText').setAttribute('data-open-id', id);
  }

  function hidePreview() {
    var box = $('starPreview');
    if (box) box.hidden = true;
  }

  function bindPreview() {
    var close = $('spClose');
    if (close) close.addEventListener('click', hidePreview);
    var open = $('spOpenText');
    if (open) open.addEventListener('click', function () {
      var id = open.getAttribute('data-open-id');
      selectInText(id);    // 展开预览后点击变文字模式（61 行）
    });
    var files = $('spFiles');
    if (files) files.addEventListener('click', function (e) {
      var fb = e.target.closest ? e.target.closest('[data-file]') : null;
      if (!fb) return;
      var path = fb.getAttribute('data-file');
      if (window.cbPrompter && window.cbPrompter.openFile) window.cbPrompter.openFile(path);
      else if (window.cbPrompter && window.cbPrompter.toast) window.cbPrompter.toast('关联文件：' + path);
    });
  }

  function saveCardPos(id, px, py) {
    var b = bridge();
    if (!b || !b.get) return;
    var it = b.get(id);
    if (!it) return;
    var nx = Math.max(-1, Math.min(1, px / (WORLD_W / 2)));
    var ny = Math.max(-1, Math.min(1, py / (WORLD_H / 2)));
    if (b.saveStar) b.saveStar(id, nx, ny);
  }

  function bindStar() {
    var stage = $('starStage');
    if (stage) {
      stage.addEventListener('wheel', function (e) {
        if (!$('starPreview').hidden) return;
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      }, { passive: false });

      stage.addEventListener('pointerdown', function (e) {
        if (!$('starPreview').hidden) return;
        var node = e.target.closest ? e.target.closest('.star-node') : null;
        if (node) {
          var id = node.getAttribute('data-star-id');
          star.dragCard = {
            node: node, id: id,
            sx: e.clientX, sy: e.clientY,
            ox: parseFloat(node.style.left) || 0,
            oy: parseFloat(node.style.top) || 0,
            moved: false, k: 1 / star.zoom,
          };
          try { node.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件无活动指针，忽略 */ }
          return;
        }
        star.panning = true;
        star.panStart = { x: e.clientX, y: e.clientY, tx: star.tx, ty: star.ty };
      });

      stage.addEventListener('pointermove', function (e) {
        if (star.panning && star.panStart) {
          star.tx = star.panStart.tx + (e.clientX - star.panStart.x);
          star.ty = star.panStart.ty + (e.clientY - star.panStart.y);
          applyCam();
        } else if (star.dragCard) {
          var d = star.dragCard;
          var dx = (e.clientX - d.sx) * d.k, dy = (e.clientY - d.sy) * d.k;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          d.node.style.left = (d.ox + dx) + 'px';
          d.node.style.top = (d.oy + dy) + 'px';
        }
      });

      function endPointer() {
        if (star.dragCard) {
          var d = star.dragCard;
          if (d.moved) saveCardPos(d.id, parseFloat(d.node.style.left), parseFloat(d.node.style.top));
          else showPreview(d.id);   // 单击星星 = 展开预览，不直接进文字
          star.dragCard = null;
        }
        star.panning = false;
        star.panStart = null;
      }
      stage.addEventListener('pointerup', endPointer);
      stage.addEventListener('pointercancel', endPointer);
      stage.addEventListener('dblclick', function (e) {
        if (e.target === stage || e.target.id === 'starWorld' || e.target.id === 'starCards') fitStar();
      });
    }
    var zin = $('starZoomIn'); if (zin) zin.addEventListener('click', function () { zoomBy(1.2); });
    var zout = $('starZoomOut'); if (zout) zout.addEventListener('click', function () { zoomBy(1 / 1.2); });
    var fit = $('starFit'); if (fit) fit.addEventListener('click', fitStar);
  }

  /* ---------------- 文件夹视图：category/segment → 树（保留原能力 + 就地切回） ---------------- */
  function renderFolder() {
    var box = $('folderReqTree');
    if (!box) return;
    var b = bridge();
    var items = b && b.items ? b.items() : [];
    if (!b || !items.length) {
      box.innerHTML = '<div class="folder-empty">还没有需求 · 先在文字视图新建，或点剪贴板同步</div>';
      return;
    }
    var tree = {};
    items.forEach(function (it) {
      var cat = it.category || 'todo';
      var seg = it.segment || '未归段';
      tree[cat] = tree[cat] || {};
      tree[cat][seg] = tree[cat][seg] || [];
      tree[cat][seg].push(it);
    });
    var CAT = { todo: '待办区', idea: '想法区', done: '已完成', ai: 'AI 新增', ai_done: 'AI 转正', invalid: '失效区' };
    var html = '';
    Object.keys(tree).forEach(function (cat) {
      html += '<details class="fld-cat" open><summary>' + esc(CAT[cat] || cat)
        + ' <span class="fld-count">' + Object.keys(tree[cat]).reduce(function (s, k) { return s + tree[cat][k].length; }, 0) + '</span></summary>';
      Object.keys(tree[cat]).forEach(function (seg) {
        html += '<details class="fld-seg" open><summary>' + esc(seg) + '</summary><ul>';
        tree[cat][seg].forEach(function (it) {
          html += '<li><button type="button" class="fld-item' + (it.id === currentId ? ' is-selected' : '') + '" data-star-open="' + esc(it.id) + '">'
            + esc(it.title || (it.text || '').slice(0, 30) || '未命名') + '</button>'
            + '<button type="button" class="fld-open-file" data-open-file="' + esc((it.linkedFiles || [])[0] || '') + '" title="打开关联文件/文件夹"'
            + (it.linkedFiles && it.linkedFiles.length ? '' : ' hidden') + '>↗</button></li>';
        });
        html += '</ul></details>';
      });
      html += '</details>';
    });
    html += '<div class="fld-note">需求按分类 → 六段归位；点标题就地打开详情，点 ↗ 打开关联文件/文件夹。命令方块的文件树不在这里重复实现。</div>';
    box.innerHTML = html;
  }

  function bindFolder() {
    var box = $('folderReqTree');
    if (!box) return;
    box.addEventListener('click', function (e) {
      var fb = e.target.closest ? e.target.closest('[data-open-file]') : null;
      if (fb) {
        var p = fb.getAttribute('data-open-file');
        if (p && window.cbPrompter && window.cbPrompter.openFile) window.cbPrompter.openFile(p);
        return;
      }
      var b = e.target.closest ? e.target.closest('[data-star-open]') : null;
      if (b) selectInText(b.getAttribute('data-star-open'));
    });
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    var btns = document.querySelectorAll('[data-tc-mainview-btn]');
    for (var i = 0; i < btns.length; i += 1) {
      btns[i].addEventListener('click', function (e) {
        setView(e.currentTarget.getAttribute('data-tc-mainview-btn'));
      });
    }
    bindStar();
    bindPreview();
    bindFolder();
    bindContextNav();
    setView(readView(), { quiet: true });
  }

  // 需求库刷新后当前视图跟着更新
  window.addEventListener('ticiqi:prompts-changed', function () {
    var v = root.getAttribute('data-tc-mainview');
    if (v === 'star') renderStar();
    if (v === 'folder') renderFolder();
    renderContextNav();
  });

  // app.js 选中需求时同步"正在改动的位置"
  window.addEventListener('ticiqi:prompt-selected', function (e) {
    if (e && e.detail && e.detail.id) {
      rememberSelection(e.detail.id);
      renderContextNav();
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
