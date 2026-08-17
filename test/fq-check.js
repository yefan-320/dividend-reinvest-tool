#!/usr/bin/env node
/* 不复权 vs 前复权 分位差异实测（主人抓的 bug：K线用不复权价做分位）
 * 问题：除权跳空让历史价格"非市场下移"，高股息股分位被系统性低估（假便宜）
 * 方法：8 只高股息股，腾讯 qfq 前复权 vs 不复权，各算 W500 分位序列，对比：
 *   ① 当前分位差异 ② 80 分位触发事件数差异 ③ 两口径事件买点质量差异 ④ 股息率 vs 分位偏差相关性
 */
const STOCKS = [
  { code: '600036', market: 1, name: '招商银行', tx: 'sh600036' },
  { code: '601398', market: 1, name: '工商银行', tx: 'sh601398' },
  { code: '600519', market: 1, name: '贵州茅台', tx: 'sh600519' },
  { code: '601318', market: 1, name: '中国平安', tx: 'sh601318' },
  { code: '600900', market: 1, name: '长江电力', tx: 'sh600900' },
  { code: '000001', market: 0, name: '平安银行', tx: 'sz000001' },
  { code: '600028', market: 1, name: '中国石化', tx: 'sh600028' },
  { code: '601988', market: 1, name: '中国银行', tx: 'sh601988' },
];

async function fetchKlineTx(tx, fq) {
  // 腾讯 fqkline：fq='' 不复权 / 'qfq' 前复权；不复权限 2000 根，统一 2000 公平对比
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tx},day,,,2000,${fq}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://gu.qq.com/' } });
  const j = await r.json();
  const d = j && j.data && j.data[tx];
  const arr = (d && (d[fq + 'day'] || d.day)) || [];
  return arr.map(x => ({ d: x[0], close: parseFloat(x[2]) })).filter(x => x.close > 0);
}

function calcSeries(klines, W) {
  const series = [];
  for (let i = 0; i < klines.length; i++) {
    if (i < W - 1) { series.push({ d: klines[i].d, pct: null }); continue; }
    const win = klines.slice(i - W + 1, i + 1).map(x => x.close).sort((a, b) => a - b);
    let less = 0; for (const v of win) { if (v <= klines[i].close) less++; }
    series.push({ d: klines[i].d, pct: less / W * 100 });
  }
  return series;
}
function findEvents(series, tier) {
  const ev = []; let inZ = false, start = null;
  for (const x of series) {
    if (x.pct == null) continue;
    if (x.pct >= tier) { if (!inZ) { inZ = true; start = x.d; } }
    else { if (inZ) { ev.push(start); inZ = false; } }
  }
  if (inZ) ev.push(start);
  return ev;
}
function buyAfterN(klines, buyD, years) {
  const bi = klines.findIndex(x => x.d >= buyD);
  if (bi < 0) return null;
  const bp = klines[bi].close;
  const ti = klines.findIndex(x => x.d >= addDays(buyD, years * 365));
  if (ti < 0) return null;
  return (klines[ti].close - bp) / bp * 100;
}
function addDays(dStr, days) { const d = new Date(dStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }

async function main() {
  console.log('=== 不复权 vs 前复权：W500 分位对比（真实数据） ===');
  const rows = [];
  for (const s of STOCKS) {
    let raw, qfq;
    try {
      raw = await fetchKlineTx(s.tx, '');
      qfq = await fetchKlineTx(s.tx, 'qfq');
    } catch (e) { console.log(`❌ ${s.name}: ${e.message}`); continue; }
    const serRaw = calcSeries(raw, 500), serQfq = calcSeries(qfq, 500);
    const curRaw = serRaw[serRaw.length - 1].pct, curQfq = serQfq[serQfq.length - 1].pct;
    // 全部历史日期的分位差异（仅两口径都有值的日期）
    const diffs = [];
    for (let i = 0; i < serRaw.length; i++) {
      const a = serRaw[i].pct, b = serQfq[i].pct;
      if (a != null && b != null) diffs.push(Math.abs(a - b));
    }
    const avgDiff = diffs.length ? diffs.reduce((s, x) => s + x, 0) / diffs.length : null;
    const bigDiff = diffs.filter(x => x > 10).length;
    const evRaw = findEvents(serRaw, 80).length, evQfq = findEvents(serQfq, 80).length;
    rows.push({ name: s.name, curRaw, curQfq, avgDiff, bigDiff, evRaw, evQfq, n: diffs.length });
    console.log(`${s.name.padEnd(6)} 当前分位 不复权=${curRaw != null ? curRaw.toFixed(1) : '—'} 前复权=${curQfq != null ? curQfq.toFixed(1) : '—'} | 历史平均偏差=${avgDiff != null ? avgDiff.toFixed(1) : '—'}pp 偏差>10pp天数=${bigDiff} | 80事件 不复权=${evRaw} 前复权=${evQfq}`);
  }
  // 极端案例：茅台/长电（高股息）单独看分位序列差异
  const zs = STOCKS.find(s => s.name === '招商银行');
  if (zs) {
    const raw = await fetchKlineTx(zs.tx, ''), qfq = await fetchKlineTx(zs.tx, 'qfq');
    const serRaw = calcSeries(raw, 500), serQfq = calcSeries(qfq, 500);
    console.log('\n=== 招商银行 分位序列对比（抽样每年末） ===');
    const years = {};
    serRaw.forEach((x, i) => {
      const y = x.d.slice(0, 4);
      if (x.d.slice(5, 10) === '12-31' || (i === serRaw.length - 1)) years[y] = { raw: x.pct, qfq: serQfq[i].pct };
    });
    Object.entries(years).forEach(([y, v]) => console.log(y, '不复权=' + (v.raw != null ? v.raw.toFixed(1) : '—'), '前复权=' + (v.qfq != null ? v.qfq.toFixed(1) : '—')));
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
