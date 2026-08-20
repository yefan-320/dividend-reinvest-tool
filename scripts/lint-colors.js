#!/usr/bin/env node
/* lint-colors.js — P104 色值统一防复发（2026-08-21 大师 P104：统一后加 lint，防"这次统一了下次又写新色值"）
 * 用法：node scripts/lint-colors.js
 * 验收：旧色值（分裂色）出现 = 退出码 1；全站只允许 5 主色 + :root 变量引用
 * 5 主色：红 #e05a5a / 金 #d9a441 / 绿 #4caf7d / 灰 #8fa69c / 蓝 #5aa9e6
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FILES = ['index.html', 'views.js', 'data-layer.js'];
// 分裂色 → 统一主色（映射表，审计方法固化）
const LEGACY = {
  '#e06666': '#e05a5a',   // 红
  '#d9a45b': '#d9a441',   // 金
  '#e0a030': '#d9a441',   // 金
  '#3fbf7f': '#4caf7d',   // 绿
};
const rgbaMap = [
  [/(224,\s*102,\s*102)/g, '224,94,90'],   // 红
  [/(212,\s*160,\s*23)/g, '217,164,65'],   // 金
];
let bad = 0;
for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const s = fs.readFileSync(p, 'utf8');
  for (const [legacy, main] of Object.entries(LEGACY)) {
    const hits = (s.match(new RegExp(legacy.replace('#', '#'), 'g')) || []).length;
    if (hits) { console.log(`!! ${f}: 旧色值 ${legacy} 出现 ${hits} 次（应为 ${main}）`); bad += hits; }
  }
  for (const [re, rep] of rgbaMap) {
    const hits = (s.match(re) || []).length;
    if (hits) { console.log(`!! ${f}: 旧 rgba ${re} 出现 ${hits} 次（应为 ${rep}）`); bad += hits; }
  }
}
if (bad) { console.log(`\n✗ 色值 lint 失败：${bad} 处分裂色残留`); process.exit(1); }
console.log('✅ 色值 lint 通过：全站 5 主色统一（红#e05a5a/金#d9a441/绿#4caf7d/灰#8fa69c/蓝#5aa9e6）');
