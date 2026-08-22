#!/usr/bin/env node
/* 第一批：A2 TTM / A3 锁定TTM / A4 年化股息率 / A5 三档 / A7 覆盖率 / A17 财年归组
 * 方法：真实数据（东财分红+腾讯现价）→ 工具函数 → 回源锚点核对 */
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
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://data.eastmoney.com/', 'Accept': 'application/json, text/plain, */*' } });
  const j = await r.json();
  if (!j.result || !j.result.data) { if (tryN < 5) { await new Promise(r2 => setTimeout(r2, tryN * 4000)); return fetchDivsFull(code, tryN + 1); } return []; }
  return j.result.data;
}

async function fetchPriceTx(code) {
  const tx = (code.startsWith('0') || code.startsWith('3')) ? 'sz' + code : 'sh' + code;
  const url = `https://qt.gtimg.cn/q=${tx}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://gu.qq.com/' } });
  const t = await r.text();
  const m = t.match(/="([^"]+)"/);
  if (!m) return null;
  const p = m[1].split('~');
  return parseFloat(p[3]); // 现价
}

(async () => {
  const dateNow = '2026-08-18';
  for (const h of HOLDINGS) {
    let rows;
    try { rows = await fetchDivsFull(h.code); } catch (e) { console.log(`\n=== ${h.name} 拉取失败: ${e.message}`); continue; }
    const divs = DL.dedupDividends(DL.parseDivs(rows));
    const price = await fetchPriceTx(h.code);
    console.log(`\n========== ${h.name}(${h.code}) 现价=${price} ==========`);

    // A17 财年归组 + A2 TTM
    const yr = DL.calcReportYearDivs(divs);
    const yrSum = {};
    divs.forEach(d => { if (d.pending || !d.ex || !(d.dps > 0)) return; const y = (d.report || d.ex).slice(0, 4); yrSum[y] = (yrSum[y] || 0) + d.dps; });
    const last3 = Object.keys(yrSum).filter(y => yrSum[y] > 0).sort().slice(-3);
    console.log('A17 财年归组(近3年):', last3.map(y => `${y}=${yrSum[y].toFixed(4)}`).join('  '));

    const ttm624 = DL.ttmDivsAt(divs, '2026-06-24');
    const ttm710 = DL.ttmDivsAt(divs, '2026-07-10');
    const ttmNow = DL.ttmDivsAt(divs, dateNow);
    console.log(`A2  TTM(B主): 6-24=${ttm624.toFixed(4)}  7-10=${ttm710.toFixed(4)}  今天=${ttmNow.toFixed(4)}  | 6-24→7-10 跳变=${(ttm710 - ttm624).toFixed(4)}`);

    // A3 锁定TTM：最近一次除息日
    const lock = DL.calcLockedTTM(divs);
    const lastEx = Object.keys(lock).sort().slice(-1)[0];
    console.log(`A3  锁定TTM: 最近除息日 ${lastEx} → 锁定 ${lock[lastEx].lockedDps.toFixed(4)}`);

    // A4 年化股息率（工具口径=最近2个报告年均值）
    const dy = DL.calcAnnualDivYield(divs, price);
    if (dy) {
      const yearsTxt = dy.years.join('/');
      console.log(`A4  年化股息率: ${dy.annualDps.toFixed(4)}/股 (${yearsTxt}均值) → ${dy.yieldPct.toFixed(2)}%`);
      // 回源核对：最近财年单年
      const lastY = last3[last3.length - 1];
      console.log(`    回源: 最近财年${lastY}分红=${yrSum[lastY].toFixed(4)} → 单年股息率=${(yrSum[lastY] / price * 100).toFixed(2)}%`);
    } else console.log('A4  年化股息率: null');

    // A5 三档
    const spot = DL.tierSpot(dy ? dy.yieldPct : null, h.ind);
    if (spot) console.log(`A5  三档(${h.ind}): 小仓线=${spot.mid}% 加仓线=${spot.line}% 重仓线=${spot.heavy}% → 落档=${spot.cur} 距加仓线差=${spot.gapAdd.toFixed(2)}pp`);
    else console.log('A5  三档: null');

    // A7 覆盖率（asOfYear=2026）
    const cov = DL.coverageAt(divs, 2026);
    console.log(`A7  覆盖率(2026视角, 近2财年): ${cov == null ? 'null(数据不足)' : cov.toFixed(3)}`);
  }
  process.exit(0);
})();
