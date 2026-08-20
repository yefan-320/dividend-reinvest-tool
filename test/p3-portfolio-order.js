#!/usr/bin/env node
/* P3 组合联动排序（M4）：多只同时触发时按什么优先级买？
 * 规则候选：
 *  A. 证据分数（等级制 score）降序
 *  B. 等级（L5>L4>L3>L2>L1）降序
 *  C. 股息率降序
 *  D. 历史胜率（SIG_STATS 行业 heavy 胜率）降序
 * 用真实触发场景演示排序结果，输出排序规则建议。
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const ts = DL.tradingSignal;
const fs = require('fs');

/* 当前 7 只持仓的等级制输出（用真实缓存 dy 近似模拟触发） */
const indNull = { signals: [], level: null, msg: null };
const STOCKS = [
  { code: '600036', name: '招行', dy: 6.2, tier: 'p95', industry: '银行', finGood: true },
  { code: '601398', name: '工行', dy: 6.1, tier: 'p95', industry: '银行', finGood: true },
  { code: '000333', name: '美的', dy: 5.7, tier: 'p90', industry: '家用电器', finGood: true },
  { code: '600066', name: '宇通', dy: 8.3, tier: 'p95', industry: '汽车制造', finGood: true },
  { code: '600887', name: '伊利', dy: 5.5, tier: 'p90', industry: '食品饮料', finGood: false },
  { code: '600941', name: '移动', dy: 5.2, tier: 'p90', industry: '电信运营', finGood: true },
  { code: '601318', name: '平安', dy: 5.7, tier: 'p95', industry: '保险', finGood: true },
];
const rows = STOCKS.map(s => {
  const r = ts({ code: s.code, dy: s.dy, tier: s.tier, trendOk: true, finOk: s.finGood, finChecks: [], lastBuyDays: null, industrySignals: indNull, industry: s.industry, finGood: s.finGood, valuation: null });
  const score = parseInt((r.reason.match(/证据(\d+)分/) || [])[1] || 0, 10);
  const indKey = DL.indKeyOf(s.industry);
  const heavy = DL.SIG_STATS[indKey] && DL.SIG_STATS[indKey].heavy;
  const winP = heavy ? parseFloat(heavy.all) : null;
  return { ...s, level: r.level, strength: r.strength, score, winP, text: r.text };
});
// 触发过滤（L1=观察 不排，只排真触发）
const triggered = rows.filter(r => r.level && r.level !== 'L1');
console.log('=== P3 组合联动排序（多只同时触发时）===');
console.log('排序规则 | 顺序');
const byScore = [...triggered].sort((a, b) => b.score - a.score).map(r => `${r.name}(${r.level})`).join(' > ');
const byLevel = [...triggered].sort((a, b) => ({ L5: 5, L4: 4, L3: 3, L2: 2, L1: 1 }[b.level] - { L5: 5, L4: 4, L3: 3, L2: 2, L1: 1 }[a.level])).map(r => `${r.name}(${r.level})`).join(' > ');
const byDy = [...triggered].sort((a, b) => b.dy - a.dy).map(r => `${r.name}(${r.dy.toFixed(1)}%)`).join(' > ');
const byWin = [...triggered].sort((a, b) => (b.winP || 0) - (a.winP || 0)).map(r => `${r.name}(${r.winP != null ? r.winP + '%' : '无'})`).join(' > ');
console.log('证据分数 | ' + byScore);
console.log('等级    | ' + byLevel);
console.log('股息率  | ' + byDy);
console.log('行业胜率| ' + byWin);

const out = `# P3 组合联动排序（2026-08-20）

> 多只同时触发时按什么优先级买？用 7 只持仓真实等级输出演示 4 种排序规则。

| 标的 | 等级 | 强度 | 证据分 | dy | 行业胜率 |
|---|---|---|---|---|---|
${rows.map(r => `| ${r.name} | ${r.level || '—'} | ${r.strength} | ${r.score} | ${r.dy}% | ${r.winP != null ? r.winP + '%' : '—'} |`).join('\n')}

## 四种排序结果
- 证据分数：${byScore}
- 等级：${byLevel}
- 股息率：${byDy}
- 行业胜率：${byWin}

## 建议（组合约束联动）
1. **主排序=等级制（证据分数）**：与买入指令同源，不引入第二套逻辑
2. **辅助=行业胜率**：同等级时优先行业历史胜率高者（bank 96% > utility 100% > consumer 62%）
3. **组合约束过滤优先**：行业超限（≥3只）先降级再排（v7 规则）
4. 股息率仅作展示不作排序（价格分位已含股息率信息，重复排序无增益）
`;
fs.writeFileSync('/Users/macbookpro/Documents/dividend-tool/repo/test/reports/P3-portfolio-order.md', out);
console.log('\n报告: test/reports/P3-portfolio-order.md');
process.exit(0);
