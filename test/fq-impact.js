#!/usr/bin/env node
/* 问题严重性实测：不复权分位 vs 前复权分位（本地减差法，已与腾讯qfq验证一致）
 * 15 只高股息股 × 2010-2026，W500 分位对比：
 * ① 当前分位差异 ② 历史平均偏差 ③ 80 分位触发事件差异（假信号率）
 * ④ 股息率(近12月分红/现价) 与 分位偏差 的相关性（验证"高股息=假便宜"假说）
 */
const STOCKS = [
  { code: '600036', name: '招商银行', tx: 'sh600036' }, { code: '601398', name: '工商银行', tx: 'sh601398' },
  { code: '600519', name: '贵州茅台', tx: 'sh600519' }, { code: '601318', name: '中国平安', tx: 'sh601318' },
  { code: '600900', name: '长江电力', tx: 'sh600900' }, { code: '000001', name: '平安银行', tx: 'sz000001' },
  { code: '600028', name: '中国石化', tx: 'sh600028' }, { code: '601988', name: '中国银行', tx: 'sh601988' },
  { code: '000651', name: '格力电器', tx: 'sz000651' }, { code: '000333', name: '美的集团', tx: 'sz000333' },
  { code: '600585', name: '海螺水泥', tx: 'sh600585' }, { code: '601088', name: '中国神华', tx: 'sh601088' },
  { code: '601006', name: '大秦铁路', tx: 'sh601006' }, { code: '000895', name: '双汇发展', tx: 'sz000895' },
  { code: '600104', name: '上汽集团', tx: 'sh600104' },
];
async function fetchKlineSina(tx) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tx}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  return JSON.parse(await r.text()).map(x => ({ d: x.day, close: parseFloat(x.close) })).filter(x => x.close > 0);
}
async function fetchDivs(code) {
  const cols = 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,ASSIGN_PROGRESS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://data.eastmoney.com/' } });
  const j = await r.json();
  return (j && j.result && j.result.data || []).filter(x => x.EX_DIVIDEND_DATE && (x.ASSIGN_PROGRESS || '').indexOf('实施') >= 0)
    .map(x => ({ ex: x.EX_DIVIDEND_DATE.slice(0, 10), dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10, bonus: (parseFloat(x.BONUS_IT_RATIO) || 0) / 10 }));
}
function localQfq(klines, divs) {
  const ks = [...klines].sort((a, b) => a.d < b.d ? -1 : 1);
  const dates = ks.map(x => x.d);
  const price = {}; ks.forEach(x => price[x.d] = x.close);
  const exDivs = divs.filter(d => d.ex && d.ex >= dates[0] && d.ex <= dates[dates.length - 1]);
  exDivs.sort((a, b) => a.ex < b.ex ? -1 : 1);
  let sum = 0, mul = 1;
  const out = {};
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    out[d] = price[d] * mul - sum;
    const ex = exDivs.find(x => x.ex === d);
    if (ex) { sum += ex.dps; if (ex.bonus > 0) mul /= (1 + ex.bonus); }
  }
  return dates.map(d => ({ d, close: out[d] }));
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
  return { ret: (klines[ti].close - bp) / bp * 100, buyP: bp };
}
function addDays(dStr, days) { const d = new Date(dStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }

async function main() {
  console.log('=== 不复权 vs 前复权：W500 分位（15 只 × 2010-2026 真实数据） ===');
  const rows = [];
  for (const s of STOCKS) {
    let klines, divs;
    try { klines = await fetchKlineSina(s.tx); divs = await fetchDivs(s.code); }
    catch (e) { console.log(`❌ ${s.name}: ${e.message}`); continue; }
    const qfq = localQfq(klines, divs);
    const serRaw = calcSeries(klines, 500), serQfq = calcSeries(qfq, 500);
    const curRaw = serRaw[serRaw.length - 1].pct, curQfq = serQfq[serQfq.length - 1].pct;
    // 历史平均偏差 + 偏差>10pp 占比
    let sumDiff = 0, n = 0, big = 0;
    for (let i = 0; i < serRaw.length; i++) {
      const a = serRaw[i].pct, b = serQfq[i].pct;
      if (a != null && b != null) { const dd = Math.abs(a - b); sumDiff += dd; n++; if (dd > 10) big++; }
    }
    // 触发事件差异
    const evRaw = findEvents(serRaw, 80), evQfq = findEvents(serQfq, 80);
    const onlyRaw = evRaw.filter(d => !evQfq.includes(d)).length;  // 不复权独有（假信号）
    const onlyQfq = evQfq.filter(d => !evRaw.includes(d)).length;
    // 近12月股息率（近似：近一年分红/现价）
    const lastP = klines[klines.length - 1].close;
    const lastYear = addDays(klines[klines.length - 1].d, -365);
    const div1y = divs.filter(d => d.ex >= lastYear).reduce((s, d) => s + d.dps, 0);
    const dy = lastP > 0 ? div1y / lastP * 100 : null;
    rows.push({ name: s.name, curRaw, curQfq, avgDiff: sumDiff / n, bigPct: big / n * 100, evRaw: evRaw.length, evQfq: evQfq.length, onlyRaw, onlyQfq, dy });
    console.log(`${s.name.padEnd(6)} 当前: 不复权=${curRaw != null ? curRaw.toFixed(1) : '—'} 前复权=${curQfq != null ? curQfq.toFixed(1) : '—'} | 历史均偏=${(sumDiff / n).toFixed(1)}pp 偏>10pp占${(big / n * 100).toFixed(0)}% | 80事件: 不=${evRaw.length} 前=${evQfq.length} 假信号=${onlyRaw} 漏检=${onlyQfq} | 股息率=${dy != null ? dy.toFixed(1) : '—'}%`);
  }
  // 相关性：股息率 vs 当前分位偏差
  const withDy = rows.filter(r => r.dy != null && r.curRaw != null && r.curQfq != null);
  const corr = withDy.length > 2 ? (() => {
    const n = withDy.length;
    const mx = withDy.reduce((s, r) => s + r.dy, 0) / n, my = withDy.reduce((s, r) => s + Math.abs(r.curRaw - r.curQfq), 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    withDy.forEach(r => { sxy += (r.dy - mx) * (Math.abs(r.curRaw - r.curQfq) - my); sxx += (r.dy - mx) ** 2; syy += (Math.abs(r.curRaw - r.curQfq) - my) ** 2; });
    return sxy / Math.sqrt(sxx * syy);
  })() : null;
  console.log(`\n股息率 vs 分位偏差 相关系数: ${corr != null ? corr.toFixed(3) : '—'}（>0.5=高股息股确实更容易假便宜）`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
