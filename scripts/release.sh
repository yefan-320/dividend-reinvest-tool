#!/bin/bash
# scripts/release.sh — 发布流程（v1.8.7 大师 P0-2：版本号机械防漏）
# 用法：./scripts/release.sh [版本号]
#  - 不传版本号：读 git describe --tags 或 last commit 短 hash 自动生成
#  - 自动更新 index.html 的 APP_VERSION + 日期（主人两次抓版本号漏更新）
#  - 跑 e2e 浏览器实测（test/e2e-browser.js），全绿才提交推送
set -e
cd "$(dirname "$0")/.."

# 1. 版本号（大师 P0-③：必传参数，禁止 git 推断——git describe 返回旧 tag 会把版本回退）
if [ -z "$1" ]; then
  echo "!! 必须传版本号：./scripts/release.sh v1.8.x"
  exit 1
fi
VER="$1"
TODAY=$(date +%Y-%m-%d)
echo "==> 发布版本: $VER ($TODAY)"

# 2. 同步 APP_VERSION + 日期 + JS 版本参数（防漏：主人两次抓页面版本号旧 + 浏览器缓存旧 JS 导致修复不生效）
python3 - "$VER" "$TODAY" <<'PY'
import re, sys
ver, today = sys.argv[1], sys.argv[2]
p = 'index.html'
s = open(p).read()
s2 = re.sub(r"const APP_VERSION = '[^']*';", f"const APP_VERSION = '{ver}';", s)
s2 = re.sub(r"APP_VERSION \+ ' · [0-9-]+ ·", f"APP_VERSION + ' · {today} ·", s2)
# cache-busting：三个本地 JS 加 ?v=版本（强制浏览器拉新，否则旧 JS 缓存让修复不生效）
s2 = re.sub(r"(src=\"(?:demo-data|data-layer|views)\.js)(\?v=[^\"]*)?\"", lambda m: m.group(1) + f"?v={ver}\"", s2)
if s2 == s:
    print(f'==> 版本号已是 {ver}（无变更，继续）')   # v1.8.11 幂等修复：重复发布不再误报退出
open(p, 'w').write(s2)
print(f'==> index.html 版本号+JS版本参数已更新: {ver} · {today}')
PY

# 3. 语法检查（v1.8.13：加 index.html 内联 JS 提取检查——HTML 里写错的 JS 语法曾多次漏网）
node --check data-layer.js
node --check views.js
python3 - <<'PY2'
import re, subprocess, sys
s = open('index.html', encoding='utf-8').read()
scripts = re.findall(r'<script>(.*?)</script>', s, re.S)
for i, sc in enumerate(scripts):
    open('/tmp/inline-%d.js' % i, 'w', encoding='utf-8').write(sc)
    r = subprocess.run(['node', '--check', '/tmp/inline-%d.js' % i])
    if r.returncode != 0:
        print('!! index.html 内联 JS 语法错误（块 %d）' % i)
        sys.exit(1)
print('==> 语法 OK（data-layer/views/index.html 内联）')
PY2

# 4. e2e 浏览器实测（大师 P0-3：发布前必过；失败即中止；EXPECT_VER=本次版本号强制比对）
if command -v node >/dev/null && [ -f test/e2e-browser.js ]; then
  echo "==> e2e 浏览器实测 R1-R7（期望版本 $VER）…"
  EXPECT_VER="$VER" node test/e2e-browser.js || { echo "!! e2e 失败，中止发布"; exit 1; }
fi
# v1.8.13：全功能实测（27 场景，修复回归全覆盖）——失败即中止发布
if [ -f test/e2e-full.js ]; then
  echo "==> e2e 全功能实测（27 场景）…"
  node test/e2e-full.js || { echo "!! e2e-full 失败，中止发布"; exit 1; }
fi
# v1.9.4：自选入口闭环实测（A/B/C 三入口+去重）——失败即中止发布
if [ -f test/e2e-v194.js ]; then
  echo "==> e2e-v194 自选入口闭环（10 断言）…"
  node test/e2e-v194.js || { echo "!! e2e-v194 失败，中止发布"; exit 1; }
fi
# v1.9.5：TTM/去平滑单测 + 口径标注 e2e——失败即中止发布
if [ -f test/unit-v195.js ]; then
  echo "==> unit-v195 TTM 窗口/去平滑（15 断言）…"
  node test/unit-v195.js || { echo "!! unit-v195 失败，中止发布"; exit 1; }
fi
if [ -f test/e2e-v195.js ]; then
  echo "==> e2e-v195 口径标注实测（6 断言）…"
  node test/e2e-v195.js || { echo "!! e2e-v195 失败，中止发布"; exit 1; }
fi
if [ -f test/e2e-v196.js ]; then
  echo "==> e2e-v196 用户视角回归（搜索框/真实输入/扫描mock/结论行/回本进度 10 断言）…"
  node test/e2e-v196.js || { echo "!! e2e-v196 失败，中止发布"; exit 1; }
fi

# 5. 提交 + 打 tag + 推送（大师 P0-③：发布必打 tag，供下次校验/回滚）
# v1.9.1 O3：发布前检查工作区是否干净（防"测完忘推"——大师基座签名红灯教训）
# v1.9.25 修复：排除三受管文件（index.html/data-layer.js/views.js）——版本号更新是脚本自己改的预期改动，否则每次发布自相矛盾中止（本次踩到）
DIRTY=$(git status --porcelain | grep -v '^??' | grep -v -E '^ M (index\.html|data-layer\.js|views\.js)$' | head -5)
if [ -n "$DIRTY" ]; then
  echo "!! 工作区有未提交改动，中止发布："
  echo "$DIRTY"
  exit 1
fi
git add index.html data-layer.js views.js
git commit -m "$VER: 发布（版本号由 scripts/release.sh 自动同步）" 2>/dev/null || echo "(无变更可提交)"
git tag "$VER" 2>/dev/null || echo "(tag 已存在)"
git push origin main --tags
# v1.9.1 O3：推送后复核签名（本地=远程）
# v1.9.2 O3 升级：从 HEAD sha 对比升级为三文件 blob sha 对比——HEAD sha 相同但文件内容不同（amend/force-push/提交不完整）也能拦住
echo "==> 推送后复核（文件级 blob sha）："
git fetch origin main >/dev/null 2>&1
FAIL=0
for f in views.js index.html data-layer.js; do
  LOCAL=$(git rev-parse HEAD:$f)
  REMOTE=$(git rev-parse origin/main:$f)
  if [ "$LOCAL" = "$REMOTE" ]; then
    echo "==> ✅ $f: 本地=远程 ($(echo $LOCAL | cut -c1-10))"
  else
    echo "!! ⚠️ $f 不一致！本地=$LOCAL 远程=$REMOTE"
    FAIL=1
  fi
done
if [ $FAIL -ne 0 ]; then
  echo "!! 文件级复核失败，发布中止"
  exit 1
fi
echo "==> ✅ 三文件 blob sha 全部一致"
echo "==> 已推送 $VER（含 tag）"
