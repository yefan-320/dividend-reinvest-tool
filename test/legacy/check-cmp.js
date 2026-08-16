const fs = require('fs');
const vm = require('vm');

// 回测核心
const src = fs.readFileSync('index.html', 'utf8');
const start = src.indexOf('/* ================= 回测核心');
const end = src.indexOf('/* ================= 渲染');
const core = src.slice(start, end);
const sandbox = {};
sandbox.window = sandbox; sandbox.console = console; sandbox.location = { search: '' };
sandbox.document = { write: ()=>{} }; sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.simulate = simulate;', sandbox);

// 数据层核心
const src2 = fs.readFileSync('data-layer.js', 'utf8');
const s2 = src2.indexOf('const DIV_COLS');
const e2 = src2.indexOf('/* ---------- 对外导出 ----------');
const sandbox2 = {};
sandbox2.window = sandbox2; sandbox2.setTimeout = setTimeout; sandbox2.clearTimeout = clearTimeout;
vm.createContext(sandbox2);
vm.runInContext(src2.slice(s2, e2) + '\nthis.parseDivs = parseDivs; this.dedupDividends = dedupDividends; this.calcAnnualDivYield = calcAnnualDivYield;', sandbox2);

const DIV_COLS = 'SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,PLAN_NOTICE_DATE,NOTICE_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,IT_RATIO,ASSIGN_PROGRESS,IMPL_PLAN_PROFILE,BASIC_EPS,TOTAL_SHARES';
async function fetchEm(code) {
  const filter = `(SECURITY_CODE="${code}")`;
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${DIV_COLS}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent(filter)}`;
  const d = await (await fetch(url)).json();
  return (d && d.result && d.result.data) || [];
}
async function fetchKlineTx(code, start, end) {
  const map = {}; let cur = start; let guard = 0; let prevLast = null;
  while (cur < end && guard++ < 12) {
    const d0 = new Date(cur);
    const segEnd = new Date(Date.UTC(d0.getUTCFullYear() + 2, d0.getUTCMonth() + 6, d0.getUTCDate()));
    const endStr = segEnd > new Date(end) ? end : segEnd.toISOString().slice(0, 10);
    const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + code + ',day,' + cur + ',' + endStr + ',800,';
    let rows = [];
    try { const d = await (await fetch(url)).json(); const node = d && d.data && d.data[code]; rows = (node && node.day) || []; } catch (e) {}
    if (!rows.length) break;
    rows.forEach(r => { map[r[0]] = parseFloat(r[2]); });
    const last = rows[rows.length - 1][0];
    if (last >= end) break;
    if (last === prevLast) break;
    prevLast = last;
    const nd = new Date(last); nd.setDate(nd.getDate() + 1);
    cur = nd.toISOString().slice(0, 10);
  }
  return map;
}
function guessPrefix(code) { return /^6/.test(code) ? 'sh' + code : /^(0|3)/.test(code) ? 'sz' + code : /^5/.test(code) ? 'sh' + code : /^1/.test(code) ? 'sz' + code : code; }
async function cmpOne(code, name, start, end, monthly) {
  const kline = await fetchKlineTx(guessPrefix(code), start, end);
  const divs = sandbox2.dedupDividends(sandbox2.parseDivs(await fetchEm(code)));
  const res = sandbox.simulate(1000000, start, true, kline, divs, monthly);
  const f = res.final;
  let maxDD = 0, peak = -Infinity;
  res.daily.forEach(x => { if (x.value > peak) peak = x.value; const dd = (peak - x.value) / peak; if (dd > maxDD) maxDD = dd; });
  const lastPrice = f.lastClose;
  const dy = sandbox2.calcAnnualDivYield(divs, lastPrice);
  return { code, name, kline: Object.keys(kline).length, divs: divs.length, finalValue: f.finalValue, principal: f.principal, monthlyTotal: f.monthlyTotal||0, totalDiv: f.totalDiv, xirr: f.xirr, maxDD, lastPrice, yield12: dy ? dy.yieldPct : null, yieldYears: dy ? dy.years : null, divEvents: res.divEvents.slice(-6) };
}
(async () => {
  const start = '2021-08-12', end = '2026-08-16';
  console.log(`=== 对比 ${start} → ${end}（5年，100万，零月供） ===\n`);
  const r1 = await cmpOne('515080', '中证红利ETF招商', start, end, 0);
  console.log(`【${r1.name}】K线${r1.kline}点 分红${r1.divs}条`);
  console.log(`  期末总资产 ${Math.round(r1.finalValue).toLocaleString()} 累计投入 ${Math.round(r1.principal).toLocaleString()} 累计分红 ${Math.round(r1.totalDiv).toLocaleString()} XIRR ${(r1.xirr*100).toFixed(2)}% 最大回撤 ${(r1.maxDD*100).toFixed(2)}% 最新价 ${r1.lastPrice}`);
  console.log(`  年化股息率(近2财年) ${r1.yield12 != null ? r1.yield12.toFixed(2)+'%' : '—'} 年份:${JSON.stringify(r1.yieldYears)}`);
  r1.divEvents.forEach(e => console.log(`    分红 ${e.date} 到账年=${e.year} 报告期年=${e.reportYear} ${Math.round(e.cash).toLocaleString()}元`));
  console.log('');
  const r2 = await cmpOne('600036', '招商银行', start, end, 0);
  console.log(`【${r2.name}】K线${r2.kline}点 分红${r2.divs}条`);
  console.log(`  期末总资产 ${Math.round(r2.finalValue).toLocaleString()} 累计投入 ${Math.round(r2.principal).toLocaleString()} 累计分红 ${Math.round(r2.totalDiv).toLocaleString()} XIRR ${(r2.xirr*100).toFixed(2)}% 最大回撤 ${(r2.maxDD*100).toFixed(2)}% 最新价 ${r2.lastPrice}`);
  console.log(`  年化股息率(近2财年) ${r2.yield12 != null ? r2.yield12.toFixed(2)+'%' : '—'} 年份:${JSON.stringify(r2.yieldYears)}`);
  r2.divEvents.forEach(e => console.log(`    分红 ${e.date} 到账年=${e.year} 报告期年=${e.reportYear} ${Math.round(e.cash).toLocaleString()}元`));
})().catch(e => console.error('ERR', e.message));
