#!/usr/bin/env node
/* v1.9.1 单测：柔性模式 computeZone 双模式 + calcEcoType 生态判定 */
global.window = global;
require('../data-layer.js');
const DL = global.window.DL;

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

// ===== computeZone 双模式 =====
// 柔性 64@70 起（e2e 断言 1）
let z = DL.computeZone(64, { mode: 'flexible', ecoStart: 70 });
T('柔性64@70 → wait，距70差6', z.zone === 'wait' && z.label.includes('差 6'), z.label);
// 保守 64@80 起（e2e 断言 2）
z = DL.computeZone(64, { mode: 'conservative', ecoStart: 80 });
T('保守64@80 → wait，未触发80', z.zone === 'wait' && z.label.includes('未触发建仓线（80'), z.label);
// 柔性 70 触发（e2e 断言 3）
z = DL.computeZone(70, { mode: 'flexible', ecoStart: 70 });
T('柔性70触发 → start 20%', z.zone === 'start' && z.currentTier.pos === 20 && z.nextTier.pct === 80, JSON.stringify(z));
// 柔性 80/90 → add 40% / full 60%
z = DL.computeZone(80, { mode: 'flexible', ecoStart: 70 });
T('柔性80 → add 40%', z.zone === 'add' && z.currentTier.pos === 40, z.zone + ' ' + (z.currentTier && z.currentTier.pos));
z = DL.computeZone(90, { mode: 'flexible', ecoStart: 70 });
T('柔性90 → full 60%', z.zone === 'full' && z.currentTier.pos === 60, z.zone);
// 柔性 95+ → 80% 封顶
z = DL.computeZone(95, { mode: 'flexible', ecoStart: 70 });
T('柔性95 → extreme 80%封顶', z.zone === 'extreme' && z.currentTier.pos === 80, JSON.stringify(z));
// 保守 85 → add 67%（2/3）
z = DL.computeZone(85, { mode: 'conservative', ecoStart: 80 });
T('保守85 → add 67%', z.zone === 'add' && z.currentTier.pos === 67, JSON.stringify(z.currentTier));
// 高波 ecoStart 85（e2e 断言 4）
z = DL.computeZone(85, { mode: 'flexible', ecoStart: 85 });
T('高波柔性85 → start 20%', z.zone === 'start' && z.currentTier.pos === 20, z.zone);
z = DL.computeZone(80, { mode: 'flexible', ecoStart: 85 });
T('高波柔性80 → watch 预告（距85差5）', z.zone === 'watch', z.zone + ' ' + z.label);
// 预告（距起建线≤5）
z = DL.computeZone(76, { mode: 'conservative', ecoStart: 80 });
T('保守76 → watch 预告', z.zone === 'watch', z.zone);
// 只进不退：回落时 currentTier=null，但调用方用 histPos 记忆（这里验证回落状态无 currentTier）
z = DL.computeZone(66, { mode: 'flexible', ecoStart: 70 });
T('回落66 → 无当前档（调用方记忆 histPos）', z.currentTier == null && z.zone === 'watch', z.zone);

// ===== calcEcoType =====
// 恒定价格（无回撤）→ low
const kline = {}; let dt = new Date('2022-01-04T00:00:00');
for (let i = 0; i < 900; i++) { kline[dt.toISOString().slice(0, 10)] = 30; dt.setDate(dt.getDate() + 1); }
const divs = []; for (let y = 2018; y <= 2026; y++) divs.push({ report: (y - 1) + '-12-31', ex: y + '-06-15', dps: 1.5, pending: false });
const series = DL.calcRollingPercentile(kline, divs, 500);
let eco = DL.calcEcoType(kline, series);
T('恒定价格 → low(70)', eco.type === 'low' && eco.ecoStart === 70, JSON.stringify(eco));
// 深回撤 → high(85)
const kline2 = {}; dt = new Date('2022-01-04T00:00:00');
for (let i = 0; i < 900; i++) {
  const p = i < 300 ? 40 : (i < 500 ? 30 - (i - 300) * 0.05 : 20);
  kline2[dt.toISOString().slice(0, 10)] = +p.toFixed(2); dt.setDate(dt.getDate() + 1);
}
const series2 = DL.calcRollingPercentile(kline2, divs, 500);
eco = DL.calcEcoType(kline2, series2);
console.log('  深回撤生态:', JSON.stringify(eco));
T('深回撤(40→20=-50%) → high(85)', eco.type === 'high' && eco.ecoStart === 85, JSON.stringify(eco));
// 中等回撤 → mid(80)
const kline3 = {}; dt = new Date('2022-01-04T00:00:00');
for (let i = 0; i < 900; i++) {
  const p = i < 300 ? 30 : (i < 600 ? 30 - (i - 300) * 0.02 : 24);
  kline3[dt.toISOString().slice(0, 10)] = +p.toFixed(2); dt.setDate(dt.getDate() + 1);
}
const series3 = DL.calcRollingPercentile(kline3, divs, 500);
eco = DL.calcEcoType(kline3, series3);
console.log('  中回撤生态:', JSON.stringify(eco));
T('中回撤(30→24=-20%) → low(70)', eco.type === 'low' && eco.ecoStart === 70, JSON.stringify(eco));

console.log(`\n========== v1.9.1 单测：通过 ${pass} / ${pass + fail} ==========`);
process.exit(fail ? 1 : 0);
