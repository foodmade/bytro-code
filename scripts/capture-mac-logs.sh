#!/usr/bin/env bash
# capture-mac-logs.sh
#
# 启动 Bytro Community Edition 并把日志全部重定向到桌面,用于排查安装包问题
# (安装包不能直接打开 DevTools,所以只能靠落盘日志)。
#
# 同时捕获两份:
#   1) 应用进程的 stdout/stderr(Rust 后端 println! / eprintln!,以及从
#      Terminal 启动时 WKWebView 透出的部分日志)
#   2) macOS 统一日志系统(unified logging)中跟 Bytro 相关的内容,
#      作为前端 console.* 的兜底来源
#
# 用法:
#   bash scripts/capture-mac-logs.sh
#   bash scripts/capture-mac-logs.sh "/path/to/Bytro Community Edition.app"
#   bash scripts/capture-mac-logs.sh --filter split-drag   # 实时只显示带过滤词的行(原始日志仍完整落盘)
#
# 步骤:
#   1) 终端运行此脚本(它会启动 Bytro Community Edition 并开始抓取)
#   2) 在应用窗口里复现问题(例如:拖拽会话尝试分屏)
#   3) 复现完成后回到此终端按 Ctrl+C 结束
#   4) 桌面会得到两份 log 文件,打包发给开发者即可

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[error] 此脚本仅支持 macOS" >&2
  exit 1
fi

# ───────────────────────────────────────────────
# 解析参数
# ───────────────────────────────────────────────
APP_PATH=""
FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter)
      FILTER="${2:-}"
      if [[ -z "$FILTER" ]]; then
        echo "[error] --filter 需要参数,例如:--filter split-drag" >&2
        exit 1
      fi
      shift 2
      ;;
    --filter=*)
      FILTER="${1#--filter=}"
      shift
      ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      if [[ -z "$APP_PATH" ]]; then
        APP_PATH="$1"
      else
        echo "[error] 未知参数: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

# ───────────────────────────────────────────────
# 定位 Bytro Community Edition.app
# ───────────────────────────────────────────────
if [[ -z "$APP_PATH" ]]; then
  for candidate in \
    "/Applications/Bytro Community Edition.app" \
    "$HOME/Applications/Bytro Community Edition.app" \
    "/Volumes/Bytro Community Edition/Bytro Community Edition.app"; do
    if [[ -d "$candidate" ]]; then
      APP_PATH="$candidate"
      break
    fi
  done
fi

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  cat >&2 <<EOF
[error] 找不到 Bytro Community Edition.app

请将应用拖到 /Applications,或者把路径作为参数传入:
  bash $(basename "$0") "/path/to/Bytro Community Edition.app"
EOF
  exit 1
fi

# Tauri 的可执行文件名取自 Cargo.toml 的 package.name
# (本项目是 "bytro-community"),
# 不是 productName。进程名同理。
BIN_NAME="bytro-community"
BIN="$APP_PATH/Contents/MacOS/$BIN_NAME"
if [[ ! -x "$BIN" ]]; then
  echo "[error] 主程序不存在或不可执行: $BIN" >&2
  exit 1
fi

# ───────────────────────────────────────────────
# 准备日志文件
# ───────────────────────────────────────────────
DESKTOP="$HOME/Desktop"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
APP_LOG="$DESKTOP/bytro-community-app-$TIMESTAMP.log"
SYS_LOG="$DESKTOP/bytro-community-syslog-$TIMESTAMP.log"

# ───────────────────────────────────────────────
# 杀掉已在运行的实例,避免日志混淆
# ───────────────────────────────────────────────
if pgrep -x "$BIN_NAME" >/dev/null 2>&1; then
  echo "[info] 检测到 Bytro Community Edition 已在运行,先退出旧实例..."
  pkill -x "$BIN_NAME" || true
  sleep 1
  # 还在跑就强杀
  if pgrep -x "$BIN_NAME" >/dev/null 2>&1; then
    pkill -9 -x "$BIN_NAME" || true
    sleep 1
  fi
fi

cat <<EOF
═══════════════════════════════════════════════
Bytro Community Edition 日志捕获
═══════════════════════════════════════════════

  应用路径:    $APP_PATH
  二进制:      $BIN
  应用日志:    $APP_LOG
  系统日志:    $SYS_LOG
$(if [[ -n "$FILTER" ]]; then echo "  实时过滤:    $FILTER"; fi)

操作步骤:
  1) 应用启动后,在窗口内复现问题
     (例如:拖拽左侧会话到聊天区试图分屏)
  2) 复现完后回到此终端,按 Ctrl+C 结束抓取
  3) 桌面会得到两份 .log 文件,打包发给开发者

═══════════════════════════════════════════════

EOF

# ───────────────────────────────────────────────
# 后台启动 log stream(macOS unified logging)
# 抓 bytro 进程及其 .app 路径下子进程(WebContent 等)的所有日志
# ───────────────────────────────────────────────
log stream \
  --predicate "process == \"$BIN_NAME\" OR processImagePath CONTAINS \"Bytro Community Edition.app\"" \
  --level info \
  --style compact \
  >"$SYS_LOG" 2>&1 &
SYSLOG_PID=$!

# ───────────────────────────────────────────────
# 退出清理
# ───────────────────────────────────────────────
on_exit() {
  echo ""
  echo "停止抓取..."
  if kill -0 "$SYSLOG_PID" 2>/dev/null; then
    kill "$SYSLOG_PID" 2>/dev/null || true
    wait "$SYSLOG_PID" 2>/dev/null || true
  fi
  # 顺手退出应用,避免后台残留
  if pgrep -x "$BIN_NAME" >/dev/null 2>&1; then
    pkill -x "$BIN_NAME" 2>/dev/null || true
  fi
  echo ""
  echo "✅ 日志已保存到桌面:"
  echo "   $APP_LOG"
  echo "   $SYS_LOG"
  echo ""
  if [[ -n "$FILTER" ]]; then
    echo "查看过滤后的内容:"
    echo "   grep -E '$FILTER' \"$APP_LOG\" \"$SYS_LOG\""
  else
    echo "查看分屏拖拽相关日志(可改关键字):"
    echo "   grep 'split-drag' \"$APP_LOG\" \"$SYS_LOG\""
  fi
}
trap on_exit EXIT INT TERM

# ───────────────────────────────────────────────
# 前台启动二进制,捕获 stdout+stderr
# 直接 exec .app/Contents/MacOS/bytro-community(而不是 `open` 应用包),
# 这样 Rust 后端的 println!/eprintln! 会落到 tee 的输入,被写进日志。
# ───────────────────────────────────────────────
echo "[启动] $BIN"
echo "(应用窗口出现后即可开始操作;按 Ctrl+C 或关闭窗口结束抓取)"
echo ""

if [[ -n "$FILTER" ]]; then
  # 实时按过滤词高亮显示,但完整内容仍写入 APP_LOG
  "$BIN" 2>&1 | tee "$APP_LOG" | grep --line-buffered -E "$FILTER" || true
else
  "$BIN" 2>&1 | tee "$APP_LOG"
fi
