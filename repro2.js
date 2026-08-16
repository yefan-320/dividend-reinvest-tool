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

// 截图数字：累计投入 6,354,946 / 持股 458,000 / 总资产 17,485,786
// 反查：458,000 股需要多少本金+月供？粗算
console.log('=== 反查持股 458,000 股 ===');
for (const [p, m] of [[1000000, 30000], [1000000, 40000], [1000000, 50000], [2000000, 30000], [2000000, 50000], [3000000, 30000], [3000000, 50000]]) {
  const r = sandbox.simulate(p, '2016-08-16', true, closes, demo.dividends, m);
  console.log(`本金${(p/10000).toFixed(0)}万 月供${(m/10000).toFixed(0)}万 → 累计投入 ${r.final.finalInvested.toLocaleString()} · 持股 ${r.final.shares.toLocaleString()} · 总资产 ${r.final.finalValue.toLocaleString()}`);
}
