#!/bin/bash
# =============================================================================
# install-watch-launchd.sh — 为 watch.js 安装 macOS 原生定时任务（launchd）
# -----------------------------------------------------------------------------
# 背景：watch.js 目前依赖外部 trigger（openclaw），本脚本改为 launchd 原生调度。
#
# 频率规则（主人拍板）：
#   财报季（3/4/7/8/10 月）：每天 15:30 跑
#   非财报季：每周一/三/五 15:30 跑
#
# 实现原理：
#   launchd 的 StartCalendarInterval 不支持"每月特定日 + 星期几"的复杂组合，
#   且 plist 中同名 key 只能出现一次 → 用两个 plist 条目的思路不可行。
#   正确做法：用一个 plist **每天 15:30** 触发 wrapper 脚本（watch-scheduler.sh），
#   wrapper 内部判断今天是否该跑：该跑则执行 node watch.js，不该跑则 exit 0。
#
# 本脚本生成两个文件：
#   1. ~/Library/LaunchAgents/com.divtool.watch.plist   （每天 15:30 触发 wrapper）
#   2. <repo>/scripts/watch-scheduler.sh               （日期判断 wrapper）
#
# 说明：watch.js 的 ROOT 是 __dirname/..（即 repo/），WATCH_FILE 默认在 repo 上一级
#       deepseek/watchlist.json，STATE_FILE 默认 deepseek/.state/watch-state.json，
#       均正常，不需要改 watch.js。
#
# 日志：/tmp/divtool-watch.log（追加）
#
# 卸载方法（取消定时）：
#   launchctl unload ~/Library/LaunchAgents/com.divtool.watch.plist
#   rm ~/Library/LaunchAgents/com.divtool.watch.plist
# =============================================================================

set -u   # 未定义变量即报错
# 不使用 set -e：卸载旧条目失败本就要忽略，不能让脚本因此中断

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"    # scripts/ 目录
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"       # repo/ 目录（watch.js 所在）
WRAPPER="$SCRIPT_DIR/watch-scheduler.sh"       # wrapper 脚本完整路径
PLIST_DIR="$HOME/Library/LaunchAgents"         # launchd 用户级 plist 目录
PLIST="$PLIST_DIR/com.divtool.watch.plist"     # plist 完整路径
LABEL="com.divtool.watch"                      # launchd Label（全局唯一标识）
LOG="/tmp/divtool-watch.log"                   # 日志文件（追加写）

echo "==> 安装目录      ：$REPO_DIR"
echo "==> 将生成两个文件："
echo "    plist         ：$PLIST"
echo "    wrapper       ：$WRAPPER"

# 前置检查：watch.js 必须在 repo/ 下
if [ ! -f "$REPO_DIR/watch.js" ]; then
  echo "[失败] 未找到 $REPO_DIR/watch.js，请确认脚本位于 repo/scripts/ 下" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# ① 生成 wrapper 脚本（watch-scheduler.sh）
#    判断逻辑：月份 ∈ {3,4,7,8,10} → 财报季，无条件跑；
#              否则星期 ∈ {1,3,5}（%u：1=周一 … 7=周日）→ 跑；
#              其余情况 → exit 0 跳过（0 成本）。
#    注意：launchd 环境 PATH 极简（/usr/bin:/bin），which node 通常找不到 node，
#          所以先补充常见 node 目录，并保留固定绝对路径兜底。
# ---------------------------------------------------------------------------
cat > "$WRAPPER" <<'WRAPPER_EOF'
#!/bin/bash
# watch-scheduler.sh — watch.js 日期调度 wrapper（由 install-watch-launchd.sh 生成）
# 频率规则：财报季(3/4/7/8/10月)每天 15:30；非财报季周一/三/五 15:30。
# 由 launchd 每天 15:30 触发；本脚本判断今天是否该跑，不该跑直接 exit 0。
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"    # repo/（watch.js 所在）
LOG="/tmp/divtool-watch.log"

