#!/usr/bin/env node
/* P2 买入节奏验证（v9.2 立项）：触发后买入 vs 等 1 年/等 2 年再买，3 年持有收益对比（含分红口径）
 * 触发 = 行业买点线（BENCH yieldMid+yieldUp，与 signal-effectiveness.js 同口径）的股息率达标区间首日
 * 对比：
 *   A 立即买：T 日买入，持有 3 年（T→T+750）
 *   B 等1年买：T+250 日买入，持有 3 年（T+250→T+1000）
 *   C 等2年买：T+500 日买入，持有 3 年（T+500→T+1250）
 * 另附同终点对照（机会成本视角）：立即买3年 vs 等1年买2年 vs 等2年买1年（终点同为 T+750）
 * 结论回答：触发后立即买还是等更好？
 * 运行：node test/p2-rhythm.js
 */
'use strict';
const lib = require('./bt-lib.js');
const fs = require('fs');
const path = require('path');
const { DL, loadCache, loadStock, datesOf, buyReturn, zoneEventsDy, tierLines, mean, pct } = lib;

const OUT_MD = path.join(__dirname, 'reports', 'P2-rhythm.md');
const HOLD3 = 750;   // 3 年 = 750 交易日

function holdAt(kline, dates, divs, idx, holdDays) {
  const r = buyReturn(kline, dates, divs, idx, holdDays);
  return r ? r.totalRet : null;
}

