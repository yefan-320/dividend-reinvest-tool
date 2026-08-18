#!/usr/bin/env node
/* P0-4 陷阱过滤器·拦截精确率回放验收（2026-08-18，大师 Final Gate 上线门）
 * 对 40 只 × 16 年：三档线事件 → 用触发日之前的最新年报（净利同比=F10 annuals，支付率=divs 报告期归组）
 * → trapFilter（共现版默认）→ 对比事后 1 年收益 → 统计：
 *   ① hard 拦截精确率（被拦事件中事后 1 年亏损占比——越高=拦得越准）
 *   ② 周期误伤（energy/煤炭被 hard 拦但事后上涨占比——越低越好；高→建议切豁免版）
 *   ③ 全量事件被拦比例（不拦太少=过滤器没存在感，不拦太多=过度拦截）
 * 口径：与 signal-effectiveness.js 同源（375 窗口滚动分位、1年=250交易日、分红=持有期 dps 加总）
 * 运行：node test/trap-replay.js   （首次自动拉 40 只 F10 到 /tmp/f10-annuals.json，之后复用）
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');

const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));
const IND = {
  bank: ['600036', '601398', '601988', '601288', '601328', '600016', '000001', '601166'],
  consumer: ['600519', '000858', '000895', '600887', '000651', '000333', '600690'],
  insurer: ['601318', '601628', '601601'],
  utility: ['600900', '600886', '600027', '600795', '601985'],
  energy: ['600028', '601857', '601088', '600188', '601225'],
  telecom: ['600941'],
};
const F10_FILE = '/tmp/f10-annuals.json';
const SEC = { '600036': '.SH', '601398': '.SH', '601988': '.SH', '601288': '.SH', '601328': '.SH', '600016': '.SH', '000001': '.SZ', '601166': '.SH', '600519': '.SH', '000858': '.SZ', '000895': '.SZ', '600887': '.SH', '000651': '.SZ', '000333': '.SZ', '600690': '.SH', '601318': '.SH', '601628': '.SH', '601601': '.SH', '600900': '.SH', '600886': '.SH', '600027': '.SH', '600795': '.SH', '601985': '.SH', '600028': '.SH', '601857': '.SH', '601088': '.SH', '600188': '.SH', '601225': '.SH', '600941': '.SH' };

async function fetchAllF10() {
  if (fs.existsSync(F10_FILE)) return JSON.parse(fs.readFileSync(F10_FILE, 'utf8'));
  const out = {};
  for (const [ind, codes] of Object.entries(IND)) {
    for (const code of codes) {
      try {
        const f10 = await DL.fetchF10Annual(code + (SEC[code] || '.SH'));
        if (f10 && f10.annuals && f10.annuals.length) {
          out[code] = { annuals: f10.annuals.map(a => ({ reportDate: a.reportDate, netProfit: a.netProfit })) };
        }
        console.log(`F10 ${code} ✓ (${out[code] ? out[code].annuals.length : 0} 年报)`);
      } catch (e) { console.log(`F10 ${code} ✗ ${e.message}`); }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  fs.writeFileSync(F10_FILE, JSON.stringify(out), 'utf8');
  return out;
}

function loadStock(code) {
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { code, kline, divs };
}
function zoneEvents(series, line) {
  const evs = []; let inZ = false, start = null;
  for (const x of series) {
    if (x.dy == null) continue;
    if (x.dy >= line) { if (!inZ) { inZ = true; start = x.d; } }
    else { if (inZ) { evs.push(start); inZ = false; } }
  }
  if (inZ) evs.push(start);
  return evs;
}
function buyReturn(kline, dates, divs, buyIdx, holdDays) {
  const sellIdx = buyIdx + holdDays;
  if (sellIdx >= dates.length) return null;
  const buyP = kline[dates[buyIdx]], sellP = kline[dates[sellIdx]];
  if (!(buyP > 0) || !(sellP > 0)) return null;
  const buyD = dates[buyIdx], sellD = dates[sellIdx];
  let divSum = 0;
  divs.forEach(d => { if (d.ex && d.dps > 0 && d.ex > buyD && d.ex <= sellD) divSum += d.dps; });
  return { totalRet: (sellP + divSum) / buyP - 1 };
}
/* 触发日前最近年报净利同比（F10 annuals 降序，找 reportDate<=d 的第一条 vs 下一条更早） */
function yoyAt(annuals, d) {
  const idx = annuals.findIndex(a => a.reportDate <= d);
  if (idx < 0 || idx + 1 >= annuals.length) return null;
  const cur = annuals[idx].netProfit, prev = annuals[idx + 1].netProfit;
  if (cur == null || prev == null || prev === 0) return null;
  return (cur / prev - 1) * 100;
}
/* 触发日所属财年支付率：divs 中 report=最近<=d 的 12-31 财年 → Σdps/eps */
function payoutAt(divs, d) {
  const yrs = {};
  divs.forEach(x => {
    if (!x.report || !/12-31/.test(x.report)) return;
    if (x.report > d) return;
    if (!yrs[x.report]) yrs[x.report] = { dps: 0, eps: null };
    yrs[x.report].dps += (x.dps || 0);
    if (x.eps != null) yrs[x.report].eps = x.eps;
  });
  const keys = Object.keys(yrs).sort().reverse();
  if (!keys.length) return null;
  const y = yrs[keys[0]];
  return (y.eps != null && y.eps > 0) ? y.dps / y.eps : null;
}

