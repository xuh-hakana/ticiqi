'use strict';
/**
 * 提词器（ticiqi 独立项目）· 主进程（Windows / macOS 通用）
 *
 * 这是干什么的：单独双击 ticiqi/提词器.app 就能开；电脑上没有「命令方块」也能用，
 * 本文件不读 命令方块/ 里的任何代码或路径。
 *
 * 与命令方块的分工：
 *   端口文件   port-ticiqi（独立，不覆盖命令方块的 port / port-prompter）
 *   窗口数据   ~/Library/Application Support/TiciqiPrompter（独立缓存）
 *   需求库     ~/Library/Application Support/CommandBlock（与命令方块共用同一份，
 *              这是联动功能，归命令方块侧维护；本侧不复制第二份需求库）
 *   剪贴板捕获 只在这个进程跑
 *   联动功能   /api/focus、cb:reveal 联动版、port+health、需求条目↔代码行绑定
 *              全部由命令方块侧维护，见 命令方块/docs/联动功能归属.md
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu } = require('electron');
const { createApp, defaultDataDir } = require('./backend/server');

const APP_ROOT = path.resolve(__dirname, '..');   // app/ 的上一级 = ticiqi/
const IS_MAC = process.platform === 'darwin';
const DATA_DIR = defaultDataDir();
const PORT_FILE = 'port-ticiqi';
const HOME = os.homedir();
const USER_DATA = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'TiciqiPrompter')
  : IS_MAC ? path.join(HOME, 'Library', 'Application Support', 'TiciqiPrompter')
    : path.join(HOME, '.config', 'TiciqiPrompter');
const LOG_FILE = process.platform === 'win32'
  ? path.join(DATA_DIR, '提词器.log')
  : IS_MAC ? path.join(HOME, 'Library', 'Logs', 'Ticiqi-Prompter.log')
    : path.join(USER_DATA, 'prompter.log');

// 独立缓存目录，和命令方块区分开（必须在 ready 之前设）。
app.setPath('userData', USER_DATA);

let backend = null;
let mainWin = null;
let port = 0;

function log(line) {
  const text = '[' + new Date().toISOString() + '] ' + line + '\n';
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, text); } catch (e) {}
  if (process.env.CB_VERBOSE) console.log(text.trim());
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1000,
    height: 740,
    minWidth: 720,
    minHeight: 520,
    title: '提词器',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 14, y: 16 } : undefined,
    backgroundColor: '#F3F6FB',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWin.loadURL('http://127.0.0.1:' + port + '/?app=prompter&platform=' + process.platform);
  mainWin.once('ready-to-show', () => { mainWin.show(); mainWin.focus(); log('提词器窗口已显示'); });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  return mainWin;
}

// ---------------------------------------------------------------------------
// IPC：本项目 preload 的四个能力
// ---------------------------------------------------------------------------
ipcMain.handle('cb:info', () => ({
  port,
  platform: process.platform,
  appRoot: APP_ROOT,
  version: app.getVersion(),
}));

ipcMain.handle('cb:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWin, {
    title: '选择要只读浏览的文件夹',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '打开这个文件夹',
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('cb:readClipboard', () => {
  try { return clipboard.readText() || ''; } catch (e) { return ''; }
});

// 关联文件在独立客户端里没有文件视图，点了就在系统文件管理器里定位。
ipcMain.handle('cb:reveal', (event, rel) => {
  try {
    const root = backend ? backend.repo.rootDisplay() : '';
    if (!root || !rel) return { ok: false };
    const abs = path.resolve(root, String(rel));
    if (!abs.startsWith(root + path.sep)) return { ok: false };
    shell.showItemInFolder(abs);
    return { ok: true };
  } catch (e) { return { ok: false }; }
});

// ---------------------------------------------------------------------------
// 启动：单实例也用端口文件判断，不用 Electron 的 SingletonLock（强杀会留陈旧锁）
// ---------------------------------------------------------------------------
function cbHttp(portNum, method, route) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: portNum, path: route, method },
      res => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode === 200 })); });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(900, () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

async function runningPort() {
  let p = 0;
  try { p = Number(fs.readFileSync(path.join(DATA_DIR, PORT_FILE), 'utf8').trim()) || 0; } catch (e) { return 0; }
  if (!p) return 0;
  const r = await cbHttp(p, 'GET', '/api/health');
  return r.ok ? p : 0;
}

app.whenReady().then(async () => {
  if (Menu.setApplicationMenu) Menu.setApplicationMenu(null);

  const existing = await runningPort();
  if (existing) {
    log('提词器已在运行 port=' + existing + '，本次不再开第二个窗口');
    app.quit();
    return;
  }

  try {
    backend = createApp({
      appRoot: APP_ROOT,
      webDir: path.join(APP_ROOT, 'web'),
      dataDir: DATA_DIR,
      portFile: PORT_FILE,
      enablePrompts: true,
      rootOverride: process.env.CB_ROOT || '',
      verbose: !!process.env.CB_VERBOSE,
      pickFolder: async () => {
        const result = await dialog.showOpenDialog(mainWin, {
          title: '选择要只读浏览的文件夹',
          properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
      },
      readClipboard: async () => { try { return clipboard.readText() || ''; } catch (e) { return ''; } },
    });
    port = await backend.listen(0);
    log('服务已启动 port=' + port + ' root=' + backend.repo.rootDisplay());
  } catch (e) {
    log('启动失败：' + (e && e.stack || e));
    dialog.showErrorBox('提词器启动失败', String(e && e.message || e));
    app.quit();
    return;
  }

  createMainWindow();
});

// 独立客户端关掉窗口就整个退出，不在后台常驻。
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (backend) { try { backend.close(); } catch (e) {} }
  log('提词器退出');
});
