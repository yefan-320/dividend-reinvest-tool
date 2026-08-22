/* ============================================================
 * views-home.js — views.js 拆分模块 决策台（今日简报/机会地图/自选/日历/扫描/发现器）
 * 生成：scripts/split-views.py（v3.10+ 接手 AI）
 * 加载顺序：views-core → views-home → views-diag → views-compare → views-pfbt
 * 全局作用域共享（去 IIFE），勿在此文件内重复声明 DL/$/fmt
 * ============================================================ */
  function renderTodayBrief(rows) {
    const el = document.getElementById('todayBrief');
    if (!el || !rows || !rows.length) return;
    const inZone = rows.filter(r => r.pct != null && r.pct >= 80).sort((a, b) => (b.pct || 0) - (a.pct || 0));
    const topDy = rows.filter(r => r.dy != null).sort((a, b) => (b.dy || 0) - (a.dy || 0)).slice(0, 3);
    const parts = [];
    if (inZone.length) {
      parts.push(`<span style="color:#4caf7d">📡 <b>${inZone.length}</b> 只在买点区：${inZone.slice(0, 3).map(r => `<a href="javascript:void(0)" data-map="${r.code}" style="color:#4caf7d;text-decoration:underline">${r.name} ${r.pct.toFixed(0)}%</a>`).join('、')}${inZone.length > 3 ? '…' : ''}</span>`);
    } else {
      parts.push('<span style="color:var(--sub)">📡 暂无自选在买点区</span>');
    }
    if (topDy.length) {
      parts.push(`<span style="color:#d9a441">💰 高息榜：${topDy.map(r => `<a href="javascript:void(0)" data-map="${r.code}" style="color:#d9a441;text-decoration:underline">${r.name} ${r.dy.toFixed(1)}%</a>`).join('、')}</span>`);
    }
    try {
      const today = DL.todayStr();
      const todayDec = decLog().filter(x => (x.ts || '').toString().length === 13 ? new Date(x.ts).toISOString().slice(0, 10) === today : false).length;
      if (todayDec > 0) parts.push(`<span style="color:#5aa9e6">📒 今日已记 ${todayDec} 条决策</span>`);
    } catch (e) {}
    el.style.display = 'block';
    el.innerHTML = `<div style="padding:8px 12px;border:1px solid rgba(90,169,230,.35);border-radius:10px;background:rgba(90,169,230,.07);font-size:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center"><span style="font-weight:700;color:#5aa9e6">☀️ 今日简报</span>${parts.join('<span style="color:var(--line)">|</span>')}<span style="font-size:10px;color:var(--muted);margin-left:auto">点名称进诊断 · 完整机会地图见下方自选卡</span></div>`;
    el.querySelectorAll('[data-map]').forEach(a => a.onclick = () => { try { openDiagnose(a.dataset.map); } catch (e) {} });
  }

  async function renderOpportunityMap(wl) {
    const el = document.getElementById('oppMap');
    if (!el) return;
    if (!wl || !wl.length) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = '<div class="hint">⏳ 生成机会地图…</div>';
    const rows = [];
    for (const w of wl) {
      try {
        const [kline, divs] = await Promise.all([
          DL.getKline(w.code, DL.daysAgo(400), DL.todayStr()),
          DL.fetchDividendsOne(w.code),
        ]);
        if (!kline || !Object.keys(kline).length) continue;
        const series = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS);
        const last = series.filter(x => x.pct != null).pop();
        const price = Object.values(kline).pop();
        rows.push({
          code: w.code, name: w.name || w.code,
          pct: last ? last.pct : null, dy: last ? last.dy : null, price: price || 0,
        });
      } catch (e) {}
    }
    if (!rows.length) { el.innerHTML = '<div class="hint">数据不足，无法生成地图</div>'; return; }
    const valid = rows.filter(r => r.pct != null && r.dy != null);
    window.__oppMapRows = valid;   /* v3.9.0：供今日简报聚合 */
    if (!valid.length) { el.innerHTML = '<div class="hint">分位数据不足（K线样本<250天）</div>'; return; }
    try { renderTodayBrief(valid); } catch (e) {}
    const data = valid.map(r => [+(r.pct).toFixed(1), +(r.dy).toFixed(2), r.price, r.code, r.name]);
    /* 结论档颜色：分位≥95 深度低估=深绿 / ≥90 低估二档=绿 / ≥75 低估一档=浅绿 / 其余=灰 */
    const colorOf = p => p >= 95 ? '#2e9e63' : p >= 90 ? '#4caf7d' : p >= 75 ? '#8bc34a' : '#8fa69c';
    el.innerHTML = `<div style="background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:8px">
      <div style="font-size:11px;color:var(--gold);font-weight:600;margin-bottom:2px">🗺️ 机会地图（自选全景：越左上=又便宜又高息）</div>
      <div id="oppMapChart" style="height:${Math.min(320, Math.max(200, valid.length * 42))}px"></div>
      <div style="font-size:10px;color:var(--muted);margin-top:2px">X=估值分位（右=历史便宜）· Y=股息率（报告期口径，上=高）· 颜色=结论档（深绿=深度低估…灰=等待）· 点气泡进诊断</div>
    </div>`;
    try {
      if (typeof echarts === 'undefined') return;
      const ch = echarts.init(document.getElementById('oppMapChart'));
      ch.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => `<b>${p.data[4]}</b>（${p.data[3]}）<br/>分位 ${p.data[0]}% · 股息率 ${p.data[1]}% · 现价 ${p.data[2] != null ? p.data[2].toFixed(2) : '—'} 元` },
        grid: { left: 44, right: 30, top: 14, bottom: 28 },
        xAxis: { type: 'value', name: '分位→', nameTextStyle: { color: '#8fa69c', fontSize: 9 }, min: 0, max: 100, axisLabel: { color: '#8fa69c', fontSize: 9 }, splitLine: { lineStyle: { color: '#22322c' } } },
        yAxis: { type: 'value', name: '股息率%', nameTextStyle: { color: '#8fa69c', fontSize: 9 }, axisLabel: { color: '#8fa69c', fontSize: 9 }, splitLine: { lineStyle: { color: '#22322c' } } },
        series: [{
          type: 'scatter', symbolSize: 26, data: data.map(d => ({ value: d, itemStyle: { color: colorOf(d[0]) } })),
          label: { show: true, formatter: p => p.data[4].slice(0, 4), position: 'top', color: '#e8efe9', fontSize: 9 },
          markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(217,164,65,.5)', type: 'dashed' }, data: [{ xAxis: 80 }, { xAxis: 90 }, { xAxis: 95 }] },
        }],
      });
      ch.on('click', p => { if (p.data && p.data[3]) { try { openDiagnose(p.data[3]); } catch (e) {} } });
    } catch (e) { try { console.warn('机会地图失败', e); } catch (e2) {} }
  }

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
    /* v3.9.0 U8 机会地图（不 await，与后续渲染并行） */
    renderOpportunityMap(wl).catch(() => {});
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
    const lifeHtml = `<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px">
      <details><summary style="font-size:11px;color:var(--sub);cursor:pointer">💸 分红生活视角（E1 年报 · D12 消费覆盖 · E2 追加 · E3 里程碑）</summary>
        <div style="font-size:11px;color:var(--sub);margin:6px 0 4px">📅 近 ${Math.min(6, years.length)} 年实际分红收入（需在决策台录入持仓）：</div>
        <div>${yearRows || '<span class="hint">到决策台「📊 我的持仓」录入后显示历史分红收入</span>'}</div>
        <div style="font-size:11px;margin-top:6px">🚀 分红里程碑：${doubleY ? `按近 3 年分红增速 ${(avgCagr * 100).toFixed(1)}% 持续（保守口径），月分红翻倍还需约 <b>${doubleY.toFixed(0)} 年</b>` : '<span class="hint">自选样本不足，无法估算增速（分红不增长时永远不翻倍）</span>'}</div>
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
            title: { text: '分红目标覆盖', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
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
          title: { text: '未来 12 个月到账（税前·元）' + (getParam('monthSmooth') ? '·平滑' : '·实际到账月'), left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
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
      /* v3.7.0 发现器降级（接手 AI S4）：限流时不再裸报失败——
       * ①提示限流 ②自动切换到扫描器通道（效果相同的替代入口）③重试带 10s 冷却防撞限流窗口 */
      const limited = e.message.includes('限流') || e.message.includes('繁忙') || e.message.includes('为空');
      window.__discCooldown = Date.now();
      if (limited) {
        el.innerHTML = `<div class="hint err">⚠️ 发现器限流（东财接口繁忙）。已自动切换到【📡 扫描器】通道（效果相同）：<button type="button" class="chip" id="btnDiscoverRetry" style="margin-left:8px">🔄 10s 后重试发现器</button></div>`;
        const scanTab = document.querySelector('.opp-tab[data-opp="scan"]');
        if (scanTab) { try { scanTab.click(); } catch (e2) {} }
      } else {
        el.innerHTML = `<div class="hint err">⚠️ 发现器失败：${'数据获取失败，请稍后重试'} <button type="button" class="chip" id="btnDiscoverRetry" style="margin-left:8px">🔄 重试</button></div>`;
      }
    const rb = document.getElementById('btnDiscoverRetry');
    if (rb) rb.onclick = () => {
      const wait = Date.now() - (window.__discCooldown || 0);
      if (wait < 10000) { rb.textContent = `🔄 ${Math.ceil((10000 - wait) / 1000)}s 后重试`; setTimeout(() => { rb.textContent = '🔄 重试'; }, 10000 - wait); return; }
      runDiscoverer();
    };
    }
    } finally {
      _discRunning = false;
      if (btnD) { btnD.disabled = false; btnD.textContent = '🔭 发现器'; }
    }
  }

  /* C14/E1（2026-08-21）：诊断页自选快捷切换状态（外层函数，openDiagnose 同步调用） */