/* 判据变体（参数化，P0-4 校准用）：
 * v1 共现版（当前默认）：同比<0 且 支付率>50% 且 高股息画像 → hard（全档）
 * v2 共现+阈值：同比<-10% 且 支付率>50% 且 高股息画像 → hard（全档）
 * v3 v2+仅重仓：同上但 hard 只作用于重仓档（加仓一律 soft）
 * v4 同比<-10% 且 高股息画像（去支付率条件）→ hard（全档）
 */
const MODE = process.argv[2] || 'v1';
function judgeTrap({ yoy, payout, dy, p90Line, tier }) {
  if (yoy == null) return null;
  const highYield = p90Line != null ? (dy != null && dy >= p90Line) : (dy != null && dy >= 5);
  if (MODE === 'v1') {
    if (yoy < 0 && highYield && payout != null && payout > 0.5) return 'hard';
    if (yoy < 0) return 'soft';
    return null;
  }
  if (MODE === 'v2') {
    if (yoy < -10 && highYield && payout != null && payout > 0.5) return 'hard';
    if (yoy < 0) return 'soft';
    return null;
  }
  if (MODE === 'v3') {
    if (tier === '重仓' && yoy < -10 && highYield && payout != null && payout > 0.5) return 'hard';
    if (yoy < 0) return 'soft';
    return null;
  }
  if (MODE === 'v4') {
    if (yoy < -10 && highYield) return 'hard';
    if (yoy < 0) return 'soft';
    return null;
  }
  return null;
}

