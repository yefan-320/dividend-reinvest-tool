#!/usr/bin/env node
/* v1.7.1 测试：每月追加投入（P1-23/24/25） */
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const start = html.indexOf('/* ================= 回测核心');
const end = html.indexOf('/* ================= 渲染');
const core = html.slice(start, end);
const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.simulate = simulate; this.calcXirr = calcXirr;', sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/demo-data.js', 'utf8'), sandbox);
const demo = sandbox.DEMO_DATA;
const closes = {}; demo.closes.forEach(x => closes[x[0]] = x[1]);
const assert = (cond, msg) => { if (!cond) { console.error('❌ 断言失败:', msg); process.exitCode = 1; } else console.log('✅', msg); };

console.log('== T-M1 每月追加基本逻辑 ==');
// 无追加（默认 0）→ 与旧版一致
const r0 = sandbox.simulate(100000, '2016-08-03', true, closes, demo.dividends);
const r0b = sandbox.simulate(100000, '2016-08-03', true, closes, demo.dividends, 0);
assert(r0.final.finalValue === r0b.final.finalValue, 'monthly=0 与不传参结果一致（向后兼容）');

console.log('== T-M2 每月追加 10000 ==');
const r1 = sandbox.simulate(100000, '2016-08-03', true, closes, demo.dividends, 10000);
// 2016-08 买入 → 2016-09 起每月首个交易日追加（首月不追加）
const months = (r1.final.lastDate.slice(0,4) - 2016) * 12 + (parseInt(r1.final.lastDate.slice(5,7)) - 8);
const expectAdd = Math.max(0, months);   // 2016-09 至 2026-07 = 119 个月左右
assert(r1.final.finalInvested > 100000 + 10000 * 110, `累计投入含追加（实际 ${r1.final.finalInvested.toFixed(0)}，应 > ${(100000+10000*110).toFixed(0)}）`);
assert(r1.final.finalValue > r0.final.finalValue, '追加后总资产更高');
assert(r1.final.xirr != null && r1.final.xirr > 0, 'XIRR 正常计算（含追加现金流）');

console.log('== T-M3 攒一手逻辑（高价股买不起一手） ==');
// 构造高价场景：股价 500 元，每月追加 1000 元（不够一手 50000）→ 现金池累计
const hi = { '2020-01-02': 500, '2020-02-03': 500, '2020-03-02': 500, '2020-04-01': 500 };
const r2 = sandbox.simulate(100000, '2020-01-02', true, hi, [], 1000);
// 首月(2020-01)不追加；02/03/04 三个月各 1000 → 现金池 3000，买不起一手(50000)
assert(Math.abs(r2.final.cashPool - 3000) < 1e-6, `不足一手累计现金池（实际 ${r2.final.cashPool.toFixed(0)}，应 3000）`);
assert(r2.final.shares === 200, '持股不变（一手=50000 买不起）');

console.log('== T-M4 攒够一手后买入 ==');
const hi2 = { '2020-01-02': 10, '2020-02-03': 10, '2020-03-02': 10, '2020-04-01': 10 };
const r3 = sandbox.simulate(100000, '2020-01-02', true, hi2, [], 10000);
// 02/03/04 每月 10000 → 02月买1000股(10000元)，03月再买1000股，04月再买1000股 → 追加买入 3000 股
assert(r3.final.shares === 10000 + 3000, `攒够一手即买入（10000+3000=${r3.final.shares}）`);
assert(Math.abs(r3.final.cashPool) < 1e-6, '现金池干净（每期刚好一手）');

console.log('\n测试完成' + (process.exitCode ? '（有失败）' : '（全部通过）'));
