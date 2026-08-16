// 用真实接口数据验证：qfq vs 不复权，复现截图数字
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
  console.log('拉取数据中...');
  const qfq = await fetchAll('sh600036', '2016-08-16', '2026-08-14', 'qfq');
  const day = await fetchAll('sh600036', '2016-08-16', '2026-08-14', '');
  console.log('qfq 条数:', Object.keys(qfq).length, '| day 条数:', Object.keys(day).length);
  console.log('qfq 2016-08-16:', qfq['2016-08-16'], '| day 2016-08-16:', day['2016-08-16']);
  console.log('qfq 2026-08-14:', qfq['2026-08-14'], '| day 2026-08-14:', day['2026-08-14']);

  console.log('\n=== qfq（旧 bug 路径）模拟 ===');
  for (const m of [10000, 20000, 30000]) {
    const r = sandbox.simulate(1000000, '2016-08-16', true, qfq, realDivs, m);
    console.log(`月供${m} → 累计投入 ${r.final.finalInvested.toLocaleString()} · 持股 ${r.final.shares.toLocaleString()} · 总资产 ${r.final.finalValue.toLocaleString()}`);
  }
  console.log('\n=== day（修复后）模拟 ===');
  for (const m of [10000, 20000, 30000]) {
    const r = sandbox.simulate(1000000, '2016-08-16', true, day, realDivs, m);
    console.log(`月供${m} → 累计投入 ${r.final.finalInvested.toLocaleString()} · 持股 ${r.final.shares.toLocaleString()} · 总资产 ${r.final.finalValue.toLocaleString()}`);
  }
  console.log('\n截图: 累计投入 6,354,946 · 持股 458,000 · 总资产 17,485,786');
})();
