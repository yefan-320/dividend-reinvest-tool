#!/usr/bin/env node
/* 关键验证：股息率分位的正确输入是什么？
 * 工具现状：不复权价（TTM/真实市价=真实股息率）
 * 理想对照：除息日跳变消除版（除息日用前一日价格算 dy，消除分母跳变）
 * 等比前复权对照：历史 dy 是否虚高（分母被压缩）
 * 结论：① 工具现状偏差多大？② 前复权输入是不是反而错？
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;

const STOCKS = [
  { code: '600036', name: '招商银行', tx: 'sh600036' }, { code: '601398', name: '工商银行', tx: 'sh601398' },
  { code: '600519', name: '贵州茅台', tx: 'sh600519' }, { code: '600900', name: '长江电力', tx: 'sh600900' },
  { code: '000001', name: '平安银行', tx: 'sz000001' }, { code: '000651', name: '格力电器', tx: 'sz000651' },
  { code: '601088', name: '中国神华', tx: 'sh601088' }, { code: '000895', name: '双汇发展', tx: 'sz000895' },
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
// 等比法前复权（乘因子，不会负价格）
function qfqMult(klines, divs) {
  const ks = [...klines].sort((a, b) => a.d < b.d ? -1 : 1);
  const dates = ks.map(x => x.d);
  const price = {}; ks.forEach(x => price[x.d] = x.close);
  const exDivs = divs.filter(d => d.ex && d.ex >= dates[0] && d.ex <= dates[dates.length - 1]);
  exDivs.sort((a, b) => a.ex < b.ex ? -1 : 1);
  let factor = 1;
  const out = {};
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    out[d] = price[d] * factor;
    const ex = exDivs.find(x => x.ex === d);
    if (ex) {
      const prev = i > 0 ? price[dates[i - 1]] : null;
      if (prev && prev > 0) factor *= (prev - ex.dps) / (prev * (1 + ex.bonus));
    }
  }
  return dates.map(d => ({ d, close: out[d] }));
}
// 除息跳变消除版：除息日价格 = 前一日价格（分母不跳）
function noJump(klines, divs) {
  const ks = [...klines].sort((a, b) => a.d < b.d ? -1 : 1);
  const exSet = new Set(divs.filter(d => d.ex).map(d => d.ex));
  const out = {};
  for (let i = 0; i < ks.length; i++) {
    const d = ks[i].d;
    out[d] = exSet.has(d) && i > 0 ? ks[i - 1].close : ks[i].close;
  }
  return ks.map(x => ({ d: x.d, close: out[x.d] }));
}

async function main() {
  console.log('=== 股息率分位：工具现状(不复权) vs 除息跳变消除(理想) vs 等比前复权 ===');
  console.log('股票      现状分位  理想分位  差   等比分位  差(等比-现状)');
  let sumA = 0, sumB = 0, n = 0;
  for (const s of STOCKS) {
    await new Promise(r => setTimeout(r, 1200));
    let klines, divs;
    try { klines = await fetchKlineSina(s.tx); divs = await fetchDivs(s.code); }
    catch (e) { console.log(`❌ ${s.name}: ${e.message}`); continue; }
    if (!divs.length) { console.log(`${s.name}: 分红空(限流)`); continue; }
    const km = {}; klines.forEach(x => km[x.d] = x.close);
    const ideal = noJump(klines, divs); const im = {}; ideal.forEach(x => im[x.d] = x.close);
    const qm2 = qfqMult(klines, divs); const qm = {}; qm2.forEach(x => qm[x.d] = x.close);
    const sRaw = DL.calcRollingPercentile(km, divs, 500);
    const sIdeal = DL.calcRollingPercentile(im, divs, 500);
    const sQ = DL.calcRollingPercentile(qm, divs, 500);
    if (!sRaw.length || !sIdeal.length || !sQ.length) { console.log(`${s.name}: 序列空`); continue; }
    const cR = sRaw[sRaw.length - 1].pct, cI = sIdeal[sIdeal.length - 1].pct, cQ = sQ[sQ.length - 1].pct;
    if (cR == null || cI == null || cQ == null) { console.log(`${s.name}: pct空 raw=${cR} ideal=${cI} q=${cQ}`); continue; }
    sumA += Math.abs(cR - cI); sumB += Math.abs(cQ - cR); n++;
    console.log(`${s.name.padEnd(6)} ${cR.toFixed(1).padStart(5)}   ${cI.toFixed(1).padStart(5)}  ${(cI - cR >= 0 ? '+' : '') + (cI - cR).toFixed(1).padStart(4)}  ${cQ.toFixed(1).padStart(5)}   ${(cQ - cR >= 0 ? '+' : '') + (cQ - cR).toFixed(1).padStart(4)}`);
  }
  console.log(`\n平均：现状 vs 理想（除息跳变残留）=${(sumA / n).toFixed(1)}pp | 等比前复权 vs 现状=${(sumB / n).toFixed(1)}pp`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
