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
  /* ===== v3.0 动效层公共函数（数字滚动/卡片进场/决策渐入/骨架屏） ===== */
  function v3CountUp(el, target, opts) {
    /* 数字滚动：从 0 滚到目标值（只用于关键数字，防晕） */
    if (!el) return;
    opts = opts || {};
    const dur = opts.dur || 700, dec = opts.dec || 0;
    const t0 = performance.now();
    const step = now => {
      const p = Math.min(1, (now - t0) / dur);
      const ease = 1 - Math.pow(1 - p, 3);
      el.textContent = (target * ease).toFixed(dec);
      if (p < 1) requestAnimationFrame(step);
    };
    try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = target.toFixed(dec); return; } } catch (e) {}
    requestAnimationFrame(step);
  }
  function v3CardIn(el) { if (el) el.classList.add('v3-card'); }
  function v3StepIn(el, delay) { if (el) { el.classList.add('v3-step'); el.style.animationDelay = (delay || 0) + 'ms'; } }
  function v3Flash(el, up) { if (el) { el.classList.remove('v3-flash-up', 'v3-flash-down'); void el.offsetWidth; el.classList.add(up ? 'v3-flash-up' : 'v3-flash-down'); } }
  function v3Skeleton(el, h) { if (el) el.innerHTML = `<div class="v3-skeleton" style="height:${h || 60}px"></div>`; }
  /* ===== v3.0 L7-L10：本地 AI 可选层（默认关，模型不绑死，模板+模型混合防胡说） ===== */
  function localAIEnabled() { try { return getParam('localAI') === true || getParam('localAI') === 'true'; } catch (e) { return false; } }
  function localModelName() { try { const m = getParam('localModel'); return m && m !== 'custom' ? m : 'qwen3.5:9b-mlx'; } catch (e) { return 'qwen3.5:9b-mlx'; } }
  async function localAIExplain(template, opts) {
    /* 模板保证数字准确，模型只润色语气；Ollama 离线/超时/失败→回退模板 */
    if (!localAIEnabled()) return template;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: localModelName(), prompt: '用一句人话总结以下投资体检数据（不要改数字，不要编造）：' + template, stream: false, options: { temperature: 0.3 } }),
      });
      clearTimeout(to);
      if (!r.ok) return template;
      const j = await r.json();
      const t = (j.response || '').trim();
      return t ? t : template;
    } catch (e) { return template; }
  }



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
    /* P81（2026-08-21）：回决策台清 ?diag= URL（诊断态才保留分享参数） */
    if (name === 'home') { try { history.replaceState({}, '', location.pathname); } catch (e) {} }
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
    /* v3.2 S2：切到驾驶舱，若结果区为空且有自动快照 → 秒出加载（刷新不丢结果） */
    if (name === 'pfbt') {
      (async () => {
        try {
          const el = $('#pfbtResult');
          if (el && !el.dataset.loaded && !_pfbtRunning) {
            const c = DL.loadCombos();
            const sel = $('#pfbtComboSel');
            const activeId = sel && sel.value ? sel.value : c.activeId;
            if (activeId) {
              const snap = await btLoadAuto(activeId);
              if (snap && snap.full.res) {
                el.dataset.loaded = '1';
                const combo = snap.full.combo;
                const meta = { modeTxt: snap.meta.mode === 'weight' ? '按初始权重分配' : snap.meta.mode === 'fixed' ? '每只固定' : '智慧定投（按分位）', cacheNote: '', failed: [], cashTxt: '' };
                renderCockpit(snap.full.res, combo, {}, meta);
                btSnapNotice(snap.meta);
              }
            }
          }
        } catch (e) { }
      })();
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
    renderOnboard();   // X11/P45：三步引导状态机（无自选→搜代码；有自选→看诊断记决策；有持仓→消失）
    renderDailyBar();  // B4/K8（2026-08-21）：今日变化条（快照对比，首日明日起可见）
    renderDataHealth(); // v2.0 #9：异常分级（major横幅/mid标注/minor小字）
    renderCaliberPanel(); // v2.0 #6：?debug=caliber 口径自检
    const pt = document.getElementById('paramToggle');
    if (pt && !pt.dataset.bound) { pt.dataset.bound = '1'; pt.onclick = toggleParamPanel; }
    const wl = await DL.Watchlist.list();
    homeState.watchlist = wl;
    /* Y5/P53（2026-08-21）：高频核心打开自动刷新——行情缓存 >5 分钟强制重拉（≤10 请求防限流） */
    if (wl.length && wl.length <= 10) {
      try {
        const qk = 'qt:' + wl.map(x => x.code).join(',');
        const qh = await DL.cacheGet(qk);
        if (qh && Date.now() - qh.ts > 5 * 60000) await DL.cacheSet(qk, null);
      } catch (e) {}
    }
    renderOpportunities();
    renderWatchlist();
    renderDivCalendar();
    // v1.9.1 P2：组合建仓总览（默认折叠）
    renderPortfolio(wl);
    // v3.0：组合工作台（自由输入/组合/金额/月追加）
    renderComboCard();
    // v1.9.0：三级到价提醒（自选股分位扫描 → 横幅 + 桌面通知尽力而为）
    renderZoneBanner(wl);
    // 数据新鲜度徽标（大师补：信任）+ W10/W12（2026-08-21）：来源徽章三态（实时/缓存/降级）+ 30 天过期橙→红
    const snapHit = await DL.cacheGet('snap:all');
    const fresh = $('#wlFresh');
    if (fresh) {
      if (snapHit) {
        const mins = Math.max(0, Math.round((Date.now() - snapHit.ts) / 60000));
        const days = mins / 1440;
        const badge = days > 30
          ? `<data-badge source="expired">已过期（${Math.round(days)} 天前）</data-badge>`
          : (mins <= 5
            ? `<data-badge source="live">行情实时 · ${mins} 分钟前</data-badge>`
            : `<data-badge source="cache">行情缓存 · ${mins} 分钟前</data-badge>`);
        fresh.innerHTML = badge;
      } else { fresh.innerHTML = `<data-badge source="degraded">行情待更新</data-badge>`; }
    }
  }

  /* B4/K8（2026-08-21）：今日变化条——快照 divtool_daily_snapshot，3 类独立折叠（触发/买点/数据变化）
   * 首日无基线快照 → “明日起可见”；色盲图标 ▲/●/▼（P54） */
  async function renderDailyBar() {
    const el = document.getElementById('dailyBar');
    if (!el) return;
    try {
      const wl = homeState.watchlist && homeState.watchlist.length ? homeState.watchlist : await DL.Watchlist.list();
      if (!wl.length) { el.style.display = 'none'; return; }
      const today = DL.todayStr();
      let prev = null;
      try { prev = JSON.parse(localStorage.getItem('divtool_daily_snapshot') || 'null'); } catch (e) {}
      const snap = { date: today, items: wl.map(w => ({ code: w.code, name: w.name || w.code, dy: (w.snapshot && w.snapshot.divYield) || null })) };
      if (!prev || prev.date !== today) {
        /* 首日/跨天：只存基线，明日起可见（旧快照同日不重复写） */
        if (!prev || prev.date !== today) { try { localStorage.setItem('divtool_daily_snapshot', JSON.stringify(snap)); } catch (e) {} }
        el.style.display = 'block';
        el.innerHTML = `<div style="padding:8px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:10px;font-size:12px">📋 <b>今日变化</b>：基线已建立（${today}），<b>明日起可见</b>——之后每天打开，这里显示与昨日的对比（触发档位/买点/股息率变化）</div>`;
        return;
      }
      /* 有同日基线（今天第二次打开）：显示与上次快照对比 */
      const prevByCode = {};
      (prev.items || []).forEach(it => prevByCode[it.code] = it);
      const trig = [], buy = [], chg = [];
      snap.items.forEach(it => {
        const p = prevByCode[it.code];
        if (!p || p.dy == null || it.dy == null) return;
        const d = it.dy - p.dy;
        if (d >= 0.5) chg.push(`${it.name} 股息率 ${p.dy.toFixed(2)}%→${it.dy.toFixed(2)}% ▲`);
        else if (d <= -0.5) chg.push(`${it.name} 股息率 ${p.dy.toFixed(2)}%→${it.dy.toFixed(2)}% ▼`);
        else chg.push(`${it.name} 股息率 ${it.dy.toFixed(2)}% ●`);
      });
      const parts = [];
      /* v2.0 #24：站内提醒强化——到账日（divtool_today_due 由分红日历写入，零请求） */
      try {
        const due = JSON.parse(localStorage.getItem('divtool_today_due') || 'null');
        if (due && due.date === today && due.txt) {
          parts.push(`<details open><summary style="font-size:12px;cursor:pointer">💰 今日到账（${due.txt.split('（')[0] || ''}）</summary><div style="font-size:11px;color:var(--sub);padding:4px 0">${due.txt}</div></details>`);
          /* v3.0 C7：到账日系统通知（默认开，失败静默） */
          try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !sessionStorage.getItem('divtool_notified_' + today)) {
              new Notification('💰 今日分红到账', { body: due.txt });
              sessionStorage.setItem('divtool_notified_' + today, '1');
            } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') { Notification.requestPermission().catch(() => {}); }
          } catch (e2) {}
        }
      } catch (e) {}
      if (trig.length) parts.push(`<details><summary style="font-size:12px;cursor:pointer">🔴 今日触发（${trig.length}）</summary><div style="font-size:11px;color:var(--sub);padding:4px 0">${trig.join('<br>')}</div></details>`);
      if (buy.length) parts.push(`<details><summary style="font-size:12px;cursor:pointer">🟢 买点命中（${buy.length}）</summary><div style="font-size:11px;color:var(--sub);padding:4px 0">${buy.join('<br>')}</div></details>`);
      if (chg.length) parts.push(`<details><summary style="font-size:12px;cursor:pointer">📈 数据变化（${chg.length}）</summary><div style="font-size:11px;color:var(--sub);padding:4px 0">${chg.join('<br>')}</div></details>`);
      el.style.display = 'block';
      el.innerHTML = `<div style="padding:8px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:10px;font-size:12px">📋 <b>今日变化</b>${parts.length ? parts.join('') : '<span style="color:var(--sub);font-size:11px"> 无显著变化</span>'}</div>`;
      try { localStorage.setItem('divtool_daily_snapshot', JSON.stringify(snap)); } catch (e) {}
    } catch (e) { el.style.display = 'none'; }
  }

  /* v1.9.0：三级到价提醒（80建仓/85加仓/90加满/95+极值）
   * 推送降频：75-80 预告不推（仅页面展示）；80-85 每日汇总；85+ 实时横幅；95+ 高亮+桌面通知 */
  /* X11/P45（2026-08-21）：三步引导状态机——独立点亮
   * 无自选 → 搜代码加自选；有自选无持仓 → 看诊断记决策；有持仓 → 引导消失 */
  async function renderOnboard() {
    const el = document.getElementById('onboardGuide');
    if (!el) return;
    try {
      const wl = homeState.watchlist && homeState.watchlist.length ? homeState.watchlist : await DL.Watchlist.list();
      const holds = loadHoldings();
      let html = '';
      if (holds.length) {
        el.style.display = 'none';
      } else if (wl.length) {
        el.style.display = 'block';
        html = `<div style="padding:8px 12px;border:1px solid rgba(217,164,65,.35);border-radius:10px;background:rgba(217,164,65,.08);margin-bottom:10px;font-size:12px">💡 <b>下一步：看诊断记决策</b>——点击自选卡进入诊断页，看完记一笔决策（1-3 年后回来对照）</div>`;
      } else {
        el.style.display = 'block';
        html = `<div style="padding:8px 12px;border:1px solid rgba(217,164,65,.35);border-radius:10px;background:rgba(217,164,65,.08);margin-bottom:10px;font-size:12px">💡 <b>第 1 步：搜代码加自选</b>——在上方搜索框输入 6 位代码（如 600036）→ 点 ➕ 加自选</div>`;
      }
      el.innerHTML = html;
    } catch (e) { el.style.display = 'none'; }
  }

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
            const dps = DL.reportYearDivAt(divs, today);
            const v = DL.verdictEngine({ coverage: DL.coverageAt(divs, parseInt(today.slice(0, 4), 10)), reserveYears: null, payoutRate: null, dps, dy: last.dy, pct: last.pct, industry: ind, code: c.code, netProfitYoY: f10.netProfitYoY });
            if (v.tiers && v.tiers.length) tiersTxt = v.tiers.slice(0, 1).map(t => t.text).join('') + (v.tiers.length > 1 ? ' | ' + v.tiers.slice(1, 3).map(t => t.type + '=' + t.rate.toFixed(1) + '% <span style="font-size:11px;opacity:.7">' + t.price + ' 元</span>' + (t.hit ? ' ✅' : '')).join(' | ') : '');
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
      html += `<div style="background:rgba(224,90,90,.12);border:1px solid rgba(224,90,90,.4);border-radius:10px;padding:10px 14px;margin-bottom:10px">🔔 <b>建仓区提醒</b>：${act.map(r => `<b>${r.name}</b>(${r.code}) ${r.pct.toFixed(0)}%分位 [${r.label}]${r.tcls && r.tcls.cls === 'trap' ? ' <span style="color:#e05a5a">⚠️分红陷阱</span>' : r.tcls && r.tcls.cls === 'dull' ? ' <span style="color:#d9a441">钝化</span>' : ''}${r.tiersTxt ? '<div style="font-size:11px;color:var(--sub);margin-top:2px">' + r.tiersTxt + '</div>' : ''}`).join(' · ')}</div>`;
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
      body.innerHTML = '<div class="hint">还没有自选。搜索代码 → 点➕ 加自选，或点下方 🔍 找机会 发现高股息标的——这里会显示每只的建仓进度和资金分配建议。</div>';
      const arrow0 = $('#pfArrow'); if (arrow0) arrow0.textContent = '▸';
      return;
    }
    /* P69（2026-08-21）：紧凑常显行——总仓位·覆盖·触发·今日到账（零请求，读缓存；展开才懒加载） */
    const mode = (localStorage.getItem('divtool_zone_mode') || 'conservative');
    let summary = '…';
    try { const prev = JSON.parse(localStorage.getItem('divtool_pf_summary') || 'null'); if (prev) summary = prev.txt; } catch (e) {}
    if (_pfCache) summary = `组合总仓位 ${_pfCache.totalPos}% · ${_pfCache.triggeredCount}/${_pfCache.items.length} 已触发`;
    let todayTxt = '';
    try {
      const td = JSON.parse(localStorage.getItem('divtool_today_due') || 'null');
      if (td && td.date === DL.todayStr() && td.txt) todayTxt = ' · 今日到账 <b style="color:var(--gold)">' + td.txt + '</b>';
    } catch (e) {}
    const ps = $('#pfSummary');
    if (ps) ps.innerHTML = summary + todayTxt;
    const arrow = $('#pfArrow');
    if (arrow) arrow.textContent = body.style.display !== 'none' ? '▾' : '▸';
    card.onclick = async () => {
      if (body.style.display !== 'none') { body.style.display = 'none'; if (arrow) arrow.textContent = '▸'; return; }
      if (_pfLoading) return;   // v1.9.2 O2：加载锁
      body.style.display = 'block';
      if (arrow) arrow.textContent = '▾';
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
      /* A2（M183/M203）：警示徽标数写进 summary 缓存（渐进增强：首屏无数据不显示，展开后回写） */
      const nTrapC = items.filter(it => it.tcls && it.tcls.cls === 'trap').length;
      const nWarnC = items.filter(it => it.warn && (!it.tcls || (it.tcls.cls !== 'trap' && it.tcls.cls !== 'dull'))).length;
      const nF10C = items.filter(it => it.trap && it.trap.level === 'hard').length;
      try { localStorage.setItem('divtool_pf_summary', JSON.stringify({ ts: Date.now(), txt: `组合总仓位 ${totalPos}% · ${triggered}/${items.length} 已触发`, totalPos, triggeredCount: triggered, nTrap: nTrapC, nWarn: nWarnC, nF10Trap: nF10C })); } catch (e) {}
      /* P69：展开完成同步紧凑行（汇总+今日到账） */
      let tdTxt2 = '';
      try { const td2 = JSON.parse(localStorage.getItem('divtool_today_due') || 'null'); if (td2 && td2.date === DL.todayStr() && td2.txt) tdTxt2 = ' · 今日到账 <b style="color:var(--gold)">' + td2.txt + '</b>'; } catch (e2) {}
      const ps2 = $('#pfSummary'); if (ps2) ps2.innerHTML = `组合总仓位 ${totalPos}% · ${triggered}/${items.length} 已触发` + tdTxt2;
      const arr2 = $('#pfArrow'); if (arr2) arr2.textContent = '▾';
      _pfLoading = false;
      renderPfBody(_pfCache);
    };
    /* P69：body 内按钮点击不折叠卡片 */
    body.onclick = e => { try { e.stopPropagation(); } catch (e2) {} };
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
          <span><b>${it.name}</b>(${it.code}) ${(DL.TRADE_LAYER[it.code] || '') === 'event' ? '<span style="font-size:11px;color:#d9a441;border:1px solid #d9a441;border-radius:4px;padding:0 3px">🔎事件层</span>' : '<span style="font-size:11px;color:#5aa9e6;border:1px solid #5aa9e6;border-radius:4px;padding:0 3px">⚡自动层</span>'} <span style="font-size:11px;color:var(--muted)">${ecoName[it.ecoType] || '中波'}·起${it.ecoStart}</span></span>
          <span style="font-size:11px">${it.pct.toFixed(0)}%分位 <span style="color:${color}">${it.label}</span>${it.tcls && it.tcls.cls !== 'direct' ? ` <span style="color:${it.tcls.color}" title="${it.tcls.detail}">${it.tcls.label}</span>` : ''}${it.warn && (!it.tcls || it.tcls.cls !== 'trap') ? ' <span style="color:#e05a5a">⚠️分红缩水</span>' : ''}${it.trap && it.trap.level ? ` <span style="color:${it.trap.level === 'hard' ? '#e05a5a' : '#d9a441'};font-weight:700" title="${it.trap.msg}">${it.trap.level === 'hard' ? '🚫陷阱确认' : '⚠️净利下滑'}</span>` : ''}</span>
        </div>
        <div style="height:6px;background:var(--card2);border-radius:3px;margin-top:3px;position:relative">
          <div style="position:absolute;left:0;top:0;bottom:0;width:${bar}%;background:${color};border-radius:3px"></div>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">已建 ${it.pos}% / 上限 ${it.target || (it.zone === 'extreme' ? '80' : it.zone === 'full' ? '60' : it.zone === 'add' ? '40' : it.zone === 'start' ? '20' : '—')}%${it.zone === 'wait' || it.zone === 'watch' ? ' · 未触发' : ''}</div>
      </div>`;
    });
    // 资金分配模拟（截断不缩放：90+ > 80 > 70 > 未触发，现金 ≥20%）
    /* G2（2026-08-21）：资金模拟记忆上次输入 + 重置按钮（默认 100 万） */
    let pfFundV = 1000000;
    try { pfFundV = parseFloat(localStorage.getItem('divtool_pf_fund') || '1000000') || 1000000; } catch (e) {}
    const fundInput = `<div style="display:flex;gap:6px;align-items:center;margin:8px 0;flex-wrap:wrap">总资金 <input id="pfFund" type="number" value="${pfFundV}" style="width:110px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt)"> 元 → <button type="button" class="chip" id="pfCalc">💡 分配建议</button> <button type="button" class="chip" id="pfFundReset" title="恢复默认 100 万">↺ 重置</button></div>`;
    // v1.9.3 持仓巡检汇总：健康/观察/警示
    const nTrap = items.filter(it => it.tcls && it.tcls.cls === 'trap').length;
    const nDull = items.filter(it => it.tcls && it.tcls.cls === 'dull').length;
    const nWarn = items.filter(it => it.warn && (!it.tcls || (it.tcls.cls !== 'trap' && it.tcls.cls !== 'dull'))).length;
    // P0-5：净利趋势预警（F10）计数
    const nF10Trap = items.filter(it => it.trap && it.trap.level === 'hard').length;
    const nF10Watch = items.filter(it => it.trap && it.trap.level === 'soft').length;
    const patrolHtml = `<div style="font-size:11px;color:var(--muted);margin-bottom:6px;padding:5px 8px;background:var(--card2);border-radius:8px">🔍 持仓巡检：<b class="green">${items.length - nTrap - nDull - nWarn} 健康</b> · ${nDull ? `<b style="color:#d9a441">${nDull} 观察（低估值钝化）</b> · ` : ''}${nTrap ? `<b class="red">${nTrap} 警示（分红陷阱）</b> · ` : ''}${nWarn ? `<b class="red">${nWarn} 分红缩水</b> · ` : ''}${nF10Trap ? `<b class="red">${nF10Trap} 陷阱确认（净利+覆盖）</b> · ` : ''}${nF10Watch ? `<b style="color:#d9a441">${nF10Watch} 净利下滑观察</b>` : ''}</div>`;
    /* X1（2026-08-21）：组合三件套——加权股息率(TTM·等权)/12月现金流/目标覆盖（后两件看分红日历，同源口径） */
    const wlH = homeState.watchlist || [];
    const dys = wlH.map(w => w.snapshot && w.snapshot.divYield).filter(x => x != null && x > 0);
    const wAvgDy = dys.length ? dys.reduce((s, x) => s + x, 0) / dys.length : null;
    const trioHtml = `<div style="font-size:11px;color:var(--sub);margin-bottom:6px;padding:5px 8px;border:1px solid var(--line);border-radius:8px">📊 组合三件套：加权股息率(年化近2财年) <b style="color:var(--gold)">${wAvgDy != null ? wAvgDy.toFixed(2) + '%' : '—'}</b>（等权 · ${dys.length} 只有数据） · 未来12月现金流/目标覆盖 → 见上方 📅 分红到账日历（持仓口径）</div>`;
    body.innerHTML = `${trioHtml}${patrolHtml}<div style="font-size:11px;color:var(--muted);margin-bottom:6px">组合总仓位 <b>${totalPos}%</b> · 已触发 ${triggeredCount}/${items.length} · 模式：${mode === 'flexible' ? '柔性' : '保守'}（模式在建仓卡切换）</div>${rows}<div id="pfFundWrap">${fundInput}<div id="pfFundResult"></div></div><div id="pfRef" style="margin-top:6px"></div>`;
    /* v2.0 #20 行业集中度 + #21 分红成长分组（追加到组合卡） */
    try {
      const after = document.createElement('div');
      const indMap = {};
      items.forEach(it => { const ind = industryForSync(it.code, it.name) || '其他'; indMap[ind] = (indMap[ind] || 0) + 1; });
      const indTotal = items.length || 1;
      const indTh = getParam('indConc');
      const indOver = Object.entries(indMap).filter(([, n]) => n / indTotal * 100 > indTh);
      const indBar = Object.entries(indMap).map(([ind, n]) => `<span style="display:inline-block;font-size:11px;padding:1px 6px;border-radius:8px;background:var(--card2);border:1px solid var(--line);margin:1px 2px">${ind} ${n}只${n / indTotal * 100 > indTh ? ' <b style="color:#e05a5a">⚠️' + (n / indTotal * 100).toFixed(0) + '%</b>' : ''}</span>`).join('');
      const indHtml = `<div style="font-size:11px;color:var(--sub);margin-top:6px;padding:5px 8px;border-radius:8px;background:var(--card2)">🏭 行业集中度（阈值 ${indTh}%）：${indBar}${indOver.length ? `<div style="color:#e05a5a;font-size:11px;margin-top:2px">⚠️ 超阈值：${indOver.map(([i, n]) => i + ' ' + (n / indTotal * 100).toFixed(0) + '%').join('、')}——单行业暴露过大，注意分散</div>` : ''}</div>`;
      const g = { grow: 0, stable: 0, shrink: 0 };
      items.forEach(it => { if (it.cagr == null) return; if (it.cagr >= 0.05) g.grow++; else if (it.cagr > 0) g.stable++; else g.shrink++; });
      const grpHtml = `<div style="font-size:11px;color:var(--sub);margin-top:4px;padding:5px 8px;border-radius:8px;background:var(--card2)">📈 分红成长分组（CAGR 3年）：<b class="green">增长 ${g.grow}</b> · 稳定 ${g.stable} · <b class="${g.shrink ? 'red' : ''}">缩水 ${g.shrink}</b>${g.shrink ? ' <span style="color:#e05a5a">（缩水项指向卖出信号，见个股卖出卡）</span>' : ''}</div>`;
      body.insertAdjacentHTML('beforeend', indHtml + grpHtml);
    } catch (e) {}
    /* v2.0 #25：移动端一屏看板（覆盖率+下月到账+持仓健康三卡，窄屏优先显示） */
    /* v2.0 #25：移动端一屏看板（覆盖率+下月到账+持仓健康三卡，窄屏优先显示） */
    try {
      const board = document.createElement('div');
      let covTxt = '—', dueTxt = '—', healthTxt = '—';
      try { const td = JSON.parse(localStorage.getItem('divtool_today_due') || 'null'); if (td && td.date === DL.todayStr() && td.txt) dueTxt = td.txt; } catch (e2) {}
      try { const ps = JSON.parse(localStorage.getItem('divtool_pf_summary') || 'null'); if (ps) covTxt = ps.txt || '—'; } catch (e2) {}
      const nH = items.length - items.filter(it => it.warn || (it.tcls && it.tcls.cls === 'trap') || (it.trap && it.trap.level === 'hard')).length;
      healthTxt = nH + '/' + items.length + ' 健康';
      board.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px';
      board.innerHTML = [['💰 覆盖率', covTxt], ['📅 今日到账', dueTxt], ['🏥 持仓健康', healthTxt]].map(([t, v]) =>
        `<div style="flex:1;min-width:120px;padding:6px 8px;border-radius:8px;background:var(--card2);border:1px solid var(--line)"><div style="font-size:10px;color:var(--muted)">${t}</div><div style="font-size:12px;font-weight:600;color:var(--gold)">${v}</div></div>`).join('');
      body.insertAdjacentHTML('beforeend', board.outerHTML);
    } catch (e) {}
    // 资金模拟绑定
    const calcBtn = $('#pfCalc');
    if (calcBtn) calcBtn.onclick = () => {
      const F = parseFloat(($('#pfFund') || {}).value) || 0;
      const result = $('#pfFundResult');
      if (!F || !result) return;
      /* G2：记忆上次输入 */
      try { localStorage.setItem('divtool_pf_fund', String(F)); } catch (e2) {}
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
    /* G2（2026-08-21）：重置按钮——恢复默认 100 万并清记忆 */
    const fundReset = $('#pfFundReset');
    if (fundReset) fundReset.onclick = () => {
      try { localStorage.removeItem('divtool_pf_fund'); } catch (e2) {}
      const fi = $('#pfFund'); if (fi) fi.value = '1000000';
      const res = $('#pfFundResult'); if (res) res.innerHTML = '<div class="hint">已重置为默认 100 万，重新点 💡 分配建议</div>';
    };
    /* G2：输入即记忆（失焦保存，刷新后保留） */
    const fi2 = $('#pfFund');
    if (fi2) fi2.onchange = () => { const v = parseFloat(fi2.value) || 0; if (v > 0) { try { localStorage.setItem('divtool_pf_fund', String(v)); } catch (e2) {} } };
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
        ref.innerHTML = `<div class="hint">组合历史同类买点（按当前持仓权重）：平均收益 <b class="${totRet / wSum >= 0 ? 'green' : 'red'}">${(totRet / wSum).toFixed(1)}%</b> / 最大浮亏 <b class="red">-${(totMdd / wSum).toFixed(1)}%</b>（${nEvt} 次独立事件，仅参考非预测；触发点基于报告期口径·2026-08-21 起）</div>`;
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
    try {   /* W6：错误组件包裹 */
    const wl = homeState.watchlist;
    if (!wl.length) { el.innerHTML = ''; return; }   /* P72（2026-08-21）：无自选时留空——自选卡空态组件统一引导，防重复提示 */
    el.innerHTML = '<div class="hint"><span class="spinner"></span>加载中…</div>';
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
    if (radarLines.length) html += `<div style="margin-bottom:4px;font-size:12px">🔍 <b>机会雷达</b>：${radarLines.join('；')}</div><div class="hint" style="font-size:11px;margin-bottom:4px">位置≠建议——当前股息率在三档的哪个区，结合分位与财报底座判断</div>`;
    if (nearAdd.length) html += `<div class="hint">距加仓线最近：${nearAdd.slice(0, 3).map(x => `${x.name} 差 <b>${x.gap.toFixed(2)}pp</b>`).join(' · ')}（现价股息率 vs 行业加仓线）</div>`;
    html += alerts.length
      ? alerts.map(a => `<div class="alert-item">🔔 ${a}</div>`).join('')
      : '<div class="hint">✅ 变化提醒：自选股状态稳定（股息率/价格无显著变化）</div>';
    /* P99/J1（2026-08-21）：删线上假功能——/tmp/watch-report.json 是本地开发残留，GitHub Pages 必 404。
     * 诚实条款：无真实能力不显示占位。今日触发/买点命中并入 B4 今日变化条（K8）。 */
    el.innerHTML = html;
    } catch (e) { showLoadError(el, '机会雷达加载失败' + (e && e.message ? '：' + e.message : ''), renderOpportunities); }
  }

  /* 自选卡片：默认3指标（股息率+分位、估值分位、年化/回撤合并）+ 展开态 */
  async function renderWatchlist() {
    const el = $('#homeWatchlist');
    if (!el) return;
    try {   /* W6：错误组件包裹 */
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
      /* A6/W8（2026-08-21）：空态组件规范——emoji+一句+一动作（含推荐动作与 P45 三步引导衔接） */
      el.innerHTML = `<div class="hint">🔍 <b>还没有自选</b><br>搜代码（如 600036）→ 点 ➕ 加自选，或从下方推荐直接试：<br>` +
        recs.map(x => `<button class="chip" data-code="${x.code}">${x.name}</button>`).join(' ') +
        `<div style="font-size:11px;color:var(--muted);margin-top:4px">加上第 1 只后，诊断页会教您记决策——1-3 年后回来对照</div></div>`;
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
        if (dy && dy.yieldPct) await DL.Watchlist.updateSnapshot(code, { divYield: dy.yieldPct, dps: dy.yieldPct * price / 100, price, at: Date.now(), caliber: 'annual-2y' });
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
    /* P96（2026-08-21）：自选卡按档位优先级排序——重仓>加仓>小仓>等待>回避（卖出信号=回避带角标）
     * 先算后排：档位同键时股息率高者在前；线待补/无行业垫底；回避（卖出信号）排最末 */
    const cards = wl.map(it => {
      const s = snap[it.code];
      const dy = it.snapshot ? it.snapshot.divYield : null;
      const sig = sellSig[it.code];
      const sigTxt = sig && sig !== 'ok' && sig !== 'pending'
        ? `<span class="chip" style="background:rgba(224,90,90,.15);color:#e05a5a;font-size:11px;padding:1px 6px;border:1px solid rgba(224,90,90,.4)" title="连续2年${sig.indexOf('eps') >= 0 ? 'EPS下滑' : ''}${sig === 'both' ? ' + ' : ''}${sig.indexOf('div') >= 0 ? '分红下调' : ''}（5财年窗口）">⚠️ 卖出信号</span>` : '';
      /* O1（并入 P2）：自选卡三档联动——距加仓线差（股息率差口径，大师 Q3 确认；行业未识别降级） */
      const ind = snapAllInd[it.code];
      const spot = (dy != null && ind) ? DL.tierSpot(dy, ind, it.code) : null;
      const gapTxt = spot ? (spot.pending ? '<span style="color:var(--gold)" title="K线源故障，溢价线待补">⚠️ 线待补（仅参考）</span>' : spot.cur === 'add' ? '<span style="color:var(--gold)">已到加仓线</span>' : spot.cur === 'heavy' ? '<span style="color:#e05a5a">已到重仓线</span>' : spot.cur === 'small' ? `距加仓线差 <b>${spot.gapAdd.toFixed(2)}pp</b>` : `距小仓线差 ${(spot.mid - dy).toFixed(2)}pp`) : '';
      /* v1.9.13：过滤层黄灯角标（红线/短样本→可点击跳诊断页看原因；大师第2轮：角标=入口不是终点） */
      const spotTl = spot && spot.tl;
      const warnTxt = spotTl && !spot.pending && (spotTl.redLine || spotTl.shortSample || spotTl.drift)
        ? `<a href="javascript:void(0)" class="wl-warn" data-code="${it.code}" title="信号降级：${[spotTl.redLine ? '支付率超红线' : '', spotTl.shortSample ? '短样本' : '', spotTl.drift ? '线漂移' : ''].filter(Boolean).join('、')}（点击看详情）" style="color:#d9a441;font-size:11px;margin-left:4px">🟡</a>` : '';
      const missTxt = (dy == null && retried[it.code]) ? ' · <a href="javascript:void(0)" class="wl-retry" data-code="' + it.code + '" style="color:var(--gold)">点此重试</a>' : '';
      const rank = spot ? (spot.pending ? 0.5 : spot.cur === 'heavy' ? 4 : spot.cur === 'add' ? 3 : spot.cur === 'small' ? 2 : 1) : 0.5;
      /* P96：回避档（卖出信号）排最末，角标=原因（已有 sigTxt 悬停看详情） */
      const avoidRank = (sig && sig !== 'ok' && sig !== 'pending') ? -1 : 0;
      return { rank: rank + avoidRank, dy: dy || 0, html: `<div class="wl-card" data-code="${it.code}">
        <div class="wl-head"><b>${esc(it.name)}</b><span class="wl-code">${esc(it.code)}</span>${warnTxt}${sigTxt}${secTypeLabel({ code: it.code }) !== '股票' ? `<span class="chip" style="font-size:11px;padding:1px 6px">${secTypeLabel({ code: it.code })}</span>` : ''}
          <button class="chip wl-tohold" data-code="${it.code}" title="加入我的持仓" style="font-size:11px;padding:0 8px;margin-left:auto">📥 持仓</button><button class="wl-del" data-code="${it.code}">✕</button></div>
        <div class="wl-main">${dy != null ? `年化股息率 <b class="gold" title="展示口径=近2财年已公告分红÷现价；决策口径=最近已公告财年（进诊断看分位）">${dy.toFixed(2)}%</b>` : '<span class="hint">待数据</span>' + missTxt}
          ${s ? `<span class="wl-price">${fmt(s.price, 2)}元</span>` : ''}</div>
        <div class="wl-sub hint">${gapTxt || '点击进入诊断'}${gapTxt ? ' · 点击进入诊断' : ''}</div>
      </div>` };
    }).sort((a, b) => b.rank - a.rank || b.dy - a.dy).map(c => c.html).join('');
    el.innerHTML = cards;
    el.querySelectorAll('.wl-card').forEach(c => c.onclick = () => openDiagnose(c.dataset.code));
    /* v1.9.13：黄灯角标→诊断页（大师第2轮：角标=入口不是终点；stopPropagation 防触卡） */
    el.querySelectorAll('.wl-warn').forEach(a => {
      a.onclick = e => { e.stopPropagation(); openDiagnose(a.dataset.code); };
    });
    el.querySelectorAll('.wl-del').forEach(b => {
      b.onclick = async e => { e.stopPropagation(); await DL.Watchlist.remove(b.dataset.code); renderHome(); };
    });
    /* B5（2026-08-21）：自选→持仓显式按钮（预填 v1 表单代码） */
    el.querySelectorAll('.wl-tohold').forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        const code = b.dataset.code;
        const wl = homeState.watchlist || [];
        const it = wl.find(x => x.code === code);
        switchTab('home');
        const pf = document.getElementById('pfSample');
        if (pf) { try { pf.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e2) {} }
        const hc = document.getElementById('holdCode');
        if (hc) { hc.value = code; try { hc.focus(); } catch (e2) {} }
        try { toast('已预填：' + (it ? it.name : code) + ' → 填股数后点 ➕ 录入'); } catch (e2) {}
      };
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
    } catch (e) { showLoadError(el, '自选卡加载失败' + (e && e.message ? '：' + e.message : ''), renderWatchlist); }
  }

  /* 分红到账日历 v1.9.3：自选未来12个月（已宣告+上年同期估计，月度汇总+持仓金额）
   * 持仓股数可填（P114：v1 真源，录入在决策台「📊 我的持仓」），未填只显示每股合计 */
  async function renderDivCalendar() {
    const el = $('#homeDivCalendar');
    if (!el) return;
    const wl = homeState.watchlist;
    if (!wl.length) { el.innerHTML = '<div class="hint">📅 还没有自选。在上方搜索框输入 6 位代码 → 点 ➕ 加自选，这里显示未来 12 个月的分红到账日历（已宣告+上年同期估算）。</div>'; return; }
    el.innerHTML = '<div class="hint"><span class="spinner"></span>分红日历加载中…</div>';
    const today = DL.todayStr();
    let holdings = {};
    /* P114（2026-08-21）：F2 第 0 步——分红日历改读 v1 真源（数组→映射） */
    try { holdings = Object.fromEntries(loadHoldings().map(h => [h.code, h.shares])); } catch (e) {}
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
    /* P69（2026-08-21）：今日到账写入 localStorage——组合总览紧凑常显行读取（零请求） */
    try {
      const dueToday = [];
      cf.forEach(m => m.items.forEach(x => { if (!x.est && x.ex === today) dueToday.push(x); }));
      let dueTxt = '';
      if (dueToday.length) {
        const sum = dueToday.reduce((s, x) => s + x.dps * x.shares, 0);
        dueTxt = dueToday.map(x => x.name + (x.shares > 0 ? ' ' + x.shares + '股' : '')).join('、');
        if (sum > 0) dueTxt += '（合计 ' + (sum / 10000).toFixed(2) + ' 万）';
      }
      try { localStorage.setItem('divtool_today_due', JSON.stringify({ date: today, txt: dueTxt })); } catch (e2) {}
    } catch (e2) {}
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
        <div style="font-size:11px;color:var(--sub);margin-bottom:3px">📊 组合级视图（D4）${pos ? '' : '<span style="font-size:11px">（未填持仓=按自选等权示意）</span>'}</div>
        <div style="font-size:12px">组合加权股息率 <b class="green">${comboDy.toFixed(2)}%</b> ${pos ? `（持仓 ${rows4.length} 只）` : ''}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px">单票风险占比（股息率×权重，前5）：${riskRows.map(r => `${r.name} <b>${(r.dy * weight(r)).toFixed(2)}%</b>`).join(' · ')}</div>
      </div>`;
    } catch (e) {}
    /* v2.0 批次2：#1 决策语言 + #2 无风险基准（组合级，M373：Σ每股DPS×股数） */
    let decHtml = '';
    try {
      const pool = rows4.map(r => ({ code: r.code, name: r.name, shares: r.shares, price: r.price, divs: allDivs.filter(d => d.code === r.code) })).filter(p => p.price > 0 && p.shares > 0);
      if (pool.length && expDef > 0) {
        const cagrP = getParam('cagrAssump');
        const cagrV = cagrP === 'hist' ? 0.12 : (cagrP === 0.05 ? 0.05 : 0.08);
        const ds = DL.decisionSentence(pool, { monthlyExp: expDef, cagrAssumption: cagrV });
        if (ds) {
          const taxOn = getParam('taxAfter') === true;
          const rf = DL.riskFreeCompare(ds.invest, ds.annual.base);
          const taxTag = taxOn ? `（税后 9 折：${(ds.monthly.base * 0.9 / 10000).toFixed(2)}万/月）` : '';
          decHtml = `<div style="margin:6px 0;padding:6px 9px;border-radius:8px;border:1px solid var(--line);background:rgba(0,0,0,.15)">
        <div style="font-size:11px;color:var(--sub);margin-bottom:3px">🧭 决策语言（组合级·中性 CAGR 8% 可调）</div>
        <div style="font-size:12px">${ds.sentence}${taxTag}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px">💰 吃分红 vs 存银行（国债 ${rf.treasury.toFixed(2)}%）：年分红 <b>${(rf.divAnnual / 10000).toFixed(2)}万</b> vs 存银行 <b>${(rf.bankAnnual / 10000).toFixed(2)}万</b> → <b class="${rf.better === '分红' ? 'green' : 'red'}">${rf.better}</b>更优（${rf.note}）</div>
      </div>`;
        }
      }
    } catch (e) {}
    const targetInput = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px"><span style="font-size:11px;color:var(--muted)">每年目标分红（万）：</span><input id="divtoolTargetInput" type="number" min="0" placeholder="如 20" value="${target ? (target / 10000).toFixed(1) : ''}" style="width:70px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:11px"><button type="button" class="chip" id="divtoolTargetSave">💾 保存</button></div>`;
    /* P106（2026-08-21）：K3 单一录入入口——旧 divtoolHoldInput 已删，持仓只认决策台 v1 表单（#pfSample） */
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
        <div style="font-size:11px;color:var(--sub);margin:6px 0 4px">📅 近 ${Math.min(6, years.length)} 年实际分红收入（需在决策台录入持仓）：</div>
        <div>${yearRows || '<span class="hint">到决策台「📊 我的持仓」录入后显示历史分红收入</span>'}</div>
        <div style="font-size:11px;margin-top:6px">🚀 分红里程碑：${doubleY ? `按近 3 年分红增速 ${(avgCagr * 100).toFixed(1)}% 持续（保守口径），月分红翻倍还需约 <b>${doubleY.toFixed(0)} 年</b>` : '<span class="hint">自选样本不足，无法估算增速（分红不增长时永远不翻倍）</span>'}</div>
        <div id="${etfRefId}" style="font-size:11px;margin-top:4px"><span class="hint">红利 ETF 参照加载中…</span></div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:8px"><span style="font-size:11px;color:var(--muted)">月生活支出（元）：</span><input id="divLifeExp" type="number" min="0" placeholder="如 15000" value="${expDef || ''}" style="width:90px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:11px"><button type="button" class="chip" id="divLifeExpSave">💾 算覆盖</button></div>
        <div style="font-size:11px;margin-top:4px">${covPct != null ? `当前年分红 <b>${(yearIncome / 10000).toFixed(2)}万</b>（月 ${(yearIncome / 12 / 10000).toFixed(2)}万）→ 覆盖月支出 <b style="color:var(--gold)">${covPct.toFixed(0)}%</b>；${gapRange}` : '<span class="hint">填月支出后显示覆盖率与缺口本金</span>'}</div>
        <!-- v2.0 批次3：#13 反向本金 + #12 退休时间点模拟 -->
        <div style="font-size:11px;margin-top:6px" id="v2ReversePrincipal"></div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap"><span style="font-size:11px;color:var(--muted)">通胀假设(%)：</span><input id="v2Infl" type="number" min="0" max="10" step="0.5" value="2" style="width:56px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:11px"><button type="button" class="chip" id="v2RetireCalc">🏖 算退休时间点</button><span style="font-size:11px;color:var(--muted)">（分红增速 ${avgCagr != null ? (avgCagr * 100).toFixed(1) + '%' : '—'}，可调 CAGR 假设见参数中心）</span></div>
        <div style="font-size:11px;margin-top:4px" id="v2RetireOut"></div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">提取参考（分红由持股产生，提取不影响下年分红基数）：提取 0/30/50/100% → 每年可消费 0 / ${(yearIncome * 0.3 / 10000).toFixed(2)} / ${(yearIncome * 0.5 / 10000).toFixed(2)} / ${(yearIncome / 10000).toFixed(2)} 万，剩余复投</div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:8px"><span style="font-size:11px;color:var(--muted)">追加金额（元）：</span><input id="divLifeAdd" type="number" min="0" placeholder="如 50000" value="${addDef || ''}" style="width:90px;padding:4px 6px;background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:11px"><button type="button" class="chip" id="divLifeAddSave">💾 算贡献</button><span style="font-size:11px;color:var(--muted)">按自选平均股息率 ${(avgDy * 100).toFixed(1)}%</span></div>
        <div style="font-size:11px;margin-top:4px">${addDef > 0 ? `追加 ${(addDef / 10000).toFixed(1)}万 → 年贡献分红 <b>${(addYear / 10000).toFixed(2)}万</b>（月 ${(addMonth / 10000).toFixed(2)}万）——1 年后起算，长期吃分红视角` : '<span class="hint">填追加金额后显示分红贡献</span>'}</div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap">
          <button type="button" class="chip" id="divLifeReinvest" style="color:#4caf7d">🔄 分红→再投资（去扫描器）</button>
          <button type="button" class="chip" id="divLifeExport">⬇️ 导出数据（换设备迁移）</button>
          <button type="button" class="chip" id="divLifeImport">⬆️ 导入数据</button>
          <input type="file" id="divLifeImportFile" accept="application/json" style="display:none">
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">导出=自选/持仓/决策日志/目标/支出/设置（JSON 带版本号，本地文件不上传）</div>
      </details>
    </div>`;
    el.innerHTML = `${targetInput}${targetHtml}${decHtml}${comboHtml}${nearTxt}<div style="font-size:11px;color:var(--muted);margin-bottom:6px">未来 12 个月预计到账（税前） <b>${cf.length} 个月</b>${yearTotal > 0 ? ' · 合计 <b style="color:var(--txt)">' + (yearTotal / 10000).toFixed(2) + ' 万</b>' : ''}（估=上年同期推算，未公告；持仓股数以决策台「📊 我的持仓」为准）</div>${rows.length ? rows.join('') : '<div class="hint">未来 12 个月无预计到账</div>'}${lifeHtml}<div class="hint" style="margin-top:4px;color:var(--sub)">💸 到账视角：已宣告=按除息日计入（公告即算）；未宣告估算=按上年同月除息日推算（标"估"）</div>
    <!-- C7/P49（2026-08-21）：可视化——V1 覆盖进度环 + V2 12月柱状（C8：移动端规格环≥160px 柱宽≥8px） -->
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
      <div id="calChartCover" style="width:160px;height:160px;flex-shrink:0"></div>
      <div id="calChartMonths" style="flex:1;min-width:230px;height:160px"></div>
    </div>`;
    /* V1：覆盖进度环（目标>0 才画；无目标显示引导） */
    try {
      const ccEl = document.getElementById('calChartCover');
      if (ccEl && typeof echarts !== 'undefined') {
        if (target > 0) {
          const coverPct = Math.min(100, yearTotalNow / target * 100);
          const cc = echarts.init(ccEl);
          cc.setOption({
            series: [{ type: 'pie', radius: ['62%', '82%'], silent: true, label: { show: true, position: 'center', formatter: () => coverPct.toFixed(0) + '%\n覆盖', fontSize: 14, color: '#e8efe9' }, data: [{ value: coverPct, itemStyle: { color: '#4caf7d' } }, { value: 100 - coverPct, itemStyle: { color: 'rgba(255,255,255,.08)' } }] }],
            title: { text: '分红目标覆盖', left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
          });
        } else {
          ccEl.innerHTML = '<div class="hint" style="font-size:11px;padding-top:56px;text-align:center">🎯 上方填年度分红目标<br>这里显示覆盖进度环</div>';
        }
      }
    } catch (e2) {}
    /* V2：12 个月到账柱状（C8：柱宽≥8px 规格） */
    try {
      const cmEl = document.getElementById('calChartMonths');
      if (cmEl && typeof echarts !== 'undefined') {
        const cm = echarts.init(cmEl);
        cm.setOption({
          title: { text: '未来 12 个月到账（税前·元）' + (getParam('monthSmooth') ? '·平滑' : '·实际到账月'), left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
          grid: { left: 44, right: 8, top: 26, bottom: 22 },
          xAxis: { type: 'category', data: cf.map(m => m.month.slice(5) + '月'), axisLabel: { color: '#8fa69c', fontSize: 10 }, axisLine: { lineStyle: { color: '#2a3d36' } } },
          yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
          series: [{ type: 'bar', data: cf.map(m => m.total), itemStyle: { color: '#d9a441', borderRadius: [3, 3, 0, 0] }, barMinWidth: 8, barMaxWidth: 22,
            markLine: expDef > 0 ? { silent: true, symbol: 'none', label: { show: true, formatter: '月支出 ' + (expDef / 10000).toFixed(2) + '万', color: '#e05a5a', fontSize: 10, position: 'insideEndTop' }, lineStyle: { color: '#e05a5a', type: 'dashed' }, data: [{ yAxis: expDef }] } : undefined }],
          tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: ps => { const m = cf[ps[0].dataIndex]; return `<b>${m.month}</b><br/>到账 <b>${(m.total / 10000).toFixed(2)} 万</b>`; } },
        });
      }
    } catch (e2) {}
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
    /* v2.0 批次3：#13 反向本金——月支出→需本金（当前股息率/预期5%双答案，零网络） */
    try {
      const rpEl = document.getElementById('v2ReversePrincipal');
      if (rpEl && expDef > 0 && yearIncome > 0) {
        const curDy = yearIncome / Math.max(1, (() => { try { const h = loadHoldings(); return h.reduce((s, x) => s + (x.shares || 0) * (x.cost || 0), 0); } catch (e) { return 0; } })());
        const rp = DL.requiredPrincipal(expDef, curDy > 0 ? curDy : avgDy, 0.05);
        if (rp) rpEl.innerHTML = `🔄 <b>反向本金</b>：月支出 ${(expDef / 10000).toFixed(2)}万 → 需本金 <b>${(rp.atCurrent / 10000).toFixed(0)}万</b>（当前股息率 ${(rp.dyCur * 100).toFixed(1)}%）或 <b>${(rp.atExpected / 10000).toFixed(0)}万</b>（按预期 5%）`;
      } else if (rpEl && expDef > 0) {
        const rp = DL.requiredPrincipal(expDef, 0.0484, 0.05);
        if (rp) rpEl.innerHTML = `🔄 <b>反向本金</b>：月支出 ${(expDef / 10000).toFixed(2)}万 → 需本金 <b>${(rp.atCurrent / 10000).toFixed(0)}万</b>（按当前自选加权 4.84%）或 <b>${(rp.atExpected / 10000).toFixed(0)}万</b>（按预期 5%）`;
      }
    } catch (e) {}
    /* v2.0 批次3：#12 退休时间点模拟——CAGR+通胀→哪年覆盖率100% */
    const retireBtn = $('#v2RetireCalc');
    if (retireBtn) retireBtn.onclick = () => {
      const out = document.getElementById('v2RetireOut');
      if (!out) return;
      const infl = (parseFloat(($('#v2Infl') || {}).value) || 0) / 100;
      if (!(yearIncome > 0) || !(expDef > 0)) { out.innerHTML = '<span class="hint">需先填月生活支出 + 有年分红数据</span>'; return; }
      const cagrP = getParam('cagrAssump');
      const g = cagrP === 'hist' ? 0.12 : (cagrP === 0.05 ? 0.05 : (avgCagr != null && avgCagr > 0 ? avgCagr : 0.08));
      const rs = DL.retirementSim(yearIncome, g, infl, expDef, 30);
      if (!rs) { out.innerHTML = '<span class="hint">数据不足</span>'; return; }
      const last = rs.rows[rs.rows.length - 1];
      out.innerHTML = rs.hitYear != null
        ? `🏖 按分红增速 ${(g * 100).toFixed(1)}% + 通胀 ${(infl * 100).toFixed(1)}%，覆盖率 100% 预计在第 <b style="color:var(--gold)">${rs.hitYear} 年</b>（${rs.hitYear === 0 ? '现在已达标' : '需继续滚雪球'}）· 第 30 年覆盖 ${last.cov.toFixed(0)}%`
        : `🏖 30 年内无法达标（增速 ${(g * 100).toFixed(1)}% vs 通胀 ${(infl * 100).toFixed(1)}%）——需提高复投率/追加本金或降支出；第 30 年覆盖 ${last.cov.toFixed(0)}%`;
    };
    /* 反向本金/退休模拟初次渲染（有数据时直接显示） */
    if (retireBtn && expDef > 0 && yearIncome > 0) retireBtn.onclick();
    const addSave = $('#divLifeAddSave');
    if (addSave) addSave.onclick = () => {
      const v = parseFloat(($('#divLifeAdd') || {}).value || '0') || 0;
      try { localStorage.setItem('divtool_add_amt', String(v)); } catch (e) {}
      renderDivCalendar();
    };
    // P2：分红资金闭环（D12 出口→扫描器再投资）
    const reinBtn = $('#divLifeReinvest');
    if (reinBtn) reinBtn.onclick = () => {
      try { const h = document.querySelector('[data-tab="home"]'); if (h) h.click(); const f = $('#btnFindOpp'); if (f) f.click(); const t = document.querySelector('.opp-tab[data-opp="disc"]'); if (t) t.click(); } catch (e) {}
    };
    /* A2（M181/M213）：紧凑行缓存回写——年度分红/目标覆盖（与 V1 覆盖进度环同源），持仓卡紧凑行读此缓存零请求 */
    try { localStorage.setItem('divtool_compact_cache', JSON.stringify({ ts: Date.now(), yearIncome, yearTotalNow, target })); } catch (e) {}
    /* 批次2（M276）：净值曲线累计分红线数据源——E1 历史逐年分红回写缓存 */
    try { localStorage.setItem('divtool_div_years', JSON.stringify({ years, values: years.map(y => yearMap[y] || 0) })); } catch (e) {}
    // P2 F3：多设备数据迁移（导出/导入 JSON 带版本号）
    /* P41/P44（2026-08-21）：导出 v2 四件套——持仓/自选（含快照）/决策日志/设置；读写 v1 真源，旧 key 只兼容读不互写 */
    const exBtn = $('#divLifeExport');
    if (exBtn) exBtn.onclick = () => {
      try {
        const data = {
          v: 2, app: 'dividend-tool', exportedAt: DL.todayStr(),
          watchlist: wl.map(w => ({ code: w.code, name: w.name || '', snapshot: w.snapshot || null })),
          holdings: loadHoldings(),
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
    /* P43（2026-08-21）：导入三保险——覆盖确认 → 导入前 bak（divtool_bak_before_import）→ 失败自动回滚 */
    if (imFile) imFile.onchange = async (e) => {
      const file = e.target.files && e.target.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const vOk = data && (data.v === 1 || data.v === 2) && data.app === 'dividend-tool';
        if (!vOk) { try { toast('文件版本不兼容'); } catch (e2) {} return; }
        if (!confirm('导入将覆盖当前本地数据（自选/持仓/决策日志/设置），继续？')) return;
        /* 导入前备份（可手动恢复的 key：divtool_bak_before_import） */
        const bak = {};
        ['divtool_watchlist_v1', 'divtool_holdings_v1', 'divtool_decisions_v1', 'divtool_div_target', 'divtool_monthly_exp', 'divtool_add_amt', 'divtool_zone_mode']
          .forEach(k => { try { const v = localStorage.getItem(k); if (v != null) bak[k] = v; } catch (e2) {} });
        try { localStorage.setItem('divtool_bak_before_import', JSON.stringify(bak)); } catch (e2) {}
        try {
          if (Array.isArray(data.watchlist)) { try { localStorage.setItem('divtool_watchlist_v1', JSON.stringify(data.watchlist)); } catch (e2) {} }
          if (Array.isArray(data.holdings)) { try { localStorage.setItem('divtool_holdings_v1', JSON.stringify(data.holdings)); } catch (e2) {} }
          else if (data.holdings && typeof data.holdings === 'object') { /* v1 旧格式兼容：对象 → 数组 */
            const arr = Object.entries(data.holdings).filter(([c, s]) => /^\d{6}$/.test(c) && s > 0).map(([c, s]) => ({ code: c, name: c, shares: s, cost: null, date: null }));
            try { localStorage.setItem('divtool_holdings_v1', JSON.stringify(arr)); } catch (e2) {}
          }
          if (Array.isArray(data.decisions)) { try { localStorage.setItem('divtool_decisions_v1', JSON.stringify(data.decisions.slice(0, 200))); } catch (e2) {} }
          ['target', 'monthlyExp', 'addAmt'].forEach(k => { if (data[k] != null && data[k] !== '') { try { localStorage.setItem('divtool_' + k, data[k]); } catch (e2) {} } });
          if (data.mode) { try { localStorage.setItem('divtool_zone_mode', data.mode); } catch (e2) {} }
          try { toast('✅ 导入成功'); } catch (e2) {}
          if (typeof renderHome === 'function') { try { renderHome(); } catch (e2) {} }
          renderDivCalendar();
        } catch (err) {
          /* 失败自动回滚 */
          try {
            const b = JSON.parse(localStorage.getItem('divtool_bak_before_import') || '{}');
            Object.entries(b).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch (e2) {} });
            try { toast('导入失败已回滚：' + err.message); } catch (e2) {}
          } catch (e2) {}
        }
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
            const start = DL.daysAgo(366);
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
    const btn = document.querySelector('.opp-tab[data-opp="scan"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 扫描中…'; }
    try {
    const el = $('#scanBody');
    el.style.display = 'block';
    el.innerHTML = '<div class="hint">⏳ 扫描中：拉取全市场分红数据（近 3 年，连分判定需要）…</div>';
    // v1.9.6 修复：原来只拉 365 天→连分≥3年永远不满足→恒 0 只（确定性 bug）；改拉 3 年
    const from = DL.daysAgo(3 * 366);
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
      if (btn) { btn.disabled = false; btn.textContent = '📡 扫描新机会'; }
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
    const btnD = document.querySelector('.opp-tab[data-opp="disc"]');
    if (btnD) { btnD.disabled = true; btnD.textContent = '⏳ 发现中…'; }
    try {
    const el = $('#scanBody');
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
      el.innerHTML = `<div class="hint">✅ 第一通道（股息率≥3%，外部源口径·东财TTM）：${ch1.length} 只候选。深扫 top ${Math.min(40, ch1.length)} 算 CAGR/生态/置信度…</div>`;
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
          <span class="gold">${r.dy.toFixed(2)}%</span><span class="hint"> 外部TTM</span>
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
      if (btnD) { btnD.disabled = false; btnD.textContent = '🔭 发现器'; }
    }
  }

  /* C14/E1（2026-08-21）：诊断页自选快捷切换状态（外层函数，openDiagnose 同步调用） */
  function updateDiagNav() {
    const diagPrev = $('#diagPrev'), diagNext = $('#diagNext');
    if (!diagPrev || !diagNext) return;
    const wl = homeState.watchlist || [];
    if (wl.length < 2 || !diagCode) { diagPrev.style.display = 'none'; diagNext.style.display = 'none'; return; }
    const idx = wl.findIndex(x => x.code === diagCode);
    diagPrev.style.display = 'inline-flex'; diagPrev.disabled = idx <= 0;
    diagNext.style.display = 'inline-flex'; diagNext.disabled = idx < 0 || idx >= wl.length - 1;
  }

  /* ---------- 诊断页 ---------- */
  let diagCode = null;
  let diagYears = 5;
  let diagSeq = 0;   // v1.9.0 竞态修复：请求序号，旧请求异步返回时丢弃（防 D3→D4 串台覆盖 etfNote）
  async function openDiagnose(code, years) {
    const seq = ++diagSeq;
    diagCode = code;
    if (years) diagYears = years;
    /* P81（2026-08-21）：URL 同步——分享/刷新保持当前股票 */
    try { history.replaceState({}, '', '?diag=' + code); } catch (e) {}
    try { updateDiagNav(); } catch (e) {}
    switchTab('diagnose');
    $('#diagEmpty').style.display = 'none';
    $('#diagContent').style.display = 'block';
    $('#diagTitle').textContent = '🔬 ' + code + ' 诊断中…';
    $('#diagStats').innerHTML = '<div class="hint"><span class="spinner"></span>数据加载中…（网络请求，超时自动提示）</div>';
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
        etfNoteEl.textContent = isEtf ? '⚠️ ETF/指数：若累计分红显示 0，为分红数据源暂缺或获取失败（已接入基金公告源，正常应显示真实分红记录）。ETF 分红免税。' : '';
      }
      $('#diagTitle').textContent = '🔬 ' + (name === code ? '' : name + ' ') + code;
      const [divs, kline] = await Promise.all([
        DL.fetchDividendsOne(code),
        /* v1.9.17：K线拉取范围 = max(diagYears, 10) 年——长期复投视角（5年/10年）需要 10 年数据，
         * 旧版只拉 diagYears（默认5年）→ 10年 永远"样本不足"，主人抓"做个5年10年怎么没优化" */
        DL.getKline(code, DL.daysAgo(Math.max(diagYears, 10) * 366), DL.todayStr()),
      ]);
      if (seq !== diagSeq) return;   // v1.9.0 竞态修复
      // BUG修复(2026-08-18)：snap 复用同根因——诊断其他股票时若 snap 缺该 code，合并拉取保证 PE/PB/价格齐全
      const fresh = await DL.getStockQuotes([code]);
      const snap = Object.assign({}, homeState.snap || {}, fresh);
      homeState.snap = snap;
      const s = snap[code] || {};
      /* W11（2026-08-21）：页头数据状态条——仅缺失时显示（"K线✓ 分红✗ 行情✓"），✗ 项点击重试 */
      try {
        const st = $('#diagDataState');
        if (st) {
          const miss = [];
          if (!kline || !Object.keys(kline).length) miss.push(['K线', 'k']);
          if (!divs || !divs.length) miss.push(['分红', 'd']);
          if (!s.price) miss.push(['行情', 'q']);
          if (miss.length) {
            st.innerHTML = `<div style="font-size:11px;padding:6px 10px;border:1px solid rgba(217,164,65,.5);border-radius:8px;background:rgba(217,164,65,.08);margin-bottom:6px">⚠️ 部分数据缺失：${miss.map(m => `<a href="javascript:void(0)" data-retry="${m[1]}" style="color:var(--gold);font-weight:700">${m[0]} ✗ 点击重试</a>`).join(' · ')}（下方结论可能不完整）</div>`;
            st.querySelectorAll('[data-retry]').forEach(a => a.onclick = () => openDiagnose(diagCode, diagYears));
          } else { st.innerHTML = ''; }
        }
      } catch (e2) {}
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
      $('#diagStats').innerHTML = `<div style="margin-bottom:6px">${srcBadge(diagCode + ':div', '分红 ')}${srcBadge(diagCode + ':k', 'K线 ')}${srcBadge('qt:' + (homeState.watchlist || []).map(x => x.code).join(',') || diagCode, '行情 ')}</div><div class="stats">
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
          const seg = fc.note ? `<div class="hint" style="font-size:11px;margin-top:3px">${fc.note}</div>` : '';
          fcEl.insertAdjacentHTML('beforeend', `<div style="margin-top:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:rgba(0,0,0,.15)">
            <div style="font-size:11px;color:var(--sub);margin-bottom:4px">🔮 分红预测三情景（${fc.years.n} 年数据，至 ${fc.years.last} 年度）<span style="font-size:11px">M5引擎</span></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <div style="flex:1;min-width:90px;padding:5px 7px;border-radius:6px;background:rgba(224,90,90,.12)"><div style="font-size:11px;color:#e05a5a">保守（10年周期均）</div><div style="font-size:12px;font-weight:700;color:#e05a5a">${fc.text.conservative}</div></div>
              <div style="flex:1;min-width:90px;padding:5px 7px;border-radius:6px;background:rgba(224,160,48,.12)"><div style="font-size:11px;color:#d9a441">中性（7年周期均）</div><div style="font-size:12px;font-weight:700;color:#d9a441">${fc.text.base}</div></div>
              <div style="flex:1;min-width:90px;padding:5px 7px;border-radius:6px;background:rgba(76,175,125,.12)"><div style="font-size:11px;color:#4caf7d">乐观（最近年度）</div><div style="font-size:12px;font-weight:700;color:#4caf7d">${fc.text.optimistic}</div></div>
            </div>
            ${seg}
            <div class="hint" style="font-size:11px;margin-top:4px">最不确定变量：分红率政策（制度承诺 vs 管理层意愿）与盈利周期——见报告卡财报证据行</div>
          </div>`);
        }
      } catch (e) {}
      // 带状图：历史股息率分位（滚动口径：每年用当年分红）
      renderYieldBand(divs, kline, diagYears);
      // v1.9.0：建仓区状态卡 + 分位信号线（滚动分位，窗口 G_WINDOW） + 分红增长趋势
      renderZoneAndSignal(divs, kline);
      renderDivTrend(divs, kline);
      renderStrategy(divs, kline);
      // v1.9.1 P7：卖出信号卡（EPS 趋势 + 分红连续性 + 估值放大器）
      renderSellSignals(divs, kline, code);
      // v1.9.3：档位画像卡
      renderTierProfile(code);
      /* C15/E2（2026-08-21）：两段式渲染——结论先出，F10 异步填充（填充期显示加载中，W11 联动） */
      // v1.9.6：决策摘要区（买入结论行+关键三数）
      /* C10/P56（2026-08-21）：引擎数字审计——结论行带数据源时间戳（"基于 K线 HH:MM/分红 HH:MM"） */
      let kTs = null, dTs = null;
      try {
        const [kh, dh] = await Promise.all([DL.cacheGet(code + ':k'), DL.cacheGet(code + ':div')]);
        if (kh && kh.ts) kTs = new Date(kh.ts);
        if (dh && dh.ts) dTs = new Date(dh.ts);
      } catch (e2) {}
      renderDecisionSummary(code, divs, kline, { kTs, dTs });
      // 分红节奏
      renderRhythm(divs);
      // v1.8.13 功能D：多起点敏感度（1/3/5/10年前买入对比）
      renderMultiStart(code, divs);
      // O1/O2：报告卡（F10 自动数据优先，研究静态数据兜底）
      const rc = $('#diagReportCard');
      if (rc) {
        rc.style.display = '';
        /* C15/E2：F10 异步填充期——先显示加载占位（结论已在决策主卡先行渲染） */
        rc.innerHTML = '<div class="hint"><span class="spinner"></span>财报数据加载中…（结论已在上方，依据稍后补齐）</div>';
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
      /* 2026-08-21 主人抓"宇通上蹿下跳"：改纯报告期口径（最近完整财年÷当日价），去 A 兜底 366 窗口混入 */
      const t = DL.reportYearDivAt(divs, d);
      if (t > 0) data.push({ d, y: t / kline[d] * 100 });
    }
    // v1.9.26 除息日告警区分（大师裁决 D）：非除息日 dy 单日突变>50% → 标注疑似异常；除息日跳变=正常不标
    const exDates = new Set(divs.filter(x => x.ex).map(x => x.ex));
    const planDates = new Set(divs.filter(x => x.planNotice).map(x => x.planNotice));
    data.forEach((x, i) => {
      if (i === 0) return;
      const prev = data[i - 1];
      if (prev.y <= 0) return;
      const chg = Math.abs(x.y - prev.y) / prev.y;
      /* 2026-08-21：除息日 + 公告日都排除——公告日=报告期口径分子切换（宇通 2026-03-31 公告 2025年报 1.5→2.5 被误标红） */
      if (chg > 0.5 && !exDates.has(x.d) && !planDates.has(x.d)) x.susp = true;
    });
    const suspCount = data.filter(x => x.susp).length;
    if (!data.length) { chart.dispose(); el.innerHTML = '<div class="hint">暂无分红数据</div>'; return; }
    const vals = data.map(x => x.y).sort((a, b) => a - b);
    const pct = p => vals.length ? vals[Math.floor(p * (vals.length - 1))] : null;
    const q25 = pct(0.25), q75 = pct(0.75);
    const lastDate = dates[dates.length - 1];
    /* 2026-08-21 口径统一（主人拍板）：带状图当前值改报告期口径——原 ttmDivsAt 含 A 兜底（366 窗口混 1.5 财年）
     * 与曲线（reportYearDivAt）同尺，否则“当前点 vs 历史分位”错位（大师 M284） */
    let curTtm = null;
    try { const t = DL.reportYearDivAt(divs, lastDate); if (t > 0) curTtm = t / kline[lastDate] * 100; } catch (e) { }
    const cur = curTtm != null ? curTtm : (data.length ? data[data.length - 1].y : null);
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 12 }, formatter: p => { const x = data[p[0].dataIndex]; const y0 = x.d.slice(0, 4); const yrDiv = divs.filter(d => d.ex && d.ex.slice(0, 4) === y0).reduce((s, d) => s + (d.dps || 0), 0); return `<b>${x.d}</b><br/>股息率 <b>${x.y.toFixed(2)}%</b>${yrDiv > 0 ? `<br/><span style="font-size:10px;color:#8fa69c">${y0} 年每股分红 ${yrDiv.toFixed(2)} 元（税前）</span>` : ''}<br/><span style="font-size:10px;color:#8fa69c">报告期口径·公告日切换</span>`; } },
      grid: { left: 46, right: 14, top: 20, bottom: 24 },
      xAxis: { type: 'category', data: data.map(x => x.d), axisLine: { lineStyle: { color: '#3a4f46' } }, axisLabel: { color: '#8fa69c', fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '%' }, splitLine: { lineStyle: { color: '#22322c' } } },
      series: [
        { name: '股息率', type: 'line', showSymbol: false, data: data.map(x => +x.y.toFixed(3)), lineStyle: { width: 1.5, color: '#d9a441' }, areaStyle: { color: 'rgba(217,164,65,.15)' } },
        ...(suspCount ? [{ name: '疑似异常', type: 'scatter', symbol: 'pin', symbolSize: 14, itemStyle: { color: '#e74c3c' }, data: data.filter(x => x.susp).map(x => [x.d, +x.y.toFixed(3)]) }] : []),
        { name: '25%分位', type: 'line', showSymbol: false, data: data.map(() => +q25.toFixed(3)), lineStyle: { type: 'dashed', width: 1, color: '#5aa9e6' } },
        { name: '75%分位', type: 'line', showSymbol: false, data: data.map(() => +q75.toFixed(3)), lineStyle: { type: 'dashed', width: 1, color: '#5aa9e6' } },
      ],
    });
    const note = $('#diagYieldNote');
    if (note) {
      // v1.8.13 功能A：当前股息率的历史分位结论值（窗口=所选年数，不裸报）
      const curPct = (cur != null && vals.length) ? (vals.filter(v => v <= cur).length / vals.length * 100) : null;
      note.textContent = `当前股息率 ${cur != null ? cur.toFixed(2) : '—'}% · 近 ${years||5} 年 ${curPct != null ? curPct.toFixed(0) : '—'}% 分位（25%~75%：${q25 != null ? q25.toFixed(2) : '—'}%~${q75 != null ? q75.toFixed(2) : '—'}%）· 本图=报告期口径（每点=最近完整财年分红÷当日价，公告即算；宇通类一年多派不再窗口混入）${suspCount ? '；⚠️ ' + suspCount + ' 处疑似数据异常（红色标记，非除息日突变>50%，可能数据源错误）' : ''}；年化近2财年=${(() => { try { const ad = DL.calcAnnualDivYield(divs, kline[dates[dates.length-1]]); return ad ? ad.yieldPct.toFixed(2) + '%' : '—'; } catch (e) { return '—'; } })()}`;
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
        /* v2.0 #4：档位传递——当前档位暴露给策略对比（renderStrategy 读取） */
        window._curZone = z.zone; window._curPct = last.pct;
        if (z.currentTier && z.currentTier.pos > histPos) { histPos = z.currentTier.pos; try { localStorage.setItem(posKey, String(histPos)); } catch (e) {} }
        const zoneColor = { start: '#d9a441', add: '#5aa9e6', full: '#4caf7d', extreme: '#2e8b57', watch: '#8fa69c', wait: '#8fa69c', nodata: '#8fa69c' }[z.zone] || '#8fa69c';  /* v1.9.15 情绪反色：极值区=估值低位（绿系） */
        const bar = Math.min(100, Math.max(0, last.pct));
        // 阈值刻度（随模式+生态）
        const tiers = [];
        if (mode === 'flexible') { for (let t = eco.ecoStart; t < 95; t += 10) tiers.push(t); tiers.push(95); }
        else { for (let t = eco.ecoStart; t < 95; t += 5) tiers.push(t); tiers.push(95); }
        const tierLabels = tiers.map(t => t + (t === tiers[0] ? '建' : (t === tiers[tiers.length - 1] ? '满' : '加')));
        // 第二维度：报告期口径股息率 + CAGR 状态词
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
          ? `<div style="display:flex;gap:6px;align-items:center;margin-top:6px"><button type="button" class="mode-chip ${neutral85 ? 'on' : ''}" data-neutral85="1">🔀 85 起建（边界型，数据支持有限）</button><span style="font-size:11px;color:var(--muted)">默认 80（6 只样本，85 优势靠格力/海尔个案，大师 R16 挂起）</span></div>`
          : '';
        const trendHtml = trend && trend.degraded && tcls.cls !== 'trap'
          ? `<div style="margin-top:6px;padding:6px 10px;border-radius:8px;background:rgba(224,90,90,.14);border:1px solid rgba(224,90,90,.45)"><b style="color:#e05a5a">⚠️ 分红连续 ${trend.decStreak} 年下降</b> <span style="font-size:11px;color:var(--sub)">（报告期归组，近3年 ${trend.last3 != null ? trend.last3.toFixed(0) + '%' : '—'}）——分位信号降权，建议回避/小仓</span></div>`
          : '';
        const winGapHtml = winGap != null
          ? `<span class="hint">窗口敏感度：${termTip('W375')}=<b>${last.pct.toFixed(0)}%</b> · W500=${last500.pct.toFixed(0)}%${winGap > 15 ? ' · ⚠️跨窗口差异大，结论参考性降低' : ''}</span>`
          : '';
        // v1.9.15：估值联动行（图1口径交叉引用·大师M4）+ 主信号徽章 + 窗口敏感（大师P3）
        const estSpot = DL.tierSpot(rollingDy, null, diagCode);
        const estWord = estSpot && !estSpot.pending ? (estSpot.cur === 'heavy' ? '深度低估' : estSpot.cur === 'add' ? '低估二档' : estSpot.cur === 'small' ? '低估一档' : '等待') : null;
        const estLink = estSpot && estWord
          ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">估值档（溢价分位·近3年·图1口径）：<b style="color:${estSpot.cur === 'heavy' ? '#2e8b57' : 'var(--txt)'}">${estWord}</b>${estSpot.cur === 'heavy' ? '（深度低估=历史高溢价区，本卡按 95 满档执行）' : estSpot.cur === 'add' ? '（低估二档，加仓节奏参考）' : estSpot.cur === 'small' ? '（低估一档，建仓起点）' : ''}</div>`
          : '';
        const winSens = last.pct >= 93 && last.pct <= 97 ? ` · <span style="color:#d9a441">⚠️窗口敏感·跨档边缘</span>` : '';
        /* v1.9.16 主人令"做个5年10年"：长期复投视角入建仓区状态卡（旧版只在报告卡，主人看的这张没有） */
        const longView = calcLongTermView(series, kline, divs, rollingDy);
        const longHtml = longView && (longView[1250] || longView[2500])
          ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">📈 长期复投视角（同类档位历史表现·非个股承诺）：5年 ${longView[1250] ? longView[1250].winP.toFixed(0) + '%胜率·均值' + (longView[1250].avg >= 0 ? '+' : '') + longView[1250].avg.toFixed(1) + '%（n=' + longView[1250].n + '）' : '样本不足'} · 10年 ${longView[2500] ? longView[2500].winP.toFixed(0) + '%·' + (longView[2500].avg >= 0 ? '+' : '') + longView[2500].avg.toFixed(1) + '%（n=' + longView[2500].n + '）' : '样本不足'}（含分红·不复投·复投更高·不含送转股）</div>`
          : '';
        /* v2.0 #27：加仓机会成本——该股分红 CAGR vs 无风险基准（复投值不值） */
        const oppCostHtml = (() => {
          try {
            const c = DL.calcDivCAGR(divs, 3);
            const rfNow = DL.TREASURY_NOW;
            if (c == null || rfNow == null) return '';
            const diff = c * 100 - rfNow;
            const ok = diff >= 0;
            return `<div style="font-size:11px;color:var(--muted);margin-top:4px">💡 加仓机会成本：分红 CAGR <b class="${c >= 0.05 ? 'green' : (c > 0 ? '' : 'red')}">${(c * 100).toFixed(1)}%</b> vs 国债 ${rfNow.toFixed(2)}% → <b class="${ok ? 'green' : 'red'}">${ok ? '加仓优（分红增速跑赢无风险）' : '机会成本高（不如存国债）'}</b>（分红增速−国债 = ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp；名义口径未扣通胀）</div>`;
          } catch (e) { return ''; }
        })();
        zel.innerHTML = `<div class="zone-row">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="font-weight:600;color:${zoneColor}">📊 估值视角（报告期）· ${z.label}</span>
            <span>当前 <b>${last.pct.toFixed(0)}%</b> 分位（${rangeWord}）${winSens}<span style="font-size:11px;color:var(--sub);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-left:4px">自身分位·近${window.G_WINDOW || 375}日·主信号</span></span>
          </div>
          ${longHtml}
          ${estLink}
          ${oppCostHtml}
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <button type="button" class="mode-chip ${mode === 'conservative' ? 'on' : ''}" data-mode="conservative">🛡 保守（${eco.ecoStart} 起）</button>
            <button type="button" class="mode-chip ${mode === 'flexible' ? 'on' : ''}" data-mode="flexible">🔶 柔性（更早参与）</button>
            <span style="font-size:11px;color:var(--muted);align-self:center">生态：${ecoName}（起建线 ${eco.ecoStart} 分位）</span>
          </div>
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <span style="font-size:11px;color:var(--muted);align-self:center">窗口：</span>
            ${[250, 375, 500].map(w => `<button type="button" class="mode-chip ${(window.G_WINDOW || 375) === w ? 'on' : ''}" data-win="${w}">${w}日${w === 375 ? '·默认' : w === 250 ? '·灵敏' : '·极简'}</button>`).join('')}
          </div>
          <div style="height:10px;background:var(--card2);border-radius:5px;overflow:hidden;position:relative">
            <div style="position:absolute;left:0;top:0;bottom:0;width:${bar}%;background:${zoneColor};border-radius:5px"></div>
            ${tiers.map(t => `<div style="position:absolute;left:${t}%;top:-3px;bottom:-3px;width:1px;background:rgba(255,255,255,.35)" title="${t}分位"></div>`).join('')}
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:3px">
            <span>0</span>${tiers.map((t, i) => `<span>${t}${tierLabels[i] ? '·' + tierLabels[i].replace(t, '') : ''}</span>`).join('')}<span>100</span>
          </div>
          <div class="hint" style="margin-top:6px">${posTxt}${z.zone === 'extreme' ? '（历史 95+ 分位 3 年胜率 97/133，分红未复投，非买入即涨，浮亏均值 -22.9%±）' : ''}</div>
          <div class="hint" style="margin-top:2px">报告期口径股息率 <b>${rollingDy != null ? rollingDy.toFixed(2) + '%' : '—'}</b>（最近已公告完整财年÷当日价，分位窗口${window.G_WINDOW || 375}日）· 分红 CAGR <b class="${cagrColor}">${cagr != null ? (cagr * 100).toFixed(1) + '%' : '—'}</b>（${cagrWord}）${winGapHtml ? ' · ' + winGapHtml : ''}</div>
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
    /* C1（2026-08-21）：折叠 details 展开时 resize 信号线图（折叠容器尺寸 0 → 图不显示） */
    const sigDetails = document.querySelector('#diagZoneCard details');
    if (sigDetails && !sigDetails.dataset.bound) {
      sigDetails.dataset.bound = '1';
      sigDetails.addEventListener('toggle', () => { setTimeout(() => { try { if (_signalChart) _signalChart.resize(); } catch (e2) {} }, 60); });
    }
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
          tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 12 }, formatter: p => { const x = valid[p[0].dataIndex]; return `<b>${x.d}</b><br/>分位 <b>${x.pct.toFixed(0)}%</b> · 股息率 <b>${x.dy.toFixed(2)}%</b>（报告期口径·公告即算）`; } },
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
  function renderDivTrend(divs, kline) {
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
    else if (stops.length === 1) html += '<span style="color:#d9a441"> ⚠️ ' + stops[0].y + ' 分红' + (stops[0].pct < 0 ? '下调' : '停增') + ' ' + stops[0].pct.toFixed(1) + '%（第1年关注，连续2年触发降级观察）</span>';
    html += '</div><table style="width:100%;font-size:12px;margin-top:6px;border-collapse:collapse"><tr style="color:var(--muted)"><th style="text-align:left;padding:3px">报告期</th><th>每股分红</th><th>同比</th><th>趋势</th></tr>';
    last5.forEach((y, i) => {
      const v = byYear[y];
      const yv = i > 0 ? yoy[i-1] : null;
      const cls = yv && yv.pct != null && yv.pct <= 0 ? 'red' : (yv && yv.pct != null && yv.pct > 0 ? 'green' : '');
      const arrow = yv && yv.pct != null ? (yv.pct > 0 ? '▲' : (yv.pct < 0 ? '▼' : '—')) : '';
      html += `<tr><td style="padding:3px">${y}</td><td style="text-align:center">${v.toFixed(3)} 元</td><td style="text-align:center" class="${cls}">${yv ? arrow + ' ' + (yv.pct != null ? yv.pct.toFixed(1) + '%' : '—') : '—'}</td><td style="text-align:center">${yv ? '<span style="color:' + (yv.pct > 0 ? '#4caf7d' : (yv.pct < 0 ? '#e05a5a' : '#8fa69c')) + '">' + (yv.pct > 0 ? '增长' : (yv.pct < 0 ? '下调' : '持平')) + '</span>' : '—'}</td></tr>`;
    });
    html += '</table>';
    /* v2.0 #14：最坏 3 年标注——分红缩水 + 价格大跌双杀时段（kline 年跌幅∩分红下调年） */
    try {
      if (kline && Object.keys(kline).length > 300) {
        const ks = Object.keys(kline).sort();
        const byKYear = {};
        ks.forEach(d => { const y = d.slice(0, 4); if (!byKYear[y] || kline[d] < byKYear[y].min) { if (!byKYear[y]) byKYear[y] = { min: kline[d], max: kline[d] }; else byKYear[y].min = kline[d]; } if (byKYear[y] && kline[d] > byKYear[y].max) byKYear[y].max = kline[d]; });
        const killZones = [];
        Object.keys(byKYear).sort().forEach(y => {
          const yr = byKYear[y];
          if (!(yr.max > 0)) return;
          const yrDrop = (yr.min - yr.max) / yr.max * 100;
          const divDown = yoy.find(v => v.y === y && v.pct != null && v.pct < 0);
          if (divDown && yrDrop <= -20) killZones.push({ y, divPct: divDown.pct, priceDrop: yrDrop });
        });
        if (killZones.length) {
          html += `<div style="font-size:11px;margin-top:4px;padding:4px 8px;border-radius:6px;background:rgba(224,90,90,.08);border:1px solid rgba(224,90,90,.25)">🌪 <b style="color:#e05a5a">历史双杀时段（分红缩水+年跌≥20%）</b>：${killZones.slice(-3).map(z => `${z.y}（分红 ${z.divPct.toFixed(0)}% · 价 ${z.priceDrop.toFixed(0)}%）`).join(' · ')}——压力测试参考，非预测</div>`;
        }
      }
    } catch (e) {}
    html += '<div class="hint" style="margin-top:4px">口径：报告期归组（含中期+末期）；连续2年停增/下调 → 降级观察（卖出第1级信号）</div>';
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
    /* v2.0 #15：信号可信度三档——按档位独立事件数（findZoneEvents 同口径）标注 */
    const nEvents = (t) => DL.findZoneEvents(series, t).length;
    const confTag = (n) => n < 5 ? '<span style="color:#d9a441" title="样本不足">样本不足(' + n + ')</span>' : (n < 10 ? '<span style="color:var(--sub)" title="样本有限">样本有限(' + n + ')</span>' : '<span style="color:#4caf7d" title="样本正常">样本正常(' + n + ')</span>');
    const confLine = `<div style="font-size:11px;color:var(--sub);margin:4px 0">📊 信号可信度（近${window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS}日窗·独立事件数）：80档 ${confTag(nEvents(80))} · 85档 ${confTag(nEvents(85))} · 90档 ${confTag(nEvents(90))} · 95档 ${confTag(nEvents(95))}</div>`;
    strat.sort((a, b) => b.riskEff - a.riskEff);   // 默认风险效率排序
    /* v2.0 #4：档位传递回测——诊断结论档位 → 策略映射（当前档位高亮行）
     * add→金字塔80/85/90（首选）；extreme/full→等90+（历史极值区已到）；start→金字塔（首档刚触发）；watch/wait→未触发提示 */
    const curZone = window._curZone || 'watch';
    const zoneHint = {
      add: { s: '金字塔 80/85/90', txt: '当前处加仓区——映射：金字塔分位买入（80/85/90 各 1/3）' },
      full: { s: '等90+全仓', txt: '当前已到目标档（full）——映射：90 分位已触发，按满仓执行' },
      extreme: { s: '等95+全仓', txt: '当前处极值区——映射：历史 95+ 分位（低估区），可等 95 加重' },
      start: { s: '金字塔 80/85/90', txt: '当前刚触发首档（start）——映射：金字塔 80 起建，后续 85/90 加仓' },
      watch: { s: '—', txt: '当前未触发——映射：等待，不预设策略' },
      wait: { s: '—', txt: '当前未触发——映射：等待，不预设策略' },
      nodata: { s: '—', txt: '数据不足——无法映射' },
    }[curZone] || { s: '—', txt: '' };
    const curRow = strat.find(s => s.name.indexOf(zoneHint.s.replace('（', '').replace('）', '')) >= 0 && zoneHint.s !== '—');
    let html = `<div style="font-size:11px;color:var(--sub);margin-bottom:4px;padding:4px 8px;border-radius:6px;background:rgba(90,169,230,.08);border:1px solid rgba(90,169,230,.3)">🔗 档位传递：当前 <b>${curZone}</b>（分位 ${(window._curPct || 0).toFixed(0)}%）→ 映射策略 <b>${zoneHint.s}</b>：${zoneHint.txt}</div>`;
    html += '<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:4px"><tr style="color:var(--muted)"><th style="text-align:left;padding:4px">策略</th><th>收益</th><th>最大浮亏</th><th>风险效率</th></tr>';
    strat.forEach(s => {
      const hl = curRow && s.name === curRow.name ? ' style="background:rgba(90,169,230,.15)"' : '';
      html += `<tr${hl}><td style="padding:4px">${s.name}${s.note ? '<div style="font-size:11px;color:var(--muted)">' + s.note + '</div>' : ''}</td>
        <td style="text-align:center" class="${s.ret >= 0 ? 'green' : 'red'}">${(s.ret * 100).toFixed(1)}%</td>
        <td style="text-align:center" class="red">${(s.mdd * 100).toFixed(1)}%</td>
        <td style="text-align:center"><b>${s.riskEff.toFixed(2)}</b></td></tr>`;
    });
    html += '</table>';
    html += confLine;
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
    /* v2.0 #5：卖出信号三态分清——减仓建议（交易者）/不追加（新资金）/持有不动（旧持仓） */
    const threeStates = exit
      ? '<div style="font-size:12px;margin:6px 0;padding:6px 8px;border-radius:6px;background:rgba(224,90,90,.12);border:1px solid rgba(224,90,90,.4)">🔻 <b style="color:#e05a5a">减仓建议</b>（交易者视角）：基本面双恶化（分红+EPS 连降），可分批减仓，减仓目标向下取整到整手<br><span style="font-size:11px;color:var(--sub)">🚫 不追加</span>（新资金视角）：此标的暂不投入新资金<br><span style="font-size:11px;color:var(--sub)">🟡 持有观察</span>（旧持仓视角）：已持仓暂不割肉，跟踪下两个财报季是否恢复</div>'
      : (divDegraded || epsWorsened)
        ? '<div style="font-size:12px;margin:6px 0;padding:6px 8px;border-radius:6px;background:rgba(217,164,65,.12);border:1px solid rgba(217,164,65,.4)">🚫 <b style="color:#d9a441">不追加</b>（新资金视角）：单维恶化，暂停追加，等恢复确认<br><span style="font-size:11px;color:var(--sub)">🟡 持有观察</span>（旧持仓视角）：已持仓不动，跟踪是否升级为双恶化<br><span style="font-size:11px;color:var(--sub)">🔻 减仓</span>（交易者视角）：仅当同时触发估值高位（分位≥80）才考虑</div>'
        : '<div style="font-size:12px;margin:6px 0;padding:6px 8px;border-radius:6px;background:rgba(76,175,125,.10);border:1px solid rgba(76,175,125,.35)">✅ <b class="green">持有不动</b>（旧持仓）：无退出信号，继续持有吃分红<br><span style="font-size:11px;color:var(--sub)">➕ 可追加</span>（新资金视角）：基本面健康，按建仓档位信号执行<br><span style="font-size:11px;color:var(--sub)">🔻 减仓</span>（交易者视角）：无基本面理由，仅估值极高时自决</div>';
    const verdict = exit ? '<b class="red">⚠️ 建议退出或减仓</b>' : (divDegraded || epsWorsened) ? '<b style="color:#d9a441">⚠️ 降级观察</b>' : '<b class="green">✅ 无退出信号</b>';
    el.innerHTML = `<div style="margin-bottom:4px">${signals.map(s => `<div style="font-size:12px;margin:2px 0">${s.t}</div>`).join('')}</div>
      <div style="font-size:12px;margin:4px 0">判定：${verdict}</div>
      ${threeStates}
      <div class="hint">估值放大器：${ampTxt}${exit ? '（基本面恶化 + 估值' + (valAmp === 'high' ? '高位 → 退出信号可信' : valAmp === 'low' ? '低位 → 建议二次确认' : '中性') + '）' : ''}</div>
      ${eff ? `<div style="font-size:11px;color:${eff.verdict.indexOf('踏空') >= 0 ? '#e05a5a' : eff.verdict === '有效' ? '#4caf7d' : 'var(--muted)'};margin-top:4px">🎯 该行业卖出信号历史有效性：<b>${eff.verdict}</b>——${eff.txt}</div>` : ''}
      ${exit ? '<div class="hint" style="margin-top:4px;color:#d9a441">💡 释放资金去向：切到 <b>决策台</b> 查看顶部“建仓区提醒”横幅（当前建仓区标的 + 档位距离 + 分红陷阱/钝化标注），或自选持仓巡检卡对比健康标的</div>' : ''}
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
    let assumeHtml = '<div class="hint" style="font-size:11px">数据不足，无假设区间</div>';
    if (fc) {
      const row = (label, v, color) => `<div style="flex:1;min-width:90px;padding:5px 7px;border-radius:6px;background:${color}"><div style="font-size:11px">${label}</div><div style="font-size:12px;font-weight:700">${v}</div></div>`;
      assumeHtml = `<div style="display:flex;gap:8px;flex-wrap:wrap">
        ${row('保守（10年周期均）', fc.text.conservative, 'rgba(224,90,90,.12)')}
        ${row('中性（7年周期均）', fc.text.base, 'rgba(224,160,48,.12)')}
        ${row('乐观（最近年度）', fc.text.optimistic, 'rgba(76,175,125,.12)')}
      </div>`;
    }
    const factsHtml = facts.length ? facts.map(f => `<div style="font-size:11px;margin:2px 0;color:${f.lv === 'red' ? '#e05a5a' : f.lv === 'warn' ? '#d9a441' : f.lv === 'ok' ? 'var(--fg)' : 'var(--sub)'}">${f.lv === 'red' ? '🔴' : f.lv === 'warn' ? '🟡' : f.lv === 'ok' ? '✅' : 'ℹ️'} ${f.t}</div>`).join('') : '<div class="hint" style="font-size:11px">事实层数据不足（不假装有）</div>';
    el.innerHTML = `<div style="font-size:13px;font-weight:700;margin-bottom:4px">🏥 财报体检卡 <span style="font-size:11px;font-weight:400;color:var(--sub)">（M2·事实层可回源/假设层三情景/结论层您拍板）</span></div>
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
    /* v2.0 #18：分红质量标签（F4 版 splitSpecialDivs：现金vs送转/特别占比/覆盖率） */
    try {
      const spl = DL.splitSpecialDivs(divs);
      const sp = spl.filter(d => d.report && /-12-31$/.test(d.report) && !d.pending && d.dps > 0);
      const last2 = sp.slice(-2);
      if (last2.length) {
        const cash = last2.reduce((s, d) => s + (d.regular != null ? d.regular : d.dps), 0);
        const spec = last2.reduce((s, d) => s + (d.special || 0), 0);
        const zhuan = last2.reduce((s, d) => s + ((d.zhuan || 0) * d.dps || 0), 0);
        const cashPct = (cash + spec) > 0 ? cash / (cash + spec) * 100 : 100;
        const specPct = (cash + spec) > 0 ? spec / (cash + spec) * 100 : 0;
        const quality = specPct > 20 ? '<b style="color:#e05a5a">含特别分红（' + specPct.toFixed(0) + '%）——非经常性，估值时注意</b>' : (cashPct >= 90 ? '<b class="green">纯现金分红，质量高</b>' : '<b style="color:#d9a441">现金为主（' + cashPct.toFixed(0) + '%）</b>');
        html += `<div style="font-size:11px;color:var(--sub);margin-top:4px;padding:5px 8px;border-radius:6px;background:rgba(0,0,0,.15);border:1px solid var(--line)">📦 分红质量（近2个完整财年·F4版）：${quality} · 覆盖率(分红/EPS) ${cov != null ? (cov * 100).toFixed(0) + '%' : '—'}${zhuan > 0 ? ' · 含送转' : ''}</div>`;
      }
    } catch (e) {}
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
      /* M296/M320（2026-08-21 大师裁定）：静态战绩=旧口径（2026-08-21 前），标注口径——新口径战绩待积累（回测页现算） */
      const calNote = `<span style="opacity:.75">（旧口径样本·2026-08-21 前）</span>`;
      return `<div style="font-size:11px;color:${color};margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">${prefix} ${trNote || ''}${ddTxt} ${trNote ? calNote : ''}</div>`;
    };
    // 覆盖率（P0-B 修复后口径）
    const cov = DL.coverageAt(divs, parseInt(DL.todayStr().slice(0, 4), 10));
    // 2026-08-21 主人拍板（口径统一）：结论引擎 dps 改纯报告期口径（M284）
    // 原 ttmDivsAtMode = B主+A兜底——A 触发时分子混 1.5 财年，决策结论被污染；改 reportYearDivAt 与分位信号线同尺
    const dps = DL.reportYearDivAt(divs, DL.todayStr());
    const modeNote = '';
    // M295（大师裁定）：储备年数分母用 max(报告期dps, 年化dps)——取大值=储备偏低=保守方向（防空窗期报告期分母偏小→储备虚高假安全感）
    // 年化dps = 近2财年平均分红（calcAnnualDivYield 内部口径）
    let reserveYears = null;
    if (reserve != null) {
      let dpsMax = dps;
      try {
        const ad = DL.calcAnnualDivYield(divs, (extra && extra.price) || null);
        if (ad && ad.annualDps > dpsMax) dpsMax = ad.annualDps;
      } catch (e) {}
      reserveYears = dpsMax > 0 ? reserve / dpsMax : null;
    }
    // M304（大师裁定）：空窗期提示——最近已公告财年 < 当前年（年报未出）时标注，数据驱动不写死日期
    const annYear = DL.latestAnnouncedYear ? DL.latestAnnouncedYear(divs, DL.todayStr()) : null;
    const curYear = parseInt(DL.todayStr().slice(0, 4), 10);
    const windowNote = (annYear != null && annYear < curYear)
      ? ` · <span style="color:#d9a441">最新年报未出，基于 ${annYear} 财年</span>` : '';
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
        if (npRatio > 15) finEvidParts.push(`<span style="color:#d9a441">非经常占 ${npRatio.toFixed(0)}%</span>`);   // 理财/补助虚增嫌疑
      }
    }
    if (ocfCovTxt != null) finEvidParts.push(`分红/OCF <b>${ocfCovTxt.toFixed(0)}%</b>${ocfCovTxt < 100 ? ' <span style="color:#d9a441">(靠家底)</span>' : ''}`);
    if (extra && extra.grossMargin != null) finEvidParts.push(`毛利率 ${extra.grossMargin.toFixed(1)}%`);
    if (extra && extra.liabilityRatio != null) finEvidParts.push(`负债率 ${extra.liabilityRatio.toFixed(1)}%`);
    if (roeDownTxt) finEvidParts.push(`<span style="color:#d9a441">${roeDownTxt}</span>`);
    const finEvidHtml = finEvidParts.length
      ? `<div style="font-size:11px;color:var(--muted);margin:4px 0;padding:5px 8px;background:var(--card2);border-radius:6px;border:1px solid var(--line)">📊 财报证据<span style="font-size:11px;opacity:.7">（L2-F10·${(extra && extra.period) || '—'}·进证据不进决策）</span>：${finEvidParts.join(' · ')}</div>`
      : '';
    const netTxt = (extra && extra.netProfit != null) ? (extra.netProfit >= 100 ? extra.netProfit.toFixed(0) + ' 亿' : extra.netProfit.toFixed(1) + ' 亿') : '<span style="color:var(--muted)">待接入</span>';
    const cagrTxt = cagr != null ? (cagr * 100).toFixed(1) + '%' : '—';
    const covTxt = cov != null ? '覆盖 ' + (1 / cov).toFixed(1) + ' 倍' : '<span style="color:var(--muted)">数据不足</span>';
    const reserveTxt = reserveYears != null ? reserveYears.toFixed(1) + ' 年' : '—';
    const payoutTxt = payoutRate != null ? (payoutRate * 100).toFixed(0) + '%' : '—';
    const dyTxt = dy != null ? dy.toFixed(2) + '%' : '—';
    const pctTxt = pct != null ? pct.toFixed(0) + '%' : '—';
    const lastDate = series.length ? series[series.length - 1].d : null;
    const priceTxt = lastDate ? '<div style="font-size:11px;color:var(--muted)">收盘 ' + lastDate + '</div>' : '';
    const verdictHtml = v.summary;
    /* v1.9.13：分位线语义行（线源/线高低含义/红线/短样本告警） */
    const lineNoteHtml = v.lineNote ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">📐 ${v.lineNote}</div>` : '';
    const sourceTxt = (extra && extra.source) ? extra.source : '研究数据';
    // M1（阶段3）：数据源分级徽章（L0财报原文/L1公告/L2-F10/L3二手）——缺字段=“数据不足”不假装有
    const srcLevel = (extra && extra.source && /F10/.test(extra.source)) ? 'L2' : (extra && extra.source && /研究数据/.test(extra.source)) ? 'L1' : 'L2';
    const srcBadge = `<span style="border:1px solid ${srcLevel === 'L0' ? '#4caf7d' : srcLevel === 'L1' ? '#8bc34a' : '#d9a441'};border-radius:4px;padding:0 4px;color:${srcLevel === 'L0' ? '#4caf7d' : srcLevel === 'L1' ? '#8bc34a' : '#d9a441'}">数据源 ${srcLevel}（${srcLevel === 'L0' ? '财报原文' : srcLevel === 'L1' ? '公告/研究' : 'F10二手' }）</span>`;
    const freshTxt = (extra && extra.period) ? `数据时效：${extra.period}` : '数据时效：实时/延迟（截至最新交易日）';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:12px;font-weight:700">📋 报告卡 · ${periodLabel}${industry ? ' · ' + industry : '<span style="color:#d9a441"> · 行业待确认（仅核心三问）</span>'}</div>
        <div style="font-size:11px;color:var(--muted)">结论由引擎生成 · 可回源</div>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">数据血缘：${sourceTxt} · ${periodLabel}${modeNote}${windowNote} · ${freshTxt} · ${srcBadge}</div>
      ${finEvidHtml}
      <div style="background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px">
        ${v.trap ? `<div style="font-size:11px;margin-bottom:4px;${v.trap.level === 'hard' ? 'color:#e05a5a;font-weight:700' : 'color:#d9a441'}">${v.trap.level === 'hard' ? '🚫' : '⚠️'} ${v.trap.msg}${v.trap.level === 'hard' ? ' · 💱 换仓参考：继续持有=吃当前股息率（覆盖 ' + (cov != null ? (1 / cov).toFixed(1) + ' 倍' : '—') + '）；如需换仓可到决策台扫描对比更健康标的——注意换仓有交易成本+浮盈税（A股印花税 0.05%+佣金），历史数据非承诺' : ''}</div>` : ''}
        ${v.filters && v.filters.length ? `<div style="font-size:11px;margin-bottom:4px;color:#d9a441;background:rgba(217,164,91,.08);border:1px solid rgba(217,164,91,.3);border-radius:6px;padding:3px 6px">🟡 信号降级：仅参考 — ${v.filters.map(f => f.txt).join('；')}</div>` : ''}
        ${verdictHtml}
        ${(() => {
          /* v9.2 UI：买卖指令条（分层徽章+财报确认+行业信号+明确买卖动作）2026-08-20 */
          const layer = DL.TRADE_LAYER[code] || 'auto';
          const layerBadge = layer === 'event'
            ? '<span style="font-size:11px;border:1px solid #d9a441;border-radius:4px;padding:0 4px;color:#d9a441;margin-right:6px">🔎 事件层·人工决策</span>'
            : '<span style="font-size:11px;border:1px solid #5aa9e6;border-radius:4px;padding:0 4px;color:#5aa9e6;margin-right:6px">⚡ 自动层</span>';
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
          const col = ts.action === 'sell' ? '#e05a5a' : ts.action === 'reduce' ? '#d9a441' : ts.action === 'watch' ? '#d9a441' : (ts.action.startsWith('buy_') ? '#4caf7d' : 'var(--muted)');
          const lvNote = ts.level ? ` <span style="font-weight:400;font-size:11px;color:var(--sub)">等级 ${ts.level} · 建议强度 ${ts.strength}</span>` : '';
          const disclaimer = ts.level ? '<span style="font-weight:400;font-size:11px;color:var(--muted);display:block;margin-top:2px">⚠️ 等级=风险提示+建议，最终动作由您拍板</span>' : '';
          return '<div style="font-size:12px;margin-top:6px;padding:6px 9px;border-radius:8px;border:1px solid ' + col + ';background:rgba(0,0,0,.2);color:' + col + ';font-weight:700">' + layerBadge + ts.text + lvNote + '<span style="font-weight:400;font-size:11px;color:var(--sub)"> — ' + ts.reason + '</span>' + disclaimer + '</div>';
        })()}
        ${v.tiers && v.tiers.length ? '<div style="font-size:11px;color:var(--sub);margin-top:4px">🎯 ' + v.tiers.map(t => t.type === 'cur' ? t.text : (t.label || t.type) + ' <b>' + t.rate.toFixed(1) + '%</b><span style="font-size:11px;opacity:.7">（' + t.price + ' 元）</span>' + (t.hit ? ' ✅' : '')).join(' &nbsp;|&nbsp; ') + '</div>' : ''}
        ${v.ref3D ? '<div style="font-size:11px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">📐 三维参考：' + ['abs', 'pct', 'fin'].map(k => { const r = v.ref3D[k]; return r ? `<span style="margin-right:8px"><b>${r.label}</b> ${r.val}${r.ref ? '（' + r.ref + '）' : ''}</span>` : ''; }).join('') + '</div>' : ''}
        ${v.conflicts && v.conflicts.length ? `<div style="font-size:11px;margin-top:3px;color:#d9a441">⚡ 矛盾提示：${v.conflicts.join('；')}（并列展示，请自行裁决）</div>` : ''}
        ${lineNoteHtml}
        ${(() => { const longView = calcLongTermView(series, kline, divs, dy); return longView && (longView[1250] || longView[2500]) ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--line);padding-top:4px">📈 长期持有视角（同类档位历史表现·非个股承诺）：5年 ${longView[1250] ? longView[1250].winP.toFixed(0) + '%胜率·均值' + (longView[1250].avg >= 0 ? '+' : '') + longView[1250].avg.toFixed(1) + '%（n=' + longView[1250].n + '）' : '样本不足'} · 10年 ${longView[2500] ? longView[2500].winP.toFixed(0) + '%·' + (longView[2500].avg >= 0 ? '+' : '') + longView[2500].avg.toFixed(1) + '%（n=' + longView[2500].n + '）' : '样本不足'}（含分红·不复投·复投更高·不含送转股·样本以2010-2016为主）</div>` : ''; })()}
        ${(() => { const fuse = (dy != null && pct != null) ? DL.sellFuse(dy, pct, industry, code, divs, kline) : null; return fuse ? (fuse.active ? `<div style="font-size:11px;margin-top:4px;padding:5px 8px;border-radius:6px;background:rgba(224,90,90,.12);border:1px solid rgba(224,90,90,.45);color:#e05a5a">🚨 ${fuse.msg}</div>` : `<div style="font-size:11px;color:var(--muted);margin-top:3px">🧯 高估保险丝：未激活${fuse.exempt ? '（' + fuse.exempt + '）' : '（分位<5 且 股息率<2.2% 才触发）'}</div>`) : ''; })()}
        ${v.curTier && industry ? sigNoteHtml(industry, v.curTier.name, v.trap, gapAdd) : ''}
      </div>
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <tr>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);border-radius:6px 0 0 6px;text-align:center"><div style="color:var(--muted);font-size:11px">① 状态</div><div>净利 ${netTxt}</div></td>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);text-align:center"><div style="color:var(--muted);font-size:11px">② 可持续</div><div>覆盖 ${covTxt}</div><div>储备 ${reserveTxt} · 分红率 ${payoutTxt}</div></td>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);text-align:center"><div style="color:var(--muted);font-size:11px">③ 质量</div><div>ROE ${roeTxt}</div><div>CAGR ${cagrTxt}</div></td>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);text-align:center"><div style="color:var(--muted);font-size:11px">④ 价格</div><div>股息率 ${dyTxt}</div><div>便宜度(375d) ${pctTxt}</div>${priceTxt}</td>
          <td style="padding:4px;background:var(--card2);border:1px solid var(--line);border-radius:0 6px 6px 0;text-align:center"><div style="color:var(--muted);font-size:11px">⑤ 风险</div><div style="font-size:11px">${v.q3.msg}</div></td>
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
  function decListHtml(limit, filter) {
    /* E4/C17（2026-08-21）：筛选——manual=手动记录 / auto=信号自动 / days=时间范围 */
    let arr = decLog();
    if (filter) {
      if (filter.type === 'manual') arr = arr.filter(x => x.decision === 'buy' || x.decision === 'no' || x.decision === 'wait');
      if (filter.type === 'auto') arr = arr.filter(x => x.decision !== 'buy' && x.decision !== 'no' && x.decision !== 'wait');
      if (filter.days) { const cut = Date.now() - filter.days * 86400000; arr = arr.filter(x => x.ts >= cut); }
    }
    arr = arr.slice(0, limit || 8);
    if (!arr.length) return '<div class="hint">没有匹配的决策记录——信号触发会自动记录，或点上方按钮记本次决策（1-3 年后回来对照）</div>';
    return '<div style="font-size:11px;color:var(--muted);margin-bottom:2px">' + (limit && limit >= 50 ? '共 ' + decLog().length + ' 条记录' : '最近 ' + arr.length + ' 条') + '（自动记录=信号触发；手动=你的决定；🗑=删除）</div>' + arr.map((x, i) => {
      const d = (x.decision === 'buy' ? '✅买' : x.decision === 'no' ? '⏸不买' : x.decision === 'wait' ? '⏳等' : '🔔信号');
      const c = x.decision === 'buy' ? '#4caf7d' : x.decision === 'no' ? '#e05a5a' : x.decision === 'wait' ? '#d9a441' : 'var(--sub)';
      return `<div style="font-size:11px;padding:3px 0;border-bottom:1px dashed var(--line)">${x.date} <b>${x.name || x.code}</b> ${x.tier || ''} · ${x.pct != null ? x.pct.toFixed(0) + '%分位' : ''}${x.dy != null ? ' · ' + x.dy.toFixed(2) + '%' : ''}${x.note ? ' · ' + esc(x.note) : ''}<span style="color:${c}"> ${d}</span>${x.trap ? ' <span style="color:#e05a5a">' + (x.trap.level === 'hard' ? '🚫' : '⚠️') + '</span>' : ''} <button type="button" class="chip" data-del="${i}" style="font-size:10px;padding:0 4px;color:#e05a5a">🗑</button></div>`;
    }).join('');
  }

  /* v1.9.6 P0-8/9：决策摘要区（买入结论行 + 关键三数）——规则树与 rule-tree-backtest.js 一致，历史胜率来自回测表
   * C10/P56（2026-08-21）：opts.dataTs = {kTs, dTs} 数据源时间戳（结论行数字可回源） */
  function renderDecisionSummary(code, divs, kline, dataTs) {
    const el = $('#diagSummary');
    if (!el) return;
    const body = $('#diagSummaryBody');
    const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
    const last = series.filter(x => x.pct != null).pop();
    if (!last) {
      /* W13（2026-08-21）：缺失卡占位不消失——布局稳定（原 display:none 导致跳动），详情见顶部状态条 */
      el.style.display = 'block';
      body.innerHTML = '<div class="hint">数据暂缺（见顶部状态条）——K线/分红数据不足，无法计算分位与结论</div>';
      return;
    }
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
    /* C10/P56（2026-08-21）：结论行数据源时间戳 */
    const dataTsTxt = (dataTs && (dataTs.kTs || dataTs.dTs))
      ? `<span class="hint" style="font-size:10px;color:var(--sub)">（基于 K线 ${dataTs.kTs ? dataTs.kTs.getHours() + ':' + String(dataTs.kTs.getMinutes()).padStart(2, '0') : '—'} · 分红 ${dataTs.dTs ? dataTs.dTs.getHours() + ':' + String(dataTs.dTs.getMinutes()).padStart(2, '0') : '—'}）</span>`
      : '';
    const statTxt = v.tier === 'wait'
      ? '历史：立即买优于等 1 年再买（触发即买胜率更高，回测口径；历史均值非承诺收益）'
      : (st && st[0] != null ? `同类结论历史胜率 ${st[1]}%（${st[2]} 次事件 · 3 年收益均值 ${st[0].toFixed(1)}%（含分红） · 40只×16年回测）` : '历史样本不足');
    /* M318（2026-08-21 大师 U1 裁定）：空窗期顶部黄条——最新年报未出时，股息率/分位基于上年财年（数据驱动） */
    const annYear = DL.latestAnnouncedYear ? DL.latestAnnouncedYear(divs, last.d) : null;
    const curYearN = parseInt(last.d.slice(0, 4), 10);
    const gapBar = (annYear != null && annYear < curYearN)
      ? `<div style="font-size:11px;padding:5px 10px;border:1px solid rgba(217,164,65,.5);border-radius:8px;background:rgba(217,164,65,.10);margin-bottom:6px">⚠️ 最新年报未出，股息率/分位基于 <b>${annYear} 财年</b>（${curYearN} 年报公告后自动更新）</div>` : '';
    const cagr = DL.calcDivCAGR(divs, 3);
    const dyTmp = DL.calcAnnualDivYield(divs, Object.values(kline).pop());
    const yieldTxt = dyTmp ? dyTmp.yieldPct.toFixed(2) + '%' : '—';
    const stepsHtml = v.steps.map((s, i) => `<div style="font-size:11px;color:var(--sub);padding:2px 0">${i + 1}. ${s.msg}</div>`).join('');
    /* v2.0 #16：结论冲突解释——降级类步骤从折叠提到结论行旁（"可建仓但分红下降→观望"） */
    const conflictSteps = v.steps.filter(s => /降级|否决|一票/.test(s.msg));
    const conflictHtml = conflictSteps.length
      ? `<div style="font-size:11px;margin-top:4px;padding:4px 8px;border-radius:6px;background:rgba(224,90,90,.08);border:1px solid rgba(224,90,90,.25);color:var(--sub)">⚠️ 冲突解释：${conflictSteps.map(s => s.msg.replace(/^.*?：/, '')).join('；')}</div>`
      : '';
    body.innerHTML = `
      ${gapBar}
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid rgba(217,164,65,.5);border-radius:10px;padding:8px 10px;background:rgba(217,164,65,.06)">   <!-- W3（2026-08-21）：主信号金描边 -->
        <b style="color:${color};font-size:16px">${icon} ${label}</b>
        <span style="font-size:12px;color:var(--sub)">${statTxt} · 基于历史数据${dataTsTxt}</span>
      </div>
      <div style="font-size:12px;margin-top:6px;color:var(--txt)">当前分位 ${last.pct.toFixed(0)}%（${tcls.label} · ${ecoName}）${waitHint}</div>
      ${conflictHtml}
      <div style="font-size:11px;color:var(--sub);margin-top:4px">股息率(年化近2财年) ${yieldTxt} · 分红率(近2财年) ${cov != null ? (cov * 100).toFixed(0) + '%' : '—'} · 分红CAGR ${cagr != null ? (cagr * 100).toFixed(1) + '%' : '—'}</div>
      <details style="margin-top:6px"><summary style="font-size:11px;color:var(--sub);cursor:pointer">查看判定依据</summary>${stepsHtml}<div style="font-size:11px;color:var(--muted);margin-top:4px">规则：分红趋势一票否决 → 覆盖率降级 → 分位×生态类型 → 等待成本；历史胜率=40只×16年回测（${termTip('W375')}）；非投资建议，不构成买卖依据</div></details>
      <div style="margin-top:6px;border-top:1px dashed var(--line);padding-top:6px">
        <div style="font-size:11px;color:var(--sub);margin-bottom:4px">📒 决策日志（D6：记下今天的选择，1-3 年后自动对照）</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
          <button type="button" class="chip" id="decBtnBuy" style="color:#4caf7d">✅ 记：买</button>
          <button type="button" class="chip" id="decBtnNo" style="color:#e05a5a">⏸ 记：不买</button>
          <button type="button" class="chip" id="decBtnWait" style="color:#d9a441">⏳ 记：等</button>
        </div>
        <div id="decLogList">${decListHtml(6)}</div>
        <!-- C17/E4（2026-08-21）：查看全部+筛选（手动/自动+时间范围） -->
        <div style="margin-top:4px"><button type="button" class="chip" id="decLogMore">📖 查看全部（${decLog().length} 条）</button></div>
      </div>`;
    const bindDec = (decision) => {
      decAdd({ code, name: (window.REPORT_CARD_EXTRA && window.REPORT_CARD_EXTRA[code] && window.REPORT_CARD_EXTRA[code].name) || code, tier: v.tier, pct: last.pct, dy: dyTmp ? dyTmp.yieldPct : null, note: label, trap: null, decision });
      const ll = document.getElementById('decLogList');
      if (ll) ll.innerHTML = decListHtml(6);
    };
    const b1 = document.getElementById('decBtnBuy'); if (b1) b1.onclick = () => bindDec('buy');
    const b2 = document.getElementById('decBtnNo'); if (b2) b2.onclick = () => bindDec('no');
    const b3 = document.getElementById('decBtnWait'); if (b3) b3.onclick = () => bindDec('wait');
    /* C17/E4（2026-08-21）：查看全部→全量列表+筛选（手动/自动/近7天/近30天），展开后绑定筛选 chips */
    const decMore = document.getElementById('decLogMore');
    /* v2.0 #22：决策日志删除（事件委托，快照已带 tier/pct/dy/note） */
    if (!document.querySelector('#decLogList[data-delbound]')) {
      document.addEventListener('click', (e) => {
        const b = e.target && e.target.closest && e.target.closest('[data-del]');
        if (!b) return;
        const idx = parseInt(b.dataset.del, 10);
        try {
          const arr = decLog();
          if (idx >= 0 && idx < arr.length) { arr.splice(idx, 1); localStorage.setItem(DEC_KEY, JSON.stringify(arr.slice(0, 200))); }
        } catch (e2) {}
        const ll = document.getElementById('decLogList');
        if (ll) ll.innerHTML = decListHtml(6);
        const full = document.getElementById('decLogFull');
        if (full) full.innerHTML = decListHtml(100);
      });
    }
    if (decMore) decMore.onclick = () => {
      const ll = document.getElementById('decLogList');
      if (!ll) return;
      ll.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">
          <button type="button" class="chip dec-filter" data-f="all">全部</button>
          <button type="button" class="chip dec-filter" data-f="manual">手动</button>
          <button type="button" class="chip dec-filter" data-f="auto">自动</button>
          <button type="button" class="chip dec-filter" data-f="7d">近7天</button>
          <button type="button" class="chip dec-filter" data-f="30d">近30天</button>
        </div><div id="decLogFull">${decListHtml(100)}</div>`;
      decMore.style.display = 'none';
      ll.querySelectorAll('.dec-filter').forEach(f => f.onclick = () => {
        const ff = f.dataset.f;
        const flt = ff === 'manual' ? { type: 'manual' } : ff === 'auto' ? { type: 'auto' } : ff === '7d' ? { days: 7 } : ff === '30d' ? { days: 30 } : null;
        const full = document.getElementById('decLogFull');
        if (full) full.innerHTML = decListHtml(100, flt);
      });
    };
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
    el.innerHTML = '<div class="hint"><span class="spinner"></span>加载中…</div>';
    try {
      const end = DL.todayStr();
      const start10 = DL.daysAgo(10 * 366);
      const kline = await DL.getKline(code, start10, end);
      const dates = Object.keys(kline).sort();
      if (!dates.length || typeof window.simulate !== 'function') { el.innerHTML = '<div class="hint">数据不足</div>'; return; }
      const rows = [1, 3, 5, 10].map(y => {
        const buyDate = DL.daysAgo(y * 366);
        const res = window.simulate(1000000, buyDate, true, kline, divs, 0, 0);
        return { y, res };
      });
      el.innerHTML = '<div class="tbl-wrap"><table class="tbl sticky-first"><thead><tr><th>买入起点</th><th>买入价</th><th>期末总资产</th><th>累计分红</th><th>年化(XIRR)</th><th>总收益率</th></tr></thead><tbody>' +
        rows.map(r => { const f = r.res.final; return `<tr><td>${r.y}年前（${r.res.buyDateReal}）</td><td>${fmt(r.res.buyPrice, 2)}</td><td>${fmt(f.finalValue, 0)}</td><td>${fmt(f.totalDiv, 0)}</td><td class="${f.xirr != null && f.xirr >= 0 ? 'green' : 'red'}">${fmtPct(f.xirr)}</td><td class="${f.totalReturn >= 0 ? 'green' : 'red'}">${fmtPct(f.totalReturn)}</td></tr>`; }).join('') +
        '</tbody></table><div class="hint">口径：100万本金 · 红利再投资 · 免红利税 · XIRR 含分红再投——"现在买划不划算"参考（起点不同勿直接横比）</div></div>';
    } catch (e) { el.innerHTML = `<div class="hint err">敏感度分析失败：${e.message}</div>`; }
  }

  /* ---------- 对比页占位（第二批） ---------- */
  /* ================= 对比页（v1.7.2 大师 P1-26/27/28 落地） ================= */
  /* N3/P116（2026-08-21）：对比页状态持久化（G3 本次做）——刷新/重开不丢 */
  const CMP_KEY = 'divtool_cmp_state';
  let cmpState = null;
  try { cmpState = JSON.parse(localStorage.getItem(CMP_KEY) || 'null'); } catch (e) {}
  if (!cmpState || !Array.isArray(cmpState.list)) cmpState = { list: [], years: 5, startDate: null };   // list: [{code,name}]；startDate: 精确起始日期（null=用 years 快捷）
  const saveCmpState = () => { try { localStorage.setItem(CMP_KEY, JSON.stringify(cmpState)); } catch (e) {} };
  /* N2/P115（2026-08-21）：自选删除后对比页不再留幽灵——渲染前与 Watchlist 实时同步（无幽灵） */
  const cmpSyncWithWatchlist = async () => {
    try {
      const wl = await DL.Watchlist.list();
      if (!wl.length) return;
      const before = cmpState.list.length;
      cmpState.list = cmpState.list.filter(it => wl.some(w => w.code === it.code));
      if (cmpState.list.length !== before) saveCmpState();
    } catch (e) {}
  };
  let cmpCharts = {};
  let cmpResults = [];   // B8: 表格排序数据源（cmpRun 填充）
  let cmpSort = { key: '', dir: 1 };   // v1.8.13 BUG-5：初始空串（原 null 使 arrow(null) 恒真，标的列一直显示 ▲）

  // B8: 表格渲染（可排序）
  const yieldSeriesStr = r => (r.yieldSeries || []).filter(p => p.v != null).slice(-4).map(p => p.y + ' ' + p.v.toFixed(1) + '%').join(' · ') || '—';
  // v1.8.13 功能B：逐年分红明细行（同比上一年 -20% 标红预警）
  const yearsLine = r => { const ys = (r.res.years || []).slice().sort((a, b) => a.year < b.year ? -1 : 1); return ys.slice().reverse().map((y, i) => { const prev = (i + 1 < ys.length) ? ys[ys.length - 2 - i] : null; const yoy = (prev && prev.divTotal > 0 && y.divTotal != null) ? (y.divTotal - prev.divTotal) / prev.divTotal : null; return y.year + '年：' + fmt(y.divTotal, 0) + ' 元' + (yoy != null && yoy <= -0.2 ? ' <span style="color:var(--red)">⚠️' + (yoy * 100).toFixed(0) + '%</span>' : '') + (y.rate != null ? '（' + (y.rate * 100).toFixed(1) + '%）' : ''); }).join('<br>') || '—'; };
  function renderCmpTable() {
    const getVal = r => ({ final: r.res.final.finalValue, invested: r.res.final.finalInvested, div: r.res.final.totalDiv, recover: (r.res.final.totalDiv != null && r.res.final.finalInvested > 0) ? r.res.final.totalDiv / r.res.final.finalInvested * 100 : null, lastRepDiv: r.lastRepDiv ? r.lastRepDiv.cash : null, xirr: r.res.final.xirr, dd: -r.maxDD, yield12: r.yield12 })[cmpSort.key];
    const list = cmpSort.key ? [...cmpResults].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * cmpSort.dir;
    }) : cmpResults;
    /* C21/F1（2026-08-21）：分项第一名 🏆——每列最大值标记（不排综合，P82；divMissing 不参与） */
    const champ = {};
    const numKeys = ['final', 'invested', 'div', 'recover', 'lastRepDiv', 'xirr', 'dd', 'yield12'];
    numKeys.forEach(k => {
      const vals = list.map(r => {
        if (r.divMissing) return null;
        return k === 'final' ? r.res.final.finalValue : k === 'invested' ? r.res.final.finalInvested : k === 'div' ? r.res.final.totalDiv : k === 'recover' ? r.res.final.totalDiv / r.res.final.finalInvested * 100 : k === 'lastRepDiv' ? (r.lastRepDiv ? r.lastRepDiv.cash : null) : k === 'xirr' ? r.res.final.xirr : k === 'dd' ? -r.maxDD : r.yield12;
      }).filter(v => v != null);
      champ[k] = vals.length ? Math.max(...vals) : null;
    });
    const crown = (k, v) => (v != null && champ[k] != null && Math.abs(v - champ[k]) < 1e-9) ? ' 🏆' : '';
    const arrow = k => (k && cmpSort.key === k) ? (cmpSort.dir > 0 ? ' ▲' : ' ▼') : '';   // v1.8.13 BUG-5：k 非空才显示箭头
    const heads = [['标的', null], ['期末总资产', 'final'], ['累计投入', 'invested'], ['累计分红', 'div'], ['回本率', 'recover'], ['最新报告期分红', 'lastRepDiv'], ['年化(XIRR)', 'xirr'], ['最大回撤', 'dd'], ['股息率(近2财年)', 'yield12'], ['股息率(逐年)', null]];
    const getVal2 = r => (r.res.final.totalDiv != null && r.res.final.finalInvested > 0) ? r.res.final.totalDiv / r.res.final.finalInvested * 100 : null;
    $('#cmpTbl').innerHTML = `<div class="tbl-wrap"><table class="tbl cmp-tbl sticky-first"><tr>${heads.map(h => `<th data-sort="${h[1] || ''}" style="cursor:${h[1] ? 'pointer' : 'default'}">${h[0].indexOf('XIRR') >= 0 ? h[0].replace('XIRR', termTip('XIRR')) : h[0]}${arrow(h[1])}</th>`).join('')}</tr>` +
      list.map((r, i) => `<tr style="${r.divMissing ? 'opacity:.55' : ''};cursor:pointer" data-cmpcode="${r.it.code}" title="点击进诊断">
        <td>${i + 1}. ${r.it.name}${r.divMissing ? ' <span class="risk-badge">数据暂缺</span>' : ''}<br><span style="color:${r.actualStart ? 'var(--red)' : 'var(--sub)'};font-size:11px">${r.it.code}${r.it.market ? '.' + r.it.market.toUpperCase() : ''} · ${r.actualStart ? '自 ' + r.actualStart + ' 起' + (r.liveYears ? ' 约' + r.liveYears + '年' : '') : ''}</span>
          <details style="margin-top:4px;font-size:11px;color:var(--sub)"><summary style="cursor:pointer;color:#4caf7d">逐年分红明细 ▾</summary>
            <div style="margin-top:3px;line-height:1.7">${r.divMissing ? '<span style="color:var(--red)">分红数据暂缺（未纳入对比）</span>' : yearsLine(r)}</div>
          </details></td>
        <td>${fmt(r.res.final.finalValue, 0)} 元${crown('final', r.res.final.finalValue)}</td>
        <td>${fmt(r.res.final.finalInvested, 0)} 元${crown('invested', r.res.final.finalInvested)}</td>   <!-- v1.8.8: 口径与回测页一致（本金+追加+复投），曾只算本金致两边数字对不上 -->
        <td>${r.divMissing ? '<span style="color:var(--red)">数据暂缺</span><br><span style="color:var(--sub);font-size:11px">未纳入对比</span>' : fmt(r.res.final.totalDiv, 0) + ' 元' + crown('div', r.res.final.totalDiv) + '<br><span style="color:var(--sub);font-size:11px">年均 ' + fmt(r.res.final.totalDiv / Math.max(1, (r.res.years || []).length), 0) + ' 元</span>'}</td>
        <td>${r.divMissing ? '—' : '<b>' + fmt(Math.min(999, r.res.final.totalDiv / r.res.final.finalInvested * 100), 1) + '%</b>' + crown('recover', r.res.final.totalDiv / r.res.final.finalInvested * 100) + '<br><span style="color:var(--sub);font-size:11px">累计分红÷投入</span>'}</td>
        <td>${r.divMissing ? '—' : (r.lastRepDiv ? '<span style="color:var(--sub)">' + r.lastRepDiv.year + '</span> ' + fmt(r.lastRepDiv.cash, 0) + ' 元' + crown('lastRepDiv', r.lastRepDiv.cash) : '—')}</td>
        <td class="${r.res.final.xirr != null && r.res.final.xirr >= 0 ? 'green' : 'red'}">${r.res.final.xirr != null ? fmtPct(r.res.final.xirr) + crown('xirr', r.res.final.xirr) : '—'}</td>
        <td class="red">${fmtPct(-r.maxDD)}${crown('dd', -r.maxDD)}</td>
        <td>${r.divMissing ? '—' : (r.yield12 != null ? r.yield12.toFixed(2) + '%' + crown('yield12', r.yield12) : '—')}</td>
        <td style="font-size:11px;color:var(--sub)">${r.divMissing ? '—' : yieldSeriesStr(r)}</td>
      </tr>`).join('') + '</table></div>';
    /* C21/F1（P84）：对比行可点进诊断（summary/表头点击不触发） */
    $('#cmpTbl').querySelectorAll('tr[data-cmpcode]').forEach(tr => {
      tr.onclick = e => { if (e.target.closest('summary') || e.target.closest('th')) return; openDiagnose(tr.dataset.cmpcode); };
    });
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
    /* A1（M218）：持仓环形图 resize（断点切换/移动端不错乱） */
    try { if (typeof _pfRingChart !== 'undefined' && _pfRingChart) _pfRingChart.resize(); } catch (e) { }
    /* 批次2：净值曲线 resize */
    try { if (typeof _netChart !== 'undefined' && _netChart) _netChart.resize(); } catch (e) { }
    /* 批次3 R8：组合回测曲线 resize */
    try { if (typeof _pfbtChart !== 'undefined' && _pfbtChart) _pfbtChart.resize(); } catch (e) { }
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
         <span>${i+1}. ${esc(it.name)} <b style="color:var(--sub)">${esc(it.code)}${it.market ? '.' + it.market.toUpperCase() : ''}</b> <span class="chip" style="font-size:11px;padding:1px 6px">${secTypeLabel(it)}</span></span>
         <button class="chip" data-del="${i}" style="background:rgba(224,94,90,.15);color:var(--red)">✕</button>
       </div>`).join('') + '</div>';
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      cmpState.list.splice(+b.dataset.del, 1);
      saveCmpState();
      cmpRenderList();
    });
  }

  async function cmpAdd(v) {
    const it = typeof v === 'object' ? v : await cmpResolveCode(v);   // C2：支持 {code,name,market} 对象（ETF_PRESETS 指数带 market）
    if (!it) { toast('未找到该标的，请输入 6 位代码或正确名称'); return; }
    if (cmpState.list.some(x => x.code === it.code)) { toast(it.name + ' 已在列表'); return; }
    if (cmpState.list.length >= 5) { toast('最多对比 5 个标的'); return; }
    cmpState.list.push(it);
    saveCmpState();
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
      if (!cmpState.list.length) { toast('请先添加至少 1 个标的'); return; }
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
    if (bad) { toast('本金/月供请输入有效金额（≥0）'); return; }
    const principal = principalRaw || 1000000;
    // v1.8.11 大师 M1/M3：起始日期优先（cmpStartDate），否则快捷年数（今天-N年）
    const start = cmpState.startDate || DL.daysAgo(y * 366);
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
    // 2026-08-21：单只 try/catch——任一标的数据拉取失败（如行情源风控）只跳过该只，不拖垮整个对比页（原 Promise.all 整体 reject → 页面永不渲染）
    const tasks = cmpState.list.map(it => (async () => {
      try {
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
      const snap = (homeState.snap && homeState.snap[it.code]) ? homeState.snap : (await DL.getStockQuotes([it.code]).catch(() => ({})));   // 2026-08-21：快照失败用 {} 兑底（K线末价兜底），不拖垮对比——headless 下 qt 被风控 15s 超时曾致全盘跳过
      if (snap && snap[it.code]) homeState.snap = snap;
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
      } catch (e) {
        errors.push(`「${it.name}(${it.code})」数据拉取失败：${e.message}——已跳过`);
        return null;
      }
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
    const CMP_COLORS = ['#f2c94c', '#5aa9e6', '#4caf7d', '#c46ae0', '#e05a5a'];   // 金(提亮)/蓝/青/紫/红
    const CMP_SYMBOLS = ['circle', 'rect', 'triangle', 'diamond', 'pin'];   // B5: 全实线 + 符号双通道（色弱可辨），CMP_DASH 已删
    const shortName = n => n.length > 8 ? n.slice(0, 8) + '…' : n;
    ch1.setOption({
      backgroundColor: 'transparent', tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', confine: true, formatter: ps => {
        const x = daily0[idx[ps[0].dataIndex]];
        let s = '<b>' + x.date + '</b><br/>';
        ps.forEach(p => { s += p.marker + p.seriesName + '：<b>' + (p.value != null ? fmt(p.value, 0) : '—') + '</b> 元<br/>'; });
        results.forEach(r => {   // B6: 除息日 tooltip（悬停显示，不常驻）
          const ev = r.divByDate[x.date];
          if (ev && ev.length) s += '<span style="color:#4caf7d">📅 ' + shortName(r.it.name) + ' 除息：' + ev.map(e => '派' + (e.dps * 10).toFixed(2) + '元').join('、') + '</span><br/>';
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
    /* v3.0 V11：对比页时间轴回放（拖动看各标的走势） */
    try {
      const tl = document.getElementById('cmpTimeline');
      if (tl) {
        tl.max = String(allDates.length - 1); tl.value = String(allDates.length - 1); tl.disabled = false;
        if (!tl.dataset.bound) {
          tl.dataset.bound = '1';
          tl.addEventListener('input', () => {
            const i = +tl.value;
            const d = allDates[i];
            if (!d || !ch1) return;
            ch1.setOption({ series: [{ markLine: { symbol: 'none', data: [{ xAxis: d }], lineStyle: { color: '#fff', type: 'dotted' } } }] });
          });
        }
      }
    } catch (e) {}
    // 批次4（M189）：收益曲线对比（期初=100 归一化）——同 cmpChartAsset 数据源，看谁跑得快
    try {
      const chN = document.getElementById('cmpChartNorm');
      if (chN && typeof echarts !== 'undefined') {
        const initV = {};
        results.forEach(r => { const first = r.res.daily[0]; if (first) initV[r.it.code] = first.value > 0 ? first.value : null; });
        const chNorm = cmpEnsureChart('cmpChartNorm');
        chNorm.setOption({
          backgroundColor: 'transparent', tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis', confine: true, valueFormatter: v => v != null ? v.toFixed(0) : '—' }),
          legend: { textStyle: { color: '#8fa69c', fontSize: 11 }, top: 0, left: 0, orient: 'horizontal', type: 'plain', itemWidth: 22, itemHeight: 12, formatter: shortName },
          grid: { left: 54, right: 14, top: 34, bottom: 24 },
          xAxis: Object.assign({ type: 'category', data: allDates }, AXIS),
          yAxis: axY({ scale: true, axisLabel: { formatter: v => v + '' } }),
          series: results.filter(r => !r.divMissing && initV[r.it.code] != null).map((r, i) => {
            const vmap = {};
            r.res.daily.forEach(x => { vmap[x.date] = x.value / initV[r.it.code] * 100; });
            return { name: r.it.name, type: 'line', showSymbol: true, symbol: CMP_SYMBOLS[i % 5], symbolSize: 5, data: allDates.map(d => vmap[d] != null ? +vmap[d].toFixed(1) : null), lineStyle: { width: 2.5, color: CMP_COLORS[i % 5], type: 'solid' }, itemStyle: { color: CMP_COLORS[i % 5] } };
          }),
        });
      }
    } catch (e2) {}
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
    cmpSyncWithWatchlist();   // N2/P115：自选删除→对比页同步过滤（异步不阻塞，防数据幽灵）
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
        pn.textContent = '近 ' + cmpState.years + ' 年（自 ' + DL.daysAgo(cmpState.years * 366) + ' 起）';
      }
    };
    if (cy) {
      cy.querySelectorAll('button').forEach(b => b.onclick = () => {
        cmpState.years = +b.dataset.y;
        cmpState.startDate = null;
        saveCmpState();
        const di = $('#cmpStartDate'); if (di) di.value = '';
        cy.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        setPeriodNote();
      });
      const di = $('#cmpStartDate');
      if (di) {
        // M5：min=今天-30年，max=今天（源头挡未来日期/超长周期）
        di.max = DL.todayStr();
        di.min = DL.daysAgo(30 * 366);
        di.addEventListener('change', () => {
          const v = di.value;
          if (!v) { cmpState.startDate = null; saveCmpState(); setPeriodNote(); return; }
          if (v > di.max) { toast('起始日期不能晚于今天'); di.value = ''; cmpState.startDate = null; saveCmpState(); setPeriodNote(); return; }
          cmpState.startDate = v;
          saveCmpState();
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
      const minD = DL.daysAgo(30 * 366);
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
          if (di2) di2.value = DL.daysAgo(y * 366);
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
      // 2026-08-21 修复：URL 恢复必须替换而非追加（localStorage 对比组持久化后，分享链接曾混入旧标的——
      // 注释契约"分享链接只显示 URL 标的"被破坏；C8 e2e 实测 1 只变 3 只）
      cmpState.list = [];
      cmpRenderList();
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
      toast('添加失败：' + e.message);
      return false;
    }
  }

  /* v1.9.4 统一加自选入口（A/B/C 三处共用）：去重检测 + 统一 toast 反馈 */
  let _toastTimer = null;
  /* D11/Y1（2026-08-21）：HTML 转义（防名称/输入注入 innerHTML） */
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* C16/E3（2026-08-21）：术语表 termGlossary——一处定义全站复用，悬停即懂（P77） */
  const termGlossary = {
    'CAGR': '复合年均增长率：分红/收益的年化增速（几何平均，非简单平均）',
    'XIRR': '真实年化收益率：考虑每一笔现金流的时间价值（不等额/不等时点也能算）',
    '滚动分位': '当前股息率在历史窗口中的便宜度排名（0-100，越高=越便宜，非涨跌预测）',
    '钝化': '机会减少：分位长期维持高位不再创新高，便宜度优势被时间磨平',
    '溢价分位': '股息率相对国债收益率的贵贱对比：分位高=相对国债更便宜',
    'W375': '近 375 个交易日（约 1.5 年）的滚动分位计算窗口',
    '生态类型': '股价波动形态：低波/中波/高波/阴跌，决定起建线偏移',
    '起建线': '开始建仓的分位阈值：生态类型不同起建线不同（低波更低）',
    '报告期口径': '每点=最近已公告完整财年分红÷当日价（公告即算；一年多派不混跨财年，分位同尺子可比）',
    '报告期': '分红归属的会计年度（如 2025-12-31 年报/2025-06-30 中报）；未完成的财年（只派了中期、年报未出）不算完整财年，不参与 CAGR/覆盖计算',
    '回本率': '累计分红 ÷ 累计投入：多少年能靠分红回本',
    '事件胜率': '同类触发事件（如“分位≥80”）历史上买入后 3 年正收益的比例',
    '风险效率': '收益 ÷ 最大浮亏：每亏 1% 能赚多少（越高越优）',
  };
  const termTip = key => { const d = termGlossary[key]; return d ? `<span class="tt" title="${esc(d)}">${key}</span>` : key; };

  /* W6（2026-08-21）：错误组件——文案+🔄重试（3s 冷却防连点） */
  const _retryCool = {};
  function showLoadError(el, msg, retryFn) {
    if (!el) return;
    const key = el.id || 'el';
    const wait = _retryCool[key] || 0;
    el.innerHTML = `<div style="padding:10px;border:1px solid rgba(224,94,90,.4);border-radius:8px;background:rgba(224,94,90,.08)"><span style="font-size:12px;color:var(--red)">⚠️ ${msg || '加载失败'}</span><button type="button" class="chip" id="retry-${key}" style="margin-left:8px;color:var(--gold)">🔄 重试</button></div>`;
    const btn = document.getElementById('retry-' + key);
    if (btn) btn.onclick = () => {
      if (Date.now() < wait) { try { toast('请稍候再试（3 秒冷却）'); } catch (e2) {} return; }
      _retryCool[key] = Date.now() + 3000;
      if (retryFn) retryFn();
    };
  }

  /* W10/W12（2026-08-21）：数据源徽章三态——net 实时(绿)/cache 缓存(橙)/fallback 降级(红)；>30 天=已过期(红) */
  /* ========== v2.0 批次4/5：参数中心（配置对象化：加参数=加一行） ========== */
  const PARAMS = [
    { key: 'reinvestRate', label: '复投率', type: 'slider', min: 0, max: 100, step: 5, def: 100, unit: '%', reason: '主人不靠分红生活→滚雪球最优（10年后年分红11.9万 vs 30%的9.2万）；⚡滚雪球/💰吃分红一键切', presets: { '⚡滚雪球': 100, '💰吃分红': 30 } },
    { key: 'growthAlloc', label: '按成长性分配', type: 'toggle', def: true, reason: '分红集中到增长股（宇通/美的/伊利），低增长（平安/工行）转投增长股——+44%→+237%（主人"只要分红大幅上升就值"）' },
    { key: 'cagrAssump', label: 'CAGR假设', type: 'select', options: [['历史', 'hist'], ['中性 8%', 0.08], ['保守 5%', 0.05]], def: 0.08, reason: '宇通35.7%历史不可持续（上限参考），中性8%现实' },
    { key: 'inflation', label: '通胀假设', type: 'slider', min: 0, max: 5, step: 0.5, def: 2, unit: '%', reason: '近年 CPI 中枢；退休模拟敏感度' },
    { key: 'coverTarget', label: '覆盖率目标', type: 'slider', min: 50, max: 150, step: 10, def: 100, unit: '%', reason: '"靠分红生活"目标线' },
    { key: 'riskFree', label: '无风险基准', type: 'select', options: [['国债', 'treasury'], ['理财', 'finance'], ['自定义', 'custom']], def: 'treasury', reason: '吃分红 vs 存银行对比基准（国债 TREASURY_NOW 已有）' },
    { key: 'windowDays', label: '分位窗口', type: 'select', options: [[250, 250], [375, 375], [500, 500]], def: 375, reason: '滚动分位窗口（W375 已有）' },
    { key: 'taxAfter', label: '税后切换', type: 'toggle', def: false, reason: '>1年免税≈税前=税后；新买入 9 折' },
    { key: 'monthSmooth', label: '月度平滑', type: 'toggle', def: false, reason: '曲线按实际到账月 vs 平滑（M330）' },
    { key: 'indConc', label: '行业集中度阈值', type: 'slider', min: 20, max: 50, step: 5, def: 30, unit: '%', reason: '单行业超阈值提示（金融 3/7≈43% 会触发）' },
    { key: 'redDot', label: '异常红点阈值', type: 'slider', min: 20, max: 80, step: 10, def: 50, unit: '%', reason: '突变灵敏度（M289）' },
    /* v3.0 L7/L8：本地 AI 可选层（默认关，模型不绑死） */
    { key: 'localAI', label: '🧠 本地 AI（默认关）', type: 'toggle', def: false, reason: '用电脑本地 Ollama 生成体检报告人话总结——数据不出机器，零 API 费；关=纯电脑能力' },
    { key: 'localModel', label: '本地模型', type: 'select', options: [['qwen3.5:9b（当前）', 'qwen3.5:9b-mlx'], ['自定义', 'custom']], def: 'qwen3.5:9b-mlx', reason: '不绑死——可换任意 Ollama 模型（自定义输入）' },
  ];
  const paramKey = k => 'divtool_param_' + k;
  function getParam(k) {
    const p = PARAMS.find(x => x.key === k);
    if (!p) return null;
    try {
      const raw = localStorage.getItem(paramKey(k));
      if (raw == null) return p.def;
      return p.type === 'toggle' ? raw === '1' : (typeof p.def === 'number' ? parseFloat(raw) : raw);
    } catch (e) { return p.def; }
  }
  function setParam(k, v) { try { localStorage.setItem(paramKey(k), ptype(v)); } catch (e) {} }
  function ptype(v) { return typeof v === 'boolean' ? (v ? '1' : '0') : String(v); }
  /* 参数中心面板（决策台顶部 ⚙️ 入口） */
  function renderParamPanel() {
    const el = document.getElementById('paramPanel');
    if (!el) return;
    const ctl = p => {
      const cur = getParam(p.key);
      if (p.type === 'toggle') return `<button type="button" class="chip ${cur ? 'on' : ''}" data-pk="${p.key}" data-pv="${cur ? 1 : 0}" style="${cur ? 'color:#4caf7d;border-color:#4caf7d' : ''}">${cur ? '✅ 开' : '⬜ 关'}</button>`;
      if (p.type === 'select') return `<select data-pk="${p.key}" style="background:var(--card2);border:1px solid var(--line);border-radius:6px;color:var(--txt);padding:3px 6px;font-size:12px">${p.options.map(o => `<option value="${o[1]}" ${String(cur) === String(o[1]) ? 'selected' : ''}>${o[0]}</option>`).join('')}</select>`;
      if (p.type === 'slider') return `<input type="range" data-pk="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${cur}" style="width:110px;vertical-align:middle"> <span data-show="${p.key}" style="font-size:12px;min-width:44px;display:inline-block">${cur}${p.unit || ''}</span>`;
      return '';
    };
    const presets = PARAMS.filter(p => p.presets);
    el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b style="font-size:13px">⚙️ 参数中心（20+3 参数，改完即时生效）</b><button type="button" class="chip" id="paramResetAll">↺ 全部重置默认</button></div>` +
      (presets.length ? `<div style="display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap">${presets.map(p => Object.entries(p.presets).map(([label, v]) => `<button type="button" class="chip" data-preset="${p.key}" data-pv="${v}" style="color:#5aa9e6">${label}（${p.label} ${v}${p.unit || ''}）</button>`).join('')).join('')}</div>` : '') +
      `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:6px">` + PARAMS.map(p =>
        `<div style="padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card2)"><div style="font-size:12px">${p.label} <span style="font-size:10px;color:var(--muted)">默认 ${p.def}${p.unit || ''}</span></div><div style="margin:4px 0">${ctl(p)}</div><div style="font-size:10px;color:var(--muted)">${p.reason}</div></div>`).join('') + `</div>` +
      `<div class="hint" style="margin-top:4px;font-size:10px">持久化键 divtool_param_&lt;name&gt;（跟随 zone_mode/window_days 先例）；加参数=PARAMS 配置加一行</div>`;
    /* 绑定 */
    el.querySelectorAll('[data-pk]').forEach(ctlEl => {
      const p = PARAMS.find(x => x.key === ctlEl.dataset.pk);
      if (!p) return;
      const apply = (v) => {
        setParam(p.key, v);
        if (p.key === 'windowDays' && window.setDivWindowDays) window.setDivWindowDays(parseInt(v, 10));
        const show = el.querySelector('[data-show="' + p.key + '"]');
        if (show) show.textContent = v + (p.unit || '');
      };
      if (p.type === 'toggle') ctlEl.onclick = () => { const nv = getParam(p.key) ? 0 : 1; apply(nv); renderParamPanel(); };
      else if (p.type === 'select') ctlEl.onchange = () => { apply(p.type === 'select' && typeof p.def === 'number' ? parseFloat(ctlEl.value) : ctlEl.value); };
      else if (p.type === 'slider') { ctlEl.oninput = () => apply(parseFloat(ctlEl.value)); ctlEl.onchange = () => { try { renderHome(); } catch (e) {} }; }
    });
    el.querySelectorAll('[data-preset]').forEach(b => { b.onclick = () => { setParam(b.dataset.preset, ptype(b.dataset.pv === 'true' ? true : (b.dataset.pv === 'false' ? false : parseFloat(b.dataset.pv)))); renderParamPanel(); }; });
    const ra = document.getElementById('paramResetAll');
    if (ra) ra.onclick = () => { PARAMS.forEach(p => { try { localStorage.removeItem(paramKey(p.key)); } catch (e) {} }); renderParamPanel(); };
  }
  function toggleParamPanel() {
    const el = document.getElementById('paramPanel');
    if (!el) return;
    const show = el.style.display !== 'block';
    el.style.display = show ? 'block' : 'none';
    if (show) renderParamPanel();
  }

  function srcBadge(key, label, extra) {
    try {
      const r = DL.srcOf(key);
      const drop = (extra && extra._dropped && extra._dropped.length) ? extra._dropped.length : 0;
      if (!r && !drop) return '';
      const expired = (Date.now() - r.ts) > 30 * 86400000;
      let color = '#4caf7d', txt = '实时';
      if (r.s === 'cache') { color = '#d9a441'; txt = '缓存'; }
      if (r.s === 'fallback' || expired) { color = '#e05a5a'; txt = r.s === 'fallback' ? '降级' : '已过期'; }
      let out = `<span data-badge source="${r.s}" style="display:inline-block;font-size:11px;padding:1px 6px;border-radius:8px;border:1px solid ${color};color:${color};margin-right:6px">${label || ''}${txt}`;
      if (r.caliber) out += ` · ${r.caliber}`;
      out += `</span>`;
      /* #8 数据可信度小结：剔除数聚合（#7 留标记） */
      if (drop) out += `<span data-badge source="dropped" title="该年分红异常已剔除" style="display:inline-block;font-size:11px;padding:1px 6px;border-radius:8px;border:1px solid #e05a5a;color:#e05a5a;margin-right:6px">⚠ 剔除 ${drop} 条异常</span>`;
      return out;
    } catch (e) { return ''; }
  }

  /* v2.0 #9 异常分级提示：major=横幅 / mid=标注 / minor=小字（防狼来了） */
  function renderDataHealth() {
    const el = document.getElementById('dataHealthBar');
    if (!el) return;
    try {
      const keys = Object.keys(window.DL ? (window.DL._srcLogDebug || {}) : {});
      let major = 0, mid = 0, minor = 0;
      const msgs = [];
      /* 聚合：遍历 srcLog（data-layer 暴露遍历器） */
      const log = DL.srcLogAll ? DL.srcLogAll() : [];
      log.forEach(r => {
        if (!r || !r.s) return;
        if (r.s === 'fallback' || r.s === 'proxy') { minor++; msgs.push(r.key + ' 降级'); }
        else if (r.s === 'cache') { mid++; msgs.push(r.key + ' 缓存'); }
        else if (r.s === 'fail' || r.s === 'error') { major++; msgs.push(r.key + ' 获取失败'); }
      });
      if (major) {
        el.style.display = 'block';
        el.style.cssText = 'display:block;background:rgba(224,90,90,.12);border:1px solid #e05a5a;border-radius:8px;padding:8px 12px;font-size:13px;color:#e05a5a;margin-bottom:8px';
        el.innerHTML = `🚨 <b>数据源异常（major）</b>：${msgs.filter(m => /失败/.test(m)).join('；') || '部分数据获取失败'} — 显示可能不完整`;
      } else if (mid) {
        el.style.display = 'block';
        el.style.cssText = 'display:block;background:rgba(217,164,65,.1);border:1px solid rgba(217,164,65,.5);border-radius:8px;padding:6px 12px;font-size:12px;color:#d9a441;margin-bottom:8px';
        el.innerHTML = `ℹ️ 部分数据来自缓存（${mid} 项）` + (minor ? ` · ${minor} 项降级` : '');
      } else if (minor) {
        el.style.display = 'block';
        el.style.cssText = 'display:block;color:#8fa69c;font-size:11px;margin-bottom:6px';
        el.innerHTML = `部分行情来自备源（${minor} 项，实时性略低）`;
      } else {
        el.style.display = 'none';
      }
    } catch (e) { el.style.display = 'none'; }
  }

  /* v2.0 #6 运行时口径自检：?debug=caliber 遍历核对标注×函数 */
  function renderCaliberPanel() {
    const q = new URLSearchParams(location.search);
    if (q.get('debug') !== 'caliber') return;
    const el = document.getElementById('caliberPanel');
    if (!el) return;
    try {
      const rows = DL.caliberAudit();
      const bad = rows.filter(r => r.ok === false);
      el.style.display = 'block';
      el.style.cssText = 'display:block;background:rgba(90,169,230,.08);border:1px solid #5aa9e6;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:8px;font-family:monospace';
      el.innerHTML = `<b>口径自检（?debug=caliber）</b>：共 ${rows.length} 项，${bad.length ? `<span style="color:#e05a5a">${bad.length} 项函数缺失</span>` : '全部函数在位 ✅'}<br>` +
        rows.slice(0, 30).map(r => `${r.ok ? '✅' : '❌'} ${r.key} → ${r.caliber}`).join('<br>');
      console.table && console.table(rows);
    } catch (e) { el.style.display = 'none'; }
  }

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
/* ===== v3.0 组合驾驶舱（替换旧 runPortfolioBacktest）===== */
  let _pfbtRunning = false;
  let _cockpitChart = null, _cockpitTimeline = null;
  let _cockpitRes = null, _cockpitPool = null, _cockpitCombo = null;
  let _comboEditCode = null;   /* v1 N7：反向改——驾驶舱→组合卡预填 */

  /* v3.2 S2：回测快照自动存（独立库 divtool-bt）。
   * 自动：meta:auto:<comboId> + full:auto:<comboId>（一组合一条，覆盖最新）；
   * 固定：meta:pin:<ts> + full:pin:<ts>（用户命名保存，最多 10 条滚动）。 */
  async function btAutoSave(combo, y, mode, res) {
    try {
      const id = 'auto:' + combo.id;
      const now = Date.now();
      const ver = window.APP_VERSION || 'v3.2';
      const meta = {
        id, kind: 'auto', name: combo.name, comboId: combo.id, y, mode,
        at: now, ver, dataDate: DL.todayStr(),
        items: (combo.items || []).map(x => ({ code: x.code, name: x.name, amount: x.amount, monthly: x.monthly })),
      };
      await DL.btSet('full:' + id, { res, combo, at: now, ver, y, mode });
      await DL.btSet('meta:' + id, meta);
      await btEnforceLimit('auto', 10);
    } catch (e) { /* 快照失败不影响主流程 */ }
  }
  async function btPinSave(combo, y, mode, res, label) {
    try {
      const id = 'pin:' + Date.now();
      const now = Date.now();
      const ver = window.APP_VERSION || 'v3.2';
      const meta = { id, kind: 'pin', name: label || (combo.name + ' ' + new Date(now).toLocaleString().slice(5, 16)), comboId: combo.id, y, mode, at: now, ver, dataDate: DL.todayStr(), items: (combo.items || []).map(x => ({ code: x.code, name: x.name, amount: x.amount, monthly: x.monthly })) };
      await DL.btSet('full:' + id, { res, combo, at: now, ver, y, mode });
      await DL.btSet('meta:' + id, meta);
      await btEnforceLimit('pin', 10);
      return id;
    } catch (e) { return null; }
  }
  /* 上限：每种最多 n 条，超出删最旧（按 meta.at） */
  async function btEnforceLimit(kind, n) {
    try {
      const metas = (await DL.btList('meta:' + kind + ':')).map(x => x.val).sort((a, b) => (a.at || 0) - (b.at || 0));
      while (metas.length > n) {
        const old = metas.shift();
        await DL.btDel('meta:' + old.id); await DL.btDel('full:' + old.id);
      }
    } catch (e) {}
  }
  async function btLoadAuto(comboId) {
    try {
      const meta = await DL.btGet('meta:auto:' + comboId);
      if (!meta) return null;
      const full = await DL.btGet('full:auto:' + comboId);
      if (!full || !full.res) return null;
      return { meta, full };
    } catch (e) { return null; }
  }
  async function btListSnapshots() {
    const metas = (await DL.btList('meta:')).map(x => x.val).sort((a, b) => (b.at || 0) - (a.at || 0));
    return metas;
  }
  async function btDelSnapshot(id) {
    await DL.btDel('meta:' + id); await DL.btDel('full:' + id);
  }
  /* 快照提示条：版本戳 + 数据截止日 + 内存文案 + 重跑/固定 */
  function btSnapNotice(meta) {
    try {
      const el = $('#pfbtResult');
      if (!el) return;
      const old = document.getElementById('btSnapBar');
      if (old) old.remove();
      const bar = document.createElement('div');
      bar.id = 'btSnapBar';
      bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:11px;color:var(--sub);background:rgba(217,164,65,.08);border:1px solid rgba(217,164,65,.3);border-radius:8px;padding:6px 10px;margin-bottom:8px';
      const curVer = window.APP_VERSION || 'v3.2';
      const verTxt = meta.ver === curVer ? `v${meta.ver}` : `<b style="color:#e05a5a">旧口径 v${meta.ver}（当前 v${curVer}，建议重跑）</b>`;
      bar.innerHTML = `📸 <b>快照</b> ${esc(meta.name || '')} · 数据截止 ${meta.dataDate || '—'} · ${verTxt} · 跑于 ${meta.at ? new Date(meta.at).toLocaleString().slice(5, 16) : '—'}
        <button type="button" class="chip" id="btSnapRerun">🔄 重跑更新</button>
        <button type="button" class="chip" id="btSnapPin">📌 固定此快照</button>`;
      const rerun = bar.querySelector('#btSnapRerun');
      if (rerun) rerun.onclick = () => { const btn = $('#pfbtRun'); if (btn) btn.click(); };
      const pin = bar.querySelector('#btSnapPin');
      if (pin) pin.onclick = async () => {
        const full = await DL.btGet('full:' + meta.id);
        if (!full || !full.res) { toast('快照数据缺失'); return; }
        const label = prompt('固定快照名称（留空用默认）：', '');
        const id = await btPinSave(full.combo || { name: meta.name }, meta.y || 10, meta.mode || 'weight', full.res, label);
        toast(id ? '✅ 已固定快照' : '固定失败');
      };
      el.insertBefore(bar, el.firstChild);
    } catch (e) { }
  }

  /* 三问卡 + 驾驶舱渲染 */
  function renderCockpit(res, combo, pool, meta) {
    const el = $('#pfbtResult');
    if (!el) return;
    const last = res.last;
    const divRatio = res.divRatio;
    const yearDiv = res.yearDiv;
    const invested = res.invested;
    /* 回本速度：按年分红推算回本年份 */
    let payback = '—';
    if (yearDiv > 0 && invested > 0) {
      const years = invested / yearDiv;
      payback = years <= 99 ? years.toFixed(1) + ' 年' : '>99 年';
    }
    /* 三问卡 */
    const q1 = divRatio.toFixed(1) + '%';
    const q1sub = '累计分红÷投入成本（回本速度）';
    const q2 = (yearDiv / 10000).toFixed(2) + ' 万/年';
    const q2sub = '最近完整年分红（税前）';
    const q3 = (last.value / 10000).toFixed(1) + ' 万';
    const q3sub = '期末总资产（含分红再投+追加）';
    /* 健康色 */
    const q1c = divRatio >= 30 ? 'var(--green,#4caf7d)' : divRatio >= 15 ? 'var(--gold,#d9a441)' : '#e05a5a';
    const q2c = yearDiv >= invested * 0.04 ? 'var(--green,#4caf7d)' : 'var(--gold,#d9a441)';
    const q3c = last.value >= last.invested ? 'var(--green,#4caf7d)' : '#e05a5a';
    const card = (v, sub, c, big, num) => `<div class="v3-card" style="flex:1;min-width:130px;padding:10px 12px;border-radius:10px;background:var(--card2);border:1px solid var(--line);text-align:center">
      <div style="font-size:${big ? 22 : 18}px;font-weight:800;color:${c}">${v}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px">${sub}</div>
    </div>`;
    let html = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      ${card(q1, q1sub, q1c, true)}
      ${card(q2, q2sub, q2c, true)}
      ${card(q3, q3sub, q3c, true)}
    </div>`;
    html += `<div class="hint" style="margin-bottom:6px">✅ 组合「${esc(combo.name || '未命名')}」· ${res.rows} 只 · 近 ${res.span} 年 · 月追加模式：${meta.modeTxt}${meta.cacheNote ? ' ⚡' + meta.cacheNote : ''}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
      <button type="button" class="chip" id="rptFile" style="font-size:11px">💾 报告存本地</button>
      <button type="button" class="chip" id="rptCopy" style="font-size:11px">📋 复制报告</button>
      <button type="button" class="chip" id="rptShare" style="font-size:11px">📤 分享</button>
      <button type="button" class="chip" id="rptBackup" style="font-size:11px;color:#5aa9e6">☁️ 一键备份</button>
      ${localAIEnabled() ? `<button type="button" class="chip" id="rptAI" style="font-size:11px;color:#c46ae0">🧠 AI 人话总结</button>` : ''}
      ${localAIEnabled() ? `<span style="font-size:10px;color:#c46ae0;align-self:center">🧠 本地模式：数据不出机器</span>` : ''}
    </div>`;
    if (meta.failed && meta.failed.length) html += `<div class="hint v3-blink" style="color:#e05a5a;border:1px solid rgba(224,90,90,.3);padding:4px 8px;border-radius:6px">⚠️ 数据可信度：${meta.failed.length}/${combo.items.length} 只数据缺失（${meta.failed.join('、')}），结果未含——请检查网络或数据源</div>`;
    else html += `<div class="hint" style="color:var(--sub)">✅ 数据可信度：${res.rows}/${combo.items.length} 只数据完整（本地缓存/实时行情）</div>`;
    /* 主图（三层：总资产+投入虚线+回撤阴影） */
    html += `<div id="cockpitMain" style="width:100%;height:280px;margin-top:4px"></div>`;
    /* 辅助 3 图（覆盖率环/分红质量环/健康雷达） */
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <div id="cockpitRing" style="width:32%;min-width:150px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
      <div id="cockpitDivRing" style="width:32%;min-width:150px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
      <div id="cockpitRadar" style="flex:1;min-width:180px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
    </div>`;
    /* v1 新增可视化：收益贡献 + 组合股息日历 */
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <div id="cockpitContrib" style="flex:1;min-width:280px;height:190px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
      <div id="cockpitDivCal" style="flex:1;min-width:280px;height:190px;background:var(--card2);border-radius:10px;border:1px solid var(--line);overflow:auto"></div>
    </div>`;
    /* v1 新增可视化：覆盖率演进 + 复投vs提取 + 行业分布 */
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
      <div id="cockpitCovEvol" style="flex:1;min-width:240px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
      <div id="cockpitReinv" style="flex:1;min-width:240px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
      <div id="cockpitIndustry" style="flex:1;min-width:170px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
    </div>`;
    /* 回本进度环（W2：组合环+每只小环） */
    html += `<div id="cockpitPayback" style="width:100%;margin-top:8px;padding:8px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>`;
    /* 时间轴回放 */
    html += `<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);margin-bottom:2px">🎬 时间轴回放：拖动看「我的钱怎么长大」（预计算，拖动只切帧）</div>
      <input type="range" id="cockpitTimeline" min="0" max="${Math.max(0, res.totalAsset.length - 1)}" value="${res.totalAsset.length - 1}" style="width:100%;accent-color:var(--gold)"></div>`;
    /* 分红年度柱状 */
    html += `<div id="cockpitDivBar" style="width:100%;height:150px;margin-top:8px"></div>`;
    /* 每只贡献 + 权重演化（折叠） */
    html += `<details style="margin-top:8px"><summary style="font-size:12px;cursor:pointer;color:var(--sub)">📋 每只贡献 + 权重演化（点开）</summary>
      <table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px"><tr style="color:var(--muted)"><th style="text-align:left;padding:3px">标的</th><th>初始</th><th>月追加</th><th>期末市值</th><th>累计分红</th><th>分红率</th></tr>
      ${res.perStock.map(p => `<tr style="border-top:1px solid var(--line)" data-prow="${esc(p.code)}"><td style="padding:3px"><b>${esc(p.name)}</b></td><td style="text-align:center">${(p.amount / 10000).toFixed(1)}万</td><td style="text-align:center">${p.monthly.toFixed(0)}</td><td style="text-align:center">${(p.finalValue / 10000).toFixed(1)}万</td><td style="text-align:center" class="green">${(p.cumDiv / 10000).toFixed(2)}万</td><td style="text-align:center" class="${p.divRatio >= 15 ? 'green' : p.divRatio >= 8 ? '' : 'red'}">${p.divRatio.toFixed(1)}%</td><td style="text-align:center"><a href="javascript:void(0)" data-adj="${esc(p.code)}" style="color:#5aa9e6;font-size:10px">✏️调</a></td></tr>`).join('')}
      </table>
      <div id="cockpitWeight" style="width:100%;height:160px;margin-top:6px"></div>
    </details>`;
    /* 分析工具（折叠） */
    html += `<details style="margin-top:8px"><summary style="font-size:12px;cursor:pointer;color:var(--sub)">🔬 分析工具（再平衡/敏感度/压力/目标倒推）</summary>
      <div style="font-size:11px;color:var(--muted);margin:6px 0">再平衡建议 / 敏感度 / 压力测试 / 分红目标倒推（v3.0 分析层）</div>
      <div id="cockpitAnalysis" style="display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" class="chip" id="anRebalance">⚖️ 再平衡建议</button>
        <button type="button" class="chip" id="anSens">📉 敏感度（股息率±1pp）</button>
        <button type="button" class="chip" id="anStress">🌪 压力测试（极端年）</button>
        <button type="button" class="chip" id="anTarget">🎯 分红目标倒推</button>
      </div>
      <div id="anResult" style="font-size:11px;color:var(--sub);margin-top:6px"></div>
    </details>`;
    html += `<div class="hint" style="margin-top:6px;color:var(--sub)">口径：事件首日买入→持有至今；收益=期末价+期间分红÷买入价；月追加按所选模式分配（weight=按初始金额比例，口径见上）；${meta.cashTxt || ''}历史回测不代表未来。</div>`;
    el.innerHTML = html;
    _cockpitRes = res; _cockpitPool = pool; _cockpitCombo = combo;
    /* v3.0 动效：三问卡数字滚动 + 卡片进场 */
    try {
      const nums = el.querySelectorAll('.v3-card > div:first-child');
      nums.forEach((nd, i) => {
        const txt = nd.textContent;
        const m = txt.match(/([\d.]+)/);
        if (m) { const target = parseFloat(m[1]); const prefix = txt.slice(0, m.index); const suffix = txt.slice(m.index + m[0].length); const dec = (m[0].split('.')[1] || '').length; v3StepIn(nd.parentElement, i * 80); nd.textContent = prefix + '0'.padEnd(dec ? dec + 2 : 0, '0') + suffix; v3CountUp(nd, target, { dec, dur: 800 }); }
      });
    } catch (e) {}
    drawCockpitCharts(res, combo, pool);
    bindCockpitEvents(res);
  }

  function drawCockpitCharts(res, combo, pool) {
    /* 主图三层 */
    const mainEl = document.getElementById('cockpitMain');
    if (mainEl && typeof echarts !== 'undefined') {
      if (_cockpitChart) { _cockpitChart.dispose(); _cockpitChart = null; }
      const ch = _cockpitChart = echarts.init(mainEl);
      const t = res.totalAsset;
      /* 回撤阴影：计算峰值回撤 */
      const ddData = []; let peak = -Infinity;
      t.forEach(x => { if (x.value > peak) peak = x.value; ddData.push(+( (x.value - peak) / peak * 100).toFixed(2)); });
      ch.setOption({
        title: { text: '组合总资产（含分红再投+追加） vs 累计投入（虚线）', left: 'center', top: 2, textStyle: { fontSize: 11, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 } },
        legend: { top: 18, textStyle: { color: '#8fa69c', fontSize: 10 } },
        grid: { left: 56, right: 14, top: 44, bottom: 26 },
        xAxis: { type: 'time', axisLabel: { color: '#8fa69c', fontSize: 10 }, axisLine: { lineStyle: { color: '#2a3d36' } } },
        yAxis: [
          { type: 'value', name: '万元', nameTextStyle: { color: '#8fa69c', fontSize: 10 }, axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => (v / 10000).toFixed(0) }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
          { type: 'value', name: '回撤%', nameTextStyle: { color: '#8fa69c', fontSize: 10 }, axisLabel: { color: '#8fa69c', fontSize: 10 }, splitLine: { show: false } },
        ],
        series: [
          { name: '总资产', type: 'line', data: t.map(x => [x.d, x.value]), smooth: true, showSymbol: false, lineStyle: { color: '#4caf7d', width: 2.5 }, areaStyle: { color: 'rgba(76,175,125,.12)' } },
          { name: '累计投入', type: 'line', data: t.map(x => [x.d, x.invested]), smooth: true, showSymbol: false, lineStyle: { color: '#d9a441', width: 1.5, type: 'dashed' } },
          { name: '回撤%', type: 'line', yAxisIndex: 1, data: t.map((x, i) => [x.d, ddData[i]]), smooth: true, showSymbol: false, lineStyle: { color: 'rgba(224,90,90,.5)', width: 1 }, areaStyle: { color: 'rgba(224,90,90,.08)' } },
        ],
        animationDuration: 800,
      });
    }
    /* 覆盖率环（用年分红 vs 月支出 12 倍估算） */
    const ringEl = document.getElementById('cockpitRing');
    if (ringEl && typeof echarts !== 'undefined') {
      const ch = echarts.init(ringEl);
      let monthlyExp = 0; try { monthlyExp = parseFloat(localStorage.getItem('divtool_monthly_exp') || '0') || 0; } catch (e) {}
      const cov = monthlyExp > 0 ? Math.min(100, res.yearDiv / 12 / monthlyExp * 100) : null;
      ch.setOption({
        title: { text: '覆盖率', left: 'center', top: '38%', textStyle: { fontSize: 11, color: '#8fa69c' } },
        series: [{ type: 'pie', radius: ['62%', '82%'], silent: true, label: { show: true, position: 'center', formatter: cov != null ? cov.toFixed(0) + '%' : '填月支出', fontSize: 14, color: '#e8efe9' }, data: [{ value: cov != null ? cov : 50, itemStyle: { color: cov != null && cov >= 100 ? '#4caf7d' : '#d9a441' } }, { value: cov != null ? 100 - cov : 50, itemStyle: { color: 'rgba(255,255,255,.08)' } }] }],
      });
    }
    /* 分红质量环（简化：>=4% 股息率算高质量） */
    const divRingEl = document.getElementById('cockpitDivRing');
    if (divRingEl && typeof echarts !== 'undefined') {
      const ch = echarts.init(divRingEl);
      const hi = res.perStock.filter(p => p.divRatio >= 15).length;
      const lo = res.perStock.length - hi;
      ch.setOption({
        title: { text: '分红质量', left: 'center', top: '38%', textStyle: { fontSize: 11, color: '#8fa69c' } },
        series: [{ type: 'pie', radius: ['62%', '82%'], silent: true, label: { show: true, position: 'center', formatter: res.perStock.length ? hi + '/' + res.perStock.length : '—', fontSize: 13, color: '#e8efe9' }, data: [{ value: hi, name: '强(≥15%)', itemStyle: { color: '#4caf7d' } }, { value: lo, name: '一般', itemStyle: { color: '#d9a441' } }] }],
      });
    }
    /* 健康雷达 */
    const radarEl = document.getElementById('cockpitRadar');
    if (radarEl && typeof echarts !== 'undefined') {
      const ch = echarts.init(radarEl);
      const divRatio = res.divRatio;
      const cov = res.yearDiv > 0 ? Math.min(100, res.yearDiv / Math.max(1, res.invested) * 100 * 3) : 0;  // 归一化
      const conc = res.perStock.length ? Math.max(...res.perStock.map(p => p.finalValue / Math.max(1, res.last.value) * 100)) : 0;
      const ddMax = 100;
      const growth = res.perStock.length ? res.perStock.reduce((s, p) => s + Math.max(0, Math.min(100, (p.ret + 1) * 50)), 0) / res.perStock.length : 0;
      ch.setOption({
        title: { text: '组合健康', left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
        radar: { indicator: [{ name: '分红回报', max: 100 }, { name: '覆盖率', max: 100 }, { name: '分散度', max: 100 }, { name: '回撤控制', max: 100 }, { name: '成长性', max: 100 }], radius: '62%', axisName: { color: '#8fa69c', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.08)' } } },
        series: [{ type: 'radar', data: [{ value: [Math.min(100, divRatio * 2), cov, Math.max(0, 100 - conc), Math.max(0, 100 - ddMax), growth], name: '健康', areaStyle: { color: 'rgba(76,175,125,.2)' }, lineStyle: { color: '#4caf7d' }, itemStyle: { color: '#4caf7d' } }] }],
      });
    }
    /* 权重演化 */
    const wEl = document.getElementById('cockpitWeight');
    if (wEl && typeof echarts !== 'undefined') {
      const ch = echarts.init(wEl);
      const ys = res.weightEvol.map(w => w.y);
      const names = res.perStock.map(p => p.name);
      const series = names.map((nm, i) => {
        const code = res.perStock[i].code;
        return { name: nm, type: 'line', stack: 'w', data: res.weightEvol.map(w => +(w.weights[code] || 0).toFixed(1)), smooth: true, showSymbol: false, lineStyle: { width: 1 } };
      });
      ch.setOption({
        title: { text: '权重演化（动态再平衡视角）', left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
        legend: { top: 16, textStyle: { color: '#8fa69c', fontSize: 9 }, type: 'scroll' },
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 } },
        grid: { left: 40, right: 12, top: 40, bottom: 24 },
        xAxis: { type: 'category', data: ys, axisLabel: { color: '#8fa69c', fontSize: 10 } },
        yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '%' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        series,
      });
    }
    /* v1 V3：收益贡献条形图（分红贡献金 + 价格贡献红涨绿赔） */
    const cbEl = document.getElementById('cockpitContrib');
    if (cbEl && typeof echarts !== 'undefined') {
      const ch = echarts.init(cbEl);
      const names = res.perStock.map(p => p.name);
      const divC = res.perStock.map(p => +(p.cumDiv / 10000).toFixed(2));
      const priceC = res.perStock.map(p => +((p.finalValue - p.invested) / 10000).toFixed(2));
      ch.setOption({
        title: { text: '收益贡献（金=分红 · 红涨/绿赔=价格）', left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => p.map(x => x.marker + ' ' + x.seriesName + '：' + x.value + '万').join('<br>') },
        legend: { top: 14, textStyle: { color: '#8fa69c', fontSize: 9 } },
        grid: { left: 14, right: 90, top: 40, bottom: 24 },
        xAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        yAxis: { type: 'category', data: names, axisLabel: { color: '#8fa69c', fontSize: 10 } },
        series: [
          { name: '分红贡献', type: 'bar', data: divC, itemStyle: { color: '#d9a441', borderRadius: [0, 3, 3, 0] }, barMaxWidth: 10 },
          { name: '价格贡献', type: 'bar', data: priceC, itemStyle: { color: (p) => p.value >= 0 ? '#e05a5a' : '#4caf7d', borderRadius: [0, 3, 3, 0] }, barMaxWidth: 10 },
        ],
        animationDuration: 600,
      });
    }
    /* v1 V6：组合股息日历（未来 12 个月到账，HTML 表） */
    const dcEl = document.getElementById('cockpitDivCal');
    if (dcEl) {
      const today = DL.todayStr ? DL.todayStr() : new Date().toISOString().slice(0, 10);
      const end = (() => { const d = new Date(); d.setMonth(d.getMonth() + 12); return d.toISOString().slice(0, 10); })();
      const months = {};
      (combo.items || []).forEach(it => {
        const divs = (pool[it.code] && pool[it.code].divs) || [];
        divs.filter(d => d.ex && d.ex >= today && d.ex <= end).forEach(d => {
          const m = d.ex.slice(0, 7);
          if (!months[m]) months[m] = [];
          months[m].push({ name: it.name || it.code, cash: d.dps || 0 });
        });
      });
      const ms = Object.keys(months).sort();
      dcEl.innerHTML = `<div style="font-size:10px;color:#8fa69c;padding:6px 8px 0">📅 组合股息日历（未来12个月 · 估=上年同期推算）</div>` + (ms.length
        ? `<table style="width:100%;font-size:10px;border-collapse:collapse;margin-top:4px">${ms.map(m => `<tr style="border-top:1px solid var(--line)"><td style="padding:3px 8px;color:var(--gold);font-weight:700">${m}</td><td style="padding:3px">${months[m].map(x => `${esc(x.name)} ${x.cash.toFixed(2)}`).join(' · ')}</td><td style="padding:3px;text-align:right;color:var(--sub)">${(months[m].reduce((s, x) => s + x.cash, 0)).toFixed(2)}/股</td></tr>`).join('')}</table>`
        : `<div style="padding:10px;font-size:11px;color:var(--muted)">未来 12 个月暂无已宣告分红（或数据未含）</div>`);
    }
    /* v1 N13：覆盖率演进曲线（年分红÷月支出×12 逐年） */
    const ceEl = document.getElementById('cockpitCovEvol');
    if (ceEl && typeof echarts !== 'undefined') {
      let monthlyExp = 0; try { monthlyExp = parseFloat(localStorage.getItem('divtool_monthly_exp') || '0') || 0; } catch (e) {}
      const ch = echarts.init(ceEl);
      const ys = Object.keys(res.divByYear).sort();
      const cov = monthlyExp > 0 ? ys.map(y => +(res.divByYear[y] / 12 / monthlyExp * 100).toFixed(1)) : [];
      ch.setOption({
        title: { text: monthlyExp > 0 ? '覆盖率演进（年分红÷月支出×12）' : '覆盖率演进（填月支出后显示）', left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => p[0].name + '：' + p[0].value + '%' },
        grid: { left: 40, right: 14, top: 30, bottom: 24 },
        xAxis: { type: 'category', data: ys, axisLabel: { color: '#8fa69c', fontSize: 10 } },
        yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '%' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        series: [{ name: '覆盖率', type: 'line', data: cov, smooth: true, showSymbol: false, lineStyle: { color: '#5aa9e6', width: 2 }, areaStyle: { color: 'rgba(90,169,230,.12)' }, markLine: { data: [{ yAxis: 100, lineStyle: { color: '#4caf7d', type: 'dashed' }, label: { formatter: '100%', color: '#4caf7d', fontSize: 9 } }] } }],
        animationDuration: 600,
      });
    }
    /* v1 N12：复投 vs 提取对比（重跑 reinvest=false） */
    const riEl = document.getElementById('cockpitReinv');
    if (riEl && typeof echarts !== 'undefined') {
      const ch = echarts.init(riEl);
      /* 提取模式：每只 reinvest=false 汇总 */
      const t = res.totalAsset;
      let extractSeries = null;
      try {
        const exRows = [];
        (combo.items || []).forEach(it => {
          const p = pool[it.code];
          if (!p || !p.kline) return;
          const sim = DL.simulateOne((it.amount || 0) * ((combo.cashPct || 0) > 0 ? (1 - (combo.cashPct || 0) / 100) : 1), it.monthly || 0, p.kline, p.divs, false, 0);
          if (sim) exRows.push(sim);
        });
        if (exRows.length) {
          const ds = {};
          exRows.forEach(sim => sim.daily.forEach(dd => { ds[dd.date] = (ds[dd.date] || 0) + dd.value; }));
          const dates = Object.keys(ds).sort();
          extractSeries = dates.map(d => [d, ds[d]]);
        }
      } catch (e) {}
      ch.setOption({
        title: { text: '分红复投 vs 提取（复利的力量）', left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
        legend: { top: 14, textStyle: { color: '#8fa69c', fontSize: 9 } },
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 } },
        grid: { left: 44, right: 14, top: 40, bottom: 24 },
        xAxis: { type: 'time', axisLabel: { color: '#8fa69c', fontSize: 10 } },
        yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => (v / 10000).toFixed(0) + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        series: [
          { name: '复投', type: 'line', data: t.map(x => [x.d, x.value]), smooth: true, showSymbol: false, lineStyle: { color: '#4caf7d', width: 2 } },
          { name: '提取', type: 'line', data: extractSeries || [], smooth: true, showSymbol: false, lineStyle: { color: '#8fa69c', width: 1.5, type: 'dashed' } },
        ],
        animationDuration: 600,
      });
    }
    /* v1 V4：行业分布条形（TIER_LINE 行业） */
    const indEl = document.getElementById('cockpitIndustry');
    if (indEl && typeof echarts !== 'undefined') {
      const ch = echarts.init(indEl);
      const indMap = {};
      let other = 0;
      (combo.items || []).forEach(it => {
        const tl = DL.TIER_LINE && DL.TIER_LINE[it.code];
        const ind = tl && tl.ind ? tl.ind : '其他';
        indMap[ind] = (indMap[ind] || 0) + (it.amount || 0);
      });
      const IND_NAME = { bank: '银行', consumer: '消费', utility: '公用', energy: '能源', telecom: '电信', manufacture: '制造' };
      const rows2 = Object.keys(indMap).map(k => ({ name: IND_NAME[k] || k, value: indMap[k] })).sort((a, b) => b.value - a.value);
      const maxInd = rows2.length ? rows2[0] : null;
      ch.setOption({
        title: { text: '行业分布' + (maxInd && maxInd.value / (combo.items.reduce((s, it) => s + (it.amount || 0), 0) || 1) > 0.5 ? ' · ⚠️集中' : ''), left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => p[0].name + '：' + (p[0].value / 10000).toFixed(1) + '万' },
        grid: { left: 14, right: 50, top: 28, bottom: 20 },
        xAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 9, formatter: v => (v / 10000).toFixed(0) + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        yAxis: { type: 'category', data: rows2.map(r => r.name), axisLabel: { color: '#8fa69c', fontSize: 10 } },
        series: [{ type: 'bar', data: rows2.map(r => r.value), itemStyle: { color: '#9b6df0', borderRadius: [0, 3, 3, 0] }, barMaxWidth: 12 }],
        animationDuration: 600,
      });
    }
    /* v1 W2：回本进度环（组合环+每只小环，hover 显示回本率%） */
    const pbEl = document.getElementById('cockpitPayback');
    if (pbEl) {
      const ringHtml = (label, ratio, color) => {
        const r = Math.min(100, Math.max(0, ratio));
        return `<div style="display:inline-block;text-align:center;margin:4px 10px">
          <div style="position:relative;width:64px;height:64px">
            <svg viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="7"/><circle cx="32" cy="32" r="26" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(r / 100 * 163.4).toFixed(1)} 163.4" transform="rotate(-90 32 32)"/></svg>
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:${color}">${r.toFixed(0)}%</div>
          </div>
          <div style="font-size:9px;color:var(--muted);margin-top:2px">${label}</div>
        </div>`;
      };
      let html = `<div style="font-size:10px;color:#8fa69c;padding:0 2px">🔁 回本进度（累计分红÷投入）：</div>`;
      html += ringHtml('组合', res.divRatio, '#d9a441');
      res.perStock.forEach(p => { html += ringHtml(p.name.length > 4 ? p.name.slice(0, 4) : p.name, p.divRatio, p.divRatio >= 30 ? '#4caf7d' : p.divRatio >= 15 ? '#d9a441' : '#5aa9e6'); });
      pbEl.innerHTML = html;
    }
    /* v1 W3：来源堆叠——分红柱状叠加个股构成（累计分红口径） + N11 增速标注 + W1 断档警示 */
    const barEl3 = document.getElementById('cockpitDivBar');
    if (barEl3 && typeof echarts !== 'undefined') {
      const ch = echarts.init(barEl3);
      const ys = Object.keys(res.divByYear).sort();
      const vals = ys.map(y => res.divByYear[y]);
      /* 增速标注 */
      const labels = ys.map((y, i) => {
        if (i === 0) return '';
        const prev = vals[i - 1];
        if (!(prev > 0)) return '';
        const g = (vals[i] - prev) / prev * 100;
        return (g >= 0 ? '+' : '') + g.toFixed(1) + '%';
      });
      /* 断档警示：连续 2 年下降 */
      let warn = '';
      for (let i = ys.length - 1; i >= 2; i--) {
        if (vals[i] < vals[i - 1] && vals[i - 1] < vals[i - 2]) { warn = `⚠️ 分红连续 ${ys.length - i} 年下降（${ys[i - 2]}→${ys[i]}），关注分红持续性`; break; }
      }
      /* 来源堆叠：perStock 累计分红构成 */
      const cumTotal = res.perStock.reduce((s, p) => s + p.cumDiv, 0);
      const stackData = ys.map(y => res.perStock.map(p => +(p.cumDiv / Math.max(1, cumTotal) * res.divByYear[y]).toFixed(2)));
      const stackSeries = res.perStock.map((p, pi) => ({ name: p.name, type: 'bar', stack: 'div', data: stackData.map(d => d[pi]), itemStyle: { color: _comboPalette[pi % _comboPalette.length] }, barMaxWidth: 26 }));
      ch.setOption({
        title: { text: '年度分红到账（税前 · 堆叠=个股构成）' + (warn ? ' · ' + warn : ''), left: 'center', top: 2, textStyle: { fontSize: 10, color: warn ? '#e05a5a' : '#8fa69c' } },
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 } },
        legend: { top: 14, textStyle: { color: '#8fa69c', fontSize: 9 }, type: 'scroll' },
        grid: { left: 56, right: 12, top: 40, bottom: 24 },
        xAxis: { type: 'category', data: ys, axisLabel: { color: '#8fa69c', fontSize: 10 } },
        yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => (v / 10000).toFixed(0) + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        series: [...stackSeries, { type: 'bar', data: vals, barMaxWidth: 26, itemStyle: { color: 'transparent' }, label: { show: true, position: 'top', formatter: p => labels[p.dataIndex], color: '#8fa69c', fontSize: 9 }, tooltip: { show: false }, silent: true }],
        animationDuration: 600,
      });
    }
  }

  function bindCockpitEvents(res) {
    /* v1 N7/M533：反向改——结果页「✏️调」→ 回组合卡预填该行 */
    document.querySelectorAll('#pfbtResult [data-adj]').forEach(a => a.onclick = () => {
      const code = a.dataset.adj;
      _comboEditCode = code;
      switchTab('home');
      setTimeout(() => {
        const row = document.querySelector(`#comboListWrap [data-crow]`);
        _comboItems.forEach((it, i) => { if (it.code === code) { const r2 = document.querySelector(`[data-crow="${i}"]`); if (r2) { r2.scrollIntoView({ block: 'center', behavior: 'smooth' }); r2.style.background = 'rgba(90,169,230,.18)'; setTimeout(() => { r2.style.background = ''; }, 2000); const ai = r2.querySelector('[data-amt]'); if (ai) ai.focus(); toast('调整「' + it.name + '」金额/比例'); } } });
      }, 400);
    });
    /* v1 块8：收益贡献图点击某只 → 高亮 perStock 行（四视图联动之一） */
    const cbEl = document.getElementById('cockpitContrib');
    if (cbEl && typeof echarts !== 'undefined') {
      const inst = echarts.getInstanceByDom(cbEl);
      if (inst) inst.on('click', p => {
        if (p && p.dataIndex != null) {
          const code = res.perStock[p.dataIndex] && res.perStock[p.dataIndex].code;
          if (code) {
            const tr = document.querySelector(`[data-prow="${code}"]`);
            if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); tr.style.background = 'rgba(217,164,65,.18)'; setTimeout(() => { tr.style.background = ''; }, 1800); }
          }
        }
      });
    }
    /* v3.0 C3/C4/C5/W1：体检报告本地文件/剪贴板/分享 + 一键备份（纯电脑能力） */
    const mkReportTxt = () => {
      const combo = _cockpitCombo || { name: '组合' };
      const lines = [
        '🧮 组合体检报告 · ' + DL.todayStr(),
        '组合：' + combo.name + '（' + res.rows + ' 只 · 近 ' + res.span + ' 年）',
        '💰 回本速度：累计分红÷投入 ' + res.divRatio.toFixed(1) + '%',
        '📅 年分红（最近完整年）：' + (res.yearDiv / 10000).toFixed(2) + ' 万',
        '📊 期末总资产：' + (res.last.value / 10000).toFixed(1) + ' 万（投入 ' + (res.invested / 10000).toFixed(1) + ' 万）',
        '',
        '📋 每只贡献：',
      ];
      res.perStock.forEach(p => { lines.push('  ' + p.name + '：初始 ' + (p.amount / 10000).toFixed(1) + '万 期末 ' + (p.finalValue / 10000).toFixed(1) + '万 分红 ' + (p.cumDiv / 10000).toFixed(2) + '万（' + p.divRatio.toFixed(1) + '%）'); });
      lines.push('', '口径：月追加按所选模式分配；历史回测不代表未来。');
      return lines.join('\n');
    };
    const rf = document.getElementById('rptFile');
    if (rf && !rf.dataset.bound) { rf.dataset.bound = '1'; rf.onclick = async () => { const txt = mkReportTxt(); try { if (window.showSaveFilePicker) { const h = await window.showSaveFilePicker({ suggestedName: '组合体检-' + DL.todayStr() + '.txt' }); const w = await h.createWritable(); await w.write(txt); await w.close(); toast('已存到本地文件'); return; } } catch (e) {} const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' })); a.download = '组合体检-' + DL.todayStr() + '.txt'; a.click(); toast('已下载报告'); }; }
    const rc = document.getElementById('rptCopy');
    if (rc && !rc.dataset.bound) { rc.dataset.bound = '1'; rc.onclick = async () => { try { await navigator.clipboard.writeText(mkReportTxt()); toast('✅ 报告已复制到剪贴板'); } catch (e) { toast('复制失败（浏览器限制）'); } }; }
    const rs = document.getElementById('rptShare');
    if (rs && !rs.dataset.bound) { rs.dataset.bound = '1'; rs.onclick = async () => { try { if (navigator.share) { await navigator.share({ title: '组合体检报告', text: mkReportTxt() }); } else { await navigator.clipboard.writeText(mkReportTxt()); toast('已复制（当前环境无系统分享）'); } } catch (e) {} }; }
    const ra = document.getElementById('rptAI');
    if (ra && !ra.dataset.bound) { ra.dataset.bound = '1'; ra.onclick = async () => { const a = document.getElementById('anResult'); if (!a) { toast('先运行体检'); return; } a.innerHTML = '🧠 本地模型生成中（Ollama）…'; const tpl = '回本速度' + res.divRatio.toFixed(1) + '%，年分红' + (res.yearDiv / 10000).toFixed(2) + '万，期末' + (res.last.value / 10000).toFixed(1) + '万，' + res.rows + '只组合'; const txt = await localAIExplain(tpl); a.innerHTML = '🧠 AI 总结：' + esc(txt) + '<div style="font-size:10px;color:var(--muted);margin-top:4px">本地模型 ' + esc(localModelName()) + ' · 数据不出机器 · 数字由模板保证准确，AI 只润色语气</div>'; }; }
    const rb = document.getElementById('rptBackup');
    if (rb && !rb.dataset.bound) { rb.dataset.bound = '1'; rb.onclick = () => { try { const data = { v: 2, app: 'dividend-tool', exportedAt: DL.todayStr(), combos: DL.loadCombos(), watchlist: JSON.parse(localStorage.getItem('divtool_watchlist_v1') || '[]'), holdings: JSON.parse(localStorage.getItem('divtool_holdings_v1') || '[]'), decisions: JSON.parse(localStorage.getItem('divtool_decisions_v1') || '[]') }; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = 'dividend-tool-full-backup-' + DL.todayStr() + '.json'; a.click(); try { localStorage.setItem('divtool_last_export', String(Date.now())); } catch (e) {} toast('✅ 全量备份已下载（数据主权：我的数据在我电脑里）'); } catch (e) { toast('备份失败：' + e.message); } }; }
    const tl = document.getElementById('cockpitTimeline');
    if (tl && !tl.dataset.bound) {
      tl.dataset.bound = '1';
      tl.addEventListener('input', () => {
        const idx = +tl.value;
        const x = res.totalAsset[idx];
        if (!x || !_cockpitChart) return;
        /* 时间轴回放：主图加 markLine 当前点 */
        _cockpitChart.setOption({ series: [{ markLine: { symbol: 'none', data: [{ xAxis: x.d }], lineStyle: { color: '#fff', type: 'dotted' } } }] });
      });
    }
    const anReb = document.getElementById('anRebalance');
    if (anReb && !anReb.dataset.bound) { anReb.dataset.bound = '1'; anReb.onclick = () => { const a = document.getElementById('anResult'); if (!a) return; const lastW = res.weightEvol[res.weightEvol.length - 1]; if (!lastW) { a.innerHTML = '无权重数据'; return; } const msgs = []; res.perStock.forEach(p => { const w = lastW.weights[p.code] || 0; const tgt = p.amount / Math.max(1, res.invested) * 100; if (w - tgt > 5) msgs.push(`⚠️ <b>${esc(p.name)}</b> 现权重 ${w.toFixed(0)}% 超目标 ${tgt.toFixed(0)}% +${(w - tgt).toFixed(0)}pp，考虑停止追加`); else if (tgt - w > 5) msgs.push(`💡 <b>${esc(p.name)}</b> 权重 ${w.toFixed(0)}% 低于目标 ${tgt.toFixed(0)}% ${(tgt - w).toFixed(0)}pp，可考虑追加`); }); a.innerHTML = msgs.length ? msgs.join('<br>') : '✅ 各股权重与目标偏离均在 ±5pp 内'; }; }
    const anSens = document.getElementById('anSens');
    if (anSens && !anSens.dataset.bound) { anSens.dataset.bound = '1'; anSens.onclick = () => { const a = document.getElementById('anResult'); if (!a) return; const base = res.yearDiv; a.innerHTML = `📉 敏感度（年分红 ${(base / 10000).toFixed(2)} 万）：<br>· 股息率 -1pp → 约 ${(base * 0.8 / 10000).toFixed(2)} 万/年<br>· 股息率 +1pp → 约 ${(base * 1.2 / 10000).toFixed(2)} 万/年<br>· 分红停增 → 维持 ${(base / 10000).toFixed(2)} 万/年<br>· 分红翻倍 → 约 ${(base * 2 / 10000).toFixed(2)} 万/年`; }; }
    const anStress = document.getElementById('anStress');
    if (anStress && !anStress.dataset.bound) { anStress.dataset.bound = '1'; anStress.onclick = () => { const a = document.getElementById('anResult'); if (!a) return; let monthlyExp = 0; try { monthlyExp = parseFloat(localStorage.getItem('divtool_monthly_exp') || '0') || 0; } catch (e) {} const stressDiv = res.yearDiv * 0.5; const cov = monthlyExp > 0 ? (stressDiv / 12 / monthlyExp * 100).toFixed(0) + '%' : '（未填月支出）'; a.innerHTML = `🌪 压力测试（分红腰斩+价格 -50% 极端年）：<br>· 年分红腰斩 → ${(stressDiv / 10000).toFixed(2)} 万/年<br>· 覆盖月支出 → ${cov}<br>· 期末资产约 ${(res.last.value * 0.5 / 10000).toFixed(0)} 万（价格 -50%）<br>· 判断：极端年您的生活费仍能覆盖 ${cov}`; }; }
    const anTarget = document.getElementById('anTarget');
    if (anTarget && !anTarget.dataset.bound) { anTarget.dataset.bound = '1'; anTarget.onclick = () => { const a = document.getElementById('anResult'); if (!a) return; const tgt = prompt('目标：10 年后年分红（万元）？', '20'); const tv = parseFloat(tgt); if (!tv || tv <= 0) { a.innerHTML = '已取消'; return; } const cur = res.yearDiv / 10000; const need = tv / Math.max(0.01, cur) * res.invested; a.innerHTML = `🎯 目标 10 年后年分红 ${tv} 万：<br>· 当前年分红 ${cur.toFixed(2)} 万，投入 ${(res.invested / 10000).toFixed(0)} 万<br>· 需总投入约 <b>${(need / 10000).toFixed(0)} 万</b>（线性估算，未含复投增长）<br>· 差额 ${(Math.max(0, need - res.invested) / 10000).toFixed(0)} 万 → 月追加 ${(Math.max(0, need - res.invested) / 120 / 10000).toFixed(1)} 万/月（10 年）`; }; }
  }

  /* 驾驶舱主流程：拉组合数据 → calcComboBacktest → renderCockpit */
  async function runPortfolioBacktest() {
    const el = $('#pfbtResult');
    if (!el || _pfbtRunning) return;
    const c = DL.loadCombos();
    const sel = $('#pfbtComboSel');
    let activeId = sel && sel.value ? sel.value : c.activeId;
    const combo = c.combos.find(x => x.id === activeId);
    if (!combo) {
      el.innerHTML = `<div class="hint err" style="margin-bottom:8px">还没有组合：去决策台「🧮 我的组合」自由建组合（搜索加股→设金额/月追加→保存）</div>
        <div style="display:flex;gap:6px"><button type="button" class="btn" id="pfbtGoHome">🏠 去决策台建组合</button>
        <button type="button" class="btn" id="pfbtDemo">🎯 先用示例组合跑</button></div>`;
      const gh = document.getElementById('pfbtGoHome'); if (gh) gh.onclick = () => switchTab('home');
      const dm = document.getElementById('pfbtDemo'); if (dm) dm.onclick = () => { const c2 = DL.loadCombos(); const id = 'c' + Date.now(); c2.combos.push({ id, name: '示例组合', items: [{ code: '600036', name: '招商银行', amount: 500000, monthly: 3000 }, { code: '601398', name: '工商银行', amount: 300000, monthly: 2000 }, { code: '600900', name: '长江电力', amount: 200000, monthly: 1000 }], savedAt: Date.now() }); c2.activeId = id; DL.saveCombos(c2); const sel2 = $('#pfbtComboSel'); if (sel2) { sel2.innerHTML = ''; c2.combos.forEach(cm => { const o = document.createElement('option'); o.value = cm.id; o.textContent = cm.name + '（' + cm.items.length + '只）'; sel2.appendChild(o); }); sel2.value = id; } runPortfolioBacktest(); };
      return;
    }
    const y = parseInt((document.querySelector('.pfbt-y.on') || {}).dataset && document.querySelector('.pfbt-y.on').dataset.y || '10', 10);
    const mode = ($('#pfbtMode') && $('#pfbtMode').value) || 'weight';
    _pfbtRunning = true;
    const btn = $('#pfbtRun');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 体检中…'; }
    try {
      v3Skeleton(el, 220);
      el.innerHTML = `<div class="hint">⏳ 组合体检分步进行：</div>
        <div id="v3steps" style="font-size:11px;color:var(--sub);margin:6px 0;line-height:1.9">
          <div id="st1" style="opacity:.5">① 拉取数据（${combo.items.length} 只，本地缓存命中秒出）…</div>
          <div id="st2" style="opacity:.3">② 计算组合曲线（每只独立模拟+汇总）…</div>
          <div id="st3" style="opacity:.3">③ 生成驾驶舱（三问卡+图表+分析）…</div>
        </div>`;
      const pool = {};
      const failed = [];
      const from = (() => { const t = new Date(); t.setDate(t.getDate() - y * 366); return t.toISOString().slice(0, 10); })();
      /* Web Worker 并行拉取（v3.0 C1：11 核并行） */
      const items = combo.items.slice();
      const batchSize = 4;
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map(async (it) => {
          try {
            const [divs, kline] = await Promise.all([DL.fetchDividendsOne(it.code), DL.getKline(it.code, from, DL.todayStr())]);
            if (!divs || !divs.length || !kline || !Object.keys(kline).length) { failed.push(it.name); return; }
            const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
            pool[it.code] = { kline, divs, series };
          } catch (e) { failed.push(it.name); }
        }));
        const st1 = document.getElementById('st1'); if (st1) { st1.textContent = '✅ ① 拉取数据 ' + Math.min(i + batchSize, items.length) + '/' + items.length + '（完成）'; st1.style.opacity = 1; }
        const st2 = document.getElementById('st2'); if (st2) st2.style.opacity = 1;
      }
      /* 结果缓存（W1：同配置同区间秒出） */
      let cacheNote = '';
      const cacheKey = 'combo_bt_' + combo.id + '_' + y + '_' + mode;
      let res = null;
      try {
        const hit = await DL.cacheGet(cacheKey);
        if (hit && hit.res) { res = hit.res; cacheNote = '本地结果缓存'; }
      } catch (e) {}
      if (!res) {
        if (!Object.keys(pool).length) { el.innerHTML = '<div class="hint err">无有效数据（可能网络或数据源问题）</div>'; return; }
        const st2 = document.getElementById('st2'); if (st2) { st2.textContent = '✅ ② 计算组合曲线（' + Object.keys(pool).length + ' 只）'; st2.style.opacity = 1; }
        const st3 = document.getElementById('st3'); if (st3) st3.style.opacity = 1;
        await new Promise(r => setTimeout(r, 30));
        /* v3.0 C1：Web Worker 并行计算（11 核提速；不支持则主线程回退） */
        let workerRes = null;
        try {
          if (typeof Worker !== 'undefined') {
            workerRes = await new Promise((resolve) => {
              const w = new Worker('backtest-worker.js?v=' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'v3.1'));
              const to = setTimeout(() => { try { w.terminate(); } catch (e) {} resolve(null); }, 15000);
              w.onmessage = ev => { clearTimeout(to); try { w.terminate(); } catch (e) {} resolve(ev.data && ev.data.ok ? ev.data.res : null); };
              w.onerror = () => { clearTimeout(to); try { w.terminate(); } catch (e) {} resolve(null); };
              w.postMessage({ combo: combo.items, pool, opts: { years: y, monthlyMode: mode, cashPct: combo.cashPct || 0, cashRate: 1.5 } });
            });
          }
        } catch (e) { workerRes = null; }
        res = workerRes || DL.calcComboBacktest(combo.items, pool, { years: y, monthlyMode: mode, cashPct: combo.cashPct || 0, cashRate: 1.5 });
        if (!res) { el.innerHTML = '<div class="hint err">计算失败：数据不足</div>'; return; }
        try { await DL.cacheSet(cacheKey, { res, at: Date.now() }); } catch (e) {}
      }
      /* 填充组合选择器 */
      const sel2 = $('#pfbtComboSel');
      if (sel2 && !sel2.dataset.bound) {
        sel2.dataset.bound = '1';
        const c2 = DL.loadCombos();
        sel2.innerHTML = '';
        c2.combos.forEach(cm => { const o = document.createElement('option'); o.value = cm.id; o.textContent = cm.name + '（' + cm.items.length + '只）'; sel2.appendChild(o); });
        sel2.value = activeId;
        sel2.onchange = () => { const c3 = DL.loadCombos(); const ac = c3.combos.find(x => x.id === sel2.value); if (ac) { c3.activeId = ac.id; DL.saveCombos(c3); } runPortfolioBacktest(); };
      }
      fillCmpSel();
      const meta = { modeTxt: mode === 'weight' ? '按初始权重分配' : mode === 'fixed' ? '每只固定' : '智慧定投（按分位）', cacheNote, failed, cashTxt: (combo.cashPct || 0) > 0 ? `现金仓位 ${combo.cashPct}% 按 1.5%/年滚入（近似货基/短债，可改）；` : '' };
      renderCockpit(res, combo, pool, meta);
      /* v3.2 S2：跑完自动存快照（独立库 divtool-bt，不被缓存卫生误删）——不阻塞渲染 */
      btAutoSave(combo, y, mode, res);
    } catch (e) {
      el.innerHTML = `<div style="padding:14px;border:1px solid rgba(224,90,90,.4);border-radius:10px;background:rgba(224,90,90,.08)">
        <div style="font-size:13px;color:#e05a5a;font-weight:700">⚠️ 体检失败</div>
        <div style="font-size:11px;color:var(--sub);margin:6px 0">${esc(e.message || '未知错误')}</div>
        <div style="display:flex;gap:6px"><button type="button" class="btn" id="pfbtRetry">🔄 重试</button><button type="button" class="chip" id="pfbtGoHome2">🏠 去决策台检查组合</button></div>
        <div style="font-size:10px;color:var(--muted);margin-top:6px">常见原因：网络不可用 / 数据源限流 / 组合含退市或停牌股。重试仍失败可稍后再试。</div>
      </div>`;
      const rt = document.getElementById('pfbtRetry'); if (rt) rt.onclick = () => runPortfolioBacktest();
      const gh2 = document.getElementById('pfbtGoHome2'); if (gh2) gh2.onclick = () => switchTab('home');
    } finally {
      _pfbtRunning = false;
      if (btn) { btn.disabled = false; btn.textContent = '▶ 运行体检'; }
    }
  }

  /* v1 N6/M532：组合对比（我的组合 vs 备选，双曲线+关键指标并排） */
  async function loadComboPool(combo, y) {
    const pool = {}; const failed = [];
    const from = (() => { const t = new Date(); t.setDate(t.getDate() - y * 366); return t.toISOString().slice(0, 10); })();
    for (let i = 0; i < combo.items.length; i += 4) {
      const batch = combo.items.slice(i, i + 4);
      await Promise.all(batch.map(async (it) => {
        try {
          const [divs, kline] = await Promise.all([DL.fetchDividendsOne(it.code), DL.getKline(it.code, from, DL.todayStr())]);
          if (!divs || !divs.length || !kline || !Object.keys(kline).length) { failed.push(it.name); return; }
          const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
          pool[it.code] = { kline, divs, series };
        } catch (e) { failed.push(it.name); }
      }));
    }
    return { pool, failed };
  }
  async function runComboCompare() {
    const el = $('#pfbtCmpResult'); if (!el) return;
    const c = DL.loadCombos();
    const curSel = $('#pfbtComboSel'); const curId = curSel ? curSel.value : c.activeId;
    const cmpSel = $('#pfbtCmpSel'); const cmpId = cmpSel ? cmpSel.value : '';
    const cur = c.combos.find(x => x.id === curId);
    const cmp = c.combos.find(x => x.id === cmpId);
    if (!cur) { el.innerHTML = '<div class="hint err">先运行主组合体检</div>'; return; }
    if (!cmp) { el.innerHTML = '<div class="hint err">选一个对比组合</div>'; return; }
    const y = parseInt((document.querySelector('.pfbt-y.on') || {}).dataset && document.querySelector('.pfbt-y.on').dataset.y || '10', 10);
    const mode = ($('#pfbtMode') && $('#pfbtMode').value) || 'weight';
    el.innerHTML = '<div class="hint">⏳ 对比计算中（缓存命中秒出）…</div>';
    try {
      const [{ pool: p1 }, { pool: p2 }] = await Promise.all([loadComboPool(cur, y), loadComboPool(cmp, y)]);
      const r1 = DL.calcComboBacktest(cur.items, p1, { years: y, monthlyMode: mode, cashPct: cur.cashPct || 0, cashRate: 1.5 });
      const r2 = DL.calcComboBacktest(cmp.items, p2, { years: y, monthlyMode: mode, cashPct: cmp.cashPct || 0, cashRate: 1.5 });
      if (!r1 || !r2) { el.innerHTML = '<div class="hint err">对比失败：数据不足</div>'; return; }
      const card2 = (name, r, c2) => `<div style="flex:1;min-width:150px;padding:8px 10px;border-radius:8px;background:var(--card2);border:1px solid var(--line);text-align:center">
        <div style="font-size:12px;font-weight:700;color:${c2}">${esc(name)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">回本 ${r.divRatio.toFixed(1)}% · 年分红 ${(r.yearDiv / 10000).toFixed(2)}万 · 期末 ${(r.last.value / 10000).toFixed(1)}万</div>
      </div>`;
      el.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${card2(cur.name, r1, '#d9a441')}${card2(cmp.name, r2, '#5aa9e6')}</div><div id="cmpChart" style="width:100%;height:240px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>`;
      if (typeof echarts !== 'undefined') {
        const ch = echarts.init(document.getElementById('cmpChart'));
        ch.setOption({
          title: { text: '组合对比（总资产）', left: 'center', top: 2, textStyle: { fontSize: 11, color: '#8fa69c' } },
          legend: { top: 16, textStyle: { color: '#8fa69c', fontSize: 10 } },
          tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 } },
          grid: { left: 56, right: 14, top: 44, bottom: 26 },
          xAxis: { type: 'time', axisLabel: { color: '#8fa69c', fontSize: 10 } },
          yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => (v / 10000).toFixed(0) + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
          series: [
            { name: cur.name, type: 'line', data: r1.totalAsset.map(x => [x.d, x.value]), smooth: true, showSymbol: false, lineStyle: { color: '#d9a441', width: 2.5 } },
            { name: cmp.name, type: 'line', data: r2.totalAsset.map(x => [x.d, x.value]), smooth: true, showSymbol: false, lineStyle: { color: '#5aa9e6', width: 2 } },
          ],
        });
      }
    } catch (e) { el.innerHTML = '<div class="hint err">对比失败：' + esc(e.message) + '</div>'; }
  }
  function fillCmpSel() {
    const sel = $('#pfbtCmpSel'); if (!sel) return;
    const c = DL.loadCombos();
    const cur = $('#pfbtComboSel') ? $('#pfbtComboSel').value : '';
    sel.innerHTML = '<option value="">（选另一个组合对比）</option>' + (c.combos || []).filter(x => x.id !== cur).map(cm => `<option value="${cm.id}">${esc(cm.name)}（${cm.items.length}只）</option>`).join('');
  }
  try { fillCmpSel(); } catch (e) {}
  const pfbtCmpBtn = $('#pfbtCmpRun');
  if (pfbtCmpBtn && !pfbtCmpBtn.dataset.bound) { pfbtCmpBtn.dataset.bound = '1'; pfbtCmpBtn.onclick = runComboCompare; }

  /* O5b：持仓可选录入（M41 Q2/M43 Q4）——localStorage 存储（敏感数据不进 git）
   * 字段：代码/股数/成本价/买入日期/trades（M260：内嵌买入流水 [{date,shares,price}]，只增不删）
   * 录入则组合页真实数据，未录则空态引导（D2/M138）*/
  const HOLD_KEY = 'divtool_holdings_v1';
  function loadHoldings() { try { return JSON.parse(localStorage.getItem(HOLD_KEY)) || []; } catch (e) { return []; } }
  function saveHoldings(h) { localStorage.setItem(HOLD_KEY, JSON.stringify(h)); }

  /* 批次2（M260）：读取补默认空数组——旧数据无 trades 字段零迁移，渲染时 trades=h.trades||[] */
  function holdTrades(h) { return (h && Array.isArray(h.trades)) ? h.trades : []; }

  /* 批次2（M261）：加权平均摊薄成本（A 股券商口径，先进先出排除）
   * 有 trades：Σ(股数×价)/Σ股数；无 trades：返原 cost（手填） */
  function calcWeightedCost(h) {
    const ts = holdTrades(h);
    if (ts.length) {
      let shares = 0, amt = 0;
      ts.forEach(t => { if (t.shares > 0 && t.price > 0) { shares += t.shares; amt += t.shares * t.price; } });
      return shares > 0 ? amt / shares : null;
    }
    return (h.cost != null && h.cost > 0) ? h.cost : null;
  }

  /* P114（2026-08-21）：F2 第 0 步——旧 key 一次性迁移到 v1（对象 {code:shares} → 数组 [{code,shares}]）
   * 顺序铁律：先迁移 → 再删旧表单（已删）→ 日历改读 v1（已改）→ grep 旧 key=0。验收只看数据通了没。 */
  function migrateHoldingsV1() {
    try {
      const legacy = JSON.parse(localStorage.getItem('divtool_holdings') || 'null');
      if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        /* W7（2026-08-21）：迁移前备份旧 key（可手动恢复） */
        try { localStorage.setItem('divtool_holdings_legacy_bak', JSON.stringify(legacy)); } catch (e2) {}
        const merged = loadHoldings().slice();
        let added = 0;
        for (const [code, shares] of Object.entries(legacy)) {
          if (!/^\d{6}$/.test(code) || !(shares > 0)) continue;
          if (!merged.some(h => h.code === code)) { merged.push({ code, name: code, shares, cost: null, date: null }); added++; }
        }
        if (added > 0) {
          saveHoldings(merged);
          try { toast('✅ 旧持仓已迁移 ' + added + ' 只到新表单'); } catch (e2) {}
        }
      }
      /* 迁移完成后清旧 key；备份保留在 divtool_holdings_legacy_bak（供手动恢复） */
      localStorage.removeItem('divtool_holdings');
    } catch (e) {}
  }
