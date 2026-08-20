#!/usr/bin/env node
/* P5 卖出端长窗口验证（v9.2 立项）：PB>P75/P90/P95 分位卖出信号的长窗口验证
 * 信号口径：与 data-layer.js calcPbPercentile 同源——每日 PB = 收盘价 ÷ 最近可得年报每股净资产(BPS)
 *   （年报按披露可得性：reportDate ≤ 当日−5 个月，即 5 月 1 日才可用上年年报）
 *   PB 分位 = 当日 PB 在近 500 交易日 PB 序列中的分位（样本 <250 天 → 无信号，无未来函数）
 *   触发 = 分位 ≥ P75 / P90 / P95 的连续区间首日（同 findZoneEvents 口径）
 * 长窗口：触发后 1/2/3 年 价格+分红收益
 * 卖飞风险：触发后继续涨的概率（期末价>触发价）+ 幅度（期内最大涨幅均值 / 期末涨幅均值）
 * 结论：P75/P90/P95 卖出信号在长窗口是否有效（该卖还是该拿）？
 * 数据：42 只真实日K+分红 + 东财 F10 年报 BPS（test/.f10-cache.json）
 * 运行：node test/p5-sell-window.js
 */
'use strict';
const lib = require('./bt-lib.js');
const fs = require('fs');
const path = require('path');
const { loadCache, loadStock, datesOf, buyReturn, baseline, mean, pct } = lib;

const OUT_MD = path.join(__dirname, 'reports', 'P5-sell-window.md');
const PB_WINDOW = 500;      // 分位窗口（同 calcPbPercentile 的 pbHist.slice(-500)）
const PB_MIN = 250;         // 最小样本
const LIMITS = [75, 90, 95];

/* 每日 PB 序列：[{d, pb}]（无未来函数：年报 5 个月后可用） */
function pbSeries(kline, dates, am) {
  const out = [];
  for (const d of dates) {
    const y = parseInt(d.slice(0, 4), 10);
    const m = parseInt(d.slice(5, 7), 10) - 5;
    const limY = m <= 0 ? y - 1 : y;
    const lim = limY + '-' + String(m <= 0 ? 12 + m : m).padStart(2, '0') + '-31';
    let best = null;
    for (const yr of Object.keys(am).map(Number).sort((a, b) => a - b)) {
      const a = am[yr];
      if (a.reportDate <= lim && a.bps != null && a.bps > 0) best = a;
    }
    const price = kline[d];
    if (best && price > 0) out.push({ d, pb: price / best.bps });
  }
  return out;
}
/* 滚动分位（窗口内小于等于占比，同 calcRollingPercentile 实现） */
function pbPctSeries(pbArr) {
  return pbArr.map((x, i) => {
    if (i < PB_MIN) return { d: x.d, pct: null, pb: x.pb };
    const win = pbArr.slice(Math.max(0, i - PB_WINDOW + 1), i + 1).map(v => v.pb);
    const sorted = [...win].sort((a, b) => a - b);
    const less = sorted.filter(v => v <= x.pb).length;
    return { d: x.d, pct: less / win.length * 100, pb: x.pb };
  });
}
/* 分位达标连续区间首日 */
function zoneStarts(series, th) {
  const evs = [];
  let inZ = false, start = null;
  for (const x of series) {
    if (x.pct == null) continue;
    if (x.pct >= th) { if (!inZ) { inZ = true; start = x.d; } }
    else { if (inZ) { evs.push(start); inZ = false; } }
  }
  if (inZ) evs.push(start);
  return evs;
}

