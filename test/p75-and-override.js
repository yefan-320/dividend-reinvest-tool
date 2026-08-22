#!/usr/bin/env node
/* Q1 P75 补测 + override 表（按 P90 实测，大师第2轮定案要求）
 * P75 胜率回测（40只池·3/5年含分红，滚动近3年无未来函数）+ 当前近3年 P75/P90/P95 线表
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
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { code, kline, divs };
}
function buyReturn(kline, dates, divs, buyIdx, holdDays) {
  const sellIdx = buyIdx + holdDays;
  if (sellIdx >= dates.length) return null;
  const buyP = kline[dates[buyIdx]], sellP = kline[dates[sellIdx]];
  if (!(buyP > 0) || !(sellP > 0)) return null;
  const buyD = dates[buyIdx], sellD = dates[sellIdx];
  let divSum = 0;
  divs.forEach(d => { if (d.ex && d.dps > 0 && d.ex > buyD && d.ex <= sellD) divSum += d.dps; });
  return { totRet: (sellP + divSum) / buyP * 100 - 100, divRet: divSum / buyP * 100 };
}
(async () => {
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p / 100 * arr.length))];
  const buckets = {};
  const override = [];
  for (const [ind, codes] of Object.entries(IND)) {
    const yb = DL.BENCH[ind];
    if (!yb) continue;
    for (const code of codes) {
      const s = loadStock(code);
      const dates = Object.keys(s.kline).sort();
      if (dates.length < 1000 || !s.divs.length) continue;
      const series = DL.calcRollingPercentile(s.kline, s.divs, 375);
      const full = series.filter(x => x.dy != null);
      // override 表：当前近3年（2023-01 起）分位
      const cur3y = full.filter(x => x.d >= '2023-01-01').map(x => x.dy).sort((a, b) => a - b);
      if (cur3y.length > 400) {
        override.push({ code, ind, name: code, p75: q(cur3y, 75).toFixed(2), p90: q(cur3y, 90).toFixed(2), p95: q(cur3y, 95).toFixed(2), indLine: (yb.yieldMid + yb.yieldUp).toFixed(1), n: cur3y.length });
      }
      // P75 回测：滚动近3年 P75 触发
      const evs = [];
      for (let i = 750; i < full.length; i++) {
        const win = full.slice(i - 750, i).map(x => x.dy).sort((a, b) => a - b);
        if (win.length < 500) continue;
        if (full[i].dy >= q(win, 75)) evs.push(full[i].d);
      }
      // 合并相邻
      const merged = [];
      let last = -1e9;
      for (const d of evs) { const idx = dates.indexOf(d); if (idx < 0) continue; if (idx - last >= 250) { merged.push(d); last = idx; } }
      for (const d of merged) {
        const idx = dates.indexOf(d);
        if (idx < 0) continue;
        for (const [hn, hd] of [['3y', 750], ['5y', 1250]]) {
          const r = buyReturn(s.kline, dates, s.divs, idx, hd);
          if (!r) continue;
          const key = ind + '|' + hn;
          if (!buckets[key]) buckets[key] = { n: 0, win: 0, sum: 0 };
          buckets[key].n++; if (r.totRet > 0) buckets[key].win++; buckets[key].sum += r.totRet;
        }
      }
    }
  }
  console.log('==== Q1 P75 线回测（40只池·3/5年含分红） ====');
  for (const k of Object.keys(buckets).sort()) {
    const a = buckets[k];
    console.log(k + ': ' + a.n + '次 | 胜率 ' + Math.round(a.win / a.n * 100) + '% | 总收益均值 ' + (a.sum / a.n).toFixed(1) + '%');
  }
  console.log('\n==== override 表（当前近3年分位·大师 Q4：以 P90 实测为准） ====');
  console.log('代码 | 行业 | P75(小仓) | P90(加仓) | P95(重仓) | 行业线(加仓) | 样本天数');
  override.forEach(o => console.log(o.code + ' | ' + o.ind + ' | ' + o.p75 + '% | ' + o.p90 + '% | ' + o.p95 + '% | ' + o.indLine + '% | ' + o.n));
  process.exit(0);
})();
