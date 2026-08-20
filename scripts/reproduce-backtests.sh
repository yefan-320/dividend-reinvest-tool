#!/usr/bin/env bash
# 盲区20③：回测一键复现（脚本+缓存版本固化）
# 用法：./scripts/reproduce-backtests.sh [all|p1|p2|p4|p5|p6|p7|signal]
set -e
cd "$(dirname "$0")/.."
MODE="${1:-all}"

echo "==> 数据缓存版本: $(python3 -c "import json; print(json.load(open('data/rule-tree-cache.json')).get('_version','?'))")"
echo "==> HEAD: $(git rev-parse --short HEAD)"
echo ""

run() { echo "---- $1 ----"; shift; node "$@" || { echo "!! $1 失败"; exit 1; }; }

case "$MODE" in
  all)
    run "P1 组合模拟" test/p1-era.js
    run "P2 买入节奏" test/p2-rhythm.js
    run "P4 命门批量" test/p4-vitals.js
    run "P5 卖出窗口" test/p5-sell-window.js
    run "P6 再投验证" test/p6-reinvest.js
    run "P7 暴雷闸门" test/trap-replay.js
    run "信号有效性" test/signal-effectiveness.js
    ;;
  p1) run "P1 组合模拟" test/p1-era.js ;;
  p2) run "P2 买入节奏" test/p2-rhythm.js ;;
  p4) run "P4 命门批量" test/p4-vitals.js ;;
  p5) run "P5 卖出窗口" test/p5-sell-window.js ;;
  p6) run "P6 再投验证" test/p6-reinvest.js ;;
  p7) run "P7 暴雷闸门" test/trap-replay.js ;;
  signal) run "信号有效性" test/signal-effectiveness.js ;;
  *) echo "用法: $0 [all|p1|p2|p4|p5|p6|p7|signal]"; exit 1 ;;
esac

echo ""
echo "==> 全部完成 ✅（缓存版本+HEAD 已记录，可复现）"
