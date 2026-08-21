/* v3.0 C1：Web Worker——组合回测并行计算（11 核 CPU 提速，纯本地） */
self.onmessage = e => {
  const { combo, pool, opts } = e.data;
  try {
    /* 在 Worker 内实现精简 simulateOne + calcComboBacktest（无 DOM 依赖） */
    function simOne(principal, monthly, closes, dividends, reinvest, taxRate) {
      const dates = Object.keys(closes).sort();
      if (!dates.length) return null;
      const buyPrice = closes[dates[0]];
      if (!(buyPrice > 0)) return null;
      let shares = Math.floor(principal / buyPrice / 100) * 100;
      let cashPool = principal - shares * buyPrice;
      let reinvested = 0, monthlyTotal = 0, lastMonth = null;
      const divByDate = {};
      (dividends || []).filter(x => x.ex && x.ex >= dates[0] && x.dps > 0).forEach(x => { (divByDate[x.ex] = divByDate[x.ex] || []).push(x); });
      const daily = []; let cumDiv = 0;
      for (let i = 0; i < dates.length; i++) {
        const d = dates[i], c = closes[d];
        const ev = divByDate[d];
        if (ev && ev.length) { let cash = 0; ev.forEach(x => cash += shares * x.dps * (1 - taxRate)); cumDiv += cash; cashPool += cash; if (reinvest && cash > 0) { const bs = Math.floor(cashPool / c / 100) * 100; if (bs >= 100) { cashPool -= bs * c; reinvested += bs * c; shares += bs; } } }
        if (monthly > 0) { const ym = d.slice(0, 7); if (ym !== lastMonth) { lastMonth = ym; if (ym !== dates[0].slice(0, 7)) { cashPool += monthly; monthlyTotal += monthly; const bs = Math.floor(cashPool / c / 100) * 100; if (bs >= 100) { cashPool -= bs * c; shares += bs; } } } }
        daily.push({ date: d, value: +(shares * c + cashPool).toFixed(2), invested: +(principal + monthlyTotal + reinvested).toFixed(2), cumDiv: +cumDiv.toFixed(2) });
      }
      return { daily, cumDiv };
    }
    const totalMonthly = (combo || []).reduce((s, x) => s + (x.monthly || 0), 0);
    const totalAmount = (combo || []).reduce((s, x) => s + (x.amount || 0), 0);
    const rows = [];
    for (const it of combo) {
      const p = pool[it.code];
      if (!p || !p.kline) continue;
      let monthly = it.monthly || 0;
      if (opts.monthlyMode === 'weight' && totalMonthly > 0 && totalAmount > 0) monthly = totalMonthly * (it.amount || 0) / totalAmount;
      if (opts.monthlyMode === 'smart' && p.series) { const last = p.series[p.series.length - 1]; const pct = last && last.pct != null ? last.pct : 50; monthly = (it.monthly || 0) * (pct < 30 ? 2 : pct > 70 ? 0.5 : 1); }
      const sim = simOne(it.amount || 0, monthly, p.kline, p.divs, opts.reinvest !== false, opts.taxRate || 0);
      if (sim) rows.push({ code: it.code, name: it.name || it.code, amount: it.amount || 0, monthly, sim });
    }
    if (!rows.length) { self.postMessage({ ok: false, error: 'no data' }); return; }
    const dateSet = {}; const allDates = [];
    rows.forEach(r => r.sim.daily.forEach(dd => { if (!dateSet[dd.date]) { dateSet[dd.date] = true; allDates.push(dd.date); } }));
    allDates.sort();
    const totalAsset = allDates.map(d => { let value = 0, invested = 0, cumDiv = 0; rows.forEach(r => { const dd = r.sim.daily.find(x => x.date === d); if (dd) { value += dd.value; invested += dd.invested; cumDiv += dd.cumDiv; } }); return { d, value: +value.toFixed(2), invested: +invested.toFixed(2), cumDiv: +cumDiv.toFixed(2) }; });
    const last = totalAsset[totalAsset.length - 1];
    const divByYear = {};
    rows.forEach(r => { const byYear = {}; r.sim.daily.forEach(dd => { byYear[dd.date.slice(0, 4)] = dd.cumDiv; }); const ys = Object.keys(byYear).sort(); let prev = 0; ys.forEach(y => { divByYear[y] = (divByYear[y] || 0) + (byYear[y] - prev); prev = byYear[y]; }); });
    const invested = rows.reduce((s, r) => s + (r.amount || 0), 0);
    const cumDivTotal = rows.reduce((s, r) => s + r.sim.cumDiv, 0);
    const divRatio = invested > 0 ? cumDivTotal / invested * 100 : 0;
    const ys = Object.keys(divByYear).sort();
    const yearDiv = ys.length ? divByYear[ys[ys.length - 1]] : 0;
    const perStock = rows.map(r => ({ code: r.code, name: r.name, amount: r.amount, monthly: +r.monthly.toFixed(2), finalValue: r.sim.daily[r.sim.daily.length - 1].value, invested: r.sim.daily[r.sim.daily.length - 1].invested, cumDiv: +r.sim.cumDiv.toFixed(2), ret: r.sim.daily[r.sim.daily.length - 1].value / Math.max(1, r.amount) - 1, divRatio: r.amount > 0 ? r.sim.cumDiv / r.amount * 100 : 0 }));
    const weightEvol = [];
    const yearsList = {}; totalAsset.forEach(t => { yearsList[t.d.slice(0, 4)] = true; });
    Object.keys(yearsList).sort().forEach(y => { const yearEnd = totalAsset.filter(t => t.d.slice(0, 4) === y).pop(); if (!yearEnd) return; const wt = {}; let sum = 0; rows.forEach(r => { const dd = r.sim.daily.find(x => x.date === yearEnd.d); const v = dd ? dd.value : 0; wt[r.code] = v; sum += v; }); Object.keys(wt).forEach(c => { wt[c] = sum > 0 ? wt[c] / sum * 100 : 0; }); weightEvol.push({ y, weights: wt }); });
    self.postMessage({ ok: true, res: { totalAsset, last, divRatio, cumDivTotal, yearDiv, perStock, weightEvol, divByYear, span: opts.years || 10, invested, rows: rows.length } });
  } catch (e) { self.postMessage({ ok: false, error: e.message }); }
};
