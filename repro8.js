// 精确复现：本金120万 买入2021-01-04 月供0
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

const r = sandbox.simulate(1200000, '2021-01-04', true, closes, demo.dividends, 0);
console.log('=== 本金120万 买入2021-01-04 月供0 ===');
console.log('累计投入(期末):', r.final.finalInvested.toLocaleString(), '| 持股:', r.final.shares.toLocaleString());
r.years.slice(-6).forEach(y => {
  console.log(`  ${y.year}: 分红 ${Math.round(y.divTotal).toLocaleString()} | 每股显示 ${(y.divTotal/y.sharesStart).toFixed(3)} | 年初 ${y.sharesStart} | 年末 ${y.sharesEnd} | 累计投入 ${Math.round(y.investedEnd).toLocaleString()}`);
});
console.log('\n表格参考: 2021:34,708/1.253 | 2026:70,757/2.045 | 累计投入2026末 1,529,588');
console.log('\n2026 名义每股 = 1.013(1/16) + 1.003(7/10) = 2.016，表格 2.045 = 70,757/34,600（复投后分母口径）');
