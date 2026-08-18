#!/usr/bin/env node
/* 卖出信号回测（2026-08-18 P1）：工具"连续2年分红恶化→建议卖出"是否真的该卖？
 * 判定与工具同源：报告期归组年度分红，相邻财年 pct<0 连续 2 年 → 信号触发
 * 触发时点：第 2 个下降财年结束后的首个交易日（年报披露后，取 Y+1-05-01 后首个交易日）
 * 对比：卖出（触发时点价格）vs 持有 1/2 年（价格+期间分红）
 * 输出：卖出 vs 持有 1/2 年差值（正=卖出更好=信号有效）；分行业
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));
const IND = {
  bank: ['600036', '601398', '601988', '601288', '601328', '600016', '000001', '601166'],
  consumer: ['600519', '000858', '000895', '600887', '000651', '000333', '600690'],
  insurer: ['601318', '601628', '601601'],
  utility: ['600900', '600886', '600027', '600795', '601985'],
  energy: ['600028', '601857', '601088', '600188', '601225'],
};
function loadStock(code) {
  const karr = cache[code + ':k'] || []; const divs = cache[code + ':d'] || [];
  const kline = {}; karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { kline, divs };
}
/* 年度分红（报告期归组）→ 连续下降财年 */
function annualDivs(divs) {
  const m = {};
  divs.forEach(d => { if (d.dps > 0 && d.report && /12-31/.test(d.report)) { const y = d.report.slice(0, 4); m[y] = (m[y] || 0) + d.dps; } });
  return m;
}
function sellEvents(divs) {
  const m = annualDivs(divs);
  const ys = Object.keys(m).sort();
  const evs = [];
  for (let i = 2; i < ys.length; i++) {
    const y0 = ys[i - 2], y1 = ys[i - 1], y2 = ys[i];
    if (m[y1] < m[y0] && m[y2] < m[y1]) evs.push(parseInt(y2, 10));   // y0→y1→y2 连续下降，确认点=y2 财年
  }
  return evs;
}
(async () => {
  const results = [];   // {ind, code, year, sellRet, hold1, hold2}
  for (const [ind, codes] of Object.entries(IND)) {
    for (const code of codes) {
      const s = loadStock(code); if (!Object.keys(s.kline).length || !s.divs.length) continue;
      const dates = Object.keys(s.kline).sort(); if (dates.length < 800) continue;
      for (const y of sellEvents(s.divs)) {
        // 触发时点：y 财年结束后（y+1 年 5 月后首个交易日）
        const trigger = dates.find(d => d >= (y + 1) + '-05-01');
        if (!trigger) continue;
        const ti = dates.indexOf(trigger);
        const sellP = s.kline[trigger];
        const h1 = ti + 250, h2 = ti + 500;
        if (h1 >= dates.length || h2 >= dates.length) continue;
        const p1 = s.kline[dates[h1]], p2 = s.kline[dates[h2]];
        if (!(sellP > 0) || !(p1 > 0) || !(p2 > 0)) continue;
        let d1 = 0, d2 = 0;
        s.divs.forEach(d => { if (d.ex && d.dps > 0 && d.ex > trigger && d.ex <= dates[h1]) d1 += d.dps; if (d.ex && d.dps > 0 && d.ex > trigger && d.ex <= dates[h2]) d2 += d.dps; });
        results.push({ ind, code, year: y, sellRet: 0, hold1: (p1 + d1) / sellP - 1, hold2: (p2 + d2) / sellP - 1 });
      }
    }
  }
  console.log('===== 卖出信号回测（连续2年分红下降触发，卖出 vs 持有）=====');
  console.log(`触发 ${results.length} 次（40 只 × 16 年）`);
  const agg = (arr) => {
    const h1 = arr.reduce((s, x) => s + x.hold1, 0) / arr.length;
    const h2 = arr.reduce((s, x) => s + x.hold2, 0) / arr.length;
    const w1 = arr.filter(x => x.hold1 < 0).length / arr.length * 100;   // 持有1年亏=卖出对
    const w2 = arr.filter(x => x.hold2 < 0).length / arr.length * 100;
    return { h1, h2, w1, w2 };
  };
  const all = agg(results);
  console.log(`全量：持有1年均收益 ${(all.h1 * 100).toFixed(1)}%（${all.w1.toFixed(0)}% 概率亏损→卖出更优）| 持有2年 ${(all.h2 * 100).toFixed(1)}%（${all.w2.toFixed(0)}% 亏损）`);
  console.log(`\n触发时卖出=锁定 ${all.h1 < 0 ? '亏损' : '收益'}（持有1年<0 时卖出才对）`);
  const byInd = {};
  results.forEach(r => { if (!byInd[r.ind]) byInd[r.ind] = []; byInd[r.ind].push(r); });
  for (const ind of Object.keys(byInd)) {
    const a = agg(byInd[ind]);
    console.log(`${ind}：触发 ${byInd[ind].length} 次 | 持有1年 ${(a.h1 * 100).toFixed(1)}%（${a.w1.toFixed(0)}% 亏）| 2年 ${(a.h2 * 100).toFixed(1)}%（${a.w2.toFixed(0)}% 亏）`);
  }
  console.log('\n触发明细（code | 确认年 | 持有1年 | 持有2年）:');
  results.sort((a, b) => a.year - b.year).forEach(r => console.log(`  ${r.code} | ${r.year} | ${(r.hold1 * 100).toFixed(1)}% | ${(r.hold2 * 100).toFixed(1)}%`));
  process.exit(0);
})();
