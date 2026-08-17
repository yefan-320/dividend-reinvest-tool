#!/usr/bin/env node
/* 前复权口径全量重跑：15 只 × 6 窗口 × 1/3/5/10 年（对照旧不复权口径）
 * 触发事件：前复权分位（本地减差法）≥80
 * 收益：不复权价差（与旧口径可比）+ 分红补偿对照
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
const WINDOWS = [125, 250, 375, 500, 750, 1000];
const HOLD = [1, 3, 5, 10];
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
function addDays(dStr, days) { const d = new Date(dStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function buyAfterN(klines, buyD, years) {
  const bi = klines.findIndex(x => x.d >= buyD);
  if (bi < 0) return null;
  const bp = klines[bi].close;
  const ti = klines.findIndex(x => x.d >= addDays(buyD, years * 365));
  if (ti < 0) return null;
  return { ret: (klines[ti].close - bp) / bp * 100, annual: (Math.pow(klines[ti].close / bp, 1 / years) - 1) * 100 };
}

async function main() {
  const all = [];
  for (const s of STOCKS) {
    try {
      const klines = await fetchKlineSina(s.tx);
      const divs = await fetchDivs(s.code);
      const qfq = localQfq(klines, divs);
      all.push({ ...s, klines, qfq, divs });
      console.log(`✅ ${s.name}`);
    } catch (e) { console.log(`❌ ${s.name}: ${e.message}`); }
  }
  console.log(`\n有效 ${all.length} 只。前复权分位触发 80 事件：`);

  // 主表（与旧口径同构）
  console.log('\n=== 前复权分位 · 窗口 × 持有年限（收益=中位数，不复权价差口径） ===');
  const header = ['窗口'].concat(HOLD.map(h => `${h}年收益(n)`), HOLD.map(h => `${h}年胜率`));
  console.log(header.join(' | '));
  for (const W of WINDOWS) {
    const cells = [];
    for (const h of HOLD) {
      const arr = [];
      for (const s of all) {
        const ser = calcSeries(s.qfq, W);
        for (const ev of findEvents(ser, 80)) {
          const r = buyAfterN(s.klines, ev, h);
          if (r) arr.push(r.ret);
        }
      }
      const med = arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;
      const win = arr.length ? (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0) + '%' : '—';
      cells.push(`${med != null ? med.toFixed(1) : '—'}(${arr.length})`, win);
    }
    console.log(String(W).padEnd(6), cells.join(' | '));
  }

  // 年化
  console.log('\n=== 年化收益（前复权分位触发） ===');
  console.log('窗口  5年年化(中位)  10年年化(中位)  10年样本');
  for (const W of WINDOWS) {
    const a5 = [], a10 = [];
    for (const s of all) {
      const ser = calcSeries(s.qfq, W);
      for (const ev of findEvents(ser, 80)) {
        const r5 = buyAfterN(s.klines, ev, 5); if (r5) a5.push(r5.annual);
        const r10 = buyAfterN(s.klines, ev, 10); if (r10) a10.push(r10.annual);
      }
    }
    const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
    console.log(String(W).padEnd(6),
      (med(a5) != null ? med(a5).toFixed(2) + '%' : '—').padEnd(12),
      (med(a10) != null ? med(a10).toFixed(2) + '%' : '—').padEnd(14), a10.length);
  }

  // 与旧口径差异摘要：事件数对比
  console.log('\n=== 事件数：前复权 vs 不复权（80 分位，W500） ===');
  for (const s of all) {
    const serQ = calcSeries(s.qfq, 500), serR = calcSeries(s.klines, 500);
    console.log(`${s.name.padEnd(6)} 前复权=${findEvents(serQ, 80).length} 不复权=${findEvents(serR, 80).length}`);
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
