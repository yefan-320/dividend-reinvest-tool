#!/usr/bin/env node
/* v2.0 新功能单测（批次1-5）：数据层纯函数——决策语言/无风险对比/退休模拟/反向本金/清洗留标记/口径自检/异常分级 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;

let pass = 0, fail = 0;
function T(name, cond, extra) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (extra != null ? ' | got: ' + extra : '')); }
}

/* 平安修复后 CAGR（回源核验口径） */
const pingan = [
  { ex: '2026-09-10', report: '2026-06-30', dps: 0.98 },
  { ex: '2026-06-10', report: '2025-12-31', dps: 1.75 },
  { ex: '2025-10-24', report: '2025-06-30', dps: 0.95 },
  { ex: '2025-06-30', report: '2024-12-31', dps: 1.62 },
  { ex: '2024-10-18', report: '2024-06-30', dps: 0.93 },
  { ex: '2024-07-26', report: '2023-12-31', dps: 1.5 },
  { ex: '2023-10-20', report: '2023-06-30', dps: 0.93 },
  { ex: '2023-07-25', report: '2022-12-31', dps: 1.5 },
  { ex: '2022-10-25', report: '2022-06-30', dps: 0.92 },
  { ex: '2022-07-25', report: '2021-12-31', dps: 1.5 },
];
T('平安 CAGR 3年 +3.7%（修复后）', (() => { const c = DL.calcDivCAGR(pingan, 3); return c != null && Math.abs(c - 0.0372) < 0.001; })(), DL.calcDivCAGR(pingan, 3));

/* 清洗留标记 #7 */
const dirty = [
  { ex: '2024-06-30', report: '2023-12-31', dps: 1.5, exPrice: 40 },
  { ex: 'bad-date', report: '2020-12-31', dps: 99 },
];
const cl = DL.sanitizeDividends('601318', dirty);
T('#7 清洗留标记：非法日期剔除入 _dropped', cl.length === 1 && cl._dropped && cl._dropped.length === 1);

/* 决策语言 #1 */
const ds = DL.decisionSentence([{ code: '601318', name: '平安', shares: 10000, price: 40, divs: pingan }], { monthlyExp: 5000 });
T('#1 决策语言：投资额/覆盖率正确', ds && Math.abs(ds.invest - 400000) < 1 && ds.coverage != null && ds.coverage > 0 && ds.coverage < 1000, ds && ds.sentence);
T('#1 决策语言：sentence 含关键数字', ds && /投入 40\.0 万/.test(ds.sentence) && /覆盖月支出/.test(ds.sentence));

/* 无风险基准 #2 */
const rf = DL.riskFreeCompare(400000, 17000, 1.681);
T('#2 无风险基准：国债年收益=市值×利率', Math.abs(rf.bankAnnual - 6724) < 1 && rf.better === '分红');

/* 退休模拟 #12 */
const rs = DL.retirementSim(50000, 0.08, 0.02, 8000, 30);
T('#12 退休模拟：30年内达标年命中', rs && rs.hitYear != null && rs.hitYear >= 0 && rs.hitYear <= 30, rs && rs.hitYear);
const rs2 = DL.retirementSim(50000, 0.01, 0.05, 8000, 30);
T('#12 退休模拟：低增速高通胀永不达标→null', rs2 && rs2.hitYear == null);

/* 反向本金 #13 */
const rp = DL.requiredPrincipal(8000, 0.0484, 0.05);
T('#13 反向本金：双答案正确', rp && Math.abs(rp.atCurrent - 8000 * 12 / 0.0484) < 1 && Math.abs(rp.atExpected - 8000 * 12 / 0.05) < 1);

/* 异常分级 #9 */
T('#9 异常分级：无来源无缓存=major', DL.dataHealthLevel('k', false).level === 'major');
T('#9 异常分级：有来源=ok', (() => { DL.srcMark && DL.srcMark('t:1', 'net'); return DL.dataHealthLevel('t:1', true).level === 'ok'; })());

/* 口径自检 #6 */
const audit = DL.caliberAudit();
T('#6 口径自检：全函数在位无缺失', audit.length >= 10 && audit.every(r => r.ok));

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
