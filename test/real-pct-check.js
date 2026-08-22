#!/usr/bin/env node
/* 工具真实口径验证：calcRollingPercentile（股息率分位）输入不复权 vs 前复权价格
 * 问题：工具实际显示的分位 = 股息率分位（TTM分红/价格），价格输入用不复权 or 前复权，分位差多少？
 * 同时检查除息锁定/5日均线平滑的影响
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;

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
async function fetchDivs(code, tryN = 1) {
  const cols = 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,ASSIGN_PROGRESS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://data.eastmoney.com/', 'Accept': 'application/json, text/plain, */*' } });
  const j = await r.json();
  if (!j.result || !j.result.data) {
    if (tryN < 4) { await new Promise(r2 => setTimeout(r2, tryN * 3000)); return fetchDivs(code, tryN + 1); }
    return [];
  }
  return (j.result.data || []).filter(x => x.EX_DIVIDEND_DATE && (x.ASSIGN_PROGRESS || '').indexOf('实施') >= 0)
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

async function main() {
  console.log('=== 工具真实口径（股息率分位 calcRollingPercentile）：不复权 vs 前复权输入 ===');
  console.log('股票      当前分位(不复权)  当前分位(前复权)  差   | 历史均偏  偏>10pp% | 80事件: 不/前');
  let corrSum = 0, corrN = 0;
  for (const s of STOCKS) {
    await new Promise(r => setTimeout(r, 1500));   // 节流防限流
    let klines, divs;
    try { klines = await fetchKlineSina(s.tx); divs = await fetchDivs(s.code); }
    catch (e) { console.log(`❌ ${s.name}: ${e.message}`); continue; }
    if (!divs.length) { console.log(`${s.name}: ⚠️ 分红数据为空（限流），跳过`); continue; }
    const qfq = localQfq(klines, divs);
    // 转工具格式 {date: close}
    const km = {}; klines.forEach(x => km[x.d] = x.close);
    const qm = {}; qfq.forEach(x => qm[x.d] = x.close);
    // 工具股息率分位（真实函数）
    const serRaw = DL.calcRollingPercentile(km, divs, 500);
    const serQfq = DL.calcRollingPercentile(qm, divs, 500);
    if (!serRaw.length || !serQfq.length || serRaw[serRaw.length-1].pct == null || serQfq[serQfq.length-1].pct == null) {
      console.log(`${s.name}: ⚠️ 序列异常 raw=${serRaw.length} qfq=${serQfq.length} lastPct=${serRaw.length ? serRaw[serRaw.length-1].pct : '—'}/${serQfq.length ? serQfq[serQfq.length-1].pct : '—'} divs=${divs.length}`);
      continue;
    }
    const curRaw = serRaw[serRaw.length - 1].pct, curQfq = serQfq[serQfq.length - 1].pct;
    // 历史偏差
    let sumD = 0, n = 0, big = 0;
    for (let i = 0; i < serRaw.length; i++) {
      const a = serRaw[i].pct, b = serQfq[i].pct;
      if (a != null && b != null) { const d = Math.abs(a - b); sumD += d; n++; if (d > 10) big++; }
    }
    // 触发事件（工具 findZoneEvents）
    const evRaw = DL.findZoneEvents(serRaw, 80).length, evQfq = DL.findZoneEvents(serQfq, 80).length;
    corrSum += Math.abs(curRaw - curQfq); corrN++;
    console.log(`${s.name.padEnd(6)} ${curRaw != null ? curRaw.toFixed(1).padStart(5) : '—'}       ${curQfq != null ? curQfq.toFixed(1).padStart(5) : '—'}   ${curRaw != null && curQfq != null ? (curQfq - curRaw >= 0 ? '+' : '') + (curQfq - curRaw).toFixed(1) : '—'} | ${(sumD / n).toFixed(1)}pp   ${(big / n * 100).toFixed(0)}% | ${evRaw}/${evQfq}`);
  }
  console.log(`\n平均当前分位偏差: ${(corrSum / corrN).toFixed(1)}pp`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
