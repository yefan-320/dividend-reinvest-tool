// 参数搜索：找最接近截图 (6,354,946 / 458,000 / 17,485,786) 的组合
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
  const qfq = await fetchAll('sh600036', '2016-08-16', '2026-08-14', 'qfq');
  const day = await fetchAll('sh600036', '2016-08-16', '2026-08-14', '');
  const target = [6354946, 458000, 17485786];
  let best = null, bestScore = 1e18;
  for (const [label, closes] of [['qfq', qfq], ['day', day]]) {
    for (const p of [500000, 1000000, 1500000, 2000000]) {
      for (const m of [0, 5000, 10000, 20000, 30000]) {
        const r = sandbox.simulate(p, '2016-08-16', true, closes, realDivs, m);
        const score = Math.abs(r.final.finalInvested - target[0]) / target[0] +
                      Math.abs(r.final.shares - target[1]) / target[1] +
                      Math.abs(r.final.finalValue - target[2]) / target[2];
        if (score < bestScore) { bestScore = score; best = { label, p, m, r }; }
      }
    }
  }
  console.log('最接近截图的组合:', best.label, '本金', best.p, '月供', best.m);
  console.log('累计投入', best.r.final.finalInvested.toLocaleString(), '持股', best.r.final.shares.toLocaleString(), '总资产', best.r.final.finalValue.toLocaleString());
  console.log('偏差分', bestScore.toFixed(4));
  console.log('截图: 6,354,946 / 458,000 / 17,485,786');
})();