(async () => {
  const f10s = await fetchAllF10();
  const all = [];   // {ind, code, tier, year, yoy, payout, dy, trap, ret}
  for (const [ind, codes] of Object.entries(IND)) {
    const yb = DL.BENCH[ind];
    if (!yb) continue;
    const mid = yb.yieldMid, line = yb.yieldMid + yb.yieldUp, heavy = line + 1;
    for (const code of codes) {
      const s = loadStock(code);
      if (!Object.keys(s.kline).length || !s.divs.length) continue;
      const dates = Object.keys(s.kline).sort();
      if (dates.length < 800) continue;
      const series = DL.calcRollingPercentile(s.kline, s.divs, 375);
      const annuals = (f10s[code] && f10s[code].annuals) || [];
      const tiers = [['小仓', mid], ['加仓', line], ['重仓', heavy]];
      for (const [tierName, tLine] of tiers) {
        for (const d of zoneEvents(series, tLine)) {
          const idx = dates.indexOf(d);
          if (idx < 0) continue;
          const r = buyReturn(s.kline, dates, s.divs, idx, 250);
          if (!r) continue;
          const yoy = yoyAt(annuals, d);
          const payout = payoutAt(s.divs, d);
          const dySer = series.find(x => x.d === d);
          const dy = dySer ? dySer.dy : null;
          const tr = { level: judgeTrap({ yoy, payout, dy, p90Line: line, tier: tierName }) };
          all.push({ ind, code, tier: tierName, year: parseInt(d.slice(0, 4), 10), yoy, payout, dy, trap: tr.level, ret: r.totalRet });
        }
      }
    }
  }

  /* 统计 */
  const hard = all.filter(x => x.trap === 'hard');
  const soft = all.filter(x => x.trap === 'soft');
  const none = all.filter(x => !x.trap);
  const hLoss = hard.filter(x => x.ret < 0);
  const hWin = hard.filter(x => x.ret >= 0);
  // 周期误伤：energy 中被 hard 拦但事后涨（误伤）
  const energyHard = hard.filter(x => x.ind === 'energy');
  const energyHardWin = energyHard.filter(x => x.ret >= 0);
  const coalCodes = ['601088', '601225', '600188'];
  const coalHard = hard.filter(x => coalCodes.includes(x.code));
  const coalHardWin = coalHard.filter(x => x.ret >= 0);

  console.log('\n===== P0-4 回放验收（' + MODE + '）=====');
  console.log(`总事件 ${all.length} | hard 拦截 ${hard.length}（${(hard.length / all.length * 100).toFixed(1)}%）| soft 观察 ${soft.length} | 未触发 ${none.length}`);
  console.log(`\n① hard 拦截精确率：被拦 ${hard.length} 事件中，事后 1 年亏损 ${hLoss.length}（${(hLoss.length / Math.max(1, hard.length) * 100).toFixed(0)}%）| 误拦(事后涨) ${hWin.length}`);
  console.log(`② 周期误伤：energy hard 拦 ${energyHard.length}，其中事后涨 ${energyHardWin.length}（误伤率 ${(energyHardWin.length / Math.max(1, energyHard.length) * 100).toFixed(0)}%）| 煤炭(601088/601225/600188) hard 拦 ${coalHard.length}，误伤 ${coalHardWin.length}`);
  console.log(`③ hard 拦截明细（code | 买入年 | 档位 | 净利同比 | 支付率 | 事后1年收益）:`);
  hard.sort((a, b) => a.year - b.year).slice(0, 40).forEach(x => console.log(`   ${x.code} | ${x.year} | ${x.tier} | ${x.yoy != null ? x.yoy.toFixed(1) + '%' : '—'} | ${x.payout != null ? (x.payout * 100).toFixed(0) + '%' : '—'} | ${(x.ret * 100).toFixed(1)}%`));
  console.log(`\nsoft 观察明细（前 15）:`);
  soft.slice(0, 15).forEach(x => console.log(`   ${x.code} | ${x.year} | ${x.tier} | 同比 ${x.yoy != null ? x.yoy.toFixed(1) + '%' : '—'} | ${(x.ret * 100).toFixed(1)}%`));
  // 判据结论
  const loseRate = hLoss.length / Math.max(1, hard.length);
  const hurtRate = energyHardWin.length / Math.max(1, energyHard.length);
  console.log(`\n===== 判据结论 =====`);
  console.log(`拦截精确率 ${(loseRate * 100).toFixed(0)}%（越高越好）；energy 误伤率 ${(hurtRate * 100).toFixed(0)}%（越低越好）`);
  if (loseRate >= 0.6 && hurtRate <= 0.3) console.log('✅ 共现版达标：拦截的大多事后真跌，周期误伤可控 → 维持共现版');
  else if (loseRate < 0.6) console.log(`⚠️ 拦截精确率不足（<60%）→ 判据偏松或阈值不对，需调参再验`);
  else console.log(`⚠️ 周期误伤过高（>30%）→ 建议切换豁免版（股息率<P90 或 经营现金流为正 不拦）`);
  process.exit(0);
})();
