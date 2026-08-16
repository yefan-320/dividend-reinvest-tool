// 修复后验证：day 不复权 100万+月供5000/10000 的合理数字
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
const realDivs = demo.dividends;

async function fetchSeg(txPrefix, start, end, suffix) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${txPrefix},day,${start},${end},800,${suffix}`;
  const r = await fetch(url);
  const d = await r.json();
  const node = d && d.data && d.data[txPrefix];
  return (node && (node.qfqday || node.day)) || [];
}
async function fetchAll(txPrefix, start, end, suffix) {
  const map = {}; let cur = start; let guard = 0;
  while (cur < end && guard++ < 12) {
    const d0 = new Date(cur);
    const segEnd = new Date(Date.UTC(d0.getUTCFullYear() + 2, d0.getUTCMonth() + 6, d0.getUTCDate()));
    const endStr = segEnd > new Date(end) ? end : segEnd.toISOString().slice(0, 10);
    const rows = await fetchSeg(txPrefix, cur, endStr, suffix);
    if (!rows.length) break;
    rows.forEach(r => { map[r[0]] = parseFloat(r[2]); });
    const last = rows[rows.length - 1][0];
    if (last >= end) break;
    const nd = new Date(last); nd.setDate(nd.getDate() + 1);
    cur = nd.toISOString().slice(0, 10);
  }
  return map;
}

(async () => {
  const day = await fetchAll('sh600036', '2016-08-16', '2026-08-14', '');
  console.log('=== 修复后（不复权真实价）=== 截图对比: 6,354,946 / 458,000 / 17,485,786');
  for (const m of [0, 5000, 10000, 20000, 30000]) {
    const r = sandbox.simulate(1000000, '2016-08-16', true, day, realDivs, m);
    console.log(`月供${String(m).padStart(5)} → 累计投入 ${r.final.finalInvested.toLocaleString()} · 持股 ${r.final.shares.toLocaleString()} · 总资产 ${r.final.finalValue.toLocaleString()}`);
  }
})();
