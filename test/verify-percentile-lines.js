#!/usr/bin/env node
/* 分位线合理性验证（主人质疑：15年前数据机械比现在？）
 * ① 十年期国债历史环境 ② 6只持仓风险溢价/增长修正总回报 ③ 窗口敏感性（近1/3/5/全历史 P90）④ 季度 P90 波动（大师漂移阈值）
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));
const H = [['600036','招商银行'],['601398','工商银行'],['600887','伊利股份'],['600941','中国移动'],['000333','美的集团'],['601318','中国平安']];
const CUR_DY = { '600036': 5.28, '601398': 4.05, '600887': 5.47, '600941': 4.91, '000333': 5.14, '601318': 5.26 };

function loadStock(code) {
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { kline, divs };
}
function p90Of(kline, divs, from) {
  const series = DL.calcRollingPercentile(kline, divs, 375);
  const r = series.filter(x => x.dy != null && x.d >= from).map(x => x.dy).sort((a, b) => a - b);
  if (r.length < 100) return null;
  return r[Math.min(r.length - 1, Math.floor(0.9 * r.length))];
}
// 季度 P90：每季末往前375天窗口的 P90
function quarterlyP90s(kline, divs, from) {
  const series = DL.calcRollingPercentile(kline, divs, 375);
  const byQ = {};
  series.forEach(x => {
    if (x.dy == null || x.d < from) return;
    const q = x.d.slice(0, 7) + (x.d.slice(5, 7) <= '03' ? 'Q1' : x.d.slice(5, 7) <= '06' ? 'Q2' : x.d.slice(5, 7) <= '09' ? 'Q3' : 'Q4');
    const ym = x.d.slice(0, 7);
    // 每季取该季最后一个交易日
    byQ[ym] = byQ[ym] || [];
    byQ[ym].push(x.dy);
  });
  const out = [];
  Object.keys(byQ).sort().forEach(ym => {
    const arr = byQ[ym].sort((a, b) => a - b);
    out.push({ ym, p90: arr[Math.min(arr.length - 1, Math.floor(0.9 * arr.length))] });
  });
  return out;
}

(async () => {
  // ① 十年期国债（用中债/东财近似：直接列已知环境锚）
  console.log('==== ① 利率环境（十年期国债近似，%）：2010≈4.0 2015≈3.5 2020≈3.2 2023≈2.6 2024≈2.2 2025≈1.7 2026≈1.5-1.6 ====');
  console.log('');
  console.log('==== ② 6 只持仓：当前股息率 vs 利率环境（风险溢价）+ 增长修正总回报 ====');
  console.log('股票 | 当前dy | 风险溢价(dy-1.55) | 分红CAGR | 增长修正总回报(dy+CAGR)');
  const M = { '600036': 5.1, '601398': 0.7, '600887': 9.9, '600941': 6.7, '000333': 19.8, '601318': 3.7 };
  for (const [code, name] of H) {
    const dy = CUR_DY[code];
    console.log(name + ' | ' + dy + '% | ' + (dy - 1.55).toFixed(2) + 'pp | ' + M[code] + '% | ' + (dy + M[code]).toFixed(1) + '%');
  }
  console.log('');
  console.log('==== ③ 窗口敏感性：P90 线随窗口变化（近1/2/3/5年/全历史） ====');
  const WINS = [['近1年', '2025-01-01'], ['近2年', '2024-01-01'], ['近3年', '2023-01-01'], ['近5年', '2021-01-01'], ['全历史', '2000-01-01']];
  for (const [code, name] of H) {
    const s = loadStock(code);
    if (!Object.keys(s.kline).length) { console.log(name + ': 无K线'); continue; }
    const parts = [name];
    for (const [wn, from] of WINS) {
      const p90 = p90Of(s.kline, s.divs, from);
      parts.push(wn + '=' + (p90 != null ? p90.toFixed(2) : '—'));
    }
    console.log(parts.join(' | '));
  }
  console.log('');
  console.log('==== ④ 季度 P90 波动（近3年每季末 P90，大师漂移阈值数据） ====');
  for (const [code, name] of H) {
    const s = loadStock(code);
    if (!Object.keys(s.kline).length) { console.log(name + ': 无K线'); continue; }
    const qs = quarterlyP90s(s.kline, s.divs, '2023-01-01');
    const vals = qs.map(q => q.p90);
    if (vals.length < 6) { console.log(name + ': 季度样本不足'); continue; }
    // 相邻季度差
    const diffs = [];
    for (let i = 1; i < vals.length; i++) diffs.push(Math.abs(vals[i] - vals[i - 1]));
    const maxDiff = Math.max(...diffs).toFixed(2);
    const meanDiff = (diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(2);
    console.log(name + ': 季末P90序列=' + vals.map(v => v.toFixed(2)).join(',') + ' | 最大季差=' + maxDiff + 'pp | 平均季差=' + meanDiff + 'pp');
  }
  process.exit(0);
})();
