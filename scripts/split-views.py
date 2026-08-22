#!/usr/bin/env python3
"""scripts/split-views.py — views.js 拆 5 模块（v3.10+ 接手 AI）
原理：去掉 IIFE 外壳（L53/L6430）+ 删除与 index.html 重复的 const 声明，
函数/模块级变量变全局作用域，按 core→home→diag→compare→pfbt 顺序 <script> 加载，
跨文件函数调用不受影响（同一全局作用域）。
用法：python3 scripts/split-views.py   （在 repo 根目录运行，幂等）
"""
import re, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'views.js')
lines = open(SRC, encoding='utf-8').read().split('\n')

# 1. 校验外壳
assert lines[52].strip() == '(function () {', f'L53 不是 IIFE 开头: {lines[52]}'
assert lines[6429].strip() == '})();', f'L6430 不是 IIFE 结尾: {lines[6429]}'

# 2. 删除外壳 + 重复声明（L53-56）
head = lines[:52]                       # L1-52（IIFE 外公共函数）
body = lines[53:6429]                   # L57-6429（原 IIFE 内部，含 L54-56 重复声明）
# 删除 L54-56 的 const DL/$/fmt/fmtPct（index.html 已有全局 fmt/$，DL 是 window 属性）
body2 = []
skipped = 0
for i, ln in enumerate(body):
    if i < 3 and re.match(r"^  const (DL = window\.DL|\$ = DL\.\$|fmt = DL\.fmt)", ln):
        skipped += 1
        continue
    body2.append(ln)
assert skipped == 3, f'重复声明删除数量不对: {skipped}'

# 3. 按区域切分（原始行号偏移：body2 第 0 行 = 原 L57）
#    core:    原 L57-161   → body2[0:105]
#    home:    原 L162-1400 → body2[105:1344]
#    diag:    原 L1401-2822→ body2[1344:2766]
#    compare: 原 L2823-3870→ body2[2766:3814]
#    pfbt:    原 L3871-6429→ body2[3814:]
SEGS = [
    ('views-core.js',     '核心/动效/导航/全局状态（switchTab/homeState）', 0, 105),
    ('views-home.js',     '决策台（今日简报/机会地图/自选/日历/扫描/发现器）', 105, 1344),
    ('views-diag.js',     '诊断页（结论层/依据层/研究层/决策日志）', 1344, 2766),
    ('views-compare.js',  '对比页+参数中心+同步包+术语表', 2766, 3814),
    ('views-pfbt.js',     '组合驾驶舱+持仓+组合编辑器', 3814, None),
]
HEADER = "/* ============================================================\n * {name} — views.js 拆分模块 {desc}\n * 生成：scripts/split-views.py（v3.10+ 接手 AI）\n * 加载顺序：views-core → views-home → views-diag → views-compare → views-pfbt\n * 全局作用域共享（去 IIFE），勿在此文件内重复声明 DL/$/fmt\n * ============================================================ */\n"

out = {}
for fname, desc, a, b in SEGS:
    chunk = body2[a:b if b is not None else len(body2)]
    content = HEADER.format(name=fname, desc=desc) + '\n'.join(head) + '\n' + '\n'.join(chunk) + '\n'
    # 每个模块都带 head（L1-52 公共函数 fitLegendTop 等，重复声明在全局会报错！）→ 只 core 带 head
    if fname != 'views-core.js':
        content = HEADER.format(name=fname, desc=desc) + '\n'.join(chunk) + '\n'
    out[fname] = content

# 4. 写文件
for fname, content in out.items():
    p = os.path.join(ROOT, fname)
    open(p, 'w', encoding='utf-8').write(content)
    print('写入', fname, len(content.split('\n')), '行')

# 5. 语法检查
for fname in out:
    r = subprocess.run(['node', '--check', os.path.join(ROOT, fname)], capture_output=True, text=True)
    if r.returncode != 0:
        print(f'❌ {fname} 语法错误:', r.stderr[:400])
        sys.exit(1)
print('✅ 全部语法 OK')

# 6. 检查跨文件重名 const/let 冲突（简单扫描）
names = {}
for fname in out:
    for m in re.finditer(r'^(?:const|let)\s+(\w+)\s*=', out[fname], re.M):
        n = m.group(1)
        names.setdefault(n, []).append(fname)
dup = {n: fs for n, fs in names.items() if len(set(fs)) > 1 and n not in ('_retryCool',)}
if dup:
    print('⚠️ 跨文件重名声明（需人工确认，可能冲突）:', {k: list(set(v)) for k, v in dup.items()})
else:
    print('✅ 无跨文件重名 const/let')
