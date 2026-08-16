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

for (const m of [0, 5000, 10000, 20000, 30000, 40000, 50000]) {
  const r = sandbox.simulate(1000000, '2016-08-16', true, closes, demo.dividends, m);
  console.log(`monthly=${String(m).padStart(6)} → 累计投入 ${r.final.finalInvested.toLocaleString()} 元 · 持股 ${r.final.shares.toLocaleString()} 股 · 总资产 ${r.final.finalValue.toLocaleString()}`);
}
