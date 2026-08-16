const fs = require('fs');
const vm = require('vm');

// 回测核心（index.html）
const src = fs.readFileSync('index.html', 'utf8');
const start = src.indexOf('/* ================= 回测核心');
const end = src.indexOf('/* ================= 渲染');
const core = src.slice(start, end);
const sandbox = {};
sandbox.window = sandbox; sandbox.console = console; sandbox.location = { search: '' };
sandbox.document = { write: ()=>{} }; sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.simulate = simulate;', sandbox);

// 数据层核心函数
const src2 = fs.readFileSync('data-layer.js', 'utf8');
const s2 = src2.indexOf('const DIV_COLS');
const e2 = src2.indexOf('/* ---------- 对外导出 ----------');
const sandbox2 = {};
sandbox2.window = sandbox2; sandbox2.setTimeout = setTimeout; sandbox2.clearTimeout = clearTimeout;
vm.createContext(sandbox2);
vm.runInContext(src2.slice(s2, e2) + '\nthis.parseDivs = parseDivs; this.dedupDividends = dedupDividends; ', sandbox2);

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
(async () => {
  const divs = sandbox2.dedupDividends(sandbox2.parseDivs(await fetchEm('601398')));
  const kline = await fetchKlineTx('sh601398', '2016-08-16', '2026-08-16');
  console.log('K线点数:', Object.keys(kline).length, '最新收盘:', kline['2026-08-14'] || kline['2026-08-13']);
  const r = sandbox.simulate(1000000, '2016-08-16', true, kline, divs, 0);
  const f = r.final;
  console.log('\n=== 工行回测(100万·复投·10年) ===');
  console.log('期末总资产:', f.finalValue.toLocaleString(), '累计投入:', f.finalInvested.toLocaleString(), '累计分红:', f.totalDiv.toLocaleString());
  console.log('XIRR:', (f.xirr*100).toFixed(2)+'%');
  console.log('\n=== 每年分红（到账年） ===');
  r.years.forEach(y => console.log(`${y.year}: ${Math.round(y.divTotal).toLocaleString()}元 ${y.divCount}笔  rate(相对投入)=${(y.rate*100).toFixed(2)}%  rate0(相对本金)=${(y.rate0*100).toFixed(2)}%`));
  console.log('\n=== 分红事件近10条 ===');
  r.divEvents.slice(-10).forEach(e => console.log(`${e.date} 到账年=${e.year} 报告期年=${e.reportYear} cash=${Math.round(e.cash).toLocaleString()}元`));
})().catch(e => console.error('ERR', e.message));
