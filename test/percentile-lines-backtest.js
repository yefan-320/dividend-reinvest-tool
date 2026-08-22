#!/usr/bin/env node
/* A1 分布清洗验证 + A5 分位线 vs 行业线回测对照（大师共同分析第1轮要求）
 * A1：剔除 dy 最低 5%（泡沫段）后 P85 线差多少
 * A5：滚动近3年 P85/P90 分位线 vs 行业线，触发事件 → 3/5年含分红胜率对照（40只池）
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
  const results = { indLine: {}, p85: {}, p90: {} };
  const A1 = [];
  for (const [ind, codes] of Object.entries(IND)) {
    const yb = DL.BENCH[ind];
    if (!yb) continue;
    const mid = yb.yieldMid, line = yb.yieldMid + yb.yieldUp;
    for (const code of codes) {
      const s = loadStock(code);
      const dates = Object.keys(s.kline).sort();
      if (dates.length < 1000 || !s.divs.length) continue;
      const series = DL.calcRollingPercentile(s.kline, s.divs, 375);
      const full = series.filter(x => x.dy != null);
      const n = full.length;
      // A1：清洗 = 剔除 dy 最低 5%
      const sortedDy = full.map(x => x.dy).sort((a, b) => a - b);
      const cutIdx = Math.floor(n * 0.05);
      const cleanDy = sortedDy.slice(cutIdx);
      const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p / 100 * arr.length))];
      const p85raw = q(sortedDy, 85), p85clean = q(cleanDy, 85);
      A1.push({ name: code, ind, p85raw: p85raw.toFixed(2), p85clean: p85clean.toFixed(2), diff: (p85clean - p85raw).toFixed(2) });
      // A5：滚动近3年 P85/P90 线（无未来函数：只用截至 t 的 750 天 dy）
      const dyByDate = {};
      full.forEach(x => { dyByDate[x.d] = x.dy; });
      const p85Events = [], p90Events = [];
      for (let i = 750; i < full.length; i++) {
        const d = full[i].d;
        const win = full.slice(i - 750, i).map(x => x.dy).sort((a, b) => a - b);
        if (win.length < 500) continue;
        const p85 = q(win, 85), p90 = q(win, 90);
        if (full[i].dy >= p85) p85Events.push(d);
        if (full[i].dy >= p90) p90Events.push(d);
      }
      const evs = (list) => { const out = []; let last = -1e9; for (const d of list) { const idx = dates.indexOf(d); if (idx < 0) continue; if (idx - last >= 250) { out.push(d); last = idx; } } return out; };
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
      // 行业线事件（合并）
      const indEvs = [];
      { let inZ = false, start = null; for (const x of series) { if (x.dy == null) continue; if (x.dy >= line) { if (!inZ) { inZ = true; start = x.d; } } else { if (inZ) { indEvs.push(start); inZ = false; } } } if (inZ) indEvs.push(start); }
      collect(evs(indEvs), results.indLine);
      collect(evs(p85Events), results.p85);
      collect(evs(p90Events), results.p90);
    }
  }
  console.log('==== A1 分布清洗验证（剔除 dy 最低 5% 泡沫段） ====');
  console.log('股票 | 原始P85 | 清洗P85 | 差pp');
  A1.forEach(a => console.log(a.name + ' | ' + a.p85raw + '% | ' + a.p85clean + '% | ' + a.diff));
  console.log('\n==== A5 回测对照（40只池·3/5年含分红） ====');
  const show = (bucket, label) => {
    console.log('--- ' + label + ' ---');
    for (const k of Object.keys(bucket).sort()) {
      const a = bucket[k];
      if (a.n < 5) continue;
      console.log(k + ': ' + a.n + '次 | 胜率 ' + Math.round(a.win / a.n * 100) + '% | 总收益 ' + (a.sum / a.n).toFixed(1) + '% | 分红 ' + (a.dSum / a.n).toFixed(1) + '%');
    }
  };
  show(results.indLine, '行业线（加仓）');
  show(results.p85, '滚动近3年 P85 线');
  show(results.p90, '滚动近3年 P90 线');
  process.exit(0);
})();
