#!/usr/bin/env node
/* 溢价分位 vs 股息率分位回测对照（大师第4轮验收项：胜率不低于旧线）
 * 分子：premium = dy − 国债_t（历史国债序列·年度锚点插值近似·三重标注）
 * 滚动近3年（750天）P75/P85/P90 分位线，无未来函数；3/5年含分红
 * 对比组：股息率分位（原版）vs 溢价分位（新版）
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
// 国债年度锚点近似序列（三重标注：近似序列·年度锚点插值·正式源待接入；覆盖2010-2026）
const ANCHOR = [['2010-01-01', 4.0], ['2011-01-01', 3.8], ['2012-01-01', 3.5], ['2013-01-01', 4.0], ['2014-01-01', 3.9], ['2015-01-01', 3.5], ['2016-01-01', 3.0], ['2017-01-01', 3.9], ['2018-01-01', 3.5], ['2019-01-01', 3.2], ['2020-01-01', 3.2], ['2021-01-01', 3.1], ['2022-01-01', 2.8], ['2023-01-01', 2.6], ['2024-01-01', 2.2], ['2025-01-01', 1.7], ['2026-01-01', 1.55]];
function treasuryAt(d) {
  const t = new Date(d + 'T00:00:00Z').getTime();
  let lo = ANCHOR[0], hi = ANCHOR[ANCHOR.length - 1];
  for (let i = 1; i < ANCHOR.length; i++) {
    if (new Date(ANCHOR[i][0] + 'T00:00:00Z').getTime() > t) { hi = ANCHOR[i]; lo = ANCHOR[i - 1]; break; }
  }
  const t0 = new Date(lo[0] + 'T00:00:00Z').getTime(), t1 = new Date(hi[0] + 'T00:00:00Z').getTime();
  return lo[1] + (hi[1] - lo[1]) * (t - t0) / (t1 - t0);
}

function loadStock(code) {
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { kline, divs };
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
  const buckets = { dyP75: {}, dyP85: {}, dyP90: {}, pmP75: {}, pmP85: {}, pmP90: {} };
  for (const [ind, codes] of Object.entries(IND)) {
    for (const code of codes) {
      const s = loadStock(code);
      const dates = Object.keys(s.kline).sort();
      if (dates.length < 1000 || !s.divs.length) continue;
      const series = DL.calcRollingPercentile(s.kline, s.divs, 375);
      const full = series.filter(x => x.dy != null);
      const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p / 100 * arr.length))];
      // 溢价序列（历史国债，非当日常数——三重标注）
      const pm = full.map(x => ({ d: x.d, dy: x.dy, pm: x.dy - treasuryAt(x.d) }));
      const collect = (evList, bucket) => {
        for (const d of evList) {
          const idx = dates.indexOf(d);
          if (idx < 0) continue;
          for (const [hn, hd] of [['3y', 750], ['5y', 1250]]) {
            const r = buyReturn(s.kline, dates, s.divs, idx, hd);
            if (!r) continue;
            const key = ind + '|' + hn;
            if (!bucket[key]) bucket[key] = { n: 0, win: 0, sum: 0, dSum: 0 };
            bucket[key].n++;
            if (r.totRet > 0) bucket[key].win++;
            bucket[key].sum += r.totRet; bucket[key].dSum += r.divRet;
          }
        }
      };
      const evs = (list) => { const out = []; let last = -1e9; for (const d of list) { const idx = dates.indexOf(d); if (idx < 0) continue; if (idx - last >= 250) { out.push(d); last = idx; } } return out; };
      // 两种分子的滚动分位触发
      for (const [which, arr] of [['dy', full], ['pm', pm]]) {
        const getVal = which === 'dy' ? x => x.dy : x => x.pm;
        for (const p of [75, 85, 90]) {
          const events = [];
          for (let i = 750; i < arr.length; i++) {
            const win = arr.slice(i - 750, i).map(getVal).sort((a, b) => a - b);
            if (win.length < 500) continue;
            const line = q(win, p);
            if (getVal(arr[i]) >= line) events.push(arr[i].d);
          }
          collect(evs(events), buckets[(which === 'dy' ? 'dy' : 'pm') + 'P' + p]);
        }
      }
    }
  }
  const show = (bucket, label) => {
    console.log('--- ' + label + ' ---');
    let totalN = 0, totalWin = 0;
    for (const k of Object.keys(bucket).sort()) {
      const a = bucket[k];
      if (a.n < 5) continue;
      totalN += a.n; totalWin += a.win;
      console.log(k + ': ' + a.n + '次 | 胜率 ' + Math.round(a.win / a.n * 100) + '% | 总收益 ' + (a.sum / a.n).toFixed(1) + '% | 分红 ' + (a.dSum / a.n).toFixed(1) + '%');
    }
    console.log('合计: ' + totalN + '次 | 胜率 ' + Math.round(totalWin / totalN * 100) + '%');
  };
  console.log('==== 股息率分位（原版·对照组） ====');
  show(buckets.dyP75, '滚动近3年 P75');
  show(buckets.dyP85, '滚动近3年 P85');
  show(buckets.dyP90, '滚动近3年 P90');
  console.log('\n==== 溢价分位（新版·历史国债序列） ====');
  show(buckets.pmP75, '滚动近3年 P75');
  show(buckets.pmP85, '滚动近3年 P85');
  show(buckets.pmP90, '滚动近3年 P90');
  console.log('\n（国债序列：近似·年度锚点插值·正式源待接入）');
  process.exit(0);
})();
