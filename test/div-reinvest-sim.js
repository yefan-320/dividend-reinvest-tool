#!/usr/bin/env node
/* ============================================================
 * 分红复投模拟器（v2.0 参数 #1 复投率 / #1b 按成长性分配 的数据底座）
 * 2026-08-21 主人令：模拟脚本必须存 repo，防"数字无出处"再犯（协议第 7 条）
 *
 * 口径说明：
 * - 单股模型：首年分红 = 本金 × 股息率；10 年后年分红 = 首年分红 × (1+CAGR)^10
 *   （分红再投自身，按 CAGR 增长）
 * - 组合模型：70 万等额 7 只；首年总分红 = Σ(每只 10 万 × 股息率)
 *   复投率 p：每年新增分红按 p 买入组合（组合年化回报 R），(1-p) 花掉
 *   ——组合年化 R 用中性 8% 假设（CAGR 假设参数 #1c，可切历史/8%/5%）
 * - 历史口径数字（20:53 轮报告：0.51/1.19/14.1 万、11.9/9.2 万）为方向性估算，
 *   精确模型以本脚本为准（主人 21:00 拍板：中性 8% 为定稿默认）
 * ============================================================ */
const HOLDINGS = [
  { name: '宇通', dy: 0.0666, cagr3: 0.357 },
  { name: '美的', dy: 0.0460, cagr3: 0.198 },
  { name: '伊利', dy: 0.0515, cagr3: 0.099 },
  { name: '移动', dy: 0.0485, cagr3: 0.067 },
  { name: '招行', dy: 0.0513, cagr3: 0.051 },
  { name: '工行', dy: 0.0396, cagr3: 0.007 },
  { name: '平安', dy: 0.0353, cagr3: 0.037 },   // 修复后真实 CAGR（2026-08-21 主人抓 bug）
];

function singleStock(principal, dy, cagr, years) {
  const first = principal * dy;
  const last = first * Math.pow(1 + cagr, years);
  return { first, last, growth: last / first - 1 };
}

function portfolio(total, years, reinvestRate, R) {
  const per = total / HOLDINGS.length;
  let dividend = HOLDINGS.reduce((s, h) => s + per * h.dy, 0);   // 首年总分红
  let principal = total;
  let spent = 0;
  for (let i = 0; i < years; i++) {
    const reinvest = dividend * reinvestRate;
    spent += dividend - reinvest;
    principal += reinvest;                                        // 复投进组合
    dividend = principal * R;                                     // 分红基数随组合增长
  }
  return { dividend, spent };
}

console.log('=== 单股模型：10 万本金，10 年 ===');
console.log('平安复投平安(+3.7%)  : 10年后年分红', (singleStock(100000, 0.0353, 0.037, 10).last / 10000).toFixed(2), '万 涨幅 +' + (singleStock(100000, 0.0353, 0.037, 10).growth * 100).toFixed(0) + '%');
console.log('平安转投增长股(中性8%): 10年后年分红', (singleStock(100000, 0.0353, 0.08, 10).last / 10000).toFixed(2), '万 涨幅 +' + (singleStock(100000, 0.0353, 0.08, 10).growth * 100).toFixed(0) + '%');
console.log('平安转投宇通(历史35.7%): 10年后年分红', (singleStock(100000, 0.0666, 0.357, 10).last / 10000).toFixed(2), '万（上限参考）');

console.log('\n=== 组合模型：70 万等额 7 只，10 年，中性 R=8% ===');
for (const p of [0, 0.3, 0.5, 1]) {
  const r = portfolio(700000, 10, p, 0.08);
  console.log(`复投率 ${String(p * 100).padStart(3)}%: 10年后年分红 ${(r.dividend / 10000).toFixed(1)} 万 | 累计花掉 ${(r.spent / 10000).toFixed(1)} 万`);
}

console.log('\n=== 组合模型：不同 CAGR 假设（复投率 100%） ===');
for (const [label, R] of [['历史加权', 0.12], ['中性8%', 0.08], ['保守5%', 0.05]]) {
  const r = portfolio(700000, 10, 1, R);
  console.log(`${label.padEnd(6)}: 10年后年分红 ${(r.dividend / 10000).toFixed(1)} 万`);
}