(async () => {
  const cache = loadCache();
  const f10 = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '.f10-cache.json'), 'utf8')); } catch (e) { return {}; } })() || {};
  const annualMap = (arr) => {
    const m = {};
    (arr || []).forEach(a => { if (a && a.reportDate && /12-31/.test(a.reportDate) && a.bps != null && a.bps > 0) m[parseInt(a.reportDate.slice(0, 4), 10)] = a; });
    return m;
  };
  const evRows = [];   // {code, name, ind, th, d, r1, r2, r3, maxGain1, maxGain3, base1, base3}
  for (const s of lib.STOCKS) {
    const st = loadStock(cache, s.code);
    const dates = datesOf(st.kline);
    if (dates.length < 1000) continue;
    const am = annualMap(f10[s.code]);
    if (!Object.keys(am).length) continue;
    const pbArr = pbSeries(st.kline, dates, am);
    if (pbArr.length < PB_MIN + 100) continue;
    const ser = pbPctSeries(pbArr);
    const base1 = baseline(st.kline, dates, st.divs, 250, 800);
    const base2 = baseline(st.kline, dates, st.divs, 500, 800);
    const base3 = baseline(st.kline, dates, st.divs, 750, 800);
    for (const th of LIMITS) {
      for (const d of zoneStarts(ser, th)) {
        const i = dates.indexOf(d);
        if (i < 0) continue;
        const r1 = buyReturn(st.kline, dates, st.divs, i, 250);
        const r2 = buyReturn(st.kline, dates, st.divs, i, 500);
        const r3 = buyReturn(st.kline, dates, st.divs, i, 750);
        if (!r1 || !r2 || !r3) continue;
        /* 期内最大涨幅（价格口径，卖飞幅度）分 1 年/3 年窗口 */
        const buyP = st.kline[d];
        let max1 = buyP, max3 = buyP;
        for (let j = i + 1; j <= Math.min(i + 750, dates.length - 1); j++) {
          const p = st.kline[dates[j]];
          if (p > max3) max3 = p;
          if (j <= i + 250 && p > max1) max1 = p;
        }
        evRows.push({
          code: s.code, name: s.name, ind: s.ind, th, d,
          r1: r1.totalRet, r2: r2.totalRet, r3: r3.totalRet,
          pr1: r1.priceRet, pr3: r3.priceRet,
          maxGain1: max1 / buyP - 1, maxGain3: max3 / buyP - 1,
          base1: base1 ? base1.totalRet : null,
          base3: base3 ? base3.totalRet : null,
        });
      }
    }
  }
  /* 聚合 */
  const lines = [];
  lines.push('# P5 卖出端长窗口验证：PB>P75/P90/P95 分位卖出信号');
  lines.push('');
  lines.push(`> 数据：42 只真实日K+分红（2010-2026）+ 东财 F10 年报 BPS｜PB=收盘价÷最近可得年报BPS（年报 5 月 1 日起可用，无未来函数）｜分位=近 ${PB_WINDOW} 交易日滚动（样本≥${PB_MIN}）｜触发=分位达标连续区间首日｜收益含分红（不复投）`);
  lines.push('');
  const fmtPct = (x) => (x * 100).toFixed(1) + '%';
  for (const th of LIMITS) {
    const arr = evRows.filter(r => r.th === th);
    const n = arr.length;
    if (!n) continue;
    const agg = (f) => mean(arr.map(f));
    const upP = (f, thresh) => arr.filter(r => f(r) > thresh).length / n * 100;
    lines.push(`## P${th} 触发（${n} 次）`);
    lines.push('');
    lines.push('| 窗口 | 均收益(含分红) | 中位 | P10 | P90 | 继续涨概率 | 均值最大涨幅(卖飞幅度) | 基准(全时段随机) | 超额(pp) |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    const rows = [
      ['1 年', 'r1', 250], ['2 年', 'r2', 500], ['3 年', 'r3', 750],
    ];
    for (const [label, key, days] of rows) {
      const avg = agg(r => r[key]);
      const md = pct(arr.map(r => r[key]), 0.5);
      const p10 = pct(arr.map(r => r[key]), 0.1);
      const p90 = pct(arr.map(r => r[key]), 0.9);
      const upProb = upP(r => r[key], 0);
      const maxG = days === 250 ? agg(r => r.maxGain1) : agg(r => r.maxGain3);
      const baseKey = days === 750 ? 'base3' : 'base1';
      const base = mean(arr.filter(r => r[baseKey] != null).map(r => r[baseKey]));
      const ex = (avg - base) * 100;
      lines.push(`| ${label} | ${fmtPct(avg)} | ${fmtPct(md)} | ${fmtPct(p10)} | ${fmtPct(p90)} | ${upProb.toFixed(0)}% | ${fmtPct(maxG)} | ${fmtPct(base)} | ${ex.toFixed(1)} |`);
    }
    lines.push('');
  }
  lines.push('## 卖出 vs 持有的直接对比（触发后不卖 vs 卖，长窗口）');
  lines.push('');
  lines.push('| 信号 | n | 触发后1年收益 | 触发后3年收益 | 1年继续涨概率 | 3年继续涨概率 | 1年最大涨幅均值 | 3年最大涨幅均值 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const th of LIMITS) {
    const arr = evRows.filter(r => r.th === th);
    if (!arr.length) continue;
    lines.push(`| P${th} | ${arr.length} | ${fmtPct(mean(arr.map(r => r.r1)))} | ${fmtPct(mean(arr.map(r => r.r3)))} | ${(arr.filter(r => r.r1 > 0).length / arr.length * 100).toFixed(0)}% | ${(arr.filter(r => r.r3 > 0).length / arr.length * 100).toFixed(0)}% | ${fmtPct(mean(arr.map(r => r.maxGain1)))} | ${fmtPct(mean(arr.map(r => r.maxGain3)))} |`);
  }
  lines.push('');
  lines.push('> 注：继续涨概率=期末总收益>0 的占比（含分红）；最大涨幅=期内最高收盘价相对触发价的涨幅（卖飞幅度上限）。');
  lines.push('');
  /* 分行业（P90） */
  lines.push('## 分行业（P90 触发，1 年/3 年）');
  lines.push('');
  lines.push('| 行业 | n | 1年均收益 | 3年均收益 | 3年继续涨概率 |');
  lines.push('|---|---|---|---|---|');
  const byInd = {};
  evRows.filter(r => r.th === 90).forEach(r => { (byInd[r.ind] = byInd[r.ind] || []).push(r); });
  for (const [ind, arr] of Object.entries(byInd).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`| ${ind} | ${arr.length} | ${fmtPct(mean(arr.map(r => r.r1)))} | ${fmtPct(mean(arr.map(r => r.r3)))} | ${(arr.filter(r => r.r3 > 0).length / arr.length * 100).toFixed(0)}% |`);
  }
  /* 结论 */
  const c90 = evRows.filter(r => r.th === 90);
  const c75 = evRows.filter(r => r.th === 75);
  const c95 = evRows.filter(r => r.th === 95);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  const mk = (c, label) => {
    if (!c.length) return `- ${label}：样本不足`;
    const r1 = mean(c.map(x => x.r1)), r3 = mean(c.map(x => x.r3));
    const up1 = c.filter(x => x.r1 > 0).length / c.length * 100;
    const up3 = c.filter(x => x.r3 > 0).length / c.length * 100;
    const mg3 = mean(c.map(x => x.maxGain3));
    return `- **${label}**（n=${c.length}）：触发后 1 年均收益 ${fmtPct(r1)}（${up1.toFixed(0)}% 概率继续涨）、3 年 ${fmtPct(r3)}（${up3.toFixed(0)}% 概率继续涨）；3 年窗口内最大涨幅均值 ${fmtPct(mg3)}——${up3 > 50 ? '信号后继续上涨是常态，卖出=大概率卖飞，PB 高分位不是卖出依据' : r3 < 0 ? '信号后长期走低，卖出有保护价值' : '信号后表现分化，卖出依据弱'}。`;
  };
  lines.push(mk(c75, 'P75'));
  lines.push(mk(c90, 'P90'));
  lines.push(mk(c95, 'P95'));
  lines.push('');
  lines.push('> 口径说明：卖飞风险=触发后继续涨的概率与幅度（1/3 年期末正收益占比 + 期内最大涨幅）；基准=同股全时段随机买入 1 年/3 年均值。');
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  /* 终端 */
  console.log('===== P5 卖出端长窗口验证（PB 分位卖出信号）=====');
  for (const th of LIMITS) {
    const arr = evRows.filter(r => r.th === th);
    if (!arr.length) { console.log(`P${th}: 无样本`); continue; }
    const r1 = mean(arr.map(x => x.r1)), r3 = mean(arr.map(x => x.r3));
    const up1 = arr.filter(x => x.r1 > 0).length / arr.length * 100;
    const up3 = arr.filter(x => x.r3 > 0).length / arr.length * 100;
    const mg = mean(arr.map(x => x.maxGain));
    console.log(`P${th} (n=${arr.length}): 1年 ${fmtPct(r1)} 涨${up1.toFixed(0)}% | 3年 ${fmtPct(r3)} 涨${up3.toFixed(0)}% | 期内最大涨幅均值 ${fmtPct(mg)}`);
  }
  console.log('报告: test/reports/P5-sell-window.md');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
