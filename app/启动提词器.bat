@echo off
chcp 65001 >nul
rem 提词器（ticiqi 独立项目）· Windows 启动脚本。这是干什么的：单独启动提词器客户端窗口。
rem 与命令方块侧的联动：需求库数据共用一份；联动接口全部由命令方块侧维护。
rem Windows 没有 .app 外壳，走 npm 里的 Electron；代码是 ticiqi 自己的 app\ + web\，不读 命令方块\。
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\electron\package.json" (
  echo 首次运行，正在安装 Electron 45.2.1 ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo 安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="
start "" "node_modules\.bin\electron.cmd" prompter-main.js
exit /b 0
