/* ============================================================
 * views-diag.js — views.js 拆分模块 诊断页（结论层/依据层/研究层/决策日志）
 * 生成：scripts/split-views.py（v3.10+ 接手 AI）
 * 加载顺序：views-core → views-home → views-diag → views-compare → views-pfbt
 * 全局作用域共享（去 IIFE），勿在此文件内重复声明 DL/$/fmt
 * ============================================================ */
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
      /* v3.8.0 口径归一（接手 AI）：全站股息率主口径=报告期（最近已公告完整财年分红÷现价，与分位线/信号同尺），
       * 年化近2财年降为 hover 附注——消灭同屏同名多值 */
      let repDy = null, repDps = null;
      try { const t = DL.reportYearDivAt(divs, DL.todayStr()); if (t > 0 && lastPrice > 0) { repDps = t; repDy = t / lastPrice * 100; } } catch (e) {}
      const mainDy = repDy != null ? repDy : divYield;
      const mainDps = repDps != null ? repDps : dps;
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
        <div class="stat"><div class="k">当前股息率<span class="tt" title="报告期口径：最近已公告完整财年分红÷现价（与分位线/信号同尺）${dy ? '；年化近' + yieldLabel + '：' + divYield.toFixed(2) + '%' : ''}">(报告期)</span></div><div class="v gold">${mainDy != null ? mainDy.toFixed(2) + '%' : '—'}</div></div>
        <div class="stat"><div class="k">每股分红<span class="tt" title="报告期口径：最近已公告完整财年每股分红${dy ? '；年化近' + yieldLabel + '：' + fmt(dps, 3) + ' 元' : ''}">(报告期)</span></div><div class="v">${fmt(mainDps, 3)} 元</div></div>
        <div class="stat"><div class="k">分红占利润<span class="tt" title="近2个完整财年累计分红 ÷ 对应 2 年 EPS（支付率口径，同数异名已统一）">(近2财年)</span></div><div class="v">${cover != null ? (cover * 100).toFixed(0) + '%' : '—'}</div></div>
        <div class="stat"><div class="k">近${diagYears}年年化</div><div class="v ${cagr >= 0 ? 'green' : 'red'}">${cagr != null ? fmtPct(cagr) : '—'}</div></div>
        <div class="stat"><div class="k">近${diagYears}年最大回撤</div><div class="v red">${fmtPct(-maxDD)}</div></div>
        <div class="stat"><div class="k">PE / PB</div><div class="v">${s.pe != null ? fmt(s.pe, 1) : '—'} / ${s.pb != null ? fmt(s.pb, 2) : '—'}</div></div>
      </div>`;
      /* v3.8.0 U2 分位仪表盘 + U4 关键数据雷达图（接手 AI）——数字图形化，一眼看懂画像 */
      try {
        let _pctNow = null;
        try { const _ser = DL.calcRollingPercentile(kline, divs, window.G_WINDOW || DL.DEFAULT_WINDOW_DAYS); const _l = _ser.filter(x => x.pct != null).pop(); _pctNow = _l ? _l.pct : null; } catch (e5) {}
        const _vizEl = $('#diagStats');
        if (_vizEl && typeof echarts !== 'undefined') {
          _vizEl.insertAdjacentHTML('beforeend', `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:stretch">
            <div style="flex:0 0 190px;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:6px"><div id="diagGaugePct" style="height:130px"></div><div style="font-size:10px;color:var(--muted);text-align:center">便宜度仪表（右=便宜，绿区=买点区）</div></div>
            <div style="flex:1;min-width:260px;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:6px"><div id="diagRadar" style="height:150px"></div><div style="font-size:10px;color:var(--muted);text-align:center">六维画像（越大越好；虚线=行业参考）</div></div>
          </div>`);
          /* U2 分位仪表 */
          try {
            const _g = echarts.init(document.getElementById('diagGaugePct'));
            const _pv = _pctNow != null ? _pctNow : 0;
            _g.setOption({
              backgroundColor: 'transparent',
              series: [{
                type: 'gauge', min: 0, max: 100, startAngle: 200, endAngle: -20, radius: '100%',
                progress: { show: true, width: 12, itemStyle: { color: _pv >= 75 ? '#4caf7d' : (_pv >= 50 ? '#d9a441' : '#e05a5a') } },
                axisLine: { lineStyle: { width: 12, color: [[0.3, 'rgba(224,90,90,.5)'], [0.5, 'rgba(217,164,65,.5)'], [0.75, 'rgba(76,175,125,.35)'], [1, 'rgba(76,175,125,.8)']] } },
                axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, pointer: { show: false },
                detail: { valueAnimation: true, formatter: x => x.toFixed(0) + ' 分位', fontSize: 15, fontWeight: 700, color: '#e8efe9', offsetCenter: [0, '-6%'] },
                title: { show: false },
                data: [{ value: _pv }],
              }],
            });
          } catch (e6) { try { const g0 = document.getElementById('diagGaugePct'); if (g0) g0.remove(); } catch (e7) {} }
          /* U4 六维雷达（行业参考虚线用 BENCH）——数据源：REPORT_CARD_EXTRA（内置持仓）或空缺降级 */
          try {
            const _rr = document.getElementById('diagRadar');
            const _rce = (window.REPORT_CARD_EXTRA && window.REPORT_CARD_EXTRA[code]) || {};
            const _ind = _rce.industry || null;
            const _bench = _ind && DL.BENCH ? DL.BENCH[_ind] : null;
            const _roe = _rce.roe || null;
            const _resv = (_rce.reserve != null && mainDps > 0) ? _rce.reserve / mainDps : null;
            const _r = echarts.init(_rr);
            _r.setOption({
              backgroundColor: 'transparent',
              tooltip: { trigger: 'item', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 } },
              radar: {
                indicator: [
                  { name: 'ROE', max: 25 }, { name: '股息率', max: 10 }, { name: '分红占利润', max: 100 },
                  { name: '分红增速', max: 50 }, { name: '储备(年)', max: 10 }, { name: '波动容忍', max: 100 },
                ],
                radius: '68%', center: ['50%', '52%'],
                axisName: { color: '#8fa69c', fontSize: 9 },
                splitArea: { areaStyle: { color: ['rgba(42,61,54,.15)', 'rgba(42,61,54,.05)'] } },
                splitLine: { lineStyle: { color: '#2a3d36' } },
                axisLine: { lineStyle: { color: '#2a3d36' } },
              },
              series: [{
                type: 'radar',
                data: [
                  { value: [
                      _roe != null ? Math.min(25, _roe) : 0,
                      mainDy != null ? Math.min(10, mainDy) : 0,
                      cover != null ? Math.min(100, cover * 100) : 0,
                      cagr != null ? Math.min(50, Math.max(0, cagr * 100)) : 0,
                      _resv != null ? Math.min(10, _resv) : 0,
                      maxDD > 0 ? Math.min(100, (1 - maxDD) * 100) : 100,
                    ], name: '本股',
                    lineStyle: { color: '#d9a441', width: 2 }, itemStyle: { color: '#d9a441' },
                    areaStyle: { color: 'rgba(217,164,65,.25)' } },
                  ...(_bench ? [{ value: [
                      _bench.roe ? _bench.roe[1] : 0, _bench.yieldMid != null ? _bench.yieldMid : 0,
                      50, 15, 5, 60,
                    ], name: '行业参考', lineStyle: { color: '#5aa9e6', width: 1.5, type: 'dashed' }, itemStyle: { color: '#5aa9e6' }, areaStyle: { color: 'transparent' } }] : []),
                ],
              }],
            });
          } catch (e8) { try { const r0 = document.getElementById('diagRadar'); if (r0) r0.remove(); } catch (e9) {} }
        }
      } catch (e4) { try { console.warn('U2/U4 渲染失败', e4); } catch (e10) {} }
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
    /* v3.8.0 U5 分红瀑布柱状图（接手 AI）：涨绿跌红，一眼看增长节奏 */
    html += '<div id="diagDivChart" style="height:150px;margin-top:6px"></div>';
    el.innerHTML = html;
    try {
      if (typeof echarts !== 'undefined') {
        const ch = echarts.init(document.getElementById('diagDivChart'));
        const vals = last5.map(y => byYear[y]);
        ch.setOption({
          backgroundColor: 'transparent',
          tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => { const i = p[0].dataIndex; return `<b>${last5[i]}</b> 报告期：每股分红 <b>${vals[i].toFixed(3)} 元</b>`; } },
          grid: { left: 44, right: 10, top: 14, bottom: 20 },
          xAxis: { type: 'category', data: last5, axisLine: { lineStyle: { color: '#3a4f46' } }, axisLabel: { color: '#8fa69c', fontSize: 10 } },
          yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10 }, splitLine: { lineStyle: { color: '#22322c' } } },
          series: [{
            type: 'bar', barMaxWidth: 30,
            data: vals.map((v, i) => ({
              value: +v.toFixed(3),
              itemStyle: {
                color: i === 0 ? '#5aa9e6' : (v > vals[i - 1] ? '#4caf7d' : (v < vals[i - 1] ? '#e05a5a' : '#8fa69c')),
                borderRadius: [3, 3, 0, 0],
              },
              label: { show: true, position: 'top', color: '#8fa69c', fontSize: 9, formatter: x => x.value.toFixed(2) },
            })),
          }],
        });
      }
    } catch (e) { try { const d0 = document.getElementById('diagDivChart'); if (d0) d0.remove(); } catch (e2) {} }
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
  /* ===== v3.8.0 结论层（U1 红绿灯大图标 + 一句话 + U3 买点标尺 + U6 风险图标行 + 动作按钮）=====
   * 由 renderReportCard 在算完 verdictEngine/tradingSignal 后调用，填充 #diagConclusion */
  function renderConclusionLayer({ code, divs, kline, extra, v, dy, pct, ts, mainDy, price, lastDate }) {
    const el = document.getElementById('diagConclusion');
    if (!el) return;
    /* ---- 一句话理由（人话模板） ---- */
    let oneLiner = '';
    if (v.trap && v.trap.level === 'hard') {
      oneLiner = `现价 <b>${price != null ? fmt(price, 2) : '—'} 元</b>，股息率 <b>${mainDy != null ? mainDy.toFixed(2) + '%' : '—'}</b>（报告期）。⚠️ 净利下滑 + 分红占利润过高，<b>先别买</b>——等财报转好或价格更安全再看。`;
    } else if (ts && (ts.action === 'sell' || ts.action === 'reduce' || ts.action === 'watch')) {
      oneLiner = `现价 <b>${price != null ? fmt(price, 2) : '—'} 元</b>。⚠️ 基本面有恶化信号（${(ts.reason || '').replace(/^证据[^：]*：/, '').slice(0, 40)}），建议<b>${ts.action === 'sell' ? '回避/考虑卖出' : ts.action === 'reduce' ? '减仓观察' : '观察'}</b>。`;
    } else {
      const tLine = (v.tiers || []).filter(t => t.type !== 'cur');
      const small = tLine.find(t => t.type === 'small'), add = tLine.find(t => t.type === 'add'), full = tLine.find(t => t.type === 'full');
      const buyTxt = small ? `跌到 <b>${small.price} 元</b>可小仓` : '';
      const addTxt = add ? `、<b>${add.price} 元</b>加仓` : '';
      const fullTxt = full ? `、<b>${full.price} 元</b>重仓` : '';
      const dd = v.tiers && v.tiers.length ? null : null;
      const ddNote = (extra && extra.industry) ? DL.ddNote(extra.industry, (v.curTier && v.curTier.name === '深度低估') ? 'heavy' : (v.curTier && v.curTier.name === '低估二档') ? 'add' : (v.curTier && v.curTier.name === '低估一档') ? 'small' : null) : null;
      oneLiner = `现价 <b>${price != null ? fmt(price, 2) : '—'} 元</b>，股息率 <b>${mainDy != null ? mainDy.toFixed(2) + '%' : '—'}</b>（报告期口径）。想买：${buyTxt}${addTxt}${fullTxt || ''}。${ddNote ? '历史最坏浮亏 <b>' + ddNote.replace(/^.*?浮亏/, '') + '</b>' : ''}`;
    }
    /* ---- U3 买点价格标尺（纯 CSS，无 echarts 依赖） ---- */
    const tierList = (v.tiers || []).filter(t => t.type !== 'cur' && t.price != null);
    let scaleHtml = '';
    if (tierList.length && price != null) {
      const prices = tierList.map(t => parseFloat(t.price)).concat([price]);
      const lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
      const span = (hi - lo) || 1;
      const pos = p => ((parseFloat(p) - lo) / span * 100);
      const pct = pos(price);
      const marks = tierList.map(t => `
        <div style="position:absolute;left:${pos(t.price).toFixed(1)}%;transform:translateX(-50%);bottom:-14px;text-align:center;font-size:10px;color:${t.hit ? 'var(--gold)' : 'var(--sub)'}">
          <div style="width:2px;height:14px;background:${t.hit ? 'var(--gold)' : 'var(--line)'};margin:0 auto"></div>
          <div>${t.label} ${t.rate != null ? t.rate.toFixed(1) + '%' : ''}</div>
          <div style="font-weight:700">${t.price} 元${t.hit ? ' ✅' : ''}</div>
        </div>`).join('');
      scaleHtml = `<div style="margin-top:10px;padding:2px 4px 26px;border:1px solid var(--line);border-radius:8px;background:var(--card2);position:relative">
        <div style="position:absolute;left:${pct.toFixed(1)}%;transform:translateX(-50%);top:-6px;z-index:3;text-align:center">
          <div style="font-size:10px;font-weight:700;color:var(--gold);background:var(--card);padding:0 4px;border-radius:4px;border:1px solid var(--gold)">现价 ${fmt(price, 2)}</div>
          <div style="width:2px;height:22px;background:var(--gold);margin:1px auto"></div>
          <div style="font-size:10px;color:var(--gold)">▲</div>
        </div>
        ${marks}
        <div style="height:6px;border-radius:3px;background:linear-gradient(90deg, var(--red), #d9a441 40%, var(--green));opacity:.55"></div>
        <div style="font-size:10px;color:var(--muted);margin-top:14px;display:flex;justify-content:space-between"><span>便宜（左）</span><span>贵（右）</span></div>
      </div>`;
    } else if (v.tiers && v.tiers.length) {
      scaleHtml = '<div style="font-size:11px;color:var(--muted);margin-top:6px">买点线待补（K线源故障），暂以股息率线参考</div>';
    }
    /* ---- U6 风险图标行 ---- */
    const riskIcons = [];
    if (v.trap) riskIcons.push(`<span style="color:#e05a5a;font-weight:700">${v.trap.level === 'hard' ? '🚫' : '⚠️'} ${v.trap.level === 'hard' ? '陷阱拦截' : '陷阱观察'}</span>`);
    if (v.filters && v.filters.length) v.filters.forEach(f => riskIcons.push(`<span style="color:#d9a441">🟡 ${f.txt}</span>`));
    const q3txt = v.q3 && v.q3.msg && v.q3.msg !== '未见显著风险' ? v.q3.msg : '';
    if (q3txt) riskIcons.push(`<span style="color:${v.q3.verdict && v.q3.verdict.includes('✅') ? 'var(--green)' : '#d9a441'}">${v.q3.verdict || '⚠️'} ${q3txt}</span>`);
    if (!riskIcons.length) riskIcons.push('<span style="color:var(--green)">✅ 无明显风险</span>');
    /* ---- 结论大卡 ---- */
    const verdict = (document.getElementById('diagMainVerdict') || {}).innerHTML || '';
    el.innerHTML = `
      <div style="border:2px solid ${v.trap && v.trap.level === 'hard' ? 'var(--red)' : 'rgba(217,164,65,.6)'};border-radius:12px;padding:12px;background:linear-gradient(135deg, rgba(217,164,65,.08), transparent 60%), var(--card2)">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:260px">
            <div style="font-size:24px;font-weight:800;letter-spacing:.5px" id="diagBigVerdict">${verdict}</div>
            <div style="font-size:13px;color:var(--txt);margin-top:6px;line-height:1.6">${oneLiner}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;min-width:150px">
            <button type="button" class="chip" id="conclWl" style="color:#5aa9e6">⭐ 加自选</button>
            <button type="button" class="chip" id="conclBt" style="color:#d9a441">📊 回测验证</button>
            <button type="button" class="chip" id="conclDec" style="color:#4caf7d">📒 记决策</button>
          </div>
        </div>
        ${scaleHtml}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;font-size:11px">${riskIcons.join(' ')}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:6px">数据截至 ${lastDate || '—'} · 股息率口径=报告期（最近已公告完整财年÷现价）· 等级=风险提示，最终动作由您拍板</div>
      </div>`;
    /* 绑定动作按钮 */
    const wlBtn = document.getElementById('conclWl');
    if (wlBtn) wlBtn.onclick = () => { try { addToWatchlist(code); } catch (e) {} };
    const btBtn = document.getElementById('conclBt');
    if (btBtn) btBtn.onclick = () => { const b = document.getElementById('btnDiagBacktest'); if (b) b.click(); };
    const decBtn = document.getElementById('conclDec');
    if (decBtn) decBtn.onclick = () => { try { const d = document.getElementById('decBtnBuy'); if (d) { d.scrollIntoView({ behavior: 'smooth', block: 'center' }); d.focus(); } } catch (e) {} };
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
    // v3.4 修复（v1.9.34 重构遗留 bug）：reserve 定义被删但使用保留 → 诊断页 ReferenceError
    const reserve = (extra && extra.reserve != null) ? extra.reserve : null;
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
    const covTxt = cov != null ? termTip('覆盖率') + ' ' + (1 / cov).toFixed(1) + ' 倍' : '<span style="color:var(--muted)">数据不足</span>';
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
          /* v3.7.0 统一结论：陷阱/卖出信号合并到主结论（applyUnifiedVerdict 更新决策主卡），本指令条同步降级文案防两处打架 */
          applyUnifiedVerdict(ts, v.trap);
          /* v3.8.0 结论层：红绿灯大卡+一句话+买点标尺+风险图标+动作按钮 */
          try {
            const _price = (extra && extra.price) || (kline && kline.length ? (kline[kline.length - 1].close != null ? kline[kline.length - 1].close : null) : null);
            let _mainDy = null;
            try { const _t = DL.reportYearDivAt(divs, DL.todayStr()); if (_t > 0 && _price > 0) _mainDy = _t / _price * 100; } catch (e3) {}
            renderConclusionLayer({ code, divs, kline, extra, v, dy, pct, ts, mainDy: _mainDy, price: _price, lastDate: (kline && kline.length && kline[kline.length - 1].d) || '' });
          } catch (e3) { try { console.warn('结论层渲染失败', e3); } catch (e4) {} }
          let tsText = ts.text;
          if (v.trap && v.trap.level === 'hard') tsText = '🚫 陷阱拦截：主结论已降级回避';
          else if (v.trap && v.trap.level === 'soft') tsText = ts.text + '（⚠️ 陷阱观察，降为小仓）';
          const col = v.trap && v.trap.level === 'hard' ? '#e05a5a' : (v.trap && v.trap.level === 'soft' ? '#d9a441' : (ts.action === 'sell' ? '#e05a5a' : ts.action === 'reduce' ? '#d9a441' : ts.action === 'watch' ? '#d9a441' : (ts.action.startsWith('buy_') ? '#4caf7d' : 'var(--muted)')));
          const lvNote = ts.level ? ` <span style="font-weight:400;font-size:11px;color:var(--sub)">等级 ${ts.level} · 建议强度 ${ts.strength}</span>` : '';
          const disclaimer = ts.level ? '<span style="font-weight:400;font-size:11px;color:var(--muted);display:block;margin-top:2px">⚠️ 等级=风险提示+建议，最终动作由您拍板</span>' : '';
          return '<div style="font-size:12px;margin-top:6px;padding:6px 9px;border-radius:8px;border:1px solid ' + col + ';background:rgba(0,0,0,.2);color:' + col + ';font-weight:700">' + layerBadge + tsText + lvNote + '<span style="font-weight:400;font-size:11px;color:var(--sub)"> — ' + ts.reason + '</span>' + disclaimer + '</div>';
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
  /* ===== v3.7.0 统一结论引擎（接手 AI）：三套结论合并为唯一主结论 =====
   * 背景：诊断页曾有 3 个并列结论互相矛盾（规则树"条件建仓" vs 陷阱过滤器"陷阱确认" vs 等级引擎"L3 小仓"）。
   * 合并规则（展示层，不动三套引擎算法）：
   *   1. 卖出侧优先：tradingSignal 出 sell/reduce/watch（S1-S3）→ 主结论=回避/减仓/观察
   *   2. 陷阱 hard（净利大幅下滑+支付率过高+高股息画像）→ 主结论=回避（陷阱拦截）
   *   3. 陷阱 soft → 买入档主结论降级为"观察（陷阱风险）"
   *   4. 否则保持规则树结论（strong/buy/watch/wait/avoid）
   * 结果：页面只出现 1 个主结论，陷阱确认时绝不再显示"条件建仓"。 */
  function applyUnifiedVerdict(ts, trap) {
    const box = document.getElementById('diagMainVerdict');
    if (!box) return;
    const base = window.__ruleVerdict || null;
    if (!base) return;
    let label = base.label, color = base.color, icon = base.icon;
    let extraHtml = '';
    if (ts && (ts.action === 'sell' || ts.action === 'reduce' || ts.action === 'watch')) {
      const m = ts.text.match(/^(\S+\s*\S*)/);
      label = m ? m[1] : '回避/观察';
      color = ts.action === 'sell' ? '#e05a5a' : '#d9a441';
      icon = ts.action === 'sell' ? '🔴' : '🟡';
      extraHtml = `<span style="font-size:11px;color:var(--sub);font-weight:400">— ${ts.reason}</span>`;
    } else if (trap && trap.level === 'hard') {
      label = '回避（陷阱拦截）';
      color = '#e05a5a'; icon = '🚫';
      extraHtml = `<span style="font-size:11px;color:#e05a5a;font-weight:400">— ${trap.msg}</span>`;
    } else if (trap && trap.level === 'soft') {
      if (base.tier === 'strong' || base.tier === 'buy' || base.tier === 'watch') { label = '观察（陷阱风险）'; color = '#d9a441'; icon = '🟡'; }
      extraHtml = `<span style="font-size:11px;color:#d9a441;font-weight:400">— ${trap.msg}：加仓降为小仓</span>`;
    }
    box.innerHTML = `<b style="color:${color};font-size:16px">${icon} ${label}</b>${extraHtml ? ' ' + extraHtml : ''}`;
  }

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
        <span id="diagMainVerdict"><b style="color:${color};font-size:16px">${icon} ${label}</b></span>
        <span style="font-size:12px;color:var(--sub)">${statTxt} · 基于历史数据${dataTsTxt}</span>
      </div>
      <div style="font-size:12px;margin-top:6px;color:var(--txt)">当前分位 ${last.pct.toFixed(0)}%（${tcls.label} · ${ecoName}）${waitHint}</div>
      ${conflictHtml}
      <div style="font-size:11px;color:var(--sub);margin-top:4px"><span class="tt" title="报告期口径：最近已公告完整财年分红÷现价；年化近2财年=${yieldTxt}">股息率(报告期)</span> ${(() => { try { const _t = DL.reportYearDivAt(divs, last.d); return _t > 0 ? (_t / Object.values(kline).pop() * 100).toFixed(2) + '%' : yieldTxt; } catch (e) { return yieldTxt; } })()} · <span class="tt" title="支付率口径：近2财年分红÷EPS">分红占利润(近2财年)</span> ${cov != null ? (cov * 100).toFixed(0) + '%' : '—'} · 分红CAGR ${cagr != null ? (cagr * 100).toFixed(1) + '%' : '—'}</div>
      <details style="margin-top:6px"><summary style="font-size:11px;color:var(--sub);cursor:pointer">查看判定依据</summary>${stepsHtml}<div style="font-size:11px;color:var(--muted);margin-top:4px">规则：分红趋势一票否决 → ${termTip('覆盖率')}降级 → 分位×${termTip('生态类型')} → 等待成本；历史胜率=40只×16年回测（${termTip('W375')}）；非投资建议，不构成买卖依据</div></details>
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
    /* v3.7.0 统一结论：存规则树结论快照，供 renderReportCard 的 applyUnifiedVerdict 合并陷阱/卖出信号 */
    window.__ruleVerdict = { tier: v.tier, label, color, icon };
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
    /* v2.0 #22：决策日志删除（事件委托，快照已带 tier/pct/dy/note）
     * 修复 C1（2026-08-23 接手 AI）：原 `!document.querySelector('#decLogList[data-delbound]')` 的 data-delbound
     * 从未被任何代码设置 → 条件恒真 → 每次渲染诊断页都追加一个 document click 委托，删一条触发多次。
     * 改为 body dataset 真实标记，全局只绑定一次。 */
    if (!document.body.dataset.decDelBound) {
      document.body.dataset.decDelBound = '1';
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
    /* v3.8.0 U7 派息热力条（接手 AI）：年×12月网格，深色=派息月——一年几派/几月派一眼看出 */
    if (years.length) {
      const grid = years.map(y => {
        const ms = byYear[y];
        const cells = [];
        for (let m = 1; m <= 12; m++) {
          const hit = ms.includes(m);
          cells.push(`<div style="flex:1;height:18px;border-radius:3px;background:${hit ? 'var(--gold)' : 'rgba(42,61,54,.35)'};${hit ? 'box-shadow:0 0 4px rgba(217,164,65,.6)' : ''};margin:1px;display:flex;align-items:center;justify-content:center;font-size:9px;color:${hit ? '#201703' : 'transparent'}" title="${y}年${m}月${hit ? '派息' : ''}">${hit ? m : ''}</div>`);
        }
        return `<div style="display:flex;align-items:center;margin:2px 0"><span style="width:42px;font-size:10px;color:var(--sub);flex-shrink:0">${y}年</span><div style="display:flex;flex:1">${cells.join('')}</div></div>`;
      }).join('');
      el.innerHTML = `<div class="rhythm-heat" style="background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:6px">${grid}<div style="font-size:9px;color:var(--muted);margin-top:2px;text-align:right">■ 派息月（一年几派、几月派，一眼看规律）</div></div>`;
    } else {
      el.innerHTML = '<div class="hint">暂无分红记录</div>';
    }
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
