#!/bin/bash
# 提词器（ticiqi 独立项目）· macOS 备用启动脚本。主入口是双击 ../提词器.app。
# 这是干什么的：单独把提词器客户端叫起来，电脑上没有命令方块也能跑。
# 用途：在受限终端/沙箱环境下，双击 .app 若不出现窗口，用这个脚本启动；
#       它额外传了 --no-sandbox --disable-gpu，只影响本脚本这次启动。
cd "$(dirname "$0")" || exit 1
unset NODE_OPTIONS
unset ELECTRON_RUN_AS_NODE
BIN="$(cd .. && pwd)/提词器.app/Contents/MacOS/提词器"
if [ ! -x "$BIN" ]; then
  echo "找不到 提词器.app，请确认它和 app/、web/ 在同一个 ticiqi 文件夹里。"
  read -r -p "按回车关闭" _
  exit 1
fi
exec "$BIN" --no-sandbox --disable-gpu
