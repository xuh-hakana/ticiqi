'use strict';
/**
 * 命令方块 / 提词器 · preload（两个客户端共用）
 * 页面继续用 fetch('/api/*') 访问各自进程的本地服务，这里只补 Electron 才有的能力：
 * 原生文件夹选择、剪贴板、在系统文件管理器里显示文件、拖进来的文件夹真实路径。
 * 提词器不再是这个进程里开出来的网页窗口，所以没有「开独立窗口」这类桥。
 *
 * 注意：preload 执行时 documentElement 可能还不存在（沙箱下就是 null），
 * 所以所有碰 DOM 的动作都放进 whenDomReady()，否则整个 preload 会加载失败，
 * 页面连 window.cbNative 都拿不到。
 */
const electron = require('electron');
const contextBridge = electron.contextBridge;
const ipcRenderer = electron.ipcRenderer;

// webUtils 只在 Electron 30+ 有；沙箱下也未必暴露，取不到就退化成「读 dataTransfer」。
const webUtils = (() => {
  try { return electron.webUtils || null; } catch (e) { return null; }
})();

function whenDomReady(fn) {
  if (document.documentElement) { fn(); return; }
  document.addEventListener('DOMContentLoaded', fn, { once: true });
}

whenDomReady(() => {
  // 平台由主进程通过 URL 参数传入（sandbox 模式下 preload 里的 process 不可靠）。
  const platformMatch = /[?&]platform=([^&]+)/.exec(location.search);
  document.documentElement.dataset.platform = platformMatch ? decodeURIComponent(platformMatch[1]) : '';

  // 访达 / 桌面把文件夹拖进窗口时，渲染进程拿不到真实路径（Electron 32 起 file.path 已删）。
  // 在 preload 的隔离世界用 webUtils 读出路径，写进 DOM 属性再抛一个事件给页面：
  // 属性与事件都是跨世界共享的，所以 web/js/app.js 能直接读到。
  document.addEventListener('drop', (event) => {
    try {
      const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
      if (!files.length || !webUtils) return;
      for (const file of files) {
        let full = '';
        try { full = webUtils.getPathForFile(file); } catch (e) { full = ''; }
        if (!full) continue;
        document.documentElement.dataset.cbDropPath = full;
        document.dispatchEvent(new Event('cb:dropped'));
        return;
      }
    } catch (e) { /* 拿不到路径就让页面自己给提示 */ }
  }, true);
});

contextBridge.exposeInMainWorld('cbNative', {
  info: () => ipcRenderer.invoke('cb:info'),
  pickFolder: () => ipcRenderer.invoke('cb:pickFolder'),
  readClipboard: () => ipcRenderer.invoke('cb:readClipboard'),
  reveal: rel => ipcRenderer.invoke('cb:reveal', rel),
});

// 给页面一个「这条路能不能走」的标记，省得它瞎猜。
contextBridge.exposeInMainWorld('cbDropBridge', { hasPath: Boolean(webUtils) });