# launchd 的 PATH 很精简，先补上常见 node 安装位置（幂等）
export PATH="/Users/macbookpro/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# node 路径：先用 which node 探测，找不到再用固定绝对路径兜底
NODE_BIN="$(command -v node 2>/dev/null || echo /Users/macbookpro/.local/bin/node)"

# 日期判断（%m = 月份 01-12；%u = 星期，1=周一 … 7=周日）
read -r MONTH DOW < <(date '+%m %u')
MONTH=$((10#$MONTH))    # 去前导 0，避免 08/09 被 shell 当八进制
DOW=$((10#$DOW))

echo "[$(date '+%Y-%m-%d %H:%M:%S')] watch-scheduler: 月份=${MONTH} 星期=${DOW}"

RUN=0
case "$MONTH" in
  3|4|7|8|10) RUN=1 ;;     # 财报季：无条件跑
esac
if [ "$RUN" -eq 0 ]; then
  case "$DOW" in
    1|3|5) RUN=1 ;;        # 非财报季：仅周一/三/五跑
  esac
fi

if [ "$RUN" -ne 1 ]; then
  echo "    今天不跑（非财报季且非周一/三/五），跳过。"
  exit 0
fi

echo "    今天该跑，执行 node watch.js ..."
cd "$REPO_DIR" && "$NODE_BIN" watch.js >> "$LOG" 2>&1
RC=$?
if [ "$RC" -eq 0 ]; then
  echo "    watch.js 完成（exit 0），日志：$LOG"
else
  echo "    watch.js 退出码 ${RC}（详见日志 ${LOG}）" >&2
fi
exit "$RC"
WRAPPER_EOF

chmod +x "$WRAPPER"
echo "[OK] 已生成 wrapper：$WRAPPER"

# ---------------------------------------------------------------------------
# ② 生成 plist（XML）：每天 15:30 触发 wrapper
# ---------------------------------------------------------------------------
mkdir -p "$PLIST_DIR"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${WRAPPER}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>15</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
PLIST_EOF

# 校验 plist 语法（plutil 为 macOS 自带工具）
if ! plutil -lint "$PLIST" >/dev/null; then
  echo "[失败] plist 语法校验未通过：$PLIST" >&2
  exit 1
fi
echo "[OK] 已生成 plist：$PLIST"

# ---------------------------------------------------------------------------
# ③ 卸载旧条目（忽略错误：可能本来就没装过）
# ---------------------------------------------------------------------------
launchctl unload "$PLIST" 2>/dev/null || true
echo "[OK] 已尝试卸载旧条目（如不存在则忽略）"

# ---------------------------------------------------------------------------
# ④ 加载新条目
# ---------------------------------------------------------------------------
if launchctl load "$PLIST" 2>/dev/null; then
  echo "[OK] 已加载新定时任务"
else
  echo "[失败] launchctl load 失败，请检查：launchctl list | grep ${LABEL}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# ⑤ 确认已生效
# ---------------------------------------------------------------------------
if launchctl list 2>/dev/null | grep -q "${LABEL}"; then
  echo "[成功] 定时任务已生效："
  launchctl list 2>/dev/null | grep "${LABEL}"
  echo ""
  echo "============================================================================"
  echo "  安装完成 ✅"
  echo "  频率：财报季(3/4/7/8/10月)每天 15:30；非财报季周一/三/五 15:30"
  echo "  日志：tail -f ${LOG}"
  echo "  手动立即跑一次：bash ${WRAPPER}"
  echo "----------------------------------------------------------------------------"
  echo "  卸载方法："
  echo "    launchctl unload ${PLIST}"
  echo "    rm ${PLIST}"
  echo "============================================================================"
  exit 0
else
  echo "[失败] 未在 launchctl 列表中找到 ${LABEL}，请手动排查：launchctl list | grep ${LABEL}" >&2
  exit 1
fi
