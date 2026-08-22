/* ============================================================
 * metrics.js — 统一口径层（v3.10+，接手 AI 2026-08-23）
 * 所有指标只从这一层取（签名带口径参数），UI 只消费输出。
 * 目标：消灭"股息率 4 种口径并存/覆盖率=支付率=分红率同数异名"
 * 原则：不改 data-layer.js 的计算函数，只做统一出口 + 口径标注。
 * 用法：window.METRICS.get('divYield', { divs, price, caliber:'report' })
 * ============================================================ */
(function (root) {
  'use strict';
  const DL = (root.DL) || (root.window && root.window.DL);
  function need(why) { throw new Error('metrics.js: ' + why); }

  const METRICS = {
    /* ---- 股息率：全站唯一主口径 = 报告期（最近已公告完整财年分红÷现价），其余口径显式指定 ---- */
    divYield(opts) {
      if (!DL) need('DL 未加载（data-layer.js 需先于 metrics.js）');
      const { divs, price, caliber } = opts || {};
      if (!divs || !(price > 0)) return null;
      if (caliber === 'annual2y' || caliber === '年化近2财年') {
        const ad = DL.calcAnnualDivYield(divs, price);
        return ad ? { value: ad.yieldPct, caliber: 'annual-2y', label: '年化近2财年', note: '近2财年已派息分红均值÷现价' } : null;
      }
      if (caliber === 'ttm' || caliber === 'TTM') {
        const t = DL.ttmDivsAt(divs, DL.todayStr());
        return t > 0 ? { value: t / price * 100, caliber: 'ttm', label: 'TTM', note: '滚动12个月分红÷现价（外部源口径）' } : null;
      }
      /* 默认 = 报告期主口径 */
      const t = DL.reportYearDivAt(divs, DL.todayStr());
      if (t <= 0) return null;
      return { value: t / price * 100, caliber: 'report-year', label: '报告期', note: '最近已公告完整财年分红÷现价（全站主口径）' };
    },

    /* ---- 分红占利润比例（统一名）：近2完整财年分红÷EPS。旧名：覆盖率/支付率/分红率 ---- */
    payoutRatio(opts) {
      if (!DL) need('DL 未加载');
      const { divs, asOfYear } = opts || {};
      const cov = DL.coverageAt(divs, asOfYear || parseInt(DL.todayStr().slice(0, 4), 10));
      if (cov == null) return null;
      return { value: cov * 100, caliber: 'payout-2y', label: '分红占利润', note: '近2个完整财年累计分红 ÷ 对应2年EPS（支付率口径，旧名覆盖率/分红率）' };
    },

    /* ---- 储备年数：每股未分配利润 ÷ 每股分红（主口径=报告期 dps） ---- */
    reserveYears(opts) {
      if (!DL) need('DL 未加载');
      const { divs, reserve, price } = opts || {};
      if (reserve == null || !(reserve > 0)) return null;
      let dpsMax = null;
      try {
        const r = DL.reportYearDivAt(divs, DL.todayStr());
        const ad = DL.calcAnnualDivYield(divs, price);
        dpsMax = Math.max(r > 0 ? r : 0, ad ? ad.annualDps : 0);
      } catch (e) { return null; }
      if (!(dpsMax > 0)) return null;
      return { value: reserve / dpsMax, caliber: 'reserve-max', label: '储备年数', note: '每股未分配 ÷ max(报告期dps, 年化dps)——取大值=储备偏低=保守' };
    },

    /* ---- 估值便宜度（分位）：滚动分位 0-100，越高=越便宜 ---- */
    cheapness(opts) {
      if (!DL) need('DL 未加载');
      const { kline, divs, windowDays } = opts || {};
      const series = DL.calcRollingPercentile(kline, divs, windowDays || DL.DEFAULT_WINDOW_DAYS);
      const last = series.filter(x => x.pct != null).pop();
      if (!last) return null;
      return { value: last.pct, caliber: 'rolling-pct', label: '便宜度', note: '股息率滚动分位（W' + (windowDays || DL.DEFAULT_WINDOW_DAYS) + '），越高=历史越便宜', dy: last.dy, d: last.d };
    },
  };

  /* 统一出口：get(name, opts) → 值对象或 null；口径审计：audit() 列出所有已调用指标 */
  const _log = [];
  function get(name, opts) {
    const fn = METRICS[name];
    if (!fn) need('未知指标: ' + name);
    const out = fn(opts);
    try { _log.push({ name, at: Date.now(), caliber: out ? out.caliber : null }); } catch (e) {}
    return out;
  }
  function audit() { return _log.slice(); }

  const api = Object.assign({ get, audit }, METRICS);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.METRICS = api;
})(typeof window !== 'undefined' ? window : global);
