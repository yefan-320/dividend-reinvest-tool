#!/usr/bin/env node
/* D10 等待 vs 买入对比（2026-08-18 P2）：机会区间（分位≥80）内，立即买 vs 等 1 年再买，3 年收益的实际分布
 * 输出：差值（等-立即）分位数（10/25/50/75/90）——用实际分布不做合成曲线（大师三审：别把回测外推成确定性）
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
function holdRet(kline, dates, divs, idx, holdDays) {
  const sellIdx = idx + holdDays; if (sellIdx >= dates.length) return null;
  const buyP = kline[dates[idx]], sellP = kline[dates[sellIdx]];
  if (!(buyP > 0) || !(sellP > 0)) return null;
  const buyD = dates[idx], sellD = dates[sellIdx]; let divSum = 0;
  divs.forEach(d => { if (d.ex && d.dps > 0 && d.ex > buyD && d.ex <= sellD) divSum += d.dps; });
  return (sellP + divSum) / buyP - 1;
}
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };
(async () => {
  const diffs = [];   // 等1年买 - 立即买（3年收益差，pp）
  const imm = [], wait = [];
  for (const [ind, codes] of Object.entries(IND)) {
    for (const code of codes) {
      const s = loadStock(code); if (!Object.keys(s.kline).length || !s.divs.length) continue;
      const dates = Object.keys(s.kline).sort(); if (dates.length < 800) continue;
      const series = DL.calcRollingPercentile(s.kline, s.divs, 375);
      for (const x of series) {
        if (x.pct == null || x.pct < 80) continue;   // 仅机会区间（分位≥80）
        const idx = dates.indexOf(x.d); if (idx < 0) continue;
        const rImm = holdRet(s.kline, dates, s.divs, idx, 750);
        const rWait = holdRet(s.kline, dates, s.divs, idx + 250, 750);
        if (rImm == null || rWait == null) continue;
        imm.push(rImm); wait.push(rWait);
        diffs.push((rWait - rImm) * 100);
      }
    }
  }
  console.log('===== D10 等待 vs 买入（机会区间分位≥80，3年持有含分红）=====');
  console.log(`样本 ${diffs.length} 组（40 只 × 16 年机会区间均匀抽样）`);
  console.log(`立即买 3 年收益分位：P10 ${(q(imm, 0.1) * 100).toFixed(0)}% / P50 ${(q(imm, 0.5) * 100).toFixed(0)}% / P90 ${(q(imm, 0.9) * 100).toFixed(0)}%`);
  console.log(`等1年买 3 年收益分位：P10 ${(q(wait, 0.1) * 100).toFixed(0)}% / P50 ${(q(wait, 0.5) * 100).toFixed(0)}% / P90 ${(q(wait, 0.9) * 100).toFixed(0)}%`);
  console.log(`差值（等-立即）pp 分位：P10 ${q(diffs, 0.1).toFixed(1)} / P25 ${q(diffs, 0.25).toFixed(1)} / P50 ${q(diffs, 0.5).toFixed(1)} / P75 ${q(diffs, 0.75).toFixed(1)} / P90 ${q(diffs, 0.9).toFixed(1)}`);
  console.log(`等待更优（差值>0）占比：${(diffs.filter(d => d > 0).length / diffs.length * 100).toFixed(0)}% | 立即买更优（<0）${(diffs.filter(d => d < 0).length / diffs.length * 100).toFixed(0)}%`);
  const avgD = diffs.reduce((s, x) => s + x, 0) / diffs.length;
  console.log(`均值：${avgD.toFixed(1)}pp（正=等更划算）——结论：${avgD > 3 ? '等待有实际价值（机会区间内不急买）' : Math.abs(avgD) <= 3 ? '等待与立即买接近（分位≥80 已可买，等 90 只是锦上添花）' : '立即买更优（等待机会成本高）'}`);
  process.exit(0);
})();
