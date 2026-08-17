#!/usr/bin/env node
/* 分红口径最终验证：股息率分位事件 × 价格+分红收益（主人视角）
 * 窗口对比（15 只 × 2010-2026，工具真实 calcRollingPercentile） */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
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
const WINDOWS = [250, 375, 500, 750, 1000];
const HOLD = [1, 3, 5, 10];
async function fetchKlineSina(tx) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tx}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  return JSON.parse(await r.text()).map(x => ({ d: x.day, close: parseFloat(x.close) })).filter(x => x.close > 0);
}
async function fetchDivs(code, tryN = 1) {
  const cols = 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,ASSIGN_PROGRESS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://data.eastmoney.com/', 'Accept': 'application/json, text/plain, */*' } });
  const j = await r.json();
  if (!j.result || !j.result.data) { if (tryN < 4) { await new Promise(r2 => setTimeout(r2, tryN * 3000)); return fetchDivs(code, tryN + 1); } return []; }
  return (j.result.data || []).filter(x => x.EX_DIVIDEND_DATE && (x.ASSIGN_PROGRESS || '').indexOf('实施') >= 0).map(x => ({ ex: x.EX_DIVIDEND_DATE.slice(0, 10), dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10 }));
}
function addDays(dStr, days) { const d = new Date(dStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function buyAfterNDiv(klines, divs, buyD, years) {
  const bi = klines.findIndex(x => x.d >= buyD);
  if (bi < 0) return null;
  const bp = klines[bi].close;
  const endD = addDays(buyD, years * 365);
  const ti = klines.findIndex(x => x.d >= endD);
  if (ti < 0) return null;
  let divSum = 0;
  for (const dv of divs) { if (dv.ex && dv.ex >= buyD && dv.ex <= endD) divSum += dv.dps; }
  return (klines[ti].close - bp + divSum) / bp * 100;
}
async function main() {
  const all = [];
  for (const s of STOCKS) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const klines = await fetchKlineSina(s.tx);
      const divs = await fetchDivs(s.code);
      if (!divs.length) { console.log(`⚠️ ${s.name} 分红空`); continue; }
      const km = {}; klines.forEach(x => km[x.d] = x.close);
      all.push({ ...s, klines, divs, km });
      console.log(`✅ ${s.name}`);
    } catch (e) { console.log(`❌ ${s.name}: ${e.message}`); }
  }
  console.log(`\n有效 ${all.length} 只。股息率分位 80 事件 × 价格+分红收益（主人口径）：\n`);
  console.log('窗口  1年(中位/n/胜率)    3年(中位/n/胜率)    5年(中位/n/胜率)    10年(中位/n/胜率)');
  for (const W of WINDOWS) {
    const cells = [];
    for (const h of HOLD) {
      const arr = [];
      for (const s of all) {
        const ser = DL.calcRollingPercentile(s.km, s.divs, W);
        for (const ev of DL.findZoneEvents(ser, 80)) {
          const r = buyAfterNDiv(s.klines, s.divs, ev.start, h);
          if (r != null) arr.push(r);
        }
      }
      if (!arr.length) { cells.push('—'); continue; }
      const sorted = [...arr].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const win = (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0) + '%';
      cells.push(`${med.toFixed(1)}%/${arr.length}/${win}`);
    }
    console.log(String(W).padEnd(6), cells.join('   '));
  }
  // 分红回本（5/10年累计分红/买入价）
  console.log('\n窗口  5年分红回本(中位)  10年分红回本(中位)');
  for (const W of WINDOWS) {
    const d5 = [], d10 = [];
    for (const s of all) {
      const ser = DL.calcRollingPercentile(s.km, s.divs, W);
      for (const ev of DL.findZoneEvents(ser, 80)) {
        const bi = s.klines.findIndex(x => x.d >= ev.start);
        if (bi < 0) continue;
        const bp = s.klines[bi].close;
        const e5 = addDays(ev.start, 5 * 365), e10 = addDays(ev.start, 10 * 365);
        let s5 = 0, s10 = 0, ok5 = false, ok10 = false;
        for (const dv of s.divs) {
          if (!dv.ex) continue;
          if (dv.ex >= ev.start && dv.ex <= e5) { s5 += dv.dps; ok5 = true; }
          if (dv.ex >= ev.start && dv.ex <= e10) { s10 += dv.dps; ok10 = true; }
        }
        if (ok5 && bp > 0) d5.push(s5 / bp * 100);
        if (ok10 && bp > 0) d10.push(s10 / bp * 100);
      }
    }
    const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
    console.log(String(W).padEnd(6), (med(d5) != null ? med(d5).toFixed(1) + '%' : '—').padEnd(10), (med(d10) != null ? med(d10).toFixed(1) + '%' : '—') + ` (n=${d10.length})`);
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
