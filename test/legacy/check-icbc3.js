const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('index.html', 'utf8');
const start = src.indexOf('/* ================= 回测核心');
const end = src.indexOf('/* ================= 渲染');
const core = src.slice(start, end);
const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.location = { search: '' };
sandbox.document = { write: ()=>{} };
sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.simulate = simulate; this.calcXirr = calcXirr;', sandbox);

// 复用 check-icbc2 的取数逻辑
const fs2 = require('fs');
const src2 = fs2.readFileSync('data-layer.js', 'utf8');
const start2 = src2.indexOf('const DIV_COLS');
const end2 = src2.indexOf('/* ---------- 对外导出 ----------');
const core2 = src2.slice(start2, end2);
const sandbox2 = {};
sandbox2.window = sandbox2;
vm.createContext(sandbox2);
vm.runInContext(core2 + '\nthis.parseDivs = parseDivs; this.dedupDividends = dedupDividends;', sandbox2);

const DIV_COLS = 'SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,PLAN_NOTICE_DATE,NOTICE_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,IT_RATIO,ASSIGN_PROGRESS,IMPL_PLAN_PROFILE,BASIC_EPS,TOTAL_SHARES';
async function fetchEm(code) {
  const filter = `(SECURITY_CODE="${code}")`;
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${DIV_COLS}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent(filter)}`;
  const r = await fetch(url);
  const d = await r.json();
  return (d && d.result && d.result.data) || [];
}
async function fetchKline(code, start, end) {
  // 腾讯不复权
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,${start.replace(/-/g,'')},${end.replace(/-/g,'')},2000,qfq`;
  const r = await fetch(url);
  const d = await r.json();
  const data = d.data && d.data[code];
  const arr = (data && (data.qfqday || data.day)) || [];
  const map = {};
  arr.forEach(k => { map[k[0]] = parseFloat(k[2]); });
  return map;
}
(async () => {
  const divs = sandbox2.dedupDividends(sandbox2.parseDivs(await fetchEm('601398')));
  const kline = await fetchKline('sh601398', '2016-08-16', '2026-08-16');
  console.log('K线点数:', Object.keys(kline).length);
  const r = sandbox.simulate(1000000, '2016-08-16', true, kline, divs, 0);
  const f = r.final;
  console.log('\n=== 回测结果 ===');
  console.log('期末总资产:', f.finalValue.toLocaleString());
  console.log('累计投入:', f.finalInvested.toLocaleString());
  console.log('累计分红:', f.totalDiv.toLocaleString());
  console.log('XIRR:', (f.xirr*100).toFixed(2) + '%');
  console.log('持股:', f.shares, '现金池:', f.cashPool);
  console.log('\n=== 每年分红（到账年分组, years） ===');
  r.years.forEach(y => console.log(`${y.year}: ${y.divTotal.toLocaleString()} 元 (${y.divCount}笔) rate=${(y.rate*100).toFixed(2)}% rate0=${(y.rate0*100).toFixed(2)}%`));
  console.log('\n=== 分红事件（含报告期） ===');
  r.divEvents.slice(-8).forEach(e => console.log(`${e.date} 到账年=${e.year} 报告期年=${e.reportYear} cash=${Math.round(e.cash).toLocaleString()} 元`));
})().catch(e => console.error('ERR', e.message, e.stack));
