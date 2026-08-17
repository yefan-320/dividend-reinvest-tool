#!/usr/bin/env node
/* 完整对比：① 40只 × 5窗口完整表 ② 档位对比（375窗口下 80/85/90/95 触发）——验证"窗口是二阶、档位是一阶" */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const STOCKS = [
  { code: '600036', name: '招商银行', tx: 'sh600036' }, { code: '601398', name: '工商银行', tx: 'sh601398' },
  { code: '601988', name: '中国银行', tx: 'sh601988' }, { code: '601288', name: '农业银行', tx: 'sh601288' },
  { code: '601328', name: '交通银行', tx: 'sh601328' }, { code: '600016', name: '民生银行', tx: 'sh600016' },
  { code: '000001', name: '平安银行', tx: 'sz000001' }, { code: '601166', name: '兴业银行', tx: 'sh601166' },
  { code: '600519', name: '贵州茅台', tx: 'sh600519' }, { code: '000858', name: '五粮液', tx: 'sz000858' },
  { code: '000895', name: '双汇发展', tx: 'sz000895' }, { code: '600887', name: '伊利股份', tx: 'sh600887' },
  { code: '601318', name: '中国平安', tx: 'sh601318' }, { code: '601628', name: '中国人寿', tx: 'sh601628' },
  { code: '601601', name: '中国太保', tx: 'sh601601' },
  { code: '600900', name: '长江电力', tx: 'sh600900' }, { code: '600886', name: '国投电力', tx: 'sh600886' },
  { code: '600027', name: '华电国际', tx: 'sh600027' }, { code: '600795', name: '国电电力', tx: 'sh600795' },
  { code: '601985', name: '中国核电', tx: 'sh601985' },
  { code: '600028', name: '中国石化', tx: 'sh600028' }, { code: '601857', name: '中国石油', tx: 'sh601857' },
  { code: '601088', name: '中国神华', tx: 'sh601088' }, { code: '600188', name: '兖矿能源', tx: 'sh600188' },
  { code: '601225', name: '陕西煤业', tx: 'sh601225' },
  { code: '000651', name: '格力电器', tx: 'sz000651' }, { code: '000333', name: '美的集团', tx: 'sz000333' },
  { code: '600690', name: '海尔智家', tx: 'sh600690' }, { code: '000100', name: 'TCL科技', tx: 'sz000100' },
  { code: '600585', name: '海螺水泥', tx: 'sh600585' }, { code: '601668', name: '中国建筑', tx: 'sh601668' },
  { code: '601390', name: '中国中铁', tx: 'sh601390' }, { code: '600031', name: '三一重工', tx: 'sh600031' },
  { code: '601006', name: '大秦铁路', tx: 'sh601006' }, { code: '600104', name: '上汽集团', tx: 'sh600104' },
  { code: '600019', name: '宝钢股份', tx: 'sh600019' }, { code: '601899', name: '紫金矿业', tx: 'sh601899' },
  { code: '601600', name: '中国铝业', tx: 'sh601600' }, { code: '600009', name: '上海机场', tx: 'sh600009' },
  { code: '601111', name: '中国国航', tx: 'sh601111' },
];
const WINDOWS = [250, 375, 500, 750, 1000];
const TIERS = [80, 85, 90, 95];
const HOLD = [5, 10];
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
  if (!j.result || !j.result.data) { if (tryN < 5) { await new Promise(r2 => setTimeout(r2, tryN * 4000)); return fetchDivs(code, tryN + 1); } return []; }
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
    await new Promise(r => setTimeout(r, 800));
    try {
      const klines = await fetchKlineSina(s.tx);
      const divs = await fetchDivs(s.code);
      if (!divs.length) { continue; }
      const km = {}; klines.forEach(x => km[x.d] = x.close);
      all.push({ ...s, klines, divs, km });
    } catch (e) { }
  }
  console.log(`有效 ${all.length} 只\n`);

  // ① 完整窗口表（40只）
  console.log('=== ① 完整窗口对比（40只，价格+分红） ===');
  console.log('窗口  5年中位(n)  5年胜率  10年中位(n)  10年胜率');
  for (const W of WINDOWS) {
    const a5 = [], a10 = [];
    for (const s of all) {
      const ser = DL.calcRollingPercentile(s.km, s.divs, W);
      for (const ev of DL.findZoneEvents(ser, 80)) {
        const r5 = buyAfterNDiv(s.klines, s.divs, ev.start, 5); if (r5 != null) a5.push(r5);
        const r10 = buyAfterNDiv(s.klines, s.divs, ev.start, 10); if (r10 != null) a10.push(r10);
      }
    }
    const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
    const win = a => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '—';
    console.log(String(W).padEnd(6), (med(a5) != null ? med(a5).toFixed(1) : '—').padEnd(9) + `(${a5.length})`, win(a5).padEnd(6), (med(a10) != null ? med(a10).toFixed(1) : '—').padEnd(9) + `(${a10.length})`, win(a10));
  }

  // ② 档位对比（375窗口，80/85/90/95 触发）
  console.log('\n=== ② 档位对比（375窗口，一阶问题验证） ===');
  console.log('档位  5年中位(n)  5年胜率  10年中位(n)  10年胜率');
  for (const T of TIERS) {
    const a5 = [], a10 = [];
    for (const s of all) {
      const ser = DL.calcRollingPercentile(s.km, s.divs, 375);
      for (const ev of DL.findZoneEvents(ser, T)) {
        const r5 = buyAfterNDiv(s.klines, s.divs, ev.start, 5); if (r5 != null) a5.push(r5);
        const r10 = buyAfterNDiv(s.klines, s.divs, ev.start, 10); if (r10 != null) a10.push(r10);
      }
    }
    const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
    const win = a => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '—';
    console.log(String(T).padEnd(5), (med(a5) != null ? med(a5).toFixed(1) : '—').padEnd(9) + `(${a5.length})`, win(a5).padEnd(6), (med(a10) != null ? med(a10).toFixed(1) : '—').padEnd(9) + `(${a10.length})`, win(a10));
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
