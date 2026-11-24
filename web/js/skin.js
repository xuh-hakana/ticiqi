'use strict';
/**
 * 提词器 · 皮肤 / 白天夜晚 / 功能位开关（ticiqi 独立项目，2026-11-06）
 *
 * 这是干什么的：管三件只在客户端里能看能改的小开关。
 *   1. 皮肤三选一：原样 / 深霓虹 / 赛博炫光。只改 html[data-skin]，不动任何业务逻辑。
 *   2. 白天 / 夜晚：提词器自己的顶栏按钮（原来那个在被 CSS 藏起来的命令方块顶栏里，看不到）。
 *   3. 功能位：显示 / 隐藏所有「位置已预留、功能未做」的槽位。
 *
 * 约束：
 *   - 不用 prompt / confirm / alert，弹层是自绘的 DOM。
 *   - 提示停 2.8 秒或点击才关。
 *   - 「生成本轮需求」不另写一套，直接打开已有的【遗留问题】弹层并触发它原有的导出按钮。
 *   - 只在赛博炫光下启用鼠标跟随 / 点击光圈，切走就摘掉监听，不常驻吃性能。
 *   - 本文件是同源外部脚本（本地服务 CSP 是 script-src 'self'）。
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;
  var SKIN_KEY = 'ticiqi:skin';
  var SLOTS_KEY = 'ticiqi:slots';
  var VALID = { none: 1, nocturne: 1, cybercore: 1 };

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* 无痕模式 */ } }

  /* ---------- 提示：2.8 秒或点击才关，不用 alert ---------- */
  var toastTimer = null;
  function toast(msg) {
    var el = $('tcToast');
    if (!el) return;
    el.textContent = msg + '（点击关闭）';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2800);
  }

  /* ---------- 皮肤 ---------- */
  var current = VALID[read(SKIN_KEY)] ? read(SKIN_KEY) : 'none';

  function applySkin(name, { quiet = false } = {}) {
    current = VALID[name] ? name : 'none';
    if (current === 'none') root.removeAttribute('data-skin');
    else root.setAttribute('data-skin', current);
    write(SKIN_KEY, current);
    var opts = document.querySelectorAll('.skin-option');
    for (var i = 0; i < opts.length; i += 1) {
      opts[i].classList.toggle('is-active', opts[i].getAttribute('data-skin') === current);
      opts[i].setAttribute('aria-pressed', opts[i].getAttribute('data-skin') === current ? 'true' : 'false');
    }
    var btn = $('tcSkinBtn');
    if (btn) btn.classList.toggle('is-on', current !== 'none');
    syncEffects();
    if (!quiet) {
      var label = { none: '原样（白天 / 夜晚照旧）', nocturne: '深霓虹', cybercore: '赛博炫光' }[current];
      toast('已切到：' + label);
    }
  }

  function openSkin() { var o = $('skinOverlay'); if (o) o.hidden = false; }
  function closeSkin() { var o = $('skinOverlay'); if (o) o.hidden = true; }

  /* ---------- 白天 / 夜晚（提词器顶栏自己的按钮） ---------- */
  /* 只在本次会话内切换，不落盘：打开时的主题由 boot.js 按「当下钟点」决定（她 2026-11-09 定），
     若这里还写本地键，下次打开就会有旧值把钟点覆盖掉。 */
  function applyTheme(next, { quiet = false } = {}) {
    var v = next === 'night' ? 'night' : 'day';
    root.setAttribute('data-theme', v);
    var b = $('tcThemeBtn');
    if (b) {
      b.textContent = v === 'night' ? '夜晚 · 切白天' : '白天 · 切夜晚';
      b.classList.toggle('is-on', v === 'night');
    }
    // 顺手让被隐藏的原按钮保持一致，将来若把顶栏放出来不会显示错文案
    var old = $('themeBtn');
    if (old) old.setAttribute('aria-pressed', v === 'night' ? 'true' : 'false');
    var oldText = $('themeBtnText');
    if (oldText) oldText.textContent = v === 'night' ? '白天' : '夜晚';
    if (!quiet) toast(v === 'night' ? '已切到夜晚' : '已切到白天');
  }

  /* ---------- 功能位：显示 / 隐藏所有预留槽位 ---------- */
  function applySlots(on, { quiet = false } = {}) {
    root.setAttribute('data-tc-slots', on ? 'on' : 'off');
    write(SLOTS_KEY, on ? 'on' : 'off');
    var b = $('tcSlotsBtn');
    if (b) {
      b.classList.toggle('is-on', !on);
      b.textContent = on ? '功能位' : '功能位（已隐藏）';
    }
    if (!quiet) toast(on ? '已显示所有预留位置' : '已隐藏预留位置，界面更干净');
  }

  /* ---------- 赛博炫光专属：鼠标跟随 + 点击光圈 ---------- */
  var effectsOn = false;
  var raf = 0;

  function onMove(e) {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      root.style.setProperty('--gx', e.clientX + 'px');
      root.style.setProperty('--gy', e.clientY + 'px');
      var card = e.target && e.target.closest ? e.target.closest('.prompt-card, .issue-card, .skin-option') : null;
      if (card) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - .5;
        var py = (e.clientY - r.top) / r.height - .5;
        root.style.setProperty('--mx', (px * 7).toFixed(2) + 'deg');
        root.style.setProperty('--my', (-py * 7).toFixed(2) + 'deg');
      } else {
        root.style.setProperty('--mx', '0deg');
        root.style.setProperty('--my', '0deg');
      }
    });
  }

  function onClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var btn = t.closest('button, .prompt-card, .issue-card, .skin-option');
    if (!btn || btn.disabled) return;
    var r = btn.getBoundingClientRect();
    var dot = document.createElement('i');
    dot.className = 'tc-ripple-dot';
    dot.style.left = (e.clientX - r.left) + 'px';
    dot.style.top = (e.clientY - r.top) + 'px';
    if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
    btn.appendChild(dot);
    setTimeout(function () { if (dot.parentNode) dot.parentNode.removeChild(dot); }, 600);
  }

  function syncEffects() {
    var need = current === 'cybercore';
    if (need && !effectsOn) {
      document.addEventListener('mousemove', onMove, { passive: true });
      document.addEventListener('click', onClick, true);
      effectsOn = true;
    } else if (!need && effectsOn) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('click', onClick, true);
      root.style.setProperty('--mx', '0deg');
      root.style.setProperty('--my', '0deg');
      effectsOn = false;
    }
  }

  /* ---------- 生成本轮需求：复用【遗留问题】已有的导出，不另造一套 ---------- */
  function exportRound() {
    var overlay = $('issueOverlay');
    var exp = $('issueExportBtn');
    if (!overlay || !exp) { toast('导出入口未就绪，请从【遗留问题】里点「生成本轮需求」'); return; }
    overlay.hidden = false;
    exp.click();
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    var skinBtn = $('tcSkinBtn');
    if (skinBtn) skinBtn.addEventListener('click', openSkin);
    var close = $('skinCloseBtn');
    if (close) close.addEventListener('click', closeSkin);
    var overlay = $('skinOverlay');
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSkin(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSkin(); });

    var opts = $('skinOptions');
    if (opts) opts.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.skin-option') : null;
      if (!b) return;
      applySkin(b.getAttribute('data-skin'));
      closeSkin();
    });

    var themeBtn = $('tcThemeBtn');
    if (themeBtn) themeBtn.addEventListener('click', function () {
      applyTheme(root.getAttribute('data-theme') === 'night' ? 'day' : 'night');
    });

    var slotsBtn = $('tcSlotsBtn');
    if (slotsBtn) slotsBtn.addEventListener('click', function () {
      applySlots(root.getAttribute('data-tc-slots') === 'off');
    });
    var skinSlotsBtn = $('skinSlotsBtn');
    if (skinSlotsBtn) skinSlotsBtn.addEventListener('click', function () {
      applySlots(root.getAttribute('data-tc-slots') === 'off');
    });

    var expBtn = $('tcExportBtn');
    if (expBtn) expBtn.addEventListener('click', exportRound);

    var toastEl = $('tcToast');
    if (toastEl) toastEl.addEventListener('click', function () {
      clearTimeout(toastTimer); toastEl.hidden = true;
    });

    // 首帧恢复（boot.js 已提前设好 data-skin 防闪，这里只同步 UI 状态）
    applySkin(current, { quiet: true });
    applyTheme(root.getAttribute('data-theme') === 'night' ? 'night' : 'day', { quiet: true });
    applySlots(read(SLOTS_KEY) !== 'off', { quiet: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
