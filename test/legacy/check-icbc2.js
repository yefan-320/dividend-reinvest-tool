const fs = require('fs');
const vm = require('vm');

// 提取 parseDivs / dedupDividends / calcAnnualDivYield 到独立沙箱
const src = fs.readFileSync('data-layer.js', 'utf8');
const start = src.indexOf('const DIV_COLS');
const end = src.indexOf('/* ---------- 对外导出 ----------');
const core = src.slice(start, end);
const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.parseDivs = parseDivs; this.dedupDividends = dedupDividends; this.calcAnnualDivYield = calcAnnualDivYield;', sandbox);

const DIV_COLS = 'SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,PLAN_NOTICE_DATE,NOTICE_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,IT_RATIO,ASSIGN_PROGRESS,IMPL_PLAN_PROFILE,BASIC_EPS,TOTAL_SHARES';
async function fetchEm(code) {
  const filter = `(SECURITY_CODE="${code}")`;
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${DIV_COLS}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent(filter)}`;
  const r = await fetch(url);
  const d = await r.json();
  return (d && d.result && d.result.data) || [];
}
(async () => {
  console.log('=== 工行(601398) 东财分红原始数据 ===');
  const rows = await fetchEm('601398');
  console.log('原始条数:', rows.length);
  rows.slice(0, 20).forEach(r => {
    console.log(`报告期=${(r.REPORT_DATE||'').slice(0,10)} 除息日=${(r.EX_DIVIDEND_DATE||'').slice(0,10)} 每10股税后=${r.PRETAX_BONUS_RMB} 进度=${r.ASSIGN_PROGRESS} 送转=${r.BONUS_IT_RATIO}`);
  });
  console.log('\n=== parseDivs + dedup ===');
  const divs = sandbox.dedupDividends(sandbox.parseDivs(rows));
  divs.slice(0, 20).forEach(d => {
    console.log(`ex=${d.ex} report=${d.report} dps=${d.dps} bonus=${d.bonus} ${d.pending?'[待实施]':''}`);
  });
  console.log('\n=== 年化股息率（近2报告年度平均 ÷ 现价） ===');
  for (const price of [6.0, 6.5, 7.0]) {
    const dy = sandbox.calcAnnualDivYield(divs, price);
    console.log(`现价 ${price}:`, JSON.stringify(dy));
  }
})().catch(e => console.error('ERR', e.message));
