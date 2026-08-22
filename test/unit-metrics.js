#!/usr/bin/env node
/* v3.10+ metrics.js 口径层单测（接手 AI）：统一出口 + 口径标注正确性 */
'use strict';
global.window = global;
require(require('path').join(__dirname, '..', 'data-layer.js'));
require(require('path').join(__dirname, '..', 'metrics.js'));
const METRICS = global.METRICS;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

/* 招行模拟数据（报告期 2025=2.016，年化近2财年=(2.0+2.016)/2≈2.008） */
const divs = [
  { ex: '2025-07-11', dps: 2.0, report: '2024-12-31', pending: false, bonus: 0, eps: 5.7 },
  { ex: '2026-07-10', dps: 1.003, report: '2025-12-31', pending: false, bonus: 0, eps: 5.6 },
  { ex: '2026-01-16', dps: 1.013, report: '2025-12-31', pending: false, bonus: 0, eps: 5.6 },
];
const price = 38.9;

/* 1. 股息率主口径=报告期 */
const dy = METRICS.get('divYield', { divs, price });
ok(dy && dy.caliber === 'report-year', `股息率默认=报告期口径（${dy ? dy.value.toFixed(2) + '%' : 'null'}）`);
ok(dy && Math.abs(dy.value - (2.016 / 38.9 * 100)) < 0.01, `报告期值正确（${dy ? dy.value.toFixed(2) : '—'}% ≈ 5.18%）`);

/* 2. 显式年化口径 */
const dy2 = METRICS.get('divYield', { divs, price, caliber: 'annual2y' });
ok(dy2 && dy2.caliber === 'annual-2y' && dy2.value > 5.15 && dy2.value < 5.17, `年化近2财年口径正确（${dy2 ? dy2.value.toFixed(2) : '—'}%≈5.16%）`);

/* 3. 未知口径回退主口径不崩 */
const dy3 = METRICS.get('divYield', { divs, price, caliber: 'whatever' });
ok(dy3 && dy3.caliber === 'report-year', '未知口径回退报告期主口径');

/* 4. 分红占利润统一名（覆盖率/支付率/分红率同数异名收敛） */
const pr = METRICS.get('payoutRatio', { divs });
ok(pr && pr.label === '分红占利润' && typeof pr.value === 'number', `分红占利润口径（${pr ? pr.value.toFixed(0) + '%' : 'null'}）`);

/* 5. 储备年数取 max(报告期,年化) */
const rv = METRICS.get('reserveYears', { divs, reserve: 26.95, price });
ok(rv && rv.value > 10 && rv.value < 15, `储备年数合理（${rv ? rv.value.toFixed(1) : 'null'} 年，26.95/2.016≈13.4）`);

/* 6. 便宜度（滚动分位） */
const kline = {};
let d = new Date('2024-01-02');
for (let i = 0; i < 1000; i++) {
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0 || d.getDay() === 6) continue;
  const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  kline[ds] = 40 + Math.sin(i / 30) * 6;
}
const cp = METRICS.get('cheapness', { kline, divs });
ok(cp && cp.value >= 0 && cp.value <= 100 && cp.dy != null, `便宜度 0-100 且带 dy（${cp ? cp.value.toFixed(0) + '%' : 'null'}）`);

/* 7. 未知指标报错 */
let threw = false;
try { METRICS.get('noSuchMetric', {}); } catch (e) { threw = true; }
ok(threw, '未知指标抛错');

/* 8. 审计日志 */
const audit = METRICS.audit();
ok(audit.length >= 5, `审计日志记录 ${audit.length} 条调用（含口径标注）`);

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
