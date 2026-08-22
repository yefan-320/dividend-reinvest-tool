#!/usr/bin/env node
/* 溢价分位 vs 股息率分位对比（近3年窗口）
 * 国债历史近似序列：年度锚点线性插值（标注近似，正式数据源待接入）
 * 关键验证：窗口内国债在变（2.6→1.55）→ 溢价序列≠dy平移 → 分位真实改变
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));

// 国债年度锚点（中国10年期，近似）
const ANCHOR = [['2010-01-01', 4.0], ['2011-01-01', 3.8], ['2012-01-01', 3.5], ['2013-01-01', 4.0], ['2014-01-01', 3.9], ['2015-01-01', 3.5], ['2016-01-01', 3.0], ['2017-01-01', 3.9], ['2018-01-01', 3.5], ['2019-01-01', 3.2], ['2020-01-01', 3.2], ['2021-01-01', 3.1], ['2022-01-01', 2.8], ['2023-01-01', 2.6], ['2024-01-01', 2.2], ['2025-01-01', 1.7], ['2026-01-01', 1.55]];
function treasuryAt(d) {
  const t = new Date(d + 'T00:00:00Z').getTime();
  let lo = ANCHOR[0], hi = ANCHOR[ANCHOR.length - 1];
  for (let i = 1; i < ANCHOR.length; i++) {
    if (new Date(ANCHOR[i][0] + 'T00:00:00Z').getTime() > t) { hi = ANCHOR[i]; lo = ANCHOR[i - 1]; break; }
  }
  const t0 = new Date(lo[0] + 'T00:00:00Z').getTime(), t1 = new Date(hi[0] + 'T00:00:00Z').getTime();
  const f = (t - t0) / (t1 - t0);
  return lo[1] + (hi[1] - lo[1]) * f;
}

const H = [['600036', '招商银行'], ['601398', '工商银行'], ['600887', '伊利股份'], ['000333', '美的集团'], ['601318', '中国平安']];
for (const [code, name] of H) {
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  const series = DL.calcRollingPercentile(kline, divs, 375);
  const r3 = series.filter(x => x.dy != null && x.d >= '2023-01-01');
  const dys = r3.map(x => x.dy).sort((a, b) => a - b);
  const sp = r3.map(x => x.dy - treasuryAt(x.d)).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p / 100 * arr.length))];
  console.log(name + ': 股息率P90=' + q(dys, 90).toFixed(2) + ' vs 溢价P90=' + (q(sp, 90) + 1.55).toFixed(2) + '（回算dy口径） | 溢价P90本体=' + q(sp, 90).toFixed(2) + 'pp | 差异=' + Math.abs(q(dys, 90) - (q(sp, 90) + 1.55)).toFixed(2) + 'pp');
}
process.exit(0);
