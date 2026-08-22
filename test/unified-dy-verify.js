#!/usr/bin/env node
/* 第0步：复权口径统一验证（2026-08-20 v9.1 封版执行）
 * 统一口径：不复权K线 + 年度DPS（含中期，按REPORT_DATE年份汇总）
 * 对比：修复前（只统计12-31报告期=漏中期）vs 修复后（全部报告期按年份汇总）
 * 验证：40只行业聚合 P75/P90/P95 触发频率 + 1/3/5/10年收益
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));
const IND = {
  bank: ['600036', '601398', '601988', '601288', '601328', '600016', '000001', '601166'],
  consumer: ['600519', '000858', '000895', '600887', '000651', '000333', '600690'],
  utility: ['600900', '600886', '600027', '600795', '601985'],
  energy: ['600028', '601857', '601088', '600188', '601225'],
};
const IND_NAME = { bank: '银行', consumer: '消费', utility: '公用', energy: '能源' };
// 分位线=dy分位（溢价pp+国债1.681%），与工具一致
const LINES = {
  bank: { p75: 3.89 + 1.681, p90: 4.15 + 1.681, p95: 4.3 + 1.681 },
  consumer: { p75: 3.1 + 1.681, p90: 3.7 + 1.681, p95: 4.0 + 1.681 },
  utility: { p75: 2.9 + 1.681, p90: 3.4 + 1.681, p95: 3.6 + 1.681 },
  energy: { p75: 3.4 + 1.681, p90: 4.0 + 1.681, p95: 4.3 + 1.681 },
};
const WINS = { '1年': 250, '3年': 750, '5年': 1250, '10年': 2500 };

function loadStock(code, fixed) {
  const karr = cache[code + ':k'] || [], divs = cache[code + ':d'] || [];
  const kline = {}; karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  const divY = {};
  divs.forEach(d => {
    if (!(d.dps > 0) || !d.report) return;
    const y = d.report.slice(0, 4);
    if (fixed) { divY[y] = (divY[y] || 0) + d.dps; }  // 修复：所有报告期按年份汇总（含中期）
    else if (/12-31/.test(d.report)) divY[y] = (divY[y] || 0) + d.dps;  // 旧：只统计12-31
  });
  return { kline, divY, divs };
}

function runAll(fixed) {
  const out = {};
  for (const [ind, codes] of Object.entries(IND)) {
    const st = { p75: {}, p90: {}, p95: {} };
    for (const t of ['p75', 'p90', 'p95']) for (const w of Object.keys(WINS)) st[t][w] = { n: 0, sum: 0, pos: 0 };
    const evCount = { p75: 0, p90: 0, p95: 0 };
    for (const code of codes) {
      const s = loadStock(code, fixed);
      const dates = Object.keys(s.kline).sort();
      if (dates.length < 900) continue;
      const series = [];
      for (let i = 0; i < dates.length; i++) {
        const y = parseInt(dates[i].slice(0, 4), 10);
        const dps = s.divY[y - 1] || 0;
        if (dps > 0 && s.kline[dates[i]] > 0) series.push({ d: dates[i], dy: dps / s.kline[dates[i]] * 100 });
      }
      for (const t of ['p75', 'p90', 'p95']) {
        const line = LINES[ind][t];
        const evs = []; let inZ = false;
        for (const x of series) { if (x.dy >= line) { if (!inZ) { evs.push(x.d); inZ = true; } } else inZ = false; }
        evCount[t] += evs.length;
        for (const d of evs) {
          const idx = dates.indexOf(d);
          for (const [wn, wd] of Object.entries(WINS)) {
            const end = idx + wd;
            if (end >= dates.length) continue;
            const p0 = s.kline[d], p1 = s.kline[dates[end]];
            if (!(p0 > 0) || !(p1 > 0)) continue;
            let dd = 0;
            s.divs.forEach(x => { if (x.ex && x.dps > 0 && x.ex > d && x.ex <= dates[end]) dd += x.dps; });
            const r = (p1 + dd) / p0 - 1;
            st[t][wn].n++; st[t][wn].sum += r; if (r > 0) st[t][wn].pos++;
          }
        }
      }
    }
    out[ind] = { st, evCount };
  }
  return out;
}

console.log('========== 修复前（漏中期） vs 修复后（含中期）对比 ==========');
for (const [label, fixed] of [['【修复前·漏中期】', false], ['【修复后·含中期】', true]]) {
  console.log('\n' + label);
  const res = runAll(fixed);
  for (const [ind, d] of Object.entries(res)) {
    for (const t of ['p75', 'p90', 'p95']) {
      const per10 = Math.round(d.evCount[t] / 16 * 10);
      let line = `${IND_NAME[ind]} ${t.toUpperCase()}线(${LINES[ind][t].toFixed(2)}%): 每10年约${per10}次 |`;
      for (const w of ['1年', '3年', '5年', '10年']) {
        const s = d.st[t][w];
        if (s.n) line += ` ${w}N=${s.n} ${(s.sum / s.n * 100).toFixed(0)}%正${(s.pos / s.n * 100).toFixed(0)}% |`;
        else line += ` ${w}N=0 |`;
      }
      console.log(line);
    }
  }
}
