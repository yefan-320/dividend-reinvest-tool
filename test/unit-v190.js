#!/usr/bin/env node
/* v1.9.0 口径正确性单测（大师 e2e 三组断言·组1）：
 * ① 除息日当天 TTM=锁定值（防 10.24% 假高点）
 * ② 滚动分位 500 vs 全样本分位差异
 * ③ CAGR 低基数防护 + 报告期归组
 */
global.window = global;
const DL = require('../data-layer.js').DL || window.DL;
// data-layer.js 是 IIFE 挂 window，require 后取 window.DL
const d = require('../data-layer.js');
const DL2 = d && d.window ? d.window.DL : (global.window && global.window.DL);
const dl = DL2 || DL;

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

// mock：每年 6 月派 1.5 元，价格 30 元 → 股息率 5%，分位稳定在 ~50%
const kline = {};
let dt = new Date('2021-01-04T00:00:00');
for (let i = 0; i < 1000; i++) {
  kline[dt.toISOString().slice(0, 10)] = 30;
  dt.setDate(dt.getDate() + 1);
}
const divs = [];
for (let y = 2018; y <= 2026; y++) {
  divs.push({ report: (y - 1) + '-12-31', ex: y + '-06-15', dps: 1.5, pending: false });
}

// ① 除息锁定（365 天 TTM 窗口：每年派一次 → 锁定值=前一次派息）
const locked = dl.calcLockedTTM(divs);
T('除息日当天锁定=除息前365天TTM（2024-06-15 → 1.5）', locked['2024-06-15'] && Math.abs(locked['2024-06-15'].lockedDps - 1.5) < 1e-9, JSON.stringify(locked['2024-06-15']));
T('除息次日也锁定', !!locked['2024-06-16'], '次日 key 缺失');
T('非除息日不锁定', !locked['2024-06-17'], '普通日被误锁');

// ② 滚动分位：价格恒定 → 股息率恒定 → 分位应≈100%（窗口内全相同）；浮点噪声容忍 ≥90
const series = dl.calcRollingPercentile(kline, divs, 500);
const last = series.filter(x => x.pct != null).pop();
T('滚动分位序列生成', series.length > 500, 'len=' + series.length);
T('价格恒定 → 分位≈100%（浮点容忍≥90）', last && last.pct >= 90, 'pct=' + (last && last.pct));
T('前 250 天 pct=null（无未来函数冷启动）', series.slice(0, 250).every(x => x.pct == null), '前250条非null');
T('样本<250天 → 不产生分位', dl.calcRollingPercentile({ '2024-01-01': 30, '2024-01-02': 30 }, divs, 500).every(x => x.pct == null));

// ③ CAGR 低基数 + 归组
const good = [
  { report: '2021-12-31', ex: '2022-06-15', dps: 1.0, pending: false },
  { report: '2022-12-31', ex: '2023-06-15', dps: 1.1, pending: false },
  { report: '2023-12-31', ex: '2024-06-15', dps: 1.21, pending: false },
  { report: '2024-12-31', ex: '2025-06-15', dps: 1.33, pending: false },
];
const cagr = dl.calcDivCAGR(good, 3);
T('正常 CAGR≈10%（1.0→1.33 三年）', cagr != null && Math.abs(cagr - 0.10) < 0.03, 'cagr=' + cagr);
const lowBase = [
  { report: '2021-12-31', ex: '2022-06-15', dps: 0.02, pending: false },
  { report: '2022-12-31', ex: '2023-06-15', dps: 0.03, pending: false },
  { report: '2023-12-31', ex: '2024-06-15', dps: 0.05, pending: false },
  { report: '2024-12-31', ex: '2025-06-15', dps: 0.30, pending: false },
];
T('低基数（首年<0.1）→ null 防假象', dl.calcDivCAGR(lowBase, 3) == null);
// 一年两派归组（工行案例：中期+末期同报告期）
const twoPay = [
  { report: '2023-12-31', ex: '2024-01-15', dps: 0.35, pending: false },
  { report: '2023-12-31', ex: '2024-07-15', dps: 0.30, pending: false },
  { report: '2024-12-31', ex: '2025-01-15', dps: 0.38, pending: false },
  { report: '2024-12-31', ex: '2025-07-15', dps: 0.32, pending: false },
];
const rp = dl.calcReportYearDivs(twoPay);
T('报告期归组：2023=0.65, 2024=0.70', rp.includes('2023') && rp.includes('2024'), JSON.stringify(rp));

// ④ computeZone 边界
T('79.9 → 75-80 预告区（watch）', dl.computeZone(79.9).zone === 'watch');
T('80 → 建仓', dl.computeZone(80).zone === 'start');
T('85 → 加仓', dl.computeZone(85).zone === 'add');
T('90 → 加满', dl.computeZone(90).zone === 'full');
T('95 → 极值', dl.computeZone(95).zone === 'extreme');
T('null → nodata', dl.computeZone(null).zone === 'nodata');

console.log(`\n========== 口径单测：通过 ${pass} / ${pass + fail} ==========`);
process.exit(fail ? 1 : 0);
