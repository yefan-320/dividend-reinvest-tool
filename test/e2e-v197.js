#!/usr/bin/env node
/* 等级制 e2e 断言（2026-08-20 大师 A 定稿落地验证）：
 * 核心：P95 首触→L3（非 L5）降档验证 + 双背书放行 L4/L5 + 卖出等级 + 财报否决 + 冷却/趋势闸
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;
const ts = DL.tradingSignal;

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (detail ? ' — ' + detail : '')); }
}

/* 场景构造 */
const indNull = { signals: [], level: null, msg: null };

/* 1. P95 首触降档（平安 601318：P95_TRIGGERS=0）→ L3 小仓，非 L5 */
{
  const r = ts({ code: '601318', dy: 6.2, tier: 'p95', trendOk: true, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: indNull, industry: '保险', finGood: true, valuation: null });
  assert('P95首触(0次)→L3小仓非L5', r.action === 'buy_L3' && r.level === 'L3' && r.strength === '1/3', r.action + ' ' + r.reason);
  assert('P95首触降档注明等验证', r.reason.includes('首触降档'), r.reason);
}

/* 2. P95 有背书（招行 600036：触发20次 + bank heavy 96% n=80）→ L5 重仓 */
{
  const r = ts({ code: '600036', dy: 6.2, tier: 'p95', trendOk: true, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: indNull, industry: '银行', finGood: true, valuation: null });
  assert('P95有背书(20次+行业96%)→L5重仓', r.action === 'buy_L5' && r.level === 'L5' && r.strength === '上限', r.action + ' ' + r.reason);
}

/* 3. P90 + 有背书 → L4 加仓 */
{
  const r = ts({ code: '600036', dy: 5.2, tier: 'p90', trendOk: true, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: indNull, industry: '银行', finGood: true, valuation: null });
  assert('P90有背书→L4加仓(2/3)', r.action === 'buy_L4' && r.strength === '2/3', r.action + ' ' + r.reason);
}

/* 4. 行业无背书（consumer heavy 62% <80%）→ P95 也最多 L3 */
{
  const r = ts({ code: '600887', dy: 6.2, tier: 'p95', trendOk: true, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: indNull, industry: '食品饮料', finGood: true, valuation: null });
  assert('行业无背书(consumer 62%)→最高L3', r.action === 'buy_L3', r.action + ' ' + r.reason);
}

/* 5. 财报否决：finOk=false 即使 P95 → 禁止买入 */
{
  const r = ts({ code: '600036', dy: 6.2, tier: 'p95', trendOk: true, finOk: false, finChecks: ['扣非同比-20%（恶化>10%）'], lastBuyDays: null, industrySignals: indNull, industry: '银行', finGood: false, valuation: null });
  assert('财报不过关→禁止买入', r.action === 'hold' && r.text.includes('禁止买入'), r.text);
}

/* 6. 卖出等级：hard→S3 清仓 / soft→S2 减半 / watch→S1 观察 */
{
  const r1 = ts({ code: '600036', dy: 5, tier: null, trendOk: true, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: { signals: ['扣非转负','扣非下滑','毛利率连降S1'], level: 'hard', msg: '硬红灯' }, industry: '银行' });
  assert('hard→S3清仓(强度1.0)', r1.action === 'sell' && r1.level === 'S3' && r1.strength === '1.0', r1.action + ' ' + r1.level);
  const r2 = ts({ code: '600036', dy: 5, tier: null, trendOk: true, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: { signals: ['扣非下滑','OCF/净利0.30'], level: 'soft', msg: '软恶化' }, industry: '银行' });
  assert('soft→S2减半(30-50%)', r2.action === 'reduce' && r2.level === 'S2' && r2.strength === '0.3-0.5', r2.action + ' ' + r2.level);
  const r3 = ts({ code: '600036', dy: 5, tier: null, trendOk: true, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: { signals: ['OCF/净利0.30'], level: 'watch', msg: '观察' }, industry: '银行' });
  assert('watch→S1观察(0.15-0.2)', r3.action === 'watch' && r3.level === 'S1' && r3.strength === '0.15-0.2', r3.action + ' ' + r3.level);
}

/* 7. 冷却闸：距上次买入<60日 → 提示但不动 */
{
  const r = ts({ code: '600036', dy: 6.2, tier: 'p95', trendOk: true, finOk: true, finChecks: [], lastBuyDays: 30, industrySignals: indNull, industry: '银行', finGood: true });
  assert('冷却60日→持有', r.action === 'hold' && r.text.includes('冷却'), r.text);
}

/* 8. 持有：价格未达买入线 */
{
  const r = ts({ code: '600036', dy: 4.0, tier: null, trendOk: true, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: indNull, industry: '银行' });
  assert('未达档位→持有', r.action === 'hold' && r.text === '⚪ 持有', r.text);
}

/* 9. 估值高估扣分：P95+财报好+行业好+背书，但估值>70 → 4分=L4（非L5） */
{
  const r = ts({ code: '600036', dy: 6.2, tier: 'p95', trendOk: true, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: indNull, industry: '银行', finGood: true, valuation: { pct: 85 } });
  assert('估值高估(PB>70)→降一级L4', r.action === 'buy_L4', r.action + ' ' + r.reason);
}

/* 10. 宇通定制：趋势未确认 → 等待（trend 闸先于 gate 命中，原有行为） */
{
  const r = ts({ code: '600066', dy: 8.0, tier: 'p95', trendOk: false, finOk: true, finChecks: [], lastBuyDays: null, industrySignals: indNull, industry: '汽车制造', finGood: true });
  assert('宇通趋势未确认→等待(非买入)', r.action === 'hold' && r.text.includes('趋势未确认'), r.text);
}

console.log(`\n==== 等级制 e2e：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
