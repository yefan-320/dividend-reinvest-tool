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
  const TABS = ['home', 'diagnose', 'compare', 'backtest'];
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

  /* 机会速览：自选股股息率阈值突破提醒（打开时对比快照） */
  async function renderOpportunities() {
    const el = $('#homeOpportunities');
    if (!el) return;
    const wl = homeState.watchlist;
    if (!wl.length) { el.innerHTML = '<div class="hint">暂无自选股。添加自选后，这里会显示股息率/估值的变化提醒。</div>'; return; }
    el.innerHTML = '<div class="hint">加载中…</div>';
    const snap = await DL.getStockQuotes(wl.map(x => x.code));
    homeState.snap = snap;
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
    el.innerHTML = alerts.length
      ? alerts.map(a => `<div class="alert-item">🔔 ${a}</div>`).join('')
      : '<div class="hint">✅ 暂无新机会（自选股状态稳定）</div>';
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
      el.innerHTML = `<div class="hint">还没有自选。搜索代码添加，或试试：<br>` +
        recs.map(x => `<button class="chip" data-code="${x.code}">${x.name}</button>`).join(' ') +
        `</div>`;
      el.querySelectorAll('.chip').forEach(b => b.onclick = () => addToWatchlist(b.dataset.code));
      return;
    }
    const snap = homeState.snap || await DL.getStockQuotes(wl.map(x => x.code));
    homeState.snap = snap;
    el.innerHTML = wl.map(it => {
      const s = snap[it.code];
      const dy = it.snapshot ? it.snapshot.divYield : null;
      return `<div class="wl-card" data-code="${it.code}">
        <div class="wl-head"><b>${it.name}</b><span class="wl-code">${it.code}</span>${secTypeLabel({ code: it.code }) !== '股票' ? `<span class="chip" style="font-size:10px;padding:1px 6px">${secTypeLabel({ code: it.code })}</span>` : ''}
          <button class="wl-del" data-code="${it.code}">✕</button></div>
        <div class="wl-main">${dy != null ? `股息率 <b class="gold">${dy.toFixed(2)}%</b>` : '<span class="hint">待数据</span>'}
          ${s ? `<span class="wl-price">${fmt(s.price, 2)}元</span>` : ''}</div>
        <div class="wl-sub hint">点击进入诊断</div>
      </div>`;
    }).join('');
    el.querySelectorAll('.wl-card').forEach(c => c.onclick = () => openDiagnose(c.dataset.code));
    el.querySelectorAll('.wl-del').forEach(b => {
      b.onclick = async e => { e.stopPropagation(); await DL.Watchlist.remove(b.dataset.code); renderHome(); };
    });
  }

  /* 除息日历：自选未来30天 */
  async function renderDivCalendar() {
    const el = $('#homeDivCalendar');
    if (!el) return;
    const wl = homeState.watchlist;
    if (!wl.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="hint">除息日历加载中…</div>';
    const today = DL.todayStr();
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const items = (await Promise.all(wl.map(async it => {
      try {
        const divs = await DL.fetchDividendsOne(it.code);
        return divs.filter(d => d.ex && d.ex >= today && d.ex <= future && !d.pending)
          .map(d => ({ ex: d.ex, name: it.name, profile: d.profile || `派${(d.dps * 10).toFixed(2)}元` }));
      } catch (e) { return []; }
    }))).flat();
    items.sort((a, b) => a.ex < b.ex ? -1 : 1);
    el.innerHTML = items.length
      ? items.slice(0, 10).map(i => `<div class="cal-item"><span class="cal-date">${i.ex}</span> ${i.name} · ${i.profile}</div>`).join('')
      : '<div class="hint">未来 30 天无除息安排</div>';
  }

  /* 扫描入口：决策台底部按钮 → 打开扫描子页（简单内嵌） */
  async function runScanner() {
    const el = $('#scanPanel');
    el.style.display = 'block';
    el.innerHTML = '<div class="hint">⏳ 扫描中：拉取全市场分红数据…</div>';
    const from = new Date(Date.now() - DL.CALIB.DIVIDEND_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    try {
      const divs = await DL.fetchDividendsAll(from);
      el.innerHTML = `<div class="hint">✅ 分红数据 ${divs.length} 条，拉取行情快照…</div>`;
      const snap = await DL.getMarketSnapshot();
      // v1.7.6 M10：行情快照全失败时明确提示，避免误显示"筛选出 0 只"
      if (!Object.keys(snap).length) {
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
      el.innerHTML = `<div class="hint">✅ 筛选出 ${rows.length} 只（股息率≥${DL.CALIB.THRESHOLDS.divYield}%、连分≥${DL.CALIB.THRESHOLDS.divYears}年、市值≥50亿、排除ST；⚠️=亏损仍分红，可持续性风险请自行判断）</div>` +
        rows.slice(0, 50).map(r => `<div class="scan-row" data-code="${r.code}">
          <b>${r.name}</b> <span class="wl-code">${r.code}</span>
          <span class="gold">${r.yieldPct.toFixed(2)}%</span>
          <span class="hint">连分${r.payYears}年</span>
          ${r.pe != null && r.pe < 0 ? '<span class="risk-badge">⚠️亏损</span>' : ''}
          <span class="hint">${r.industry || ''} · 市值${(r.marketCap / 1e8).toFixed(0)}亿</span>
        </div>`).join('');
      el.querySelectorAll('.scan-row').forEach(r => r.onclick = () => { addToWatchlist(r.dataset.code); openDiagnose(r.dataset.code); });
    } catch (e) {
      el.innerHTML = `<div class="hint err">扫描失败：${e.message}，请稍后重试</div>`;
    }
  }

  /* ---------- 诊断页 ---------- */
  let diagCode = null;
  let diagYears = 5;
  async function openDiagnose(code, years) {
    diagCode = code;
    if (years) diagYears = years;
    switchTab('diagnose');
    $('#diagEmpty').style.display = 'none';
    $('#diagContent').style.display = 'block';
    $('#diagTitle').textContent = '🔬 ' + code + ' 诊断中…';
    $('#diagStats').innerHTML = '<div class="hint">加载中…</div>';
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
        DL.getKline(code, new Date(Date.now() - diagYears * 366 * 86400000).toISOString().slice(0, 10), DL.todayStr()),
      ]);
      const snap = homeState.snap || await DL.getStockQuotes([code]);
      homeState.snap = snap;
      const s = snap[code] || {};
      const lastPrice = s.price || (kline && Object.values(kline).pop());
      // v1.7.4 P7：年化股息率改按报告期归组（近2报告年度平均÷现价），替代365天窗口
      const dy = DL.calcAnnualDivYield(divs, lastPrice);
      const divYield = dy ? dy.yieldPct : null;
      const dps = dy ? dy.annualDps : null;
      const yieldLabel = dy && dy.count === 1 ? '近1财年' : '近2财年';
      // 股息覆盖率：最新年度 EPS
      const lastDiv = divs[0];
      const cover = lastDiv && lastDiv.eps ? lastDiv.dps / lastDiv.eps : null;
      // 最大回撤（近5年）
      const dates = Object.keys(kline).sort();
      let maxDD = 0, peak = -Infinity;
      dates.forEach(d => { const p = kline[d]; if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > maxDD) maxDD = dd; });
      // 年化（5年）
      const startPrice = dates.length ? kline[dates[0]] : null;
      const yearsSpan = dates.length ? (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (365 * 86400000) : 0;
      const cagr = (startPrice && lastPrice && yearsSpan > 0) ? Math.pow(lastPrice / startPrice, 1 / yearsSpan) - 1 : null;
      $('#diagStats').innerHTML = `<div class="stats">
        <div class="stat"><div class="k">当前股息率</div><div class="v gold">${divYield != null ? divYield.toFixed(2) + '%' : '—'}</div></div>
        <div class="stat"><div class="k">每股分红(年化${yieldLabel})</div><div class="v">${fmt(dps, 3)} 元</div></div>
        <div class="stat"><div class="k">股息覆盖率</div><div class="v">${cover != null ? cover.toFixed(2) : '—'}</div></div>
        <div class="stat"><div class="k">近${diagYears}年年化</div><div class="v ${cagr >= 0 ? 'green' : 'red'}">${cagr != null ? fmtPct(cagr) : '—'}</div></div>
        <div class="stat"><div class="k">近${diagYears}年最大回撤</div><div class="v red">${fmtPct(-maxDD)}</div></div>
        <div class="stat"><div class="k">PE / PB</div><div class="v">${s.pe != null ? fmt(s.pe, 1) : '—'} / ${s.pb != null ? fmt(s.pb, 2) : '—'}</div></div>
      </div>`;
      // 带状图：历史股息率分位（滚动口径：每年用当年分红）
      renderYieldBand(divs, kline, diagYears);
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
    // 逐年到账分红合计（报告期归组与到账年在此简化为自然年，与 simulate years 同口径）
    const byYear = {};
    divs.forEach(d => { if (!d.pending && d.ex) { const y = d.ex.slice(0, 4); byYear[y] = (byYear[y] || 0) + d.dps; } });
    const data = dates.map(d => ({ d, y: (byYear[d.slice(0, 4)] || 0) / kline[d] * 100 })).filter(x => x.y > 0);
    if (!data.length) { chart.dispose(); el.innerHTML = '<div class="hint">暂无分红数据</div>'; return; }
    const vals = data.map(x => x.y).sort((a, b) => a - b);
    const pct = p => vals.length ? vals[Math.floor(p * (vals.length - 1))] : null;
    const q25 = pct(0.25), q75 = pct(0.75), cur = data.length ? data[data.length - 1].y : null;
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
      note.textContent = `当前股息率 ${cur != null ? cur.toFixed(2) : '—'}% · 处于近 ${years||5} 年历史 ${curPct != null ? curPct.toFixed(0) : '—'}% 分位（区间 25%~75%：${q25 != null ? q25.toFixed(2) : '—'}%~${q75 != null ? q75.toFixed(2) : '—'}%；口径：逐年滚动——每年用当年到账分红÷当日价；顶部"当前股息率"为近2财年口径）`;
    }
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
      return `<div class="rhythm-row"><span class="rhythm-year">${y}</span>${ms.map(m => `<span class="rhythm-m">${m}月</span>`).join('')}</div>`;
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
    const getVal = r => ({ final: r.res.final.finalValue, invested: r.res.final.finalInvested, div: r.res.final.totalDiv, lastRepDiv: r.lastRepDiv ? r.lastRepDiv.cash : null, xirr: r.res.final.xirr, dd: -r.maxDD, yield12: r.yield12 })[cmpSort.key];
    const list = cmpSort.key ? [...cmpResults].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * cmpSort.dir;
    }) : cmpResults;
    const arrow = k => (k && cmpSort.key === k) ? (cmpSort.dir > 0 ? ' ▲' : ' ▼') : '';   // v1.8.13 BUG-5：k 非空才显示箭头
    const heads = [['标的', null], ['期末总资产', 'final'], ['累计投入', 'invested'], ['累计分红', 'div'], ['最新报告期分红', 'lastRepDiv'], ['年化(XIRR)', 'xirr'], ['最大回撤', 'dd'], ['股息率(近2财年)', 'yield12'], ['股息率(逐年)', null]];
    $('#cmpTbl').innerHTML = `<table class="tbl cmp-tbl"><tr>${heads.map(h => `<th data-sort="${h[1] || ''}" style="cursor:${h[1] ? 'pointer' : 'default'}">${h[0]}${arrow(h[1])}</th>`).join('')}</tr>` +
      list.map((r, i) => `<tr style="${r.divMissing ? 'opacity:.55' : ''}">
        <td>${i+1}. ${r.it.name}${r.divMissing ? ' <span class="risk-badge">数据暂缺</span>' : ''}<br><span style="color:${r.actualStart ? 'var(--red)' : 'var(--sub)'};font-size:11px">${r.it.code}${r.it.market ? '.' + r.it.market.toUpperCase() : ''} · ${r.actualStart ? '自 ' + r.actualStart + ' 起' + (r.liveYears ? ' 约' + r.liveYears + '年' : '') : ''}</span>
          <details style="margin-top:4px;font-size:11px;color:var(--sub)"><summary style="cursor:pointer;color:#3fbf7f">逐年分红明细 ▾</summary>
            <div style="margin-top:3px;line-height:1.7">${r.divMissing ? '<span style="color:var(--red)">分红数据暂缺（未纳入对比）</span>' : yearsLine(r)}</div>
          </details></td>
        <td>${fmt(r.res.final.finalValue, 0)} 元</td>
        <td>${fmt(r.res.final.finalInvested, 0)} 元</td>   <!-- v1.8.8: 口径与回测页一致（本金+追加+复投），曾只算本金致两边数字对不上 -->
        <td>${r.divMissing ? '<span style="color:var(--red)">数据暂缺</span><br><span style="color:var(--sub);font-size:11px">未纳入对比</span>' : fmt(r.res.final.totalDiv, 0) + ' 元<br><span style="color:var(--sub);font-size:11px">年均 ' + fmt(r.res.final.totalDiv / Math.max(1, (r.res.years || []).length), 0) + ' 元</span>'}</td>
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

  async function cmpResolveCode(v) {
    v = (v || '').trim();
    if (!v) return null;
    // C2：显式后缀 000300.SH / 000001.SZ（指数/股票不靠猜）
    const parsed = DL.parseSecInput(v);
    if (/^\d{6}$/.test(parsed.code)) {
      let name = parsed.code;
      try { name = await DL.fetchName(parsed.code, parsed.market); } catch (e) { }
      return { code: parsed.code, name, market: parsed.market };
    }
    // 名称搜索
    try {
      const d = await DL.jsonp('https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(v) + '&type=14&count=3', 'cb');
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
  }

  function renderCompare() {
    // ETF 快捷 chips
    const ec = $('#cmpEtfChips');
    if (ec) {
      ec.innerHTML = DL.ETF_PRESETS.slice(0, 8).map(p =>
        `<button type="button" class="chip" data-c="${p.code}${p.market ? '.' + p.market.toUpperCase() : ''}">${p.name}</button>`).join('');   // C2: 指数 chip 带 .SH
      ec.querySelectorAll('[data-c]').forEach(b => b.onclick = () => cmpAdd(b.dataset.c));
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
      const snap = homeState.snap || await DL.getStockQuotes([code]);
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
    } catch (e) {
      alert('添加失败：' + e.message);
    }
  }

  /* ---------- 初始化 ---------- */
  window.addEventListener('DOMContentLoaded', () => {
    bindTabs();
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
    const btnScan = $('#btnScan');
    if (btnScan) btnScan.onclick = runScanner;
    const btnDiagBacktest = $('#btnDiagBacktest');
    if (btnDiagBacktest) btnDiagBacktest.onclick = () => { if (diagCode) { const input = $('#code'); if (input) input.value = diagCode; const bd = $('#buyDate'); if (bd) bd.value = new Date(Date.now() - 5 * 366 * 86400000).toISOString().slice(0, 10); switchTab('backtest'); $('#btnRun').click(); } };
    switchTab('home');
  });
})();
// v1.8.13 BUG-3：views.js 就绪标志（index.html 自动运行等此标志，不再等 window load——load 依赖 echarts CDN 速度）
window.__viewsReady = true;
(window.__viewsReadyCallbacks || []).forEach(function (f) { try { f(); } catch (e) { } });
