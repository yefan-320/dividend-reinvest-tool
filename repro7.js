// 复现主人的年度明细表：找参数组合（本金/月供/买入日）
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

// 表格参考：2021-2026 每股分红 1.253/1.522/1.738/1.972/2.000/2.045；2026分红 70,757；累计投入 2026末 1,529,588
// 猜测：本金100万 + 月供2万 + 买入2021-01-04
for (const [p, m, d] of [[1000000, 20000, '2021-01-04'], [1200000, 20000, '2021-01-04'], [1000000, 20000, '2020-12-01'], [1000000, 15000, '2021-01-04']]) {
  const r = sandbox.simulate(p, d, true, closes, demo.dividends, m);
  console.log(`\n=== 本金${p/10000}万 月供${m/10000} 买入${d} ===`);
  console.log('累计投入(期末):', r.final.finalInvested.toLocaleString(), '| 持股:', r.final.shares.toLocaleString(), '| 总资产:', r.final.finalValue.toLocaleString());
  r.years.slice(-6).forEach(y => console.log(`  ${y.year}: 分红 ${Math.round(y.divTotal).toLocaleString()} | 每股 ${(y.divTotal/y.sharesStart).toFixed(3)} | 年初持股 ${y.sharesStart} | 年末 ${y.sharesEnd} | 累计投入 ${Math.round(y.investedEnd).toLocaleString()}`));
}
console.log('\n表格参考: 2021分红34,708 每股1.253 | 2026分红70,757 每股2.045 | 累计投入2026末1,529,588');
