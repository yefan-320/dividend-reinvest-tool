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
      el.innerHTML = '<div class="hint">⏳ 合并计算中…</div>';
      const rows = [];
      for (const d of divs) {
        const s = snap[d.code];
        if (!s || !s.price) continue;
        if (DL.CALIB.THRESHOLDS.excludeST && (d.name || s.name || '').includes('ST')) continue;
        if (s.marketCap && s.marketCap < DL.CALIB.THRESHOLDS.marketCap) continue;
        const yieldPct = (d.dps / s.price) * 100;
        if (yieldPct < DL.CALIB.THRESHOLDS.divYield) continue;
        rows.push({ code: d.code, name: d.name || s.name, price: s.price, yieldPct, marketCap: s.marketCap, pe: s.pe, pb: s.pb, industry: s.industry, div: d });
      }
      rows.sort((a, b) => b.yieldPct - a.yieldPct);
      await DL.cacheSet('scan:last', { ts: Date.now(), data: rows.slice(0, 20).map(r => ({ code: r.code, name: r.name })) });
      el.innerHTML = `<div class="hint">✅ 筛选出 ${rows.length} 只（股息率≥${DL.CALIB.THRESHOLDS.divYield}%、市值≥50亿、排除ST；⚠️=亏损仍分红，可持续性风险请自行判断）</div>` +
        rows.slice(0, 50).map(r => `<div class="scan-row" data-code="${r.code}">
          <b>${r.name}</b> <span class="wl-code">${r.code}</span>
          <span class="gold">${r.yieldPct.toFixed(2)}%</span>
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
      $('#diagTitle').textContent = '🔬 ' + (name === code ? '' : name + ' ') + code;
      const [divs, kline] = await Promise.all([
        DL.fetchDividendsOne(code),
        DL.getKline(code, new Date(Date.now() - diagYears * 366 * 86400000).toISOString().slice(0, 10), DL.todayStr()),
      ]);
      const snap = homeState.snap || await DL.getStockQuotes([code]);
      homeState.snap = snap;
      const s = snap[code] || {};
      const lastPrice = s.price || (kline && Object.values(kline).pop());
      // 近12月已宣告分红
      const from = new Date(Date.now() - DL.CALIB.DIVIDEND_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
      const recent = divs.filter(d => (d.ex || d.notice) >= from && (d.ex || d.notice) <= DL.todayStr() || (d.ex >= from && d.ex <= DL.todayStr()));
      const recentDivs = divs.filter(d => d.ex >= from && d.ex <= DL.todayStr() && !d.pending);
      const dps = recentDivs.reduce((s2, d) => s2 + d.dps, 0);
      const divYield = lastPrice ? (dps / lastPrice) * 100 : null;
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
        <div class="stat"><div class="k">每股分红(近12月)</div><div class="v">${fmt(dps, 3)} 元</div></div>
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
      const d = await DL.jsonp('https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(v) + '&type=14&count=3', 'callback');
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
    const start = new Date(Date.now() - y * 366 * 86400000).toISOString().slice(0, 10);
    const end = DL.todayStr();
    const status = $('#status');
    if (status) { status.textContent = '对比中：拉取 ' + cmpState.list.length + ' 个标的 K线/分红…'; status.className = 'status'; }
    const results = [];
    const errors = [];
    for (const it of cmpState.list) {
      try {
        const kline = await DL.getKline(it.code, start, end);
        const dates = Object.keys(kline).sort();
        // P1-27：区间起点不在 K 线范围内 → 拒绝 + 提示（对比必须同起点才有意义）
        if (!dates.length || dates[0] > start) {
          errors.push(`「${it.name}(${it.code})」${y}年前（${start}）尚无数据${dates.length ? '，最早 ' + dates[0] : ''}——已跳过（对比需同起点）`);
          continue;
        }
        const divs = await DL.fetchDividendsOne(it.code);
        const res = simulate(1000000, start, true, kline, divs, 0);   // 同参数：100万/复投/零月供
        // 最大回撤 + 股息率
        let maxDD = 0, peak = -Infinity;
        res.daily.forEach(x => { if (x.value > peak) peak = x.value; const dd = (peak - x.value) / peak; if (dd > maxDD) maxDD = dd; });
        const snap = homeState.snap || await DL.getStockQuotes([it.code]);
        homeState.snap = snap;
        const s = snap[it.code] || {};
        const lastPrice = s.price || res.final.lastClose;
        const from12 = new Date(Date.now() - DL.CALIB.DIVIDEND_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
        const dps12 = divs.filter(d => d.ex >= from12 && d.ex <= end && !d.pending).reduce((a, d) => a + d.dps, 0);
        results.push({ it, res, maxDD, yield12: lastPrice ? dps12 / lastPrice * 100 : null });
      } catch (e) {
        errors.push(`「${it.name}(${it.code})」数据获取失败：${e.message}——已跳过`);
      }
    }
    if (status) status.textContent = '';
    if (!results.length) { el.style.display = 'block'; $('#cmpTbl').innerHTML = '<div class="hint err">全部失败</div>'; $('#cmpNote').textContent = errors.join('；'); return; }
    if (errors.length) {
      const note = $('#cmpNote'); if (note) note.textContent = '⚠️ ' + errors.join('；');
    }
    // 总资产走势图（P1-26：对比图只画总资产+股息率；累计分红只进表格）
    const ch1 = cmpEnsureChart('cmpChartAsset');
    const allDates = results[0].res.daily.map(x => x.date);
    ch1.setOption({
      backgroundColor: 'transparent', tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis' }),
      legend: { textStyle: { color: '#8fa69c', fontSize: 10 }, top: 0, type: 'scroll' },
      grid: { left: 54, right: 14, top: 30, bottom: 24 },
      xAxis: Object.assign({ type: 'category', data: allDates }, AXIS),
      yAxis: axY({ scale: true, axisLabel: { formatter: v => v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v } }),
      series: results.map((r, i) => ({
        name: r.it.name, type: 'line', showSymbol: false,
        data: r.res.daily.map(x => Math.round(x.value)),
        lineStyle: { width: 2, color: ['#d9a441', '#5aa9e6', '#3fbf7f', '#c46ae0', '#e06a6a'][i % 5] },
      })),
    });
    // 股息率对比图（柱状，口径统一：近12月分红÷现价）
    const ch2 = cmpEnsureChart('cmpChartYield');
    ch2.setOption({
      backgroundColor: 'transparent', tooltip: Object.assign({}, TOOLTIP, { trigger: 'axis' }),
      grid: { left: 54, right: 14, top: 20, bottom: 24 },
      xAxis: Object.assign({ type: 'category', data: results.map(r => r.it.name) }, AXIS),
      yAxis: axY({ axisLabel: { formatter: v => v + '%' } }),
      series: [{ name: '股息率(近12月)', type: 'bar', barMaxWidth: 40,
        data: results.map(r => r.yield12 != null ? +r.yield12.toFixed(2) : null),
        itemStyle: { color: '#d9a441', borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: 'top', color: '#d9a441', fontSize: 10, formatter: p => p.value != null ? p.value + '%' : '—' } }],
    });
    // 表格（P1-26：累计分红只进表格，注明 ETF 分红频率低）
    const f = results[0].res.final;
    $('#cmpTbl').innerHTML = `<table class="tbl"><tr><th>标的</th><th>期末总资产</th><th>累计分红</th><th>年化(XIRR)</th><th>最大回撤</th><th>股息率(近12月)</th></tr>` +
      results.map((r, i) => `<tr>
        <td>${i+1}. ${r.it.name}<br><span style="color:var(--sub);font-size:11px">${r.it.code}</span></td>
        <td>${fmt(r.res.final.finalValue, 0)} 元</td>
        <td>${fmt(r.res.final.totalDiv, 0)} 元</td>
        <td class="${r.res.final.xirr != null && r.res.final.xirr >= 0 ? 'green' : 'red'}">${r.res.final.xirr != null ? fmtPct(r.res.final.xirr) : '—'}</td>
        <td class="red">${fmtPct(-r.maxDD)}</td>
        <td>${r.yield12 != null ? r.yield12.toFixed(2) + '%' : '—'}</td>
      </tr>`).join('') + '</table>';
    $('#cmpNote').textContent = ($('#cmpNote').textContent || '') + (results.some(r => /ETF|指数|红利/.test(r.it.name)) ? '｜注：ETF/指数分红频率低（通常一年一次），累计分红与股票不可直接比，请以股息率看分红能力' : '');
    el.style.display = 'block';
    // URL 记忆（P2-27：版本号进分享参数）
    const q = new URLSearchParams(location.search);
    q.set('cmp', cmpState.list.map(x => x.code).join(','));
    q.set('y', y);
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
    // URL 恢复（?cmp=512890,600036&y=5&v=...）
    const params = new URLSearchParams(location.search);
    const cmp = params.get('cmp');
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
        const from = new Date(Date.now() - DL.CALIB.DIVIDEND_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
        const dps = divs.filter(d => d.ex >= from && d.ex <= DL.todayStr() && !d.pending).reduce((a, d) => a + d.dps, 0);
        if (price) divYield = (dps / price) * 100;
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
              const d = await DL.jsonp('https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(v) + '&type=14&count=3', 'callback');
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
