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
console.log('=== 修复后（名义每股分红）===');
r.years.slice(-6).forEach(y => {
  console.log(`  ${y.year}: 分红 ${Math.round(y.divTotal).toLocaleString()} | 每股分红 ${y.dps.toFixed(3)} | 年初 ${y.sharesStart} | 年末 ${y.sharesEnd}`);
});
console.log('\n期望: 2026 每股 = 2.016（1.013+1.003）');
