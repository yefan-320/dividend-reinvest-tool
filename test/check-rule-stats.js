#!/usr/bin/env node
/* C13/D9（2026-08-21）：RULE_STATS 同步校验——发布闸门
 * 比对 test/rule-stats.json（回测权威输出）与 data-layer.js 硬编码 RULE_STATS，
 * 不一致 → 退出码 1（release.sh 阻断发布），防"回测表更新了代码没更新"。
 * 用法：node test/check-rule-stats.js（--update 时用 JSON 重写 data-layer.js）
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const JSON_F = path.join(__dirname, 'rule-stats.json');
const DL_F = path.join(REPO, 'data-layer.js');

if (!fs.existsSync(JSON_F)) {
  console.error('❌ 缺少 test/rule-stats.json——先跑 node test/rule-tree-backtest.js --json 生成权威值');
  process.exit(1);
}
const stats = JSON.parse(fs.readFileSync(JSON_F, 'utf8'));
const src = fs.readFileSync(DL_F, 'utf8');

/* 提取 data-layer.js 的 RULE_STATS 对象（strong: [40.7, 70, 2205], ...） */
const m = src.match(/const RULE_STATS = \{([\s\S]*?)\n\};/);
if (!m) { console.error('❌ data-layer.js 找不到 RULE_STATS'); process.exit(1); }
const cur = {};
for (const k of ['strong', 'buy', 'watch', 'avoid', 'avoid_small', 'wait']) {
  const km = m[1].match(new RegExp(k + ':\\s*\\[([^\\]]*)\\]'));
  if (!km) { console.error('❌ RULE_STATS 缺档位 ' + k); process.exit(1); }
  cur[k] = km[1].split(',').map(s => s.trim() === 'null' ? null : parseFloat(s.trim()));
}

let bad = 0;
for (const k of Object.keys(stats)) {
  const a = stats[k], b = cur[k];
  const eq = JSON.stringify(a) === JSON.stringify(b);
  console.log((eq ? '  ✅ ' : '  ❌ ') + k + '：JSON ' + JSON.stringify(a) + ' vs 代码 ' + JSON.stringify(b));
  if (!eq) bad++;
}
if (bad) {
  if (process.argv.includes('--update')) {
    /* --update：以 JSON 为准重写 data-layer.js RULE_STATS（回测表更新代码跟着更新） */
    const objStr = Object.keys(stats).map(k => '  ' + k + ': [' + stats[k].map(v => v == null ? 'null' : v).join(', ') + ']').join(',\n');
    const newBlock = 'const RULE_STATS = {\n' + objStr + '\n};';
    const updated = src.replace(/const RULE_STATS = \{[\s\S]*?\n\};/, newBlock);
    if (updated === src) { console.error('❌ --update 重写失败（正则未命中）'); process.exit(1); }
    fs.writeFileSync(DL_F, updated, 'utf8');
    console.log('✅ --update 已同步 data-layer.js RULE_STATS（以 test/rule-stats.json 为准）——重新跑本脚本确认');
    process.exit(0);
  }
  console.error('❌ RULE_STATS 与回测输出不一致（' + bad + ' 档）——先跑 node test/rule-tree-backtest.js --json 更新权威值；确认口径后 node test/check-rule-stats.js --update 同步代码');
  process.exit(1);
}
console.log('✅ RULE_STATS 同步校验通过：回测表与卡面数字一致');
