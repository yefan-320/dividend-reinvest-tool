/**
 * test/anchors.js — 股息率/分红口径真值锚点库（2026-08-21 大师裁决 A-）
 *
 * 用途：每次口径函数（ttmDivsAtMode/splitSpecialDivs/alignSendZhuan/calcRollingPercentile）
 *       改动后必须全量过锚点，过不了=提交失败（防"改一个坏另一个"）。
 * 规则：每抓一个新 bug → 加一个对应锚点（锚点是 bug 的"尸检报告"，只增不删）。
 *
 * 用法：node test/anchors.js（被 consistency-check.js 引用）
 */
'use strict';
const fs = require('fs');
global.window = global;
require('../data-layer.js');
const DL = global.window.DL;

const cache = JSON.parse(fs.readFileSync(__dirname + '/../data/rule-tree-cache.json', 'utf8'));

function dyAt(code, dateStr) {
  const divs = cache[code + ':d'] || [];
  const karr = cache[code + ':k'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  const series = DL.calcRollingPercentile(kline, divs, 375);
  const s = series.find(x => x.d === dateStr);
  return s && s.dy != null ? s.dy : null;
}

// 锚点定义：{ name, check: () => bool }
const ANCHORS = [
  {
    name: '招行 2026-06-24 ≈5.44% (B主口径·已全部到账)',
    check: () => Math.abs(dyAt('600036', '2026-06-24') - 5.44) < 0.6,
  },
  {
    name: '宇通 2023-01-03 ≈6.6% 非13% (未到账不计入)',
    check: () => Math.abs(dyAt('600066', '2023-01-03') - 6.62) < 0.8,
  },
  {
    name: '工行 2026-06-24 ≈4.3% (银行代表)',
    check: () => Math.abs(dyAt('601398', '2026-06-24') - 4.30) < 0.6,
  },
  {
    name: '伊利 2026-06-24 ≈5.66% (消费代表)',
    check: () => Math.abs(dyAt('600887', '2026-06-24') - 5.66) < 0.8,
  },
  {
    name: '移动 2026-06-24 ≈5.3% (电信代表)',
    check: () => Math.abs(dyAt('600941', '2026-06-24') - 5.30) < 0.8,
  },
  {
    name: '兖矿 2022 特别分红拆分 (reg≈1.1/sp≈1.9)',
    check: () => {
      const divs = cache['600188:d'] || [];
      const split = DL.splitSpecialDivs(divs);
      const y2022 = split.filter(d => d.report && d.report.startsWith('2022'));
      const reg = y2022.reduce((s, d) => s + (d.regular || 0), 0);
      const sp = y2022.reduce((s, d) => s + (d.special || 0), 0);
      return Math.abs(reg - 1.12) < 0.3 && Math.abs(sp - 1.95) < 0.3;
    },
  },
  {
    name: '美的 2023 无特别分红误拆 (3.0 全 regular)',
    check: () => {
      const divs = cache['000333:d'] || [];
      const split = DL.splitSpecialDivs(divs);
      const m2023 = split.filter(d => d.report && d.report.startsWith('2023'));
      const sp = m2023.reduce((s, d) => s + (d.special || 0), 0);
      return sp === 0;
    },
  },
];

let pass = 0, fail = 0;
for (const a of ANCHORS) {
  const ok = a.check();
  if (ok) { pass++; console.log('✅ ' + a.name); }
  else { fail++; console.log('❌ ' + a.name); }
}
console.log(`\n锚点库: ${pass}/${ANCHORS.length} 通过`);
process.exit(fail ? 1 : 0);
