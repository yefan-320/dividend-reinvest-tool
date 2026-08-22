#!/usr/bin/env node
/* D1 买入时机回测（2026-08-18 P1）：三档线触发后，什么时候买最优？
 * 对照臂：触发日 / 触发后第5/10/20交易日 / 触发后最近除息日前1天 / 除息日后1天
 * 口径：与 signal-effectiveness 同源（375窗口、1年=250交易日、分红=持有期 dps 加总）
 * 输出：各臂 1 年收益均值/胜率 vs 触发日（差异<1pp=时机不重要，回测价值=证明问题不重要）
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
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
function zoneEvents(series, line) {
  const evs = []; let inZ = false, start = null;
  for (const x of series) { if (x.dy == null) continue; if (x.dy >= line) { if (!inZ) { inZ = true; start = x.d; } } else { if (inZ) { evs.push(start); inZ = false; } } }
  if (inZ) evs.push(start); return evs;
}
function buyReturnAt(dates, kline, divs, buyIdx, holdDays) {
  const sellIdx = buyIdx + holdDays; if (sellIdx >= dates.length) return null;
  const buyP = kline[dates[buyIdx]], sellP = kline[dates[sellIdx]];
  if (!(buyP > 0) || !(sellP > 0)) return null;
  const buyD = dates[buyIdx], sellD = dates[sellIdx]; let divSum = 0;
  divs.forEach(d => { if (d.ex && d.dps > 0 && d.ex > buyD && d.ex <= sellD) divSum += d.dps; });
  return (sellP + divSum) / buyP - 1;
}
(async () => {
  const arms = { '触发日': [], '第5天': [], '第10天': [], '第20天': [], '除息前1天': [], '除息后1天': [] };
  let nEvt = 0;
  for (const [ind, codes] of Object.entries(IND)) {
    const yb = DL.BENCH[ind]; if (!yb) continue;
    const heavy = yb.yieldMid + yb.yieldUp + 1;
    for (const code of codes) {
      const s = loadStock(code); if (!Object.keys(s.kline).length || !s.divs.length) continue;
      const dates = Object.keys(s.kline).sort(); if (dates.length < 800) continue;
      const series = DL.calcRollingPercentile(s.kline, s.divs, 375);
      const exDates = s.divs.filter(d => d.ex && d.dps > 0).map(d => d.ex).sort();
      for (const d of zoneEvents(series, heavy)) {
        const idx = dates.indexOf(d); if (idx < 0) continue;
        const holdDays = 250;
        // 各臂买入 idx
        const armsIdx = { '触发日': idx, '第5天': idx + 5, '第10天': idx + 10, '第20天': idx + 20 };
        // 除息日臂：触发日之后最近的除息日
        const nextEx = exDates.find(x => x >= d);
        if (nextEx) {
          const exIdx = dates.indexOf(nextEx);
          if (exIdx > 0) { armsIdx['除息前1天'] = exIdx - 1; armsIdx['除息后1天'] = exIdx + 1; }
        }
        let any = false;
        for (const [name, bi] of Object.entries(armsIdx)) {
          const r = buyReturnAt(dates, s.kline, s.divs, bi, holdDays);
          if (r == null) continue;
          arms[name].push(r); any = true;
        }
        if (any) nEvt++;
      }
    }
  }
  console.log('===== D1 买入时机回测（重仓线触发，1年持有含分红）=====');
  console.log(`事件 ${nEvt} 个（触发日可计算收益）`);
  console.log('臂 | n | 均值收益 | 胜率 | vs触发日');
  const base = arms['触发日'];
  const bAvg = base.reduce((s, x) => s + x, 0) / base.length;
  const bWin = base.filter(x => x > 0).length / base.length * 100;
  console.log(`触发日 | ${base.length} | ${(bAvg * 100).toFixed(1)}% | ${bWin.toFixed(0)}% | 基准`);
  for (const name of ['第5天', '第10天', '第20天', '除息前1天', '除息后1天']) {
    const a = arms[name];
    if (!a.length) { console.log(`${name} | 0 | — | — | —`); continue; }
    const avg = a.reduce((s, x) => s + x, 0) / a.length;
    const win = a.filter(x => x > 0).length / a.length * 100;
    const diff = (avg - bAvg) * 100;
    console.log(`${name} | ${a.length} | ${(avg * 100).toFixed(1)}% | ${win.toFixed(0)}% | ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp${Math.abs(diff) < 1 ? '（≈无差异）' : ''}`);
  }
  process.exit(0);
})();
