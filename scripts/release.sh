#!/bin/bash
# scripts/release.sh — 发布流程（v1.8.7 大师 P0-2：版本号机械防漏）
# 用法：./scripts/release.sh [版本号]
#  - 不传版本号：读 git describe --tags 或 last commit 短 hash 自动生成
#  - 自动更新 index.html 的 APP_VERSION + 日期（主人两次抓版本号漏更新）
#  - 跑 e2e 浏览器实测（test/e2e-browser.js），全绿才提交推送
set -e
cd "$(dirname "$0")/.."

# 1. 版本号（参数优先，否则 git 推断）
if [ -n "$1" ]; then
  VER="$1"
else
  TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  if [ -n "$TAG" ]; then
    VER="$TAG"
  else
    VER="v$(git log -1 --format=%h)"
  fi
fi
TODAY=$(date +%Y-%m-%d)
echo "==> 发布版本: $VER ($TODAY)"

# 2. 同步 APP_VERSION + 日期（防漏：主人两次抓页面版本号旧）
python3 - "$VER" "$TODAY" <<'PY'
import re, sys
ver, today = sys.argv[1], sys.argv[2]
p = 'index.html'
s = open(p).read()
s2 = re.sub(r"const APP_VERSION = '[^']*';", f"const APP_VERSION = '{ver}';", s)
s2 = re.sub(r"APP_VERSION \+ ' · [0-9-]+ ·", f"APP_VERSION + ' · {today} ·", s2)
if s2 == s:
    print('!! 版本号未找到匹配（检查 index.html APP_VERSION 格式）'); sys.exit(1)
open(p, 'w').write(s2)
print(f'==> index.html 版本号已更新: {ver} · {today}')
PY

# 3. 语法检查
node --check data-layer.js
node --check views.js
echo "==> 语法 OK"

# 4. e2e 浏览器实测（大师 P0-3：发布前必过；失败即中止）
if command -v node >/dev/null && [ -f test/e2e-browser.js ]; then
  echo "==> e2e 浏览器实测…"
  node test/e2e-browser.js || { echo "!! e2e 失败，中止发布"; exit 1; }
fi

# 5. 提交 + 推送
git add index.html data-layer.js views.js
git commit -m "$VER: 发布（版本号由 scripts/release.sh 自动同步）" 2>/dev/null || echo "(无变更可提交)"
git push origin main
echo "==> 已推送 $VER"
