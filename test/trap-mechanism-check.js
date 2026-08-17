#!/usr/bin/env node
/* R13 补验：① 阈值敏感性（15/18/20/22/25 五档类别成员变化）② 陷阱标的触发时点分布（下跌中 vs 反弹中） */
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
function priceAfter(klines, d, days) {
  const bi = klines.findIndex(x => x.d >= d);
  if (bi < 0) return null;
  const bp = klines[bi].close;
  const ti = klines.findIndex(x => x.d >= addDays(d, days));
  if (ti < 0) return null;
  return (klines[ti].close - bp) / bp * 100;
}
async function main() {
  const all = [];
  for (const s of STOCKS) {
    await new Promise(r => setTimeout(r, 600));
    try {
      const klines = await fetchKlineSina(s.tx);
      const divs = await fetchDivs(s.code);
      if (!divs.length) continue;
      const km = {}; klines.forEach(x => km[x.d] = x.close);
      const ser = DL.calcRollingPercentile(km, divs, 375);
      const evs90 = DL.findZoneEvents(ser, 90).map(e => e.start);
      const evs80 = DL.findZoneEvents(ser, 80).map(e => e.start);
      let gap90 = null;
      if (evs90.length > 1) {
        const gaps = [];
        for (let i = 1; i < evs90.length; i++) gaps.push((new Date(evs90[i]) - new Date(evs90[i-1])) / 86400000);
        gap90 = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
      }
      const r80 = [], r90 = [];
      for (const ev of evs80) { const r = buyAfterNDiv(klines, divs, ev, 5); if (r != null) r80.push(r); }
      for (const ev of evs90) { const r = buyAfterNDiv(klines, divs, ev, 5); if (r != null) r90.push(r); }
      const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
      const diff = med(r80) != null && med(r90) != null ? med(r90) - med(r80) : null;
      const waitYears = gap90 != null ? gap90 / 365 : null;
      const annual = diff != null && waitYears != null && waitYears > 0 ? diff / waitYears : null;
      // 陷阱机制：90档触发后60天价格变化（<0=下跌中=基本面型；>0=反弹中=反弹型）
      const after60 = [];
      for (const ev of evs90) { const r = priceAfter(klines, ev, 60); if (r != null) after60.push(r); }
      const med60 = med(after60);
      all.push({ ...s, gap90, diff: diff != null ? Math.round(diff * 10) / 10 : null, annual: annual != null ? Math.round(annual * 10) / 10 : null, n80: r80.length, n90: r90.length, med60: med60 != null ? Math.round(med60 * 10) / 10 : null });
    } catch (e) {}
  }

  // ① 阈值敏感性
  console.log('=== ① 阈值敏感性（年化等待收益分档，阈值变化→类别成员数） ===');
  console.log('阈值   可等90(>阈值)  边界(中间带)  直接买(<阈值)  陷阱(负值)');
  for (const t of [15, 18, 20, 22, 25]) {
    const canWait = all.filter(x => x.annual != null && x.annual > t && x.diff > 0).length;
    const trap = all.filter(x => x.diff != null && x.diff < 0).length;
    const direct = all.filter(x => x.annual != null && x.annual < t && x.diff >= 0).length;
    const mid = all.length - canWait - trap - direct;
    console.log(String(t).padEnd(6), String(canWait).padEnd(10), String(mid).padEnd(12), String(direct).padEnd(10), trap);
  }
  console.log('\n阈值 20 的成员变化（与 15/25 对比）：');
  const names = (t, cond) => all.filter(cond).map(x => x.name).join(' ');
  const c15 = all.filter(x => x.annual != null && x.annual > 15 && x.diff > 0).map(x => x.name);
  const c20 = all.filter(x => x.annual != null && x.annual > 20 && x.diff > 0).map(x => x.name);
  const c25 = all.filter(x => x.annual != null && x.annual > 25 && x.diff > 0).map(x => x.name);
  console.log('>15 比 >20 多的:', c15.filter(x => !c20.includes(x)).join(' ') || '无');
  console.log('>25 比 >20 少的:', c20.filter(x => !c25.includes(x)).join(' ') || '无');

  // ② 陷阱机制验证
  console.log('\n=== ② 12只陷阱标的：90档触发后60天价格变化（中位） ===');
  console.log('股票    差(pp)  触发后60天  机制判断');
  all.filter(x => x.diff != null && x.diff < 0).sort((a, b) => a.diff - b.diff).forEach(x => {
    const m = x.med60;
    const type = m != null && m < -5 ? '基本面恶化型(继续跌)' : m != null && m > 5 ? '反弹型(已反弹)' : '混合/震荡型';
    console.log(x.name.padEnd(6), String(x.diff).padEnd(7), (m != null ? m + '%' : '—').padEnd(10), type);
  });
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
