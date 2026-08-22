/* ============================================================
 * views-compare.js — views.js 拆分模块 对比页+参数中心+同步包+术语表
 * 生成：scripts/split-views.py（v3.10+ 接手 AI）
 * 加载顺序：views-core → views-home → views-diag → views-compare → views-pfbt
 * 全局作用域共享（去 IIFE），勿在此文件内重复声明 DL/$/fmt
 * ============================================================ */
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
  /* v3.9.0 对比裁判：🏆结论条 + 风险-收益散点图（右上=高收益低回撤=最优） */
  function renderCmpVerdict(results) {
    const vd = $('#cmpVerdict'), sc = $('#cmpScatterCard');
    if (!vd || !results || !results.length) return;
    const valid = results.filter(r => !r.divMissing && r.res && r.res.final);
    if (!valid.length) { vd.style.display = 'none'; sc.style.display = 'none'; return; }
    /* 分项冠军 */
    const byXirr = valid.slice().sort((a, b) => (b.res.final.xirr || -9) - (a.res.final.xirr || -9))[0];
    const byDD = valid.slice().sort((a, b) => (a.maxDD || 0) - (b.maxDD || 0))[0];
    const byDiv = valid.slice().sort((a, b) => (b.res.final.totalDiv || 0) - (a.res.final.totalDiv || 0))[0];
    /* 综合最优：XIRR 归一 + 回撤反向归一，各 50% */
    const xirrs = valid.map(r => r.res.final.xirr || 0);
    const dds = valid.map(r => r.maxDD || 0);
    const xMax = Math.max.apply(null, xirrs) || 1, dMax = Math.max.apply(null, dds) || 1;
    let best = null, bestScore = -Infinity;
    valid.forEach(r => {
      const s1 = xMax > 0 ? ((r.res.final.xirr || 0) / xMax) : 0;
      const s2 = dMax > 0 ? (1 - (r.maxDD || 0) / dMax) : 0.5;
      const score = s1 * 0.6 + s2 * 0.4;
      if (score > bestScore) { bestScore = score; best = r; }
    });
    const chip = (label, r) => `<span style="font-size:12px;margin-right:10px">${label}=<b style="color:var(--gold)">${r.it.name}</b></span>`;
    vd.innerHTML = `<span style="font-weight:700;color:var(--gold);margin-right:6px">⚖️ 裁判结论</span>${chip('🏆 收益最高', byXirr)}${chip('🛡 回撤最小', byDD)}${chip('💰 分红最多', byDiv)}${best ? chip('⭐ 综合最优', best) : ''}<span style="font-size:10px;color:var(--muted)">综合=年化60%+回撤40%加权（非投资建议）</span>`;
    vd.style.display = 'block';
    /* 散点图 */
    if (typeof echarts !== 'undefined' && valid.length >= 2) {
      const ch = echarts.init($('#cmpScatter'));
      ch.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => `<b>${p.data[4]}</b><br/>年化 ${p.data[0].toFixed(1)}% · 最大回撤 ${p.data[1].toFixed(0)}%` },
        grid: { left: 50, right: 24, top: 20, bottom: 34 },
        xAxis: { type: 'value', name: '年化收益% →', nameTextStyle: { color: '#8fa69c', fontSize: 9 }, axisLabel: { color: '#8fa69c', fontSize: 9 }, splitLine: { lineStyle: { color: '#22322c' } } },
        yAxis: { type: 'value', name: '最大回撤%（负）', nameTextStyle: { color: '#8fa69c', fontSize: 9 }, axisLabel: { color: '#8fa69c', fontSize: 9, formatter: v => v.toFixed(0) + '%' }, splitLine: { lineStyle: { color: '#22322c' } } },
        series: [{
          type: 'scatter', symbolSize: 34,
          data: valid.map(r => ({
            value: [+((r.res.final.xirr || 0) * 100).toFixed(1), +(-(r.maxDD || 0) * 100).toFixed(0), r.it.name],
            itemStyle: { color: r === best ? '#d9a441' : '#5aa9e6' },
          })),
          label: { show: true, formatter: p => p.data[2], position: 'top', color: '#e8efe9', fontSize: 10 },
          markLine: { silent: true, symbol: 'none', lineStyle: { color: 'rgba(217,164,65,.4)', type: 'dashed' }, data: [{ xAxis: (xMax * 100).toFixed(1) * 0.8 }] },
        }],
      });
      ch.on('click', p => { if (p.data && p.data[2]) { try { openDiagnose(p.data[2]); } catch (e) {} } });
      sc.style.display = 'block';
    } else { sc.style.display = 'none'; }
  }

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
    /* v3.9.0 对比裁判（接手 AI）：结论条 + 风险-收益散点图——一眼选出综合最优 */
    try { renderCmpVerdict(results); } catch (e) {}
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
    /* v3.8.0 术语全覆盖（接手 AI，D13/V2-2）：高频词补录，触屏点击 ⓘ 弹解释（T2 三端适配） */
    '覆盖率': '分红占利润的比例（支付率）：近2财年分红合计 ÷ 对应2年EPS。越高=分红越慷慨，但 >90% 有"吃老本"风险',
    '支付率': '同"覆盖率"：分红占利润的比例，全站已统一称呼',
    '储备年数': '每股未分配利润 ÷ 每股分红：按当前分红水平还能分几年（家底厚度）',
    '除息日': '分红"到账扣价"的日期：这天股价会扣除分红金额，账户收到现金分红',
    '权益登记日': '在这天收盘前持有股票的人，才有资格拿本次分红',
    '到账年': '分红实际到账的年份（与报告期年份可能差一年，如 2024 年报分红 2025 年到账）',
    '报告期年': '分红归属的会计年度（如 2025 年报=2025 报告期，即使 2026 年才到账）',
    '复投': '分红再投资：分红现金按除息日收盘价自动买入股票，钱生钱（复利）',
    '现金池': '零钱池：不足 100 股（一手）的分红/零钱先存着，够一手再买入',
    '整手': 'A股最小交易单位 100 股：买入必须是 100 股的整数倍',
    '碎股': '不足一手的零散股数（送转可能产生），只能卖不能买',
    '分红CAGR': '分红复合年均增速：过去几年分红每年平均涨多少（几何平均）',
    '买点线': '买入触发线：股息率到达该线说明"便宜到值得买"（分位 P75/P90/P95 对应小仓/加仓/重仓）',
    '低估一档': '小仓买点：股息率达到历史 P75 分位线（首次可以买一点试试）',
    '低估二档': '加仓买点：股息率达到历史 P90 分位线（更便宜，可以多加）',
    '深度低估': '重仓买点：股息率达到历史 P95 分位线（历史级便宜，可重仓）',
    '分位窗口': '计算"便宜度"时回看的天数：W375=看最近 375 个交易日（约 1.5 年）',
    '卖出信号': '基本面恶化的预警：EPS/分红连续下滑、毛利率连降等（纪律参考，非自动卖出）',
    '高估保险丝': '极端高估熔断：分位<5 且 股息率<2.2% 时提示"可能是泡沫顶"（历史罕见，防卖飞）',
    '分红陷阱': '分红连续 2 年下降的高股息股：看起来股息高，其实分红在缩水（价值毁灭型）',
    '事件层': '特殊股票（如伊利/平安）：历史数据测不准，工具只监控财报不给自动买卖信号',
    '冷却期': '买入触发后 60 个交易日不再重复触发：防止追涨杀跌频繁交易',
    '智慧定投': '按月分位自动调节投入：便宜（分位<30）加倍投，贵（分位>70）减半投',
    '月追加': '每月固定追加投入的金额（每月首个交易日投入）',
    '严格同期': '对比时所有标的用同一个买入日：不足周期的标的直接跳过（防"上市早占便宜"）',
    '税前/税后': '红利税：持有超 1 年免 10% 税；1 个月~1 年 10%；不足 1 个月 20%',
    '回本进度': '累计分红 ÷ 初始本金：分红拿回本金的百分比（100%=靠分红回本了）',
    '行业超限': '同一行业持仓超过 3 只：组合集中度风险提示，触发后该股建议强度减半',
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
  /* ===== v3.8.0 三端数据同步包（接手 AI，方案 T/6.3-A）：手机/iPad/电脑同一份数据 =====
   * 导出 JSON → iCloud Drive/文件 App → 另一台设备导入合并（按记录级 updatedAt 智能合并，非覆盖）
   * 数据不出机器（无后端）；本地旧数据无 updatedAt 字段时视为旧格式，以导入为准 */
  function collectSyncData() {
    const now = Date.now();
    let wl = [], holds = [], decisions = [];
    try { wl = (JSON.parse(localStorage.getItem('divtool_watchlist_v1') || '[]')).map(w => ({ ...w, updatedAt: w.updatedAt || w.addedAt || now })); } catch (e) {}
    try { holds = loadHoldings().map(h => ({ ...h, updatedAt: h.updatedAt || now })); } catch (e) {}
    try { decisions = decLog(); } catch (e) {}
    const combos = DL.loadCombos();
    const params = {};
    PARAMS.forEach(p => { try { const v = localStorage.getItem(paramKey(p.key)); if (v != null) params[p.key] = v; } catch (e) {} });
    const misc = {};
    ['divtool_div_target', 'divtool_monthly_exp', 'divtool_add_amt', 'divtool_zone_mode'].forEach(k => { try { const v = localStorage.getItem(k); if (v != null) misc[k] = v; } catch (e) {} });
    return { watchlist: wl, holdings: holds, combos, decisions, params, misc };
  }
  function exportSyncPackage() {
    try {
      const data = {
        app: 'dividend-tool-sync', v: 1,
        device: /iPhone/.test(navigator.userAgent) ? 'iPhone' : (/iPad/.test(navigator.userAgent) ? 'iPad' : '电脑'),
        exportedAt: new Date().toISOString(),
        data: collectSyncData(),
      };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
      a.download = '红利工具同步-' + DL.todayStr() + '.json';
      a.click();
      try { localStorage.setItem('divtool_last_export', String(Date.now())); } catch (e) {}
      try { toast('📤 同步包已导出——用 iCloud/文件传到另一台设备，再点「导入合并」'); } catch (e) {}
    } catch (e) { try { toast('导出失败：' + e.message); } catch (e2) {} }
  }
  /* 合并预览：返回 { wlAdd, wlUpd, hAdd, hUpd, cAdd, cUpd, dAdd } 计数 */
  function mergePreview(pkg) {
    const d = (pkg && pkg.data) || {};
    const now = Date.now();
    const out = { wlAdd: 0, wlUpd: 0, hAdd: 0, hUpd: 0, cAdd: 0, cUpd: 0, dAdd: 0 };
    try {
      const curWl = new Map((JSON.parse(localStorage.getItem('divtool_watchlist_v1') || '[]')).map(w => [w.code, w]));
      (d.watchlist || []).forEach(w => { const cur = curWl.get(w.code); if (!cur) out.wlAdd++; else if ((w.updatedAt || 0) > (cur.updatedAt || cur.addedAt || 0)) out.wlUpd++; });
    } catch (e) {}
    try {
      const curH = new Map(loadHoldings().map(h => [h.code, h]));
      (d.holdings || []).forEach(h => { const cur = curH.get(h.code); if (!cur) out.hAdd++; else if ((h.updatedAt || 0) > (cur.updatedAt || 0)) out.hUpd++; });
    } catch (e) {}
    try {
      const curC = new Map((DL.loadCombos().combos || []).map(c => [c.id, c]));
      (d.combos && d.combos.combos || []).forEach(c => { const cur = curC.get(c.id); if (!cur) out.cAdd++; else if ((c.savedAt || 0) > (cur.savedAt || 0)) out.cUpd++; });
    } catch (e) {}
    try { out.dAdd = (d.decisions || []).filter(x => !decLog().some(y => y.ts === x.ts)).length; } catch (e) {}
    return out;
  }
  function applySyncPackage(pkg) {
    const d = (pkg && pkg.data) || {};
    const now = Date.now();
    try {   // watchlist 合并（同 code 取 updatedAt 新者）
      const cur = new Map((JSON.parse(localStorage.getItem('divtool_watchlist_v1') || '[]')).map(w => [w.code, w]));
      (d.watchlist || []).forEach(w => {
        const old = cur.get(w.code);
        if (!old || (w.updatedAt || 0) > (old.updatedAt || old.addedAt || 0)) cur.set(w.code, { ...w, updatedAt: w.updatedAt || now });
      });
      localStorage.setItem('divtool_watchlist_v1', JSON.stringify([...cur.values()]));
    } catch (e) {}
    try {   // holdings 合并
      const cur = new Map(loadHoldings().map(h => [h.code, h]));
      (d.holdings || []).forEach(h => { const old = cur.get(h.code); if (!old || (h.updatedAt || 0) > (old.updatedAt || 0)) cur.set(h.code, { ...h, updatedAt: h.updatedAt || now }); });
      saveHoldings([...cur.values()]);
    } catch (e) {}
    try {   // combos 合并（同 id 取 savedAt 新者）
      const c2 = DL.loadCombos();
      const cur = new Map((c2.combos || []).map(c => [c.id, c]));
      (d.combos && d.combos.combos || []).forEach(c => { const old = cur.get(c.id); if (!old || (c.savedAt || 0) > (old.savedAt || 0)) cur.set(c.id, c); });
      c2.combos = [...cur.values()];
      if (d.combos && d.combos.activeId) c2.activeId = d.combos.activeId;
      DL.saveCombos(c2);
    } catch (e) {}
    try {   // 决策日志合并（按 ts 去重，导入并入）
      const cur = decLog();
      const seen = new Set(cur.map(x => x.ts));
      (d.decisions || []).forEach(x => { if (!seen.has(x.ts)) { cur.push(x); seen.add(x.ts); } });
      localStorage.setItem('divtool_decisions_v1', JSON.stringify(cur.slice(0, 200)));
    } catch (e) {}
    try {   // 参数 + 杂项：导入覆盖（另一台设备的配置视为最新）
      Object.keys(d.params || {}).forEach(k => { try { localStorage.setItem(paramKey(k), d.params[k]); } catch (e) {} });
      Object.keys(d.misc || {}).forEach(k => { try { localStorage.setItem(k, d.misc[k]); } catch (e) {} });
    } catch (e) {}
    try { localStorage.setItem('divtool_last_import', String(Date.now())); } catch (e) {}
  }
  function installSyncUI() {
    const el = document.getElementById('paramPanel');
    if (!el) return;
    const box = document.getElementById('syncBox');
    if (!box) return;
    const btnEx = document.getElementById('syncExport');
    if (btnEx && !btnEx.dataset.bound) { btnEx.dataset.bound = '1'; btnEx.onclick = exportSyncPackage; }
    const btnIm = document.getElementById('syncImport');
    const file = document.getElementById('syncFile');
    if (btnIm && !btnIm.dataset.bound) { btnIm.dataset.bound = '1'; btnIm.onclick = () => { if (file) file.click(); }; }
    if (file && !file.dataset.bound) {
      file.dataset.bound = '1';
      file.onchange = async () => {
        const f = file.files && file.files[0];
        if (!f) return;
        try {
          const pkg = JSON.parse(await f.text());
          if (pkg.app !== 'dividend-tool-sync') { try { toast('⚠️ 这不是同步包（请用「导出同步包」生成的文件）'); } catch (e) {} return; }
          const diff = mergePreview(pkg);
          const total = diff.wlAdd + diff.wlUpd + diff.hAdd + diff.hUpd + diff.cAdd + diff.cUpd + diff.dAdd;
          if (total === 0) { try { toast('✅ 已是最新，无变更可合并'); } catch (e) {} return; }
          const msg = `来自 ${pkg.device || '另一台设备'}（导出于 ${(pkg.exportedAt || '').slice(0, 10)}）\n将合并：\n· 自选新增 ${diff.wlAdd} / 更新 ${diff.wlUpd}\n· 持仓新增 ${diff.hAdd} / 更新 ${diff.hUpd}\n· 组合新增 ${diff.cAdd} / 更新 ${diff.cUpd}\n· 决策记录新增 ${diff.dAdd}\n\n按时间戳智能合并（不覆盖你的新数据），继续？`;
          if (!confirm(msg)) return;
          applySyncPackage(pkg);
          try { toast('✅ 同步合并完成'); } catch (e) {}
          try { renderHome(); } catch (e) {}
          try { renderParamPanel(); } catch (e) {}
        } catch (e) { try { toast('导入失败：' + e.message); } catch (e2) {} }
        file.value = '';
      };
    }
  }

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
      `<div id="syncBox" style="padding:6px 8px;border:1px solid rgba(90,169,230,.4);border-radius:8px;background:rgba(90,169,230,.06);margin-bottom:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span style="font-size:11px;color:#5aa9e6">📱 三端同步（手机/iPad/电脑同一份数据）</span><button type="button" class="chip" id="syncExport" style="color:#5aa9e6">📤 导出同步包</button><button type="button" class="chip" id="syncImport" style="color:#4caf7d">📥 导入合并</button><input type="file" id="syncFile" accept=".json,application/json" style="display:none"><span style="font-size:10px;color:var(--muted)">导出→iCloud/文件→另一台导入，按时间戳智能合并，数据不出机器</span></div>` +
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
    installSyncUI();
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
