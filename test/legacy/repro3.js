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

// 用 qfq 前复权价格构造 closes（模拟联网 bug 场景），demo 分红照旧
const qfqCloses = {};
demo.closes.forEach(x => qfqCloses[x[0]] = +(x[1] * 0.2415).toFixed(3)); // 4.419/18.31 ≈ 0.2415 粗略模拟

console.log('=== qfq 模拟（复现截图）===');
for (const m of [10000, 20000, 30000]) {
  const r = sandbox.simulate(1000000, '2016-08-16', true, qfqCloses, demo.dividends, m);
  console.log(`monthly=${m} → 累计投入 ${r.final.finalInvested.toLocaleString()} · 持股 ${r.final.shares.toLocaleString()} · 总资产 ${r.final.finalValue.toLocaleString()}`);
}
console.log('截图: 累计投入 6,354,946 · 持股 458,000 · 总资产 17,485,786');
