#!/bin/bash
# scripts/install-tier-refresh-launchd.sh — 决策线数据自动刷新（v3.10+ 接手 AI）
# 原理：每月 1 日 05:00 运行 scripts/extract-tier-data.js，把 data-layer.js 的硬编码决策表
# （TIER_LINE/BENCH/RULE_STATS/SIG_STATS/MAX_DD/P95_TRIGGERS/TREASURY）提取到 data/tier-data.json。
# 数据版本校验：前端启动时比对 APP_VERSION 与 JSON 的 generatedAt 相关字段（后续版本做），
# 本次先做到"定期提取 + 变更留痕 + 日志"。
# 用法：bash scripts/install-tier-refresh-launchd.sh [--uninstall]
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.divtool.tier-refresh.plist"
LABEL="com.divtool.tier-refresh"

if [ "$1" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✅ 已卸载（决策线刷新定时任务）"
  exit 0
fi

# 生成 wrapper（每月 1 日 05:00 跑 extract 脚本；脚本自身幂等：无变更不覆盖）
WRAPPER="$REPO/scripts/tier-refresh-scheduler.sh"
cat > "$WRAPPER" <<EOF
#!/bin/bash
# 决策线数据提取（幂等：与当前 data-layer.js 一致则不覆盖）
cd "$REPO" || exit 1
NODE_BIN="\$(command -v node 2>/dev/null || echo /Users/macbookpro/.local/bin/node)"
"\$NODE_BIN" scripts/extract-tier-data.js >> /tmp/divtool-tier-refresh.log 2>&1
exit \$?
EOF
chmod +x "$WRAPPER"

# 生成 plist（每月 1 日 05:00）
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${WRAPPER}</string></array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Day</key><integer>1</integer>
    <key>Hour</key><integer>5</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/tmp/divtool-tier-refresh.log</string>
  <key>StandardErrorPath</key><string>/tmp/divtool-tier-refresh.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 决策线刷新定时任务已安装：每月 1 日 05:00 提取决策表到 data/tier-data.json"
echo "   日志：/tmp/divtool-tier-refresh.log ｜ 立即测试：bash $WRAPPER"
