#!/usr/bin/env node
/* v1 组合现金仓位单测（验收 24 条：现金 1.5% 数值断言） */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;

let pass = 0, fail = 0;
function T(name, cond, extra) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (extra != null ? ' | got: ' + extra : '')); }
}

/* 构造单股池：招行 10 年平线价格 40 元，无分红（隔离现金测试） */
function mkPool(code, price, n) {
  const kline = {};
  const d = new Date('2016-08-22');
  for (let i = 0; i < n; i++) {
    kline[d.toISOString().slice(0, 10)] = price;
    d.setDate(d.getDate() + 1);
  }
  return { [code]: { kline, divs: [] } };
}

/* 测试 1：100 万组合 85 万股 + 15 万现金(1.5%) 跑 10 年 → 期末现金 ≈ 15万×1.015^10 = 17.41 万 */
const pool = mkPool('600036', 40, 3800);
const combo = [{ code: '600036', name: '招商银行', amount: 1000000, monthly: 0 }];
const r = DL.calcComboBacktest(combo, pool, { years: 10, cashPct: 15, cashRate: 1.5, monthlyMode: 'fixed' });
const expected = 150000 * Math.pow(1.015, 10); // ≈ 174,082
// 找总资产里现金部分：perStock 排除现金行，totalAsset 最后值 = 股票价值 + 现金
// 股票价值 = 850000（价格平线无涨跌无分红）
const lastTotal = r.last.value;
const cashActual = lastTotal - 850000;
T('现金 1.5%×10年 ≈ 17.41万（±1%）', Math.abs(cashActual - expected) / expected < 0.01, '现金部分=' + cashActual.toFixed(0) + ' 期望=' + expected.toFixed(0));
T('股票部分=85万（scale 生效）', (() => { const st = r.perStock.find(x => x.code === '600036'); return st && Math.abs(st.amount - 850000) < 1; })(), JSON.stringify(r.perStock));

/* 测试 2：无现金仓位时股票满额 */
const r2 = DL.calcComboBacktest(combo, pool, { years: 10, monthlyMode: 'fixed' });
T('无现金仓位：股票=100万', (() => { const st = r2.perStock.find(x => x.code === '600036'); return st && Math.abs(st.amount - 1000000) < 1; })(), JSON.stringify(r2.perStock));
T('无现金仓位：期末=100万（平线）', Math.abs(r2.last.value - 1000000) < 1000, '期末=' + r2.last.value);

/* 测试 3：cashRate=0 时现金不增长 */
const r3 = DL.calcComboBacktest(combo, pool, { years: 10, cashPct: 15, cashRate: 0, monthlyMode: 'fixed' });
T('cashRate=0：期末现金=15万', Math.abs((r3.last.value - 850000) - 150000) < 100, '现金=' + (r3.last.value - 850000));

/* 测试 4：现金行不进 perStock/divByYear */
T('perStock 不含现金行', r.perStock.length === 1, 'len=' + r.perStock.length);
T('divByYear 不含现金分红', (() => { const ys = Object.keys(r.divByYear); return ys.every(y => r.divByYear[y] === 0); })(), JSON.stringify(r.divByYear));

/* 测试 5：组合卡静态补差 monthly 分配（低配优先近似）——由 views 层测，这里测 weight 模式兼容 */
const combo2 = [
  { code: '600036', name: '招行', amount: 400000, monthly: 3000 },
  { code: '601398', name: '工行', amount: 300000, monthly: 2000 },
  { code: '600900', name: '长电', amount: 300000, monthly: 1000 },
];
const pool3 = Object.assign({}, mkPool('600036', 40, 3800), mkPool('601398', 6, 3800), mkPool('600900', 25, 3800));
const r4 = DL.calcComboBacktest(combo2, pool3, { years: 10, monthlyMode: 'weight', cashPct: 10, cashRate: 1.5 });
T('weight 模式+现金仓位不崩', r4 != null && r4.rows === 4, r4 ? 'rows=' + r4.rows : 'null');

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
