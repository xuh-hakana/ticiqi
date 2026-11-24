/*
 * 署名小问号（2026-11-18 主人令：提词器 / 命令方块 / search 都要标作者）。
 * 只读展示作者与许可，不改任何第三方文件、不进任何提示词。
 * 提词器 = 本项目自研（从命令方块分出） + 雨玻璃 raindrop-fx（SardineFish / MIT）。
 */
(function () {
  'use strict';
  const CREDITS = {
    tool: {
      title: '提词器 · 作者与来源',
      rows: [
        ['本项目作者', '主人（本项目自研）'],
        ['来源', '从「命令方块」分离出的独立项目'],
        ['雨夜效果', '见顶栏「雨」旁问号 — raindrop-fx / SardineFish / MIT'],
      ],
      note: '只标作者与许可，点开不影响任何功能；以上按项目实际情况填写，未引入别的第三方库。',
    },
    rain: {
      title: '雨夜玻璃 raindrop-fx',
      rows: [
        ['原作者', 'SardineFish'],
        ['版本', '1.0.8（离线 vendored）'],
        ['许可', 'MIT License — Copyright (c) 2021 SardineFish'],
        ['仓库', 'https://github.com/SardineFish/raindrop-fx'],
        ['完整许可', 'web/js/raindrop-fx.LICENSE.txt'],
      ],
      note: '用的是原版库本体，项目不改库源码；接线在 web/js/rain-night.js。',
    },
  };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function openCredit(key) {
    const c = CREDITS[key];
    if (!c) return;
    closeCredit();
    const rows = c.rows.map(([k, v]) => {
      const val = /^https?:\/\//.test(v)
        ? '<a href="' + esc(v) + '" target="_blank" rel="noopener noreferrer">' + esc(v) + '</a>'
        : esc(v);
      return '<div class="credit-row"><b>' + esc(k) + '</b><span>' + val + '</span></div>';
    }).join('');
    const veil = document.createElement('div');
    veil.className = 'credit-veil';
    veil.dataset.creditVeil = '1';
    veil.innerHTML = '<div class="credit-card" role="dialog" aria-label="' + esc(c.title) + '">'
      + '<h3>' + esc(c.title) + '</h3>'
      + '<div class="credit-sub">点开只为标明来源，不影响功能</div>'
      + rows
      + '<p class="credit-note">' + esc(c.note) + '</p>'
      + '<div class="credit-btns"><button class="credit-close" type="button" data-credit-close>关掉</button></div>'
      + '</div>';
    veil.addEventListener('click', (e) => {
      if (e.target === veil || e.target.closest('[data-credit-close]')) closeCredit();
    });
    document.body.appendChild(veil);
  }
  function closeCredit() {
    const el = document.querySelector('[data-credit-veil]');
    if (el) el.remove();
  }
  document.addEventListener('click', (e) => {
    const q = e.target.closest('[data-credit]');
    if (q) { e.preventDefault(); e.stopPropagation(); openCredit(q.dataset.credit); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCredit(); });
  window.openCredit = openCredit;
})();
