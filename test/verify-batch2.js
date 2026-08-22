#!/usr/bin/env node
/* 第二批：A6 滚动分位 / A8 规则树 / A9 CAGR / A10 分红趋势 / A11 未来现金流 / A13 组合回测 / A14 报告卡 / A16 生态分类 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;

const HOLDINGS = [
  { code: '600036', name: '招商银行', ind: 'bank' },
  { code: '601398', name: '工商银行', ind: 'bank' },
  { code: '600887', name: '伊利股份', ind: 'consumer' },
  { code: '600941', name: '中国移动', ind: 'telecom' },
  { code: '000333', name: '美的集团', ind: 'consumer' },
  { code: '601318', name: '中国平安', ind: 'insurer' },
];

async function fetchDivsFull(code, tryN = 1) {
  const cols = 'SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,PLAN_NOTICE_DATE,NOTICE_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,IT_RATIO,ASSIGN_PROGRESS,IMPL_PLAN_PROFILE,BASIC_EPS,TOTAL_SHARES';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://data.eastmoney.com/' } });
  const j = await r.json();
  if (!j.result || !j.result.data) { if (tryN < 5) { await new Promise(r2 => setTimeout(r2, tryN * 4000)); return fetchDivsFull(code, tryN + 1); } return []; }
  return j.result.data;
}

async function fetchKlineSina(code) {
  const tx = (code.startsWith('0') || code.startsWith('3')) ? 'sz' + code : 'sh' + code;
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tx}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  const t = await r.text();
  const m = t.match(/^\[/); if (!m) throw new Error('kline 非数组: ' + t.slice(0, 80));
  const arr = JSON.parse(t);
  const kline = {};
  arr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.day] = c; });
  return kline;
}

async function fetchPriceTx(code) {
  const tx = (code.startsWith('0') || code.startsWith('3')) ? 'sz' + code : 'sh' + code;
  const r = await fetch(`https://qt.gtimg.cn/q=${tx}`, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://gu.qq.com/' } });
  const t = await r.text();
  const m = t.match(/="([^"]+)"/);
  return m ? parseFloat(m[1].split('~')[3]) : null;
}

(async () => {
  const pool = [];
  for (const h of HOLDINGS) {
    let rows, kline;
    try { rows = await fetchDivsFull(h.code); kline = await fetchKlineSina(h.code); } catch (e) { console.log(`\n=== ${h.name} 数据失败: ${e.message}`); continue; }
    const divs = DL.dedupDividends(DL.parseDivs(rows));
    pool.push({ code: h.code, name: h.name, ind: h.ind, divs, kline });
    const price = await fetchPriceTx(h.code);
    console.log(`\n========== ${h.name}(${h.code}) 现价=${price} ==========`);

    // A6 滚动分位（375）
    const series = DL.calcRollingPercentile(kline, divs, 375);
    const last = series.filter(x => x.pct != null).pop();
    const pct624 = series.find(x => x.d === '2026-06-24');
    console.log(`A6  分位(375): 当前(${last ? last.d : '—'}) dy=${last ? last.dy.toFixed(2) + '%' : '—'} pct=${last ? last.pct.toFixed(0) + '%' : '—'} | 6-24: ${pct624 ? 'dy=' + pct624.dy.toFixed(2) + '% pct=' + pct624.pct.toFixed(1) + '%' : '无该日(停牌?)'}`);

    // A16 生态分类
    const cls = DL.classifyTier(h.code);
    console.log(`A16 生态分类: ${cls.cls} (${cls.label})`);

    // A8 规则树结论
    const trendBad = DL.calcDivTrend(divs).degraded;
    const cov = DL.coverageAt(divs, 2026);
    const verdict = DL.ruleVerdict(last ? last.pct : null, cls.cls, trendBad, cov);
    console.log(`A8  规则树: ${verdict.tier} (RULE_STATS: ${JSON.stringify(DL.RULE_STATS[verdict.tier] || null)})  steps=${verdict.steps.map(s => s.msg).join(' | ')}`);

    // A9 CAGR（近3年）
    const cagr = DL.calcDivCAGR(divs, 3);
    const yrSum = {};
    divs.forEach(d => { if (d.pending || !d.ex || !(d.dps > 0)) return; const y = (d.report || d.ex).slice(0, 4); yrSum[y] = (yrSum[y] || 0) + d.dps; });
    /* v2.0 口径同步：回源手工只用有年报的完整财年（与 calcDivCAGR 修复对齐，2026-08-21 平安案例） */
    const hasAnnual = {};
    divs.forEach(d => { if (d.report && /-12-31$/.test(d.report) && !d.pending) hasAnnual[d.report.slice(0, 4)] = true; });
    const ys = Object.keys(yrSum).filter(y => yrSum[y] > 0 && hasAnnual[y]).sort();
    const fy = ys[ys.length - 4], ly = ys[ys.length - 1];
    const manual = fy && yrSum[fy] > 0.1 ? (Math.pow(yrSum[ly] / yrSum[fy], 1 / 3) - 1) : null;
    console.log(`A9  CAGR(3年): 工具=${cagr == null ? 'null' : (cagr * 100).toFixed(2) + '%'}  回源手工=(${fy}:${yrSum[fy]}→${ly}:${yrSum[ly]}) ${manual == null ? 'null(低基数)' : (manual * 100).toFixed(2) + '%'}`);

    // A10 分红趋势
    const trend = DL.calcDivTrend(divs);
    console.log(`A10 分红趋势: 近3年=${trend.last3 == null ? 'null' : trend.last3.toFixed(1) + '%'} 连续下降=${trend.decStreak}年 degraded=${trend.degraded}`);
  }

  // A13 组合回测（6持仓全历史）
  console.log(`\n========== A13 组合回测（6只×全历史） ==========`);
  const bt = DL.calcPortfolioBacktest(pool.map(p => ({ code: p.code, name: p.name, kline: p.kline, divs: p.divs, series: DL.calcRollingPercentile(p.kline, p.divs, 375) })), {});
  bt.forEach(s => console.log(`  ${s.name}: 收益=${s.ret == null ? '—' : s.ret.toFixed(1) + '%'} 年化=${s.annual == null ? '—' : s.annual.toFixed(1) + '%'} 回撤=${s.mdd == null ? '—' : s.mdd.toFixed(1) + '%'} 胜率=${s.winRate == null ? '—' : s.winRate.toFixed(0) + '%'} 事件=${s.events}`));

  // A11 未来现金流（样例持仓：每只 1000 股）
  console.log(`\n========== A11 未来12月现金流（每只1000股样例） ==========`);
  const holdings = {}; HOLDINGS.forEach(h => holdings[h.code] = 1000);
  const cf = DL.calcFutureCashflow(pool.flatMap(p => p.divs), holdings, '2026-08-18', 12);
  cf.forEach(m => console.log(`  ${m.month}: ¥${m.total.toFixed(0)}  ${m.items.map(i => (i.est ? '估' : '') + i.name + '@' + i.dps.toFixed(4) + '×' + i.shares).join(' ')}`));

  // A14 报告卡抽查（招行/移动/伊利）
  console.log(`\n========== A14 报告卡三问引擎抽查 ==========`);
  for (const code of ['600036', '600941', '600887']) {
    const p = pool.find(x => x.code === code);
    if (!p) continue;
    const price = await fetchPriceTx(code);
    const series = DL.calcRollingPercentile(p.kline, p.divs, 375);
    const last = series.filter(x => x.pct != null).pop();
    const trend = DL.calcDivTrend(p.divs);
    const cagr = DL.calcDivCAGR(p.divs, 3);
    const cov = DL.coverageAt(p.divs, 2026);
    const dy = DL.calcAnnualDivYield(p.divs, price);
    // eps/dps：最近财年
    const yrSum = {};
    p.divs.forEach(d => { if (d.pending || !d.ex || !(d.dps > 0)) return; const y = (d.report || d.ex).slice(0, 4); yrSum[y] = (yrSum[y] || 0) + d.dps; });
    const ys = Object.keys(yrSum).sort(); const lastY = ys[ys.length - 1];
    const epsRec = p.divs.filter(d => d.report && d.report.slice(0, 4) === lastY && /-12-31$/.test(d.report) && d.eps != null).pop();
    const out = DL.verdictEngine({ divs: p.divs, coverage: cov, reserveYears: null, payoutRate: null, eps: epsRec ? epsRec.eps : null, dps: yrSum[lastY], price, dy: dy ? dy.yieldPct : null, pct: last ? last.pct : null, industry: p.ind, roe: null, roeTrend: null, dividendCagr: cagr });
    console.log(`  ${p.name}: ${out.summary}`);
  }
  process.exit(0);
})();
