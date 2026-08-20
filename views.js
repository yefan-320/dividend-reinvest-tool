/* v1.9.3：分位窗口全局（默认 375，可预设切换 250/375/500）——R6-R9 窗口讨论落地 */
window.G_WINDOW = window.G_WINDOW || (window.DL ? window.DL.DEFAULT_WINDOW_DAYS : 375);
window.setDivWindowDays = function (d) { if (window.DL && window.DL.WINDOW_PRESETS.indexOf(d) >= 0) { window.G_WINDOW = d; try { localStorage.setItem('divtool_window_days', String(d)); } catch (e) {} return true; } return false; };
try { var _savedWin = parseInt(localStorage.getItem('divtool_window_days') || '', 10); if (window.DL && window.DL.WINDOW_PRESETS.indexOf(_savedWin) >= 0) window.G_WINDOW = _savedWin; } catch (e) {}

/* ============================================================
 * views.js — 红利工具视图层 v1.7.0
 * 四 tab 导航：决策台 / 诊断 / 对比 / 回测（回测逻辑在 index.html 内，不动）
 * 决策台：搜索 + 机会速览 + 自选卡片 + 除息日历 + 扫描入口
 * 诊断页：股息率带状图 + 关键数据(股息覆盖率/估值/回撤) + 分红节奏
 * 对比页：第二批占位
 * 数据全部走 window.DL（data-layer.js）
 * ============================================================ */
'use strict';

/* ---------- 公共：图例高度自适应（v1.8.4 大师 M2/M4：全站唯一实现）---------- */
/* 流程：rAF→容器可见守卫→resize→设 legend 数字宽度(触发横排)→嵌套 rAF→读 legend 实际高度→grid.top=h+8 */
window.fitLegendTop = function fitLegendTop(chart, el, gridTop) {
  const measure = () => {
    try {
      const views = chart._componentsViews || [];
      const lgView = views.find(v => v.type && v.type.indexOf('legend') === 0);
      // zrender Group 用 getBoundingRect()（getBoundingClientRect 是 DOM 方法，Group 没有→曾致修复无效被 catch 吞掉）
      const h = lgView && lgView.group ? lgView.group.getBoundingRect().height : 0;
      if (h > 0) chart.setOption({ grid: { top: h + 8 } });
      else if (gridTop) chart.setOption({ grid: { top: gridTop } });   // 兜底：读不到时用预设值
    } catch (e) { if (gridTop) { try { chart.setOption({ grid: { top: gridTop } }); } catch (e2) {} } }
  };
  let done = false;
  const finish = (fn) => { if (done) return; done = true; try { chart.off('finished', fn); } catch (e) {} };
  const onFinished = () => { finish(onFinished); measure(); };
  // 先注册 finished：容器隐藏/0 宽时不能 return 掉注册（曾致永远不测量→图例压轴）
  chart.on('finished', onFinished);
  const tryMeasure = () => {
    if (!el || el.clientWidth <= 0) return false;   // 容器不可见→返回 false，由重试机制等可见
    try {
      chart.resize();
      const w = el.clientWidth - 20;
      chart.setOption({ legend: { width: Math.max(280, w) } });   // 触发新渲染→finished→onFinished→measure
      return true;
    } catch (e) { return false; }
  };
  requestAnimationFrame(() => {
    if (tryMeasure()) return;
    // 容器隐藏/0 宽：轮询等可见后再测（不中断注册）
    const iv = setInterval(() => { if (tryMeasure()) clearInterval(iv); }, 200);
    setTimeout(() => clearInterval(iv), 4000);
  });
  // 超时兜底：finished 没触发也直接测一次
  setTimeout(() => { finish(onFinished); measure(); }, 1200);
};

