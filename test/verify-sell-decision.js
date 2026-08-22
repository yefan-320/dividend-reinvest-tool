#!/usr/bin/env node
/* 实战验证：卖出信号/决策逻辑（O3 角标 + 诊断页同源）——用真实数据回放
 * 数据链路与工具一致：东财 RPT_SHAREBONUS_DET → DL.parseDivs → DL.dedupDividends
 * 输出：现网逻辑（sellSignalQuick 原样） vs 修复逻辑（年报优先+无年报财年跳过）对比
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;

const HOLDINGS = [
  { code: '600036', name: '招商银行' },
  { code: '601398', name: '工商银行' },
  { code: '600887', name: '伊利股份' },
  { code: '600941', name: '中国移动' },
  { code: '000333', name: '美的集团' },
  { code: '601318', name: '中国平安' },
];

async function fetchDivsFull(code, tryN = 1) {
  const cols = 'SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,PLAN_NOTICE_DATE,NOTICE_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,IT_RATIO,ASSIGN_PROGRESS,IMPL_PLAN_PROFILE,BASIC_EPS,TOTAL_SHARES';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://data.eastmoney.com/', 'Accept': 'application/json, text/plain, */*' } });
  const j = await r.json();
  if (!j.result || !j.result.data) { if (tryN < 5) { await new Promise(r2 => setTimeout(r2, tryN * 4000)); return fetchDivsFull(code, tryN + 1); } return []; }
  return j.result.data;
}

/* ===== 现网逻辑逐行复刻（data-layer.js sellSignalQuick） ===== */
function replayCurrent(divs) {
  const SELL_WINDOW_YEARS = 5;
  const epsByYear = {};
  divs.forEach(d => { if (d.eps == null) return; const y = (d.report || '').slice(0, 4); if (y) epsByYear[y] = d.eps; });
  const years = Object.keys(epsByYear).sort();
  const epsTrend = [];
  for (let i = 1; i < years.length; i++) {
    const prev = epsByYear[years[i - 1]], cur = epsByYear[years[i]];
    if (prev != null && cur != null) epsTrend.push({ y: years[i], pct: (cur - prev) / prev * 100 });
  }
  const epsLastYear = years.length ? years[years.length - 1] : null;
  const epsWindowed = epsTrend.filter(t => epsLastYear != null && t.y >= epsLastYear - SELL_WINDOW_YEARS + 1);
  let epsBad = false;
  for (let i = 1; i < epsWindowed.length; i++) { if (epsWindowed[i].pct < 0 && epsWindowed[i - 1].pct < 0) { epsBad = true; break; } }
  return { epsByYear, epsTrend, epsWindowed, epsBad };
}

/* ===== 修复逻辑：年报优先；当年无年报（中报兜底）不参与连续下滑判定 ===== */
function replayFixed(divs) {
  const SELL_WINDOW_YEARS = 5;
  const epsByYear = {}, epsAnnual = {};
  divs.forEach(d => {
    if (d.eps == null) return;
    const rep = d.report || ''; const y = rep.slice(0, 4);
    if (!y) return;
    const isAnnual = rep.slice(5, 7) === '12';
    if (isAnnual) { epsByYear[y] = d.eps; epsAnnual[y] = true; }
    else if (epsByYear[y] == null) epsByYear[y] = d.eps;
  });
  const years = Object.keys(epsByYear).sort();
  const epsTrend = [];
  for (let i = 1; i < years.length; i++) {
    const prev = epsByYear[years[i - 1]], cur = epsByYear[years[i]];
    if (prev != null && cur != null) epsTrend.push({ y: years[i], pct: (cur - prev) / prev * 100 });
  }
  const epsLastYear = years.length ? years[years.length - 1] : null;
  const epsWindowed = epsTrend.filter(t => epsLastYear != null && epsAnnual[t.y] && t.y >= epsLastYear - SELL_WINDOW_YEARS + 1);
  let epsBad = false;
  for (let i = 1; i < epsWindowed.length; i++) { if (epsWindowed[i].pct < 0 && epsWindowed[i - 1].pct < 0) { epsBad = true; break; } }
  return { epsByYear, epsAnnual, epsTrend, epsWindowed, epsBad };
}

(async () => {
  for (const h of HOLDINGS) {
    let rows;
    try { rows = await fetchDivsFull(h.code); } catch (e) { console.log(`\n=== ${h.name}(${h.code}) 拉取失败: ${e.message}`); continue; }
    const divs = DL.dedupDividends(DL.parseDivs(rows));
    const cur = replayCurrent(divs);
    const fixed = replayFixed(divs);
    const badgeCur = DL.sellSignalQuick(divs);

    console.log(`\n========== ${h.name}(${h.code}) ==========`);
    console.log('【现网】EPS 逐年(同键后写覆盖):', JSON.stringify(cur.epsByYear));
    console.log('【现网】同比链:', cur.epsTrend.map(t => `${t.y}:${t.pct.toFixed(1)}%`).join('  '));
    console.log('【现网】角标:', JSON.stringify(badgeCur), badgeCur.epsBad || badgeCur.divBad ? '→ ⚠️ 卖出信号' : '→ 无信号');
    console.log('【修复】EPS 逐年(年报优先):', JSON.stringify(fixed.epsByYear), '  有年报年份:', JSON.stringify(fixed.epsAnnual));
    console.log('【修复】同比链(仅年报参与):', fixed.epsTrend.map(t => `${t.y}:${t.pct.toFixed(1)}%${fixed.epsAnnual[t.y] ? '' : '(中报兜底,不参与)'}`).join('  '));
    console.log('【修复】5年窗判定:', fixed.epsWindowed.map(t => `${t.y}:${t.pct.toFixed(1)}%`).join('  '), '→ epsBad =', fixed.epsBad);
  }
  process.exit(0);
})();
