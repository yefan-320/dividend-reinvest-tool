#!/usr/bin/env node
/* 测试：提取 index.html 中的核心函数，用招行演示数据回测验证 */
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
// 截取 simulate 函数定义 到 渲染部分之前
const start = html.indexOf('/* ================= 回测核心');
const end = html.indexOf('/* ================= 渲染');
if (start < 0 || end < 0) { console.error('找不到核心函数'); process.exit(1); }
const core = html.slice(start, end);

const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.simulate = simulate; this.calcXirr = calcXirr;', sandbox);

// 加载演示数据
vm.runInContext(fs.readFileSync(__dirname + '/demo-data.js', 'utf8'), sandbox);
const demo = sandbox.DEMO_DATA;
const closes = {}; demo.closes.forEach(x => closes[x[0]] = x[1]);

// 招行：2016-08-03 买入 10 万，红利复投
const res = sandbox.simulate(100000, '2016-08-03', true, closes, demo.dividends);
console.log('== 招行 600036 回测（10万 / 2016-08-03 买入 / 红利复投）==');
console.log('买入日:', res.buyDateReal, '买入价:', res.buyPrice.toFixed(3));
console.log('期末:', res.final.lastDate, '收盘:', res.final.lastClose, '持股:', res.final.shares.toFixed(2));
console.log('期末市值:', res.final.finalValue.toFixed(0));
console.log('累计投入(本金+复投):', res.final.finalInvested.toFixed(0));
console.log('累计分红:', res.final.totalDiv.toFixed(0));
console.log('总收益率:', (res.final.totalReturn*100).toFixed(2)+'%', '| XIRR:', (res.final.xirr*100).toFixed(2)+'%');
console.log('最新分红率:', (res.final.latestRate*100).toFixed(2)+'%', '| 最新每股分红:', res.final.latestDps.toFixed(3));
console.log('\n年度明细:');
res.years.forEach(y => console.log(
  y.year, '| 分红:', y.divTotal.toFixed(0), '| 每股:', y.dps.toFixed(3), '| 分红率:', (y.rate*100).toFixed(2)+'%',
  '| 年初持股:', y.sharesStart.toFixed(1), '| 年末持股:', y.sharesEnd.toFixed(1), '| 年末市值:', y.valueEnd.toFixed(0)
));

// 断言检查
const assert = (cond, msg) => { if(!cond){ console.error('❌ 断言失败:', msg); process.exitCode = 1; } else console.log('✅', msg); };
assert(Math.abs(res.buyPrice - closes['2016-08-03']) < 1e-9, '买入价 = 2016-08-03 收盘价');
assert(res.divEvents[0].date === '2017-06-14', '首次分红 = 2017-06-14（2016年报）');
const lastEv = res.divEvents[res.divEvents.length-1];
assert(lastEv.date === '2026-07-10', '末次分红 = 2026-07-10（2025年报）');
assert(res.divEvents.length === 11, '10年窗口内共 11 次分红到账');
assert(res.final.finalValue > 200000, '期末总资产应显著高于 10 万本金（>20万）');
assert(res.final.xirr > 0.05 && res.final.xirr < 0.25, 'XIRR 应在 5%~25% 之间（实际 '+(res.final.xirr*100).toFixed(2)+'%）');
assert(res.years.every((y,i) => i===0 || y.rate > 0), '分红率应为正');
// A股整手规则：初始买入与所有复投买入均为 100 股整数倍
assert(res.final.shares % 100 === 0, '期末持股为 100 股整数倍（实际 '+res.final.shares+'）');
assert(res.daily.every(x => x.shares % 100 === 0), '全程持股均为 100 股整数倍');
assert(res.daily[0].cashPool > 0, '初始买入有零钱存入现金池（实际 '+res.daily[0].cashPool.toFixed(0)+' 元）');
assert(res.final.cashPool >= 0, '期末现金池非负（实际 '+res.final.cashPool.toFixed(0)+' 元）');
// 复投 vs 不复投对比
const res2 = sandbox.simulate(100000, '2016-08-03', false, closes, demo.dividends);
assert(res2.final.finalValue < res.final.finalValue, '复投总资产应高于不复投');
console.log('\n不复投对比: 期末总资产 =', res2.final.finalValue.toFixed(0), '(复投为', res.final.finalValue.toFixed(0)+')');
// 2026年两次分红（1月中期+7月年度）应合并计入 2026 年
const y2026 = res.years.find(y=>y.year==='2026');
assert(y2026 && Math.abs(y2026.divTotal - (res.final.shares*0) ) > 0, '2026 年有分红记录');
console.log('\n2026年分红合计:', y2026 ? y2026.divTotal.toFixed(0) : '无');
console.log('测试完成');