(async () => {
  const cache = loadCache();
  const rows = [];   // {code, name, ind, trigger, imm3, wait1y3, wait2y3, wait1y2, wait2y1}
  for (const s of lib.STOCKS) {
    const tl = tierLines(s.ind);
    if (!tl) continue;
    const st = loadStock(cache, s.code);
    const dates = datesOf(st.kline);
    if (dates.length < 1200) continue;
    const series = DL.calcRollingPercentile(st.kline, st.divs, 375);
    const evs = zoneEventsDy(series, tl.line);   // 加仓线触发
    for (const d of evs) {
      const i = dates.indexOf(d);
      if (i < 0 || i + 1250 >= dates.length) continue;
      const imm3 = holdAt(st.kline, dates, st.divs, i, HOLD3);
      const w1y3 = holdAt(st.kline, dates, st.divs, i + 250, HOLD3);
      const w2y3 = holdAt(st.kline, dates, st.divs, i + 500, HOLD3);
      const w1y2 = holdAt(st.kline, dates, st.divs, i + 250, 500);
      const w2y1 = holdAt(st.kline, dates, st.divs, i + 500, 250);
      if (imm3 == null || w1y3 == null || w2y3 == null) continue;
      rows.push({ code: s.code, name: s.name, ind: s.ind, d, imm3, w1y3, w2y3, w1y2, w2y1 });
    }
  }
  const R = rows.length;
  const q = (arr, p) => pct(arr, p);
  const fmt = (x, d = 1) => (x * 100).toFixed(d);
  const lines = [];
  lines.push('# P2 买入节奏验证：触发后立即买 vs 等 1/2 年再买');
  lines.push('');
  lines.push(`> 数据：42 只真实历史日K+分红（2010-2026，rule-tree-cache.json）｜触发=行业买点线（BENCH 加仓线）股息率达标区间首日｜持有期含分红（除息 dps 计入，不复投）｜3 年=750 交易日`);
  lines.push('');
  lines.push(`**样本：${R} 次触发**`);
  lines.push('');
  lines.push('## 1. 主对比：各自持有 3 年（终点不同）');
  lines.push('');
  lines.push('| 节奏 | 均值收益 | 中位 | P10 | P90 | 盈利占比 |');
  lines.push('|---|---|---|---|---|---|');
  const imm3s = rows.map(r => r.imm3), w1s = rows.map(r => r.w1y3), w2s = rows.map(r => r.w2y3);
  const winPct = a => (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%';
  lines.push(`| 立即买（T 买入持 3 年） | ${fmt(mean(imm3s))}% | ${fmt(q(imm3s, 0.5))}% | ${fmt(q(imm3s, 0.1))}% | ${fmt(q(imm3s, 0.9))}% | ${winPct(imm3s)} |`);
  lines.push(`| 等 1 年买（T+1y 买入持 3 年） | ${fmt(mean(w1s))}% | ${fmt(q(w1s, 0.5))}% | ${fmt(q(w1s, 0.1))}% | ${fmt(q(w1s, 0.9))}% | ${winPct(w1s)} |`);
  lines.push(`| 等 2 年买（T+2y 买入持 3 年） | ${fmt(mean(w2s))}% | ${fmt(q(w2s, 0.5))}% | ${fmt(q(w2s, 0.1))}% | ${fmt(q(w2s, 0.9))}% | ${winPct(w2s)} |`);
  const d1 = rows.map(r => r.w1y3 - r.imm3), d2 = rows.map(r => r.w2y3 - r.imm3);
  lines.push('');
  lines.push(`**等待差值（等1年 − 立即）：均值 ${fmt(mean(d1))}pp ｜ 中位 ${fmt(q(d1, 0.5))}pp ｜ 等待更优占比 ${(d1.filter(x => x > 0).length / R * 100).toFixed(0)}%**`);
  lines.push(`**等待差值（等2年 − 立即）：均值 ${fmt(mean(d2))}pp ｜ 中位 ${fmt(q(d2, 0.5))}pp ｜ 等待更优占比 ${(d2.filter(x => x > 0).length / R * 100).toFixed(0)}%**`);
  lines.push('');
  lines.push('## 2. 同终点对照（机会成本视角：终点同为 T+3y）');
  lines.push('');
  lines.push('| 节奏 | 均值收益 | 中位 | 盈利占比 |');
  lines.push('|---|---|---|---|');
  const i3 = rows.map(r => r.imm3), w12 = rows.map(r => r.w1y2), w21 = rows.map(r => r.w2y1);
  lines.push(`| 立即买 3 年 | ${fmt(mean(i3))}% | ${fmt(q(i3, 0.5))}% | ${winPct(i3)} |`);
  lines.push(`| 等 1 年买 2 年 | ${fmt(mean(w12))}% | ${fmt(q(w12, 0.5))}% | ${winPct(w12)} |`);
  lines.push(`| 等 2 年买 1 年 | ${fmt(mean(w21))}% | ${fmt(q(w21, 0.5))}% | ${winPct(w21)} |`);
  const e1 = rows.map(r => r.w1y2 - r.imm3), e2 = rows.map(r => r.w2y1 - r.imm3);
  lines.push('');
  lines.push(`**同终点差值（等1年买2年 − 立即买3年）：均值 ${fmt(mean(e1))}pp ｜ 更优占比 ${(e1.filter(x => x > 0).length / R * 100).toFixed(0)}%**`);
  lines.push(`**同终点差值（等2年买1年 − 立即买3年）：均值 ${fmt(mean(e2))}pp ｜ 更优占比 ${(e2.filter(x => x > 0).length / R * 100).toFixed(0)}%**`);
  lines.push('');
  lines.push('## 3. 分行业（立即买 3 年 vs 等 1 年买 3 年）');
  lines.push('');
  lines.push('| 行业 | 触发数 | 立即买均值 | 等1年买均值 | 差(pp) | 等更优占比 |');
  lines.push('|---|---|---|---|---|---|');
  const byInd = {};
  rows.forEach(r => { (byInd[r.ind] = byInd[r.ind] || []).push(r); });
  for (const [ind, arr] of Object.entries(byInd)) {
    const m3 = mean(arr.map(r => r.imm3)), w3 = mean(arr.map(r => r.w1y3));
    lines.push(`| ${ind} | ${arr.length} | ${fmt(m3)}% | ${fmt(w3)}% | ${fmt(w3 - m3)} | ${(arr.filter(r => r.w1y3 > r.imm3).length / arr.length * 100).toFixed(0)}% |`);
  }
  lines.push('');
  /* 分时段稳健性 */
  lines.push('## 4. 分时段稳健性（立即买 vs 等1年买）');
  lines.push('');
  lines.push('| 时段 | 触发数 | 立即买均值 | 等1年买均值 | 差(pp) |');
  lines.push('|---|---|---|---|---|');
  const segs = [['2010-2014', '2010-01-01', '2014-12-31'], ['2015-2018', '2015-01-01', '2018-12-31'], ['2019-2022', '2019-01-01', '2022-12-31'], ['2023-2026', '2023-01-01', '2026-12-31']];
  for (const [label, a, b] of segs) {
    const arr = rows.filter(r => r.d >= a && r.d <= b);
    if (!arr.length) { lines.push(`| ${label} | 0 | - | - | - |`); continue; }
    const m3 = mean(arr.map(r => r.imm3)), w3 = mean(arr.map(r => r.w1y3));
    lines.push(`| ${label} | ${arr.length} | ${fmt(m3)}% | ${fmt(w3)}% | ${fmt(w3 - m3)} |`);
  }
  /* 结论 */
  const dMean = mean(d1);
  const dMeanPp = dMean * 100;   // 转为 pp 再与阈值比较（d1 是收益差值小数，阈值是 pp）
  let concl;
  if (dMeanPp > 3) concl = '**结论：等 1 年再买显著更优（均值差值 >3pp）——触发后不急于立即买入，等待能拿到更便宜筹码。**';
  else if (dMeanPp > 0.5) concl = '**结论：等 1 年再买略优（均值差值 0.5~3pp）——触发后可分批/留部分现金等待，但等待收益有限。**';
  else if (dMeanPp > -3) concl = '**结论：立即买与等 1 年买接近（差值 ±3pp 内）——触发即买不吃亏，等待只是锦上添花，应优先保证仓位在场（防踏空）。**';
  else concl = '**结论：立即买显著更优（等 1 年差值 <−3pp）——等待机会成本高，触发即买。**';
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(concl);
  lines.push('');
  lines.push(`> 附：P10/P90 展示分布尾部；等待差值=等1年买3年收益 − 立即买3年收益（含分红）。同终点对照剔除"等待期间踏空/错过"的持有期差异，仅衡量部署时点选择。`);
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  /* 终端摘要 */
  console.log('===== P2 买入节奏验证（42 只 × 2010-2026，加仓线触发，含分红）=====');
  console.log(`触发 ${R} 次`);
  console.log(`立即买3年: 均值 ${fmt(mean(imm3s))}% 中位 ${fmt(q(imm3s, 0.5))}% 盈利 ${winPct(imm3s)}`);
  console.log(`等1年买3年: 均值 ${fmt(mean(w1s))}% 中位 ${fmt(q(w1s, 0.5))}% 盈利 ${winPct(w1s)}`);
  console.log(`等2年买3年: 均值 ${fmt(mean(w2s))}% 中位 ${fmt(q(w2s, 0.5))}% 盈利 ${winPct(w2s)}`);
  console.log(`差值(等1-立即): 均值 ${fmt(mean(d1))}pp 等更优 ${(d1.filter(x => x > 0).length / R * 100).toFixed(0)}%`);
  console.log(`同终点: 立即3年 ${fmt(mean(i3))}% vs 等1买2年 ${fmt(mean(w12))}% vs 等2买1年 ${fmt(mean(w21))}%`);
  console.log(concl);
  console.log('报告: test/reports/P2-rhythm.md');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
