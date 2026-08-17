#!/usr/bin/env node
/* 工具真实口径窗口验证：股息率分位（calcRollingPercentile）× 窗口 × 持有年限
 * 这是工具实际信号的口径（之前窗口讨论用价格分位=实验口径，需在真实口径下重验）
 */
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
  const cols = 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,ASSIGN_PROGRESS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://data.eastmoney.com/', 'Accept': 'application/json, text/plain, */*' } });
  const j = await r.json();
  if (!j.result || !j.result.data) { if (tryN < 4) { await new Promise(r2 => setTimeout(r2, tryN * 3000)); return fetchDivs(code, tryN + 1); } return []; }
  return (j.result.data || []).filter(x => x.EX_DIVIDEND_DATE && (x.ASSIGN_PROGRESS || '').indexOf('实施') >= 0)
    .map(x => ({ ex: x.EX_DIVIDEND_DATE.slice(0, 10), dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10, bonus: (parseFloat(x.BONUS_IT_RATIO) || 0) / 10 }));
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
function buyAfterNDiv(klines, divs, buyD, years) {
  // 价格差 + 持有期分红（主人口径：长期持有靠分红）
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
  console.log(`\n有效 ${all.length} 只。工具真实口径（股息率分位）触发 80 事件：\n`);
  console.log('=== 股息率分位 · 窗口 × 持有年限（收益=中位数，不复权价差+分红补偿） ===');
  const header = ['窗口'].concat(HOLD.map(h => `${h}年(n)`), HOLD.map(h => `${h}年胜率`));
  console.log(header.join(' | '));
  for (const W of WINDOWS) {
    const cells = [];
    for (const h of HOLD) {
      const arr = [];
      for (const s of all) {
        const ser = DL.calcRollingPercentile(s.km, s.divs, W);
        const evs = DL.findZoneEvents(ser, 80);
        if (W === 500 && h === 1 && s.name === '招商银行') console.log('[dbg]', s.name, 'W=500 ser=', ser.length, 'evs=', evs.length, 'over80=', ser.filter(x => x.pct != null && x.pct >= 80).length);
        for (const ev of evs) {
          const r = buyAfterN(s.klines, ev.start, h);
          if (r) arr.push(r.ret);
        }
      }
      const med = arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;
      const win = arr.length ? (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0) + '%' : '—';
      cells.push(`${med != null ? med.toFixed(1) : '—'}(${arr.length})`, win);
    }
    console.log(String(W).padEnd(6), cells.join(' | '));
  }
  console.log('\n=== 年化（长期持有视角） ===');
  console.log('窗口  5年年化(中位)  10年年化(中位)  10年样本');
  for (const W of WINDOWS) {
    const a5 = [], a10 = [];
    for (const s of all) {
      const ser = DL.calcRollingPercentile(s.km, s.divs, W);
      for (const ev of DL.findZoneEvents(ser, 80)) {
        const r5 = buyAfterN(s.klines, ev.start, 5); if (r5) a5.push(r5.annual);
        const r10 = buyAfterN(s.klines, ev.start, 10); if (r10) a10.push(r10.annual);
      }
    }
    const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
    console.log(String(W).padEnd(6), (med(a5) != null ? med(a5).toFixed(2) + '%' : '—').padEnd(12), (med(a10) != null ? med(a10).toFixed(2) + '%' : '—').padEnd(14), a10.length);
  }
  // 当前分位（工具口径）各窗口
  console.log('\n=== 当前分位（股息率口径）窗口敏感性 ===');
  for (const s of all.slice(0, 8)) {
    let line = s.name.padEnd(6);
    for (const W of WINDOWS) {
      const ser = DL.calcRollingPercentile(s.km, s.divs, W);
      const last = ser[ser.length - 1];
      line += ` W${W}:${last.pct != null ? last.pct.toFixed(0) : '—'}`;
    }
    console.log(line);
  }
}


main().catch(e => { console.error('FATAL', e); process.exit(1); });
