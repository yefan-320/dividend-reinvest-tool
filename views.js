/* ============================================================
 * views.js — 红利工具视图层 v1.7.0
 * 四 tab 导航：决策台 / 诊断 / 对比 / 回测（回测逻辑在 index.html 内，不动）
 * 决策台：搜索 + 机会速览 + 自选卡片 + 除息日历 + 扫描入口
 * 诊断页：股息率带状图 + 关键数据(股息覆盖率/估值/回撤) + 分红节奏
 * 对比页：第二批占位
 * 数据全部走 window.DL（data-layer.js）
 * ============================================================ */
'use strict';
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
        <div class="wl-head"><b>${it.name}</b><span class="wl-code">${it.code}</span>
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
        etfNoteEl.textContent = isEtf ? '⚠️ ETF/指数分红不连续（通常一年一次），且分红数据源限制（基金分红接口暂未接入），累计分红可能显示 0——非该基金不分红，请以年化股息率看分红能力' : '';
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
      $('#btnDiagBacktest').onclick = () => {
        const input = $('#code'); if (input) input.value = code;
        const bd = $('#buyDate'); if (bd) bd.value = new Date(Date.now() - 5 * 366 * 86400000).toISOString().slice(0, 10);
        $('#btnRun').click();
      };
    } catch (e) {
      $('#diagStats').innerHTML = `<div class="hint err">诊断失败：${e.message}</div>`;
    }
  }

  /* 股息率带状图：每年每股分红 ÷ 当年均价 → 分位带（简化：最近分红 ÷ 历史价格序列 = 滚动股息率带） */
  let _yieldChart = null;
  function renderYieldBand(divs, kline, years) {
    const el = $('#diagYieldChart');
    if (!el || typeof echarts === 'undefined') return;
    if (_yieldChart) { _yieldChart.dispose(); _yieldChart = null; }   // 防重复 init（多次诊断同一只）
    const chart = _yieldChart = echarts.init(el);
    const dates = Object.keys(kline).sort();
    if (!dates.length || !divs.length) { chart.dispose(); el.innerHTML = '<div class="hint">数据不足</div>'; return; }
    // 用最新年度每股分红（避免多年期送转复杂化，第一版用最近完整年度 dps）
    const latest = divs[0];
    const dps = latest ? latest.dps : 0;
    if (!dps) { chart.dispose(); el.innerHTML = '<div class="hint">暂无分红数据</div>'; return; }
    const data = dates.map(d => ({ d, y: (dps / kline[d]) * 100 }));
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
    if (note) note.textContent = `当前股息率 ${cur != null ? cur.toFixed(2) : '—'}% · ${years||5}年区间 25%~75% 分位：${q25 != null ? q25.toFixed(2) : '—'}%~${q75 != null ? q75.toFixed(2) : '—'}%（口径：最新年度每股分红÷历史价，送转未调）`;
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

  /* ---------- 对比页占位（第二批） ---------- */
  /* ================= 对比页（v1.7.2 大师 P1-26/27/28 落地） ================= */
  const cmpState = { list: [], years: 5 };   // list: [{code,name}]
  let cmpCharts = {};

  function cmpEnsureChart(id) {
    if (cmpCharts[id]) { cmpCharts[id].dispose(); }
    const el = $(id);
    cmpCharts[id] = echarts.init(el);
    return cmpCharts[id];
  }

  async function cmpResolveCode(v) {
    v = (v || '').trim();
    if (!v) return null;
    if (/^\d{6}$/.test(v)) {
      let name = v;
      try { name = await DL.fetchName(v); } catch (e) { }
      return { code: v, name };
    }
    // 名称搜索
    try {
      const d = await DL.jsonp('https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(v) + '&type=14&count=3', 'cb');
      const list = d && d.QuotationCodeTable && d.QuotationCodeTable.Data || [];
      if (list.length) return { code: list[0].Code, name: list[0].Name };
    } catch (e) { }
    return null;
  }

  function cmpRenderList() {
    const el = $('#cmpList');
    if (!el) return;
    if (!cmpState.list.length) { el.innerHTML = '<div class="hint">还没有标的。输入代码/名称添加，或点下方 ETF 快捷。</div>'; return; }
    el.innerHTML = '<div class="wl-main">' + cmpState.list.map((it, i) =>
      `<div class="wl-card" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px">
         <span>${i+1}. ${it.name} <b style="color:var(--sub)">${it.code}</b></span>
         <button class="chip" data-del="${i}" style="background:rgba(224,102,102,.15);color:var(--red)">✕</button>
       </div>`).join('') + '</div>';
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      cmpState.list.splice(+b.dataset.del, 1);
      cmpRenderList();
    });
  }

  async function cmpAdd(v) {
    const it = await cmpResolveCode(v);
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
    // v1.7.3：月供可调（默认 0=零月供）；所有标的同月供，保证口径一致
    const monthly = Math.max(0, parseFloat($('#cmpMonthly').value) || 0);
    const strictSameStart = !!$('#cmpStrict') && $('#cmpStrict').checked;   // v1.7.4 P3：严格同期可切换（默认 B：按实际上市日起算）
    const start = new Date(Date.now() - y * 366 * 86400000).toISOString().slice(0, 10);
    const end = DL.todayStr();
    const status = $('#status');
    if (status) { status.textContent = '对比中：拉取 ' + cmpState.list.length + ' 个标的 K线/分红…'; status.className = 'status'; }
    const results = [];
    const errors = [];
    const skipped = [];
    for (const it of cmpState.list) {
      try {
        const kline = await DL.getKline(it.code, start, end);
        const dates = Object.keys(kline).sort();
        // v1.7.4 P3 方案B：默认按实际上市日起算（不足周期不跳过），严格同期时保留旧逻辑
        if (!dates.length) {
          errors.push(`「${it.name}(${it.code})」无行情数据——已跳过`);
          continue;
        }
        if (strictSameStart && dates[0] > start) {
          skipped.push(`「${it.name}(${it.code})」${y}年前（${start}）尚无数据，最早 ${dates[0]}——已跳过（严格同期）`);
          continue;
        }
        const actualStart = dates[0] > start ? dates[0] : start;   // 实际起算日（上市日晚于所选周期起点）
        const divs = await DL.fetchDividendsOne(it.code);
        const res = simulate(1000000, actualStart, true, kline, divs, monthly);   // 同参数：100万/复投/同月供
        // 最大回撤 + 股息率（v1.7.4 P7：改用按报告期归组的年化股息率，替代365天窗口）
        let maxDD = 0, peak = -Infinity;
        res.daily.forEach(x => { if (x.value > peak) peak = x.value; const dd = (peak - x.value) / peak; if (dd > maxDD) maxDD = dd; });
        const snap = homeState.snap || await DL.getStockQuotes([it.code]);
        homeState.snap = snap;
        const s = snap[it.code] || {};
        const lastPrice = s.price || res.final.lastClose;
        const dy = DL.calcAnnualDivYield(divs, lastPrice);
        const liveYears = (dates[0] > start) ? Math.round((new Date(end) - new Date(dates[0])) / (365.25 * 86400000) * 10) / 10 : null;
        results.push({ it, res, maxDD, yield12: dy ? dy.yieldPct : null, yieldYears: dy ? dy.years : null, actualStart: dates[0] > start ? dates[0] : null, liveYears });
      } catch (e) {
        errors.push(`「${it.name}(${it.code})」数据获取失败：${e.message}——已跳过`);
      }
    }
    if (status) status.textContent = '';
    if (!results.length) { el.style.display = 'block'; $('#cmpTbl').innerHTML = '<div class="hint err">全部失败</div>'; $('#cmpNote').textContent = errors.join('；'); return; }
    if (errors.length || skipped.length) {
      const note = $('#cmpNote'); if (note) note.textContent = '⚠️ ' + [...skipped, ...errors].join('；');
    }
    // P3：不足周期标的存在时，顶部 toast 级提示（升级强度，非表格角落小字）
    const shortOnes = results.filter(r => r.actualStart);
    if (shortOnes.length) {
      const st = $('#status');
      if (st) { st.textContent = 'ℹ️ ' + shortOnes.map(r => `${r.it.name} 自 ${r.actualStart} 起算（实际存续约 ${r.liveYears} 年）`).join('；') + '（所选 ' + y + ' 年，上市不足）'; st.className = 'status'; }
    }
    // 总资产走势图（P1-26：对比图只画总资产+股息率；累计分红只进表格；v1.7.4 P2：5色提亮+线型双通道+图例12px+点标记）
    const ch1 = cmpEnsureChart('cmpChartAsset');
    const allDates = results[0].res.daily.map(x => x.date);
    const CMP_COLORS = ['#f2c94c', '#5aa9e6', '#3fbf7f', '#c46ae0', '#e06666'];   // 金(提亮)/蓝/青/紫/红
    const CMP_DASH = [false, true, false, true, false];   // 线型双通道：色弱用户也能分辨
    ch1.setOption({
      backgroundColor: 'transparent', tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis' }),
      legend: { textStyle: { color: '#8fa69c', fontSize: 12 }, top: 0, type: 'scroll', itemWidth: 28, itemHeight: 14 },
      grid: { left: 54, right: 14, top: 34, bottom: 24 },
      xAxis: Object.assign({ type: 'category', data: allDates }, AXIS),
      yAxis: axY({ scale: true, axisLabel: { formatter: v => v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v } }),
      series: results.map((r, i) => ({
        name: r.it.name, type: 'line', showSymbol: true, symbol: i % 2 ? 'circle' : 'diamond', symbolSize: 4,
        data: r.res.daily.map(x => Math.round(x.value)),
        lineStyle: { width: 2.5, color: CMP_COLORS[i % 5], type: CMP_DASH[i % 5] ? 'dashed' : 'solid' },
        itemStyle: { color: CMP_COLORS[i % 5] },
      })),
    });
    // 股息率对比图（柱状，口径统一：年化股息率=近2报告年度平均÷现价，v1.7.4 P7）
    const ch2 = cmpEnsureChart('cmpChartYield');
    ch2.setOption({
      backgroundColor: 'transparent', tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis' }),
      grid: { left: 54, right: 14, top: 20, bottom: 24 },
      xAxis: Object.assign({ type: 'category', data: results.map(r => r.it.name) }, AXIS),
      yAxis: axY({ axisLabel: { formatter: v => v + '%' } }),
      series: [{ name: '年化股息率(近2财年)', type: 'bar', barMaxWidth: 40,
        data: results.map(r => r.yield12 != null ? +r.yield12.toFixed(2) : null),
        itemStyle: { color: '#f2c94c', borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: '#f2c94c', fontSize: 10, formatter: p => p.value != null ? p.value + '%' : '—' } }],
    });
    // 表格（P1-26：累计分红只进表格；v1.7.3 月供列；v1.7.4 P3 存续标注/P5 首列 sticky/P6 口径文案/N2 税前）
    const f = results[0].res.final;
    $('#cmpTbl').innerHTML = `<table class="tbl cmp-tbl"><tr><th>标的</th><th>期末总资产</th><th>累计投入</th><th>累计分红</th><th>年化(XIRR)</th><th>最大回撤</th><th>年化股息率(近2财年)</th></tr>` +
      results.map((r, i) => `<tr>
        <td>${i+1}. ${r.it.name}<br><span style="color:var(--sub);font-size:11px">${r.it.code}${r.actualStart ? ' · 自 ' + r.actualStart + ' 起' : ''}</span></td>
        <td>${fmt(r.res.final.finalValue, 0)} 元</td>
        <td>${fmt(r.res.principal + (r.res.final.monthlyTotal || 0), 0)} 元</td>
        <td>${fmt(r.res.final.totalDiv, 0)} 元</td>
        <td class="${r.res.final.xirr != null && r.res.final.xirr >= 0 ? 'green' : 'red'}">${r.res.final.xirr != null ? fmtPct(r.res.final.xirr) : '—'}</td>
        <td class="red">${fmtPct(-r.maxDD)}</td>
        <td>${r.yield12 != null ? r.yield12.toFixed(2) + '%' : '—'}</td>
      </tr>`).join('') + '</table>';
    $('#cmpNote').textContent = (monthly > 0 ? '月供 ' + fmt(monthly, 0) + ' 元/月（所有标的同月供，每月首个交易日追加，首月不追加）' : '零月供（口径统一）') + (results.some(r => /ETF|指数|红利/.test(r.it.name)) ? '｜⚠️ ETF/指数：分红不连续（通常一年一次），且分红数据源限制（基金接口未接入），累计分红可能显示 0，请以年化股息率看分红能力' : '') + '｜股息率口径：近2报告年度平均÷现价(税前)';
    el.style.display = 'block';
    // URL 记忆（P2-27：版本号进分享参数；v1.7.3 月供进 m；v1.7.4 严格同期进 s）
    const q = new URLSearchParams(location.search);
    q.set('cmp', cmpState.list.map(x => x.code).join(','));
    q.set('y', y);
    q.set('m', monthly);
    q.set('s', strictSameStart ? '1' : '0');
    q.set('v', APP_VERSION);
    history.replaceState(null, '', location.pathname + '?' + q.toString());
  }

  function renderCompare() {
    // ETF 快捷 chips
    const ec = $('#cmpEtfChips');
    if (ec) {
      ec.innerHTML = DL.ETF_PRESETS.slice(0, 8).map(p =>
        `<button type="button" class="chip" data-c="${p.code}">${p.name}</button>`).join('');
      ec.querySelectorAll('[data-c]').forEach(b => b.onclick = () => cmpAdd(b.dataset.c));
    }
    // 周期 chips + 自定义输入联动（P1-28：两者并存，同一状态）
    const cy = $('#cmpYears');
    if (cy) {
      cy.querySelectorAll('button').forEach(b => b.onclick = () => {
        cmpState.years = +b.dataset.y;
        cy.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        const ci = $('#cmpCustom'); if (ci) ci.value = '';
      });
      const ci = $('#cmpCustom');
      if (ci) ci.addEventListener('change', () => {
        const v = parseInt(ci.value, 10);
        if (v && v >= 1 && v <= 30) {
          cmpState.years = v;
          cy.querySelectorAll('button').forEach(x => x.classList.toggle('on', false));
        }
      });
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
    const s = params.get('s');
    if (s === '1' || s === '0') {
      const sc = $('#cmpStrict');
      if (sc) sc.checked = (s === '1');
    }
    const y = parseInt(params.get('y'), 10);
    if (y && y >= 1 && y <= 30) {
      cmpState.years = y;
      const cy2 = $('#cmpYears');
      if (cy2) cy2.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.y === y));
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
    if (btnDiagBacktest) btnDiagBacktest.onclick = () => { if (diagCode) { const input = $('#code'); if (input) input.value = diagCode; switchTab('backtest'); $('#btnRun').click(); } };
    switchTab('home');
  });
})();
