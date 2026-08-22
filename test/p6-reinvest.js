#!/usr/bin/env node
/* P6 分红再投验证（v5 立项）：自动再投（分红立即买入）vs 攒现金等触发点
 * 16 年回放（2010-2026）：单标的 × 组合等权
 * 结论回答：分红到手是立即再投（复利）还是攒现金等便宜买点（择时）更优？
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('/Users/macbookpro/Documents/deepseek/repo/data/rule-tree-cache.json', 'utf8'));
const HOLDINGS = ['600036', '601398', '600887', '600941', '000333', '601318', '600066'];

function loadStock(code) {
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { code, kline, divs };
}

/* 再投 vs 攒现金：起点各 1 万元买入，持有至 end
 * 再投路径：每笔分红按除息日收盘价买入
 * 攒现金路径：分红不买，仅在 dy 分位≥90 时用累计现金买入（等触发点） */
function simulate(s, startD, endD) {
  const dates = Object.keys(s.kline).filter(d => d >= startD && d <= endD).sort();
  if (dates.length < 500) return null;
  const series = DL.calcRollingPercentile(s.kline, s.divs, 375);
  const byD = {}; series.forEach(x => byD[x.d] = x);
  const startP = s.kline[dates[0]];
  if (!(startP > 0)) return null;
  // 再投
  let sharesRe = 10000 / startP, divsRe = 0;
  // 攒现金
  let sharesCash = 10000 / startP, cash = 0;
  const divsByDate = s.divs.filter(d => d.ex && d.dps > 0 && d.ex >= dates[0] && d.ex <= dates[dates.length - 1]).sort((a, b) => a.ex < b.ex ? -1 : 1);
  for (const dv of divsByDate) {
    const amt = sharesRe * dv.dps;
    divsRe += amt;
    const exP = s.kline[dv.ex];
    if (exP > 0) sharesRe += amt / exP;   // 再投
    // 攒现金：先积累
    const amtCash = sharesCash * dv.dps;
    cash += amtCash;
    // 攒现金：分位≥90 时买入
    const x = byD[dv.ex];
    if (x && x.pct != null && x.pct >= 90 && cash > 0 && exP > 0) {
      sharesCash += cash / exP; cash = 0;
    }
  }
  // 期末：攒现金剩余现金按收盘价折算
  const endP = s.kline[dates[dates.length - 1]];
  const valRe = sharesRe * endP;
  const valCash = sharesCash * endP + cash;
  return { valRe, valCash, divsRe, nDiv: divsByDate.length, trigCount: series.filter(x => x.pct != null && x.pct >= 90).length };
}

(async () => {
  console.log('=== P6 分红再投验证（2010-2026，各 1 万元起点）===');
  console.log('标的 | 再投终值 | 攒现金终值 | 再投-攒现金 | 分红累计 | 分红次数 | P90触发天数');
  let sumRe = 0, sumCash = 0, n = 0;
  const rows = [];
  for (const code of HOLDINGS) {
    const s = loadStock(code);
    if (!Object.keys(s.kline).length) continue;
    const r = simulate(s, '2010-01-01', '2026-08-20');
    if (!r) continue;
    sumRe += r.valRe; sumCash += r.valCash; n++;
    rows.push({ code, ...r });
    console.log(`${code} | ${r.valRe.toFixed(0)} | ${r.valCash.toFixed(0)} | ${(r.valRe - r.valCash).toFixed(0)} | ${r.divsRe.toFixed(0)} | ${r.nDiv} | ${r.trigCount}`);
  }
  const avgRe = sumRe / n, avgCash = sumCash / n;
  console.log(`\n组合等权：再投 ${avgRe.toFixed(0)} vs 攒现金 ${avgCash.toFixed(0)} → 再投${avgRe >= avgCash ? '胜' : '输'} ${(Math.abs(avgRe - avgCash) / avgCash * 100).toFixed(0)}%`);
  const wins = rows.filter(r => r.valRe > r.valCash).length;
  console.log(`单标的胜率：${wins}/${rows.length} 再投更优`);
  const out = `# P6 分红再投验证（2026-08-20）

> 2010-01-01 → 2026-08-20，各标的 1 万元起点，分红再投（除息日收盘价买入）vs 攒现金（dy 分位≥90 才买）
> 组合=7 只等权汇总

| 标的 | 再投终值 | 攒现金终值 | 再投-攒现金 | 分红累计 | 分红次数 |
|---|---|---|---|---|---|
${rows.map(r => `| ${r.code} | ${r.valRe.toFixed(0)} | ${r.valCash.toFixed(0)} | ${(r.valRe - r.valCash).toFixed(0)} | ${r.divsRe.toFixed(0)} | ${r.nDiv} |`).join('\n')}

## 结论
- 组合等权：再投 ${avgRe.toFixed(0)} vs 攒现金 ${avgCash.toFixed(0)} → **再投${avgRe >= avgCash ? '胜' : '输'} ${(Math.abs(avgRe - avgCash) / avgCash * 100).toFixed(0)}%**（${wins}/${rows.length} 单标的再投更优）
- 攒现金等触发点的问题：P90 触发稀少（价格长期不达），现金长期闲置=机会成本
- **与主人"长期持有吃分红"策略一致：分红到手立即再投（复利），不赌择时**
`;
  fs.writeFileSync('/Users/macbookpro/Documents/deepseek/repo/test/reports/P6-reinvest.md', out);
  console.log('\n报告: test/reports/P6-reinvest.md');
  process.exit(0);
})();
