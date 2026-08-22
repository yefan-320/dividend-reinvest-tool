#!/usr/bin/env node
/* v3.7.0 回归断言（接手 AI 2026-08-23）：
 * ① 回测总收益率口径：月追加下 totalReturn(相对初始本金) 严重虚高，相对累计投入才是真收益
 * ② 陷阱拦截修复：verdictEngine 在"深度低估档+净利下滑+支付率>50%"时 hard 陷阱必须触发（原死代码 '重仓区' 永不成立）
 * ③ 财报闸 fail-open 修复：finOk=null（F10 数据缺失）必须禁买（原 finOk===false 放行 null）
 */
'use strict';
global.window = global;
require(require('path').join(__dirname, '..', 'data-layer.js'));
const DL = global.window.DL;
const simOne = require(require('path').join(__dirname, '..', 'sim-core.js'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('✅', msg); } else { fail++; console.log('❌', msg); } };

/* ---------- 断言 1：总收益率口径（sim-core simOne） ---------- */
(function () {
  // 构造 5 年日K（2021-08-23 ~ 2026-08-21，约 1215 交易日，价格缓慢上涨），月追加 1 万
  const closes = {};
  const d0 = new Date('2021-08-23');
  const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  let t = new Date(d0);
  let price = 30;
  const guard = new Date('2026-08-23');
  while (t < guard) {
    t.setDate(t.getDate() + 1);
    if (t.getDay() === 0 || t.getDay() === 6) continue;
    price = price * (1 + 0.0002);   // 年化约 5% 上涨
    closes[fmt(t)] = +price.toFixed(2);
  }
  const divs = [];
  for (let y = 2022; y <= 2026; y++) {
    divs.push({ ex: y + '-07-01', dps: 1.0, report: (y - 1) + '-12-31', pending: false, bonus: 0, code: '600036' });
  }
  const sim = simOne(30000, 10000, closes, divs, true, 0);
  ok(!!sim, '断言1a: simOne 返回结果');
  const oldCaliber = sim.final.finalValue / 30000 - 1;          // 旧口径：相对初始本金
  const newCaliber = sim.final.finalValue / sim.extInvested - 1; // 新口径：相对累计投入
  console.log('   —— 旧口径(相对初始本金):', (oldCaliber * 100).toFixed(1) + '%', '| 新口径(相对累计投入):', (newCaliber * 100).toFixed(1) + '%');
  ok(newCaliber < oldCaliber, `断言1b: 新口径 < 旧口径（${(newCaliber * 100).toFixed(1)}% < ${(oldCaliber * 100).toFixed(1)}%）`);
  ok(newCaliber > -0.5 && newCaliber < 0.5, `断言1c: 新口径合理（|收益| < 50%，实测 ${(newCaliber * 100).toFixed(1)}%），旧口径 ${(oldCaliber * 100).toFixed(1)}% 误导`);
  ok(Math.abs(sim.extInvested - (30000 + 600000)) < 1, `断言1d: extInvested = 本金+月追加（${sim.extInvested} ≈ 630000）`);
})();

/* ---------- 断言 2：陷阱拦截（死代码修复） ---------- */
(function () {
  const v = DL.verdictEngine({
    divs: [{ ex: '2025-07-01', dps: 2.0, report: '2024-12-31', pending: false, bonus: 0 }, { ex: '2026-07-01', dps: 2.0, report: '2025-12-31', pending: false, bonus: 0 }],
    coverage: 0.76,        // 支付率 76% > 50%
    payoutRate: 0.76,
    reserveYears: 5.7, eps: 2.5, dps: 2.0, price: 25, dy: 8.0,   // dy 8% ≥ 深度低估线
    pct: 93, industry: 'consumer', roe: 12.3, roeTrend: -2,
    dividendCagr: 0.046, code: '600036',
    netProfitYoY: -34.3,   // 净利大幅下滑 → hard 陷阱
  });
  ok(v.trap && v.trap.level === 'hard', `断言2a: hard 陷阱触发（原死代码不触发；实测 level=${v.trap && v.trap.level}）`);
  ok(v.curTier && v.curTier.name.includes('陷阱拦截'), `断言2b: 主结论降级为"深度低估(陷阱拦截)"（实测 ${v.curTier && v.curTier.name}）`);
})();

/* ---------- 断言 3：财报闸 fail-open 修复 ---------- */
(function () {
  const ts = DL.tradingSignal({
    code: '600036', dy: 6.5, tier: 'p95', trendOk: true,
    finOk: null,           // F10 数据缺失 → 修复前(null !== false)放行买入
    finChecks: [], lastBuyDays: null, industrySignals: null,
    industry: 'bank', finGood: false, valuation: null,
  });
  ok(ts.action === 'hold', `断言3a: finOk=null 时禁买（action=${ts.action}，修复前会放行 buy_L*）`);
  ok(/禁止买入/.test(ts.text), `断言3b: 文案明确"禁止买入"（实测：${ts.text}）`);
})();

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
