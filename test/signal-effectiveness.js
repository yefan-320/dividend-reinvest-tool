#!/usr/bin/env node
/* 信号有效性研究（2026-08-18 主人令）：工具说"可买"时，对比真实历史股价真是机会吗？
 * 方法：40 只 × 16 年真实日K+分红（缓存）→ 逐日股息率（TTM财年归组+除息锁定，与工具同源）
 *      → 三档线触发事件（小仓/加仓/重仓）首日买入 → 1/2 年后收益（价格口径 + 分红口径）
 *      → vs 同股全时段随机买入基准（超额 = 信号带来的增益）
 * 口径：买入 1 股；1 年=250 交易日；分红 = 持有期内全部除息日 dps 之和
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
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
const NAME = { '600036': '招商银行', '601398': '工商银行', '601988': '中国银行', '601288': '农业银行', '601328': '交通银行', '600016': '民生银行', '000001': '平安银行', '601166': '兴业银行', '600519': '贵州茅台', '000858': '五粮液', '000895': '双汇发展', '600887': '伊利股份', '601318': '中国平安', '601628': '中国人寿', '601601': '中国太保', '600900': '长江电力', '600886': '国投电力', '600027': '华电国际', '600795': '国电电力', '601985': '中国核电', '600028': '中国石化', '601857': '中国石油', '601088': '中国神华', '600188': '兖矿能源', '601225': '陕西煤业', '000651': '格力电器', '000333': '美的集团', '600690': '海尔智家' };

function loadStock(code) {
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { code, kline, divs };
}

/* 触发事件：dy 序列连续达标区间的首日（与 findZoneEvents 同口径） */
function zoneEvents(series, line) {
  const evs = [];
  let inZ = false, start = null;
  for (const x of series) {
    if (x.dy == null) continue;
    if (x.dy >= line) { if (!inZ) { inZ = true; start = x.d; } }
    else { if (inZ) { evs.push(start); inZ = false; } }
  }
  if (inZ) evs.push(start);
  return evs;
}

/* 买入收益：buyIdx 日起持有 holdDays 交易日；价格+分红双口径 */
function buyReturn(kline, dates, divs, buyIdx, holdDays) {
  const sellIdx = buyIdx + holdDays;
  if (sellIdx >= dates.length) return null;
  const buyP = kline[dates[buyIdx]], sellP = kline[dates[sellIdx]];
  if (!(buyP > 0) || !(sellP > 0)) return null;
  const buyD = dates[buyIdx], sellD = dates[sellIdx];
  let divSum = 0;
  divs.forEach(d => { if (d.ex && d.dps > 0 && d.ex > buyD && d.ex <= sellD) divSum += d.dps; });
  return { priceRet: sellP / buyP - 1, divRet: divSum / buyP, totalRet: (sellP + divSum) / buyP - 1, divYield: divSum / buyP };
}

/* 基准：同股全时段随机买入的均值收益 */
function baseline(kline, dates, divs, holdDays, nSamples) {
  const maxIdx = dates.length - 1 - holdDays;
  if (maxIdx < 100) return null;
  const step = Math.max(1, Math.floor(maxIdx / nSamples));
  let sumP = 0, sumT = 0, sumD = 0, n = 0;
  for (let i = 0; i <= maxIdx; i += step) {
    const r = buyReturn(kline, dates, divs, i, holdDays);
    if (!r) continue;
    sumP += r.priceRet; sumT += r.totalRet; sumD += r.divRet; n++;
  }
  return { priceRet: sumP / n, totalRet: sumT / n, divRet: sumD / n, n };
}

(async () => {
  const results = [];   // {ind, code, name, tier, n, winP, avgP, avgT, avgD, baseP, baseT, baseD}
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
      const base1 = baseline(s.kline, dates, s.divs, 250, 800);
      const base2 = baseline(s.kline, dates, s.divs, 500, 800);
      const tiers = [['小仓', mid], ['加仓', line], ['重仓', heavy]];
      for (const [tierName, tLine] of tiers) {
        for (const [holdName, holdDays] of [['1年', 250], ['2年', 500]]) {
          const evs = zoneEvents(series, tLine);
          let win = 0, sumP = 0, sumT = 0, sumD = 0, n = 0;
          for (const d of evs) {
            const idx = dates.indexOf(d);
            if (idx < 0) continue;
            const r = buyReturn(s.kline, dates, s.divs, idx, holdDays);
            if (!r) continue;
            if (r.totalRet > 0) win++;
            sumP += r.priceRet; sumT += r.totalRet; sumD += r.divRet; n++;
          }
          if (n < 3) continue;
          results.push({
            ind, code, name: NAME[code] || code, tier: tierName, hold: holdName, n,
            winP: win / n * 100, avgP: sumP / n * 100, avgT: sumT / n * 100, avgD: sumD / n * 100,
            baseP: base1.priceRet * 100, baseT: base1.totalRet * 100, baseD: base1.divRet * 100,
            exP: (sumP / n - base1.priceRet) * 100, exT: (sumT / n - base1.totalRet) * 100,
          });
        }
      }
    }
  }
  // 汇总输出：按行业×档位×持有期聚合
  const agg = {};
  results.forEach(r => {
    const k = r.ind + '|' + r.tier + '|' + r.hold;
    if (!agg[k]) agg[k] = { ind: r.ind, tier: r.tier, hold: r.hold, n: 0, win: 0, sumP: 0, sumT: 0, sumD: 0, sumExP: 0, sumExT: 0, cnt: 0 };
    agg[k].n += r.n; agg[k].win += r.winP * r.n; agg[k].sumP += r.avgP * r.n; agg[k].sumT += r.avgT * r.n;
    agg[k].sumD += r.avgD * r.n; agg[k].sumExP += r.exP * r.n; agg[k].sumExT += r.exT * r.n; agg[k].cnt++;
  });
  console.log('行业 | 档位 | 持有 | 事件数 | 胜率% | 含分红收益% | 价格收益% | 分红收益% | 基准含分红% | 超额含分红pp');
  console.log('---');
  for (const k of Object.keys(agg).sort()) {
    const a = agg[k];
    console.log(`${a.ind} | ${a.tier} | ${a.hold} | ${a.n} | ${(a.win / a.n).toFixed(0)} | ${(a.sumT / a.n).toFixed(1)} | ${(a.sumP / a.n).toFixed(1)} | ${(a.sumD / a.n).toFixed(1)} | ${(a.sumT / a.n - a.sumExT / a.n).toFixed(1)} | ${(a.sumExT / a.n).toFixed(1)}`);
  }
  process.exit(0);
})();
