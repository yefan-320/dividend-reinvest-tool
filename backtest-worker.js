/* v3.0 C1：Web Worker——组合回测并行计算（11 核 CPU 提速，纯本地） */
/* v3.5 C2：simOne 提取共享纯函数（sim-core.js，主线程/worker 双引用防分叉）
 * 版本戳：跟随 worker URL query（?v=APP_VERSION），防 sim-core.js 被浏览器缓存旧版 */
importScripts('sim-core.js' + ((typeof self !== 'undefined' && self.location && self.location.search) || ''));
self.onmessage = e => {
  const { combo, pool, opts } = e.data;
  try {
    const simOne = self.simOneCore;
    const totalMonthly = (combo || []).reduce((s, x) => s + (x.monthly || 0), 0);
    const totalAmount = (combo || []).reduce((s, x) => s + (x.amount || 0), 0);
    /* v1：现金仓位（与 data-layer 主线程版本同口径） */
    const cashPct = opts.cashPct || 0;
    const cashRate = opts.cashRate != null ? opts.cashRate : 1.5;
    const scale = cashPct > 0 ? (1 - cashPct / 100) : 1;
    const rows = [];
    for (const it of combo) {
      const p = pool[it.code];
      if (!p || !p.kline) continue;
      let monthly = it.monthly || 0;
      if (opts.monthlyMode === 'weight' && totalMonthly > 0 && totalAmount > 0) monthly = totalMonthly * (it.amount || 0) / totalAmount;
      /* v3.2 S8（主人铁律：输入不被改）：smart 自动乘月追加默认关（smartBoost 显式开启才乘），设多少用多少 */
      if (opts.monthlyMode === 'smart' && opts.smartBoost === true && p.series) { const last = p.series[p.series.length - 1]; const pct = last && last.pct != null ? last.pct : 50; monthly = (it.monthly || 0) * (pct < 30 ? 2 : pct > 70 ? 0.5 : 1); }
      const sim = simOne((it.amount || 0) * scale, monthly, p.kline, p.divs, opts.reinvest !== false, opts.taxRate || 0);
      if (sim) rows.push({ code: it.code, name: it.name || it.code, amount: (it.amount || 0) * scale, monthly, sim });
    }
    /* 现金行 */
    if (cashPct > 0 && totalAmount > 0 && rows.length) {
      const cash0 = totalAmount * cashPct / 100;
      const rate = cashRate / 100;
      const firstDate = rows.filter(r => r.sim).reduce((min, r) => { const f = r.sim.daily[0] && r.sim.daily[0].date; return f && (!min || f < min) ? f : min; }, null) || new Date().toISOString().slice(0, 10);
      const t0 = new Date(firstDate).getTime();
      rows.push({ code: '__CASH__', name: '现金仓位', amount: cash0, monthly: 0, sim: null, _cash: { cash0, rate, t0 } });
    }
    if (!rows.length) { self.postMessage({ ok: false, error: 'no data' }); return; }
    const dateSet = {}; const allDates = [];
    rows.forEach(r => r.sim ? r.sim.daily.forEach(dd => { if (!dateSet[dd.date]) { dateSet[dd.date] = true; allDates.push(dd.date); } }) : null);
    allDates.sort();
    const _cashRow = rows.find(r => r._cash);
    const totalAsset = allDates.map(d => { let value = 0, invested = 0, cumDiv = 0; rows.forEach(r => { if (r._cash) { const yrs = Math.max(0, (new Date(d).getTime() - r._cash.t0) / 86400000 / 365.25); value += r._cash.cash0 * Math.pow(1 + r._cash.rate, yrs); invested += r._cash.cash0; return; } const dd = r.sim.daily.find(x => x.date === d); if (dd) { value += dd.value; invested += dd.invested; cumDiv += dd.cumDiv; } }); return { d, value: +value.toFixed(2), invested: +invested.toFixed(2), cumDiv: +cumDiv.toFixed(2) }; });
    const last = totalAsset[totalAsset.length - 1];
    const divByYear = {};
    /* v3.2 S13（9/8 分母修复）：现金行（r.sim=null）不参与分红统计——r.sim.daily 遍历前跳过，防抛错 */
    rows.forEach(r => { if (!r.sim) return; const byYear = {}; r.sim.daily.forEach(dd => { byYear[dd.date.slice(0, 4)] = dd.cumDiv; }); const ys = Object.keys(byYear).sort(); let prev = 0; ys.forEach(y => { divByYear[y] = (divByYear[y] || 0) + (byYear[y] - prev); prev = byYear[y]; }); });
    const invested = rows.reduce((s, r) => s + (r.amount || 0), 0);
    const cumDivTotal = rows.reduce((s, r) => s + (r.sim ? r.sim.cumDiv : 0), 0);
    const divRatio = invested > 0 ? cumDivTotal / invested * 100 : 0;
    const ys = Object.keys(divByYear).sort();
    const yearDiv = ys.length ? divByYear[ys[ys.length - 1]] : 0;
    /* 逐年分红（每只股票，跨年 cumDiv 增量——与主线程 divByYear 同算法，供对账 e2e S14） */
    function yearlyDivsOf(dailyArr) {
      const byYear = {};
      dailyArr.forEach(dd => { byYear[dd.date.slice(0, 4)] = dd.cumDiv; });
      const ys = Object.keys(byYear).sort();
      const out = {}; let prev = 0;
      ys.forEach(y => { out[y] = +(byYear[y] - prev).toFixed(2); prev = byYear[y]; });
      return out;
    }
    /* 每只净值序列（每月末采样归一化——供 SVG 迷你图，≤120 点不占快照体积） */
    function navSeriesOf(dailyArr, amount) {
      const byMonth = {};
      dailyArr.forEach(dd => { byMonth[dd.date.slice(0, 7)] = dd; });
      const mKeys = Object.keys(byMonth).sort();
      return mKeys.map(m => +(byMonth[m].value / Math.max(1, amount)).toFixed(3));
    }
    /* v3.5 AC-D1/D2：逐年明细——用 sim-core.js 共享 yearlyOf（防双份） */
    const perStock = rows.filter(r => !r._cash).map(r => ({ code: r.code, name: r.name, amount: r.amount, monthly: +r.monthly.toFixed(2), finalValue: r.sim.daily[r.sim.daily.length - 1].value, invested: r.sim.daily[r.sim.daily.length - 1].invested, extInvested: r.sim.extInvested, cumDiv: +r.sim.cumDiv.toFixed(2), ret: r.sim.daily[r.sim.daily.length - 1].value / Math.max(1, r.amount) - 1, divRatio: r.amount > 0 ? r.sim.cumDiv / r.amount * 100 : 0, yearlyDivs: yearlyDivsOf(r.sim.daily), monthlyFlow: r.sim.monthlyFlow, navSeries: navSeriesOf(r.sim.daily, r.amount), yearly: simOne.yearlyOf(r.sim) }));
    const weightEvol = [];
    const yearsList = {}; totalAsset.forEach(t => { yearsList[t.d.slice(0, 4)] = true; });
    Object.keys(yearsList).sort().forEach(y => { const yearEnd = totalAsset.filter(t => t.d.slice(0, 4) === y).pop(); if (!yearEnd) return; const wt = {}; let sum = 0; rows.forEach(r => { const dd = r._cash ? null : (r.sim.daily.find(x => x.date === yearEnd.d)); const v = dd ? dd.value : 0; wt[r.code] = v; sum += v; }); Object.keys(wt).forEach(c => { wt[c] = sum > 0 ? wt[c] / sum * 100 : 0; }); weightEvol.push({ y, weights: wt }); });
    self.postMessage({ ok: true, res: { totalAsset, last, divRatio, cumDivTotal, yearDiv, perStock, weightEvol, divByYear, span: opts.years || 10, invested, rows: rows.length } });
  } catch (e) { self.postMessage({ ok: false, error: e.message }); }
};
