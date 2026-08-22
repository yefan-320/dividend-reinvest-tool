/* v3.5 C2：simOne 共享纯函数（防双份代码分叉——主线程 script + worker importScripts 双引用）
 * 提取自 backtest-worker.js simOne 与 data-layer.js simulateOne（两处原为双份，已统一）
 * 纯函数：无 DOM、无 self.postMessage、无外部状态
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.simOneCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  /* 单股回测核心：返回 { daily, cumDiv, monthlyFlow, buyDateReal, buyPrice, final }
   * daily[i] = { date, value, invested, cumDiv }（invested 含再投额，与历史口径一致）
   * 逐年收益口径（v3.5 AC-D1）：gain = Δvalue − added − reinvested（reinvest 不进收益） */
  function simOne(principal, monthly, closes, dividends, reinvest, taxRate) {
    const dates = Object.keys(closes).sort();
    if (!dates.length) return null;
    const buyDateReal = dates[0], buyPrice = closes[buyDateReal];
    if (!(buyPrice > 0)) return null;
    let shares = Math.floor(principal / buyPrice / 100) * 100;
    let cashPool = principal - shares * buyPrice;
    let reinvested = 0, monthlyTotal = 0, lastMonth = null;
    const divByDate = {};
    (dividends || []).filter(x => x.ex && x.ex >= buyDateReal && x.dps > 0).forEach(x => { (divByDate[x.ex] = divByDate[x.ex] || []).push(x); });
    const daily = []; let cumDiv = 0;
    const monthlyFlow = []; /* 月追加现金流（首月不追，与历史口径一致），供 XIRR */
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i], c = closes[d];
      const ev = divByDate[d];
      if (ev && ev.length) {
        let cash = 0; ev.forEach(x => cash += shares * x.dps * (1 - taxRate));
        cumDiv += cash; cashPool += cash;
        if (reinvest && cash > 0) {
          const bs = Math.floor(cashPool / c / 100) * 100;
          if (bs >= 100) { cashPool -= bs * c; reinvested += bs * c; shares += bs; }
        }
      }
      if (monthly > 0) {
        const ym = d.slice(0, 7);
        if (ym !== lastMonth) {
          lastMonth = ym;
          if (ym !== buyDateReal.slice(0, 7)) {
            cashPool += monthly; monthlyTotal += monthly;
            monthlyFlow.push({ date: d, amount: +monthly.toFixed(2) });
            const bs = Math.floor(cashPool / c / 100) * 100;
            if (bs >= 100) { cashPool -= bs * c; shares += bs; }
          }
        }
      }
      daily.push({ date: d, value: +(shares * c + cashPool).toFixed(2), invested: +(principal + monthlyTotal + reinvested).toFixed(2), cumDiv: +cumDiv.toFixed(2) });
    }
    const last = daily[daily.length - 1];
    return {
      daily,
      buyDateReal,
      buyPrice,
      principal,
      final: { finalValue: last.value, finalInvested: last.invested, cumDiv: last.cumDiv, totalDiv: cumDiv },
      cumDiv,
      monthlyFlow,
      /* v3.5 新增（供逐年收益口径，AC-D1/D2） */
      reinvested,
      monthlyTotal,
      extInvested: +(principal + monthlyTotal).toFixed(2),
    };
  }
  /* v3.5 AC-D1/D2：逐年明细（worker+主线程共享，防双份）
   * yearly[y] = { y, value, invested, extInvested, div, added, reinvested, gain }
   * gain = Δvalue − added − reinvested（reinvest 不进收益，首年起点 value_0=0） */
  function yearlyOf(sim) {
    const byYear = {};
    sim.daily.forEach(dd => { byYear[dd.date.slice(0, 4)] = dd; });
    const ys = Object.keys(byYear).sort();
    const flowByYear = {};
    (sim.monthlyFlow || []).forEach(m => { flowByYear[m.date.slice(0, 4)] = (flowByYear[m.date.slice(0, 4)] || 0) + m.amount; });
    const out = [];
    let prevValue = 0, prevInvested = sim.principal || 0, prevDiv = 0;
    ys.forEach(y => {
      const end = byYear[y];
      const added = flowByYear[y] || 0;
      const cumFlow = Object.keys(flowByYear).filter(ky => ky <= y).reduce((s, ky) => s + flowByYear[ky], 0);
      const value = end.value, invested = end.invested;
      const extInvested = +((sim.principal || 0) + cumFlow).toFixed(2);
      const reinvestedY = +((invested - prevInvested) - added).toFixed(2);
      const gain = +((value - prevValue) - added - reinvestedY).toFixed(2);
      const div = +(end.cumDiv - prevDiv).toFixed(2);
      out.push({ y, value, invested, extInvested, div, added: +added.toFixed(2), reinvested: reinvestedY, gain });
      prevValue = value; prevInvested = invested; prevDiv = end.cumDiv;
    });
    return out;
  }
  simOne.yearlyOf = yearlyOf;
  return simOne;
});