(function () {
  const DL = window.DL;
  const $ = DL.$;
  const fmt = DL.fmt, fmtPct = DL.fmtPct;

  /* ---------- tab 导航 ---------- */
  const TABS = ['home', 'diagnose', 'compare', 'backtest', 'pfbt'];   // v1.9.2 加组合回测 tab
  let curTab = 'home';
  function switchTab(name) {
    curTab = name;
    TABS.forEach(t => {
      const panel = document.getElementById('tab-' + t);
      if (panel) panel.style.display = (t === name) ? 'block' : 'none';
    });
    document.querySelectorAll('.tabbar button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    if (name === 'home') renderHome();
    /* O4（2026-08-18）：切到对比 tab 时若列表为空且有自选 → 预填（renderCompare 只在首载跑一次，切 tab 需补；try 包裹防 TDZ） */
    if (name === 'compare') {
      try {
        if (cmpState && !cmpState.list.length) {
          const wl = DL.Watchlist.list();
          if (wl.length) { cmpState.list = wl.slice(0, 5).map(x => ({ code: x.code, name: x.name || x.code })); cmpRenderList(); }
        }
      } catch (e) { }
    }
  }
  function bindTabs() {
    document.querySelectorAll('.tabbar button').forEach(b => {
      b.onclick = () => switchTab(b.dataset.tab);
    });
  }

  /* ---------- 决策台 ---------- */
  let homeState = { watchlist: [], snap: null, divs: null, dividendMap: null };

  async function renderHome() {
    const wl = await DL.Watchlist.list();
    homeState.watchlist = wl;
    renderOpportunities();
    renderWatchlist();
    renderDivCalendar();
    // v1.9.1 P2：组合建仓总览（默认折叠）
    renderPortfolio(wl);
    // v1.9.0：三级到价提醒（自选股分位扫描 → 横幅 + 桌面通知尽力而为）
    renderZoneBanner(wl);
    // 数据新鲜度徽标（大师补：信任）
    const snapHit = await DL.cacheGet('snap:all');
    const fresh = $('#wlFresh');
    if (fresh) {
      if (snapHit) {
        const mins = Math.max(0, Math.round((Date.now() - snapHit.ts) / 60000));
        fresh.textContent = '行情更新于 ' + mins + ' 分钟前';
      } else { fresh.textContent = '行情待更新'; }
    }
  }

  /* v1.9.0：三级到价提醒（80建仓/85加仓/90加满/95+极值）
   * 推送降频：75-80 预告不推（仅页面展示）；80-85 每日汇总；85+ 实时横幅；95+ 高亮+桌面通知 */
  async function renderZoneBanner(wl) {
    const el = $('#zoneBanner');
    if (!el) return;
    if (!wl || !wl.length) { el.innerHTML = ''; return; }
    // v1.9.1：模式全局单例（与建仓卡同一状态）
    let mode = localStorage.getItem('divtool_zone_mode') || 'conservative';
    if (mode !== 'flexible' && mode !== 'conservative') mode = 'conservative';
    const today = DL.todayStr();
    const codes = wl.slice(0, 12);
    const rows = [];
    for (const c of codes) {
      try {
        const kline = await DL.getKline(c.code, '2023-01-01', today);
        const divs = await DL.fetchDividendsOne(c.code);
        if (!kline || !divs || !divs.length) continue;
        const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
        const last = series.filter(x => x.pct != null).pop();
        if (!last) continue;
        // 生态起建线偏移
        const eco = DL.calcEcoType(kline, series);
        const z = DL.computeZone(last.pct, { mode, ecoStart: eco.ecoStart });
        const tcls = DL.classifyTier(c.code);
        // O5（M39 Q2）：三档收益维度——F10 拉行业（7 天缓存）+ 引擎三档
        let tiersTxt = '';
        try {
          const sec = DL.guessSec(c.code);
          const f10 = await DL.fetchF10Annual(sec && sec.secuCode ? sec.secuCode : c.code);
          const ind = f10 ? DL.industryOf(f10.csrcIndustry || f10.orgType) : null;
          if (ind) {
            const dps = DL.ttmDivsAt(divs, today);
            const v = DL.verdictEngine({ coverage: DL.coverageAt(divs, parseInt(today.slice(0, 4), 10)), reserveYears: null, payoutRate: null, dps, dy: last.dy, pct: last.pct, industry: ind, code: c.code, netProfitYoY: f10.netProfitYoY });
            if (v.tiers && v.tiers.length) tiersTxt = v.tiers.slice(0, 1).map(t => t.text).join('') + (v.tiers.length > 1 ? ' | ' + v.tiers.slice(1, 3).map(t => t.type + '=' + t.rate.toFixed(1) + '% <span style="font-size:9px;opacity:.7">' + t.price + ' 元</span>' + (t.hit ? ' ✅' : '')).join(' | ') : '');
          }
        } catch (e) { /* 三档失败不阻塞横幅 */ }
        rows.push({ code: c.code, name: c.name || c.code, pct: last.pct, zone: z.zone, label: z.label, ecoStart: eco.ecoStart, ecoType: eco.type, tcls, tiersTxt });
      } catch (e) { /* 单只失败跳过 */ }
    }
    // 横幅三组（v1.9.1 P4）：① 待触发（距起建线≤5，展示不推）② 动作（已触发）③ 极值 95+
    const watch = rows.filter(r => r.zone === 'watch');
    const act = rows.filter(r => r.zone === 'start' || r.zone === 'add' || r.zone === 'full');
    const extreme = rows.filter(r => r.zone === 'extreme');
    let html = '';
    if (extreme.length) {
      html += `<div style="background:rgba(224,90,90,.16);border:1px solid rgba(224,90,90,.5);border-radius:10px;padding:10px 14px;margin-bottom:10px">🔴 <b>极值区</b>：${extreme.map(r => `<b>${r.name}</b>(${r.code}) ${r.pct.toFixed(0)}%分位`).join(' · ')}</div>`;
    }
    if (act.length) {
      html += `<div style="background:rgba(224,90,90,.12);border:1px solid rgba(224,90,90,.4);border-radius:10px;padding:10px 14px;margin-bottom:10px">🔔 <b>建仓区提醒</b>：${act.map(r => `<b>${r.name}</b>(${r.code}) ${r.pct.toFixed(0)}%分位 [${r.label}]${r.tcls && r.tcls.cls === 'trap' ? ' <span style="color:#e05a5a">⚠️分红陷阱</span>' : r.tcls && r.tcls.cls === 'dull' ? ' <span style="color:#d9a45b">钝化</span>' : ''}${r.tiersTxt ? '<div style="font-size:10px;color:var(--sub);margin-top:2px">' + r.tiersTxt + '</div>' : ''}`).join(' · ')}</div>`;
      // D6：自动记录信号触发（同 code 同档位同日去重）
      try {
        const today = DL.todayStr();
        const last = decLog().filter(x => x.decision === 'auto');
        act.forEach(r => {
          const dup = last.some(x => x.code === r.code && x.tier === r.label && x.date === today);
          if (!dup) decAdd({ code: r.code, name: r.name, tier: r.label, pct: r.pct, dy: null, note: 'auto', trap: null, decision: 'auto' });
        });
      } catch (e) {}
    }
    if (watch.length) {
      html += `<div style="background:rgba(217,164,65,.10);border:1px solid rgba(217,164,65,.35);border-radius:10px;padding:10px 14px;margin-bottom:10px">👀 <b>待触发预告</b>：${watch.map(r => `${r.name}(${r.code}) ${r.pct.toFixed(0)}% · 距${r.ecoStart}起建线差 ${(r.ecoStart - r.pct).toFixed(0)}`).join(' · ')}</div>`;
    }
    el.innerHTML = html;
    // 桌面通知（尽力而为，仅动作+极值；iOS Safari/无权限静默）
    if ((act.length || extreme.length) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification('🔔 红利建仓提醒', { body: [...act, ...extreme].map(r => r.name + ' ' + r.pct.toFixed(0) + '%分位 [' + r.label + ']').join('，') }); } catch (e) {}
    }
    if (act.length && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) {}
    }
  }

  /* v1.9.1 P2：组合建仓总览卡（默认折叠零请求，展开懒加载 + 缓存 30min）
   * 内容：每只标的进度条（已建/上限）+ 生态 + 二维排序 + 质量警示 + 资金分配模拟（截断不缩放）+ 轻量组合参考 */
  let _pfLoaded = false, _pfCache = null, _pfLoading = false;   // v1.9.2 O2：展开加载锁（防重复点击并发）
  async function renderPortfolio(wl) {
    const card = $('#portfolioCard');
    const body = $('#portfolioBody');
    if (!card || !body) return;
    if (!wl || !wl.length) {
      $('#pfSummary').textContent = '空自选';
      body.style.display = 'none';
      body.innerHTML = '<div class="hint">还没有自选。搜索代码 → 点➕ 加自选，或点下方 🔍 扫描新机会 发现高股息标的——这里会显示每只的建仓进度和资金分配建议。</div>';
      return;
    }
    // 折叠态：零请求，显示汇总（用上次展开的缓存或占位）
    const mode = (localStorage.getItem('divtool_zone_mode') || 'conservative');
    let summary = '…';
    try { const prev = JSON.parse(localStorage.getItem('divtool_pf_summary') || 'null'); if (prev) summary = prev.txt; } catch (e) {}
    if (_pfCache) summary = `组合总仓位 ${_pfCache.totalPos}% · ${_pfCache.triggeredCount}/${_pfCache.items.length} 已触发`;
    const ps = $('#pfSummary');
    if (ps) ps.textContent = summary;
    card.onclick = async () => {
      if (body.style.display !== 'none') { body.style.display = 'none'; return; }
      if (_pfLoading) return;   // v1.9.2 O2：加载锁
      body.style.display = 'block';
      // 缓存 30min：展开不重拉
      if (_pfCache && Date.now() - _pfCache.ts < 30 * 60000) { renderPfBody(_pfCache); return; }
      _pfLoading = true;
      body.innerHTML = '<div class="hint">展开加载中…</div>';
      const items = [];
      for (const c of wl.slice(0, 20)) {
        try {
          const kline = await DL.getKline(c.code, '2021-01-01', DL.todayStr());
          const divs = await DL.fetchDividendsOne(c.code);
          if (!kline || !divs || !divs.length) continue;
          const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
          const last = series.filter(x => x.pct != null).pop();
          if (!last) continue;
          const eco = DL.calcEcoType(kline, series);
          // v1.9.3 R16：起建线按类型差异化（边界型可切 85）
          const _tcls = DL.classifyTier(c.code);
          let _ecoStart = eco.ecoStart;
          if (_tcls.cls === 'neutral') { try { if (localStorage.getItem('divtool_neutral85') === '1') _ecoStart = 85; } catch (e) {} }
          const z = DL.computeZone(last.pct, { mode, ecoStart: _ecoStart });
          // 只进不退记忆
          const posKey = 'divtool_pos_' + c.code + '_' + mode;
          let histPos = parseFloat(localStorage.getItem(posKey) || '0') || 0;
          if (z.currentTier && z.currentTier.pos > histPos) { histPos = z.currentTier.pos; try { localStorage.setItem(posKey, String(histPos)); } catch (e) {} }
          const cagr = DL.calcDivCAGR(divs, 3);
          const trend = DL.calcDivTrend(divs);
          const tcls = DL.classifyTier(c.code);
          const warn = cagr != null && cagr <= 0;
          // P0-5 陷阱预警（2026-08-18）：F10 净利同比 + 支付率 → trapFilter（TIL 7 天缓存，失败静默）
          let trap = null;
          try {
            const sec = DL.guessSec(c.code);
            const f10 = await DL.fetchF10Annual(sec && sec.secuCode ? sec.secuCode : c.code);
            if (f10) {
              const ind = DL.industryOf(f10.csrcIndustry || f10.orgType);
              const yb = DL.BENCH[ind];
              const p90 = yb ? yb.yieldMid + yb.yieldUp : null;
              const payout = DL.coverageAt(divs, parseInt(DL.todayStr().slice(0, 4), 10));
              const payoutHigh = payout != null && payout > 0.9;   // v1.9.17：支付率>90%→扣非重算（防理财虚增误判，宇通案例）
              trap = DL.trapFilter({ netProfitYoY: f10.netProfitYoY, deductYoY: f10.deductYoY, payout, payoutHigh, dy: last.dy, p90Line: p90 });
            }
          } catch (e) { /* F10 失败静默 */ }
          items.push({ code: c.code, name: c.name || c.code, pct: last.pct, zone: z.zone, label: z.label, ecoType: eco.type, ecoStart: _ecoStart, pos: histPos, target: z.currentTier ? z.currentTier.pos : 0, cagr, warn, trend, tcls, series, kline, trap });
        } catch (e) { /* 单只失败跳过 */ }
      }
      const totalPos = items.reduce((s, it) => s + it.pos, 0);
      const triggered = items.filter(it => it.pos > 0).length;
      _pfCache = { ts: Date.now(), items, totalPos, triggeredCount: triggered, mode };
      try { localStorage.setItem('divtool_pf_summary', JSON.stringify({ ts: Date.now(), txt: `组合总仓位 ${totalPos}% · ${triggered}/${items.length} 已触发` })); } catch (e) {}
      _pfLoading = false;
      renderPfBody(_pfCache);
    };
  }

  /* 组合总览卡主体渲染（进度条 + 排序 + 资金模拟 + 轻量参考） */
  function renderPfBody(cache) {
    const body = $('#portfolioBody');
    if (!body) return;
    const { items, totalPos, triggeredCount, mode } = cache;
    // 二维排序：触发档深度（90+ > 80 > 70 > 未触发）+ 生态内分位高者先
    const tierRank = { extreme: 4, full: 3, add: 2, start: 1, watch: 0.5, wait: 0 };
    const sorted = items.slice().sort((a, b) => {
      const ra = tierRank[a.zone] || 0, rb = tierRank[b.zone] || 0;
      if (ra !== rb) return rb - ra;
      return b.pct - a.pct;
    });
    // 质量警示列（不混入排序）
    const ecoName = { low: '低波', mid: '中波', high: '高波', declining: '阴跌' };
    let rows = '';
    sorted.forEach(it => {
      const bar = Math.min(100, it.pos);
      const color = it.zone === 'extreme' ? '#e05a5a' : (it.zone === 'full' ? '#4caf7d' : (it.zone === 'add' ? '#5aa9e6' : (it.zone === 'start' ? '#d9a441' : '#8fa69c')));
      rows += `<div style="padding:6px 0;border-bottom:1px solid var(--line)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span><b>${it.name}</b>(${it.code}) ${(DL.TRADE_LAYER[it.code] || '') === 'event' ? '<span style="font-size:9px;color:#d9a45b;border:1px solid #d9a45b;border-radius:4px;padding:0 3px">🔎事件层</span>' : '<span style="font-size:9px;color:#5aa9e6;border:1px solid #5aa9e6;border-radius:4px;padding:0 3px">⚡自动层</span>'} <span style="font-size:10px;color:var(--muted)">${ecoName[it.ecoType] || '中波'}·起${it.ecoStart}</span></span>
          <span style="font-size:11px">${it.pct.toFixed(0)}%分位 <span style="color:${color}">${it.label}</span>${it.tcls && it.tcls.cls !== 'direct' ? ` <span style="color:${it.tcls.color}" title="${it.tcls.detail}">${it.tcls.label}</span>` : ''}${it.warn && (!it.tcls || it.tcls.cls !== 'trap') ? ' <span style="color:#e05a5a">⚠️分红缩水</span>' : ''}${it.trap && it.trap.level ? ` <span style="color:${it.trap.level === 'hard' ? '#e05a5a' : '#d9a45b'};font-weight:700" title="${it.trap.msg}">${it.trap.level === 'hard' ? '🚫陷阱确认' : '⚠️净利下滑'}</span>` : ''}</span>
        </div>
        <div style="height:6px;background:var(--card2);border-radius:3px;margin-top:3px;position:relative">
          <div style="position:absolute;left:0;top:0;bottom:0;width:${bar}%;background:${color};border-radius:3px"></div>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">已建 ${it.pos}% / 上限 ${it.target || (it.zone === 'extreme' ? '80' : it.zone === 'full' ? '60' : it.zone === 'add' ? '40' : it.zone === 'start' ? '20' : '—')}%${it.zone === 'wait' || it.zone === 'watch' ? ' · 未触发' : ''}</div>
      </div>`;
    });
    // 资金分配模拟（截断不缩放：90+ > 80 > 70 > 未触发，现金 ≥20%）
    const fundInput = `<div style="display:flex;gap:6px;align-items:center;margin:8px 0">总资金 <input id="pfFund" type="number" value="1000000" style="width:110px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt)"> 元 → <button type="button" class="chip" id="pfCalc">💡 分配建议</button></div>`;
    // v1.9.3 持仓巡检汇总：健康/观察/警示
    const nTrap = items.filter(it => it.tcls && it.tcls.cls === 'trap').length;
    const nDull = items.filter(it => it.tcls && it.tcls.cls === 'dull').length;
    const nWarn = items.filter(it => it.warn && (!it.tcls || (it.tcls.cls !== 'trap' && it.tcls.cls !== 'dull'))).length;
    // P0-5：净利趋势预警（F10）计数
    const nF10Trap = items.filter(it => it.trap && it.trap.level === 'hard').length;
    const nF10Watch = items.filter(it => it.trap && it.trap.level === 'soft').length;
    const patrolHtml = `<div style="font-size:11px;color:var(--muted);margin-bottom:6px;padding:5px 8px;background:var(--card2);border-radius:8px">🔍 持仓巡检：<b class="green">${items.length - nTrap - nDull - nWarn} 健康</b> · ${nDull ? `<b style="color:#d9a45b">${nDull} 观察（低估值钝化）</b> · ` : ''}${nTrap ? `<b class="red">${nTrap} 警示（分红陷阱）</b> · ` : ''}${nWarn ? `<b class="red">${nWarn} 分红缩水</b> · ` : ''}${nF10Trap ? `<b class="red">${nF10Trap} 陷阱确认（净利+覆盖）</b> · ` : ''}${nF10Watch ? `<b style="color:#d9a45b">${nF10Watch} 净利下滑观察</b>` : ''}</div>`;
    body.innerHTML = `${patrolHtml}<div style="font-size:11px;color:var(--muted);margin-bottom:6px">组合总仓位 <b>${totalPos}%</b> · 已触发 ${triggeredCount}/${items.length} · 模式：${mode === 'flexible' ? '柔性' : '保守'}（模式在建仓卡切换）</div>${rows}<div id="pfFundWrap">${fundInput}<div id="pfFundResult"></div></div><div id="pfRef" style="margin-top:6px"></div>`;
    // 资金模拟绑定
    const calcBtn = $('#pfCalc');
    if (calcBtn) calcBtn.onclick = () => {
      const F = parseFloat(($('#pfFund') || {}).value) || 0;
      const result = $('#pfFundResult');
      if (!F || !result) return;
      // 截断：按排序买，现金 ≥20%
      const cashLimit = F * 0.8;
      let used = 0;
      const lines = [];
      for (const it of sorted) {
        if (used >= cashLimit) { lines.push(`<div style="font-size:11px;color:var(--muted)">${it.name}：已触发但资金不足，待释放</div>`); continue; }
        const target = it.target || (it.zone === 'extreme' ? 80 : 0);
        if (!target) { continue; }
        const amt = Math.min(F * target / 100, cashLimit - used);
        used += amt;
        lines.push(`<div style="font-size:11px">${it.name}：建议 <b>${(amt / 10000).toFixed(1)} 万</b>（档位 ${target}%${amt < F * target / 100 ? '，现金受限截断' : ''}）</div>`);
      }
      result.innerHTML = lines.join('') + `<div style="font-size:11px;margin-top:4px;color:var(--muted)">合计建议 ${(used / 10000).toFixed(1)} 万 / 预算上限 ${(cashLimit / 10000).toFixed(1)} 万（现金下限 20%：至少留 ${((F - cashLimit) / 10000).toFixed(1)} 万）</div>`;
    };
    // 轻量组合参考：每只当前触发档 → 独立事件均值 → 按当前资金权重加权
    (async () => {
      const ref = $('#pfRef');
      if (!ref) return;
      let totRet = 0, totMdd = 0, nEvt = 0, wSum = 0;
      for (const it of sorted) {
        const tier = it.target || (it.zone === 'extreme' ? 80 : 0);
        if (!tier || !it.series || !it.kline) continue;
        const tierPct = it.ecoStart + (mode === 'flexible' ? ((tier / 20 - 1) * 10) : ((tier / 33.33 - 1) * 5));
        const events = DL.findZoneEvents(it.series, tierPct);
        const dates = Object.keys(it.kline).sort();
        let evRet = 0, evMdd = 0, cnt = 0;
        for (const ev of events) {
          const idx = dates.indexOf(ev.start);
          if (idx < 0 || idx >= dates.length - 250) continue;   // 至少 1 年数据
          const buyP = it.kline[dates[idx]];
          const endP = it.kline[dates[dates.length - 1]];
          let peak = -Infinity, mdd = 0;
          for (let j = idx; j < dates.length; j++) { const p = it.kline[dates[j]]; if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > mdd) mdd = dd; }
          evRet += (endP / buyP - 1) * 100;
          evMdd += mdd * 100;
          cnt++;
        }
        if (cnt) {
          const w = it.pos || 0.1;   // 权重：已建仓位（未建仓给小权重）
          totRet += (evRet / cnt) * w;
          totMdd += (evMdd / cnt) * w;
          nEvt += cnt;
          wSum += w;
        }
      }
      if (wSum > 0 && nEvt > 0) {
        ref.innerHTML = `<div class="hint">组合历史同类买点（按当前持仓权重）：平均收益 <b class="${totRet / wSum >= 0 ? 'green' : 'red'}">${(totRet / wSum).toFixed(1)}%</b> / 最大浮亏 <b class="red">-${(totMdd / wSum).toFixed(1)}%</b>（${nEvt} 次独立事件，仅参考非预测）</div>`;
      }
    })();
  }

  /* 行业提示（P2 机会雷达用）：四级查找，零阻塞（大师 P1 限频纪律）
   * ① snap:all 缓存（扫描器建立过）② sessionStorage 缓存 ③ 名称规则兜底（零网络，覆盖常见高股息股）④ push2 f127（不稳定，失败静默） */
  const NAME_IND_RULES = [
    [/银行/, 'bank'], [/保险/, 'insurer'], [/移动|联通|电信/, 'telecom'],
    [/电力|华能|大唐|国电/, 'utility'], [/煤炭|石油|石化|神华|能源/, 'energy'],
    [/伊利|蒙牛|美的|格力|海尔|茅台|五粮液|海天|农夫|双汇|海天/, 'consumer'],
  ];
  function industryByName(name) {
    for (const [re, ind] of NAME_IND_RULES) if (re.test(name || '')) return ind;
    return null;
  }
  /* O2（2026-08-18）：同步行业读取（日历/卡片用，零网络）——sessionStorage 缓存 → 名称规则 */
  function industryForSync(code, name) {
    try {
      const sess = JSON.parse(sessionStorage.getItem('ind_hint') || '{}');
      if (sess[code]) return DL.industryOf(sess[code]);
    } catch (e) { }
    return industryByName(name);
  }
  async function industryHint(code) {
    const name = ((homeState.watchlist || []).find(x => x.code === code) || {}).name || '';
    try {
      const snapAll = await DL.cacheGet('snap:all');
      if (snapAll && snapAll[code] && snapAll[code].industry) return DL.industryOf(snapAll[code].industry);
    } catch (e) { }
    try {
      const sess = JSON.parse(sessionStorage.getItem('ind_hint') || '{}');
      if (sess[code]) return DL.industryOf(sess[code]);
    } catch (e) { }
    const byName = industryByName(name);
    if (byName) {
      try { const sess = JSON.parse(sessionStorage.getItem('ind_hint') || '{}'); sess[code] = byName; sessionStorage.setItem('ind_hint', JSON.stringify(sess)); } catch (e) { }
      return byName;
    }
    try {
      const d = await DL.fetchJson('https://push2.eastmoney.com/api/qt/stock/get?secid=' + DL.emSecidOf(code) + '&fields=f57,f127');
      const ind = d && d.data && d.data.f127;
      if (ind) {
        try { const sess = JSON.parse(sessionStorage.getItem('ind_hint') || '{}'); sess[code] = ind; sessionStorage.setItem('ind_hint', JSON.stringify(sess)); } catch (e) { }
        return DL.industryOf(ind);
      }
    } catch (e) { }
    return null;
  }

  /* 机会速览（P2 重构 2026-08-18 大师裁决）：机会雷达（三档线位置）+ 变化提醒（事件）并存不互替
   * 雷达=当前股息率 vs 行业三档线（小仓/加仓/重仓），变化提醒=股息率+0.5pp/价格-15%（原逻辑保留） */
  async function renderOpportunities() {
    const el = $('#homeOpportunities');
    if (!el) return;
    const wl = homeState.watchlist;
    if (!wl.length) { el.innerHTML = '<div class="hint">暂无自选股。添加自选后，这里显示三档机会雷达+股息率/估值变化提醒。</div>'; return; }
    el.innerHTML = '<div class="hint">加载中…</div>';
    const snap = await DL.getStockQuotes(wl.map(x => x.code));
    homeState.snap = snap;
    const radar = { heavy: [], add: [], small: [], wait: [] };
    const nearAdd = [];
    for (const it of wl) {
      const s = snap[it.code];
      if (!s) continue;
      const dyNew = (it.snapshot && it.snapshot.dps && s.price) ? (it.snapshot.dps / s.price) * 100 : null;
      const ind = await industryHint(it.code);
      const spot = (dyNew != null && ind) ? DL.tierSpot(dyNew, ind, it.code) : null;
      if (spot) {
        /* v1.9.13：pending（溢价线待补）只展示不触发，不进雷达落档 */
        if (spot.pending) { radar.pending = radar.pending || []; radar.pending.push({ name: it.name, dy: dyNew }); }
        else {
          radar[spot.cur].push({ name: it.name, dy: dyNew, line: spot.line });
          if (spot.cur === 'wait' || spot.cur === 'small') nearAdd.push({ name: it.name, gap: spot.line - dyNew, dy: dyNew });
        }
      }
    }
    const alerts = [];
    for (const it of wl) {
      const s = snap[it.code];
      if (!s) continue;
      if (it.snapshot) {
        const dyOld = it.snapshot.divYield, dyNew = (it.snapshot.dps / s.price) * 100;
        if (dyOld != null && dyNew - dyOld >= 0.5) alerts.push(`${it.name} 股息率 ${dyOld.toFixed(2)}%→${dyNew.toFixed(2)}% ↑`);
        if (it.snapshot.price && s.price && (s.price / it.snapshot.price - 1) <= -0.15) alerts.push(`${it.name} 较加入时下跌 ${Math.abs((s.price / it.snapshot.price - 1) * 100).toFixed(1)}%`);
      }
    }
    const radarLines = [];
    if (radar.heavy.length) radarLines.push(`<b style="color:#e05a5a">🔴 ${radar.heavy.length} 只重仓区</b> ${radar.heavy.map(x => x.name + ' ' + x.dy.toFixed(2) + '%').join('、')}`);
    if (radar.add.length) radarLines.push(`<b style="color:var(--gold)">🟠 ${radar.add.length} 只加仓区</b> ${radar.add.map(x => x.name + ' ' + x.dy.toFixed(2) + '%').join('、')}`);
    if (radar.small.length) radarLines.push(`🟡 ${radar.small.length} 只小仓区 ${radar.small.map(x => x.name).join('、')}`);
    if (radar.wait.length) radarLines.push(`⚪ ${radar.wait.length} 只等待区 ${radar.wait.map(x => x.name).join('、')}`);
    if (radar.pending && radar.pending.length) radarLines.push(`🕓 ${radar.pending.length} 只线待补 ${radar.pending.map(x => x.name + ' ' + x.dy.toFixed(2) + '%').join('、')}`);
    nearAdd.sort((a, b) => a.gap - b.gap);
    let html = '';
    if (radarLines.length) html += `<div style="margin-bottom:4px;font-size:12px">🔍 <b>机会雷达</b>：${radarLines.join('；')}</div><div class="hint" style="font-size:10px;margin-bottom:4px">位置≠建议——当前股息率在三档的哪个区，结合分位与财报底座判断</div>`;
    if (nearAdd.length) html += `<div class="hint">距加仓线最近：${nearAdd.slice(0, 3).map(x => `${x.name} 差 <b>${x.gap.toFixed(2)}pp</b>`).join(' · ')}（现价股息率 vs 行业加仓线）</div>`;
    html += alerts.length
      ? alerts.map(a => `<div class="alert-item">🔔 ${a}</div>`).join('')
      : '<div class="hint">✅ 变化提醒：自选股状态稳定（股息率/价格无显著变化）</div>';
    /* 首页速览增强（UI 待办）：今日触发/买点命中——读 watch 最近报告 */
    try {
      const wr = await fetch('/tmp/watch-report.json').then(r => r.json()).catch(() => null);
      if (wr && Array.isArray(wr.changes) && wr.changes.length) {
        html += `<div class="alert-item" style="border-color:#4caf7d">📡 监测触发（${wr.ts.slice(0, 16).replace('T', ' ')}）：${wr.changes.slice(0, 5).map(c => `${c.name} ${c.verdict}（dy ${c.dy != null ? c.dy.toFixed(2) + '%' : '—'}）`).join('；')}</div>`;
      }
      if (wr && wr.regime) html += `<div class="alert-item">🌡️ ${wr.regime.level}：${wr.regime.note}</div>`;
      if (wr && wr.rateShift) html += `<div class="alert-item">🔄 ${wr.rateShift}</div>`;
    } catch (e) {}
    el.innerHTML = html;
  }

  /* 自选卡片：默认3指标（股息率+分位、估值分位、年化/回撤合并）+ 展开态 */
  async function renderWatchlist() {
    const el = $('#homeWatchlist');
    if (!el) return;
    const wl = homeState.watchlist;
    if (!wl.length) {
      // P2-28: 优先用扫描器最近结果（动态），无缓存回落硬编码预设
      const snapHit = await DL.cacheGet('snap:all');
      let recs = null;
      try {
        const divs = await DL.cacheGet('scan:last');
        if (divs && divs.data && divs.data.length) recs = divs.data.slice(0, 4);
      } catch (e) { }
      if (!recs) recs = ETF_PRESETS().filter(x => x.type === 'etf').slice(0, 4).map(x => ({ code: x.code, name: x.name }));
      el.innerHTML = `<div class="hint">还没有自选。搜索代码 → 点➕ 添加，或试试：<br>` +
        recs.map(x => `<button class="chip" data-code="${x.code}">${x.name}</button>`).join(' ') +
        `</div>`;
      el.querySelectorAll('.chip').forEach(b => b.onclick = () => addToWatchlist(b.dataset.code));
      return;
    }
    const snap = homeState.snap || await DL.getStockQuotes(wl.map(x => x.code));
    homeState.snap = snap;
    /* P1（2026-08-18 大师裁决）：快照缺失自动补拉——每标的每会话限 1 次（sessionStorage 记账），失败不自动死循环，显示"点此重试" */
    const retried = {};
    try { JSON.parse(sessionStorage.getItem('wl_retry') || '{}').forEach(c => retried[c] = 1); } catch (e) { }
    const needRetry = [];
    for (const it of wl) {
      if (!(it.snapshot && it.snapshot.divYield != null) && !retried[it.code]) {
        retried[it.code] = 1;
        needRetry.push(it.code);
        try { sessionStorage.setItem('wl_retry', JSON.stringify(Object.keys(retried))); } catch (e) { }
      }
    }
    const snapAllInd = {};
    try {
      const snapAll = await DL.cacheGet('snap:all');
      if (snapAll) wl.forEach(it => { const x = snapAll[it.code]; if (x && x.industry) snapAllInd[it.code] = DL.industryOf(x.industry); });
    } catch (e) { }
    for (const code of needRetry) {
      try {
        const name = (wl.find(x => x.code === code) || {}).name || code;
        const price = (snap[code] || {}).price;
        const divs = await DL.fetchDividendsOne(code);
        const dy = price ? DL.calcAnnualDivYield(divs, price) : null;
        if (dy && dy.yieldPct) await DL.Watchlist.updateSnapshot(code, { divYield: dy.yieldPct, dps: dy.yieldPct * price / 100, price, at: Date.now() });
      } catch (e) { /* 静默：下次"点此重试" */ }
    }
    if (needRetry.length) { const wl2 = await DL.Watchlist.list(); homeState.watchlist = wl2; wl.length = 0; wl.push(...wl2); }
    /* O3（2026-08-18 大师排序第一）：卖出信号角标——每标的每会话补算 1 次（sessionStorage 缓存），只拉 divs（1 请求）
     * 与诊断页 renderSellSignals 同源（DL.sellSignalQuick）；失败=无信号（角标宁缺勿误报） */
    let sellSig = {};
    try { sellSig = JSON.parse(sessionStorage.getItem('sell_sig') || '{}'); } catch (e) { }
    const sellNeed = wl.filter(it => !(it.code in sellSig)).map(it => it.code);
    for (const code of sellNeed) {
      sellSig[code] = 'pending';
      try {
        const divs = await DL.fetchDividendsOne(code);
        const r = DL.sellSignalQuick(divs);
        sellSig[code] = (r.epsBad || r.divBad) ? (r.epsBad && r.divBad ? 'both' : (r.epsBad ? 'eps' : 'div')) : 'ok';
      } catch (e) { sellSig[code] = 'ok'; }
      try { sessionStorage.setItem('sell_sig', JSON.stringify(sellSig)); } catch (e) { }
    }
    el.innerHTML = wl.map(it => {
      const s = snap[it.code];
      const dy = it.snapshot ? it.snapshot.divYield : null;
      const sig = sellSig[it.code];
      const sigTxt = sig && sig !== 'ok' && sig !== 'pending'
        ? `<span class="chip" style="background:rgba(224,90,90,.15);color:#e05a5a;font-size:10px;padding:1px 6px;border:1px solid rgba(224,90,90,.4)" title="连续2年${sig.indexOf('eps') >= 0 ? 'EPS下滑' : ''}${sig === 'both' ? ' + ' : ''}${sig.indexOf('div') >= 0 ? '分红下调' : ''}（5财年窗口）">⚠️ 卖出信号</span>` : '';
      /* O1（并入 P2）：自选卡三档联动——距加仓线差（股息率差口径，大师 Q3 确认；行业未识别降级） */
      const ind = snapAllInd[it.code];
      const spot = (dy != null && ind) ? DL.tierSpot(dy, ind, it.code) : null;
      const gapTxt = spot ? (spot.pending ? '<span style="color:var(--gold)" title="K线源故障，溢价线待补">⚠️ 线待补（仅参考）</span>' : spot.cur === 'add' ? '<span style="color:var(--gold)">已到加仓线</span>' : spot.cur === 'heavy' ? '<span style="color:#e05a5a">已到重仓线</span>' : spot.cur === 'small' ? `距加仓线差 <b>${spot.gapAdd.toFixed(2)}pp</b>` : `距小仓线差 ${(spot.mid - dy).toFixed(2)}pp`) : '';
      /* v1.9.13：过滤层黄灯角标（红线/短样本→可点击跳诊断页看原因；大师第2轮：角标=入口不是终点） */
      const spotTl = spot && spot.tl;
      const warnTxt = spotTl && !spot.pending && (spotTl.redLine || spotTl.shortSample || spotTl.drift)
        ? `<a href="javascript:void(0)" class="wl-warn" data-code="${it.code}" title="信号降级：${[spotTl.redLine ? '支付率超红线' : '', spotTl.shortSample ? '短样本' : '', spotTl.drift ? '线漂移' : ''].filter(Boolean).join('、')}（点击看详情）" style="color:#d9a45b;font-size:10px;margin-left:4px">🟡</a>` : '';
      const missTxt = (dy == null && retried[it.code]) ? ' · <a href="javascript:void(0)" class="wl-retry" data-code="' + it.code + '" style="color:var(--gold)">点此重试</a>' : '';
      return `<div class="wl-card" data-code="${it.code}">
        <div class="wl-head"><b>${it.name}</b><span class="wl-code">${it.code}</span>${warnTxt}${sigTxt}${secTypeLabel({ code: it.code }) !== '股票' ? `<span class="chip" style="font-size:10px;padding:1px 6px">${secTypeLabel({ code: it.code })}</span>` : ''}
          <button class="wl-del" data-code="${it.code}">✕</button></div>
        <div class="wl-main">${dy != null ? `年化股息率 <b class="gold">${dy.toFixed(2)}%</b>` : '<span class="hint">待数据</span>' + missTxt}
          ${s ? `<span class="wl-price">${fmt(s.price, 2)}元</span>` : ''}</div>
        <div class="wl-sub hint">${gapTxt || '点击进入诊断'}${gapTxt ? ' · 点击进入诊断' : ''}</div>
      </div>`;
    }).join('');
    el.querySelectorAll('.wl-card').forEach(c => c.onclick = () => openDiagnose(c.dataset.code));
    /* v1.9.13：黄灯角标→诊断页（大师第2轮：角标=入口不是终点；stopPropagation 防触卡） */
    el.querySelectorAll('.wl-warn').forEach(a => {
      a.onclick = e => { e.stopPropagation(); openDiagnose(a.dataset.code); };
    });
    el.querySelectorAll('.wl-del').forEach(b => {
      b.onclick = async e => { e.stopPropagation(); await DL.Watchlist.remove(b.dataset.code); renderHome(); };
    });
    /* P1 手动重试：清 sessionStorage 标记 → 重新渲染触发补拉 */
    el.querySelectorAll('.wl-retry').forEach(a => {
      a.onclick = async e => {
        e.stopPropagation();
        const code = a.dataset.code;
        try { const r = JSON.parse(sessionStorage.getItem('wl_retry') || '[]').filter(c => c !== code); sessionStorage.setItem('wl_retry', JSON.stringify(r)); } catch (err) { }
        renderHome();
      };
    });
  }

  /* 分红到账日历 v1.9.3：自选未来12个月（已宣告+上年同期估计，月度汇总+持仓金额）
   * 持仓股数可填（divtool_holdings_{code}），未填只显示每股合计 */
  async function renderDivCalendar() {
    const el = $('#homeDivCalendar');
    if (!el) return;
    const wl = homeState.watchlist;
    if (!wl.length) { el.innerHTML = '<div class="hint">还没有自选。添加自选后，这里显示未来 12 个月的分红到账日历（已宣告+上年同期估算）。</div>'; return; }
    el.innerHTML = '<div class="hint">分红日历加载中…</div>';
    const today = DL.todayStr();
    let holdings = {};
    try { holdings = JSON.parse(localStorage.getItem('divtool_holdings') || '{}'); } catch (e) {}
    const allDivs = [];
    const names = {};
    const cagrs = [];   // E3：自选分红 CAGR 收集（保守口径）
    for (const it of wl.slice(0, 20)) {
      try {
        const divs = await DL.fetchDividendsOne(it.code);
        divs.forEach(d => { if (d.dps > 0 && !d.pending) { d.code = it.code; d.name = it.name || it.code; } });
        allDivs.push(...divs);
        names[it.code] = it.name || it.code;
        const cagr = DL.calcDivCAGR(divs, 3);
        if (cagr != null) cagrs.push(cagr);
      } catch (e) {}
    }
    const cf = DL.calcFutureCashflow(allDivs, holdings, today, 12);
    // v1.9.6 P1-2：近30天除息提醒（已宣告，非估算）
    const soon = [];
    cf.forEach(m => m.items.forEach(x => { if (!x.est && x.ex) soon.push(x); }));
    soon.sort((a, b) => (a.ex < b.ex ? -1 : 1));
    const near30 = soon.filter(x => { const d = new Date(x.ex + 'T00:00:00'); return (d - new Date(today + 'T00:00:00')) <= 30 * 86400000; });
    const nearTxt = near30.length
      ? `<div style="font-size:11px;color:var(--gold);margin-bottom:6px">⏰ 近30天除息：${near30.map(x => `${x.name} ${x.ex.slice(5)} 每股${(x.dps * 10).toFixed(2)}元${x.shares > 0 ? '（' + x.shares + '股 → ' + (x.dps * x.shares / 10000).toFixed(2) + '万）' : ''}`).join(' · ')}</div>`
      : '';
    // v1.9.6 P1-1：分红收入目标（主人“靠分红”定位：目标覆盖度）
    let target = 0;
    try { target = parseFloat(localStorage.getItem('divtool_div_target') || '0') || 0; } catch (e) {}
    const yearTotalNow = cf.reduce((s, m) => s + m.total, 0);
    const targetHtml = target > 0
      ? `<div style="font-size:11px;color:var(--txt);margin-bottom:6px">🎯 分红目标 ${(target / 10000).toFixed(1)}万/年 → 当前覆盖 <b style="color:var(--gold)">${Math.min(999, yearTotalNow / target * 100).toFixed(0)}%</b>${yearTotalNow < target ? ` · 缺口 ${((target - yearTotalNow) / 10000).toFixed(1)}万/年` : ' · 已达标 🎉'}</div>`
      : '';
    // D4（阶段4）：组合级视图——组合加权股息率 + 单票风险占比（持仓占比×股息率贡献；无持仓=按自选等权示意）
    let comboHtml = '';
    try {
      const pos = Object.keys(holdings).length ? holdings : null;
      const rows4 = wl.slice(0, 20).map(it => {
        const sn = it.snapshot || {};
        const price = sn.price || 0, dy = sn.divYield != null ? sn.divYield : null;
        const shares = pos && pos[it.code] ? pos[it.code] : 0;
        const val = shares > 0 ? shares * price : 0;
        return { code: it.code, name: it.name || it.code, price, dy, val, shares };
      }).filter(r => r.price > 0);
      const totalVal = pos ? rows4.reduce((s, r) => s + r.val, 0) : 0;
      const weight = r => pos ? (totalVal > 0 ? r.val / totalVal : 0) : 1 / Math.max(1, rows4.length);
      const comboDy = rows4.reduce((s, r) => s + (r.dy != null ? r.dy * weight(r) : 0), 0);
      const riskRows = rows4.filter(r => weight(r) > 0.02).sort((a, b) => b.dy * weight(b) - a.dy * weight(a)).slice(0, 5);
      comboHtml = `<div style="margin:6px 0;padding:6px 9px;border-radius:8px;border:1px solid var(--line);background:rgba(0,0,0,.15)">
        <div style="font-size:11px;color:var(--sub);margin-bottom:3px">📊 组合级视图（D4）${pos ? '' : '<span style="font-size:9px">（未填持仓=按自选等权示意）</span>'}</div>
        <div style="font-size:12px">组合加权股息率 <b class="green">${comboDy.toFixed(2)}%</b> ${pos ? `（持仓 ${rows4.length} 只）` : ''}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px">单票风险占比（股息率×权重，前5）：${riskRows.map(r => `${r.name} <b>${(r.dy * weight(r)).toFixed(2)}%</b>`).join(' · ')}</div>
      </div>`;
    } catch (e) {}
    const targetInput = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px"><span style="font-size:11px;color:var(--muted)">每年目标分红（万）：</span><input id="divtoolTargetInput" type="number" min="0" placeholder="如 20" value="${target ? (target / 10000).toFixed(1) : ''}" style="width:70px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:11px"><button type="button" class="chip" id="divtoolTargetSave">💾 保存</button></div>`;
    // 持仓管理行
    const holdInput = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px"><span style="font-size:11px;color:var(--muted)">持仓股数：</span><input id="divtoolHoldInput" type="text" placeholder="600036:5000, 601398:20000（代码:股数，逗号分隔）" value="${Object.entries(holdings).map(([c, s]) => c + ':' + s).join(', ')}" style="flex:1;min-width:0;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:11px"><button type="button" class="chip" id="divtoolHoldSave">💾 保存</button></div><div style="font-size:10px;color:var(--muted);margin:-4px 0 6px">格式：代码:股数，逗号分隔（如 600036:5000）——填了才能算到账金额</div>`;
    const rows = cf.map(m => {
      const hasAmt = m.items.some(x => x.shares > 0);
      const amt = hasAmt ? m.items.reduce((s, x) => s + x.dps * x.shares, 0) : 0;
      const items = m.items.map(x => {
        /* O2（2026-08-18 大师排序第三）：日历×三档联动——每只标的显示当前股息率 vs 加仓线（同步零网络） */
        const wlIt = wl.find(w => w.code === x.code);
        const dy = wlIt && wlIt.snapshot ? wlIt.snapshot.divYield : null;
        let tierTxt = '';
        if (dy != null) {
          const ind = industryForSync(x.code, x.name);
          const spot = ind ? DL.tierSpot(dy, ind, x.code) : null;
          if (spot) tierTxt = spot.pending ? ' <span style="color:var(--gold)" title="K线源故障，溢价线待补">⚠️线待补</span>' : spot.cur === 'add' ? ' <span style="color:var(--gold)">已到加仓线</span>' : spot.cur === 'heavy' ? ' <span style="color:#e05a5a">已到重仓线</span>' : spot.cur === 'small' ? ` <span style="color:var(--sub)">距加仓线差 ${spot.gapAdd.toFixed(2)}pp</span>` : ` <span style="color:var(--sub)">距小仓线差 ${(spot.mid - dy).toFixed(2)}pp</span>`;
        }
        return `${x.name}${x.est ? '(估)' : ''} ${(x.dps * 10).toFixed(2)}元${x.shares > 0 ? '×' + x.shares : ''}${tierTxt}`;
      }).join(' · ');
      return `<div class="cal-item" style="display:flex;justify-content:space-between;gap:6px"><span class="cal-date">${m.month}</span><span style="flex:1;font-size:11px">${items}</span>${hasAmt ? `<b style="color:var(--txt)">${(amt / 10000).toFixed(2)}万</b>` : ''}</div>`;
    });
    const yearTotal = cf.reduce((s, m) => s + m.total, 0);
    /* E1 分红年报 + D12 消费自由度 + E2 追加视角（2026-08-18 P1）：
     * E1：历史年度分红收入（持仓股数×除息日 dps，按年聚合+同比）
     * D12：月支出→覆盖率+缺口本金区间（保守 4-5% 股息率，给区间不给假精确）+ 提取四档（诚实呈现）
     * E2：追加金额→年/月分红贡献（按自选平均股息率） */
    const sharesOf = (code) => holdings[code] || 0;
    const yearMap = {};
    allDivs.forEach(d => { if (!(d.dps > 0) || !d.ex) return; const y = d.ex.slice(0, 4); const s = sharesOf(d.code); if (!s) return; yearMap[y] = (yearMap[y] || 0) + d.dps * s; });
    const years = Object.keys(yearMap).sort();
    const yearRows = years.slice(-6).map((y, i, a) => {
      const prev = i > 0 ? a[i - 1] : null;
      const cur = yearMap[y];
      const yoy = (prev && yearMap[prev] > 0) ? ((cur / yearMap[prev] - 1) * 100) : null;
      return `<div style="font-size:11px;padding:2px 0">${y}：<b>${(cur / 10000).toFixed(2)}万</b>${yoy != null ? ` <span style="color:${yoy >= 0 ? '#4caf7d' : '#e05a5a'}">${yoy >= 0 ? '↑' : '↓'}${Math.abs(yoy).toFixed(0)}%</span>` : ''}</div>`;
    }).join('');
    const expDef = (() => { try { return parseFloat(localStorage.getItem('divtool_monthly_exp') || '0') || 0; } catch (e) { return 0; } })();
    const yearIncome = yearMap[years[years.length - 1]] || yearTotalNow;   // 最近完整年（或未来12月估）
    const yearExp = expDef * 12;
    const covPct = (yearExp > 0 && yearIncome > 0) ? Math.min(999, yearIncome / yearExp * 100) : null;
    const gap = (yearExp > 0 && yearIncome < yearExp) ? yearExp - yearIncome : 0;
    const gapRange = gap > 0 ? `缺口本金 ≈ <b>${(gap / 0.05 / 10000).toFixed(0)}~${(gap / 0.04 / 10000).toFixed(0)}万</b>（按 4-5% 股息率区间）` : (yearExp > 0 ? '已覆盖 🎉' : '');
    const addDef = (() => { try { return parseFloat(localStorage.getItem('divtool_add_amt') || '0') || 0; } catch (e) { return 0; } })();
    const avgDy = (() => { const ds = wl.map(w => w.snapshot && w.snapshot.divYield).filter(x => x > 0); return ds.length ? ds.reduce((s, x) => s + x, 0) / ds.length : 0.05; })();
    const addYear = addDef * avgDy, addMonth = addYear / 12;
    /* E3 分红里程碑：按自选平均 CAGR（保守口径）算月分红翻倍年数（72 法则精确式 ln2/ln(1+g)） */
    const avgCagr = cagrs.length ? cagrs.reduce((s, x) => s + x, 0) / cagrs.length : null;
    const doubleY = (avgCagr != null && avgCagr > 0) ? Math.log(2) / Math.log(1 + avgCagr) : null;
    const etfRefId = 'divLifeEtf';
    const lifeHtml = `<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px">
      <details><summary style="font-size:11px;color:var(--sub);cursor:pointer">💸 分红生活视角（E1 年报 · D12 消费覆盖 · E2 追加 · E3 里程碑 · D11 ETF 参照）</summary>
        <div style="font-size:11px;color:var(--sub);margin:6px 0 4px">📅 近 ${Math.min(6, years.length)} 年实际分红收入（需填持仓股数）：</div>
        <div>${yearRows || '<span class="hint">填写上方持仓股数后显示历史分红收入</span>'}</div>
        <div style="font-size:11px;margin-top:6px">🚀 分红里程碑：${doubleY ? `按近 3 年分红增速 ${(avgCagr * 100).toFixed(1)}% 持续（保守口径），月分红翻倍还需约 <b>${doubleY.toFixed(0)} 年</b>` : '<span class="hint">自选样本不足，无法估算增速（分红不增长时永远不翻倍）</span>'}</div>
        <div id="${etfRefId}" style="font-size:11px;margin-top:4px"><span class="hint">红利 ETF 参照加载中…</span></div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:8px"><span style="font-size:11px;color:var(--muted)">月生活支出（元）：</span><input id="divLifeExp" type="number" min="0" placeholder="如 15000" value="${expDef || ''}" style="width:90px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:11px"><button type="button" class="chip" id="divLifeExpSave">💾 算覆盖</button></div>
        <div style="font-size:11px;margin-top:4px">${covPct != null ? `当前年分红 <b>${(yearIncome / 10000).toFixed(2)}万</b>（月 ${(yearIncome / 12 / 10000).toFixed(2)}万）→ 覆盖月支出 <b style="color:var(--gold)">${covPct.toFixed(0)}%</b>；${gapRange}` : '<span class="hint">填月支出后显示覆盖率与缺口本金</span>'}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">提取参考（分红由持股产生，提取不影响下年分红基数）：提取 0/30/50/100% → 每年可消费 0 / ${(yearIncome * 0.3 / 10000).toFixed(2)} / ${(yearIncome * 0.5 / 10000).toFixed(2)} / ${(yearIncome / 10000).toFixed(2)} 万，剩余复投</div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:8px"><span style="font-size:11px;color:var(--muted)">追加金额（元）：</span><input id="divLifeAdd" type="number" min="0" placeholder="如 50000" value="${addDef || ''}" style="width:90px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:11px"><button type="button" class="chip" id="divLifeAddSave">💾 算贡献</button><span style="font-size:10px;color:var(--muted)">按自选平均股息率 ${(avgDy * 100).toFixed(1)}%</span></div>
        <div style="font-size:11px;margin-top:4px">${addDef > 0 ? `追加 ${(addDef / 10000).toFixed(1)}万 → 年贡献分红 <b>${(addYear / 10000).toFixed(2)}万</b>（月 ${(addMonth / 10000).toFixed(2)}万）——1 年后起算，长期吃分红视角` : '<span class="hint">填追加金额后显示分红贡献</span>'}</div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap">
          <button type="button" class="chip" id="divLifeReinvest" style="color:#4caf7d">🔄 分红→再投资（去扫描器）</button>
          <button type="button" class="chip" id="divLifeExport">⬇️ 导出数据（换设备迁移）</button>
          <button type="button" class="chip" id="divLifeImport">⬆️ 导入数据</button>
          <input type="file" id="divLifeImportFile" accept="application/json" style="display:none">
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">导出=自选/持仓/决策日志/目标/支出/设置（JSON 带版本号，本地文件不上传）</div>
      </details>
    </div>`;
    el.innerHTML = `${holdInput}${targetInput}${targetHtml}${comboHtml}${nearTxt}<div style="font-size:11px;color:var(--muted);margin-bottom:6px">未来 12 个月预计到账 <b>${cf.length} 个月</b>${yearTotal > 0 ? ' · 合计 <b style="color:var(--txt)">' + (yearTotal / 10000).toFixed(2) + ' 万</b>' : ''}（估=上年同期推算，未公告）</div>${rows.length ? rows.join('') : '<div class="hint">未来 12 个月无预计到账</div>'}${lifeHtml}`;
    const saveBtn = $('#divtoolHoldSave');
    if (saveBtn) saveBtn.onclick = () => {
      const v = ($('#divtoolHoldInput') || {}).value || '';
      const h = {};
      v.split(',').forEach(part => {
        const m = part.trim().match(/^(\d{6})\s*[:：]\s*(\d+)$/);
        if (m) h[m[1]] = parseInt(m[2], 10);
      });
      try { localStorage.setItem('divtool_holdings', JSON.stringify(h)); } catch (e) {}
      renderDivCalendar();
    };
    const tSave = $('#divtoolTargetSave');
    if (tSave) tSave.onclick = () => {
      const v = parseFloat(($('#divtoolTargetInput') || {}).value || '0') || 0;
      try { localStorage.setItem('divtool_div_target', String(v * 10000)); } catch (e) {}
      renderDivCalendar();
    };
    // D12/E1/E2：生活视角按钮
    const expSave = $('#divLifeExpSave');
    if (expSave) expSave.onclick = () => {
      const v = parseFloat(($('#divLifeExp') || {}).value || '0') || 0;
      try { localStorage.setItem('divtool_monthly_exp', String(v)); } catch (e) {}
      renderDivCalendar();
    };
    const addSave = $('#divLifeAddSave');
    if (addSave) addSave.onclick = () => {
      const v = parseFloat(($('#divLifeAdd') || {}).value || '0') || 0;
      try { localStorage.setItem('divtool_add_amt', String(v)); } catch (e) {}
      renderDivCalendar();
    };
    // P2：分红资金闭环（D12 出口→扫描器再投资）
    const reinBtn = $('#divLifeReinvest');
    if (reinBtn) reinBtn.onclick = () => {
      try { const h = document.querySelector('[data-tab="home"]'); if (h) h.click(); const d = $('#btnDiscover'); if (d) d.click(); } catch (e) {}
    };
    // P2 F3：多设备数据迁移（导出/导入 JSON 带版本号）
    const exBtn = $('#divLifeExport');
    if (exBtn) exBtn.onclick = () => {
      try {
        const data = {
          v: 1, app: 'dividend-tool', exportedAt: DL.todayStr(),
          watchlist: wl.map(w => ({ code: w.code, name: w.name || '' })),
          holdings: (() => { try { return JSON.parse(localStorage.getItem('divtool_holdings') || '{}'); } catch (e) { return {}; } })(),
          decisions: decLog(),
          target: localStorage.getItem('divtool_div_target') || '',
          monthlyExp: localStorage.getItem('divtool_monthly_exp') || '',
          addAmt: localStorage.getItem('divtool_add_amt') || '',
          mode: localStorage.getItem('divtool_zone_mode') || '',
        };
        const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dividend-tool-backup-' + DL.todayStr() + '.json'; a.click();
      } catch (e) { try { toast('导出失败'); } catch (e2) {} }
    };
    const imBtn = $('#divLifeImport'), imFile = $('#divLifeImportFile');
    if (imBtn) imBtn.onclick = () => { if (imFile) imFile.click(); };
    if (imFile) imFile.onchange = async (e) => {
      const file = e.target.files && e.target.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data || data.v !== 1 || data.app !== 'dividend-tool') { try { toast('文件版本不兼容'); } catch (e2) {} return; }
        if (Array.isArray(data.watchlist)) { try { localStorage.setItem('divtool_watchlist_v1', JSON.stringify(data.watchlist)); } catch (e2) {} }
        if (data.holdings) { try { localStorage.setItem('divtool_holdings', JSON.stringify(data.holdings)); } catch (e2) {} }
        if (Array.isArray(data.decisions)) { try { localStorage.setItem(DEC_KEY, JSON.stringify(data.decisions.slice(0, 200))); } catch (e2) {} }
        ['target', 'monthlyExp', 'addAmt'].forEach(k => { if (data[k] != null && data[k] !== '') { try { localStorage.setItem('divtool_' + k, data[k]); } catch (e2) {} } });
        if (data.mode) { try { localStorage.setItem('divtool_zone_mode', data.mode); } catch (e2) {} }
        try { toast('✅ 导入成功'); } catch (e2) {}
        if (typeof renderHome === 'function') { try { renderHome(); } catch (e2) {} }
        renderDivCalendar();
      } catch (err) { try { toast('导入失败：' + err.message); } catch (e2) {} }
    };
    // P2 D11：红利 ETF 年化分红参照（近 12 月每份分红 ÷ 现价，异步填充失败静默）
    (async () => {
      const etfEl = document.getElementById(etfRefId);
      if (!etfEl) return;
      try {
        const etfs = [['512890', '红利低波'], ['515080', '红利ETF'], ['510300', '沪深300']];
        const rows = [];
        for (const [code, name] of etfs) {
          try {
            const divs = await DL.fetchEtfDividends(code);
            const snap = await DL.getStockQuotes([code]);
            const price = snap[code] && snap[code].price;
            if (!divs || !divs.length || !price) continue;
            const start = new Date(Date.now() - 366 * 86400000).toISOString().slice(0, 10);
            let sum = 0;
            divs.forEach(d => { if (d.ex && d.ex >= start && d.ex <= DL.todayStr()) sum += d.dps; });
            rows.push(name + ' <b>' + (sum / price * 100).toFixed(1) + '%</b>');
          } catch (e) {}
        }
        etfEl.innerHTML = rows.length
          ? '📊 红利ETF 年化分红参照（近12月每份分红÷现价）：' + rows.join(' · ') + ' <span style="color:var(--muted)">vs 自选平均 ' + (avgDy * 100).toFixed(1) + '%</span>'
          : '<span class="hint">ETF 参照加载失败（数据源暂不可用）</span>';
      } catch (e) { const el2 = document.getElementById(etfRefId); if (el2) el2.innerHTML = '<span class="hint">ETF 参照加载失败</span>'; }
    })();
  }

  /* 扫描入口：决策台底部按钮 → 打开扫描子页（简单内嵌） */
  let _scanRunning = false;   // v1.9.2 O2：扫描器运行锁（防重复点击并发覆盖）
  async function runScanner() {
    if (_scanRunning) return;
    _scanRunning = true;
    const btn = $('#btnScan');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 扫描中…'; }
    try {
    const el = $('#scanPanel');
    el.style.display = 'block';
    el.innerHTML = '<div class="hint">⏳ 扫描中：拉取全市场分红数据（近 3 年，连分判定需要）…</div>';
    // v1.9.6 修复：原来只拉 365 天→连分≥3年永远不满足→恒 0 只（确定性 bug）；改拉 3 年
    const from = new Date(Date.now() - 3 * 366 * 86400000).toISOString().slice(0, 10);
    try {
      const divs = await DL.fetchDividendsAll(from);
      el.innerHTML = `<div class="hint">✅ 分红数据 ${divs.length} 条，拉取行情快照…</div>`;
      const snap = await DL.getMarketSnapshot();
      // v1.9.6 P0-4：快照完整性检查（防残缺数据静默筛选出 0 只）
      const snapMeta = snap && snap.__meta;
      const snapKeys = Object.keys(snap).filter(k => k !== '__meta');
      if (snapMeta && snapMeta.total > 0 && snapMeta.actual < snapMeta.total * 0.5) {
        el.innerHTML = `<div class="hint err">⚠️ 行情快照返回不完整（${snapMeta.actual}/${snapMeta.total} 条），结果可能不准确，请稍后重试</div>`;
        return;
      }
      // v1.7.6 M10：行情快照全失败时明确提示，避免误显示"筛选出 0 只"
      if (!snapKeys.length) {
        el.innerHTML = `<div class="hint err">⚠️ 行情快照获取失败（数据源不可用），请稍后重试</div>`;
        return;
      }
      el.innerHTML = '<div class="hint">⏳ 合并计算中…</div>';
      const rows = [];
      // v1.7.4 P7：扫描改用年化股息率（按报告期归组），替代单笔/365天窗口
      // v1.7.6 M5：按股票去重（byCode keys），同一股票多笔分红只算一次；补连分≥3年过滤（T06 divYears 落地）
      const byCode = {};
      divs.forEach(d => { if (!byCode[d.code]) byCode[d.code] = []; byCode[d.code].push(d); });
      for (const code of Object.keys(byCode)) {
        const list = byCode[code];
        const s = snap[code];
        if (!s || !s.price) continue;
        if (DL.CALIB.THRESHOLDS.excludeST && (list[0].name || s.name || '').includes('ST')) continue;
        if (s.marketCap && s.marketCap < DL.CALIB.THRESHOLDS.marketCap) continue;
        // 连分年数：有除息日的记录按报告年去重计数（≥divYears 才保留）
        const payYears = new Set(list.filter(x => !x.pending && x.ex).map(x => (x.report || x.ex).slice(0, 4)).filter(Boolean));
        if (payYears.size < DL.CALIB.THRESHOLDS.divYears) continue;
        const dy = DL.calcAnnualDivYield(list, s.price);
        const yieldPct = dy ? dy.yieldPct : null;
        if (yieldPct == null || yieldPct < DL.CALIB.THRESHOLDS.divYield) continue;
        rows.push({ code, name: list[0].name || s.name, price: s.price, yieldPct, marketCap: s.marketCap, pe: s.pe, pb: s.pb, industry: s.industry, payYears: payYears.size, div: list[0] });
      }
      rows.sort((a, b) => b.yieldPct - a.yieldPct);
      await DL.cacheSet('scan:last', { ts: Date.now(), data: rows.slice(0, 20).map(r => ({ code: r.code, name: r.name })) });
      el.innerHTML = `<div class="hint">✅ 筛选出 ${rows.length} 只（年化股息率≥${DL.CALIB.THRESHOLDS.divYield}%、连分≥${DL.CALIB.THRESHOLDS.divYears}年、市值≥50亿、排除ST；⚠️=亏损仍分红，可持续性风险请自行判断）</div>` +
        rows.slice(0, 50).map(r => `<div class="scan-row" data-code="${r.code}">
          <b>${r.name}</b> <span class="wl-code">${r.code}</span>
          <span class="gold">${r.yieldPct.toFixed(2)}%</span><span class="hint"> 年化</span>
          <span class="hint">连分${r.payYears}年</span>
          ${r.pe != null && r.pe < 0 ? '<span class="risk-badge">⚠️亏损</span>' : ''}
          <span class="hint">${r.industry || ''} · 市值${(r.marketCap / 1e8).toFixed(0)}亿</span>
        </div>`).join('');
      el.querySelectorAll('.scan-row').forEach(r => r.onclick = () => { addToWatchlist(r.dataset.code); openDiagnose(r.dataset.code); });
    } catch (e) {
      el.innerHTML = `<div class="hint err">扫描失败：${e.message}，请稍后重试</div>`;
    }
    } finally {
      _scanRunning = false;
      if (btn) { btn.disabled = false; btn.textContent = '🔍 扫描新机会（全市场高股息）'; }
    }
  }

  /* v1.9.1 P5：发现器 MVP（三层动态池第一层粗筛的双通道落地）
   * 第一通道：股息率 ≥3%（clist 接口 f9 直接全市场排序，快）
   * 第二通道：增长榜（股息率 ≥2% + 分红 CAGR ≥10%）——对第一通道 top N 深扫补 CAGR
   * 输出：候选列表（股息率/CAGR/生态色标/样本年数/置信度）+ 点击加自选 */
  let _discRunning = false;   // v1.9.2 O2：发现器运行锁
  async function runDiscoverer() {
    if (_discRunning) return;
    _discRunning = true;
    const btnD = $('#btnDiscover');
    if (btnD) { btnD.disabled = true; btnD.textContent = '⏳ 发现中…'; }
    try {
    const el = $('#scanPanel');
    el.style.display = 'block';
    el.innerHTML = '<div class="hint">⏳ 发现器：拉取全市场股息率排序…</div>';
    try {
      // 第一通道：clist 全市场按股息率降序（f9=股息率%，实测可用）
      // v1.9.6 P0-10：自动重试 2 次（1.5s 间隔）；P0-5：失败走中文报错+重试按钮
      let list = null;
      for (let i = 0; i < 3; i++) {
        try {
          list = await DL.fetchJson('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fid=f9&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f2,f9,f12,f14,f20,f21');
          break;
        } catch (e) {
          if (i >= 2) throw new Error('东财行情接口繁忙（限流）');
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      const raw = (list && list.data && list.data.diff) || [];
      if (!raw.length) throw new Error('全市场列表为空（接口被限流）');
      // 过滤：有股息率 + ≥3% + 非 ST + 市值≥50亿
      const ch1 = raw.filter(r => r && r.f9 && r.f9 > 0 && r.f12 && !(r.f14 || '').includes('ST') && (!r.f20 || r.f20 >= 50e8))
        .map(r => ({ code: r.f12, name: r.f14, price: r.f2, dy: r.f9, cap: r.f20 }))
        .sort((a, b) => b.dy - a.dy);
      el.innerHTML = `<div class="hint">✅ 第一通道（股息率(TTM)≥3%）：${ch1.length} 只候选。深扫 top ${Math.min(40, ch1.length)} 算 CAGR/生态/置信度…</div>`;
      // 深扫 top N（批处理：5 并发 × 8 批，避免东财限流）
      const top = ch1.slice(0, 40);
      const rows = [];
      const scanOne = async (c) => {
        try {
          const [divs, kline] = await Promise.all([
            DL.fetchDividendsOne(c.code),
            DL.getKline(c.code, '2021-01-01', DL.todayStr()),
          ]);
          if (!divs || !divs.length) return;
          const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
          const last = series.filter(x => x.pct != null).pop();
          const eco = DL.calcEcoType(kline, series);
          const cagr = DL.calcDivCAGR(divs, 3);
          const payYears = new Set(divs.filter(x => !x.pending && x.ex).map(x => (x.report || x.ex).slice(0, 4)).filter(Boolean)).size;
          // 低置信度：样本<500天 或 分红<4年
          const lowConf = (last == null) || payYears < 4;
          rows.push({ ...c, pct: last ? last.pct : null, ecoType: eco.type, cagr, payYears, lowConf });
        } catch (e) { /* 单只跳过 */ }
      };
      for (let i = 0; i < top.length; i += 5) {
        await Promise.all(top.slice(i, i + 5).map(scanOne));
        el.innerHTML = `<div class="hint">⏳ 深扫进度：${Math.min(i + 5, top.length)}/${top.length}…</div>`;
      }
      // 第二通道标注：增长榜（CAGR≥10% 且股息率≥2%）高亮
      // D4（P0-6）：质量排序——负增长/低置信排后，同质量按股息率（高股息→高质量高股息）
      rows.sort((a, b) => {
        const qa = (a.cagr != null && a.cagr < 0) ? 1 : 0, qb = (b.cagr != null && b.cagr < 0) ? 1 : 0;
        if (qa !== qb) return qa - qb;
        const la = a.lowConf ? 1 : 0, lb = b.lowConf ? 1 : 0;
        if (la !== lb) return la - lb;
        return (b.dy || 0) - (a.dy || 0);
      });
      const ecoName = { low: '🟢低波', mid: '🟡中波', high: '🔴高波', declining: '🔻阴跌' };
      el.innerHTML = `<div class="hint">✅ 发现器完成：${rows.length} 只深扫（第一通道 ${ch1.length} 只 → top ${top.length}）· 绿色=增长榜（CAGR≥10%）· 低置信=样本不足 · 负增长排后（D4）</div>` +
        rows.slice(0, 40).map(r => `<div class="scan-row" data-code="${r.code}">
          <b>${r.name}</b> <span class="wl-code">${r.code}</span>
          <span class="gold">${r.dy.toFixed(2)}%</span><span class="hint"> TTM</span>
          ${r.cagr != null ? `<span class="${r.cagr >= 0.1 ? 'green' : (r.cagr >= 0 ? '' : 'red')}">CAGR ${(r.cagr * 100).toFixed(1)}%</span>` : '<span class="hint">CAGR—</span>'}
          ${r.cagr != null && r.cagr >= 0.1 ? '<span class="green">📈增长榜</span>' : ''}
          <span class="hint">${ecoName[r.ecoType] || ''}</span>
          ${r.pct != null ? `<span class="hint">分位${r.pct.toFixed(0)}</span>` : ''}
          ${r.lowConf ? '<span class="risk-badge">低置信</span>' : ''}
          <span class="hint">连分${r.payYears}年</span>
        </div>`).join('') + '<div class="hint" style="margin-top:4px">⚠️ 高股息≠稳赚：历史信号胜率分行业/档位差异大（见诊断卡标注），历史胜率≠本次会赢</div>';
      el.querySelectorAll('.scan-row').forEach(r => r.onclick = () => { addToWatchlist(r.dataset.code); openDiagnose(r.dataset.code); });
    } catch (e) {
      el.innerHTML = `<div class="hint err">⚠️ 发现器失败：${e.message.includes('限流') || e.message.includes('繁忙') ? '东财行情接口繁忙（限流），请稍后重试' : '数据获取失败，请稍后重试'} <button type="button" class="chip" id="btnDiscoverRetry" style="margin-left:8px">🔄 重试</button></div>`;
    const rb = document.getElementById('btnDiscoverRetry');
    if (rb) rb.onclick = runDiscoverer;
    }
    } finally {
      _discRunning = false;
      if (btnD) { btnD.disabled = false; btnD.textContent = '🔭 发现器（双通道：股息率≥3% ∪ 增长榜 CAGR≥10%）'; }
    }
  }

  /* ---------- 诊断页 ---------- */
  let diagCode = null;
  let diagYears = 5;
  let diagSeq = 0;   // v1.9.0 竞态修复：请求序号，旧请求异步返回时丢弃（防 D3→D4 串台覆盖 etfNote）
  async function openDiagnose(code, years) {
    const seq = ++diagSeq;
    diagCode = code;
    if (years) diagYears = years;
    switchTab('diagnose');
    $('#diagEmpty').style.display = 'none';
    $('#diagContent').style.display = 'block';
    $('#diagTitle').textContent = '🔬 ' + code + ' 诊断中…';
    $('#diagStats').innerHTML = '<div class="hint">加载中…</div>';
    updateDiagWlBtn(code, diagSeq);   // v1.9.4 B 入口：诊断页 ⭐ 加自选按钮（异步检测已自选态）
    // 时间 chips 高亮 + 绑定（P1-28：chips + 自定义输入联动，同一状态）
    const yq = $('#diagYieldQuick');
    if (yq) {
      yq.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.y === diagYears));
      if (!yq.dataset.bound) {
        yq.dataset.bound = '1';
        yq.querySelectorAll('button').forEach(b => b.onclick = () => openDiagnose(diagCode, +b.dataset.y));
        const ci = $('#diagYieldCustom');
        if (ci) ci.addEventListener('change', () => {
          const v = parseInt(ci.value, 10);
          if (v && v >= 1 && v <= 30) openDiagnose(diagCode, v);
        });
      }
      const ci = $('#diagYieldCustom');
      if (ci) ci.value = '';
    }
    const yl = $('#diagYieldYears');
    if (yl) yl.textContent = diagYears;
    try {
      const name = await DL.fetchName(code);
      if (seq !== diagSeq) return;   // v1.9.0 竞态修复：旧请求丢弃
      // v1.7.6 M9：ETF/指数分红标注（防误读：指数ETF分红频率低、不连续）
      const isEtf = /ETF|指数/.test(name) || /^(5|1)/.test(code);
      const etfNoteEl = $('#diagEtfNote');
      if (etfNoteEl) {
        etfNoteEl.style.display = isEtf ? 'block' : 'none';
        etfNoteEl.textContent = isEtf ? '⚠️ ETF/指数：若累计分红显示 0，为分红数据源暂缺或获取失败（已接入基金公告源，正常应显示真实分红记录）' : '';
      }
      $('#diagTitle').textContent = '🔬 ' + (name === code ? '' : name + ' ') + code;
      const [divs, kline] = await Promise.all([
        DL.fetchDividendsOne(code),
        /* v1.9.17：K线拉取范围 = max(diagYears, 10) 年——长期复投视角（5年/10年）需要 10 年数据，
         * 旧版只拉 diagYears（默认5年）→ 10年 永远"样本不足"，主人抓"做个5年10年怎么没优化" */
        DL.getKline(code, new Date(Date.now() - Math.max(diagYears, 10) * 366 * 86400000).toISOString().slice(0, 10), DL.todayStr()),
      ]);
      if (seq !== diagSeq) return;   // v1.9.0 竞态修复
      // BUG修复(2026-08-18)：snap 复用同根因——诊断其他股票时若 snap 缺该 code，合并拉取保证 PE/PB/价格齐全
      const fresh = await DL.getStockQuotes([code]);
      const snap = Object.assign({}, homeState.snap || {}, fresh);
      homeState.snap = snap;
      const s = snap[code] || {};
      const lastPrice = s.price || (kline && Object.values(kline).pop());
      // v1.7.4 P7：年化股息率改按报告期归组（近2报告年度平均÷现价），替代365天窗口
      const dy = DL.calcAnnualDivYield(divs, lastPrice);
      const divYield = dy ? dy.yieldPct : null;
      const dps = dy ? dy.annualDps : null;
      const yieldLabel = dy && dy.count === 1 ? '近1财年' : '近2财年';
      // 股息覆盖率 C2（v1.9.6 大师裁决）：近2个完整财年累计分红 ÷ 对应2年EPS（排除未完成年；同财年多笔派息 EPS 取全年最大值，防中期/末期重复计）
      const todayY0 = parseInt(DL.todayStr().slice(0, 4), 10);
      const byRep = {};
      divs.forEach(d => {
        if (d.pending || !d.report || !d.ex) return;
        const y = parseInt(d.report.slice(0, 4), 10);
        if (!y || y >= todayY0) return;
        if (!byRep[y]) byRep[y] = { dps: 0, eps: 0 };
        byRep[y].dps += d.dps || 0;
        byRep[y].eps = Math.max(byRep[y].eps, d.eps || 0);
      });
      const repYs = Object.keys(byRep).sort((a, b) => b - a).slice(0, 2);
      const cover = repYs.length === 2 && byRep[repYs[0]].eps > 0 && byRep[repYs[1]].eps > 0
        ? (byRep[repYs[0]].dps + byRep[repYs[1]].dps) / (byRep[repYs[0]].eps + byRep[repYs[1]].eps) : null;
      // 最大回撤（近5年）
      const dates = Object.keys(kline).sort();
      let maxDD = 0, peak = -Infinity;
      dates.forEach(d => { const p = kline[d]; if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > maxDD) maxDD = dd; });
      // 年化（5年）
      const startPrice = dates.length ? kline[dates[0]] : null;
      const yearsSpan = dates.length ? (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (365 * 86400000) : 0;
      const cagr = (startPrice && lastPrice && yearsSpan > 0) ? Math.pow(lastPrice / startPrice, 1 / yearsSpan) - 1 : null;
      $('#diagStats').innerHTML = `<div class="stats">
        <div class="stat"><div class="k">当前股息率(年化)</div><div class="v gold">${divYield != null ? divYield.toFixed(2) + '%' : '—'}</div></div>
        <div class="stat"><div class="k">每股分红(年化${yieldLabel})</div><div class="v">${fmt(dps, 3)} 元</div></div>
        <div class="stat"><div class="k">分红率(近2财年)</div><div class="v">${cover != null ? (cover * 100).toFixed(0) + '%' : '—'}</div></div>
        <div class="stat"><div class="k">近${diagYears}年年化</div><div class="v ${cagr >= 0 ? 'green' : 'red'}">${cagr != null ? fmtPct(cagr) : '—'}</div></div>
        <div class="stat"><div class="k">近${diagYears}年最大回撤</div><div class="v red">${fmtPct(-maxDD)}</div></div>
        <div class="stat"><div class="k">PE / PB</div><div class="v">${s.pe != null ? fmt(s.pe, 1) : '—'} / ${s.pb != null ? fmt(s.pb, 2) : '—'}</div></div>
      </div>`;
      // M5+M7（阶段3）：分红预测三情景区间卡（divForecast 引擎）——卡面单点→区间
      try {
        const fc = DL.divForecast(divs, kline[dates[dates.length - 1]]);
        const fcEl = $('#diagStats');
        if (fc) {
          const seg = fc.note ? `<div class="hint" style="font-size:10px;margin-top:3px">${fc.note}</div>` : '';
          fcEl.insertAdjacentHTML('beforeend', `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:rgba(0,0,0,.15)">
            <div style="font-size:11px;color:var(--sub);margin-bottom:4px">🔮 分红预测三情景（${fc.years.n} 年数据，至 ${fc.years.last} 年度）<span style="font-size:9px">M5引擎</span></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <div style="flex:1;min-width:90px;padding:5px 7px;border-radius:6px;background:rgba(224,90,90,.12)"><div style="font-size:10px;color:#e06666">保守（10年周期均）</div><div style="font-size:12px;font-weight:700;color:#e06666">${fc.text.conservative}</div></div>
              <div style="flex:1;min-width:90px;padding:5px 7px;border-radius:6px;background:rgba(224,160,48,.12)"><div style="font-size:10px;color:#e0a030">中性（7年周期均）</div><div style="font-size:12px;font-weight:700;color:#e0a030">${fc.text.base}</div></div>
              <div style="flex:1;min-width:90px;padding:5px 7px;border-radius:6px;background:rgba(76,175,125,.12)"><div style="font-size:10px;color:#4caf7d">乐观（最近年度）</div><div style="font-size:12px;font-weight:700;color:#4caf7d">${fc.text.optimistic}</div></div>
            </div>
            ${seg}
            <div class="hint" style="font-size:9px;margin-top:4px">最不确定变量：分红率政策（制度承诺 vs 管理层意愿）与盈利周期——见报告卡财报证据行</div>
          </div>`);
        }
      } catch (e) {}
      // 带状图：历史股息率分位（滚动口径：每年用当年分红）
      renderYieldBand(divs, kline, diagYears);
      // v1.9.0：建仓区状态卡 + 分位信号线（滚动分位，窗口 G_WINDOW） + 分红增长趋势
      renderZoneAndSignal(divs, kline);
      renderDivTrend(divs);
      renderStrategy(divs, kline);
      // v1.9.1 P7：卖出信号卡（EPS 趋势 + 分红连续性 + 估值放大器）
      renderSellSignals(divs, kline, code);
      // v1.9.3：档位画像卡
      renderTierProfile(code);
      // O1/O2：报告卡（F10 自动数据优先，研究静态数据兜底）
      const rc = $('#diagReportCard');
      if (rc) {
        rc.style.display = '';
        let extra = null;
        try {
          const sec = DL.guessSec(code);
          const f10 = await DL.fetchF10Annual(sec && sec.secuCode ? sec.secuCode : code);
          if (f10) {
            const staticX = window.REPORT_CARD_EXTRA && window.REPORT_CARD_EXTRA[code];
            extra = {
              industry: DL.industryOf(f10.csrcIndustry || f10.orgType) || (staticX && staticX.industry) || null,
              roe: f10.roe,
              roeTrend: (staticX && staticX.roeTrend) || 0,
              netProfit: f10.netProfit,
              netProfitYoY: f10.netProfitYoY,
              reserve: f10.mgwfplr,
              period: f10.reportDate,
              source: '东财F10 ' + (f10.cached ? '缓存(' + f10.cachedAt + ')' : '实时'),
              /* v1.9.17 财报证据层（宇通教训）：扣非/覆盖率/ROE退化/毛利率/负债率——L2数据源，进证据行不进决策 */
              deductNetProfit: f10.deductNetProfit,
              deductYoY: f10.deductYoY,
              roeDownYears: f10.roeDownYears,
              grossMargin: f10.grossMargin,
              netMargin: f10.netMargin,
              ocf: f10.ocf,
              ocfPerShare: f10.ocfPerShare,
              totalShare: f10.totalShare,
              liabilityRatio: f10.liabilityRatio,
            };
          }
        } catch (e) { /* F10 失败→静态兜底 */ }
        if (!extra && window.REPORT_CARD_EXTRA && window.REPORT_CARD_EXTRA[code]) {
          extra = Object.assign({ source: '研究数据 2026-08-18' }, window.REPORT_CARD_EXTRA[code]);
        }
        if (extra) renderReportCard(code, divs, kline, extra);
        // M2（阶段3）：风险提示版体检卡（事实层/假设层三情景/结论层）——在报告卡后（extra 可用）
        renderRiskCheck(code, divs, kline, extra);
      }
      // v1.9.6：决策摘要区（买入结论行+关键三数）
      renderDecisionSummary(code, divs, kline);
      // 分红节奏
      renderRhythm(divs);
      // v1.8.13 功能D：多起点敏感度（1/3/5/10年前买入对比）
      renderMultiStart(code, divs);
      // v1.8.13 BUG-1：btnDiagBacktest 绑定统一在 DOMContentLoaded（此处整体覆盖 onclick 会丢失 switchTab，曾致"点了不跳转"）
    } catch (e) {
      $('#diagStats').innerHTML = `<div class="hint err">诊断失败：${e.message}</div>`;
    }
  }

  /* 股息率带状图（C4：逐年滚动——每年用当年到账分红÷当日价，避免"2024年图用2026年分红"失真） */
  let _yieldChart = null;
  function renderYieldBand(divs, kline, years) {
    const el = $('#diagYieldChart');
    if (!el || typeof echarts === 'undefined') return;
    if (_yieldChart) { _yieldChart.dispose(); _yieldChart = null; }   // 防重复 init（多次诊断同一只）
    const chart = _yieldChart = echarts.init(el);
    const dates = Object.keys(kline).sort();
    if (!dates.length || !divs.length) { chart.dispose(); el.innerHTML = '<div class="hint">数据不足</div>'; return; }
    /* v1.9.16 修复（主人抓"图2股息率不对"）：曲线与标注口径统一=TTM 滚动（每点=该日往前366天到账分红÷当日价）
     * 旧版曲线用"自然年到账"（2026年到账2.0→6.70%）、标注却用TTM（2.5→8.38%）→ 同图自相矛盾；
     * 且"自然年到账"在年初无分红到账时曲线断档、年末集中跳变。TTM 滚动=平滑+与分位信号线同源 */
    const data = [];
    for (const d of dates) {
      const t = DL.ttmDivsAt(divs, d);
      if (t > 0) data.push({ d, y: t / kline[d] * 100 });
    }
    if (!data.length) { chart.dispose(); el.innerHTML = '<div class="hint">暂无分红数据</div>'; return; }
    const vals = data.map(x => x.y).sort((a, b) => a - b);
    const pct = p => vals.length ? vals[Math.floor(p * (vals.length - 1))] : null;
    const q25 = pct(0.25), q75 = pct(0.75);
    const lastDate = dates[dates.length - 1];
    let curTtm = null;
    try { const t = DL.ttmDivsAt(divs, lastDate); if (t > 0) curTtm = t / kline[lastDate] * 100; } catch (e) { }
    const cur = curTtm != null ? curTtm : (data.length ? data[data.length - 1].y : null);
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 12 }, formatter: p => { const x = data[p[0].dataIndex]; return `<b>${x.d}</b><br/>股息率 <b>${x.y.toFixed(2)}%</b>`; } },
      grid: { left: 46, right: 14, top: 20, bottom: 24 },
      xAxis: { type: 'category', data: data.map(x => x.d), axisLine: { lineStyle: { color: '#3a4f46' } }, axisLabel: { color: '#8fa69c', fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '%' }, splitLine: { lineStyle: { color: '#22322c' } } },
      series: [
        { name: '股息率', type: 'line', showSymbol: false, data: data.map(x => +x.y.toFixed(3)), lineStyle: { width: 1.5, color: '#d9a441' }, areaStyle: { color: 'rgba(217,164,65,.15)' } },
        { name: '25%分位', type: 'line', showSymbol: false, data: data.map(() => +q25.toFixed(3)), lineStyle: { type: 'dashed', width: 1, color: '#5aa9e6' } },
        { name: '75%分位', type: 'line', showSymbol: false, data: data.map(() => +q75.toFixed(3)), lineStyle: { type: 'dashed', width: 1, color: '#5aa9e6' } },
      ],
    });
    const note = $('#diagYieldNote');
    if (note) {
      // v1.8.13 功能A：当前股息率的历史分位结论值（窗口=所选年数，不裸报）
      const curPct = (cur != null && vals.length) ? (vals.filter(v => v <= cur).length / vals.length * 100) : null;
      note.textContent = `当前股息率 ${cur != null ? cur.toFixed(2) : '—'}% · 近 ${years||5} 年 ${curPct != null ? curPct.toFixed(0) : '—'}% 分位（25%~75%：${q25 != null ? q25.toFixed(2) : '—'}%~${q75 != null ? q75.toFixed(2) : '—'}%）· 本图=TTM滚动口径（每点=该日前366天到账分红÷价，与顶部信号线同源）；年化近2财年=${(() => { try { const ad = DL.calcAnnualDivYield(divs, kline[dates[dates.length-1]]); return ad ? ad.yieldPct.toFixed(2) + '%' : '—'; } catch (e) { return '—'; } })()}`;
    }
  }

  /* ===== v1.9.0：建仓区状态卡（J 方案）+ 分位信号线（滚动分位）+ 分红趋势 ===== */
  let _signalChart = null;
  function renderZoneAndSignal(divs, kline) {
    // v1.9.1 模式全局单例（localStorage 记忆）
    let mode = localStorage.getItem('divtool_zone_mode') || 'conservative';
    if (mode !== 'flexible' && mode !== 'conservative') mode = 'conservative';
    const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
    const last = series.filter(x => x.pct != null).pop();
    // 生态类型 + 起建线
    const eco = DL.calcEcoType(kline, series);
    // v1.9.3 R16：起建线按类型差异化（边界型可切 85，默认 80）
    const tcls = DL.classifyTier(diagCode);
    let ecoStart = eco.ecoStart;
    let neutral85 = false;
    if (tcls.cls === 'neutral') {
      try { neutral85 = localStorage.getItem('divtool_neutral85') === '1'; } catch (e) {}
      if (neutral85) ecoStart = 85;
    }
    const ecoName = { low: '低波动', mid: '中波动', high: '高波动', declining: '阴跌' }[eco.type] || '中波动';
    const zel = $('#diagZone');
    if (zel) {
      if (!last) {
        zel.innerHTML = '<div class="hint">数据不足（需≥250个交易日）</div>';
      } else {
        // 只进不退：position 记忆（已触发的最高档位比例）
        const posKey = 'divtool_pos_' + diagCode + '_' + mode;
        let histPos = parseFloat(localStorage.getItem(posKey) || '0') || 0;
        const z = DL.computeZone(last.pct, { mode, ecoStart });
        if (z.currentTier && z.currentTier.pos > histPos) { histPos = z.currentTier.pos; try { localStorage.setItem(posKey, String(histPos)); } catch (e) {} }
        const zoneColor = { start: '#d9a441', add: '#5aa9e6', full: '#4caf7d', extreme: '#2e8b57', watch: '#8fa69c', wait: '#8fa69c', nodata: '#8fa69c' }[z.zone] || '#8fa69c';  /* v1.9.15 情绪反色：极值区=估值低位（绿系） */
        const bar = Math.min(100, Math.max(0, last.pct));
        // 阈值刻度（随模式+生态）
        const tiers = [];
        if (mode === 'flexible') { for (let t = eco.ecoStart; t < 95; t += 10) tiers.push(t); tiers.push(95); }
        else { for (let t = eco.ecoStart; t < 95; t += 5) tiers.push(t); tiers.push(95); }
        const tierLabels = tiers.map(t => t + (t === tiers[0] ? '建' : (t === tiers[tiers.length - 1] ? '满' : '加')));
        // 第二维度：滚动股息率（同口径）+ CAGR 状态词
        const rollingDy = last ? last.dy : null;
        const cagr = DL.calcDivCAGR(divs, 3);
        const cagrWord = cagr == null ? '—' : (cagr >= 0.05 ? '增长中' : (cagr > 0 ? '停增' : '缩水'));
        const cagrColor = cagr == null ? '' : (cagr >= 0.05 ? 'green' : (cagr > 0 ? '' : 'red'));
        // 只进不退显示逻辑：历史已触发 > 当前档 → 显示“已建 X% 保留，距下一档差 N”
        let posTxt = z.action;
        if (histPos > 0 && (!z.currentTier || z.currentTier.pos < histPos)) {
          const nextT = z.nextTier || tiers.find(t => t > last.pct);
          posTxt = '已建 ' + histPos + '% 仓位（只进不退，回落保留），距下一档（' + (nextT || 95) + ' 分位）差 ' + ((nextT || 95) - last.pct).toFixed(0);
        }
        const rangeWord = last.pct < 25 ? '低位区' : (last.pct < 50 ? '中低位' : (last.pct < 75 ? '中高位' : (last.pct < 90 ? '高位区' : '极值区')));
        // v1.9.3：五态分类 + 分红趋势 + 窗口双值（敏感度弱化为信息展示）
        const tcls = DL.classifyTier(diagCode);
        const trend = DL.calcDivTrend(divs);
        const series500 = DL.calcRollingPercentile(kline, divs, 500);
        const last500 = series500.filter(x => x.pct != null).pop();
        const winGap = last && last500 ? Math.abs(last.pct - last500.pct) : null;
        const tclsHtml = tcls.cls !== 'direct'
          ? `<div style="margin-top:6px;padding:6px 10px;border-radius:8px;background:${tcls.cls === 'trap' ? 'rgba(224,90,90,.14)' : tcls.cls === 'dull' ? 'rgba(217,164,91,.12)' : 'rgba(58,167,109,.10)'};border:1px solid ${tcls.cls === 'trap' ? 'rgba(224,90,90,.45)' : tcls.cls === 'dull' ? 'rgba(217,164,91,.4)' : 'rgba(58,167,109,.35)'}"><b style="color:${tcls.color}">${tcls.label}</b> <span style="font-size:11px;color:var(--sub)">${tcls.detail}</span></div>`
          : '';
        // v1.9.3 R16：可等90型触发时的权衡提示（等多久/差多少/踏空多大 → 主人自决）
        const wait90Hint = tcls.cls === 'wait90' && tcls.profile && (z.zone === 'start' || z.zone === 'add' || z.zone === 'full' || z.zone === 'extreme')
          ? `<div style="margin-top:6px;padding:6px 10px;border-radius:8px;background:rgba(90,169,230,.10);border:1px solid rgba(90,169,230,.35)">🤔 <b>等不等 90？</b> <span style="font-size:11px;color:var(--sub)">该股历史等 90 档平均 ${(tcls.profile.gap90 / 30.4).toFixed(0)} 个月、90 档比 80 档 5 年多赚 <b>+${tcls.profile.diff.toFixed(0)}pp</b>（年化 ${tcls.profile.annual.toFixed(0)}pp/年）；但等待期间价格最大曾涨 <b>144%</b>（踏空风险）——<b>建议 80 档买入</b>；愿承担踏空风险可手动等 90 档</span></div>`
          : '';
        // v1.9.3 R16：陷阱型触发时补“持有后退出”动作
        const trapHoldHint = tcls.cls === 'trap' && (z.zone === 'start' || z.zone === 'add' || z.zone === 'full' || z.zone === 'extreme')
          ? `<div style="margin-top:6px;padding:6px 10px;border-radius:8px;background:rgba(224,90,90,.10);border:1px solid rgba(224,90,90,.3)"><span style="font-size:11px;color:var(--sub)">⚠️ 若已持有：关注分红是否连续 2 年下降（报告期归组）——恶化则触发退出信号（见下方卖出信号卡）；买入前建议回避/小仓</span></div>`
          : '';
        // v1.9.3 R16：边界型 85 起建切换
        const neutralSwitch = tcls.cls === 'neutral'
          ? `<div style="display:flex;gap:6px;align-items:center;margin-top:6px"><button type="button" class="mode-chip ${neutral85 ? 'on' : ''}" data-neutral85="1">🔀 85 起建（边界型，数据支持有限）</button><span style="font-size:10px;color:var(--muted)">默认 80（6 只样本，85 优势靠格力/海尔个案，大师 R16 挂起）</span></div>`
          : '';
        const trendHtml = trend && trend.degraded && tcls.cls !== 'trap'
          ? `<div style="margin-top:6px;padding:6px 10px;border-radius:8px;background:rgba(224,90,90,.14);border:1px solid rgba(224,90,90,.45)"><b style="color:#e05a5a">⚠️ 分红连续 ${trend.decStreak} 年下降</b> <span style="font-size:11px;color:var(--sub)">（报告期归组，近3年 ${trend.last3 != null ? trend.last3.toFixed(0) + '%' : '—'}）——分位信号降权，建议回避/小仓</span></div>`
          : '';
        const winGapHtml = winGap != null
          ? `<span class="hint">窗口敏感度：W375=<b>${last.pct.toFixed(0)}%</b> · W500=${last500.pct.toFixed(0)}%${winGap > 15 ? ' · ⚠️跨窗口差异大，结论参考性降低' : ''}</span>`
          : '';
        // v1.9.15：估值联动行（图1口径交叉引用·大师M4）+ 主信号徽章 + 窗口敏感（大师P3）
        const estSpot = DL.tierSpot(rollingDy, null, diagCode);
        const estWord = estSpot && !estSpot.pending ? (estSpot.cur === 'heavy' ? '深度低估' : estSpot.cur === 'add' ? '低估二档' : estSpot.cur === 'small' ? '低估一档' : '等待') : null;
        const estLink = estSpot && estWord
          ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">估值档（溢价分位·近3年·图1口径）：<b style="color:${estSpot.cur === 'heavy' ? '#2e8b57' : 'var(--txt)'}">${estWord}</b>${estSpot.cur === 'heavy' ? '（深度低估=历史高溢价区，本卡按 95 满档执行）' : estSpot.cur === 'add' ? '（低估二档，加仓节奏参考）' : estSpot.cur === 'small' ? '（低估一档，建仓起点）' : ''}</div>`
          : '';
        const winSens = last.pct >= 93 && last.pct <= 97 ? ` · <span style="color:#d9a45b">⚠️窗口敏感·跨档边缘</span>` : '';
        /* v1.9.16 主人令"做个5年10年"：长期复投视角入建仓区状态卡（旧版只在报告卡，主人看的这张没有） */
        const longView = calcLongTermView(series, kline, divs, rollingDy);
        const longHtml = longView && (longView[1250] || longView[2500])
          ? `<div style="font-size:10px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">📈 长期复投视角（当前股息率档·历史表现）：5年 ${longView[1250] ? longView[1250].winP.toFixed(0) + '%胜率·均值' + (longView[1250].avg >= 0 ? '+' : '') + longView[1250].avg.toFixed(1) + '%（n=' + longView[1250].n + '）' : '样本不足'} · 10年 ${longView[2500] ? longView[2500].winP.toFixed(0) + '%·' + (longView[2500].avg >= 0 ? '+' : '') + longView[2500].avg.toFixed(1) + '%（n=' + longView[2500].n + '）' : '样本不足'}（含分红·不复投·复投更高）</div>`
          : '';
        zel.innerHTML = `<div class="zone-row">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="font-weight:600;color:${zoneColor}">${z.label}</span>
            <span>当前 <b>${last.pct.toFixed(0)}%</b> 分位（${rangeWord}）${winSens}<span style="font-size:9px;color:var(--sub);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-left:4px">自身分位·近375日·主信号</span></span>
          </div>
          ${longHtml}
          ${estLink}
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <button type="button" class="mode-chip ${mode === 'conservative' ? 'on' : ''}" data-mode="conservative">🛡 保守（${eco.ecoStart} 起）</button>
            <button type="button" class="mode-chip ${mode === 'flexible' ? 'on' : ''}" data-mode="flexible">🔶 柔性（更早参与）</button>
            <span style="font-size:10px;color:var(--muted);align-self:center">生态：${ecoName}（起建线 ${eco.ecoStart} 分位）</span>
          </div>
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <span style="font-size:10px;color:var(--muted);align-self:center">窗口：</span>
            ${[250, 375, 500].map(w => `<button type="button" class="mode-chip ${(window.G_WINDOW || 375) === w ? 'on' : ''}" data-win="${w}">${w}日${w === 375 ? '·默认' : w === 250 ? '·灵敏' : '·极简'}</button>`).join('')}
          </div>
          <div style="height:10px;background:var(--card2);border-radius:5px;overflow:hidden;position:relative">
            <div style="position:absolute;left:0;top:0;bottom:0;width:${bar}%;background:${zoneColor};border-radius:5px"></div>
            ${tiers.map(t => `<div style="position:absolute;left:${t}%;top:-3px;bottom:-3px;width:1px;background:rgba(255,255,255,.35)" title="${t}分位"></div>`).join('')}
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:3px">
            <span>0</span>${tiers.map((t, i) => `<span>${t}${tierLabels[i] ? '·' + tierLabels[i].replace(t, '') : ''}</span>`).join('')}<span>100</span>
          </div>
          <div class="hint" style="margin-top:6px">${posTxt}${z.zone === 'extreme' ? '（历史 95+ 分位 3 年胜率 97/133，分红未复投，非买入即涨，浮亏均值 -22.9%±）' : ''}</div>
          <div class="hint" style="margin-top:2px">滚动股息率 <b>${rollingDy != null ? rollingDy.toFixed(2) + '%' : '—'}</b>（与分位同窗口）· 分红 CAGR <b class="${cagrColor}">${cagr != null ? (cagr * 100).toFixed(1) + '%' : '—'}</b>（${cagrWord}）${winGapHtml ? ' · ' + winGapHtml : ''}</div>
          ${tclsHtml}${trendHtml}${wait90Hint}${trapHoldHint}${neutralSwitch}
        </div>`;
        // 模式/窗口/边界85切换绑定
        zel.querySelectorAll('.mode-chip').forEach(b => b.onclick = () => {
          if (b.dataset.win) { window.setDivWindowDays(parseInt(b.dataset.win, 10)); renderZoneAndSignal(divs, kline); return; }
          if (b.dataset.neutral85) {
            try { localStorage.setItem('divtool_neutral85', b.dataset.neutral85 === '1' ? (neutral85 ? '0' : '1') : '0'); } catch (e) {}
            renderZoneAndSignal(divs, kline); return;
          }
          localStorage.setItem('divtool_zone_mode', b.dataset.mode);
          renderZoneAndSignal(divs, kline);
        });
      }
    }
    // 信号线图（阈值虚线随模式+生态）
    const el = $('#diagSignalChart');
    if (el && typeof echarts !== 'undefined') {
      if (_signalChart) { _signalChart.dispose(); _signalChart = null; }
      const valid = series.filter(x => x.pct != null);
      if (valid.length < 30) {
        el.innerHTML = '<div class="hint">数据不足</div>';
      } else {
        const chart = _signalChart = echarts.init(el);
        const tiers2 = [];
        if (mode === 'flexible') { for (let t = eco.ecoStart; t < 95; t += 10) tiers2.push(t); tiers2.push(95); }
        else { for (let t = eco.ecoStart; t < 95; t += 5) tiers2.push(t); tiers2.push(95); }
        const markAreas = tiers2.slice(0, -1).map((t, i) => [{ yAxis: t, itemStyle: { color: 'rgba(217,164,65,.10)' } }, { yAxis: tiers2[i + 1] }]);
        chart.setOption({
          backgroundColor: 'transparent',
          tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 12 }, formatter: p => { const x = valid[p[0].dataIndex]; return `<b>${x.d}</b><br/>分位 <b>${x.pct.toFixed(0)}%</b> · 股息率 <b>${x.dy.toFixed(2)}%</b>（滚动 366 天 TTM）`; } },
          grid: { left: 44, right: 14, top: 24, bottom: 26 },
          xAxis: { type: 'category', data: valid.map(x => x.d), axisLine: { lineStyle: { color: '#3a4f46' } }, axisLabel: { color: '#8fa69c', fontSize: 10 } },
          yAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '%' }, splitLine: { lineStyle: { color: '#22322c' } } },
          series: [{
            name: '滚动分位', type: 'line', showSymbol: false, data: valid.map(x => +x.pct.toFixed(1)),
            lineStyle: { width: 1.5, color: '#d9a441' }, areaStyle: { color: 'rgba(217,164,65,.12)' },
            markLine: {
              silent: true, symbol: 'none',
              data: tiers2.map(v => ({ yAxis: v, lineStyle: { type: 'dashed', width: 1, color: 'rgba(255,255,255,.4)' }, label: { formatter: v + '分位', color: '#8fa69c', fontSize: 10, position: 'insideEndTop' } })),
            },
            markArea: { silent: true, data: markAreas },
          }],
        });
        const sn = $('#diagSignalNote');
        // Q3（M40）：数据截止标注——分红/EPS 数据最新报告期
        const lastRep = divs.filter(d => d.report).map(d => d.report).sort().pop() || '';
        const cutoffTxt = lastRep ? '数据截止 ' + lastRep.slice(0, 7) : '';
        if (sn) sn.textContent = '口径：滚动分位（无未来函数，窗口 ' + (window.G_WINDOW||375) + ' 日）；' + (mode === 'flexible' ? '柔性档 ' : '保守档 ') + tiers2.map(t => t + ' 分位').join(' / ') + '；只进不退（触发档位保留）。历史 90+ 分位买点 3 年胜率 68%（487/713，分红未复投），浮亏均值 -23.9%±。' + (cutoffTxt ? '；' + cutoffTxt : '');
      }
    }
  }

  /* 分红增长趋势（报告期归组柱状图 + CAGR + 停增/下调标红） */
  function renderDivTrend(divs) {
    const el = $('#diagDivTrend');
    if (!el) return;
    const byYear = {};
    divs.forEach(d => { if (d.pending || !d.ex || !(d.dps > 0)) return; const y = (d.report || d.ex).slice(0, 4); byYear[y] = (byYear[y] || 0) + d.dps; });
    const years = Object.keys(byYear).filter(y => byYear[y] > 0).sort();
    if (years.length < 2) { el.innerHTML = '<div class="hint">暂无分红记录</div>'; return; }
    const last5 = years.slice(-6);
    const cagr = DL.calcDivCAGR(divs, 3);
    // v1.9.0 入池三档（CAGR ≥5% 推荐 / 0-5% 观察 / ≤0 剔除；基数检查防好想你假象）
    const grade = cagr == null ? null : (cagr >= 0.05 ? { tag: '✅ 推荐', cls: 'green' } : (cagr > 0 ? { tag: '👀 观察', cls: '' } : { tag: '❌ 剔除', cls: 'red' }));
    let html = `<div class="hint">分红 CAGR（近3年，报告期归组）：${cagr != null ? '<b class="' + (cagr >= 0.05 ? 'green' : (cagr > 0 ? '' : 'red')) + '">' + (cagr * 100).toFixed(1) + '%/年</b>' : '数据不足'}`;
    if (grade) html += ` · 入池评级 <b class="${grade.cls}">${grade.tag}</b>`;
    if (cagr == null && years.length >= 4) html += '（基数过低或数据不足，防假象不计）';
    // 同比检测（近6年）
    const yoy = [];
    for (let i = 1; i < last5.length; i++) {
      const prev = byYear[last5[i-1]], cur = byYear[last5[i]];
      yoy.push({ y: last5[i], pct: prev > 0 ? (cur - prev) / prev * 100 : null });
    }
    const stops = yoy.filter(v => v.pct != null && v.pct <= 0);
    // v1.9.1 修复：连续检测必须相邻两年（旧实现非连续累计误报——招行 2008/2013 各降一次被判“连续4年”）
    // Q2（M29）：连续 2 年恶化=严格递减（pct<0 不含持平），防单年波动误触发
    const consec = [];
    for (let i = 1; i < yoy.length; i++) { if (yoy[i].pct != null && yoy[i].pct < 0 && yoy[i - 1].pct != null && yoy[i - 1].pct < 0) consec.push(yoy[i]); }
    if (consec.length > 0) html += '<span class="red"> ⚠️ 分红连续 2 年下调（' + consec.slice(-1).map(s => s.y + ' ' + s.pct.toFixed(1) + '%').join('、') + '）→ 降级观察（基本面卖出信号第1级）</span>';
    else if (stops.length === 1) html += '<span style="color:#e0a030"> ⚠️ ' + stops[0].y + ' 分红' + (stops[0].pct < 0 ? '下调' : '停增') + ' ' + stops[0].pct.toFixed(1) + '%（第1年关注，连续2年触发降级观察）</span>';
    html += '</div><table style="width:100%;font-size:12px;margin-top:6px;border-collapse:collapse"><tr style="color:var(--muted)"><th style="text-align:left;padding:3px">报告期</th><th>每股分红</th><th>同比</th><th>趋势</th></tr>';
    last5.forEach((y, i) => {
      const v = byYear[y];
      const yv = i > 0 ? yoy[i-1] : null;
      const cls = yv && yv.pct != null && yv.pct <= 0 ? 'red' : (yv && yv.pct != null && yv.pct > 0 ? 'green' : '');
      const arrow = yv && yv.pct != null ? (yv.pct > 0 ? '▲' : (yv.pct < 0 ? '▼' : '—')) : '';
      html += `<tr><td style="padding:3px">${y}</td><td style="text-align:center">${v.toFixed(3)} 元</td><td style="text-align:center" class="${cls}">${yv ? arrow + ' ' + (yv.pct != null ? yv.pct.toFixed(1) + '%' : '—') : '—'}</td><td style="text-align:center">${yv ? '<span style="color:' + (yv.pct > 0 ? '#4caf7d' : (yv.pct < 0 ? '#e05a5a' : '#8fa69c')) + '">' + (yv.pct > 0 ? '增长' : (yv.pct < 0 ? '下调' : '持平')) + '</span>' : '—'}</td></tr>`;
    });
    html += '</table><div class="hint" style="margin-top:4px">口径：报告期归组（含中期+末期）；连续2年停增/下调 → 降级观察（卖出第1级信号）</div>';
    el.innerHTML = html;
  }

  /* 策略对比表（三列：收益+浮亏+风险效率，默认风险效率排序+三行导读）
   * 近5年回测：闭眼全仓 / 金字塔分位(80/85/90) / 等90分位 / 等95分位 */
  function renderStrategy(divs, kline) {
    const el = $('#diagStrategy');
    if (!el) return;
    const dates = Object.keys(kline).sort();
    const startD = dates[0];
    const endD = dates[dates.length - 1];
    const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
    if (series.length < 60) { el.innerHTML = '<div class="hint">数据不足</div>'; return; }
    const priceOf = d => kline[d];
    const retOf = (buyD) => priceOf(endD) / priceOf(buyD) - 1;
    const mddOf = (buyD) => {
      let peak = -Infinity, mdd = 0;
      dates.forEach(d => { if (d < buyD) return; const p = kline[d]; if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > mdd) mdd = dd; });
      return mdd;
    };
    const strat = [];
    // A 闭眼全仓
    strat.push({ name: '闭眼全仓', ret: retOf(startD), mdd: mddOf(startD) });
    // B 金字塔分位 80/85/90 各1/3（无间隔/无超额）
    const p80 = series.find(x => x.pct != null && x.pct >= 80);
    const p85 = series.find(x => x.pct != null && x.pct >= 85);
    const p90 = series.find(x => x.pct != null && x.pct >= 90);
    if (p80) {
      const buys = [p80];
      if (p85) buys.push(p85);
      if (p90) buys.push(p90);
      const w = 1 / buys.length;
      let ret = 0, mdd = 0;
      buys.forEach(b => { ret += w * retOf(b.d); mdd += w * mddOf(b.d); });
      strat.push({ name: '金字塔 80/85/90', ret, mdd, note: '首档触发 ' + p80.d });
    }
    // C 等 90 分位全仓
    if (p90) {
      strat.push({ name: '等90分位全仓', ret: retOf(p90.d), mdd: mddOf(p90.d), note: '触发 ' + p90.d });
    }
    // D 等 95+ 全仓
    const p95 = series.find(x => x.pct != null && x.pct >= 95);
    if (p95) {
      strat.push({ name: '等95+全仓', ret: retOf(p95.d), mdd: mddOf(p95.d), note: '触发 ' + p95.d });
    }
    // 风险效率 = 收益/|浮亏|（收益为负=0.3以下标灰）
    strat.forEach(s => { s.riskEff = Math.abs(s.ret) / Math.max(0.0001, Math.abs(s.mdd)); });
    strat.sort((a, b) => b.riskEff - a.riskEff);   // 默认风险效率排序
    let html = '<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:4px"><tr style="color:var(--muted)"><th style="text-align:left;padding:4px">策略</th><th>收益</th><th>最大浮亏</th><th>风险效率</th></tr>';
    strat.forEach(s => {
      html += `<tr><td style="padding:4px">${s.name}${s.note ? '<div style="font-size:10px;color:var(--muted)">' + s.note + '</div>' : ''}</td>
        <td style="text-align:center" class="${s.ret >= 0 ? 'green' : 'red'}">${(s.ret * 100).toFixed(1)}%</td>
        <td style="text-align:center" class="red">${(s.mdd * 100).toFixed(1)}%</td>
        <td style="text-align:center"><b>${s.riskEff.toFixed(2)}</b></td></tr>`;
    });
    html += '</table>';
    el.innerHTML = html;
    const g = $('#diagStrategyGuide');
    if (g) g.innerHTML = '<span>① 收益最高≠最优：浮亏深度决定拿不拿得住；② 金字塔浮亏最浅，且 90 分位永不出现也能建仓；③ 风险效率=收益÷浮亏，1.9 以上=赚得多亏得少，1.0 以下=赚得少亏得多。</span>';
  }

  /* v1.9.1 P6+P7：卖出信号卡（EPS 趋势 + 分红连续性 + 估值放大器）
   * 基本面恶化：EPS 按报告期归组（每年最新），连续 2 年下滑 → 恶化
   * 分红连续 2 年停增/下调 → 降级观察（已有 renderDivTrend 逻辑复用）
   * 估值放大器：当前分位 ≤20（便宜）→ 卖出信号可信度低（提示谨慎）；≥80 → 可信度高 */
  function renderSellSignals(divs, kline, code) {
    const el = $('#diagSellSignals');
    if (!el) return;
    // 卖出信号回测（2026-08-18 P1，test/sell-signal-backtest.js，46 次触发）：行业有效性标注
    const SELL_EFFECT = {
      utility: { verdict: '有效', txt: '该行业分红连降≈真恶化（历史卖出后 1 年均 -8.7%、2 年 -13.9%）' },
      bank: { verdict: '有效/中性', txt: '该行业分红连降≈真问题（历史卖出≈中性偏优，2 年 -0.1%）' },
      consumer: { verdict: '踏空史', txt: '该行业分红连降多为波动假信号（历史卖出后 1 年均 +35%，卖出=踏空）' },
      energy: { verdict: '踏空史', txt: '该行业分红连降常为周期底假信号（历史卖出后 1 年均 +13.4%、2 年 +24.1%，随后反弹）' },
      insurer: { verdict: '样本不足', txt: '该行业触发样本仅 3 次，信号不可靠' },
    };
    const eff = (code && DL.TIER_LINE[code]) ? SELL_EFFECT[DL.TIER_LINE[code].ind] : null;
    // P0-C 修复（2026-08-18）：卖出信号限最近 5 个完整财年（滚动财年窗，窗口终点=最近完整财年）
    // 旧：遍历全部历史 → 长电 2019/2022 历史事件永久触发"建议退出或减仓"
    const SELL_WINDOW_YEARS = 5;
    const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
    // EPS 趋势（2026-08-18 修复，与 DL.sellSignalQuick 同源同步）：年报优先，中报仅兜底；无年报财年不参与
    const epsByYear = {}, epsAnnual = {};
    divs.forEach(d => {
      if (d.eps == null) return;
      const rep = d.report || ''; const y = rep.slice(0, 4);
      if (!y) return;
      const isAnnual = /-12-31$/.test(rep);
      if (isAnnual) { epsByYear[y] = d.eps; epsAnnual[y] = true; }
      else if (epsByYear[y] == null) epsByYear[y] = d.eps;
    });
    const years = Object.keys(epsByYear).sort();
    const epsTrend = [];
    for (let i = 1; i < years.length; i++) {
      const prev = epsByYear[years[i - 1]], cur = epsByYear[years[i]];
      if (prev != null && cur != null) epsTrend.push({ y: years[i], pct: (cur - prev) / prev * 100 });
    }
    // v1.9.1 修复：真正的“连续”检测（相邻两年都下滑才计数；旧实现非连续年份累计误报——招行 2008/2013 各降一次被判“连续4年”）
    // P0-C：EPS 同样限最近 5 个完整财年；2026-08-18：仅年报参与 + 收紧为最近两年连续为负（历史下滑已恢复的不算）
    const epsLastYear = years.length ? years[years.length - 1] : null;
    const epsWindowed = epsTrend.filter(t => epsLastYear != null && epsAnnual[t.y] && t.y >= epsLastYear - SELL_WINDOW_YEARS + 1);
    const epsConsec = [];
    const eW = epsWindowed;
    if (eW.length >= 2 && eW[eW.length - 1].pct < 0 && eW[eW.length - 2].pct < 0) epsConsec.push({ y: eW[eW.length - 1].y, p1: eW[eW.length - 2].pct, p2: eW[eW.length - 1].pct });
    const epsWorsened = epsConsec.length > 0;
    // 分红连续停增（同样相邻两年检测）
    const byYear = {};
    divs.forEach(d => { if (d.pending || !d.ex || !(d.dps > 0)) return; const y = (d.report || d.ex).slice(0, 4); byYear[y] = (byYear[y] || 0) + d.dps; });
    const ys = Object.keys(byYear).filter(y => byYear[y] > 0).sort();
    const yoy = [];
    for (let i = 1; i < ys.length; i++) { const prev = byYear[ys[i - 1]], cur = byYear[ys[i]]; yoy.push({ y: ys[i], pct: prev > 0 ? (cur - prev) / prev * 100 : null }); }
    const lastFullYear = ys.length ? ys[ys.length - 1] : null;
    const yoyWindowed = yoy.filter(t => lastFullYear != null && t.y >= lastFullYear - SELL_WINDOW_YEARS + 1);
    const divConsec = [];
    // Q2（M29）：连续 2 年恶化=严格递减（pct<0 不含持平）；2026-08-18 与 EPS 通道同步收紧：最近两年连续为负
    const dW = yoyWindowed;
    if (dW.length >= 2 && dW[dW.length - 1].pct != null && dW[dW.length - 1].pct < 0 && dW[dW.length - 2].pct != null && dW[dW.length - 2].pct < 0) divConsec.push({ y: dW[dW.length - 1].y, p1: dW[dW.length - 2].pct, p2: dW[dW.length - 1].pct });
    const divDegraded = divConsec.length > 0;
    // 估值放大器
    const last = series.filter(x => x.pct != null).pop();
    const curPct = last ? last.pct : null;
    const valAmp = curPct != null ? (curPct <= 20 ? 'low' : (curPct >= 80 ? 'high' : 'mid')) : 'mid';
    const ampTxt = { low: '当前估值低位（分位≤20%），基本面信号可能滞后，建议谨慎验证后再决策', mid: '当前估值中性', high: '当前估值高位（分位≥80%），基本面信号可信度较高' }[valAmp];
    // 组合判定
    const signals = [];
    // D1c（阶段4）：分红率政策变化监控——支付率（分红÷EPS）连2期降>10pp→提示收缩
    const payoutByYear = {};
    const dpsByYear = {};
    (divs || []).forEach(d => {
      if (d.pending || !(d.dps > 0) || !d.ex) return;
      const y = d.ex.slice(0, 4); dpsByYear[y] = (dpsByYear[y] || 0) + d.dps;
    });
    Object.keys(dpsByYear).forEach(y => {
      if (epsByYear[y] != null && epsByYear[y] > 0) payoutByYear[y] = dpsByYear[y] / epsByYear[y];
    });
    const pyKeys = Object.keys(payoutByYear).sort();
    if (pyKeys.length >= 3) {
      const p3 = pyKeys.slice(-3).map(y => payoutByYear[y]);
      if (p3[1] < p3[2] - 0.10 && p3[0] < p3[1] - 0.10) {
        signals.push({ t: `🟠 分红率连2期降>10pp（${pyKeys.slice(-3).map((y, i) => y + ' ' + (p3[i] * 100).toFixed(0) + '%').join('→')}）——派息政策收缩，关注可持续性` });
      }
    }
    if (divDegraded) signals.push({ t: '🔴 分红连续 2 年下调（' + divConsec.slice(-1).map(s => s.y + ' ' + s.p2.toFixed(1) + '%').join('、') + '）→ 降级观察' });
    else if (yoy.length >= 2 && yoy[yoy.length - 1].pct != null && yoy[yoy.length - 1].pct <= 0) signals.push({ t: '🟡 最近年度（' + yoy[yoy.length - 1].y + '）分红停增/下调 ' + yoy[yoy.length - 1].pct.toFixed(1) + '%，第 1 年关注' });
    else signals.push({ t: '🟢 分红近 ' + (yoy.length ? yoy.length : 0) + ' 年未见连续停增（最近 ' + (yoy.length ? yoy[yoy.length - 1].y : '—') + ' ' + (yoy.length && yoy[yoy.length - 1].pct != null ? (yoy[yoy.length - 1].pct > 0 ? '+' : '') + yoy[yoy.length - 1].pct.toFixed(1) + '%' : '—') + '）' });
    if (epsWorsened) signals.push({ t: '🔴 EPS 连续 2 年下滑（' + epsConsec.slice(-1).map(t => t.y + ' ' + t.p2.toFixed(1) + '%').join('、') + '）→ 基本面恶化' });
    else if (epsTrend.length >= 2 && epsTrend[epsTrend.length - 1].pct < 0) signals.push({ t: '🟡 最近年度 EPS 下滑（' + epsTrend[epsTrend.length - 1].pct.toFixed(1) + '%），关注' });
    else if (epsTrend.length >= 2) signals.push({ t: '🟢 EPS 近 ' + epsTrend.length + ' 年无连续下滑' });
    else signals.push({ t: '⚪ EPS 数据不足' });
    const exit = divDegraded && epsWorsened;
    const verdict = exit ? '<b class="red">⚠️ 建议退出或减仓</b>' : (divDegraded || epsWorsened) ? '<b style="color:#e0a030">⚠️ 降级观察</b>' : '<b class="green">✅ 无退出信号</b>';
    el.innerHTML = `<div style="margin-bottom:4px">${signals.map(s => `<div style="font-size:12px;margin:2px 0">${s.t}</div>`).join('')}</div>
      <div style="font-size:12px;margin:4px 0">判定：${verdict}</div>
      <div class="hint">估值放大器：${ampTxt}${exit ? '（基本面恶化 + 估值' + (valAmp === 'high' ? '高位 → 退出信号可信' : valAmp === 'low' ? '低位 → 建议二次确认' : '中性') + '）' : ''}</div>
      ${eff ? `<div style="font-size:10px;color:${eff.verdict.indexOf('踏空') >= 0 ? '#e06666' : eff.verdict === '有效' ? '#4caf7d' : 'var(--muted)'};margin-top:4px">🎯 该行业卖出信号历史有效性：<b>${eff.verdict}</b>——${eff.txt}</div>` : ''}
      ${exit ? '<div class="hint" style="margin-top:4px;color:#d9a45b">💡 释放资金去向：切到 <b>决策台</b> 查看顶部“建仓区提醒”横幅（当前建仓区标的 + 档位距离 + 分红陷阱/钝化标注），或自选持仓巡检卡对比健康标的</div>' : ''}
      <div class="hint">口径：EPS/分红按报告期归组；连续 2 年（相邻年度）恶化才触发退出，单年波动仅关注；<b>信号仅看最近 5 个完整财年（滚动窗口，历史事件不永久触发）</b>；卖出信号是纪律参考，非自动执行；<b>执行颗粒：部分卖出目标仓位向下取整到整手（100 股/手）</b>——<300 股建议"卖0或全卖"两选项</div>`;
  }

  /* v1.9.3：档位画像卡（诊断页）——五态分类 + 年化等待收益/间隔/收益差（研究固化数据） */
  /* M2（阶段3）：风险提示版体检卡——事实层触发器/假设层三情景表/结论层空白（主人拍板区）
   * 事实层：财报证据（扣非/OCF/毛利率/负债率/ROE退化/分红连续性/行业信号）——全部可回源，零猜测
   * 假设层：divForecast 三情景 DPS+股息率区间（保守/中性/乐观）
   * 结论层：空白——买/持/卖由主人定（不替主人拍板，8/18 原则）
   */
  function renderRiskCheck(code, divs, kline, extra) {
    const el = $('#diagRiskCheck');
    if (!el) return;
    const price = kline && kline.length ? kline[kline.length - 1].close : null;
    // 事实层：财报证据（extra=F10 数据）
    const facts = [];
    if (extra && extra.deductNetProfit != null && extra.netProfit != null && extra.netProfit > 0) {
      const npRatio = (extra.netProfit - extra.deductNetProfit) / extra.netProfit * 100;
      if (npRatio > 15) facts.push({ lv: 'warn', t: `非经常损益占归母 ${npRatio.toFixed(0)}%（理财/补助虚增嫌疑）` });
      else facts.push({ lv: 'ok', t: `利润含金量高（扣非/归母=${(extra.deductNetProfit / extra.netProfit * 100).toFixed(0)}%）` });
    }
    if (extra && extra.ocf != null && extra.netProfit != null && extra.netProfit > 0) {
      const cov = extra.ocf / extra.netProfit;
      facts.push({ lv: cov < 0.6 ? 'warn' : 'ok', t: `OCF/净利=${(cov * 100).toFixed(0)}%（${cov < 0.6 ? '现金流偏弱，分红靠家底' : '现金流健康'}）` });
    }
    if (extra && extra.roeDownYears != null && extra.roeDownYears >= 2) facts.push({ lv: 'warn', t: `ROE 连降${extra.roeDownYears}年（盈利能力退化）` });
    if (extra && extra.grossMargin != null && extra.grossMarginPrev != null && extra.grossMargin < extra.grossMarginPrev - 2) facts.push({ lv: 'warn', t: `毛利率下降 ${(extra.grossMarginPrev - extra.grossMargin).toFixed(1)}pp（${extra.grossMarginPrev.toFixed(1)}→${extra.grossMargin.toFixed(1)}%）` });
    if (extra && extra.liabilityRatio != null && extra.liabilityRatio > 70) facts.push({ lv: 'warn', t: `负债率 ${extra.liabilityRatio.toFixed(0)}%（>70%）` });
    // 事实层：分红连续性（divs 序列，报告期归组）
    const ys = {};
    (divs || []).forEach(d => { if (d.pending || !(d.dps > 0) || !d.ex) return; const y = d.ex.slice(0, 4); ys[y] = (ys[y] || 0) + d.dps; });
    const yKeys = Object.keys(ys).sort();
    if (yKeys.length >= 3) {
      const last3 = yKeys.slice(-3).map(y => ys[y]);
      if (last3[1] > last3[2] * 1.02 && last3[0] > last3[1] * 1.02) facts.push({ lv: 'ok', t: `分红连续 ${yKeys.length} 年递增（${yKeys.slice(-3).join('/')}）` });
      else if (last3[0] < last3[1] * 0.98 && last3[1] < last3[2] * 0.98) facts.push({ lv: 'warn', t: `分红连续 2 年下调（${yKeys.slice(-3).map((y, i) => y + '=' + last3[i]).join(' ') }）` });
      else facts.push({ lv: 'ok', t: `分红近 ${yKeys.length} 年稳定（最近 ${yKeys[yKeys.length - 1]}=${ys[yKeys[yKeys.length - 1]]} 元）` });
    } else if (yKeys.length) facts.push({ lv: 'info', t: `分红数据 ${yKeys.length} 年（<3年，成长股通道？）` });
    // 事实层：行业信号（trapFilter 同源信号——扣非转负/支付率过高）
    if (extra && extra.deductNetProfit != null && extra.deductNetProfit < 0) facts.push({ lv: 'red', t: '扣非转负（命门信号：强有效，触发降档/回避）' });
    // 假设层：三情景 DPS 区间
    const fc = price > 0 ? DL.divForecast(divs, price) : null;
    let assumeHtml = '<div class="hint" style="font-size:10px">数据不足，无假设区间</div>';
    if (fc) {
      const row = (label, v, color) => `<div style="flex:1;min-width:90px;padding:5px 7px;border-radius:6px;background:${color}"><div style="font-size:10px">${label}</div><div style="font-size:12px;font-weight:700">${v}</div></div>`;
      assumeHtml = `<div style="display:flex;gap:8px;flex-wrap:wrap">
        ${row('保守（10年周期均）', fc.text.conservative, 'rgba(224,90,90,.12)')}
        ${row('中性（7年周期均）', fc.text.base, 'rgba(224,160,48,.12)')}
        ${row('乐观（最近年度）', fc.text.optimistic, 'rgba(76,175,125,.12)')}
      </div>`;
    }
    const factsHtml = facts.length ? facts.map(f => `<div style="font-size:11px;margin:2px 0;color:${f.lv === 'red' ? '#e05a5a' : f.lv === 'warn' ? '#e0a030' : f.lv === 'ok' ? 'var(--fg)' : 'var(--sub)'}">${f.lv === 'red' ? '🔴' : f.lv === 'warn' ? '🟡' : f.lv === 'ok' ? '✅' : 'ℹ️'} ${f.t}</div>`).join('') : '<div class="hint" style="font-size:10px">事实层数据不足（不假装有）</div>';
    el.innerHTML = `<div style="font-size:13px;font-weight:700;margin-bottom:4px">🏥 财报体检卡 <span style="font-size:9px;font-weight:400;color:var(--sub)">（M2·事实层可回源/假设层三情景/结论层您拍板）</span></div>
      <div style="font-size:11px;color:var(--sub);margin:4px 0 2px">【事实层 · 触发器】</div>
      ${factsHtml}
      <div style="font-size:11px;color:var(--sub);margin:6px 0 2px">【假设层 · 三情景 DPS/股息率区间】（M5 引擎·${fc ? fc.years.n + ' 年数据至 ' + fc.years.last : '—'}）</div>
      ${assumeHtml}
      <div style="font-size:11px;color:var(--sub);margin:6px 0 2px">【结论层 · 主人拍板区】</div>
      <div style="font-size:11px;padding:6px 8px;border:1px dashed var(--line);border-radius:6px;color:var(--muted)">买 / 持 / 卖 —— 由主人依据上两层事实决定（工具不替您拍板）</div>`;
  }

  function renderTierProfile(code) {
    const el = $('#diagTierProfile');
    if (!el) return;    const tcls = DL.classifyTier(code);
    const p = tcls.profile;
    const known = p != null;
    let html = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><b style="color:${tcls.color}">${tcls.label}</b><span style="font-size:11px;color:var(--sub)">${tcls.detail}</span></div>`;
    if (known) {
      html += `<table class="tbl" style="margin-top:6px"><tr><th>指标</th><th>数值</th><th>含义</th></tr>
        <tr><td>年化等待收益</td><td><b>${p.annual.toFixed(1)} pp/年</b></td><td>等 90 档每年多赚的收益（>20 值得等 / <10 直接买）<span style="color:var(--muted)">· 均值口径非线性，直觉参考</span></td></tr>
        <tr><td>90 档平均间隔</td><td>${p.gap90} 天（约 ${(p.gap90 / 30.4).toFixed(0)} 个月）</td><td>等 90 档的历史等待成本</td></tr>
        <tr><td>90 vs 80 收益差</td><td>${p.diff >= 0 ? '+' : ''}${p.diff.toFixed(1)} pp</td><td>90 档买入比 80 档 5 年收益高出的百分点</td></tr>
      </table>`;
      html += `<div class="hint" style="margin-top:6px">建议：${tcls.cls === 'wait90' ? '触发 80 档时可选择等待 90 档（平均 ' + (p.gap90 / 30.4).toFixed(0) + ' 个月），年化多赚 ' + p.annual.toFixed(1) + 'pp；若等不起可在 80 档分批建仓' : tcls.cls === 'neutral' ? '80/90 档收益差适中（年化 ' + p.annual.toFixed(1) + 'pp）——按自身风险偏好：等得起就等 90，等不起 80 档直接建' : tcls.cls === 'direct' ? '等 90 档年化收益仅 ' + p.annual.toFixed(1) + 'pp（或 90 档收益反而差）——80 档直接建仓，不值得等' : ''}</div>`;
    } else {
      html += `<div class="hint">该标的暂无研究画像数据（40 只高股息池外）——默认按“80 直接买”保守处理；后续随研究扩展补充。</div>`;
    }
    html += `<div class="hint" style="margin-top:4px">口径：40 只高股息标的 2010-2026 实测（R12-R14）；年化等待收益=90档5年收益差÷等待年数；样本量见研究记录，非全部标的覆盖</div>`;
    html += `<div class="hint" style="margin-top:2px">D10 实测（25991 组机会区间）：等 1 年 vs 立即买，3 年收益差均值 <b>+8pp</b>、58% 概率更优（分布 -67~+77pp 极宽）——分位≥80 已可买，等 90 档只是锦上添花，不是必需</div>`;
    el.innerHTML = html;
  }

  /* O1：报告卡（六部分→五格数据+顶部结论引擎）——M22/M27 定稿：数据层/结论层分离
   * 卡面五格只展示数据；顶部一句话结论=verdictEngine 生成（可回源）
   * ROE/净利来自研究表（2026-08-18 东财F10 2025年报），F10 自动接入后替换 */
  /* v1.9.15 长期复投视角（主人令：加5年/10年看长期）：历史上 dy≥当前dy 的独立事件 → 持有 5/10 年
   * 含分红·不复投（复投收益更高）·样本以2010-2016为主需标注 */
  function calcLongTermView(series, kline, divs, curDy) {
    if (curDy == null) return null;
    const dates = Object.keys(kline).sort();
    const evs = []; let inZ = false, start = null;
    for (const x of series) {
      if (x.dy == null) continue;
      if (x.dy >= curDy) { if (!inZ) { inZ = true; start = x.d; } }
      else { if (inZ) { evs.push(start); inZ = false; } }
    }
    if (inZ) evs.push(start);
    const out = {};
    [1250, 2500].forEach(h => {
      let win = 0, sum = 0, n = 0;
      for (const d of evs) {
        const bi = dates.indexOf(d);
        if (bi < 0 || bi + h >= dates.length) continue;
        const bp = kline[dates[bi]], sp = kline[dates[bi + h]];
        if (!(bp > 0) || !(sp > 0)) continue;
        let divSum = 0;
        divs.forEach(x => { if (x.ex && x.dps > 0 && x.ex > dates[bi] && x.ex <= dates[bi + h]) divSum += x.dps; });
        const r = (sp + divSum) / bp - 1;
        if (r > 0) win++;
        sum += r; n++;
      }
      out[h] = n >= 3 ? { winP: win / n * 100, avg: sum / n * 100, n } : null;
    });
    return out;
  }
  function renderReportCard(code, divs, kline, extra) {
    const el = $('#diagReportCard');
    if (!el) return;
    // P0-6：当前档位历史标注（三维表）——重仓→heavy/加仓→add/小仓→small；hard 已拦截不重复标
    // v1.9.14 招行案例优化：wait 也分级显示（near/mid/far + 5年复投中位/亏损率 + 预计等待 + 踏空率）；
    // E："小仓≈随机"旧结论作废→3-5年含分红复投口径；Q5 带样本量
    const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
    const last = series.filter(x => x.pct != null).pop();
    const dy = last ? last.dy : null;
    const pct = last ? last.pct : null;
    const sigNoteHtml = (ind, tierName, trap, gapAdd) => {
      if (trap && trap.level === 'hard') return '';
      const key = tierName.indexOf('深度低估') >= 0 ? 'heavy' : tierName.indexOf('低估二档') >= 0 ? 'add' : tierName.indexOf('低估一档') >= 0 ? 'small' : tierName.indexOf('等待') >= 0 ? 'wait' : null;
      if (!key) return '';
      const trNote = DL.tierTrackNote(ind, key, gapAdd);
      const dd = DL.ddNote(ind, key);   // D7：分时段最大浮亏（重仓/加仓档）
      if (!trNote && !dd) return '';
      const isWait = key === 'wait';
      const ddTxt = dd ? ` · ${dd}` : '';
      const color = isWait ? 'var(--muted)' : 'var(--sub)';
      const prefix = isWait ? '⏳' : '📊';
      return `<div style="font-size:10px;color:${color};margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">${prefix} ${trNote || ''}${ddTxt}</div>`;
    };
    // 覆盖率（P0-B 修复后口径）
    const cov = DL.coverageAt(divs, parseInt(DL.todayStr().slice(0, 4), 10));
    // 储备年数 = 每股未分配 ÷ 每股派息（M25 公式锁定）——未分配暂无接口，用 extra 传入
    const reserve = (extra && extra.reserve != null) ? extra.reserve : null;
    // B 口径年度派息（P0-A 修复后：最近完整财年归属分红），非历史总和
    // Q2（M40）：mode 感知——A 兜底（366 现金流）触发时标注"过渡期口径"（实测 0 触发，防御性路径）
    const ttmMode = DL.ttmDivsAtMode(divs, DL.todayStr());
    const dps = ttmMode.v;
    const modeNote = ttmMode.mode === 'A' ? ' · <span style="color:#e0a030">过渡期口径（366现金流）</span>' : '';
    const reserveYears = (reserve != null && dps > 0) ? reserve / dps : null;
    const payoutRate = cov != null ? cov : null;
    // 分红 CAGR（近3年）
    const cagr = DL.calcDivCAGR(divs);
    // 行业（ORG_TYPE 兜底，extra 传结构化行业）
    const industry = (extra && extra.industry) || null;
    const tsNow = (dy != null && industry) ? DL.tierSpot(dy, industry, code) : null;
    const gapAdd = tsNow ? tsNow.gapAdd : null;
    const periodLabel = DL.reportPeriodLabel(divs) || (extra && extra.period) || '—';
    // 结论引擎（v1.9.13：传 code 启用分位线三档）
    const v = DL.verdictEngine({
      coverage: cov, reserveYears, payoutRate,
      eps: (extra && extra.eps) || null, dps, price: (extra && extra.price) || null,
      dy, pct, industry, code,
      roe: (extra && extra.roe) || null,
      roeTrend: (extra && extra.roeTrend) || null,
      dividendCagr: cagr,
      netProfitYoY: (extra && extra.netProfitYoY) || null,
    });
    const roeTxt = (extra && extra.roe != null) ? extra.roe.toFixed(1) + '%' : '<span style="color:var(--muted)">待接入</span>';
    /* v1.9.17 财报证据行（宇通教训）：扣非双口径/覆盖率/ROE退化/毛利率/负债率——证据层只展示，不进决策
     * 数据源分级：L2-F10（非财报原文），缺字段=显示"数据不足"不假装有（8/18 原则） */
    const deductTxt = (extra && extra.deductNetProfit != null)
      ? ((extra.deductNetProfit >= 100 ? extra.deductNetProfit.toFixed(0) + '亿' : extra.deductNetProfit.toFixed(1) + '亿') + (extra.deductYoY != null ? ' (' + (extra.deductYoY >= 0 ? '+' : '') + extra.deductYoY.toFixed(1) + '%)' : ''))
      : null;
    // v1.9.17 分红/OCF 覆盖率（分红总额 ÷ 经营现金流）：dps(元)×总股本÷OCF(亿)——之前用 dps/ocf 单位错配（2.5/31.97=8%假象，实际 55.35/31.97=173%）
    // 总股本从 F10 TOTAL_SHARE 拿；无总股本时用 OCF 的每股口径（MGJYXJJE）回退
    const ocfCovTxt = (extra && extra.ocf != null && extra.ocf > 0 && dps > 0)
      ? (extra.totalShare != null ? (dps * extra.totalShare / 1e8 / extra.ocf * 100) : (extra.ocfPerShare != null ? (dps / extra.ocfPerShare * 100) : null))
      : null;   // <100%=分红靠家底补（经营现金流不够分）
    const roeDownTxt = (extra && extra.roeDownYears != null && extra.roeDownYears >= 2) ? `⚠️ ROE连降${extra.roeDownYears}年` : null;
    const finEvidParts = [];
    if (extra && extra.deductNetProfit != null) {
      finEvidParts.push(`扣非 <b>${deductTxt}</b>`);
      if (extra.netProfit != null && extra.deductNetProfit != null && extra.netProfit > 0) {
        const npRatio = (extra.netProfit - extra.deductNetProfit) / extra.netProfit * 100;
        if (npRatio > 15) finEvidParts.push(`<span style="color:#e0a030">非经常占 ${npRatio.toFixed(0)}%</span>`);   // 理财/补助虚增嫌疑
      }
    }
    if (ocfCovTxt != null) finEvidParts.push(`分红/OCF <b>${ocfCovTxt.toFixed(0)}%</b>${ocfCovTxt < 100 ? ' <span style="color:#e0a030">(靠家底)</span>' : ''}`);
    if (extra && extra.grossMargin != null) finEvidParts.push(`毛利率 ${extra.grossMargin.toFixed(1)}%`);
    if (extra && extra.liabilityRatio != null) finEvidParts.push(`负债率 ${extra.liabilityRatio.toFixed(1)}%`);
    if (roeDownTxt) finEvidParts.push(`<span style="color:#e0a030">${roeDownTxt}</span>`);
    const finEvidHtml = finEvidParts.length
      ? `<div style="font-size:10px;color:var(--muted);margin:4px 0;padding:5px 8px;background:var(--card2);border-radius:6px;border:1px solid var(--line)">📊 财报证据<span style="font-size:9px;opacity:.7">（L2-F10·${(extra && extra.period) || '—'}·进证据不进决策）</span>：${finEvidParts.join(' · ')}</div>`
      : '';
    const netTxt = (extra && extra.netProfit != null) ? (extra.netProfit >= 100 ? extra.netProfit.toFixed(0) + ' 亿' : extra.netProfit.toFixed(1) + ' 亿') : '<span style="color:var(--muted)">待接入</span>';
    const cagrTxt = cagr != null ? (cagr * 100).toFixed(1) + '%' : '—';
    const covTxt = cov != null ? '覆盖 ' + (1 / cov).toFixed(1) + ' 倍' : '<span style="color:var(--muted)">数据不足</span>';
    const reserveTxt = reserveYears != null ? reserveYears.toFixed(1) + ' 年' : '—';
    const payoutTxt = payoutRate != null ? (payoutRate * 100).toFixed(0) + '%' : '—';
    const dyTxt = dy != null ? dy.toFixed(2) + '%' : '—';
    const pctTxt = pct != null ? pct.toFixed(0) + '%' : '—';
    const lastDate = series.length ? series[series.length - 1].d : null;
    const priceTxt = lastDate ? '<div style="font-size:9px;color:var(--muted)">收盘 ' + lastDate + '</div>' : '';
    const verdictHtml = v.summary;
    /* v1.9.13：分位线语义行（线源/线高低含义/红线/短样本告警） */
    const lineNoteHtml = v.lineNote ? `<div style="font-size:10px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">📐 ${v.lineNote}</div>` : '';
    const sourceTxt = (extra && extra.source) ? extra.source : '研究数据';
    // M1（阶段3）：数据源分级徽章（L0财报原文/L1公告/L2-F10/L3二手）——缺字段=“数据不足”不假装有
    const srcLevel = (extra && extra.source && /F10/.test(extra.source)) ? 'L2' : (extra && extra.source && /研究数据/.test(extra.source)) ? 'L1' : 'L2';
    const srcBadge = `<span style="border:1px solid ${srcLevel === 'L0' ? '#4caf7d' : srcLevel === 'L1' ? '#8bc34a' : '#e0a030'};border-radius:4px;padding:0 4px;color:${srcLevel === 'L0' ? '#4caf7d' : srcLevel === 'L1' ? '#8bc34a' : '#e0a030'}">数据源 ${srcLevel}（${srcLevel === 'L0' ? '财报原文' : srcLevel === 'L1' ? '公告/研究' : 'F10二手' }）</span>`;
    const freshTxt = (extra && extra.period) ? `数据时效：${extra.period}` : '数据时效：实时/延迟（截至最新交易日）';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:12px;font-weight:700">📋 报告卡 · ${periodLabel}${industry ? ' · ' + industry : '<span style="color:#e0a030"> · 行业待确认（仅核心三问）</span>'}</div>
        <div style="font-size:10px;color:var(--muted)">结论由引擎生成 · 可回源</div>
      </div>
      <div style="font-size:9px;color:var(--muted);margin-bottom:4px">数据血缘：${sourceTxt} · ${periodLabel}${modeNote} · ${freshTxt} · ${srcBadge}</div>
      ${finEvidHtml}
      <div style="background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px">
        ${v.trap ? `<div style="font-size:11px;margin-bottom:4px;${v.trap.level === 'hard' ? 'color:#e05a5a;font-weight:700' : 'color:#d9a45b'}">${v.trap.level === 'hard' ? '🚫' : '⚠️'} ${v.trap.msg}${v.trap.level === 'hard' ? ' · 💱 换仓参考：继续持有=吃当前股息率（覆盖 ' + (cov != null ? (1 / cov).toFixed(1) + ' 倍' : '—') + '）；如需换仓可到决策台扫描对比更健康标的——注意换仓有交易成本+浮盈税（A股印花税 0.05%+佣金），历史数据非承诺' : ''}</div>` : ''}
        ${v.filters && v.filters.length ? `<div style="font-size:10px;margin-bottom:4px;color:#d9a45b;background:rgba(217,164,91,.08);border:1px solid rgba(217,164,91,.3);border-radius:6px;padding:3px 6px">🟡 信号降级：仅参考 — ${v.filters.map(f => f.txt).join('；')}</div>` : ''}
        ${verdictHtml}
        ${(() => {
          /* v9.2 UI：买卖指令条（分层徽章+财报确认+行业信号+明确买卖动作）2026-08-20 */
          const layer = DL.TRADE_LAYER[code] || 'auto';
          const layerBadge = layer === 'event'
            ? '<span style="font-size:9px;border:1px solid #d9a45b;border-radius:4px;padding:0 4px;color:#d9a45b;margin-right:6px">🔎 事件层·人工决策</span>'
            : '<span style="font-size:9px;border:1px solid #5aa9e6;border-radius:4px;padding:0 4px;color:#5aa9e6;margin-right:6px">⚡ 自动层</span>';
          let tier = null;
          if (pct != null) { if (pct >= 95) tier = 'p95'; else if (pct >= 90) tier = 'p90'; else if (pct >= 75) tier = 'p75'; }
          let finOk = true, finChecks = [];
          let indSig = null;
          if (extra && extra.deductNetProfit != null) {
            const fc = DL.finConfirm({ industry, code, kf: extra.deductNetProfit, kfPrev: extra.deductNetProfitPrev, ocf: extra.ocf, np: extra.netProfit, xsmll: extra.grossMargin, xsmllPrev: extra.grossMarginPrev, xsmllPrev2: extra.grossMarginPrev2 });
            finOk = fc.pass; finChecks = fc.checks;
            indSig = DL.assessIndustrySignals({ industry, code, kf: extra.deductNetProfit, kfPrev: extra.deductNetProfitPrev, ocf: extra.ocf, np: extra.netProfit, xsmll: extra.grossMargin, xsmllPrev: extra.grossMarginPrev, xsmllPrev2: extra.grossMarginPrev2, netProfitYoY: extra.netProfitYoY });
          }
          let trendOk = true;
          if (kline && kline.length >= 60) {
            const low60 = Math.min(...kline.slice(-60).map(x => x.low || x.close || Infinity));
            const cur = kline[kline.length - 1];
            if (cur && cur.close != null && cur.close <= low60 * 1.02) trendOk = false;
          }
          const ts = DL.tradingSignal({ code, dy, tier, trendOk, finOk, finChecks, lastBuyDays: null, industrySignals: indSig, industry, finGood: !!(extra && extra.deductNetProfit != null && extra.deductNetProfitPrev != null && extra.deductNetProfitPrev > 0 && extra.deductNetProfit > extra.deductNetProfitPrev), valuation: null });
          const col = ts.action === 'sell' ? '#e05a5a' : ts.action === 'reduce' ? '#d9a45b' : ts.action === 'watch' ? '#d9a45b' : (ts.action.startsWith('buy_') ? '#4caf7d' : 'var(--muted)');
          const lvNote = ts.level ? ` <span style="font-weight:400;font-size:10px;color:var(--sub)">等级 ${ts.level} · 建议强度 ${ts.strength}</span>` : '';
          const disclaimer = ts.level ? '<span style="font-weight:400;font-size:9px;color:var(--muted);display:block;margin-top:2px">⚠️ 等级=风险提示+建议，最终动作由您拍板</span>' : '';
          return '<div style="font-size:12px;margin-top:6px;padding:6px 9px;border-radius:8px;border:1px solid ' + col + ';background:rgba(0,0,0,.2);color:' + col + ';font-weight:700">' + layerBadge + ts.text + lvNote + '<span style="font-weight:400;font-size:10px;color:var(--sub)"> — ' + ts.reason + '</span>' + disclaimer + '</div>';
        })()}
        ${v.tiers && v.tiers.length ? '<div style="font-size:11px;color:var(--sub);margin-top:4px">🎯 ' + v.tiers.map(t => t.type === 'cur' ? t.text : (t.label || t.type) + ' <b>' + t.rate.toFixed(1) + '%</b><span style="font-size:9px;opacity:.7">（' + t.price + ' 元）</span>' + (t.hit ? ' ✅' : '')).join(' &nbsp;|&nbsp; ') + '</div>' : ''}
        ${v.ref3D ? '<div style="font-size:10px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">📐 三维参考：' + ['abs', 'pct', 'fin'].map(k => { const r = v.ref3D[k]; return r ? `<span style="margin-right:8px"><b>${r.label}</b> ${r.val}${r.ref ? '（' + r.ref + '）' : ''}</span>` : ''; }).join('') + '</div>' : ''}
        ${v.conflicts && v.conflicts.length ? `<div style="font-size:10px;margin-top:3px;color:#d9a45b">⚡ 矛盾提示：${v.conflicts.join('；')}（并列展示，请自行裁决）</div>` : ''}
        ${lineNoteHtml}
        ${(() => { const longView = calcLongTermView(series, kline, divs, dy); return longView && (longView[1250] || longView[2500]) ? `<div style="font-size:10px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">📈 长期持有视角（当前股息率档·历史表现）：5年 ${longView[1250] ? longView[1250].winP.toFixed(0) + '%胜率·均值' + (longView[1250].avg >= 0 ? '+' : '') + longView[1250].avg.toFixed(1) + '%（n=' + longView[1250].n + '）' : '样本不足'} · 10年 ${longView[2500] ? longView[2500].winP.toFixed(0) + '%·' + (longView[2500].avg >= 0 ? '+' : '') + longView[2500].avg.toFixed(1) + '%（n=' + longView[2500].n + '）' : '样本不足'}（含分红·不复投·复投更高·样本以2010-2016为主）</div>` : ''; })()}
        ${(() => { const fuse = (dy != null && pct != null) ? DL.sellFuse(dy, pct, industry, code, divs, kline) : null; return fuse ? (fuse.active ? `<div style="font-size:11px;margin-top:4px;padding:5px 8px;border-radius:6px;background:rgba(224,90,90,.12);border:1px solid rgba(224,90,90,.45);color:#e05a5a">🚨 ${fuse.msg}</div>` : `<div style="font-size:10px;color:var(--muted);margin-top:3px">🧯 高估保险丝：未激活${fuse.exempt ? '（' + fuse.exempt + '）' : '（分位<5 且 股息率<2.2% 才触发）'}</div>`) : ''; })()}
        ${v.curTier && industry ? sigNoteHtml(industry, v.curTier.name, v.trap, gapAdd) : ''}
      </div>
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <tr>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);border-radius:6px 0 0 6px;text-align:center"><div style="color:var(--muted);font-size:10px">① 状态</div><div>净利 ${netTxt}</div></td>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);text-align:center"><div style="color:var(--muted);font-size:10px">② 可持续</div><div>覆盖 ${covTxt}</div><div>储备 ${reserveTxt} · 分红率 ${payoutTxt}</div></td>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);text-align:center"><div style="color:var(--muted);font-size:10px">③ 质量</div><div>ROE ${roeTxt}</div><div>CAGR ${cagrTxt}</div></td>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);text-align:center"><div style="color:var(--muted);font-size:10px">④ 价格</div><div>股息率 ${dyTxt}</div><div>便宜度(375d) ${pctTxt}</div>${priceTxt}</td>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);border-radius:0 6px 6px 0;text-align:center"><div style="color:var(--muted);font-size:10px">⑤ 风险</div><div style="font-size:10px">${v.q3.msg}</div></td>
        </tr>
      </table>`;
  }

  /* D6 决策日志（2026-08-18）：一条决策=一行流水，localStorage 持久化（上限 200 条）
   * 自动：建仓区提醒/极值触发时记一条（decision='auto'）
   * 手动：决策摘要区"记：买/不买/等"三按钮
   * 字段：ts/date/code/name/tier/pct/dy/note/trap/decision/price */
  const DEC_KEY = 'divtool_decisions_v1';
  function decLog() { try { return JSON.parse(localStorage.getItem(DEC_KEY)) || []; } catch (e) { return []; } }
  function decAdd(rec) {
    try {
      const arr = decLog();
      arr.unshift(Object.assign({ ts: Date.now(), date: DL.todayStr() }, rec));
      localStorage.setItem(DEC_KEY, JSON.stringify(arr.slice(0, 200)));
    } catch (e) {}
  }
  function decListHtml(limit) {
    const arr = decLog().slice(0, limit || 8);
    if (!arr.length) return '<div class="hint">还没有决策记录——信号触发会自动记录，或点上方按钮记本次决策（1-3 年后回来对照）</div>';
    return '<div style="font-size:10px;color:var(--muted);margin-bottom:2px">最近 ' + arr.length + ' 条（自动记录=信号触发；手动=你的决定）</div>' + arr.map(x => {
      const d = (x.decision === 'buy' ? '✅买' : x.decision === 'no' ? '⏸不买' : x.decision === 'wait' ? '⏳等' : '🔔信号');
      const c = x.decision === 'buy' ? '#4caf7d' : x.decision === 'no' ? '#e06666' : x.decision === 'wait' ? '#d9a45b' : 'var(--sub)';
      return `<div style="font-size:11px;padding:3px 0;border-bottom:1px dashed var(--line)">${x.date} <b>${x.name || x.code}</b> ${x.tier || ''} · ${x.pct != null ? x.pct.toFixed(0) + '%分位' : ''}${x.dy != null ? ' · ' + x.dy.toFixed(2) + '%' : ''}<span style="color:${c}"> ${d}</span>${x.trap ? ' <span style="color:#e05a5a">' + (x.trap.level === 'hard' ? '🚫' : '⚠️') + '</span>' : ''}</div>`;
    }).join('');
  }

  /* v1.9.6 P0-8/9：决策摘要区（买入结论行 + 关键三数）——规则树与 rule-tree-backtest.js 一致，历史胜率来自回测表 */
  function renderDecisionSummary(code, divs, kline) {
    const el = $('#diagSummary');
    if (!el) return;
    const body = $('#diagSummaryBody');
    const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
    const last = series.filter(x => x.pct != null).pop();
    if (!last) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const tcls = DL.classifyTier(code);
    const asOfY = parseInt(last.d.slice(0, 4), 10);
    const trendBad = DL.divTrendBadAt(divs, asOfY);
    const cov = DL.coverageAt(divs, asOfY);
    const v = DL.ruleVerdict(last.pct, tcls.cls, trendBad, cov);
    const st = DL.RULE_STATS[v.tier];
    const label = DL.RULE_TIER_LABEL[v.tier];
    const color = { strong: '#4caf7d', buy: '#4caf7d', watch: '#d9a441', wait: '#8fa69c', avoid: '#e05a5a', avoid_small: '#e05a5a' }[v.tier];
    const icon = { strong: '🟢', buy: '🟢', watch: '🟡', wait: '⚪', avoid: '🔴', avoid_small: '🔴' }[v.tier];
    const eco = DL.calcEcoType(kline, series);
    const ecoName = { low: '低波动', mid: '中波动', high: '高波动', declining: '阴跌' }[eco.type] || '中波动';
    const waitHint = (v.tier === 'wait' && tcls.profile) ? ` · 历史等90档平均约 ${(tcls.profile.gap90 / 30.4).toFixed(0)} 个月` : '';
    const statTxt = v.tier === 'wait'
      ? '历史：等1年再买 vs 立即买 3年收益差 +3.6%（976 次事件，历史均值非承诺收益）'
      : (st && st[0] != null ? `历史同结论 3 年收益 ${st[0].toFixed(1)}% / 胜率 ${st[1]}%（${st[2]} 次事件）` : '历史样本不足');
    const cagr = DL.calcDivCAGR(divs, 3);
    const dyTmp = DL.calcAnnualDivYield(divs, Object.values(kline).pop());
    const yieldTxt = dyTmp ? dyTmp.yieldPct.toFixed(2) + '%' : '—';
    const stepsHtml = v.steps.map((s, i) => `<div style="font-size:11px;color:var(--sub);padding:2px 0">${i + 1}. ${s.msg}</div>`).join('');
    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b style="color:${color};font-size:16px">${icon} ${label}</b>
        <span style="font-size:12px;color:var(--sub)">${statTxt} · 基于历史数据</span>
      </div>
      <div style="font-size:12px;margin-top:6px;color:var(--txt)">当前分位 ${last.pct.toFixed(0)}%（${tcls.label} · ${ecoName}）${waitHint}</div>
      <div style="font-size:11px;color:var(--sub);margin-top:4px">股息率(TTM) ${yieldTxt} · 分红率(近2财年) ${cov != null ? (cov * 100).toFixed(0) + '%' : '—'} · 分红CAGR ${cagr != null ? (cagr * 100).toFixed(1) + '%' : '—'}</div>
      <details style="margin-top:6px"><summary style="font-size:11px;color:var(--sub);cursor:pointer">查看判定依据</summary>${stepsHtml}<div style="font-size:10px;color:var(--muted);margin-top:4px">规则：分红趋势一票否决 → 覆盖率降级 → 分位×生态类型 → 等待成本；历史胜率=40只×16年回测（375窗口）；非投资建议，不构成买卖依据</div></details>
      <div style="margin-top:6px;border-top:1px dashed var(--line);padding-top:6px">
        <div style="font-size:11px;color:var(--sub);margin-bottom:4px">📒 决策日志（D6：记下今天的选择，1-3 年后自动对照）</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
          <button type="button" class="chip" id="decBtnBuy" style="color:#4caf7d">✅ 记：买</button>
          <button type="button" class="chip" id="decBtnNo" style="color:#e06666">⏸ 记：不买</button>
          <button type="button" class="chip" id="decBtnWait" style="color:#d9a45b">⏳ 记：等</button>
        </div>
        <div id="decLogList">${decListHtml(6)}</div>
      </div>`;
    const bindDec = (decision) => {
      decAdd({ code, name: (window.REPORT_CARD_EXTRA && window.REPORT_CARD_EXTRA[code] && window.REPORT_CARD_EXTRA[code].name) || code, tier: v.tier, pct: last.pct, dy: dyTmp ? dyTmp.yieldPct : null, note: label, trap: null, decision });
      const ll = document.getElementById('decLogList');
      if (ll) ll.innerHTML = decListHtml(6);
    };
    const b1 = document.getElementById('decBtnBuy'); if (b1) b1.onclick = () => bindDec('buy');
    const b2 = document.getElementById('decBtnNo'); if (b2) b2.onclick = () => bindDec('no');
    const b3 = document.getElementById('decBtnWait'); if (b3) b3.onclick = () => bindDec('wait');
  }

  /* 分红节奏：每年几月派息 */
  function renderRhythm(divs) {
    const el = $('#diagRhythm');
    if (!el) return;
    const byYear = {};
    divs.forEach(d => { if (!d.ex) return; const y = d.ex.slice(0, 4), m = parseInt(d.ex.slice(5, 7), 10); (byYear[y] = byYear[y] || []).push(m); });
    const years = Object.keys(byYear).sort().slice(-10);
    el.innerHTML = years.length ? years.map(y => {
      const ms = byYear[y].sort((a, b) => a - b);
      return `<div class="rhythm-row"><span class="rhythm-year">${y}年</span>${ms.map(m => `<span class="rhythm-m">${m}月</span>`).join('')}</div>`;
    }).join('') : '<div class="hint">暂无分红记录</div>';
  }

  /* v1.8.13 功能D：多起点敏感度（1/3/5/10年前买入对比，回答"现在买划不划算"） */
  async function renderMultiStart(code, divs) {
    const el = $('#diagMultiStart');
    if (!el) return;
    el.innerHTML = '<div class="hint">加载中…</div>';
    try {
      const end = DL.todayStr();
      const start10 = new Date(Date.now() - 10 * 366 * 86400000).toISOString().slice(0, 10);
      const kline = await DL.getKline(code, start10, end);
      const dates = Object.keys(kline).sort();
      if (!dates.length || typeof window.simulate !== 'function') { el.innerHTML = '<div class="hint">数据不足</div>'; return; }
      const rows = [1, 3, 5, 10].map(y => {
        const buyDate = new Date(Date.now() - y * 366 * 86400000).toISOString().slice(0, 10);
        const res = window.simulate(1000000, buyDate, true, kline, divs, 0, 0);
        return { y, res };
      });
      el.innerHTML = '<div class="scroll"><table class="tbl"><thead><tr><th>买入起点</th><th>买入价</th><th>期末总资产</th><th>累计分红</th><th>年化(XIRR)</th><th>总收益率</th></tr></thead><tbody>' +
        rows.map(r => { const f = r.res.final; return `<tr><td>${r.y}年前（${r.res.buyDateReal}）</td><td>${fmt(r.res.buyPrice, 2)}</td><td>${fmt(f.finalValue, 0)}</td><td>${fmt(f.totalDiv, 0)}</td><td class="${f.xirr != null && f.xirr >= 0 ? 'green' : 'red'}">${fmtPct(f.xirr)}</td><td class="${f.totalReturn >= 0 ? 'green' : 'red'}">${fmtPct(f.totalReturn)}</td></tr>`; }).join('') +
        '</tbody></table><div class="hint">口径：100万本金 · 红利再投资 · 免红利税 · XIRR 含分红再投——"现在买划不划算"参考（起点不同勿直接横比）</div></div>';
    } catch (e) { el.innerHTML = `<div class="hint err">敏感度分析失败：${e.message}</div>`; }
  }

  /* ---------- 对比页占位（第二批） ---------- */
  /* ================= 对比页（v1.7.2 大师 P1-26/27/28 落地） ================= */
  const cmpState = { list: [], years: 5, startDate: null };   // list: [{code,name}]；startDate: 精确起始日期（null=用 years 快捷）
  let cmpCharts = {};
  let cmpResults = [];   // B8: 表格排序数据源（cmpRun 填充）
  let cmpSort = { key: '', dir: 1 };   // v1.8.13 BUG-5：初始空串（原 null 使 arrow(null) 恒真，标的列一直显示 ▲）

  // B8: 表格渲染（可排序）
  const yieldSeriesStr = r => (r.yieldSeries || []).filter(p => p.v != null).slice(-4).map(p => p.y + ' ' + p.v.toFixed(1) + '%').join(' · ') || '—';
  // v1.8.13 功能B：逐年分红明细行（同比上一年 -20% 标红预警）
  const yearsLine = r => { const ys = (r.res.years || []).slice().sort((a, b) => a.year < b.year ? -1 : 1); return ys.slice().reverse().map((y, i) => { const prev = (i + 1 < ys.length) ? ys[ys.length - 2 - i] : null; const yoy = (prev && prev.divTotal > 0 && y.divTotal != null) ? (y.divTotal - prev.divTotal) / prev.divTotal : null; return y.year + '年：' + fmt(y.divTotal, 0) + ' 元' + (yoy != null && yoy <= -0.2 ? ' <span style="color:var(--red)">⚠️' + (yoy * 100).toFixed(0) + '%</span>' : '') + (y.rate != null ? '（' + (y.rate * 100).toFixed(1) + '%）' : ''); }).join('<br>') || '—'; };
  function renderCmpTable() {
    const getVal = r => ({ final: r.res.final.finalValue, invested: r.res.final.finalInvested, div: r.res.final.totalDiv, recover: (r.res.final.totalDiv != null && r.res.final.invested > 0) ? r.res.final.totalDiv / r.res.final.invested * 100 : null, lastRepDiv: r.lastRepDiv ? r.lastRepDiv.cash : null, xirr: r.res.final.xirr, dd: -r.maxDD, yield12: r.yield12 })[cmpSort.key];
    const list = cmpSort.key ? [...cmpResults].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * cmpSort.dir;
    }) : cmpResults;
    const arrow = k => (k && cmpSort.key === k) ? (cmpSort.dir > 0 ? ' ▲' : ' ▼') : '';   // v1.8.13 BUG-5：k 非空才显示箭头
    const heads = [['标的', null], ['期末总资产', 'final'], ['累计投入', 'invested'], ['累计分红', 'div'], ['回本率', 'recover'], ['最新报告期分红', 'lastRepDiv'], ['年化(XIRR)', 'xirr'], ['最大回撤', 'dd'], ['股息率(近2财年)', 'yield12'], ['股息率(逐年)', null]];
    const getVal2 = r => (r.res.final.totalDiv != null && r.res.final.invested > 0) ? r.res.final.totalDiv / r.res.final.invested * 100 : null;
    $('#cmpTbl').innerHTML = `<table class="tbl cmp-tbl"><tr>${heads.map(h => `<th data-sort="${h[1] || ''}" style="cursor:${h[1] ? 'pointer' : 'default'}">${h[0]}${arrow(h[1])}</th>`).join('')}</tr>` +
      list.map((r, i) => `<tr style="${r.divMissing ? 'opacity:.55' : ''}">
        <td>${i+1}. ${r.it.name}${r.divMissing ? ' <span class="risk-badge">数据暂缺</span>' : ''}<br><span style="color:${r.actualStart ? 'var(--red)' : 'var(--sub)'};font-size:11px">${r.it.code}${r.it.market ? '.' + r.it.market.toUpperCase() : ''} · ${r.actualStart ? '自 ' + r.actualStart + ' 起' + (r.liveYears ? ' 约' + r.liveYears + '年' : '') : ''}</span>
          <details style="margin-top:4px;font-size:11px;color:var(--sub)"><summary style="cursor:pointer;color:#3fbf7f">逐年分红明细 ▾</summary>
            <div style="margin-top:3px;line-height:1.7">${r.divMissing ? '<span style="color:var(--red)">分红数据暂缺（未纳入对比）</span>' : yearsLine(r)}</div>
          </details></td>
        <td>${fmt(r.res.final.finalValue, 0)} 元</td>
        <td>${fmt(r.res.final.finalInvested, 0)} 元</td>   <!-- v1.8.8: 口径与回测页一致（本金+追加+复投），曾只算本金致两边数字对不上 -->
        <td>${r.divMissing ? '<span style="color:var(--red)">数据暂缺</span><br><span style="color:var(--sub);font-size:11px">未纳入对比</span>' : fmt(r.res.final.totalDiv, 0) + ' 元<br><span style="color:var(--sub);font-size:11px">年均 ' + fmt(r.res.final.totalDiv / Math.max(1, (r.res.years || []).length), 0) + ' 元</span>'}</td>
        <td>${r.divMissing ? '—' : '<b>' + fmt(Math.min(999, r.res.final.totalDiv / r.res.final.invested * 100), 1) + '%</b><br><span style="color:var(--sub);font-size:11px">累计分红÷投入</span>'}</td>
        <td>${r.divMissing ? '—' : (r.lastRepDiv ? '<span style="color:var(--sub)">' + r.lastRepDiv.year + '</span> ' + fmt(r.lastRepDiv.cash, 0) + ' 元' : '—')}</td>
        <td class="${r.res.final.xirr != null && r.res.final.xirr >= 0 ? 'green' : 'red'}">${r.res.final.xirr != null ? fmtPct(r.res.final.xirr) : '—'}</td>
        <td class="red">${fmtPct(-r.maxDD)}</td>
        <td>${r.divMissing ? '—' : (r.yield12 != null ? r.yield12.toFixed(2) + '%' : '—')}</td>
        <td style="font-size:11px;color:var(--sub)">${r.divMissing ? '—' : yieldSeriesStr(r)}</td>
      </tr>`).join('') + '</table>';
    $('#cmpTbl').querySelectorAll('th[data-sort]').forEach(th => {
      const k = th.dataset.sort;
      if (!k) return;
      th.onclick = () => {
        if (cmpSort.key === k) cmpSort.dir = -cmpSort.dir;
        else { cmpSort.key = k; cmpSort.dir = 1; }
        renderCmpTable();
      };
    });
  }

  function cmpEnsureChart(id) {
    if (cmpCharts[id]) { cmpCharts[id].dispose(); }
    const el = $(id);
    cmpCharts[id] = echarts.init(el);
    return cmpCharts[id];
  }
  // 窗口/横竖屏变化时对比页图表自适应（与回测页 charts 同款；缺这个=换设备/旋转后旧尺寸残留=图挤）
  window.addEventListener('resize', () => {
    Object.keys(cmpCharts).forEach(k => {
      try {
        const chart = cmpCharts[k];
        const el = document.getElementById(k);
        if (el && el.clientWidth > 0) {
          // legend 数字宽度跟随容器（ECharts 5.5.0 百分比解析 bug 的规避）
          chart.setOption({ legend: { width: Math.max(280, el.clientWidth - 20) } });
        }
        chart.resize();
      } catch (e) { }
    });
  });

    let _cmpSeq = 0;   // v1.9.2 O2：搜索解析序号（防连续输入晚返回覆盖）
  async function cmpResolveCode(v) {
    v = (v || '').trim();
    if (!v) return null;
    const seq = ++_cmpSeq;
    // C2：显式后缀 000300.SH / 000001.SZ（指数/股票不靠猜）
    const parsed = DL.parseSecInput(v);
    if (/^\d{6}$/.test(parsed.code)) {
      let name = parsed.code;
      try { name = await DL.fetchName(parsed.code, parsed.market); } catch (e) { }
      if (seq !== _cmpSeq) return null;   // 已被新输入取代
      return { code: parsed.code, name, market: parsed.market };
    }
    // 名称搜索
    try {
      const d = await DL.jsonp('https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(v) + '&type=14&count=3', 'cb');
      if (seq !== _cmpSeq) return null;
      const list = d && d.QuotationCodeTable && d.QuotationCodeTable.Data || [];
      if (list.length) return { code: list[0].Code, name: list[0].Name, market: null };
    } catch (e) { }
    return null;
  }

  // C8：标的类型标签（股/ETF/指数）
  function secTypeLabel(it) {
    if (it.market && /^000/.test(it.code)) return '指数';
    if (/^(5|159|16)/.test(it.code)) return 'ETF';
    return '股票';
  }

  function cmpRenderList() {
    const el = $('#cmpList');
    if (!el) return;
    if (!cmpState.list.length) { el.innerHTML = '<div class="hint">还没有标的。输入代码/名称添加，或点下方 ETF 快捷。</div>'; return; }
    el.innerHTML = '<div class="wl-main">' + cmpState.list.map((it, i) =>
      `<div class="wl-card" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px">
         <span>${i+1}. ${it.name} <b style="color:var(--sub)">${it.code}${it.market ? '.' + it.market.toUpperCase() : ''}</b> <span class="chip" style="font-size:10px;padding:1px 6px">${secTypeLabel(it)}</span></span>
         <button class="chip" data-del="${i}" style="background:rgba(224,102,102,.15);color:var(--red)">✕</button>
       </div>`).join('') + '</div>';
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      cmpState.list.splice(+b.dataset.del, 1);
      cmpRenderList();
    });
  }

  async function cmpAdd(v) {
    const it = typeof v === 'object' ? v : await cmpResolveCode(v);   // C2：支持 {code,name,market} 对象（ETF_PRESETS 指数带 market）
    if (!it) { alert('未找到该标的，请输入 6 位代码或正确名称'); return; }
    if (cmpState.list.some(x => x.code === it.code)) { alert(it.name + ' 已在列表'); return; }
    if (cmpState.list.length >= 5) { alert('最多对比 5 个标的'); return; }
    cmpState.list.push(it);
    cmpRenderList();
    $('#cmpInput').value = '';
  }

  async function cmpRun() {
    const el = $('#cmpResult');
    if (!el) return;
    // v1.9.1 O2：运行锁（防连续点击并发跑两次，晚返回覆盖）
    if (cmpState.running) return;
    cmpState.running = true;
    try {
      if (!cmpState.list.length) { alert('请先添加至少 1 个标的'); return; }
    el.style.display = 'none';
    const y = cmpState.years;
    // B2/B1：本金/复投可调（默认 100 万/复投，与回测页同口径）
    const principalRaw = parseFloat($('#cmpPrincipal').value);
    const monthlyRaw = parseFloat($('#cmpMonthly').value);
    // v1.8.11 大师 M4-②：非法金额红框提示（不静默回退）
    const markBad = (id, bad) => { const el = $(id); if (el) el.style.borderColor = bad ? 'var(--red)' : 'var(--line)'; };
    let bad = false;
    if (isNaN(principalRaw) || principalRaw < 0) { markBad('#cmpPrincipal', true); bad = true; } else markBad('#cmpPrincipal', false);
    if (isNaN(monthlyRaw) || monthlyRaw < 0) { markBad('#cmpMonthly', true); bad = true; } else markBad('#cmpMonthly', false);
    if (bad) { alert('本金/月供请输入有效金额（≥0）'); return; }
    const principal = principalRaw || 1000000;
    // v1.8.11 大师 M1/M3：起始日期优先（cmpStartDate），否则快捷年数（今天-N年）
    const start = cmpState.startDate || new Date(Date.now() - y * 366 * 86400000).toISOString().slice(0, 10);
    const reinvest = !$('#cmpReinvest') || $('#cmpReinvest').checked;
    // v1.7.3：月供可调（默认 0=零月供）；所有标的同月供，保证口径一致
    const monthly = Math.max(0, parseFloat($('#cmpMonthly').value) || 0);
    const strictSameStart = !!$('#cmpStrict') && $('#cmpStrict').checked;   // v1.7.4 P3：严格同期可切换（默认 B：按实际上市日起算）
    const end = DL.todayStr();
    const status = $('#status');
    if (status) { status.textContent = '对比中：拉取 ' + cmpState.list.length + ' 个标的 K线/分红…'; status.className = 'status'; }
    const results = [];
    const errors = [];
    const skipped = [];
    // 2026-08-17 性能修复：各标的并行拉取（原来串行=5×(K线+分红+快照)依次排队）
    const tasks = cmpState.list.map(it => (async () => {
      const kline = await DL.getKline(it.code, start, end, it.market);   // C2: 指数带 market（sh000300）
      const dates = Object.keys(kline).sort();
      // v1.7.4 P3 方案B：默认按实际上市日起算（不足周期不跳过），严格同期时保留旧逻辑
      if (!dates.length) {
        errors.push(`「${it.name}(${it.code})」无行情数据——已跳过`);
        return null;
      }
      if (strictSameStart && dates[0] > start) {
        skipped.push(`「${it.name}(${it.code})」${y}年前（${start}）尚无数据，最早 ${dates[0]}——已跳过（严格同期）`);
        return null;
      }
      const actualStart = dates[0] > start ? dates[0] : start;   // 实际起算日（上市日晚于所选周期起点）
      const divs = await DL.fetchDividendsOne(it.code);
      const divMissing = !!(divs && divs._missing);   // v1.8.13 BUG-4：数据暂缺（≠分红为0）
      const res = simulate(principal, actualStart, reinvest, kline, divs, monthly);   // B2/B1: 本金/复投可调
      // 最大回撤 + 股息率（v1.7.4 P7：改用按报告期归组的年化股息率，替代365天窗口）
      let maxDD = 0, peak = -Infinity;
      res.daily.forEach(x => { if (x.value > peak) peak = x.value; const dd = (peak - x.value) / peak; if (dd > maxDD) maxDD = dd; });
      const snap = homeState.snap || await DL.getStockQuotes([it.code]);
      homeState.snap = snap;
      const s = snap[it.code] || {};
      // C2：指数无行情快照（腾讯 sz000922 会拿错佳电股份价）→ 直接用 K 线末收盘价
      const lastPrice = it.market ? res.final.lastClose : (s.price || res.final.lastClose);
      const dy = DL.calcAnnualDivYield(divs, lastPrice);
      const liveYears = (dates[0] > start) ? Math.round((new Date(end) - new Date(dates[0])) / (365.25 * 86400000) * 10) / 10 : null;
      // B3：逐年股息率序列（报告期归组 ÷ 年末价；起点=min(买入年-1, 首笔分红年)·大师裁）
      const annual = {};
      divs.forEach(d => { if (!d.pending && d.report) { const ry = d.report.slice(0, 4); annual[ry] = (annual[ry] || 0) + d.dps; } });
      const repYrs = Object.keys(annual).map(Number).sort();
      const yieldSeries = repYrs.length ? (() => {
        const startY = Math.min(parseInt(actualStart.slice(0, 4), 10) - 1, repYrs[0]);
        const endY = repYrs[repYrs.length - 1];
        const out = [];
        for (let yy = startY; yy <= endY; yy++) {
          const dps = annual[yy] || 0;
          if (!dps) { out.push({ y: yy, v: null }); continue; }
          const yDates = dates.filter(d => d.startsWith(String(yy)));
          const price = yDates.length ? kline[yDates[yDates.length - 1]] : lastPrice;
          out.push({ y: yy, v: dps / price * 100 });
        }
        return out;
      })() : null;
      // B6：除息日索引（tooltip 标注用）
      // v1.8.7 P1-3：最新报告期分红金额（元，按报告期归组；口径与回测页分红图一致）
      const annualCash = {};
      res.divEvents.forEach(e => { if (e.cash && e.reportYear) { annualCash[e.reportYear] = (annualCash[e.reportYear] || 0) + e.cash; } });
      const repCashYrs = Object.keys(annualCash).map(Number).sort();
      const lastRepDiv = repCashYrs.length ? { year: repCashYrs[repCashYrs.length-1], cash: annualCash[repCashYrs[repCashYrs.length-1]] } : null;
      const divByDate = {};
      divs.forEach(d => { if (d.ex) (divByDate[d.ex] = divByDate[d.ex] || []).push(d); });
      return { it, res, maxDD, yield12: dy ? dy.yieldPct : null, yieldYears: dy ? dy.years : null, actualStart: dates[0] > start ? dates[0] : null, liveYears, yieldSeries, divByDate, lastRepDiv, divMissing };
    })());
    const settled = await Promise.all(tasks);
    settled.forEach(r => { if (r) results.push(r); });
    if (status) status.textContent = '';
    if (!results.length) { el.style.display = 'block'; $('#cmpTbl').innerHTML = '<div class="hint err">全部失败</div>'; $('#cmpNote').textContent = errors.join('；'); return; }
    el.style.display = 'block';   // v1.8.4c：先显示容器再绘三图+fitLegendTop（曾致 clientWidth=0 守卫拦截测量）
    if (errors.length || skipped.length) {
      const note = $('#cmpNote'); if (note) note.textContent = '⚠️ ' + [...skipped, ...errors].join('；');
    }
    const missingOnes = results.filter(r => r.divMissing);
    if (missingOnes.length) {   // v1.8.13 BUG-4：数据暂缺≠0，明示未纳入分红对比
      const note = $('#cmpNote'); if (note) note.textContent = (note.textContent ? note.textContent + '；' : '') + '⚠️ ' + missingOnes.map(r => r.it.name + '(' + r.it.code + ')').join('、') + ' 分红数据暂缺（未纳入分红对比）';
    }
    // P3 + v1.8.11 大师 M2：不足周期标的存在时，图区顶部显式警告（旧版仅 status 小字，日期输入模式下起点非标变常态）
    const shortOnes = results.filter(r => r.actualStart);
    const warnEl = $('#cmpWarn');
    if (shortOnes.length && warnEl) {
      warnEl.style.display = 'block';
      warnEl.innerHTML = '⚠️ ' + shortOnes.map(r => `<b>${r.it.name}</b> 上市晚于所选起点（${start}），实际自 <b>${r.actualStart}</b> 起（约 ${r.liveYears} 年）——曲线起点不同，对比仅供参考`).join('<br>');
    } else if (warnEl) { warnEl.style.display = 'none'; }
    // 总资产走势图（P1-26：对比图只画总资产+股息率；累计分红只进表格；v1.7.4 P2：5色提亮+线型双通道+图例12px+点标记）
    // 图例自适应：v1.8.4 全局 window.fitLegendTop（大师 M2：全站唯一实现，此局部定义已删）
    const ch1 = cmpEnsureChart('cmpChartAsset');
    // x 轴防挤：日线数据抽样（最多 ~400 点），图例名称截断防分页（全名留在 tooltip）
    // 主轴 = 最早/最长数据标的（v1.8.2: 原来只取 results[0]→若第一个标的上市晚，选 10 年也只显示它的存续期）
    const master = results.reduce((a, b) => a.res.daily.length >= b.res.daily.length ? a : b);
    const daily0 = master.res.daily;
    const step = Math.max(1, Math.floor(daily0.length / 600));
    const idx = daily0.map((_, i) => i).filter(i => i % step === 0);
    const allDates = idx.map(i => daily0[i].date);
    const CMP_COLORS = ['#f2c94c', '#5aa9e6', '#3fbf7f', '#c46ae0', '#e06666'];   // 金(提亮)/蓝/青/紫/红
    const CMP_SYMBOLS = ['circle', 'rect', 'triangle', 'diamond', 'pin'];   // B5: 全实线 + 符号双通道（色弱可辨），CMP_DASH 已删
    const shortName = n => n.length > 8 ? n.slice(0, 8) + '…' : n;
    ch1.setOption({
      backgroundColor: 'transparent', tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', confine: true, formatter: ps => {
        const x = daily0[idx[ps[0].dataIndex]];
        let s = '<b>' + x.date + '</b><br/>';
        ps.forEach(p => { s += p.marker + p.seriesName + '：<b>' + (p.value != null ? fmt(p.value, 0) : '—') + '</b> 元<br/>'; });
        results.forEach(r => {   // B6: 除息日 tooltip（悬停显示，不常驻）
          const ev = r.divByDate[x.date];
          if (ev && ev.length) s += '<span style="color:#3fbf7f">📅 ' + shortName(r.it.name) + ' 除息：' + ev.map(e => '派' + (e.dps * 10).toFixed(2) + '元').join('、') + '</span><br/>';
        });
        return s;
      } }),
      legend: { textStyle: { color: '#8fa69c', fontSize: 12 }, top: 0, left: 0, orient: 'horizontal', type: 'plain', itemWidth: 28, itemHeight: 14, formatter: shortName },
      grid: { left: 54, right: 14, top: 34, bottom: 24 },
      xAxis: Object.assign({ type: 'category', data: allDates }, AXIS),
      yAxis: axY({ scale: true, axisLabel: { formatter: v => v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v } }),
      series: results.filter(r => !r.divMissing).map((r, i) =>   {   // v1.8.13 BUG-4: 数据暂缺标的曲线不画（表格仍灰显展示）
        const vmap = {};
        r.res.daily.forEach(x => { vmap[x.date] = x.value; });   // 各标的按日期对齐（缺=null 断点）
        return {
          name: r.it.name, type: 'line', showSymbol: true, symbol: CMP_SYMBOLS[i % 5], symbolSize: 5,
          data: allDates.map(d => vmap[d] != null ? Math.round(vmap[d]) : null),
          lineStyle: { width: 2.5, color: CMP_COLORS[i % 5], type: 'solid' },   // B5: 全实线
          itemStyle: { color: CMP_COLORS[i % 5] },
        };
      }),
    });
    fitLegendTop(ch1, $('#cmpChartAsset'), 34);
    // B9：累计分红曲线（多标的叠加，与总资产同轴语义：分红累计到账）
    const chDiv = cmpEnsureChart('cmpChartDiv');
    chDiv.setOption({
      backgroundColor: 'transparent', tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', confine: true, valueFormatter: v => fmt(v, 0) + ' 元' }),
      legend: { textStyle: { color: '#8fa69c', fontSize: 11 }, top: 0, left: 0, orient: 'horizontal', type: 'plain', itemWidth: 22, itemHeight: 12, formatter: shortName },
      grid: { left: 54, right: 14, top: 34, bottom: 24 },
      xAxis: Object.assign({ type: 'category', data: allDates }, AXIS),
      yAxis: axY({ axisLabel: { formatter: v => v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v } }),
      series: results.filter(r => !r.divMissing).map((r, i) =>   {   // v1.8.13 BUG-4: 数据暂缺标的曲线不画（表格仍灰显展示）
        // 按日期累计分红（v1.8.10 修复：主轴 allDates 是抽样轴（5年≈1215天 step=2 跳日），
        // 旧版依赖 evMap[d] 恰好命中 → 除息日在被抽样跳过的日期时该笔分红永远进不了曲线，
        // 实测曲线终点 84,038 vs 表格 201,715。改为指针式：累计所有除息日 <= 当前轴日期的分红）
        const evs = r.res.divEvents.slice().sort((a, b) => a.date < b.date ? -1 : 1);
        let ei = 0, cum = 0;
        const data = allDates.map(d => {
          while (ei < evs.length && evs[ei].date <= d) { cum += evs[ei].cash; ei++; }
          return cum > 0 ? Math.round(cum) : null;
        });
        return {
          name: r.it.name, type: 'line', showSymbol: false, data,
          lineStyle: { width: 1.8, color: CMP_COLORS[i % 5], type: 'solid' },
          itemStyle: { color: CMP_COLORS[i % 5] },
        };
      }),
    });
    window.fitLegendTop(chDiv, $('#cmpChartDiv'), 34);   // v1.8.4 大师 M2：统一全局实现（旧同步读内联已删，同步读=0 无效）
    // 每年分红对比（v1.8.10 大师 M1-M3：分组柱状，到账年口径；空分红年=0柱+tooltip标注；
    // M6：x 轴抽稀只动刻度标签，数据全量保留）
    const chA = cmpEnsureChart('cmpChartAnnual');
    // v1.8.12 主人令：与回测页同款口径开关（到账年/报告期），渲染抽函数供 radio 切换
    const renderCmpAnnual = (mode) => {
      const srcYears = r => mode === 'report' ? (r.res.reportYears || []) : (r.res.years || []);
      const yrsAll = [...new Set(results.flatMap(r => srcYears(r).map(y => y.year)))].sort();
      const yearLabelStep = yrsAll.length > 10 ? Math.ceil(yrsAll.length / 8) : 1;
      chA.setOption({
        backgroundColor: 'transparent',
        tooltip: Object.assign({}, TOOLTIP, {
          trigger: 'axis', confine: true,
          formatter: ps => {
            const yr = ps[0].axisValue;
            let s = '<b>' + yr + ' 年</b><br/>';
            ps.forEach(p => {
              const r = results[p.seriesIndex];
              const rec = srcYears(r).find(y => y.year === yr);
              s += p.marker + p.seriesName + '：<b>' + (p.value != null ? fmt(p.value, 0) : '—') + '</b> 元' + (rec ? '' : '<span style="color:var(--sub)">（该年无分红）</span>') + '<br/>';
            });
            return s;
          },
        }),
        legend: { textStyle: { color: '#8fa69c', fontSize: 11 }, top: 0, left: 0, orient: 'horizontal', type: 'plain', itemWidth: 18, itemHeight: 10, formatter: shortName },
        grid: { left: 54, right: 14, top: 34, bottom: 24 },
        xAxis: Object.assign({ type: 'category', data: yrsAll }, AXIS, { axisLabel: Object.assign({}, AXIS.axisLabel, { interval: yearLabelStep > 1 ? yearLabelStep : 'auto' }) }),   // M6: 只抽刻度标签，数据全量
        yAxis: axY({ axisLabel: { formatter: v => v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v } }),
        series: results.filter(r => !r.divMissing).map((r, i) =>   {   // v1.8.13 BUG-4: 数据暂缺标的曲线不画（表格仍灰显展示）
          const m = {};
          srcYears(r).forEach(y => { m[y.year] = y.divTotal; });
          return {
            name: r.it.name, type: 'bar', barGap: '10%',
            data: yrsAll.map(yr => m[yr] != null ? Math.round(m[yr]) : 0),   // M2: 空分红年=0柱（同起点买入，没分=真没分）
            itemStyle: { color: CMP_COLORS[i % 5], borderRadius: [3, 3, 0, 0] },
          };
        }),
      });
      const tEl = $('#cmpAnnualModeTitle'); if (tEl) tEl.textContent = mode === 'report' ? '报告期' : '到账年';
      window.fitLegendTop(chA, $('#cmpChartAnnual'), 34);
    };
    renderCmpAnnual('pay');
    document.querySelectorAll('input[name=cmpAnnualMode]').forEach(el => el.onchange = () => renderCmpAnnual(el.value));   // 口径开关（与回测页 divMode 同款）
    // B3：股息率逐年折线（报告期归组 ÷ 年末价，替代单值柱状；多标的多线）
    const ch2 = cmpEnsureChart('cmpChartYield');
    const yieldYearsAll = [...new Set(results.flatMap(r => (r.yieldSeries || []).map(p => p.y)))].sort();
    ch2.setOption({
      backgroundColor: 'transparent', tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', confine: true, valueFormatter: v => v != null ? v.toFixed(2) + '%' : '—' }),
      legend: { textStyle: { color: '#8fa69c', fontSize: 11 }, top: 0, left: 0, orient: 'horizontal', type: 'plain', itemWidth: 22, itemHeight: 12, formatter: shortName },
      grid: { left: 54, right: 14, top: 34, bottom: 24 },
      xAxis: Object.assign({ type: 'category', data: yieldYearsAll }, AXIS, { axisLabel: Object.assign({}, AXIS.axisLabel, { interval: yieldYearsAll.length > 10 ? Math.ceil(yieldYearsAll.length / 8) : 'auto' }) }),   // v1.8.4 大师 M5：25 年份(2002-2026)窄屏必重叠，显式抽稀兜底
      yAxis: axY({ axisLabel: { formatter: v => v + '%' } }),
      series: results.filter(r => !r.divMissing).map((r, i) =>   ({   // v1.8.13 BUG-4: 数据暂缺标的曲线不画（表格仍灰显展示）
        name: r.it.name, type: 'line', showSymbol: true, symbol: CMP_SYMBOLS[i % 5], symbolSize: 5,
        data: yieldYearsAll.map(yy => { const p = (r.yieldSeries || []).find(p => p.y === yy); return p ? (p.v != null ? +p.v.toFixed(2) : null) : null; }),
        lineStyle: { width: 2, color: CMP_COLORS[i % 5], type: 'solid' },
        itemStyle: { color: CMP_COLORS[i % 5] },
      })),
    });
    window.fitLegendTop(ch2, $('#cmpChartYield'), 34);   // v1.8.4 大师 M2：统一全局实现
    // 表格（B4：股息率两列=近2财年+逐年；B8：表头排序；B10：存续年限；C8：类型标签）
    cmpResults = results;
    renderCmpTable();
    $('#cmpNote').textContent = '本金 ' + fmt(principal, 0) + ' 元 · ' + (reinvest ? '复投' : '不复投') + ' · ' + (monthly > 0 ? '月供 ' + fmt(monthly, 0) + ' 元/月（每月首交易日追加，首月不追）' : '零月供') + (results.some(r => /ETF|指数|红利/.test(r.it.name)) ? '｜⚠️ ETF/指数：若累计分红显示 0，为分红数据源暂缺或获取失败（已接入基金公告源）' : '') + '｜每年分红=到账年口径（与累计分红一致）；股息率=报告期归组÷年末价（逐年），2026 年数据截至 ' + results[0].res.final.lastDate;
    // URL 记忆（B2/B1：本金进 p、复投进 r；v1.7.3 月供进 m；v1.7.4 严格同期进 s）
    const q = new URLSearchParams(location.search);
    q.set('cmp', cmpState.list.map(x => x.market ? x.code + '.' + x.market.toUpperCase() : x.code).join(','));   // C2: 指数带后缀进 URL
    q.set('y', y);
    q.set('d', cmpState.startDate || '');   // v1.8.11 大师 M3：起始日期精确值（空则恢复时用 y）
    q.set('m', monthly);
    q.set('p', principal);
    q.set('r', reinvest ? '1' : '0');
    q.set('s', strictSameStart ? '1' : '0');
    q.set('v', APP_VERSION);
    history.replaceState(null, '', location.pathname + '?' + q.toString());
    } finally {
      cmpState.running = false;   // v1.9.1 O2：释放运行锁
    }
  }

  function renderCompare() {
    // ETF 快捷 chips
    const ec = $('#cmpEtfChips');
    if (ec) {
      ec.innerHTML = DL.ETF_PRESETS.slice(0, 8).map(p =>
        `<button type="button" class="chip" data-c="${p.code}${p.market ? '.' + p.market.toUpperCase() : ''}">${p.name}</button>`).join('');   // C2: 指数 chip 带 .SH
      // v1.9.5：chips 点击直接传对象（本地预设零网络）——原传字符串走 cmpResolveCode 网络+_cmpSeq 竞态，
      // 快速连点多个时慢请求被丢弃（东财限流时实测 3 连点只加 1 个）；对象直传同步渲染无此问题
      ec.querySelectorAll('[data-c]').forEach(b => b.onclick = () => {
        const p = DL.ETF_PRESETS.find(x => (x.code + (x.market ? '.' + x.market.toUpperCase() : '')) === b.dataset.c);
        if (p) cmpAdd(p);
      });
    }
    // 周期 chips + 起始日期输入联动（v1.8.11 大师 M1/M3/M5：日期输入替代自定义年；实时反馈行；min/max 约束）
    const cy = $('#cmpYears');
    const setPeriodNote = () => {
      const pn = $('#cmpPeriodNote');
      if (!pn) return;
      if (cmpState.startDate) {
        const days = Math.max(0, Math.round((new Date(DL.todayStr()) - new Date(cmpState.startDate)) / 86400000));
        pn.textContent = '自 ' + cmpState.startDate + ' 起 · 约 ' + (days / 365.25).toFixed(1) + ' 年';
      } else {
        pn.textContent = '近 ' + cmpState.years + ' 年（自 ' + new Date(Date.now() - cmpState.years * 366 * 86400000).toISOString().slice(0, 10) + ' 起）';
      }
    };
    if (cy) {
      cy.querySelectorAll('button').forEach(b => b.onclick = () => {
        cmpState.years = +b.dataset.y;
        cmpState.startDate = null;
        const di = $('#cmpStartDate'); if (di) di.value = '';
        cy.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        setPeriodNote();
      });
      const di = $('#cmpStartDate');
      if (di) {
        // M5：min=今天-30年，max=今天（源头挡未来日期/超长周期）
        di.max = DL.todayStr();
        di.min = new Date(Date.now() - 30 * 366 * 86400000).toISOString().slice(0, 10);
        di.addEventListener('change', () => {
          const v = di.value;
          if (!v) { cmpState.startDate = null; setPeriodNote(); return; }
          if (v > di.max) { alert('起始日期不能晚于今天'); di.value = ''; cmpState.startDate = null; setPeriodNote(); return; }
          cmpState.startDate = v;
          cy.querySelectorAll('button').forEach(x => x.classList.toggle('on', false));
          setPeriodNote();
        });
      }
      setPeriodNote();
    }
    const addBtn = $('#btnCmpAdd');
    if (addBtn) addBtn.onclick = () => cmpAdd($('#cmpInput').value);
    const inp = $('#cmpInput');
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') cmpAdd(inp.value); });
    const runBtn = $('#btnCmpRun');
    if (runBtn) runBtn.onclick = cmpRun;
    cmpRenderList();
    // URL 恢复（?cmp=512890,600036&y=5&m=5000&s=0&v=...）
    const params = new URLSearchParams(location.search);
    const cmp = params.get('cmp');
    const m = params.get('m');
    if (m && parseFloat(m) >= 0) {
      const mi = $('#cmpMonthly');
      if (mi) mi.value = m;
    }
    const p = params.get('p');   // B2: 本金 URL 记忆
    if (p && parseFloat(p) > 0) {
      const pi = $('#cmpPrincipal');
      if (pi) pi.value = p;
    }
    const r = params.get('r');   // B1: 复投 URL 记忆
    if (r === '1' || r === '0') {
      const ri = $('#cmpReinvest');
      if (ri) ri.checked = (r === '1');
    }
    const s = params.get('s');
    if (s === '1' || s === '0') {
      const sc = $('#cmpStrict');
      if (sc) sc.checked = (s === '1');
    }
    // v1.8.11 大师 M3：URL 规则——d（起始日期）优先于 y（年数）；非法/未来 d 回退 y=10；y 不在快捷集时按钮全不亮+日期回填
    const dParam = params.get('d');
    const y = parseInt(params.get('y'), 10);
    let dValid = false;
    if (dParam) {
      const today = DL.todayStr();
      const minD = new Date(Date.now() - 30 * 366 * 86400000).toISOString().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dParam) && dParam <= today && dParam >= minD) {
        cmpState.startDate = dParam;
        dValid = true;
        const di3 = $('#cmpStartDate'); if (di3) di3.value = dParam;
        const cy3 = $('#cmpYears');
        if (cy3) cy3.querySelectorAll('button').forEach(b => b.classList.toggle('on', false));
        setPeriodNote();
      } else {
        cmpState.years = 10;   // 非法/未来 d：toast + 回退 y=10
        const st3 = $('#status');
        if (st3) { st3.textContent = '⚠️ 分享链接的起始日期无效（' + dParam + '），已回退为近 10 年'; st3.className = 'status err'; }
      }
    }
    if (!dValid && y && y >= 1 && y <= 30) {
      cmpState.years = y;
      const cy2 = $('#cmpYears');
      if (cy2) {
        cy2.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.y === y));
        if (![1, 3, 5, 10].includes(y)) {
          // M3-③：y 非快捷集（如老链接 y=15/20）→ 按钮全不亮，日期输入回填计算出的日期
          const di2 = $('#cmpStartDate');
          if (di2) di2.value = new Date(Date.now() - y * 366 * 86400000).toISOString().slice(0, 10);
        }
      }
      setPeriodNote();
    }
    // O4（2026-08-18 大师排序第二）：对比页预填自选（前 5 只；URL cmp 参数优先时不预填——分享链接只显示 URL 标的）
    if (!cmpState.list.length && !params.get('cmp')) {
      try {
        const wl = DL.Watchlist.list();
        if (wl.length) { cmpState.list = wl.slice(0, 5).map(x => ({ code: x.code, name: x.name || x.code })); cmpRenderList(); }
      } catch (e) { }
    }
    if (cmp) {
      const ver = params.get('v');
      if (ver && ver !== APP_VERSION) { const st = $('#status'); if (st) { st.textContent = '⚠️ 分享链接版本旧（' + ver + '），当前 ' + APP_VERSION + '，请重新对比生成新链接'; st.className = 'status err'; } }
      const codes = cmp.split(',').filter(Boolean);
      (async () => {
        for (const c of codes) { await cmpAdd(c); }
        await cmpRun();
      })();
    }
  }

  /* ---------- 工具：ETF 预设（决策台空状态推荐） ---------- */
  function ETF_PRESETS() { return DL.ETF_PRESETS; }

  /* 添加自选（带快照：股息率基线） */
  async function addToWatchlist(code) {
    try {
      const name = await DL.fetchName(code);
      // BUG修复(2026-08-18 实战发现)：homeState.snap || 复用导致第2只以后全部取不到报价→股息率"待数据"
      // 每次强制拉当前代码报价，并合并进已有 snap（旧股价格缓存保留）
      const fresh = await DL.getStockQuotes([code]);
      const snap = Object.assign({}, homeState.snap || {}, fresh);
      homeState.snap = snap;
      const s = snap[code];
      let divYield = null, price = s ? s.price : null;
      try {
        const divs = await DL.fetchDividendsOne(code);
        // v1.7.4 P7：年化股息率按报告期归组（近2报告年度平均÷现价）
        const dy = DL.calcAnnualDivYield(divs, price);
        if (dy) divYield = dy.yieldPct;
      } catch (e) { }
      await DL.Watchlist.add(code, name, { divYield, price, dps: divYield != null ? divYield * price / 100 : null, at: Date.now() });
      renderHome();
      return true;
    } catch (e) {
      alert('添加失败：' + e.message);
      return false;
    }
  }

  /* v1.9.4 统一加自选入口（A/B/C 三处共用）：去重检测 + 统一 toast 反馈 */
  let _toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:rgba(20,20,26,.95);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:80vw;transition:opacity .3s';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }
  async function addToWatchlistUI(code, goDiag) {
    const wl = await DL.Watchlist.list();
    if (wl.some(x => x.code === code)) { toast('已在自选中：' + code); if (goDiag) openDiagnose(code); return; }
    const ok = await addToWatchlist(code);
    if (ok) { toast('已加入自选：' + code); if (goDiag) openDiagnose(code); }
  }
  /* B 入口：诊断页标题 ⭐ 加自选 / ✓ 已自选 切换（已自选态可取消，取消需 confirm） */
  async function updateDiagWlBtn(code, seq) {
    const b = document.getElementById('diagWlBtn');
    if (!b) return;
    const wl = await DL.Watchlist.list();
    if (seq !== diagSeq) return;   // 竞态：旧请求丢弃
    const inWl = wl.some(x => x.code === code);
    b.textContent = inWl ? '✓ 已自选' : '⭐ 加自选';
    b.style.display = 'inline-block';
    b.onclick = async () => {
      if (inWl) {
        if (!confirm('取消自选：' + code + '？')) return;
        await DL.Watchlist.remove(code);
        toast('已取消自选：' + code);
        renderHome();
        updateDiagWlBtn(code, seq);
      } else {
        await addToWatchlistUI(code, false);
        updateDiagWlBtn(code, seq);
      }
    };
  }

  /* ---------- 初始化 ---------- */
  /* v1.9.2 组合级回测 tab：拉取自选池 → 算 series → calcPortfolioBacktest → 策略对比表
   * v1.9.3-D：金字塔模拟器升级——自定义档位方案（档位:权重% 输入）加入对比 */
  let _pfbtRunning = false;
  let _pfbtCustom = [];   // 自定义方案列表 [{ name, desc, tiers }]
  function parseCustomTiers(str) {
    const parts = (str || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const tiers = [];
    for (const p of parts) {
      const m = p.match(/^(\d{2,3})\s*[:：]\s*(\d{1,3})$/);
      if (!m) return null;
      const pct = parseInt(m[1], 10), w = parseInt(m[2], 10);
      if (pct < 60 || pct > 100 || w <= 0) return null;
      tiers.push({ pct, frac: w / 100 });
    }
    if (!tiers.length) return null;
    return tiers;
  }
  function renderCustomList() {
    const el = $('#pfbtCustomList');
    if (!el) return;
    el.innerHTML = _pfbtCustom.length
      ? '已加入：' + _pfbtCustom.map((c, i) => `<span style="margin-right:8px">${c.name}（${c.desc}）<a href="javascript:void(0)" data-rm="${i}" style="color:#e05a5a">✕</a></span>`).join('')
      : '未加入自定义方案（只用内置 4 策略）';
    el.querySelectorAll('[data-rm]').forEach(a => a.onclick = () => { _pfbtCustom.splice(parseInt(a.dataset.rm, 10), 1); renderCustomList(); });
  }
  async function runPortfolioBacktest() {
    const el = $('#pfbtResult');
    if (!el || _pfbtRunning) return;
    const wl = (homeState.watchlist && homeState.watchlist.length) ? homeState.watchlist : await DL.Watchlist.list();
    if (!wl.length) {
      // v1.9.4 C 入口：空态升级——错误文案 + 内联快捷添加 + 去决策台按钮
      el.innerHTML = `<div class="hint err" style="margin-bottom:8px">自选为空：搜索代码 → 点➕ 加自选，或使用下方快捷添加</div>` +
        `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">` +
        `<input id="pfbtQuickCode" type="text" placeholder="输入 6 位股票代码" maxlength="6" style="width:150px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt)">` +
        `<button type="button" class="btn" id="pfbtQuickAdd">➕ 加自选</button>` +
        `<button type="button" class="btn" id="pfbtGoHome">🏠 去决策台添加</button>` +
        `</div>`;
      const qc = document.getElementById('pfbtQuickCode');
      const qa = document.getElementById('pfbtQuickAdd');
      const gh = document.getElementById('pfbtGoHome');
      const quickAdd = async () => {
        const v = (qc.value || '').trim();
        if (!/^\d{6}$/.test(v)) { toast('请先输入 6 位股票代码'); return; }
        await addToWatchlistUI(v, false);
        const wl2 = await DL.Watchlist.list();
        if (wl2.length) {
          el.innerHTML = `<div class="hint" style="color:#7ec699">✅ 已加入自选：${v}（当前 ${wl2.length} 只）。点上方“▶ 运行组合回测”开始。</div>` +
            `<div style="margin-top:8px"><button type="button" class="btn" id="pfbtGoHome">🏠 去决策台添加更多</button></div>`;
          const gh2 = document.getElementById('pfbtGoHome');
          if (gh2) gh2.onclick = () => { switchTab('home'); const s = document.getElementById('homeSearch'); if (s) s.focus(); };
        }
      };
      if (qa) qa.onclick = quickAdd;
      if (qc) qc.addEventListener('keydown', e => { if (e.key === 'Enter') quickAdd(); });
      if (gh) gh.onclick = () => { switchTab('home'); const s = document.getElementById('homeSearch'); if (s) s.focus(); };
      return;
    }
    _pfbtRunning = true;
    const btn = $('#pfbtRun');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 回测中…'; }
    // 区间
    const y = parseInt((document.querySelector('.pfbt-y.on') || {}).dataset && document.querySelector('.pfbt-y.on').dataset.y || '5', 10);
    try {
      el.innerHTML = `<div class="hint">⏳ 拉取 ${wl.length} 只自选 K线+分红（批处理 5 并发）…</div>`;
      const from = new Date(Date.now() - y * 366 * 86400000).toISOString().slice(0, 10);
      const pool = [];
      for (let i = 0; i < wl.length; i += 5) {
        const batch = wl.slice(i, i + 5);
        await Promise.all(batch.map(async (c) => {
          try {
            const [divs, kline] = await Promise.all([DL.fetchDividendsOne(c.code), DL.getKline(c.code, from, DL.todayStr())]);
            if (!divs || !divs.length || !kline || !Object.keys(kline).length) return;
            const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
            pool.push({ code: c.code, name: c.name || c.code, series, kline, divs });
          } catch (e) { /* 跳过 */ }
        }));
        el.innerHTML = `<div class="hint">⏳ 拉取进度：${Math.min(i + 5, wl.length)}/${wl.length}…</div>`;
      }
      if (!pool.length) { el.innerHTML = '<div class="hint err">无有效数据</div>'; return; }
      el.innerHTML = `<div class="hint">⏳ 回测计算中（${pool.length} 只）…</div>`;
      await new Promise(r => setTimeout(r, 50));   // 让 UI 刷新
      const res = DL.calcPortfolioBacktest(pool, { years: y, customTiers: _pfbtCustom });
      let html = `<div class="hint">✅ 组合回测完成：${pool.length} 只自选 · 近 ${y} 年 · 标的等权 · 含分红（近似再投）${_pfbtCustom.length ? ' · 含 ' + _pfbtCustom.length + ' 个自定义方案' : ''}</div>`;
      html += '<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:6px"><tr style="color:var(--muted)"><th style="text-align:left;padding:4px">策略</th><th>总收益</th><th>年化</th><th>最大浮亏</th><th>事件胜率</th><th>触发事件</th></tr>';
      res.forEach(r => {
        const retC = r.ret != null ? (r.ret >= 0 ? 'green' : 'red') : '';
        html += `<tr><td style="padding:4px"><b>${r.name}</b><div style="font-size:10px;color:var(--muted)">${r.desc}</div></td>
          <td style="text-align:center" class="${retC}">${r.ret != null ? r.ret.toFixed(1) + '%' : '—'}</td>
          <td style="text-align:center">${r.annual != null ? r.annual.toFixed(1) + '%' : '—'}</td>
          <td style="text-align:center" class="red">${r.mdd != null ? '-' + Math.abs(r.mdd).toFixed(1) + '%' : '—'}</td>
          <td style="text-align:center">${r.winRate != null ? r.winRate.toFixed(0) + '%' : '—'}</td>
          <td style="text-align:center">${r.events}</td></tr>`;
      });
      html += '</table>';
      // 结论行：推荐风险效率最高（收益/|浮亏|）的策略
      const best = res.filter(r => r.ret != null && r.mdd != null).sort((a, b) => (a.ret / Math.max(0.01, Math.abs(a.mdd))) - (b.ret / Math.max(0.01, Math.abs(b.mdd))))[res.filter(r => r.ret != null).length - 1];
      /* P4（2026-08-18 大师裁决）：动态行情语境标注（按行业构成；位置=价格收益结论行）
       * 治标：结论带语境防"闭眼全仓吊打策略"误导；治本=行情分段回测（backlog） */
      let ctxNote = '';
      try {
        const snapAll = await DL.cacheGet('snap:all');
        if (snapAll) {
          let finN = 0;
          wl.forEach(it => { const x = snapAll[it.code]; if (x && x.industry && (DL.industryOf(x.industry) === 'bank' || DL.industryOf(x.industry) === 'insurer')) finN++; });
          if (wl.length && finN / wl.length >= 0.5) ctxNote = `🧭 行情语境：标的池金融权重高（银行/保险 ${finN}/${wl.length}）——${y} 年窗口下银行单边行情时买入持有天然占优，策略差异被压缩；建议切 5年/10年 看不同形态`;
        }
      } catch (e) { }
      if (best) html += `<div class="hint" style="margin-top:6px">📌 风险效率最优：<b>${best.name}</b>（收益 ${best.ret.toFixed(1)}% / 浮亏 -${Math.abs(best.mdd).toFixed(1)}% · 每亏 1% 赚 ${(best.ret / Math.max(0.01, Math.abs(best.mdd))).toFixed(2)}%）。⚠️ 结论基于“买入持有”口径（策略买入→持有至今，未计卖出/再平衡）；历史回测不代表未来，仅验证规则方向。</div>`;
      if (ctxNote) html += `<div class="hint" style="margin-top:4px;color:var(--sub)">${ctxNote}</div>`;
      html += '<div class="hint">口径：事件首日买入（分位≥档位的连续区间）→ 持有至今；收益=期末价+期间分红÷买入价；组合=标的<u>等权</u>（与组合总览卡的“档位权重”口径不同）；含分红近似再投。策略规则没变就不用重跑。</div>';
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = `<div class="hint err">组合回测失败：${e.message}</div>`;
    } finally {
      _pfbtRunning = false;
      if (btn) { btn.disabled = false; btn.textContent = '▶ 运行组合回测'; }
    }
  }

  /* O5b：持仓可选录入（M41 Q2/M43 Q4）——localStorage 存储（敏感数据不进 git）
   * 字段：代码/股数/成本价/买入日期；录入则组合页真实数据，未录则静态样例兜底 */
  const HOLD_KEY = 'divtool_holdings_v1';
  function loadHoldings() { try { return JSON.parse(localStorage.getItem(HOLD_KEY)) || []; } catch (e) { return []; } }
  function saveHoldings(h) { localStorage.setItem(HOLD_KEY, JSON.stringify(h)); }
  function renderHoldingsEditor() {
    const el = $('#pfSample');
    if (!el) return;
    const holds = loadHoldings();
    const rowsHtml = holds.map((h, i) => `
      <tr style="border-top:1px solid var(--line)">
        <td style="padding:3px"><b>${h.name || h.code}</b></td>
        <td style="text-align:center">${h.code}</td>
        <td style="text-align:center">${h.shares}</td>
        <td style="text-align:center">${h.cost != null ? h.cost.toFixed(2) : '—'}</td>
        <td style="text-align:center">${h.date || '—'}</td>
        <td style="text-align:center"><button type="button" class="chip" data-rm="${i}" style="color:#e05a5a">✕</button></td>
      </tr>`).join('');
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:12px;font-weight:700">📊 我的持仓（${holds.length ? '已录入 ' + holds.length + ' 只' : '可选录入·未录则显示静态样例'}）</div>
        <div style="font-size:10px;color:var(--muted)">数据存本地 · 不进仓库</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;font-size:11px">
        <input id="holdCode" placeholder="代码" maxlength="6" style="width:70px;padding:4px 6px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt)">
        <input id="holdShares" placeholder="股数" type="number" style="width:80px;padding:4px 6px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt)">
        <input id="holdCost" placeholder="成本价" type="number" step="0.01" style="width:80px;padding:4px 6px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt)">
        <input id="holdDate" placeholder="买入日期 YYYY-MM-DD" style="width:130px;padding:4px 6px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt)">
        <button type="button" class="btn flexbtn" id="holdAdd">➕ 录入</button>
        ${holds.length ? '<button type="button" class="chip" id="holdClear" style="color:#e05a5a">清空</button>' : ''}
      </div>
      ${holds.length ? `<table style="width:100%;font-size:11px;border-collapse:collapse"><tr style="color:var(--muted)"><th style="text-align:left;padding:3px">名称</th><th>代码</th><th>股数</th><th>成本</th><th>买入日</th><th></th></tr>${rowsHtml}</table>` : ''}
      <div class="hint" style="margin-top:6px">${holds.length ? '已录入持仓 → 下方组合总览用真实股数计算' : '未录入 → 下方显示静态样例（研究数据 2026-08-18）'}</div>`;
    const addBtn = document.getElementById('holdAdd');
    if (addBtn) addBtn.onclick = async () => {
      const code = document.getElementById('holdCode').value.trim();
      const shares = parseFloat(document.getElementById('holdShares').value);
      const cost = parseFloat(document.getElementById('holdCost').value);
      const date = document.getElementById('holdDate').value.trim();
      // Q4（M44）：数据校验——代码格式/股数>0/日期合法/代码存在
      if (!/^\d{6}$/.test(code)) { toast('请输入 6 位代码'); return; }
      if (!(shares > 0) || !isFinite(shares)) { toast('股数必须 >0'); return; }
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('日期格式 YYYY-MM-DD'); return; }
      let name = code;
      try {
        const n = await DL.fetchName(code);
        if (n && n !== code) name = n;
        else { toast('代码不存在或无法识别'); return; }
      } catch (e) { toast('代码校验失败'); return; }
      const holds2 = loadHoldings();
      if (holds2.some(h => h.code === code)) { toast('该代码已录入'); return; }
      holds2.push({ code, name, shares, cost: cost > 0 ? cost : null, date: date || null });
      saveHoldings(holds2);
      renderHoldingsEditor();
      renderPortfolioSample();
    };
    const rmBtns = el.querySelectorAll('[data-rm]');
    rmBtns.forEach(b => b.onclick = () => {
      const i = parseInt(b.dataset.rm, 10);
      const h2 = loadHoldings(); h2.splice(i, 1); saveHoldings(h2);
      renderHoldingsEditor(); renderPortfolioSample();
    });
    const clearBtn = document.getElementById('holdClear');
    if (clearBtn) clearBtn.onclick = () => { saveHoldings([]); renderHoldingsEditor(); renderPortfolioSample(); };
  }

  /* O4：组合静态样例页（M27 方案 C）——6 只持仓一行一卡，静态原型·数据 2026-08-18
   * 与 M24 组合级发现对照：三档结构（可买4 vs 等更低2）、金融集中度 3/6 */
  function renderPortfolioSample() {
    const el = $('#pfSample');
    if (!el) return;
    const holds = loadHoldings();
    if (holds.length) {
      // 有录入 → 渲染录入持仓卡（真实股数），静态样例作为下方参考
      const rowsHtml = holds.map(h => {
        const indKey = null;
        const v = DL.verdictEngine({ coverage: null, reserveYears: null, payoutRate: null, dps: 0, dy: null, pct: null, industry: indKey });
        return `<tr style="border-top:1px solid var(--line)">
          <td style="padding:4px"><b>${h.name || h.code}</b><div style="font-size:9px;color:var(--muted)">${h.code}</div></td>
          <td style="text-align:center">${h.shares}</td>
          <td style="text-align:center">${h.cost != null ? h.cost.toFixed(2) : '—'}</td>
          <td style="text-align:center">${h.date || '—'}</td>
          <td style="text-align:center;font-size:10px;color:var(--muted)">点诊断页看报告卡</td>
        </tr>`;
      }).join('');
      el.innerHTML += `<div class="card" style="margin-top:8px">
        <div style="font-size:12px;font-weight:700">📊 组合总览（已录入 ${holds.length} 只）</div>
        <table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px"><tr style="color:var(--muted)"><th style="text-align:left;padding:4px">标的</th><th>股数</th><th>成本</th><th>买入日</th><th>提示</th></tr>${rowsHtml}</table>
        <div class="hint" style="margin-top:4px">逐只诊断请到诊断页（报告卡+三档买点）；组合级计算（现金流/回本）随持仓模块完整落地</div>
      </div>`;
    }
    const rows = [
      /* Q3（M39）：风险列与报告卡引擎⑤同源（roeTrend 连降 / 分红率高企判定） */
      { name: '招商银行', code: '600036', price: 38.31, dy: 5.26, cov: 2.83, reserve: 13.4, pr: 35, roe: 13.44, roeTrend: -3, ind: '银行', tiers: '小仓区', dec: '✅ 可买' },
      { name: '工商银行', code: '601398', price: 7.67, dy: 4.05, cov: 3.22, reserve: 19.7, pr: 31, roe: 9.45, roeTrend: -1, ind: '银行', tiers: '等待区', dec: '🟡 等更低' },
      { name: '伊利股份', code: '600887', price: 25.14, dy: 5.49, cov: 1.33, reserve: 3.8, pr: 75, roe: 20.87, roeTrend: 0, ind: '消费', tiers: '小仓区', dec: '✅ 可买·预警' },
      { name: '中国移动', code: '600941', price: 95.84, dy: 4.91, cov: 1.35, reserve: 12.0, pr: 74, roe: 9.90, roeTrend: -1, ind: '电信', tiers: '小仓区', dec: '✅ 可买' },
      { name: '美的集团', code: '000333', price: 83.40, dy: 5.16, cov: 1.35, reserve: 5.1, pr: 74, roe: 19.70, roeTrend: 0, ind: '消费', tiers: '小仓区', dec: '✅ 可买' },
      { name: '中国平安', code: '601318', price: 51.28, dy: 5.27, cov: 2.84, reserve: 15.7, pr: 35, roe: 14.00, roeTrend: 0, ind: '保险', tiers: '小仓区', dec: '✅ 可买' },
    ];
    const buyN = rows.filter(r => r.dec.startsWith('✅')).length;
    const waitN = rows.length - buyN;
    const finN = rows.filter(r => ['银行','保险'].includes(r.ind)).length;
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:12px;font-weight:700">📊 组合总览（静态原型）</div>
        <div style="font-size:10px;color:var(--muted)">静态原型·数据 2026-08-18 · 持仓模块拍板后自动更新</div>
      </div>
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <tr style="color:var(--muted)">
          <th style="text-align:left;padding:4px">标的</th><th>现价</th><th>股息率</th><th>覆盖</th><th>储备</th><th>分红率</th><th>ROE</th><th>档位</th><th>决策</th><th>主要风险</th>
        </tr>
        ${rows.map(r => {
          const indKey = { '银行':'bank', '消费':'consumer', '电信':'telecom', '保险':'insurer' }[r.ind];
          const v = DL.verdictEngine({ coverage: r.cov, reserveYears: r.reserve, payoutRate: r.pr/100, eps: r.roe, dps: 0, price: r.price, dy: r.dy, pct: 50, industry: indKey, roe: r.roe, roeTrend: r.roeTrend, dividendCagr: 0.05 });
          return `<tr style="border-top:1px solid var(--line)">
          <td style="padding:4px"><b>${r.name}</b><div style="font-size:9px;color:var(--muted)">${r.code} · ${r.ind}</div></td>
          <td style="text-align:center">${r.price.toFixed(2)}</td>
          <td style="text-align:center">${r.dy.toFixed(2)}%</td>
          <td style="text-align:center">${r.cov.toFixed(2)}</td>
          <td style="text-align:center">${r.reserve.toFixed(1)}年</td>
          <td style="text-align:center">${r.pr}%</td>
          <td style="text-align:center">${r.roe.toFixed(1)}%</td>
          <td style="text-align:center">${r.tiers}</td>
          <td style="text-align:center">${r.dec}</td>
          <td style="text-align:center;font-size:10px;color:var(--muted)">${v.q3.msg}</td>
        </tr>`;
        }).join('')}
      </table>
      <div class="hint" style="margin-top:6px">组合结构：可买 ${buyN} 只 vs 等更低 ${waitN} 只 · 金融集中度 ${finN}/6（50%）· 分红安全分层：招行/工行/平安覆盖 2.8-3.2 倍 vs 伊利/移动/美的 1.3 倍</div>`;
  }

  window.addEventListener('DOMContentLoaded', () => {
    bindTabs();
    // v1.9.18 S2：启动异步拉取国债正式源（中国货币网官方接口），成功后若有打开的诊断卡则重渲染（线值随国债锚变化）
    // 注意：必须在 bindTabs 之后调用（防异常打断初始化），且 DL.refreshTreasury 已导出
    try {
      if (typeof DL.refreshTreasury === 'function') {
        DL.refreshTreasury().then(r => {
          if (r && typeof diagCode === 'string' && diagCode) {
            try { openDiagnose(diagCode, diagYears); } catch (e) { }
          }
        });
      }
    } catch (e) { }
    renderHoldingsEditor();
    renderPortfolioSample();
    renderCompare();
    // 搜索：输入6位代码 → 进诊断；支持名称
    const search = $('#homeSearch');
    if (search) {
      search.addEventListener('keydown', async e => {
        if (e.key === 'Enter') {
          const v = search.value.trim();
          if (/^\d{6}$/.test(v)) { openDiagnose(v); return; }
          if (v.length >= 2) {
            try {
              const d = await DL.jsonp('https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(v) + '&type=14&count=3', 'cb');
              const list = d && d.QuotationCodeTable && d.QuotationCodeTable.Data || [];
              if (list.length) { openDiagnose(list[0].Code); return; }
            } catch (err) { }
          }
          alert('请输入 6 位股票代码');
        }
      });
    }
    // v1.9.4 A 入口：决策台搜索框 ➕ 加自选（输入代码直接加，加了就进诊断）
    const homeSearchAdd = $('#homeSearchAdd');
    if (homeSearchAdd) homeSearchAdd.onclick = async () => {
      const v = ($('#homeSearch') || {}).value ? $('#homeSearch').value.trim() : '';
      if (!/^\d{6}$/.test(v)) { toast('请先输入 6 位股票代码'); return; }
      await addToWatchlistUI(v, true);
    };
    const btnScan = $('#btnScan');
    if (btnScan) btnScan.onclick = runScanner;
    const btnDiscover = $('#btnDiscover');
    if (btnDiscover) btnDiscover.onclick = runDiscoverer;
    // v1.9.2：组合回测 tab 绑定（区间 chips + 运行按钮）
    const pfbtRun = $('#pfbtRun');
    if (pfbtRun) pfbtRun.onclick = runPortfolioBacktest;
    const pfbtAdd = $('#pfbtCustomAdd');
    if (pfbtAdd) pfbtAdd.onclick = () => {
      const v = ($('#pfbtCustom') || {}).value || '';
      const tiers = parseCustomTiers(v);
      if (!tiers) { alert('格式：档位:权重%，逗号分隔，如 80:33,85:33,90:34（档位 60-100，权重 1-100）'); return; }
      _pfbtCustom.push({ name: '自定义' + (_pfbtCustom.length + 1), desc: tiers.map(t => t.pct + '档 ' + Math.round(t.frac * 100) + '%').join(' / '), tiers });
      $('#pfbtCustom').value = '';
      renderCustomList();
    };
    document.querySelectorAll('.pfbt-preset').forEach(b => b.onclick = () => {
      const tiers = parseCustomTiers(b.dataset.p);
      if (!tiers) return;
      _pfbtCustom.push({ name: b.textContent, desc: tiers.map(t => t.pct + '档 ' + Math.round(t.frac * 100) + '%').join(' / '), tiers });
      renderCustomList();
    });
    document.querySelectorAll('.pfbt-y').forEach(b => b.onclick = () => {
      document.querySelectorAll('.pfbt-y').forEach(x => x.classList.toggle('on', x === b));
    });
    const btnDiagBacktest = $('#btnDiagBacktest');
    if (btnDiagBacktest) btnDiagBacktest.onclick = () => { if (diagCode) { const input = $('#code'); if (input) input.value = diagCode; const bd = $('#buyDate'); if (bd) bd.value = new Date(Date.now() - 5 * 366 * 86400000).toISOString().slice(0, 10); switchTab('backtest'); $('#btnRun').click(); } };
    switchTab('home');
  });
})();
// v1.8.13 BUG-3：views.js 就绪标志（index.html 自动运行等此标志，不再等 window load——load 依赖 echarts CDN 速度）
window.__viewsReady = true;
(window.__viewsReadyCallbacks || []).forEach(function (f) { try { f(); } catch (e) { } });
