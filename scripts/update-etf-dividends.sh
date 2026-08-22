#!/bin/bash
# scripts/update-etf-dividends.sh — 本机定时更新 ETF 分红数据并推送（cron 用）
cd ~/Documents/deepseek/repo || exit 1
node scripts/fetch-etf-dividends.js || exit 1
if git diff --quiet data/etf-dividends.json; then
  echo "$(date '+%Y-%m-%d %H:%M') 无变更"
else
  git add data/etf-dividends.json
  git commit -m "chore: 更新 ETF 分红数据 $(date +%Y-%m-%d)"
  git push origin main
  echo "$(date '+%Y-%m-%d %H:%M') 已更新并推送"
fi
