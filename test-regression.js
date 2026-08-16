#!/usr/bin/env node
/* 测试 v1.7.0：送转口径回归 + 边界案例
 * 送转 bug 修复验证：纯转增 BONUS_IT_RATIO=4.5/IT_RATIO=4.5 → bonus 应为 0.45（旧版 0.9 翻倍）
 * 边界：零股（送转产生）、上市首日买入、退市/缺数据、无分红股票 */
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const start = html.indexOf('/* ================= 数据拉取');
const end = html.indexOf('/* ================= 渲染');
if (start < 0 || end < 0) { console.error('找不到核心函数'); process.exit(1); }
const core = html.slice(start, end);

const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.simulate = simulate; this.calcXirr = calcXirr; this.parseDivs = parseDivs;', sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/demo-data.js', 'utf8'), sandbox);

const assert = (cond, msg) => { if (!cond) { console.error('❌ 断言失败:', msg); process.exitCode = 1; } else console.log('✅', msg); };

/* T1 送转口径（大师 P1-7 回归：南华期货 10转4.5 案例） */
console.log('\n== T1 送转口径回归 ==');
const rows = [
  { REPORT_DATE: '2025-12-31', EX_DIVIDEND_DATE: '2026-07-01', PRETAX_BONUS_RMB: 0.69, BONUS_IT_RATIO: 4.5, IT_RATIO: 4.5, ASSIGN_PROGRESS: '实施分配', IMPL_PLAN_PROFILE: '10转4.50股派0.69元' },
  { REPORT_DATE: '2025-12-31', EX_DIVIDEND_DATE: '2026-07-01', PRETAX_BONUS_RMB: 3.5, BONUS_IT_RATIO: 3, IT_RATIO: null, ASSIGN_PROGRESS: '实施分配', IMPL_PLAN_PROFILE: '10送3股派3.50元' },
];
const parsed = sandbox.parseDivs(rows);
const zhuan = parsed.find(x => Math.abs(x.dps - 0.069) < 1e-9);
const song = parsed.find(x => Math.abs(x.dps - 0.35) < 1e-9);
assert(Math.abs(zhuan.bonus - 0.45) < 1e-9, `纯转增 10转4.5 → bonus=0.45（实际 ${zhuan.bonus}，旧版 bug 为 0.9）`);
assert(Math.abs(song.bonus - 0.3) < 1e-9, `纯送股 10送3 → bonus=0.3（实际 ${song.bonus}）`);

/* T2 送转对持股影响：模拟转增案例 */
console.log('\n== T2 转增持股模拟 ==');
const closes = { '2026-01-01': 10, '2026-07-01': 5, '2026-07-02': 5 };  // 除权日价格腰斩（10转10）
const divs = [{ report: '2025-12-31', ex: '2026-07-01', dps: 0, bonus: 1.0 }];  // 10转10 → 每股送转1股
const r1 = sandbox.simulate(100000, '2026-01-01', false, closes, divs);
assert(Math.abs(r1.final.shares - 20000) < 1e-6, `10转10 后持股翻倍（10000→${r1.final.shares}）`);
assert(Math.abs(r1.final.finalValue - 100000) < 1e-6, `转增不改变总资产（除权价腰斩+股数翻倍=${r1.final.finalValue.toFixed(0)}）`);

/* T3 边界：买入日早于最早交易日 → 用最早交易日 */
console.log('\n== T3 边界案例 ==');
const r3 = sandbox.simulate(50000, '2020-01-01', true, closes, []);
assert(r3.buyDateReal === '2026-01-01', '买入日早于数据起点 → 用首个交易日');
assert(r3.final.totalDiv === 0, '无分红数据 → 累计分红 0');
assert(r3.daily.length === 3, '全部交易日都被遍历');

/* T4 边界：零股现金池（买入非整手倍数本金） */
const r4 = sandbox.simulate(12345, '2026-01-01', true, closes, []);
assert(r4.daily[0].shares === 1200, `零钱进现金池（12345元/10元=1234.5股→1200股，实际 ${r4.daily[0].shares}）`);
assert(r4.daily[0].cashPool > 0, '现金池有零钱');

/* T5 边界：退市/缺数据 → 空 closes 报错而非崩溃 */
let threw = false;
try { sandbox.simulate(10000, '2020-01-01', true, {}, []); } catch (e) { threw = true; }
assert(threw, '无行情数据应抛出可捕获错误');

console.log('\n测试完成' + (process.exitCode ? '（有失败）' : '（全部通过）'));