/* ===== v1 组合工作台 UI（决策台「🧮 我的组合」卡）===== */
let _comboUndoStack = [];
let _comboItems = [];   // [{code,name,amount,monthly}]
let _comboName = '';
let _comboId = null;    // 当前编辑组合 id（null=未保存新组合）
let _comboTotal = 0;    // 总投资基准（用户可设，%→金额投影）
let _comboCashPct = 0;  // 现金仓位 %（组合级配置，按 1.5%/年滚）
let _comboDonutMode = 'amt';  // 'amt' 金额视图 | 'div' 分红贡献视图

function comboPushUndo() { _comboUndoStack.push(JSON.stringify({ items: _comboItems, name: _comboName, total: _comboTotal })); if (_comboUndoStack.length > 30) _comboUndoStack.shift(); }
function comboUndo() {
  if (!_comboUndoStack.length) { toast('没有可撤销的'); return; }
  const s = JSON.parse(_comboUndoStack.pop());
  _comboItems = s.items; _comboName = s.name; if (s.total != null) _comboTotal = s.total;
  renderComboList();
}
async function comboResolve(v) {
  /* 复用 cmpResolveCode 逻辑：6 位代码直接 fetchName，否则东财 suggest */
  if (/^\d{6}$/.test(v.trim())) {
    try { const name = await DL.fetchName(v.trim()); return { code: v.trim(), name }; } catch (e) { return { code: v.trim(), name: v.trim() }; }
  }
  try {
    const d = await DL.jsonp('https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(v.trim()) + '&type=14&count=3', 'cb');
    const list = d && d.QuotationCodeTable && d.QuotationCodeTable.Data;
    if (list && list.length) { const it = list[0]; return { code: it.Code, name: it.Name }; }
  } catch (e) {}
  return null;
}
/* ---- 金额/比例派生 ---- */
function comboSumAmt() { return _comboItems.reduce((s, x) => s + (x.amount || 0), 0); }
function comboSumMon() { return _comboItems.reduce((s, x) => s + (x.monthly || 0), 0); }
function comboPct(i) { const t = comboSumAmt(); return t > 0 ? (_comboItems[i].amount || 0) / t * 100 : 0; }
/* 等比缩放：改第 idx 只的目标 %=pct，其余按原比例缩，金额=comboTotal×%/100（保持 Σ=comboTotal） */
function comboScaleTo(idx, pct) {
  const n = _comboItems.length; if (!n) return;
  pct = Math.max(0, Math.min(100, pct));
  const total = _comboTotal > 0 ? _comboTotal : comboSumAmt();
  if (total <= 0) { _comboItems.forEach((it, i) => { it.amount = i === idx ? pct * 1000 : 0; }); _comboTotal = pct * 1000; return; }
  const oSum = _comboItems.reduce((s, x, i) => s + (i !== idx ? (x.amount || 0) : 0), 0);
  const newOthers = Math.max(0, 100 - pct);
  _comboItems.forEach((it, i) => {
    if (i === idx) it.amount = Math.round(total * pct / 100);
    else {
      const base = oSum > 0 ? (it.amount || 0) / oSum : 1 / Math.max(1, n - 1);
      it.amount = Math.round(total * newOthers / 100 * base);
    }
  });
  _comboTotal = total;
  comboFixRounding();
}
/* 整数补差：Σ金额≠comboTotal 时差额补到最大那只（恒=100%） */
function comboFixRounding() {
  if (_comboTotal > 0 && _comboItems.length) {
    let sum = comboSumAmt();
    if (Math.abs(sum - _comboTotal) > 1) {
      let maxI = 0; _comboItems.forEach((x, i) => { if ((x.amount || 0) > (_comboItems[maxI].amount || 0)) maxI = i; });
      _comboItems[maxI].amount = Math.max(0, (_comboItems[maxI].amount || 0) + (_comboTotal - sum));
    }
  }
}
/* 等权：每只=total/n，余数补第一只 */
function comboEqualize() {
  const n = _comboItems.length; if (!n) return;
  const total = _comboTotal > 0 ? _comboTotal : 1000000;
  const base = Math.floor(total / n);
  _comboItems.forEach((it, i) => { it.amount = base; });
  _comboItems[0].amount += total - base * n;
  _comboTotal = total;
  comboFixRounding();
}
/* 总月追加按比例拆（低配优先简化：按目标占比=金额占比拆） */
function comboDistributeMonthly(totalMon) {
  const n = _comboItems.length; if (!n) return;
  const t = comboSumAmt();
  _comboItems.forEach((it, i) => { it.monthly = t > 0 ? Math.round(totalMon * (it.amount || 0) / t) : Math.round(totalMon / n); });
}
/* ---- 校验（软校验：<100%=现金仓位提示，>100% 硬拦） ---- */
function comboCheckPct() {
  const el = $('#comboCheck'); if (!el) return '';
  const t = comboSumAmt();
  if (!_comboItems.length) { el.innerHTML = '<span style="color:var(--muted)">空组合：搜索加股 → 设比例/金额 → 命名保存</span>'; return ''; }
  if (t <= 0) { el.innerHTML = '<span style="color:#e05a5a">⚠️ 总投入为 0，先填金额或比例</span>'; return 'over'; }
  const cashPct = _comboCashPct || 0;
  const cashAmt = t * cashPct / 100;
  let html = '';
  if (cashPct > 0) {
    html = `<span style="color:var(--gold)">💵 现金仓位 ${cashPct.toFixed(0)}%（≈${(cashAmt / 10000).toFixed(1)} 万，按 1.5%/年滚入）</span>`;
  } else {
    html = `<span style="color:#4caf7d">✅ 满仓（可设现金仓位留子弹）</span>`;
  }
  el.innerHTML = html;
  return '';
}
/* ---- 环形图 SVG（金额/分红双视图 + hover + 点击联动） ---- */
const _comboPalette = ['#d9a441', '#5aa9e6', '#4caf7d', '#e05a5a', '#9b6df0', '#f0a45a', '#5ad0d0', '#d05a9b', '#8a8a5a', '#6d9b5a', '#5a7ad0', '#d0a05a'];
let _comboDonutDiv = null;  // {i: 分红贡献占比} 估算
function renderComboDonut() {
  const el = $('#comboDonut'); if (!el) return;
  const items = _comboItems;
  const total = comboSumAmt();
  if (!items.length || total <= 0) { el.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:11px">加股后显示仓位图</div>'; return; }
  const vals = items.map((it, i) => {
    if (_comboDonutMode === 'div' && _comboDonutDiv && _comboDonutDiv[i] != null) return _comboDonutDiv[i];
    return (it.amount || 0);
  });
  const vSum = vals.reduce((s, x) => s + x, 0) || 1;
  const R = 62, r = 42, cx = 75, cy = 75;
  let acc = 0;
  const paths = vals.map((v, i) => {
    const pct = v / vSum * 100;
    const a0 = acc / 100 * 2 * Math.PI - Math.PI / 2;
    const a1 = (acc + pct) / 100 * 2 * Math.PI - Math.PI / 2;
    acc += pct;
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const x0 = +(cx + R * Math.cos(a0)).toFixed(2), y0 = +(cy + R * Math.sin(a0)).toFixed(2);
    const x1 = +(cx + R * Math.cos(a1)).toFixed(2), y1 = +(cy + R * Math.sin(a1)).toFixed(2);
    const x0r = +(cx + r * Math.cos(a1)).toFixed(2), y0r = +(cy + r * Math.sin(a1)).toFixed(2);
    const x1r = +(cx + r * Math.cos(a0)).toFixed(2), y1r = +(cy + r * Math.sin(a0)).toFixed(2);
    const d = `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x0r},${y0r} A${r},${r} 0 ${large} 0 ${x1r},${y1r} Z`;
    return `<path d="${d}" fill="${_comboPalette[i % _comboPalette.length]}" stroke="#0f1a14" stroke-width="1" data-di="${i}" style="cursor:pointer;transition:opacity .2s" opacity="0.92"><title>${esc(items[i].name || items[i].code)} ${pct.toFixed(1)}%</title></path>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 150 150" width="100%" height="100%">${paths}<text x="75" y="70" text-anchor="middle" fill="#e8efe9" font-size="12" font-weight="700">${_comboDonutMode === 'div' ? '分红' : '金额'}</text><text x="75" y="84" text-anchor="middle" fill="#8fa69c" font-size="8">${_comboDonutMode === 'div' ? '贡献占比（估算）' : (total / 10000).toFixed(1) + '万'}</text></svg>`;
  el.querySelectorAll('path[data-di]').forEach(p => {
    p.onmouseenter = () => { const i = +p.dataset.di; comboDonutTip(i, true); p.style.opacity = 1; };
    p.onmouseleave = () => { comboDonutTip(-1, false); p.style.opacity = 0.92; };
    p.onclick = () => { const i = +p.dataset.di; comboHighlightRow(i); };
  });
}
function comboDonutTip(i, on) {
  const tip = $('#comboDonutTip'); if (!tip) return;
  if (!on || i < 0) { tip.innerHTML = ''; return; }
  const it = _comboItems[i]; if (!it) return;
  const pct = comboPct(i);
  const dy = _comboDonutDiv && _comboDonutDiv[i] != null ? _comboDonutDiv[i] : null;
  tip.innerHTML = `<div style="font-size:11px;color:var(--sub);margin-top:2px"><b>${esc(it.name || it.code)}</b> 占 ${pct.toFixed(1)}%${dy != null ? ` · 分红贡献 ${dy.toFixed(1)}%` : ''}</div>`;
}
function comboHighlightRow(i) {
  const row = document.querySelector(`[data-crow="${i}"]`);
  if (row) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); row.style.background = 'rgba(217,164,65,.15)'; setTimeout(() => { row.style.background = ''; }, 1200); }
}
/* ---- 汇总 ---- */
function renderComboTotals() {
  const el = $('#comboTotals'); if (!el) return;
  const totalAmt = comboSumAmt();
  const totalMon = comboSumMon();
  const prevAmt = el.dataset.amt ? parseFloat(el.dataset.amt) : null;
  el.dataset.amt = totalAmt;
  el.innerHTML = _comboItems.length
    ? `💰 总投入 <b style="color:var(--gold)">${(totalAmt / 10000).toFixed(1)} 万</b> · 📅 总月追加 <b>${totalMon.toFixed(0)} 元/月</b> · 🧮 ${_comboItems.length} 只` + (totalMon > 0 ? ` · 年追加 ${(totalMon * 12 / 10000).toFixed(1)} 万` : '')
    : '组合为空：搜索加股，或点 📥持仓 / 📋自选 / 🎯示例 导入';
  if (prevAmt != null && totalAmt !== prevAmt && _comboItems.length) { const b = el.querySelector('b'); if (b) v3Flash(b, totalAmt > prevAmt); }
  const totalInp = $('#comboTotal');
  if (totalInp && document.activeElement !== totalInp) totalInp.value = totalAmt > 0 ? Math.round(totalAmt) : '';
  const monInp = $('#comboTotalMon');
  if (monInp && document.activeElement !== monInp) monInp.value = totalMon > 0 ? Math.round(totalMon) : '';
  comboCheckPct();
}
/* ---- 列表（每行：名称/代码 + %输入 + 金额输入 + 月追加 + 现价/涨跌 + 迷你走势 + 股息率徽章 + 操作） ---- */
let _comboExpanded = true;
function renderComboList() {
  const wrap = $('#comboListWrap');
  if (!wrap) return;
  if (!_comboItems.length) { wrap.innerHTML = '<div class="hint" style="margin-bottom:4px">① 搜索加股 → ② 设比例或金额 → ③ 命名保存</div>'; renderComboTotals(); renderComboDonut(); return; }
  const t = comboSumAmt();
  /* >10 只自适应折叠（验收 11 条）：折叠=只显名称+占比+徽章，点开全卡 */
  const compact = _comboItems.length > 10 && !_comboExpanded;
  const rows = _comboItems.map((it, i) => {
    const pct = t > 0 ? (it.amount || 0) / t * 100 : 0;
    if (compact) {
      return `<div style="display:flex;gap:6px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--line);cursor:pointer" data-crow="${i}" title="点开展开">
        <span style="flex:1"><b>${esc(it.name || it.code)}</b> <span style="color:var(--muted);font-size:10px">${it.code}</span></span>
        <span style="font-size:11px;color:var(--gold)">${pct.toFixed(1)}%</span>
        <span class="combo-dy" data-dy="${i}" style="font-size:10px;color:var(--muted);min-width:44px"></span>
      </div>`;
    }
    return `<div style="display:flex;gap:6px;align-items:center;padding:5px 6px;border-bottom:1px solid var(--line);flex-wrap:wrap" data-crow="${i}">
      <span style="min-width:104px"><b>${esc(it.name || it.code)}</b> <span style="color:var(--muted);font-size:10px">${it.code}</span></span>
      <span style="font-size:11px;color:var(--sub)">%</span><input type="number" data-pct="${i}" value="${pct.toFixed(pct % 1 === 0 ? 0 : 1)}" min="0" max="100" style="width:52px;padding:3px 5px;background:var(--card);border:1px solid var(--line);border-radius:5px;color:var(--txt);font-size:11px" title="目标占比（改这个=其余等比缩放）">
      <span style="font-size:11px;color:var(--sub)">金额</span><input type="number" data-amt="${i}" value="${it.amount || 0}" style="width:86px;padding:3px 5px;background:var(--card);border:1px solid var(--line);border-radius:5px;color:var(--txt);font-size:11px">
      <span style="font-size:11px;color:var(--sub)">月追加</span><input type="number" data-mon="${i}" value="${it.monthly || 0}" style="width:72px;padding:3px 5px;background:var(--card);border:1px solid var(--line);border-radius:5px;color:var(--txt);font-size:11px">
      <span class="combo-card-meta" data-meta="${i}" style="font-size:10px;color:var(--muted);min-width:70px">…</span>
      <span class="combo-spark" data-spark="${i}" style="width:56px;height:20px;display:inline-block"></span>
      <span class="combo-dy" data-dy="${i}" style="font-size:10px;color:var(--muted);min-width:44px"></span>
      <button type="button" class="chip" data-up="${i}" title="上移">↑</button>
      <button type="button" class="chip" data-dn="${i}" title="下移">↓</button>
      <button type="button" class="chip" data-rm="${i}" style="color:#e05a5a">✕</button>
    </div>`;
  }).join('');
  wrap.innerHTML = (_comboItems.length > 10
    ? `<div style="margin-bottom:4px"><button type="button" class="chip" id="comboExpandToggle" style="font-size:10px">${_comboExpanded ? '📕 折叠（只显占比）' : '📖 展开全部'}</button> <span style="font-size:10px;color:var(--muted)">${_comboItems.length} 只（>10 自动折叠）</span></div>`
    : '') + rows;
  const et = $('#comboExpandToggle');
  if (et) et.onclick = () => { _comboExpanded = !_comboExpanded; renderComboList(); };
  if (compact) {
    wrap.querySelectorAll('[data-crow]').forEach(div => div.onclick = () => { _comboExpanded = true; renderComboList(); });
    renderComboTotals(); renderComboDonut(); comboLoadCardData(); return;
  }
  /* % 输入 → 等比缩放（其余同缩），金额=total×%/100 */
  wrap.querySelectorAll('[data-pct]').forEach(inp => inp.onchange = () => {
    comboPushUndo(); const i = +inp.dataset.pct; let v = parseFloat(inp.value);
    if (isNaN(v) || v < 0) v = 0;
    if (v > 100) { toast('单只不能超 100%'); v = 100; }
    comboScaleTo(i, v); renderComboList();
  });
  /* 金额输入 → 直接改金额，% 派生 */
  wrap.querySelectorAll('[data-amt]').forEach(inp => inp.onchange = () => {
    comboPushUndo(); const i = +inp.dataset.amt; let v = parseFloat(inp.value);
    if (isNaN(v) || v < 0) v = 0;
    _comboItems[i].amount = v; _comboTotal = comboSumAmt(); renderComboList();
  });
  /* 月追加输入 */
  wrap.querySelectorAll('[data-mon]').forEach(inp => inp.onchange = () => {
    comboPushUndo(); const i = +inp.dataset.mon; let v = parseFloat(inp.value);
    if (isNaN(v) || v < 0) v = 0;
    _comboItems[i].monthly = v; renderComboTotals();
  });
  wrap.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { comboPushUndo(); const i = +b.dataset.up; if (i > 0) { const t2 = _comboItems[i]; _comboItems[i] = _comboItems[i - 1]; _comboItems[i - 1] = t2; renderComboList(); } });
  wrap.querySelectorAll('[data-dn]').forEach(b => b.onclick = () => { comboPushUndo(); const i = +b.dataset.dn; if (i < _comboItems.length - 1) { const t2 = _comboItems[i]; _comboItems[i] = _comboItems[i + 1]; _comboItems[i + 1] = t2; renderComboList(); } });
  wrap.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { comboPushUndo(); _comboItems.splice(+b.dataset.rm, 1); _comboTotal = comboSumAmt(); renderComboList(); });
  renderComboTotals();
  renderComboDonut();
  comboLoadCardData();
}
/* 个股卡片数据：现价/涨跌（getStockQuotes）+ 迷你走势（getKline 60日）+ 股息率档（fetchDividendsOne） */
let _comboCardLoading = false;
async function comboLoadCardData() {
  if (_comboCardLoading || !_comboItems.length) return;
  _comboCardLoading = true;
  const codes = _comboItems.map(x => x.code);
  let snap = {};
  try { snap = await DL.getStockQuotes(codes); } catch (e) {}
  _comboItems.forEach((it, i) => {
    const p = snap[it.code] && snap[it.code].price;
    const meta = document.querySelector(`[data-meta="${i}"]`);
    if (meta) meta.textContent = p != null ? `现价 ${p.toFixed(2)}` : '行情—';
  });
  /* 迷你走势（60日收盘 sparkline）+ 涨跌色 */
  const start = (() => { const d = new Date(); d.setDate(d.getDate() - 120); return d.toISOString().slice(0, 10); })();
  const today = DL.todayStr ? DL.todayStr() : new Date().toISOString().slice(0, 10);
  _comboItems.forEach(async (it, i) => {
    try {
      const kl = await DL.getKline(it.code, start, today);
      const dates = Object.keys(kl).sort();
      if (dates.length >= 5) {
        const closes = dates.map(d => kl[d]);
        const last = closes[closes.length - 1], prev = closes[closes.length - 2];
        const chg = prev > 0 ? (last - prev) / prev * 100 : 0;
        const sp = document.querySelector(`[data-spark="${i}"]`);
        if (sp) {
          const min = Math.min(...closes), max = Math.max(...closes);
          const range = (max - min) || 1, n = closes.length;
          const pts = closes.map((c, k) => `${(k / (n - 1) * 50).toFixed(1)},${(18 - (c - min) / range * 16).toFixed(1)}`).join(' ');
          const color = chg >= 0 ? '#e05a5a' : '#4caf7d';  // A股红涨绿跌
          sp.innerHTML = `<svg width="56" height="20" viewBox="0 0 50 20" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2"/></svg>`;
          const meta = document.querySelector(`[data-meta="${i}"]`);
          if (meta) meta.innerHTML += ` <span style="color:${color}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>`;
        }
        /* D6 估值分位徽章（hover 显示，低/中/高）——用 K线+分红算滚动分位 */
        try {
          const divs = await DL.fetchDividendsOne(it.code);
          const series = DL.calcRollingPercentile(kl, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
          const lastPct = series.filter(x => x.pct != null).pop();
          if (lastPct && lastPct.pct != null) {
            const p = lastPct.pct;
            const tag = p < 30 ? '低估' : p < 70 ? '中估' : '高估';
            const col = p < 30 ? '#4caf7d' : p < 70 ? '#5aa9e6' : '#e05a5a';
            const el2 = document.querySelector(`[data-dy="${i}"]`);
            if (el2) {
              el2.innerHTML += ` <span style="color:${col};border:1px solid ${col};border-radius:4px;padding:0 4px;font-size:9px;cursor:help" title="估值分位 ${p.toFixed(0)}%（近5年股息率滚动分位）">${tag}</span>`;
            }
          }
        } catch (e) {}
      } else {
        const sp = document.querySelector(`[data-spark="${i}"]`);
        if (sp) sp.innerHTML = '<span style="color:var(--muted);font-size:9px">—</span>';
      }
    } catch (e) {
      const sp = document.querySelector(`[data-spark="${i}"]`);
      if (sp) sp.innerHTML = '<span style="color:var(--muted);font-size:9px">—</span>';
    }
    /* 股息率档徽章 + 分红贡献占比（环形图分红视图数据） */
    try {
      const divs = await DL.fetchDividendsOne(it.code);
      const p = snap[it.code] && snap[it.code].price;
      if (divs && divs.length && p > 0) {
        const y = parseInt(today.slice(0, 4), 10);
        const lastYear = divs.filter(d => d.ex && parseInt(d.ex.slice(0, 4), 10) === y - 1);
        const sum = lastYear.reduce((s, d) => s + (d.cash || 0), 0);
        if (sum > 0) {
          const dy = sum / p * 100;
          if (!_comboDonutDiv) _comboDonutDiv = {};
          _comboDonutDiv[i] = (it.amount || 0) * dy;  // 分红贡献=金额×股息率（估算）
          const tag = dy >= 5 ? '高息' : dy >= 3 ? '中息' : '低息';
          const col = dy >= 5 ? '#d9a441' : dy >= 3 ? '#5aa9e6' : 'var(--muted)';
          const el2 = document.querySelector(`[data-dy="${i}"]`);
          if (el2) el2.innerHTML = `<span style="color:${col};border:1px solid ${col};border-radius:4px;padding:0 4px;font-size:9px">${tag} ${dy.toFixed(1)}%</span>`;
        }
      }
    } catch (e) {}
  });
  _comboCardLoading = false;
  if (_comboDonutMode === 'div') renderComboDonut();
}
function renderComboSaved() {
  const el = $('#comboSaved');
  if (!el) return;
  const c = DL.loadCombos();
  el.innerHTML = (c.combos && c.combos.length)
    ? '已保存 ' + c.combos.length + ' 个：' + c.combos.map((cm, i) => `<span style="margin-right:8px">${esc(cm.name)}（${cm.items.length}只）${cm.id === c.activeId ? ' <b style="color:var(--gold)">●当前</b>' : ''} <span style="color:var(--muted);font-size:10px">${cm.savedAt ? new Date(cm.savedAt).toLocaleString().slice(5, 16) : ''}</span></span>`).join('')
    : '尚无已保存组合';
}
function renderComboSel() {
  const sel = $('#comboSel');
  if (!sel) return;
  const c = DL.loadCombos();
  sel.innerHTML = '<option value="">— 选择组合 —</option>' + (c.combos || []).map(cm => `<option value="${cm.id}" ${cm.id === c.activeId ? 'selected' : ''}>${esc(cm.name)}（${cm.items.length}只）</option>`).join('');
}
function comboLoad(id) {
  const c = DL.loadCombos();
  const cm = c.combos.find(x => x.id === id);
  if (!cm) return;
  _comboItems = JSON.parse(JSON.stringify(cm.items));
  _comboName = cm.name; _comboId = cm.id;
  _comboTotal = comboSumAmt();
  _comboCashPct = cm.cashPct || 0;
  c.activeId = id; DL.saveCombos(c);
  const ni = $('#comboName'); if (ni) ni.value = _comboName;
  const ci = $('#comboCashPct'); if (ci) ci.value = _comboCashPct || '';
  renderComboList(); renderComboSaved(); renderComboSel();
}
function comboPersist() {
  const c = DL.loadCombos();
  const name = (_comboName || '').trim() || '我的组合';
  const cashPct = _comboCashPct || 0;
  if (_comboId) {
    const cm = c.combos.find(x => x.id === _comboId);
    if (cm) { cm.name = name; cm.items = JSON.parse(JSON.stringify(_comboItems)); cm.savedAt = Date.now(); cm.cashPct = cashPct; }
    else { const id = 'c' + Date.now(); c.combos.push({ id, name, items: JSON.parse(JSON.stringify(_comboItems)), savedAt: Date.now(), cashPct }); _comboId = id; }
  } else {
    const id = 'c' + Date.now();
    c.combos.push({ id, name, items: JSON.parse(JSON.stringify(_comboItems)), savedAt: Date.now(), cashPct });
    _comboId = id;
  }
  if (c.combos.length > 8) c.combos.shift();
  c.activeId = _comboId;
  DL.saveCombos(c);
  renderComboSaved(); renderComboSel();
  return name;
}
async function renderComboCard() {
  const body = $('#comboBody');
  if (!body) return;
  const c = DL.loadCombos();
  if (c.activeId) { const ac = c.combos.find(x => x.id === c.activeId); if (ac) { _comboItems = JSON.parse(JSON.stringify(ac.items)); _comboName = ac.name; _comboId = ac.id; _comboTotal = comboSumAmt(); _comboCashPct = ac.cashPct || 0; } }
  const ni = $('#comboName'); if (ni) ni.value = _comboName;
  const ci2 = $('#comboCashPct'); if (ci2) ci2.value = _comboCashPct || '';
  renderComboSel(); renderComboList(); renderComboSaved();
  const $b = (id, fn) => { const b = $(id); if (b && !b.dataset.bound) { b.dataset.bound = '1'; b.onclick = fn; } return b; };
  $b('comboAdd', async () => {
    const v = ($('#comboSearch').value || '').trim();
    if (!v) { toast('先输入代码或名称'); return; }
    const r = await comboResolve(v);
    if (!r) { toast('未找到：' + v); return; }
    if (_comboItems.some(x => x.code === r.code)) { toast('已在组合中：' + r.name); return; }
    comboPushUndo();
    const t = _comboTotal > 0 ? _comboTotal : 1000000;
    const n2 = _comboItems.length + 1;
    const amt = Math.round(t / n2);
    _comboItems.forEach(x => x.amount = amt);
    _comboItems.push({ code: r.code, name: r.name, amount: t - amt * (_comboItems.length - 1), monthly: 0 });
    _comboTotal = t;
    $('#comboSearch').value = '';
    renderComboList();
  });
  const sr = $('#comboSearch');
  if (sr && !sr.dataset.bound) { sr.dataset.bound = '1'; sr.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const b = $('#comboAdd'); if (b) b.click(); } }); }
  $b('comboFromHold', () => { const holds = loadHoldings(); if (!holds.length) { toast('无持仓可导入'); return; } comboPushUndo(); holds.forEach(h => { if (!_comboItems.some(x => x.code === h.code)) _comboItems.push({ code: h.code, name: h.name || h.code, amount: (h.cost || 10) * (h.shares || 100), monthly: 0 }); }); _comboTotal = comboSumAmt(); renderComboList(); toast('已从持仓导入 ' + holds.length + ' 只'); });
  $b('comboFromWl', async () => { const wl = homeState.watchlist && homeState.watchlist.length ? homeState.watchlist : await DL.Watchlist.list(); if (!wl.length) { toast('自选为空'); return; } comboPushUndo(); wl.forEach(w => { if (!_comboItems.some(x => x.code === w.code)) _comboItems.push({ code: w.code, name: w.name || w.code, amount: 100000, monthly: 0 }); }); _comboTotal = comboSumAmt(); renderComboList(); toast('已从自选导入 ' + wl.length + ' 只'); });
  $b('comboFromDemo', () => { comboPushUndo(); [['600036', '招商银行', 400000, 3000], ['601398', '工商银行', 300000, 2000], ['600900', '长江电力', 300000, 1000]].forEach(([code, name, amount, monthly]) => { if (!_comboItems.some(x => x.code === code)) _comboItems.push({ code, name, amount, monthly }); }); _comboTotal = comboSumAmt(); renderComboList(); toast('已载入示例组合（招行/工行/长电 4:3:3）'); });
  $b('comboEqual', () => { comboPushUndo(); comboEqualize(); renderComboList(); toast('已等权分配（余数补第一只）'); });
  /* 总投资输入 → 等比缩放全部 */
  const totInp = $('#comboTotal');
  if (totInp && !totInp.dataset.bound) { totInp.dataset.bound = '1'; totInp.onchange = () => { const v = parseFloat(totInp.value); if (isNaN(v) || v < 0) { totInp.value = ''; return; } if (!_comboItems.length) { _comboTotal = v; return; } comboPushUndo(); const old = comboSumAmt(); if (old > 0) { _comboItems.forEach(x => x.amount = Math.round(v * (x.amount || 0) / old)); } else { _comboItems.forEach((x, i) => x.amount = Math.round(v / _comboItems.length)); _comboItems[0].amount += v - Math.round(v / _comboItems.length) * _comboItems.length; } _comboTotal = v; comboFixRounding(); renderComboList(); }; }
  /* 总月追加 → 按比例拆 */
  const monInp = $('#comboTotalMon');
  if (monInp && !monInp.dataset.bound) { monInp.dataset.bound = '1'; monInp.onchange = () => { const v = parseFloat(monInp.value); if (isNaN(v) || v < 0) { monInp.value = ''; return; } if (!_comboItems.length) return; comboPushUndo(); comboDistributeMonthly(v); renderComboList(); toast('已按金额占比拆月追加（低配优先为近似）'); }; }
  /* 组合名输入 */
  const nmInp = $('#comboName');
  if (nmInp && !nmInp.dataset.bound) { nmInp.dataset.bound = '1'; nmInp.onchange = () => { _comboName = nmInp.value.trim(); }; }
  /* 现金仓位输入（组合级配置，随组合保存） */
  const cashInp = $('#comboCashPct');
  if (cashInp && !cashInp.dataset.bound) { cashInp.dataset.bound = '1'; cashInp.onchange = () => { let v = parseFloat(cashInp.value); if (isNaN(v) || v < 0) v = 0; if (v > 100) { toast('现金仓位不能超 100%'); v = 100; } _comboCashPct = v; comboCheckPct(); toast('现金仓位 ' + v + '%（按 1.5%/年滚入）'); }; }
  /* 组合管理 */
  $b('comboNew', () => { comboPushUndo(); _comboItems = []; _comboName = ''; _comboId = null; _comboTotal = 0; const n2 = $('#comboName'); if (n2) n2.value = ''; const s2 = $('#comboSel'); if (s2) s2.value = ''; renderComboList(); renderComboSaved(); renderComboSel(); toast('新建组合（未保存）'); });
  $b('comboRename', () => { if (!_comboId) { toast('先保存组合再重命名'); return; } const nm = prompt('新名字：', _comboName); if (nm && nm.trim()) { _comboName = nm.trim(); comboPersist(); toast('已重命名「' + _comboName + '」'); } });
  $b('comboDup', () => { if (!_comboItems.length) { toast('组合为空'); return; } comboPushUndo(); const c2 = DL.loadCombos(); const id = 'c' + Date.now(); const name = (_comboName || '组合') + ' 副本'; c2.combos.push({ id, name, items: JSON.parse(JSON.stringify(_comboItems)), savedAt: Date.now() }); if (c2.combos.length > 8) c2.combos.shift(); c2.activeId = id; DL.saveCombos(c2); _comboId = id; _comboName = name; const n2 = $('#comboName'); if (n2) n2.value = name; renderComboSaved(); renderComboSel(); toast('已复制为「' + name + '」'); });
  $b('comboDel', () => { if (!_comboId) { toast('当前组合未保存，无需删除'); return; } const c2 = DL.loadCombos(); const cm = c2.combos.find(x => x.id === _comboId); if (!cm) return; if (!confirm('删除组合「' + cm.name + '」？此操作不可恢复')) return; c2.combos = c2.combos.filter(x => x.id !== _comboId); if (c2.activeId === _comboId) c2.activeId = c2.combos.length ? c2.combos[c2.combos.length - 1].id : null; DL.saveCombos(c2); _comboId = null; _comboItems = []; _comboName = ''; _comboTotal = 0; const n2 = $('#comboName'); if (n2) n2.value = ''; renderComboSel(); renderComboList(); renderComboSaved(); toast('已删除'); });
  const sel = $('#comboSel');
  if (sel && !sel.dataset.bound) { sel.dataset.bound = '1'; sel.onchange = () => { if (sel.value) comboLoad(sel.value); }; }
  const saveBtn = $('#comboSave');
  if (saveBtn && !saveBtn.dataset.bound) { saveBtn.dataset.bound = '1'; saveBtn.onclick = () => { if (!_comboItems.length) { toast('组合为空'); return; } const name = comboPersist(); toast('已保存「' + name + '」'); }; }
  const undoBtn = $('#comboUndo');
  if (undoBtn && !undoBtn.dataset.bound) { undoBtn.dataset.bound = '1'; undoBtn.onclick = comboUndo; }
  const runBtn = $('#comboRun');
  if (runBtn && !runBtn.dataset.bound) { runBtn.dataset.bound = '1'; runBtn.onclick = () => { if (!_comboItems.length) { toast('组合为空，先加股'); return; } const name = comboPersist(); switchTab('pfbt'); setTimeout(() => { const sel2 = $('#pfbtComboSel'); if (sel2) { sel2.innerHTML = ''; const c3 = DL.loadCombos(); (c3.combos || []).forEach(cm => { const o = document.createElement('option'); o.value = cm.id; o.textContent = cm.name + '（' + cm.items.length + '只）'; sel2.appendChild(o); }); sel2.value = _comboId || ''; } const run = $('#pfbtRun'); if (run) run.click(); }, 300); }; }
  /* 环形图视图切换（金额/分红） */
  $b('comboDonutMode', () => { _comboDonutMode = _comboDonutMode === 'amt' ? 'div' : 'amt'; renderComboDonut(); });
  /* 快捷键（Ctrl+Z 撤销 / Ctrl+S 保存 / Ctrl+Enter 回测） */
  document.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { if (typeof comboUndo === 'function') { e.preventDefault(); comboUndo(); } }
    if ((e.ctrlKey || e.metaKey) && k === 's') { const sb = $('#comboSave'); if (sb && sb.dataset.bound) { e.preventDefault(); sb.click(); } }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { const rb = $('#pfbtRun'); if (rb) { e.preventDefault(); rb.click(); } }
  });
}

  /* D2（M186）：合并 renderHoldingsEditor + renderPortfolioSample → renderHoldingsCard
   * 结构：头部 + 录入表单 +（空态=引导 / 有持仓=明细表 7 列 + 组合总览卡）
   * 两套行绑定并存（M134）：明细表 data-hrow（编辑+✕删除+点击跳诊断+stopPropagation）
   *   组合总览卡 data-diag（纯点击跳诊断）
   * 空态=引导+完整表单（M138）；备份提醒保留（M132）；#pfSample id 保留（M137）
   * A1 扩展点：7 列含现价/市值（D 阶段先"—"占位，A1 fillPrices 异步填，M215-M217）
   * 手机适配（M197）：≤900px 核心 4 列由 A1 阶段加响应式，本函数全 7 列结构 */
  function renderHoldingsCard() {
    const el = $('#pfSample');
    if (!el) return;
    const holds = loadHoldings();
    const n = holds.length;
    const backupHint = (() => {
      try {
        const t = parseInt(localStorage.getItem('divtool_last_export') || '0', 10);
        if (!t) return ' <span style="font-size:11px;color:var(--muted)">（未备份过，建议 ☁️ 定期导出）</span>';
        const days = Math.round((Date.now() - t) / 86400000);
        if (days > 30) return ` <span style="font-size:11px;color:#e05a5a">⚠️ 上次导出 ${days} 天前（>30 天，建议重新导出）</span>`;
        return ` <span style="font-size:11px;color:var(--muted)">上次导出 ${days} 天前</span>`;
      } catch (e) { return ''; }
    })();
    const title = n ? `📊 我的持仓 · 已录入 ${n} 只` : '📥 我的持仓';
    const form = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;font-size:11px">
        <input id="holdCode" placeholder="代码" maxlength="6" style="width:70px;padding:4px 6px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt)">
        <input id="holdShares" placeholder="股数" type="number" style="width:80px;padding:4px 6px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt)">
        <input id="holdCost" placeholder="成本价" type="number" step="0.01" style="width:80px;padding:4px 6px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt)">
        <input id="holdDate" placeholder="买入日期 YYYY-MM-DD" style="width:130px;padding:4px 6px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt)">
        <button type="button" class="btn flexbtn" id="holdAdd">➕ 录入</button>
        <button type="button" class="chip" id="holdBulkToggle">📋 批量粘贴</button>
        ${n ? '<button type="button" class="chip" id="holdClear" style="color:#e05a5a">清空</button>' : ''}
      </div>
      <div id="holdBulkWrap" style="display:none;margin-bottom:8px">
        <textarea id="holdBulk" placeholder="每行 代码:股数，例：&#10;601398:1000&#10;600036:2000&#10;000858:500" style="width:100%;height:72px;padding:6px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt);font-size:11px;resize:vertical"></textarea>
        <div id="holdBulkErr" style="font-size:11px;color:#e05a5a;margin-top:4px"></div>
        <button type="button" class="btn flexbtn" id="holdBulkAdd" style="margin-top:6px">✅ 批量保存</button>
      </div>`;
    const emptyGuide = `
      <div style="padding:10px;border:1px dashed var(--line);border-radius:8px;text-align:center;font-size:12px;color:var(--muted)">
        📊 录入持仓后，这里显示您的组合总览（总市值/分红/覆盖月支出）
        <div style="margin-top:8px"><button type="button" class="btn flexbtn" id="holdEmptyAdd">➕ 录入持仓</button></div>
      </div>`;
    const rowsHtml = holds.map((h, i) => {
      const wCost = calcWeightedCost(h);
      const hasTrades = holdTrades(h).length > 0;
      const costTxt = wCost != null ? wCost.toFixed(2) + (hasTrades ? '' : ' <span style="color:var(--sub);font-size:10px">手填</span>') : '—';
      return `<tr style="border-top:1px solid var(--line);cursor:pointer" data-hrow="${h.code}" title="点击进诊断">
        <td style="padding:3px"><b>${esc(h.name || h.code)}</b></td>
        <td style="text-align:center" class="col-opt">${h.code}</td>
        <td style="text-align:center">${h.shares}</td>
        <td style="text-align:center" class="col-opt">${costTxt}</td>
        <td style="text-align:center" class="col-opt">${h.date || '—'}</td>
        <td style="text-align:center" class="hq-price" data-code="${h.code}">—</td>
        <td style="text-align:center" class="hq-mv" data-code="${h.code}">—</td>
        <td style="text-align:center" class="hq-pnl" data-code="${h.code}">—</td>
        <td style="text-align:center"><button type="button" class="chip" data-add="${i}" style="color:var(--gold)">➕加仓</button> <button type="button" class="chip" data-rm="${i}" style="color:#e05a5a">✕</button></td>
      </tr>`;
    }).join('');
    const detailTable = n ? `
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <tr style="color:var(--muted)"><th style="text-align:left;padding:3px">名称</th><th class="col-opt">代码</th><th>股数</th><th class="col-opt">成本</th><th class="col-opt">买入日</th><th>现价</th><th>市值</th><th>盈亏</th><th></th></tr>
        ${rowsHtml}
      </table>
      <div style="font-size:11px;color:var(--sub);margin-top:2px">市值=现价×股数（全部持仓）· 盈亏=市值−成本（加权平均，手填=录入原价）· 现价=腾讯行情快照（TTL 15 分钟）</div>` : '';
    const overviewRows = holds.map(h => `
      <tr style="border-top:1px solid var(--line);cursor:pointer" data-diag="${h.code}">
        <td style="padding:4px"><b>${esc(h.name || h.code)}</b><div style="font-size:11px;color:var(--muted)">${esc(h.code)}</div></td>
        <td style="text-align:center">${h.shares}</td>
        <td style="text-align:center">${h.cost != null ? h.cost.toFixed(2) : '—'}</td>
        <td style="text-align:center">${h.date || '—'}</td>
        <td style="text-align:center;font-size:11px;color:var(--muted)">点此行看诊断 →</td>
      </tr>`).join('');
    const overview = n ? `
      <div class="card" style="margin-top:8px">
        <div style="font-size:12px;font-weight:700">📊 组合总览（已录入 ${n} 只）${backupHint}</div>
        <div id="pfMvRow" style="font-size:12px;margin:6px 0;padding:6px 8px;background:var(--card2);border-radius:8px">总市值/总盈亏加载中…</div>
        <div id="pfRingWrap" style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:6px 0">
          <div id="pfRing" style="width:150px;height:150px;flex-shrink:0"></div>
          <div style="flex:1;min-width:200px">
            <table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px"><tr style="color:var(--muted)"><th style="text-align:left;padding:4px">标的</th><th>股数</th><th>成本</th><th>买入日</th><th>提示</th></tr>${overviewRows}</table>
            <div class="hint" style="margin-top:4px">点击持仓行可跳转该股诊断（X12）；备份入口在首页分红日历底部 💸 分红生活视角 → ⬇️ 导出数据</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--muted)">占比=市值÷总市值（现价×股数，腾讯行情快照）· 点扇区跳诊断</div>
        <div id="pfNetWorth" style="width:100%;height:160px;margin-top:8px"></div>
        <div id="pfNetWorthSub" style="font-size:11px;color:var(--muted);text-align:center"></div>
      </div>` : '';
    /* A2（M181/M183/M199/M213）：紧凑行 3 数字+警示徽标（全读缓存零请求；渐进增强 M188：无警示数据不显示） */
    let compactHtml = '';
    try {
      const pf = JSON.parse(localStorage.getItem('divtool_pf_summary') || 'null');
      const cp = JSON.parse(localStorage.getItem('divtool_compact_cache') || 'null');
      const cells = [];
      const yearIncome = cp ? cp.yearIncome : null;
      const yearTotalNow = cp ? cp.yearTotalNow : null;
      const target = cp ? cp.target : null;
      if (yearIncome != null) cells.push(`<span style="color:var(--gold)">年度分红 <b>${(yearIncome / 10000).toFixed(2)}万</b></span>`);
      if (target > 0 && yearTotalNow != null) {
        const cov = Math.min(999, yearTotalNow / target * 100);
        cells.push(`<span style="color:${cov >= 100 ? '#4caf7d' : 'var(--gold)'}">目标覆盖 <b>${cov.toFixed(0)}%</b></span>`);
      }
      if (pf && pf.totalPos != null) cells.push(`<span>总仓位 <b>${pf.totalPos}%</b>（${pf.triggeredCount || 0} 触发）</span>`);
      const nWarn = pf ? ((pf.nTrap || 0) + (pf.nWarn || 0) + (pf.nF10Trap || 0)) : 0;
      if (nWarn > 0) cells.push(`<span style="color:#e05a5a">⚠️ ${nWarn} 警示</span>`);
      if (cells.length) compactHtml = `<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px;margin-bottom:6px;padding:5px 8px;background:var(--card2);border-radius:8px">${cells.join('<span style="color:var(--line)">|</span>')}<span style="color:var(--sub)">总市值见下方我的持仓卡</span></div>`;
    } catch (e) { compactHtml = ''; }
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:12px;font-weight:700">${title}</div>
        <div style="font-size:11px;color:var(--muted)">数据存本地 · 不进仓库</div>
      </div>
      ${compactHtml}
      ${form}
      ${n ? '' : emptyGuide}
      ${detailTable}
      ${overview}`;
    bindHoldingEvents();
    if (n) fillHoldPrices();   /* A1（M215-M217）：骨架先渲染 → 异步填现价/市值 + 画环形图；失败 {} 兑底 */
  }

  /* A1（M215-M217）：批量拉行情快照一次（getStockQuotes TTL15min 已缓存）→ 填现价/市值 + 画环形图
   * 快照失败 {} 兑底显示"—"不白屏（M215）；市值=现价×股数；环形图只在有持仓时画（M198） */
  let _pfRingChart = null;
  let _pfbtChart = null;   /* 批次3 R2：组合回测三线曲线实例 */
  async function fillHoldPrices() {
    const el = $('#pfSample');
    if (!el) return;
    const holds = loadHoldings();
    if (!holds.length) return;
    const codes = holds.map(h => h.code);
    let snap = {};
    try { snap = await DL.getStockQuotes(codes); } catch (e) { snap = {}; }
    const priceEls = el.querySelectorAll('.hq-price');
    const mvEls = el.querySelectorAll('.hq-mv');
    const pnlEls = el.querySelectorAll('.hq-pnl');
    let totalMv = 0, totalCost = 0;
    const rows = [];
    const costOf = {};
    holds.forEach(h => {
      const wCost = calcWeightedCost(h);
      costOf[h.code] = wCost;
      totalCost += (wCost != null ? wCost * h.shares : 0);
    });
    holds.forEach(h => {
      const p = (snap[h.code] && snap[h.code].price != null) ? snap[h.code].price : null;
      const mv = (p != null && h.shares > 0) ? p * h.shares : null;
      const wCost = costOf[h.code];
      const pnl = (mv != null && wCost != null) ? mv - wCost * h.shares : null;
      if (mv != null) totalMv += mv;
      if (mv != null) rows.push({ code: h.code, name: h.name || h.code, value: mv });
      priceEls.forEach(x => { if (x.dataset.code === h.code) x.textContent = p != null ? p.toFixed(2) : '—'; });
      mvEls.forEach(x => { if (x.dataset.code === h.code) x.textContent = mv != null ? Math.round(mv).toLocaleString() : '—'; });
      pnlEls.forEach(x => {
        if (x.dataset.code === h.code) {
          x.textContent = pnl != null ? (pnl >= 0 ? '+' : '') + Math.round(pnl).toLocaleString() : '—';
          if (pnl != null) x.style.color = pnl >= 0 ? '#4caf7d' : '#e05a5a';
        }
      });
    });
    drawHoldRing(rows, totalMv);
    /* 批次2（M274-M277）：净值曲线数据源——市值快照每天首开存（当天去重），divCum 由渲染期读 divtool_div_years 缓存 */
    try {
      const today = DL.todayStr();
      const snaps = JSON.parse(localStorage.getItem('divtool_holdings_snap') || '[]');
      if (!Array.isArray(snaps)) return;
      if (!snaps.some(s => s.date === today) && totalMv > 0) {
        snaps.push({ date: today, totalValue: totalMv, items: holds.map(h => ({ code: h.code, name: h.name || h.code, shares: h.shares, value: (costOf[h.code] != null && snap[h.code] && snap[h.code].price != null) ? snap[h.code].price * h.shares : null })) });
        snaps.sort((a, b) => a.date < b.date ? -1 : 1);
        if (snaps.length > 366) snaps.splice(0, snaps.length - 366);
        localStorage.setItem('divtool_holdings_snap', JSON.stringify(snaps));
      }
    } catch (e) {}
    /* 组合总市值/总盈亏写入总览行（无行情时兜底不显示） */
    const mvRow = document.getElementById('pfMvRow');
    if (mvRow && totalMv > 0) {
      const totalPnl = totalMv - totalCost;
      mvRow.innerHTML = `总市值 <b style="color:var(--txt)">${Math.round(totalMv).toLocaleString()}</b> · 总成本 <b>${Math.round(totalCost).toLocaleString()}</b> · 总盈亏 <b style="color:${totalPnl >= 0 ? '#4caf7d' : '#e05a5a'}">${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}（${totalCost > 0 ? ((totalPnl / totalCost) * 100).toFixed(1) : '—'}%）</b>`;
    }
    drawNetWorthCurve();
  }

  /* 批次2（M274-M277）：组合历史净值曲线——双线：市值（快照 divtool_holdings_snap）+ 累计分红（E1 历史 divtool_div_years）
   * 起点不同标注（M276）；数据积累中标注（M277）；放在持仓卡环形图下方 */
  let _netChart = null;
  function drawNetWorthCurve() {
    const el = document.getElementById('pfNetWorth');
    if (!el) return;
    let snaps = [];
    try { snaps = JSON.parse(localStorage.getItem('divtool_holdings_snap') || '[]'); } catch (e) {}
    if (!snaps.length || snaps.length < 1) {
      el.innerHTML = '<div class="hint" style="font-size:11px;padding:8px;text-align:center">📈 净值曲线积累中（每天打开工具记录一次市值快照，攒几天后显示）</div>';
      return;
    }
    let divYears = null;
    try { divYears = JSON.parse(localStorage.getItem('divtool_div_years') || 'null'); } catch (e) {}
    const mvData = snaps.map(s => [s.date, Math.round(s.totalValue)]);
    const divData = [];
    if (divYears && Array.isArray(divYears.years)) {
      let cum = 0;
      divYears.years.forEach((y, i) => { cum += (divYears.values[i] || 0); divData.push([y + '-12-31', Math.round(cum)]); });
    }
    if (typeof echarts === 'undefined') { el.innerHTML = '<div class="hint" style="font-size:11px;padding:8px;text-align:center">图表库未加载</div>'; return; }
    if (_netChart) { _netChart.dispose(); _netChart = null; }
    const chart = _netChart = echarts.init(el);
    const series = [{ name: '持仓市值', type: 'line', data: mvData, smooth: true, showSymbol: false, lineStyle: { color: '#4caf7d', width: 2 }, itemStyle: { color: '#4caf7d' } }];
    if (divData.length) series.push({ name: '累计分红', type: 'line', data: divData, smooth: true, showSymbol: false, lineStyle: { color: '#d9a441', width: 2, type: 'dashed' }, itemStyle: { color: '#d9a441' } });
    chart.setOption({
      title: { text: '组合净值曲线', left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
      tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 } },
      legend: { top: 16, textStyle: { color: '#8fa69c', fontSize: 10 }, data: series.map(s => s.name) },
      grid: { left: 52, right: 12, top: 40, bottom: 24 },
      xAxis: { type: 'time', axisLabel: { color: '#8fa69c', fontSize: 10 }, axisLine: { lineStyle: { color: '#2a3d36' } } },
      yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
      series,
    });
    /* 双线起点不同标注（M276） */
    const sub = document.getElementById('pfNetWorthSub');
    if (sub) sub.textContent = divData.length ? '市值=打开工具的日子起快照 · 累计分红=E1 历史年度累加（起点不同）' : '市值=打开工具的日子起快照（数据积累中）';
  }

  /* A1 环形图（M179/M198/M211/M214）：市值占比饼图，扇区标百分比 1 位小数+图例标名称市值，点扇区跳诊断
   * resize 监听（M218）：复用全局 resize（2281 行 cmpCharts 同一监听） */
  function drawHoldRing(rows, totalMv) {
    const el = document.getElementById('pfRing');
    if (!el) return;
    if (!rows.length) { if (_pfRingChart) { _pfRingChart.dispose(); _pfRingChart = null; } el.innerHTML = '<div class="hint" style="font-size:11px;padding-top:52px;text-align:center">行情快照未取到<br>稍后自动重试</div>'; return; }
    if (typeof echarts === 'undefined') { el.innerHTML = '<div class="hint" style="font-size:11px;padding-top:52px;text-align:center">图表库未加载</div>'; return; }
    if (_pfRingChart) { _pfRingChart.dispose(); _pfRingChart = null; }
    const chart = _pfRingChart = echarts.init(el);
    chart.setOption({
      tooltip: { trigger: 'item', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => `<b>${p.name}</b><br/>市值 <b>${(p.value / 10000).toFixed(2)} 万</b>（${p.percent.toFixed(1)}%）` },
      series: [{ type: 'pie', radius: ['45%', '72%'], label: { formatter: '{d}%', fontSize: 10, color: '#e8efe9' }, data: rows }],
      title: { text: '市值占比', left: 'center', top: 2, textStyle: { fontSize: 10, color: '#8fa69c' } },
    });
    chart.on('click', p => { if (p.data && p.data.code) { try { openDiagnose(p.data.code); } catch (e) {} } });
  }

  function refreshPortfolio() { renderHoldingsCard(); }

  /* M105：bindHoldingEvents 独立函数（两分支复用）——addBtn/rmBtns/clearBtn/bulkToggle/bulkAdd/data-diag/data-hrow 全绑 + stopPropagation（M119）
   * M154：空态分支也要绑 bulkToggle（可直接批量粘贴）；M155：选择器限 el 范围防 662 行自选卡 data-code 干扰 */
  function bindHoldingEvents() {
    const el = $('#pfSample');
    if (!el) return;
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
      const holds2 = loadHoldings();
      const dup = holds2.find(h => h.code === code);
      if (dup) { toast('该代码已录入 → 用行内 ➕加仓 追加（记录买入流水）'); return; }
      let name = code;
      try {
        const nn = await DL.fetchName(code);
        if (nn && nn !== code) name = nn;
        else { toast('代码不存在或无法识别'); return; }
      } catch (e) { toast('代码校验失败'); return; }
      /* 批次2（M260/M267）：新增写首笔 trades（date/shares/price）；无价则 trades 空+cost 手填 */
      const trades = (cost > 0 && date) ? [{ date: date || null, shares, price: cost }] : [];
      holds2.push({ code, name, shares, cost: cost > 0 ? cost : null, date: date || null, trades });
      saveHoldings(holds2);
      try { toast('✅ 已保存 ' + holds2.length + ' 只持仓' + (trades.length ? '（含首笔买入流水）' : '')); } catch (e2) {}
      refreshPortfolio();
    };
    /* 批次2（M267-M270）：行内 ➕加仓——只追加 trades，不覆盖；输入框填了代码=预填该行，否则用该行代码 */
    el.querySelectorAll('[data-add]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const i = parseInt(b.dataset.add, 10);
      const h2 = loadHoldings();
      const h = h2[i];
      if (!h) return;
      const shares = parseFloat(document.getElementById('holdShares').value);
      const cost = parseFloat(document.getElementById('holdCost').value);
      const date = document.getElementById('holdDate').value.trim();
      if (!(shares > 0) || !isFinite(shares)) { toast('先在上方填加仓股数'); return; }
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('日期格式 YYYY-MM-DD'); return; }
      const ts = holdTrades(h).slice();
      ts.push({ date: date || null, shares, price: cost > 0 ? cost : null });
      const newShares = h.shares + shares;
      const wCost = calcWeightedCost(Object.assign({}, h, { trades: ts }));
      h2[i] = Object.assign({}, h, { shares: newShares, trades: ts, cost: wCost != null ? wCost : h.cost });
      saveHoldings(h2);
      try { toast('✅ ' + h.code + ' 加仓 ' + shares + ' 股 → 共 ' + newShares + ' 股（加权成本 ' + (wCost != null ? wCost.toFixed(2) : '—') + '）'); } catch (e2) {}
      refreshPortfolio();
    });
    const emptyAdd = document.getElementById('holdEmptyAdd');
    if (emptyAdd) emptyAdd.onclick = () => { const fc = document.getElementById('holdCode'); if (fc) { fc.focus(); try { fc.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} } };
    el.querySelectorAll('[data-rm]').forEach(b => b.onclick = e => {
      e.stopPropagation();   /* X12：防冒泡触发行点击进诊断 */
      const i = parseInt(b.dataset.rm, 10);
      const h2 = loadHoldings(); h2.splice(i, 1); saveHoldings(h2);
      try { toast('✅ 已保存 ' + h2.length + ' 只持仓'); } catch (e2) {}
      refreshPortfolio();
    });
    /* X12/P46（2026-08-21）：持仓行可点进诊断（与自选卡一致；删除按钮 stopPropagation 防冲突） */
    el.querySelectorAll('[data-hrow]').forEach(r => {
      r.onclick = () => { openDiagnose(r.dataset.hrow); };
      /* v3.0 V13：hover 微交互——迷你提示（距加仓线/分红质量/最近分红） */
      r.addEventListener('mouseenter', () => {
        const code = r.dataset.hrow;
        const h = loadHoldings().find(x => x.code === code);
        if (!h) return;
        const cost = calcWeightedCost(h);
        const costTxt = cost != null ? '成本 ' + cost.toFixed(2) : '成本 —';
        const divTxt = (h.snapshot && h.snapshot.divYield != null) ? '股息率 ' + h.snapshot.divYield.toFixed(2) + '%' : '股息率 —';
        const tip = document.createElement('div');
        tip.style.cssText = 'position:absolute;z-index:99;background:rgba(20,20,26,.96);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:11px;color:#e8efe9;pointer-events:none;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.4);transition:opacity .2s';
        tip.textContent = esc(h.name || code) + ' · ' + costTxt + ' · ' + divTxt + ' · 点击进诊断';
        r.style.position = 'relative';
        r.appendChild(tip);
        tip.style.top = '-34px'; tip.style.left = '0';
      });
      r.addEventListener('mouseleave', () => { const t = r.querySelector('div[style*="position:absolute"]'); if (t) t.remove(); });
    });
    const clearBtn = document.getElementById('holdClear');
    if (clearBtn) clearBtn.onclick = () => { saveHoldings([]); try { toast('✅ 已清空持仓'); } catch (e2) {} refreshPortfolio(); };
    /* J2/P100（2026-08-21）：批量粘贴入口——行级错误定位（"第 2 行格式错误：601398（应为 代码:股数）"）+ toast"已保存 N 只" */
    const bulkToggle = document.getElementById('holdBulkToggle');
    const bulkWrap = document.getElementById('holdBulkWrap');
    if (bulkToggle && bulkWrap) bulkToggle.onclick = () => { bulkWrap.style.display = bulkWrap.style.display === 'none' ? 'block' : 'none'; };
    const bulkAdd = document.getElementById('holdBulkAdd');
    if (bulkAdd) bulkAdd.onclick = () => {
      const raw = (document.getElementById('holdBulk').value || '').split(/\n/);
      const errEl = document.getElementById('holdBulkErr');
      if (errEl) errEl.innerHTML = '';
      const errors = [];
      const parsed = [];
      const seen = {};
      raw.forEach((line, i) => {
        const t = line.trim();
        if (!t) return;
        const m = t.match(/^(\d{6})\s*[:：]\s*(\d+(?:\.\d+)?)$/);
        if (!m) { errors.push('第 ' + (i + 1) + ' 行格式错误：' + t.slice(0, 20) + '（应为 代码:股数）'); return; }
        const code = m[1], shares = parseFloat(m[2]);
        if (!(shares > 0)) { errors.push('第 ' + (i + 1) + ' 行股数无效：' + t.slice(0, 20)); return; }
        if (seen[code]) { errors.push('第 ' + (i + 1) + ' 行重复：' + code + '（同一批只取首行）'); return; }
        seen[code] = true;
        parsed.push({ code, name: code, shares, cost: null, date: null });
      });
      const existing = loadHoldings();
      const dupInStore = parsed.filter(p => existing.some(h => h.code === p.code));
      const fresh = parsed.filter(p => !existing.some(h => h.code === p.code));
      if (fresh.length) { existing.push(...fresh); saveHoldings(existing); }
      let msg = '✅ 已保存 ' + existing.length + ' 只持仓';
      const parts = [];
      if (fresh.length) parts.push('新增 ' + fresh.length + ' 只');
      if (dupInStore.length) parts.push('已存在跳过 ' + dupInStore.length + ' 只');
      if (errors.length) parts.push(errors.length + ' 行错误');
      if (parts.length) msg += '（' + parts.join('，') + '）';
      if (errors.length) { if (errEl) errEl.innerHTML = errors.slice(0, 5).join('<br>') + (errors.length > 5 ? '<br>… 共 ' + errors.length + ' 行错误' : ''); }
      try { toast(msg); } catch (e2) {}
      const ta = document.getElementById('holdBulk');
      if (ta) ta.value = '';
      refreshPortfolio();
    };
    el.querySelectorAll('[data-diag]').forEach(tr => { tr.onclick = () => { try { openDiagnose(tr.dataset.diag); } catch (e) {} }; });
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
    /* P114（2026-08-21）：F2 第 0 步——旧 key 一次性迁移（对象→数组），必须在渲染前 */
    try { migrateHoldingsV1(); } catch (e) { }
    /* P39（2026-08-21）：IndexedDB 缓存卫生（>7天且>50MB 才 prune，异步不阻塞） */
    try { if (typeof DL.cachePrune === 'function') DL.cachePrune(); } catch (e) { }
    refreshPortfolio();
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
          toast('请输入 6 位股票代码');
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
    /* P70/P73（2026-08-21）：一个"找机会"入口——三通道 tab（自选/扫描/发现器），原 btnScan+btnDiscover 合并 */
    const btnFindOpp = $('#btnFindOpp');
    if (btnFindOpp) btnFindOpp.onclick = () => {
      const panel = $('#scanPanel');
      if (!panel) return;
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        activateOppTab('watch');
        try { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e2) {}
      } else { panel.style.display = 'none'; }
    };
    const activateOppTab = (which) => {
      const panel = $('#scanPanel');
      const body = $('#scanBody');
      if (!panel || !body) return;
      panel.querySelectorAll('.opp-tab').forEach(t => t.classList.toggle('active', t.dataset.opp === which));
      if (which === 'watch') {
        body.innerHTML = '<div class="hint">⭐ 我的自选见上方自选卡：机会雷达 + 档位排序 + 卖出信号角标。点卡片进诊断看买卖点。</div>';
        const wc = $('#watchlistCard');
        if (wc) { try { wc.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e2) {} }
      } else if (which === 'scan') {
        runScanner();
      } else if (which === 'disc') {
        runDiscoverer();
      }
    };
    panelTabClick: {
      const panel = $('#scanPanel');
      if (panel) panel.querySelectorAll('.opp-tab').forEach(t => t.onclick = () => activateOppTab(t.dataset.opp));
    }
    // v1.9.2：组合回测 tab 绑定（区间 chips + 运行按钮 + 模式切换）
    const pfbtRun = $('#pfbtRun');
    if (pfbtRun) pfbtRun.onclick = runPortfolioBacktest;
    document.querySelectorAll('.pfbt-y').forEach(b => b.onclick = () => {
      document.querySelectorAll('.pfbt-y').forEach(x => x.classList.toggle('on', x === b));
    });
    const pfbtModeSel = $('#pfbtMode');
    if (pfbtModeSel && !pfbtModeSel.dataset.bound) { pfbtModeSel.dataset.bound = '1'; pfbtModeSel.onchange = () => { try { $('#pfbtRun').click(); } catch (e) {} }; }
    const btnDiagBacktest = $('#btnDiagBacktest');
    if (btnDiagBacktest) btnDiagBacktest.onclick = () => { if (diagCode) { const input = $('#code'); if (input) input.value = diagCode; const bd = $('#buyDate'); if (bd) bd.value = DL.daysAgo(5 * 366); switchTab('backtest'); $('#btnRun').click(); } };
    /* C19/P80（2026-08-21）：诊断页头 ← 返回决策台 */
    const diagBack = $('#diagBack');
    if (diagBack) diagBack.onclick = () => switchTab('home');
    /* C18/E5（2026-08-21）：诊断页头 🔄 刷新数据（3s 冷却） */
    let _diagRefreshAt = 0;
    const diagRefresh = $('#diagRefresh');
    if (diagRefresh) diagRefresh.onclick = () => {
      const now = Date.now();
      if (now - _diagRefreshAt < 3000) { try { toast('刷新冷却中（3 秒）'); } catch (e2) {} return; }
      _diagRefreshAt = now;
      if (diagCode) openDiagnose(diagCode, diagYears);
    };
    /* C14/E1（2026-08-21）：诊断页自选快捷切换（←/→，P75 切换保留上下文） */
    const diagPrev = $('#diagPrev'), diagNext = $('#diagNext');
    if (diagPrev) diagPrev.onclick = () => { const wl = homeState.watchlist || []; const idx = wl.findIndex(x => x.code === diagCode); if (idx > 0) openDiagnose(wl[idx - 1].code, diagYears); };
    if (diagNext) diagNext.onclick = () => { const wl = homeState.watchlist || []; const idx = wl.findIndex(x => x.code === diagCode); if (idx >= 0 && idx < wl.length - 1) openDiagnose(wl[idx + 1].code, diagYears); };
    /* C5（2026-08-21）：回到顶部（滚动 >800px 出现，点击平滑回顶） */
    const toTop = $('#toTop');
    if (toTop) {
      window.addEventListener('scroll', () => {
        toTop.style.display = (document.documentElement.scrollTop || document.body.scrollTop) > 800 ? 'block' : 'none';
      }, { passive: true });
      toTop.onclick = () => { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e2) { window.scrollTo(0, 0); } };
    }
    /* C20/F2（2026-08-21）：回测页「📥 用我的持仓参数」一键带入（X1 同源；带入可改不锁定 P83） */
    const btUseHoldings = $('#btUseHoldings');
    if (btUseHoldings) btUseHoldings.onclick = () => {
      const hs = loadHoldings();
      if (!hs.length) { try { toast('还没有持仓——先在决策台「📊 我的持仓」录入'); } catch (e2) {} return; }
      const h = hs[0];
      const codeIn = $('#code'); if (codeIn) codeIn.value = h.code;
      const bd = $('#buyDate');
      if (bd) { bd.value = h.date || DL.daysAgo(5 * 366); if (!h.date) { try { toast('该持仓无买入日期，已用 5 年前（可改）'); } catch (e2) {} } }
      if (h.cost > 0 && h.shares > 0) {
        const pr = $('#principal'); if (pr) pr.value = Math.round(h.cost * h.shares);
      }
      try { toast('已带入：' + (h.name || h.code) + '（可修改后回测）'); } catch (e2) {}
    };
    /* C22/L3/P113（2026-08-21）：深链 ?diag=code——先密码锁后生效（轮询解锁标记，锁页不触发） */
    const diagFromUrl = new URLSearchParams(location.search).get('diag');
    if (diagFromUrl && /^\d{6}$/.test(diagFromUrl)) {
      const tryOpenDiag = () => {
        let unlocked = false;
        try { const ts = parseInt(localStorage.getItem('divtool_unlock_ts') || '0', 10); unlocked = !!ts && Date.now() - ts < 30 * 86400000; } catch (e3) {}
        if (unlocked) { openDiagnose(diagFromUrl); }
        else setTimeout(tryOpenDiag, 2000);
      };
      setTimeout(tryOpenDiag, 1000);
    }
    /* C6/P50（2026-08-21）：📄 生成报告——白底报告（组合+持仓+日历+引擎结论四块），Cmd+P 即 PDF */
    const pfReport = $('#pfReport');
    if (pfReport) pfReport.onclick = () => {
      try {
        const today = DL.todayStr();
        const wl = homeState.watchlist || [];
        const holds = loadHoldings();
        let pfTxt = '未展开计算（展开组合总览后报告更全）';
        try { const prev = JSON.parse(localStorage.getItem('divtool_pf_summary') || 'null'); if (prev) pfTxt = prev.txt; } catch (e2) {}
        let dueTxt = '';
        try { const td = JSON.parse(localStorage.getItem('divtool_today_due') || 'null'); if (td && td.date === today && td.txt) dueTxt = ' · 今日到账：' + td.txt; } catch (e2) {}
        const holdRows = holds.length ? holds.map(h => `<tr><td>${esc(h.name || h.code)}</td><td>${esc(h.code)}</td><td>${h.shares}</td><td>${h.cost != null ? h.cost.toFixed(2) : '—'}</td><td>${h.date || '—'}</td></tr>`).join('') : '<tr><td colspan="5">未录入持仓</td></tr>';
        const wlRows = wl.length ? wl.map(w => `<tr><td>${esc(w.name || w.code)}</td><td>${esc(w.code)}</td><td>${w.snapshot && w.snapshot.divYield != null ? w.snapshot.divYield.toFixed(2) + '%' : '—'}</td><td>${w.snapshot && w.snapshot.price != null ? fmt(w.snapshot.price, 2) : '—'}</td></tr>`).join('') : '<tr><td colspan="4">暂无自选</td></tr>';
        const ver = (window.APP_VERSION || 'v1.9.30');
        const w = window.open('', '_blank');
        if (!w) { try { toast('弹窗被拦截，请允许弹出'); } catch (e3) {} return; }
        w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>红利复投工具 · 报告 ${today}</title>
<style>body{font-family:-apple-system,'PingFang SC',sans-serif;color:#111;padding:24px;max-width:760px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}th,td{padding:5px 8px;text-align:left;border-bottom:1px solid #ddd}th{color:#555;font-size:11px}
.meta{font-size:11px;color:#666;margin-bottom:16px}.box{border:1px solid #ddd;border-radius:8px;padding:10px 12px;font-size:13px;margin-top:6px}
.eng{border:1px solid #d9a441;border-radius:8px;padding:10px 12px;font-size:13px;margin-top:6px;background:#fdf9ef}
.foot{margin-top:24px;font-size:10px;color:#888}</style></head><body>
<h1>💰 红利复投工具 · 投资报告</h1>
<div class="meta">生成日期 ${today} · 版本 ${ver} · 数据本地缓存，仅供研究参考，非投资建议</div>
<h2>一、组合总览</h2><div class="box">${esc(pfTxt)}${dueTxt}</div>
<h2>二、我的持仓</h2><table><tr><th>名称</th><th>代码</th><th>股数</th><th>成本价</th><th>买入日</th></tr>${holdRows}</table>
<h2>三、自选快照</h2><table><tr><th>名称</th><th>代码</th><th>年化股息率</th><th>现价</th></tr>${wlRows}</table>
<h2>四、引擎结论</h2>`);
        if (diagCode) {
          const el2 = $('#diagSummaryBody');
          w.document.write(`<div class="eng">当前诊断：${esc(diagCode)}（${esc(el2 ? el2.innerText.slice(0, 500) : '打开诊断页后结论自动带入')}）</div>`);
        } else {
          w.document.write(`<div class="box">进入单股诊断页后，此处自动带入引擎结论（档位+依据+历史胜率）</div>`);
        }
        w.document.write(`<div class="foot">口径：股息率=报告期口径（最近完整财年分红÷当日价，公告即算）；报告内容随本地数据更新；历史数据不代表未来，不构成买卖依据。</div>
</body></html>`);
        w.document.close();
        setTimeout(() => { try { w.focus(); w.print(); } catch (e3) {} }, 400);
      } catch (e) { try { toast('报告生成失败：' + e.message); } catch (e2) {} }
    };
    switchTab('home');
  });
})();
// v1.8.13 BUG-3：views.js 就绪标志（index.html 自动运行等此标志，不再等 window load——load 依赖 echarts CDN 速度）
window.__viewsReady = true;
(window.__viewsReadyCallbacks || []).forEach(function (f) { try { f(); } catch (e) { } });
