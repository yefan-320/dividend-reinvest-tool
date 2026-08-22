#!/usr/bin/env node
/* R5b 分红视角验证（主人核心关切）：买后 5/10 年累计分红 ÷ 买入价，按窗口分组
 * 用工具真实分红逻辑（东财 RPT_SHAREBONUS_DET，fetchDividendsOne 同源接口）
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;

const STOCKS = [
  { code: '600036', market: 1, name: '招商银行' }, { code: '601398', market: 1, name: '工商银行' },
  { code: '600519', market: 1, name: '贵州茅台' }, { code: '601318', market: 1, name: '中国平安' },
  { code: '600900', market: 1, name: '长江电力' }, { code: '000001', market: 0, name: '平安银行' },
  { code: '600028', market: 1, name: '中国石化' }, { code: '601988', market: 1, name: '中国银行' },
  { code: '000651', market: 0, name: '格力电器' }, { code: '000333', market: 0, name: '美的集团' },
  { code: '600585', market: 1, name: '海螺水泥' }, { code: '601088', market: 1, name: '中国神华' },
  { code: '601006', market: 1, name: '大秦铁路' }, { code: '000895', market: 0, name: '双汇发展' },
  { code: '600104', market: 1, name: '上汽集团' },
];
const WINDOWS = [250, 375, 500, 750, 1000];

async function fetchKline(code, market) {
  const sym = (market === 1 ? 'sh' : 'sz') + code;
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  return JSON.parse(await r.text()).map(x => ({ d: x.day, close: parseFloat(x.close) })).filter(x => x.close > 0);
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

async function fetchDivsDirect(code) {
  // 东财 RPT_SHAREBONUS_DET 直连（Node 无 document，绕过 jsonp）
  const cols = 'SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,ASSIGN_PROGRESS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://data.eastmoney.com/' } });
  const j = await r.json();
  const rows = (j && j.result && j.result.data) || [];
  return rows.map(x => ({ ex: (x.EX_DIVIDEND_DATE || '').slice(0, 10), dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10 })).filter(x => x.ex && x.dps > 0);
}

async function main() {
  const all = [];
  for (const s of STOCKS) {
    try {
      const k = await fetchKline(s.code, s.market);
      const divs = await fetchDivsDirect(s.code);
      all.push({ ...s, klines: k, divs });
      console.log(`✅ ${s.name}: K线${k.length}根 分红${divs.length}条`);
    } catch (e) { console.log(`❌ ${s.name}: ${e.message}`); }
  }
  // 买后 5/10 年累计分红（除息日在持有期内的 dps 之和）÷ 买入价
  console.log('\n=== 分红视角：买后累计分红 ÷ 买入价（中位数，含分红收益率年化参考） ===');
  console.log('窗口  5年分红回本率(中位)  5年样本  10年分红回本率(中位)  10年样本');
  for (const W of WINDOWS) {
    const d5 = [], d10 = [];
    for (const s of all) {
      const ser = calcSeries(s.klines, W);
      for (const ev of findEvents(ser, 80)) {
        const bi = s.klines.findIndex(x => x.d >= ev);
        if (bi < 0) continue;
        const bp = s.klines[bi].close;
        const end5 = addDays(ev, 5 * 365), end10 = addDays(ev, 10 * 365);
        let sum5 = 0, sum10 = 0, ok5 = false, ok10 = false;
        for (const dv of s.divs) {
          if (!dv.ex || !(dv.dps > 0)) continue;
          if (dv.ex >= ev && dv.ex <= end5) { sum5 += dv.dps; ok5 = true; }
          if (dv.ex >= ev && dv.ex <= end10) { sum10 += dv.dps; ok10 = true; }
        }
        if (ok5 && bp > 0) d5.push(sum5 / bp * 100);
        if (ok10 && bp > 0) d10.push(sum10 / bp * 100);
      }
    }
    const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
    console.log(String(W).padEnd(6),
      (med(d5) != null ? med(d5).toFixed(1) + '%' : '—').padEnd(14), String(d5.length).padEnd(8),
      (med(d10) != null ? med(d10).toFixed(1) + '%' : '—').padEnd(16), d10.length);
  }
  // 示例：招行 2016 年买入（500 天触发）分红回本明细
  console.log('\n=== 示例：招商银行 500天窗口最近一次 80 分位事件 ===');
  const zs = all.find(s => s.code === '600036');
  if (zs) {
    const ser = calcSeries(zs.klines, 500);
    const evs = findEvents(ser, 80);
    const last = evs[evs.length - 1];
    const bi = zs.klines.findIndex(x => x.d >= last);
    const bp = zs.klines[bi].close;
    let sum = 0;
    const rows = [];
    for (const dv of zs.divs) { if (dv.ex && dv.ex >= last && dv.dps > 0) { sum += dv.dps; rows.push(`${dv.ex} 每股${dv.dps}元`); } }
    console.log(`事件日 ${last}，买入价 ${bp}，至今累计分红 ${sum.toFixed(2)} 元/股 = 分红回本 ${(sum / bp * 100).toFixed(1)}%`);
    console.log('分红明细:', rows.slice(-6).join('；'));
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
