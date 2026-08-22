/* ============================================================
 * views-pfbt.js — views.js 拆分模块 组合驾驶舱+持仓+组合编辑器
 * 生成：scripts/split-views.py（v3.10+ 接手 AI）
 * 加载顺序：views-core → views-home → views-diag → views-compare → views-pfbt
 * 全局作用域共享（去 IIFE），勿在此文件内重复声明 DL/$/fmt
 * ============================================================ */
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

  /* v3.2 S3：年度战绩表数据（分红列优先：当年分红/YoY/当年收益率/当年XIRR/年末资产）
   * 分红YoY走图标通道（▲绿▼红），收益率/XIRR走数字着色（A股红涨绿跌）——双语义分离防撞色 */
  function buildYearTable(res) {
    const t = res.totalAsset || [];
    const divByYear = res.divByYear || {};
    const mfMap = {};
    (res.perStock || []).forEach(p => (p.monthlyFlow || []).forEach(m => { mfMap[m.date] = (mfMap[m.date] || 0) + m.amount; }));
    const years = Object.keys(divByYear).sort();
    const rows = years.map((y, i) => {
      const div = divByYear[y] || 0;
      const prevDiv = i > 0 ? (divByYear[years[i - 1]] || 0) : null;
      const yoy = (prevDiv != null && prevDiv > 0) ? (div - prevDiv) / prevDiv * 100 : null;
      const pts = t.filter(x => x.d.startsWith(y));
      const lastPt = pts[pts.length - 1];
      const firstPt = pts[0];
      let ret = null;
      if (lastPt) {
        if (i === 0) ret = lastPt.invested > 0 ? (lastPt.value / lastPt.invested - 1) * 100 : null;
        else {
          const prevPts = t.filter(x => x.d.startsWith(years[i - 1]));
          const prevLast = prevPts[prevPts.length - 1];
          if (prevLast && prevLast.value > 0) ret = (lastPt.value / prevLast.value - 1) * 100;
        }
      }
      let xirr = null;
      if (firstPt && lastPt && lastPt.d !== firstPt.d) {
        try {
          const flows = [{ d: firstPt.d, v: -firstPt.value }];
          Object.keys(mfMap).sort().forEach(d => { if (d.startsWith(y)) flows.push({ d, v: -mfMap[d] }); });
          flows.push({ d: lastPt.d, v: lastPt.value });
          if (flows.length >= 2 && typeof calcXirr === 'function') { const x = calcXirr(flows); xirr = x != null ? x * 100 : null; }
        } catch (e) { xirr = null; }
      }
      /* v3.4 N1：累计收益率 = 该年末值 ÷ 该年末累计投入 - 1（含月追加，MOIC 同源口径） */
      let cumRet = null;
      if (lastPt && lastPt.invested > 0) cumRet = (lastPt.value / lastPt.invested - 1) * 100;
      return { year: y, div, yoy, ret, xirr, endValue: lastPt ? lastPt.value : null, cumRet, cumInvest: lastPt ? lastPt.invested : null };
    });
    return rows;
  }
  /* 年度战绩表渲染（v3.4：人话表头 + 色块热力 + 累计收益率列；断点 900藏分红比去年/480藏当年赚了，累计收益率+年末资产永不隐藏）
   * 新列序：年份|当年分红|分红比去年(色块)|当年赚了(色块)|累计收益率|算上追加每年赚|年末资产 */
  function renderYearTable(res, sortKey, sortDir) {
    let rows = buildYearTable(res);
    const keys = ['year', 'div', 'yoy', 'ret', 'cumRet', 'xirr', 'endValue'];
    if (sortKey && keys.indexOf(sortKey) >= 0 && sortKey !== 'year') {
      rows = rows.slice().sort((a, b) => {
        const av = a[sortKey] == null ? -Infinity : a[sortKey];
        const bv = b[sortKey] == null ? -Infinity : b[sortKey];
        return (av - bv) * (sortDir === 'asc' ? 1 : -1);
      });
    } else rows = rows.slice().reverse();
    const head = (label, k, hint) => `<th data-skey="${k}" title="${hint || ''}" style="text-align:right;padding:5px 8px;cursor:pointer;font-size:11px;color:var(--muted);white-space:nowrap;user-select:none">${label} ${sortKey === k ? (sortDir === 'asc' ? '▲' : '▼') : ''}</th>`;
    const fmtW = v => (v / 10000).toFixed(2) + '万';
    /* 色块热力（v3.4 TB1/TB2）：分红比去年 ↑绿/↓红/—灰；当年赚了 红涨绿跌 */
    const heatDiv = (yoy) => {
      if (yoy == null) return '<span class="v3-heat flat">—</span>';
      return yoy >= 0
        ? `<span class="v3-heat up">▲${Math.abs(yoy).toFixed(1)}%</span>`
        : `<span class="v3-heat down">▼${Math.abs(yoy).toFixed(1)}%</span>`;
    };
    const heatRet = (ret) => {
      if (ret == null) return '<span class="v3-heat flat">—</span>';
      return ret >= 0
        ? `<span class="v3-heat up" style="background:rgba(224,90,90,.14);color:#e05a5a">+${ret.toFixed(1)}%</span>`
        : `<span class="v3-heat down" style="background:rgba(76,175,125,.16);color:#4caf7d">${ret.toFixed(1)}%</span>`;
    };
    const rowHtml = r => {
      /* 首年 YoY=—（灰）；断档年（前年有今年无）红字「停分」 */
      let yoyCell;
      if (r.yoy == null) yoyCell = '<span class="v3-heat flat">—</span>';
      else if (r.yoy === -100) yoyCell = '<span class="v3-heat down">停分</span>';
      else yoyCell = heatDiv(r.yoy);
      const retCell = heatRet(r.ret);
      const cumTxt = r.cumRet == null ? '—' : `<span style="color:${r.cumRet >= 0 ? 'var(--up,#e05a5a)' : 'var(--down,#4caf7d)'};font-weight:600">${r.cumRet >= 0 ? '+' : ''}${r.cumRet.toFixed(1)}%</span>`;
      const xirrTxt = r.xirr == null ? '—' : `<span style="color:${r.xirr >= 0 ? 'var(--up,#e05a5a)' : 'var(--down,#4caf7d)'}">${r.xirr >= 0 ? '+' : ''}${r.xirr.toFixed(1)}%</span>`;
      const divTxt = r.div > 0 ? fmtW(r.div) : '<span style="color:var(--muted)">—</span>';
      return `<tr style="border-top:1px solid var(--line)">
        <td style="text-align:left;padding:5px 8px;font-weight:600">${r.year}</td>
        <td style="text-align:right;padding:5px 8px;font-variant-numeric:tabular-nums">${divTxt}</td>
        <td style="text-align:right;padding:5px 8px">${yoyCell}</td>
        <td style="text-align:right;padding:5px 8px">${retCell}</td>
        <td style="text-align:right;padding:5px 8px;font-variant-numeric:tabular-nums;white-space:nowrap">${cumTxt}</td>
        <td style="text-align:right;padding:5px 8px;font-variant-numeric:tabular-nums;white-space:nowrap">${xirrTxt}</td>
        <td style="text-align:right;padding:5px 8px;font-variant-numeric:tabular-nums">${r.endValue != null ? fmtW(r.endValue) : '—'}</td>
      </tr>`;
    };
    return `<div class="v3-year-table" id="pfbtYearTable">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span style="font-size:13px;font-weight:700">📅 年度战绩</span>
        <span style="font-size:10px;color:var(--muted)">分红列优先·点列头排序·当年赚了=XIRR 双口径</span>
        <span style="margin-left:auto;font-size:10px;color:var(--muted)">分红比去年：▲绿/▼红/—灰｜当年赚了：红涨绿跌（A股）</span>
      </div>
      <div style="overflow-x:auto">
      <table style="width:100%;font-size:11px;border-collapse:collapse;background:var(--card2);border-radius:10px;overflow:hidden">
        <thead><tr style="background:var(--card)">${head('年份','year')}${head('当年分红','div')}${head('分红比去年','yoy','▲增长 ▼下滑 —持平/首年')}${head('当年赚了','ret','红涨绿跌')}${head('累计收益率','cumRet','该年末值÷累计投入-1（含追加）')}${head('算上追加每年赚','xirr','年化内部收益率')}${head('年末资产','endValue')}</tr></thead>
        <tbody>${rows.map(rowHtml).join('')}</tbody>
      </table>
      </div>
    </div>`;
  }

  /* v3.2 S6/S7：个股卡片区（4 层架构 L1-L4）——SVG 迷你图不卡平板；栅格断点 1280/768；贡献拆解分列
   * L1 名称/代码/行业徽章/数据源点 · L2 股息率+分位徽章 · L3 六格指标+贡献%进度条 · L4 SVG迷你线+分红小柱
   * 迷你图统一中性绿（语义只走徽章，防一屏霓虹灯） */
  function renderStockCards(res, pool) {
    const ps = res.perStock || [];
    if (!ps.length) return '';
    const divTotal = ps.reduce((s, p) => s + p.cumDiv, 0);
    const lastW = (res.weightEvol && res.weightEvol.length) ? res.weightEvol[res.weightEvol.length - 1] : null;
    const lastDate = (res.totalAsset && res.totalAsset.length) ? res.totalAsset[res.totalAsset.length - 1].d : '';
    /* v3.5 排序状态（存 window 模块级，切换器读写）
     * 修复 C3（2026-08-23 接手 AI）：原 var 声明在函数内每次调用重建 → typeof 恒 undefined → 恒重置 'mkt'
     * → L4663 设置的值下次渲染被清掉 → 排序切换器实际不生效。改 window 属性持久。 */
    if (window._stockSortKey == null) window._stockSortKey = 'mkt'; /* mkt=市值占比 / gain=总收益 / name=拼音 */
    let sorted = ps.slice();
    if (window._stockSortKey === 'mkt') {
      sorted.sort((a, b) => {
        const wa = lastW ? (lastW.weights[a.code] || 0) : 0;
        const wb = lastW ? (lastW.weights[b.code] || 0) : 0;
        return wb - wa;
      });
    } else if (window._stockSortKey === 'gain') {
      sorted.sort((a, b) => (((b.finalValue - b.invested) + b.cumDiv) - ((a.finalValue - a.invested) + a.cumDiv)));
    } else {
      sorted.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    }
    const svgSpark = (ns) => {
      if (!ns || ns.length < 2) return '<div style="font-size:10px;color:var(--muted)">—</div>';
      const pts = ns.length > 50 ? ns.filter((_, i) => i % Math.ceil(ns.length / 50) === 0) : ns; /* 降采样≤50 */
      const w = 100, h = 24, min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
      const span = (max - min) || 1;
      const coords = pts.map((v, i) => `${(i / (pts.length - 1) * w).toFixed(1)},${(h - 2 - (v - min) / span * (h - 4)).toFixed(1)}`).join(' ');
      return `<svg viewBox="0 0 100 24" preserveAspectRatio="none" style="width:100%;height:24px;display:block"><polyline points="${coords}" fill="none" stroke="rgba(76,175,125,.85)" stroke-width="1.5"/></svg>`;
    };
    const divSpark = (yd) => {
      const ys = Object.keys(yd || {}).sort();
      if (!ys.length) return '';
      const vals = ys.slice(-8).map(y => yd[y]);
      const max = Math.max.apply(null, vals.concat([1]));
      const bars = vals.map((v, i) => {
        const h = Math.max(2, Math.round(v / max * 6));
        const c = v <= 0 ? '#2a3d36' : (i > 0 && vals[i - 1] > 0 && v < vals[i - 1] ? '#e05a5a' : '#4caf7d');
        return `<rect x="${i * 12}" y="${6 - h}" width="8" height="${h}" rx="1" fill="${c}"/>`;
      }).join('');
      return `<svg viewBox="0 0 96 6" preserveAspectRatio="none" style="width:100%;height:6px;display:block">${bars}</svg>`;
    };
    const cards = sorted.map(p => {
      /* v3.5 三口径（AC-U1）：主 C 总收益 + 副 A 账户增值 + 副 B 本金回报 */
      const extInv = p.extInvested != null && p.extInvested > 0 ? p.extInvested : (p.invested - ((p.invested || 0) - (p.amount || 0) - ((p.monthlyFlow || []).reduce((s, m) => s + m.amount, 0))));
      const inv = p.invested > 0 ? p.invested : p.amount;
      const gainC = inv > 0 ? (p.finalValue + p.cumDiv - inv) / inv * 100 : null;   /* 总收益（分红也算） */
      const gainA = inv > 0 ? (p.finalValue / inv - 1) * 100 : null;               /* 账户增值（含再投成本） */
      const gainB = p.amount > 0 ? (p.finalValue / p.amount - 1) * 100 : null;     /* 本金回报（只看初始） */
      const fmtPct = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
      const cColor = gainC == null ? 'var(--muted)' : gainC >= 0 ? 'var(--green,#4caf7d)' : 'var(--red,#e05a5a)';
      const wPct = lastW ? (lastW.weights[p.code] || 0) : null; /* 市值占比（weightEvol 末点=当前，与 finalValue 同源） */
      const contrib = (((p.finalValue - p.invested) + p.cumDiv) / (Math.abs(ps.reduce((s, q) => s + ((q.finalValue - q.invested) + q.cumDiv), 0)) || 1)) * 100;
      const cagr = p.ret != null && p.ret > -1 ? (Math.pow(1 + p.ret, 1 / Math.max(1, (res.span || 10))) - 1) * 100 : null;
      const dy = p.cumDiv > 0 && p.amount > 0 ? p.cumDiv / p.amount * 100 : null;
      const badge = dy == null ? '<span style="font-size:10px;color:var(--muted)">—</span>' : dy >= 6 ? '<span style="font-size:10px;background:rgba(76,175,125,.2);color:#4caf7d;border-radius:4px;padding:1px 5px">高息</span>' : dy >= 4 ? '<span style="font-size:10px;background:rgba(217,164,65,.18);color:#d9a441;border-radius:4px;padding:1px 5px">中息</span>' : '<span style="font-size:10px;background:rgba(224,90,90,.15);color:#e05a5a;border-radius:4px;padding:1px 5px">低息</span>';
      let indTxt = null;
      try { indTxt = industryForSync(p.code, p.name); } catch (e) {}
      const indBadge = `<span style="font-size:10px;background:rgba(90,169,230,.14);color:#5aa9e6;border-radius:4px;padding:1px 5px">${indTxt || '行业待确认'}</span>`;
      let pct = null;
      try { const s = pool && pool[p.code] && pool[p.code].series; if (s && s.length) { const last = s[s.length - 1]; if (last && last.pct != null) pct = last.pct; } } catch (e) {}
      const pctBadge = pct == null ? '' : (pct <= 30 ? '<span style="font-size:10px;background:rgba(76,175,125,.2);color:#4caf7d;border-radius:4px;padding:1px 5px">便宜</span>' : pct >= 70 ? '<span style="font-size:10px;background:rgba(224,90,90,.15);color:#e05a5a;border-radius:4px;padding:1px 5px">贵</span>' : '<span style="font-size:10px;background:rgba(143,166,156,.15);color:var(--muted);border-radius:4px;padding:1px 5px">中性</span>');
      /* v3.4 S7：分红缩水预警——保留在卡片（大师 R7 P2-1：风险信号一屏可见） */
      let shrinkWarn = '';
      try {
        const yd = p.yearlyDivs || {};
        const ys = Object.keys(yd).sort();
        if (ys.length >= 2) {
          const ly = ys[ys.length - 1], py = ys[ys.length - 2];
          if (yd[py] > 0 && yd[ly] > 0 && (yd[ly] - yd[py]) / yd[py] <= -0.2) shrinkWarn = `<span style="font-size:10px;background:rgba(224,90,90,.15);color:#e05a5a;border-radius:4px;padding:1px 5px">⚠️ 分红缩水 ${((yd[ly] - yd[py]) / yd[py] * 100).toFixed(0)}%</span>`;
        }
      } catch (e) {}
      /* v3.5 市值占比横条（主口径，tooltip 标截至日期——大师 R5 P1-1） */
      const mktBar = wPct == null ? '' : `<div style="display:flex;align-items:center;gap:5px;margin-top:2px" title="市值占比（截至 ${lastDate}）：${wPct.toFixed(1)}%">
        <span style="font-size:10px;color:var(--muted);flex:none">组合占比</span>
        <div class="v3-track" style="flex:1;height:5px"><div class="v3-fill" style="width:${Math.min(100, Math.max(0, wPct))}%;background:var(--gold,#d9a441)"></div></div>
        <span style="font-size:10px;font-weight:700;color:var(--gold,#d9a441);flex:none">${wPct.toFixed(1)}%</span>
      </div>`;
      /* v3.5 三口径同屏（主 C + 副 A/B，hover 显公式——R7 定稿） */
      const trio = `<div style="display:flex;flex-direction:column;gap:2px">
        <div style="display:flex;align-items:baseline;gap:6px" title="总收益 = (现值 + 分红到手 − 累计投入) ÷ 累计投入（分红也算收益）">
          <span style="font-size:22px;font-weight:800;color:${cColor}">${fmtPct(gainC)}</span>
          <span style="font-size:10px;color:var(--muted)">总收益 · 分红也算</span>${badge}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--muted)">
          <span title="账户增值 = 现值 ÷ 累计投入 − 1（分红再投算入成本）">账户增值 <b style="color:var(--fg,#e8efe9)">${fmtPct(gainA)}</b></span>
          <span title="本金回报 = 现值 ÷ 初始本金 − 1（只看最初那笔）">本金回报 <b style="color:var(--fg,#e8efe9)">${fmtPct(gainB)}</b></span>
        </div>
      </div>`;
      const grid = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:10px;color:var(--muted)">
          <span>投入 <b style="color:var(--fg,#e8efe9)">${(p.amount / 10000).toFixed(1)}万</b></span><span>现值 <b style="color:var(--fg,#e8efe9)">${(p.finalValue / 10000).toFixed(1)}万</b></span>
          <span>累计分红 <b style="color:#d9a441">+${(p.cumDiv / 10000).toFixed(1)}万</b></span><span>年化 <b style="color:var(--fg,#e8efe9)">${cagr != null ? (cagr >= 0 ? '+' : '') + cagr.toFixed(1) + '%' : '—'}</b></span>
        </div>`;
      return `<div class="v3-stock-card" data-code="${esc(p.code)}" style="background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:6px;min-width:0;cursor:pointer" title="点击看逐年详情">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap"><b style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</b><span style="font-size:10px;color:var(--muted)">${esc(p.code || '')}</span>${indBadge}${pctBadge}${shrinkWarn}<span style="margin-left:auto;width:8px;height:8px;border-radius:50%;background:${p.cumDiv > 0 ? '#4caf7d' : '#d9a441'}" title="分红数据：${p.cumDiv > 0 ? '有' : '缓存'}"></span></div>
        ${trio}
        ${grid}
        ${mktBar}
        <div style="display:flex;align-items:center;gap:4px">收益贡献 <div class="v3-track" style="flex:1"><div class="v3-fill" style="width:${Math.min(100, Math.max(0, contrib))}%"></div></div><span style="font-size:10px;color:var(--gold,#d9a441);font-weight:700">${contrib >= 0 ? '+' : ''}${contrib.toFixed(0)}%</span></div>
        ${svgSpark(p.navSeries)}
        ${divSpark(p.yearlyDivs)}
      </div>`;
    });
    const sortSel = `<select id="stockSortSel" style="font-size:10px;padding:2px 4px;background:var(--card);border:1px solid var(--line);border-radius:6px;color:var(--txt)">
      <option value="mkt" ${window._stockSortKey === 'mkt' ? 'selected' : ''}>按市值占比</option>
      <option value="gain" ${window._stockSortKey === 'gain' ? 'selected' : ''}>按总收益</option>
      <option value="name" ${window._stockSortKey === 'name' ? 'selected' : ''}>按名称</option>
    </select>`;
    return `<div style="margin-top:8px;background:var(--card2);border-radius:10px;border:1px solid var(--line);padding:8px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap"><span style="font-size:12px;font-weight:700">🧩 每只股票</span><span style="font-size:10px;color:var(--muted)">总收益/账户增值/本金回报三口径 · 市值占比=当前 · 点卡片看逐年详情</span><span style="margin-left:auto">${sortSel}</span></div>
      <div class="v3-stock-grid" id="stockCardsGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">${cards.join('')}</div>
    </div>`;
  }

  /* v3.5 AC-U3/U4：个股逐年详情面板（弹层内嵌）
   * 摘要条（三口径+市值占比）→ 年表 8 列 → 双柱图（分红/收益）→ 金额轴曲线（叠投入线，日粒度按钮）→ 占比演化（市值vs投入双线） */
  function renderStockDetail(res, p) {
    const yl = p.yearly || [];
    const extInv = p.extInvested != null && p.extInvested > 0 ? p.extInvested : p.amount;
    const inv = p.invested > 0 ? p.invested : p.amount;
    const gainC = inv > 0 ? (p.finalValue + p.cumDiv - inv) / inv * 100 : null;
    const gainA = inv > 0 ? (p.finalValue / inv - 1) * 100 : null;
    const gainB = p.amount > 0 ? (p.finalValue / p.amount - 1) * 100 : null;
    const fmtPct = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
    const lastW = (res.weightEvol && res.weightEvol.length) ? res.weightEvol[res.weightEvol.length - 1] : null;
    const wPct = lastW ? (lastW.weights[p.code] || 0) : null;
    const lastDate = (res.totalAsset && res.totalAsset.length) ? res.totalAsset[res.totalAsset.length - 1].d : '';
    /* 摘要条 */
    const sum = `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;padding-bottom:8px;border-bottom:1px solid var(--line);margin-bottom:8px">
      <span style="font-size:18px;font-weight:800;color:${gainC != null && gainC >= 0 ? 'var(--green,#4caf7d)' : 'var(--red,#e05a5a)'}" title="总收益 = (现值+分红到手−累计投入)÷累计投入（分红也算）">总收益 ${fmtPct(gainC)}</span>
      <span style="font-size:11px;color:var(--muted)" title="账户增值 = 现值÷累计投入−1（分红再投算入成本）">账户增值 ${fmtPct(gainA)}</span>
      <span style="font-size:11px;color:var(--muted)" title="本金回报 = 现值÷初始本金−1（只看最初那笔）">本金回报 ${fmtPct(gainB)}</span>
      <span style="font-size:11px;color:var(--muted)">累计分红率 <b style="color:#d9a441">${p.divRatio != null ? p.divRatio.toFixed(1) + '%' : '—'}</b></span>
      <span style="font-size:11px;color:var(--muted)">投入 <b>${(p.amount / 10000).toFixed(1)}万</b> → 现值 <b>${(p.finalValue / 10000).toFixed(1)}万</b></span>
      ${wPct != null ? `<span style="font-size:11px;color:var(--muted)" title="截至 ${lastDate}">市值占比 <b style="color:var(--gold,#d9a441)">${wPct.toFixed(1)}%</b></span>` : ''}
      <span style="margin-left:auto;font-size:10px;color:var(--muted)">👆 点击面板任意处收起</span>
    </div>`;
    /* 年表 8 列：年份/年初市值/年末市值/当年追加/当年分红/当年收益/年末占比/占比变化 */
    const lastWPrev = (res.weightEvol && res.weightEvol.length > 1) ? res.weightEvol[res.weightEvol.length - 2] : null;
    const wPctPrev = lastWPrev ? (lastWPrev.weights[p.code] || 0) : null;
    const rows = yl.map((y, i) => {
      const prev = i > 0 ? yl[i - 1] : null;
      const begVal = prev ? prev.value : 0;
      const wNow = lastW ? (lastW.weights[p.code] || 0) : null;
      const wPrevY = (res.weightEvol || []).find(w => w.y === y.y);
      const wY = wPrevY ? (wPrevY.weights[p.code] || 0) : null;
      const wDiff = wY != null && wPrevY ? 0 : null; /* 占比变化=本年 vs 去年末 */
      const wYPrev = i > 0 ? (res.weightEvol || []).find(w => w.y === yl[i - 1].y) : null;
      const wDiffTxt = (wY != null && wYPrev) ? ((wY - (wYPrev.weights[p.code] || 0)) >= 0 ? '+' : '') + (wY - (wYPrev.weights[p.code] || 0)).toFixed(1) + 'pp' : '—';
      const gainTxt = y.gain >= 0 ? `<span style="color:#e05a5a;font-weight:600">+${(y.gain / 10000).toFixed(1)}万</span>` : `<span style="color:#4caf7d">${(y.gain / 10000).toFixed(1)}万</span>`;
      const divTxt = y.div > 0 ? `<span style="color:#d9a441">${(y.div / 10000).toFixed(2)}万</span>` : '<span style="color:var(--muted)">—</span>';
      return `<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px;text-align:left;font-weight:600">${y.y}</td>
        <td style="padding:3px 6px;text-align:right">${begVal > 0 ? (begVal / 10000).toFixed(1) + '万' : '<span style="color:var(--muted)">起投</span>'}</td>
        <td style="padding:3px 6px;text-align:right">${(y.value / 10000).toFixed(1)}万</td>
        <td style="padding:3px 6px;text-align:right">${y.added > 0 ? (y.added / 10000).toFixed(2) + '万' : '<span style="color:var(--muted)">—</span>'}</td>
        <td style="padding:3px 6px;text-align:right">${divTxt}</td>
        <td style="padding:3px 6px;text-align:right">${gainTxt}</td>
        <td style="padding:3px 6px;text-align:right">${wY != null ? wY.toFixed(1) + '%' : '—'}</td>
        <td style="padding:3px 6px;text-align:right">${wDiffTxt}</td></tr>`;
    }).join('');
    const table = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:10px;margin-bottom:8px">
      <thead><tr style="color:var(--muted)"><th style="text-align:left;padding:3px 6px">年份</th><th style="text-align:right;padding:3px 6px">年初市值</th><th style="text-align:right;padding:3px 6px">年末市值</th><th style="text-align:right;padding:3px 6px">当年追加</th><th style="text-align:right;padding:3px 6px">当年分红</th><th style="text-align:right;padding:3px 6px">当年收益</th><th style="text-align:right;padding:3px 6px">年末占比</th><th style="text-align:right;padding:3px 6px">占比变化</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
    return sum + table + `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <div id="sdDivBar_${p.code}" style="flex:1;min-width:260px;height:150px;background:var(--card2);border-radius:8px;border:1px solid var(--line)"></div>
        <div id="sdGainBar_${p.code}" style="flex:1;min-width:260px;height:150px;background:var(--card2);border-radius:8px;border:1px solid var(--line)"></div>
      </div>
      <div style="margin-bottom:4px;display:flex;align-items:center;gap:6px"><span style="font-size:10px;color:var(--muted)">📈 市值曲线（金额轴，叠累计投入）</span><button type="button" class="chip" id="sdDailyBtn_${p.code}" style="font-size:10px;padding:1px 8px">🔍 日粒度</button><span style="font-size:10px;color:var(--muted)" id="sdDailyHint_${p.code}"></span></div>
      <div id="sdCurve_${p.code}" style="width:100%;height:170px;background:var(--card2);border-radius:8px;border:1px solid var(--line);margin-bottom:8px"></div>
      <div style="margin-bottom:4px"><span style="font-size:10px;color:var(--muted)">🧭 占比演化：市值占比（实线）vs 投入占比（虚线）——偏离=跑赢/跑输组合</span></div>
      <div id="sdWeight_${p.code}" style="width:100%;height:150px;background:var(--card2);border-radius:8px;border:1px solid var(--line)"></div>
    `;
  }

  /* v3.5 个股详情图表初始化（双柱图/曲线/占比演化） */
  function initStockDetailCharts(res, p, det) {
    if (typeof echarts === 'undefined') return;
    const yl = p.yearly || [];
    const ys = yl.map(y => y.y);
    /* 双柱图 1：分红（金） */
    const dbEl = document.getElementById('sdDivBar_' + p.code);
    if (dbEl && yl.length) {
      const ch = echarts.init(dbEl);
      ch.setOption({
        title: { text: '📊 当年分红', left: 'center', top: 2, textStyle: { fontSize: 11, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 10 }, formatter: ps => { const y = ps[0].axisValue; const row = yl.find(x => x.y === y); return row ? `<b>${y}</b><br/>分红 <b style="color:#d9a441">${(row.div / 10000).toFixed(2)}万</b>（占年初市值 ${row.value > 0 ? (row.div / (yl[ys.indexOf(y)] && yl[ys.indexOf(y)].value || 1) * 100).toFixed(1) : 0}%）` : ''; } },
        grid: { left: 50, right: 12, top: 24, bottom: 20 },
        xAxis: { type: 'category', data: ys, axisLabel: { color: '#8fa69c', fontSize: 9 } },
        yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 9, formatter: v => v / 10000 + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        series: [{ type: 'bar', data: yl.map(y => +y.div.toFixed(2)), itemStyle: { color: '#d9a441', borderRadius: [2, 2, 0, 0] }, barMaxWidth: 14 }],
      });
    }
    /* 双柱图 2：当年收益（红涨绿跌，tooltip 拆两段：分红贡献 + 净值增长） */
    const gbEl = document.getElementById('sdGainBar_' + p.code);
    if (gbEl && yl.length) {
      const ch = echarts.init(gbEl);
      ch.setOption({
        title: { text: '📈 当年收益（红涨绿跌）', left: 'center', top: 2, textStyle: { fontSize: 11, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 10 }, formatter: ps => { const y = ps[0].axisValue; const row = yl.find(x => x.y === y); if (!row) return ''; const navGain = row.gain - row.div; return `<b>${y}</b><br/>当年收益 <b>${(row.gain / 10000).toFixed(1)}万</b><br/>· 分红贡献 <b style="color:#d9a441">+${(row.div / 10000).toFixed(2)}万</b><br/>· 净值增长（含再投效应）<b style="color:${navGain >= 0 ? '#e05a5a' : '#4caf7d'}">${(navGain / 10000).toFixed(1)}万</b>`; } },
        grid: { left: 50, right: 12, top: 24, bottom: 20 },
        xAxis: { type: 'category', data: ys, axisLabel: { color: '#8fa69c', fontSize: 9 } },
        yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 9, formatter: v => v / 10000 + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        series: [{ type: 'bar', data: yl.map(y => +y.gain.toFixed(2)), itemStyle: { color: p => p.value >= 0 ? '#e05a5a' : '#4caf7d', borderRadius: [2, 2, 0, 0] }, barMaxWidth: 14 }],
      });
    }
    /* 市值曲线（月粒度默认，日粒度按钮切换——simOne 重算降采样，AC-D4）
     * v3.6 F1（大师 P0-3）：月粒度改用 perStock 内嵌 mSeries（快照/缓存自包含），不再依赖外部 pool；日粒度需 simOne 重算，无 pool 时禁用按钮 */
    const cvEl = document.getElementById('sdCurve_' + p.code);
    if (cvEl) {
      const ch = echarts.init(cvEl);
      const t = res.totalAsset || [];
      const pool2 = _cockpitPool || {};
      const hasPool = !!(pool2[p.code] && pool2[p.code].kline);
      const draw = (granularity) => {
        let seriesData = [], investData = [];
        if (granularity === 'month' && p.mSeries && p.mSeries.length) {
          /* 内嵌月采样：快照/缓存/排序切换全部自包含 */
          seriesData = p.mSeries.map(m => [m.d, m.value]);
          investData = p.mSeries.map(m => [m.d, m.invested]);
        } else {
          const src = pool2[p.code];
          if (src && src.kline) {
            const sim = window.simOneCore ? window.simOneCore(p.amount, p.monthly || 0, src.kline, src.divs || [], true, 0) : null;
            if (sim) {
              const daily = sim.daily;
              if (granularity === 'month') {
                const bm = {};
                daily.forEach(dd => { bm[dd.date.slice(0, 7)] = dd; });
                const mks = Object.keys(bm).sort();
                seriesData = mks.map(m => [m + '-01', +(bm[m].value / 10000).toFixed(2)]);
                investData = mks.map(m => [m + '-01', +(bm[m].invested / 10000).toFixed(2)]);
              } else {
                seriesData = daily.map(dd => [dd.date, +(dd.value / 10000).toFixed(2)]);
                investData = daily.map(dd => [dd.date, +(dd.invested / 10000).toFixed(2)]);
              }
            }
          }
        }
        ch.setOption({
          /* v3.6.1 P0-1/P2-2（大师）：time 轴 axisValue 是时间戳 → 用 data[0] 取原始日期（对齐 4212 主图先例）；日期统一中文格式；加月分红到账行（mSeries.cumDiv 相邻差，旧快照 undefined 容错） */
          tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 10 }, formatter: ps => { if (!ps.length) return ''; const d = ps[0].data ? ps[0].data[0] : (typeof ps[0].axisValue === 'string' ? ps[0].axisValue : ''); if (!d) return ''; const mm = d.length >= 10 ? (Number(d.slice(5, 7)) + '月' + Number(d.slice(8, 10)) + '日') : ''; let s = `<b>${Number(d.slice(0, 4))}年${mm}</b><br/>市值 <b>${ps[0].value}万</b> · 累计投入 ${ps[1] ? ps[1].value + '万' : '—'}`;
            /* 月分红到账：mSeries 相邻 cumDiv 差（>0 金色行）；旧快照无 cumDiv 字段 → 跳过不崩 */
            try { const ms = p.mSeries || []; const idx = ms.findIndex(m => m.d === d); if (idx >= 0 && ms[idx].cumDiv != null) { const prev = idx > 0 ? (ms[idx - 1].cumDiv || 0) : 0; const md = ms[idx].cumDiv - prev; if (md > 0.0001) s += `<br/><span style="color:#d9a441">● 该月分红到账 ${md.toFixed(2)}万</span>`; } } catch (e) {}
            return s; } },
          legend: { top: 2, textStyle: { color: '#8fa69c', fontSize: 10 } },
          grid: { left: 50, right: 12, top: 26, bottom: 22 },
          xAxis: { type: 'time', axisLabel: { color: '#8fa69c', fontSize: 9 }, axisLine: { lineStyle: { color: '#2a3d36' } } },
          yAxis: { type: 'value', name: '金额(万)', nameTextStyle: { color: '#8fa69c', fontSize: 9 }, axisLabel: { color: '#8fa69c', fontSize: 9, formatter: v => v + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } }, scale: true },
          series: [
            { name: '市值', type: 'line', data: seriesData, smooth: true, showSymbol: false, lineStyle: { color: 'rgba(60,150,110,.85)', width: 2 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(60,150,110,.2)' }, { offset: 1, color: 'rgba(60,150,110,.02)' }] } } },
            { name: '累计投入', type: 'line', data: investData, smooth: true, showSymbol: false, lineStyle: { color: '#d9a441', width: 1.2, type: 'dashed' } },
          ],
        });
      };
      draw('month');
      const btn = document.getElementById('sdDailyBtn_' + p.code);
      const hint = document.getElementById('sdDailyHint_' + p.code);
      let isDaily = false;
      if (btn && hint) {
        if (!hasPool) {
          /* v3.6 F1（大师 P1-1）：快照/缓存模式无 K线池 → 禁用日粒度，防切了空白 */
          btn.disabled = true;
          btn.style.opacity = .45;
          btn.title = '快照/缓存模式仅月粒度（重跑体检后可切日粒度）';
          hint.textContent = '· 快照模式仅月粒度';
        }
        btn.onclick = () => {
          isDaily = !isDaily;
          draw(isDaily ? 'day' : 'month');
          btn.textContent = isDaily ? '📅 月粒度' : '🔍 日粒度';
          hint.textContent = isDaily ? '· 已切换日粒度（simOne 重算）' : '';
        };
      }
    }
    /* 占比演化：市值占比（实线）vs 投入占比（虚线） */
    const wEl = document.getElementById('sdWeight_' + p.code);
    if (wEl && res.weightEvol && res.weightEvol.length) {
      const ch = echarts.init(wEl);
      const we = res.weightEvol;
      const totalInv = res.invested || 1;
      const mktLine = we.map(w => +((w.weights[p.code] || 0)).toFixed(1));
      const invLine = we.map(w => {
        const yEnd = w.y;
        const row = (p.yearly || []).find(x => x.y === yEnd);
        return row ? +((row.extInvested || 0) / totalInv * 100).toFixed(1) : 0;
      });
      ch.setOption({
        title: { text: '占比演化：市值 vs 投入（偏离=跑赢/跑输）', left: 'center', top: 2, textStyle: { fontSize: 11, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 10 }, formatter: ps => { if (!ps.length) return ''; const y = ps[0].axisValue; const m = mktLine[we.findIndex(w => w.y === y)]; const iv = invLine[we.findIndex(w => w.y === y)]; return `<b>${y}</b><br/>市值占比 <b>${m.toFixed(1)}%</b><br/>投入占比 <b>${iv.toFixed(1)}%</b><br/>偏离 <b style="color:${m - iv >= 0 ? '#e05a5a' : '#4caf7d'}">${(m - iv >= 0 ? '+' : '') + (m - iv).toFixed(1)}pp</b>`; } },
        legend: { top: 14, textStyle: { color: '#8fa69c', fontSize: 10 } },
        grid: { left: 42, right: 12, top: 38, bottom: 22 },
        xAxis: { type: 'category', data: we.map(w => w.y), axisLabel: { color: '#8fa69c', fontSize: 9 } },
        yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 9, formatter: v => v + '%' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        series: [
          { name: '市值占比', type: 'line', data: mktLine, smooth: true, showSymbol: false, lineStyle: { color: 'rgba(60,150,110,.9)', width: 2 } },
          { name: '投入占比', type: 'line', data: invLine, smooth: true, showSymbol: false, lineStyle: { color: '#d9a441', width: 1.5, type: 'dashed' } },
        ],
      });
    }
  }

  /* v3.5 N6：数据完整性动态清单（从 res 实际字段遍历生成——有=✅ 无=❌灰，防手写清单随版本腐化） */
  function renderDataCompleteness(res) {
    const has = (v) => v != null && v !== 0 && v !== '' && v !== false;
    const items = [
      ['总共赚了（hero）', has(res.last) && has(res.last.value) && has(res.last.invested), 'last.value/invested'],
      ['累计分红率', has(res.divRatio), 'res.divRatio'],
      ['年分红（最近完整年）', has(res.yearDiv), 'res.yearDiv'],
      ['期末总资产', has(res.last) && has(res.last.value), 'res.last.value'],
      ['回本年限', has(res.yearDiv) && has(res.invested), 'res.invested/res.yearDiv'],
      ['年度战绩表（7列）', has(res.totalAsset) && res.totalAsset.length > 0, 'buildYearTable'],
      ['市值曲线（金额轴）', has(res.totalAsset) && res.totalAsset.length > 1, 'res.totalAsset[].value'],
      ['累计投入线', has(res.totalAsset) && res.totalAsset.some(x => has(x.invested)), 'res.totalAsset[].invested'],
      ['分红日标记点', has(res.totalAsset) && res.totalAsset.some(x => has(x.cumDiv)), 'res.totalAsset[].cumDiv'],
      ['回撤副图', has(res.totalAsset) && res.totalAsset.length > 1, '峰值回撤计算'],
      ['分红节奏（日/月/年）', has(res.divByYear) && Object.keys(res.divByYear).length > 0, 'res.divByYear'],
      ['权重演化（逐年）', has(res.weightEvol) && res.weightEvol.length > 0, 'res.weightEvol'],
      ['收益贡献图', has(res.perStock) && res.perStock.length > 0, 'res.perStock[].cumDiv/finalValue'],
      ['组合股息日历', has(res.perStock), 'pool.divs 未来12月'],
      ['快照对比 A/B', true, '同组合不同配置重跑'],
      ['分析工具（再平衡/敏感度/压力/倒推）', true, '按需计算'],
      ['个股卡片（总数据+三口径+占比）', has(res.perStock) && res.perStock.some(p => has(p.yearly)), 'perStock[].yearly/extInvested'],
      ['个股逐年详情（8列+图）', has(res.perStock) && res.perStock.some(p => has(p.yearly) && p.yearly.length > 0), 'perStock[].yearly'],
      ['占比三口径（市值/投入/贡献）', has(res.weightEvol) && has(res.invested), 'weightEvol + invested'],
      ['数据完整性清单（本项）', true, '动态遍历'],
    ];
    const rows = items.map(([name, ok, src]) => `<tr style="border-top:1px solid var(--line)">
      <td style="padding:2px 6px;text-align:left">${ok ? '<span style="color:#4caf7d">✅</span>' : '<span style="color:#2a3d36">❌</span>'} ${name}</td>
      <td style="padding:2px 6px;text-align:left;color:var(--muted)">${src}</td>
    </tr>`).join('');
    return `<details class="v3-fold" style="margin-top:6px"><summary>📋 数据完整性清单（${items.filter(x => x[1]).length}/${items.length} 项就绪 · 动态生成）</summary>
      <div style="font-size:10px;color:var(--muted);margin-top:4px">从回测结果实际字段遍历，缺项标 ❌——版本升级后自动更新，不会腐化</div>
      <table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:4px"><thead><tr style="color:var(--muted)"><th style="text-align:left;padding:2px 6px">数据项</th><th style="text-align:left;padding:2px 6px">来源字段</th></tr></thead><tbody>${rows}</tbody></table>
    </details>`;
  }

  /* v3.4 AC-38：年度表行点击 → 弹该年月度明细（hover 只高亮不弹，点击才弹；点明细任意处收起） */
  function bindYearRowClick(res, yt) {
    try {
      const t = res.totalAsset || [];
      const divByDay = {};
      let prevCum = 0;
      t.forEach(x => { const d = x.cumDiv - prevCum; if (d > 0.005) divByDay[x.d] = d; prevCum = x.cumDiv; });
      const monthRows = {};
      t.forEach(x => {
        const m = x.d.slice(0, 7);
        if (!monthRows[m] || x.d > monthRows[m].d) monthRows[m] = { d: x.d, value: x.value, invested: x.invested, div: (divByDay[x.d] || 0) };
      });
      yt.querySelectorAll('tbody tr').forEach(tr => {
        tr.style.cursor = 'pointer';
        tr.title = '点击查看该年月度明细';
        tr.onclick = () => {
          const y = (tr.querySelector('td') || {}).textContent || '';
          const ms = Object.keys(monthRows).filter(m => m.startsWith(y)).sort();
          const cur = document.getElementById('yearMonthDetail');
          if (cur) cur.remove();
          if (!ms.length) return;
          const rows = ms.map(m => {
            const r = monthRows[m];
            const mm = Number(m.slice(5)) + '月';
            return `<tr style="border-top:1px solid var(--line)"><td style="padding:3px 8px">${y}年${mm}</td><td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums">${(r.value / 10000).toFixed(2)}万</td><td style="padding:3px 8px;text-align:right;font-variant-numeric:tabular-nums">${(r.invested / 10000).toFixed(2)}万</td><td style="padding:3px 8px;text-align:right">${r.div > 0 ? `<span style="color:#d9a441">+${(r.div / 10000).toFixed(2)}万</span>` : '<span style="color:var(--muted)">—</span>'}</td></tr>`;
          }).join('');
          const det = document.createElement('div');
          det.id = 'yearMonthDetail';
          det.style.cssText = 'margin-top:4px;padding:6px 8px;background:var(--card);border:1px solid var(--line);border-radius:8px;font-size:11px';
          det.innerHTML = `<div style="color:var(--muted);margin-bottom:2px">📅 ${y}年 月度明细（月末值 · 点击任意处收起）</div>
            <table style="width:100%;border-collapse:collapse;font-size:10px"><thead><tr style="color:var(--muted)"><th style="text-align:left;padding:3px 8px">月</th><th style="text-align:right;padding:3px 8px">月末市值</th><th style="text-align:right;padding:3px 8px">累计投入</th><th style="text-align:right;padding:3px 8px">当月分红</th></tr></thead><tbody>${rows}</tbody></table>`;
          det.onclick = () => det.remove();
          tr.after(det);
        };
      });
    } catch (e) { }
  }

  /* v3.2 S12：组合级 XIRR（现金流：初始投入负流 + 月追加负流 + 期末市值正流） */
  function comboXirr(res) {
    try {
      const t = res.totalAsset || [];
      if (!t.length) return null;
      const first = t[0], last = t[t.length - 1];
      const flows = [{ d: first.d, v: -res.invested }];
      const mfMap = {};
      (res.perStock || []).forEach(p => (p.monthlyFlow || []).forEach(m => { mfMap[m.date] = (mfMap[m.date] || 0) + m.amount; }));
      Object.keys(mfMap).sort().forEach(d => flows.push({ d, v: -mfMap[d] }));
      flows.push({ d: last.d, v: last.value });
      if (flows.length < 2 || typeof calcXirr !== 'function') return null;
      const x = calcXirr(flows);
      return x != null ? x * 100 : null;
    } catch (e) { return null; }
  }
  /* v3.2 S12：快照对比面板（A/B——数字卡并排 + 曲线叠加 + 年度表并排 + 差异>10%绿箭头>30%加粗） */
  async function renderSnapCompare(container) {
    try {
      const metas = await btListSnapshots();
      if (!metas.length) { container.innerHTML = '<div class="hint" style="font-size:11px">还没有快照——跑一次组合回测自动生成，点「📌 固定此快照」可保留多个对比</div>'; return; }
      container.innerHTML = `<div style="font-size:11px;color:var(--sub);margin-bottom:6px">选两个快照对比（同一组合不同配置：复投率/年限/月追加）：</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select id="scA" style="flex:1;min-width:160px;background:var(--card2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:6px 8px;font-size:11px"></select>
          <span style="color:var(--sub)">vs</span>
          <select id="scB" style="flex:1;min-width:160px;background:var(--card2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:6px 8px;font-size:11px"></select>
        </div>
        <div id="scOut" style="margin-top:8px"></div>`;
      const mkOpt = (m, i) => `<option value="${esc(m.id)}">${esc(m.name || '快照')} · ${m.y || 10}年 · ${m.mode || 'weight'} · ${m.at ? new Date(m.at).toLocaleString().slice(5, 16) : ''}</option>`;
      const selA = container.querySelector('#scA'), selB = container.querySelector('#scB');
      selA.innerHTML = metas.map(mkOpt).join('');
      selB.innerHTML = metas.map(mkOpt).join('');
      selB.selectedIndex = metas.length > 1 ? 1 : 0;
      const draw = async () => {
        const out = container.querySelector('#scOut');
        const a = await DL.btGet('full:' + selA.value), b = await DL.btGet('full:' + selB.value);
        if (!a || !b || !a.res || !b.res) { out.innerHTML = '<div class="hint err">快照数据缺失</div>'; return; }
        const ra = a.res, rb = b.res;
        const xa = comboXirr(ra), xb = comboXirr(rb);
        const card = (label, va, vb, fmt) => {
          const d = (vb != null && va != null) ? vb - va : null;
          const diff = d != null && va !== 0 ? `<span style="font-size:10px;${Math.abs(d / Math.abs(va)) > 0.3 ? 'font-weight:800;' : ''}color:${d >= 0 ? '#4caf7d' : '#e05a5a'}">${d >= 0 ? '▲' : '▼'}${fmt(d)}</span>` : '';
          return `<div style="flex:1;min-width:120px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px;text-align:center">
            <div style="font-size:10px;color:var(--muted)">${label}</div>
            <div style="font-size:15px;font-weight:700;margin-top:2px">${fmt(va)}</div>
            <div style="font-size:15px;font-weight:700;color:${vb >= va ? '#4caf7d' : '#e05a5a'}">${fmt(vb)}</div>
            <div style="margin-top:2px">${diff}</div>
          </div>`;
        };
        out.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          ${card('期末资产', ra.last.value, rb.last.value, v => (v / 10000).toFixed(1) + '万')}
          ${card('累计分红率', ra.divRatio, rb.divRatio, v => v.toFixed(1) + '%')}
          ${card('年分红', ra.yearDiv, rb.yearDiv, v => (v / 10000).toFixed(2) + '万')}
          ${card('XIRR', xa, xb, v => (v != null ? v.toFixed(1) + '%' : '—'))}
        </div>
        <div id="scChart" style="width:100%;height:180px;background:var(--card);border:1px solid var(--line);border-radius:10px"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <div style="flex:1;min-width:260px">${renderYearTable(ra, null, 'desc')}</div>
          <div style="flex:1;min-width:260px">${renderYearTable(rb, null, 'desc')}</div>
        </div>`;
        if (typeof echarts !== 'undefined') {
          const base = ra.totalAsset[0] && ra.totalAsset[0].value > 0 ? ra.totalAsset[0].value : 1;
          const ch = echarts.init(out.querySelector('#scChart'));
          ch.setOption({
            tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 } },
            legend: { top: 2, textStyle: { color: '#8fa69c', fontSize: 10 } },
            grid: { left: 56, right: 14, top: 30, bottom: 24 },
            xAxis: { type: 'time', axisLabel: { color: '#8fa69c', fontSize: 10 }, axisLine: { lineStyle: { color: '#2a3d36' } } },
            yAxis: { type: 'value', scale: true, axisLabel: { color: '#8fa69c', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
            series: [
              { name: 'A', type: 'line', data: ra.totalAsset.map(x => [x.d, x.value / base]), smooth: true, showSymbol: false, lineStyle: { color: '#5aa9e6', width: 2 } },
              { name: 'B', type: 'line', data: rb.totalAsset.map(x => [x.d, x.value / base]), smooth: true, showSymbol: false, lineStyle: { color: '#d9a441', width: 2 } },
            ],
            animationDuration: 600,
          });
        }
      };
      selA.onchange = draw; selB.onchange = draw;
      draw();
    } catch (e) { container.innerHTML = '<div class="hint err">对比加载失败：' + esc(e.message || '') + '</div>'; }
  }

  /* 三问卡 + 驾驶舱渲染 */
  function renderCockpit(res, combo, pool, meta) {
    const el = $('#pfbtResult');
    if (!el) return;
    /* v3.6 F2（大师 P0-2）：旧快照 schema 校验必须在读 res.last 之前——v3.4.3 快照无 weightEvol（v3.5 分水岭字段），后面 4261 .map 会 TypeError 整页崩 */
    const metaVer = (meta && meta.ver) || '';
    const curVer = (typeof APP_VERSION !== 'undefined') ? APP_VERSION : '';
    const oldSchema = !res || !res.weightEvol || !res.perStock || !res.perStock.length || (metaVer && curVer && metaVer !== curVer);
    if (oldSchema) {
      const cmb = (res && res.perStock && res.perStock.length) ? res.perStock : [];
      const gV = (res && res.last && res.last.value != null) ? (res.last.value / 10000).toFixed(0) : '—';
      const gD = (res && res.cumDivTotal != null) ? (res.cumDivTotal / 10000).toFixed(0) : '—';
      const gI = (res && res.invested != null) ? (res.invested / 10000).toFixed(0) : '—';
      const rows = cmb.map(p => `<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px;text-align:left">${esc(p.name || p.code)}</td><td style="padding:3px 6px;text-align:right">${p.finalValue != null ? (p.finalValue / 10000).toFixed(1) + '万' : '—'}</td><td style="padding:3px 6px;text-align:right">${p.cumDiv != null ? '+' + (p.cumDiv / 10000).toFixed(1) + '万' : '—'}</td></tr>`).join('');
      el.innerHTML = `<div style="padding:16px;border:1px solid rgba(217,164,65,.4);border-radius:12px;background:rgba(217,164,65,.06)">
        <div style="font-size:14px;font-weight:700;color:var(--gold,#d9a441)">📦 旧版快照（${esc(metaVer || '旧版本')}）· 无逐年数据</div>
        <div style="font-size:12px;color:var(--sub);margin:8px 0">当前工具 ${esc(curVer)} 需要重跑体检才能展示市值曲线/逐年明细（旧快照不含这些字段）。组合总览仍可看：</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin:8px 0;font-size:13px"><span>投入 <b>${gI}万</b></span><span>现值 <b>${gV}万</b></span><span>累计分红 <b style="color:#d9a441">${gD}万</b></span></div>
        ${cmb.length ? `<table style="width:100%;border-collapse:collapse;font-size:11px;margin:6px 0"><thead><tr style="color:var(--muted)"><th style="text-align:left;padding:3px 6px">股票</th><th style="text-align:right;padding:3px 6px">现值</th><th style="text-align:right;padding:3px 6px">累计分红</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
        <button type="button" class="btn flexbtn" onclick="document.getElementById('pfbtRun') && document.getElementById('pfbtRun').click()">🔄 重跑体检（更新到最新版）</button>
      </div>`;
      try { const anc = document.getElementById('pfbtAnchor'); if (anc) anc.style.display = 'none'; } catch (e) { }
      return;
    }
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
    /* v3.4 总卡：3 核心数字 + 流水线 + 迷你曲线(分红日标记点) + 回本环 + 点击展开（P26-P30） */
    /* v3.5 AC-F3 口径一致性：hero 主口径改为 C 全收益（现值+分红到手−累计投入）÷累计投入——与卡片大字同口径，防同屏两数打架（R7 P1-2） */
    const cumDivTotal2 = (res.perStock || []).reduce((s, p) => s + (p.cumDiv || 0), 0);
    const hero = (last.invested > 0 && cumDivTotal2 > 0) ? ((last.value + cumDivTotal2 - last.invested) / last.invested * 100) : (last.invested > 0 ? ((last.value / last.invested - 1) * 100) : null);
    const heroTxt = hero == null ? '—' : (hero >= 0 ? '+' : '') + hero.toFixed(1) + '%';
    const heroC = hero == null ? 'var(--muted)' : hero >= 4 ? 'var(--green,#4caf7d)' : hero >= 0 ? 'var(--gold,#d9a441)' : 'var(--red,#e05a5a)';
    const priceTotal2 = (res.perStock || []).reduce((s, p) => s + ((p.finalValue || 0) - (p.invested || 0)), 0);
    const monthlySpend = yearDiv / 12;
    const summaryHtml = `<div class="v3-summary" id="pfbtSummary" onclick="document.getElementById('pfbtAnchor') && document.getElementById('pfbtAnchor').scrollIntoView({behavior:'smooth'})">
      <div class="v3-summary-main">
        <div style="font-size:11px;color:var(--muted);font-weight:600">总共赚了（含分红再投+月追加）</div>
        <div class="hero" style="color:${heroC}">${heroTxt}</div>
        <div class="pipe">投入 <b>${(invested / 10000).toFixed(1)}万</b> → 现值 <b>${(last.value / 10000).toFixed(1)}万</b> → 分红到手 <b style="color:var(--gold)">${(cumDivTotal2 / 10000).toFixed(2)}万</b></div>
        <div class="meta"><span>价格贡献 <b style="color:${priceTotal2 >= 0 ? '#e05a5a' : '#4caf7d'}">${priceTotal2 >= 0 ? '+' : ''}${(priceTotal2 / 10000).toFixed(1)}万</b></span><span>分红贡献 <b style="color:var(--gold)">+${(cumDivTotal2 / 10000).toFixed(1)}万</b></span><span>每月可花 <b>${(monthlySpend / 10000).toFixed(2)}万</b></span></div>
      </div>
      <div class="v3-summary-side">
        <div class="mini-chart" id="pfbtMiniCurve" title="hover 看某天：值/分红"></div>
        <div style="display:flex;align-items:center;gap:8px">
          <svg viewBox="0 0 40 40" style="width:40px;height:40px;flex:none"><circle cx="20" cy="20" r="17" fill="none" stroke="var(--line)" stroke-width="5"/><circle cx="20" cy="20" r="17" fill="none" stroke="var(--gold)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${payback !== '—' ? (Math.min(100, Math.min(100, invested / yearDiv * 12)) / 100 * 106.8).toFixed(1) : 0} 106.8" transform="rotate(-90 20 20)"/></svg>
          <div style="font-size:11px;color:var(--muted)"><div>回本速度</div><b style="color:var(--txt);font-size:13px">${payback}</b></div>
        </div>
        <div class="hint-open">👆 点击查看完整汇报 ↓</div>
      </div>
    </div>`;
    /* v3.4 KPI 行（4 卡）：累计分红率/年分红/期末资产/回本年限 */
    let html = summaryHtml + `<div class="v3-kpi-row">
      ${card(q1, q1sub, q1c, true)}
      ${card(q2, q2sub, q2c, true)}
      ${card(q3, q3sub, q3c, true)}
      ${card(payback, '回本年限（按当前年分红）', payback !== '—' ? 'var(--txt)' : 'var(--muted)', true)}
    </div>`;
    /* v3.2 S3：年度战绩表（第一屏·分红列优先）——插入 KPI 行之下、主图之上 */
    const yearTableId = 'cockpitYearTable_' + Date.now();
    let sortKey = null, sortDir = 'desc';
    html += `<div id="${yearTableId}" style="margin-bottom:8px">${renderYearTable(res, sortKey, sortDir)}</div>`;
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
    /* 主图（金额轴 + 双基准 + 下挂回撤副图——v3.2 S5/D3 + v3.4 主人令） */
    html += `<div id="cockpitMain" style="width:100%;height:320px;margin-top:4px"></div>`;
    /* v3.5 N6：数据完整性动态清单（从 res 实际字段遍历，有=✅ 无=❌灰——防手写清单随版本腐化） */
    html += renderDataCompleteness(res);
    /* v3.4 P9：16 图平铺→折叠面板——辅助图区分组折叠，默认开 ①体检三件套 ②分红节奏；其余点开才显（长页不吓人） */
    html += `<details class="v3-fold" open><summary>📊 体检三件套（覆盖率 / 分红质量 / 健康雷达）</summary>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <div id="cockpitRing" style="flex:1;min-width:150px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
        <div id="cockpitDivRing" style="flex:1;min-width:150px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
        <div id="cockpitRadar" style="flex:1;min-width:180px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
      </div>
    </details>`;
    /* 收益贡献 + 组合股息日历（折叠） */
    html += `<details class="v3-fold"><summary>💰 收益贡献 + 📅 组合股息日历</summary>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <div id="cockpitContrib" style="flex:1;min-width:280px;height:190px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
        <div id="cockpitDivCal" style="flex:1;min-width:280px;height:190px;background:var(--card2);border-radius:10px;border:1px solid var(--line);overflow:auto"></div>
      </div>
    </details>`;
    /* 覆盖率演进 + 复投vs提取 + 行业分布（折叠） */
    html += `<details class="v3-fold"><summary>📈 覆盖率演进 / 复投vs提取 / 行业分布</summary>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <div id="cockpitCovEvol" style="flex:1;min-width:240px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
        <div id="cockpitReinv" style="flex:1;min-width:240px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
        <div id="cockpitIndustry" style="flex:1;min-width:170px;height:170px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>
      </div>
    </details>`;
    /* 回本进度环（W2：组合环+每只小环） */
    html += `<div id="cockpitPayback" style="width:100%;margin-top:8px;padding:8px;background:var(--card2);border-radius:10px;border:1px solid var(--line)"></div>`;
    /* 时间轴回放 */
    html += `<div style="margin-top:8px"><div style="font-size:11px;color:var(--muted);margin-bottom:2px">🎬 时间轴回放：拖动看「我的钱怎么长大」（预计算，拖动只切帧）</div>
      <input type="range" id="cockpitTimeline" min="0" max="${Math.max(0, res.totalAsset.length - 1)}" value="${res.totalAsset.length - 1}" style="width:100%;accent-color:var(--gold)"></div>`;
    /* v3.2 S4：逐年分红柱 + 增长率双轴（日/月/年切换 + CAGR 徽章 + 三态色 + 断档断开）——默认开 */
    html += `<details class="v3-fold" open><summary>📊 分红节奏（逐年/逐月/逐日）</summary>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px">
        <span id="divCagrBadge" style="font-size:11px;color:var(--muted)"></span>
        <span id="divStabWarn" style="font-size:11px;color:var(--muted)"></span>
        <span style="margin-left:auto;display:flex;gap:4px" id="divGranSwitch">
          <button type="button" class="chip" data-g="day" style="font-size:11px;padding:2px 8px">日</button>
          <button type="button" class="chip" data-g="month" style="font-size:11px;padding:2px 8px">月</button>
          <button type="button" class="chip" data-g="year" style="font-size:11px;padding:2px 8px">年</button>
        </span>
      </div>
      <div id="cockpitDivBar" style="width:100%;height:170px;margin-top:4px"></div>
    </details>`;
    /* v3.2 S6/S7：个股卡片区（分红柱之下） */
    html += renderStockCards(res, pool);
    /* 每只贡献 + 权重演化（折叠） */
    html += `<details style="margin-top:8px"><summary style="font-size:12px;cursor:pointer;color:var(--sub)">📋 每只贡献 + 权重演化（点开）</summary>
      <table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px"><tr style="color:var(--muted)"><th style="text-align:left;padding:3px">标的</th><th>初始</th><th>月追加</th><th>期末市值</th><th>累计分红</th><th>分红率</th></tr>
      ${res.perStock.map(p => `<tr style="border-top:1px solid var(--line)" data-prow="${esc(p.code)}"><td style="padding:3px"><b>${esc(p.name)}</b></td><td style="text-align:center">${(p.amount / 10000).toFixed(1)}万</td><td style="text-align:center">${p.monthly.toFixed(0)}</td><td style="text-align:center">${(p.finalValue / 10000).toFixed(1)}万</td><td style="text-align:center" class="green">${(p.cumDiv / 10000).toFixed(2)}万</td><td style="text-align:center" class="${p.divRatio >= 15 ? 'green' : p.divRatio >= 8 ? '' : 'red'}">${p.divRatio.toFixed(1)}%</td><td style="text-align:center"><a href="javascript:void(0)" data-adj="${esc(p.code)}" style="color:#5aa9e6;font-size:10px">✏️调</a></td></tr>`).join('')}
      </table>
      <div id="cockpitWeight" style="width:100%;height:160px;margin-top:6px"></div>
    </details>`;
    /* v3.2 S12：快照对比（折叠面板，点开才 init） */
    html += `<details style="margin-top:8px"><summary style="font-size:12px;cursor:pointer;color:var(--sub)">⚖️ 快照对比 A/B（同组合不同配置）</summary>
      <div id="cockpitSnapCmp" style="margin-top:6px;font-size:11px">点开加载…</div>
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
    /* v3.4 N3：结果渲染后显示锚点导航 */
    try { const anc = document.getElementById('pfbtAnchor'); if (anc) anc.style.display = 'flex'; } catch (e) { }
    _cockpitRes = res; _cockpitPool = pool; _cockpitCombo = combo;
    /* v3.2 S3：年度表表头排序（事件委托）——v3.4 AC-38：行点击弹月度明细 */
    try {
      const yt = document.getElementById(yearTableId);
      if (yt) {
        yt.querySelectorAll('th[data-skey]').forEach(th => {
          th.onclick = () => {
            const k = th.dataset.skey;
            if (sortKey === k) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
            else { sortKey = k; sortDir = 'desc'; }
            yt.innerHTML = renderYearTable(res, sortKey, sortDir);
            bindYearRowClick(res, yt);
          };
        });
        bindYearRowClick(res, yt);
      }
    } catch (e) { }
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
    /* v3.4 D1/D2：日粒度分红 map（totalAsset 每天已带 cumDiv，纯 UI 展示） */
    const t = res.totalAsset || [];
    const divByDay = {};
    let prevCum = 0;
    t.forEach(x => { const d = x.cumDiv - prevCum; if (d > 0.005) divByDay[x.d] = d; prevCum = x.cumDiv; });
    /* v3.4 D1：总卡迷你曲线（SVG 降采样≤60 点 + 分红日金色标记点 + hover 看某天值/分红） */
    const miniEl = document.getElementById('pfbtMiniCurve');
    if (miniEl && t.length >= 2) {
      const pts = t.length > 60 ? t.filter((_, i) => i % Math.ceil(t.length / 60) === 0) : t;
      const w = 240, h = 72, pad = 3;
      let mn = Infinity, mx = -Infinity;
      pts.forEach(p => { mn = Math.min(mn, p.value, p.invested); mx = Math.max(mx, p.value, p.invested); });
      const span = (mx - mn) || 1;
      const X = i => (i / (pts.length - 1) * (w - pad * 2)) + pad;
      const Y = v => h - pad - (v - mn) / span * (h - pad * 2);
      const line = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
      const invLine = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.invested).toFixed(1)}`).join(' ');
      /* 分红日标记点（金色小圆点，hover 显示"X月X日分红到账 X万"）——用全量 t 定位（降采样 pts 可能丢分红日） */
      const dots = Object.keys(divByDay).map(d => {
        const idx = t.findIndex(p => p.d === d);
        if (idx < 0) return '';
        const xPos = (idx / (t.length - 1) * (w - pad * 2)) + pad;
        const mm = d.slice(5).replace('-', '月') + '日';
        const amt = (divByDay[d] / 10000).toFixed(2);
        return `<circle cx="${xPos.toFixed(1)}" cy="${Y(t[idx].value).toFixed(1)}" r="2.6" class="v3-divdot"><title>${Number(d.slice(0, 4))}年${mm} 分红到账 ${amt}万</title></circle>`;
      }).join('');
      miniEl.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:100%;display:block">
        <polyline points="${invLine}" fill="none" stroke="rgba(217,164,65,.55)" stroke-width="1" stroke-dasharray="3 2"/>
        <polyline points="${line}" fill="none" stroke="rgba(76,175,125,.9)" stroke-width="1.8"/>
        ${dots}
        <rect x="0" y="0" width="${w}" height="${h}" fill="transparent"><title>hover 看某天：值/分红（金色点=分红日）</title></rect>
      </svg>`;
    }
    /* 主图三层 */
    const mainEl = document.getElementById('cockpitMain');
    if (mainEl && typeof echarts !== 'undefined') {
      if (_cockpitChart) { _cockpitChart.dispose(); _cockpitChart = null; }
      const ch = _cockpitChart = echarts.init(mainEl);
      /* v3.4 主人令（13:20）：「不要净值要具体的钱」——主图改金额轴（万元），基准换算同本金投入金额 */
      /* 回撤副图数据（灰蓝，非红——主人点名"回测搞成红色太难看"） */
      const ddData = []; let peak = -Infinity;
      t.forEach(x => { if (x.value > peak) peak = x.value; ddData.push(+( (x.value - peak) / peak * 100).toFixed(2)); });
      const navData = t.map(x => [x.d, +(x.value / 10000).toFixed(2)]);        /* 金额（万元） */
      const investNav = t.map(x => [x.d, +(x.invested / 10000).toFixed(2)]);  /* 金额（万元） */
      ch.setOption({
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, axisPointer: { snap: true, lineStyle: { color: 'rgba(157,180,171,.6)', type: 'dashed' } },
          /* v3.4 D5 + 主人令：日粒度 hover 显示具体钱（修复：time 轴 axisValue 是时间戳，用 data[0] 取原始日期） */
          formatter: (ps) => {
            if (!ps || !ps.length) return '';
            const d = ps[0].data ? ps[0].data[0] : (typeof ps[0].axisValue === 'string' ? ps[0].axisValue : '');
            const day = t.find(x => x.d === d);
            if (!day) return d;
            const dv = divByDay[d];
            const mm = d.slice(5).replace('-', '月') + '日';
            let s = `<b>${d.slice(0, 4)}年${mm}</b><br/>`;
            s += `市值 <b>${(day.value / 10000).toFixed(2)}万</b> · 累计投入 ${(day.invested / 10000).toFixed(2)}万`;
            if (dv) s += `<br/><b style="color:#d9a441">● 分红到账 ${(dv / 10000).toFixed(2)}万</b>`;
            return s;
          } },
        legend: { top: 2, textStyle: { color: '#8fa69c', fontSize: 10 } },
        grid: [
          { left: 62, right: 14, top: 28, height: '62%' },
          { left: 62, right: 14, top: '74%', height: '20%' },
        ],
        xAxis: [
          { type: 'time', gridIndex: 0, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#2a3d36' } } },
          { type: 'time', gridIndex: 1, axisLabel: { color: '#8fa69c', fontSize: 10 }, axisLine: { lineStyle: { color: '#2a3d36' } } },
        ],
        yAxis: [
          { type: 'value', gridIndex: 0, name: '金额(万)', nameTextStyle: { color: '#8fa69c', fontSize: 10 }, axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } }, scale: true },
          { type: 'value', gridIndex: 1, axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '%' }, splitLine: { show: false }, min: 'dataMin' },
        ],
        dataZoom: [
          { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
          { type: 'slider', xAxisIndex: [0, 1], bottom: 2, height: 14, borderColor: '#2a3d36', backgroundColor: '#16211d', fillerColor: 'rgba(217,164,65,.12)', textStyle: { color: '#8fa69c', fontSize: 10 } },
        ],
        series: [
          { name: '组合市值', type: 'line', data: navData, smooth: true, showSymbol: false, lineStyle: { color: 'rgba(60,150,110,.85)', width: 2.5 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(60,150,110,.25)' }, { offset: 1, color: 'rgba(60,150,110,.02)' }] } } },
          { name: '累计投入', type: 'line', data: investNav, smooth: true, showSymbol: false, lineStyle: { color: '#d9a441', width: 1.5, type: 'dashed' } },
          { name: '回撤', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: t.map((x, i) => [x.d, ddData[i]]), smooth: true, showSymbol: false, lineStyle: { color: 'rgba(100,130,160,.6)', width: 1 }, areaStyle: { color: 'rgba(100,130,160,.15)' } },
          /* v3.4 D2：分红日标记点（金色小圆点，hover 显示"X月X日分红到账 X万"）——金额轴同尺 */
          { name: '分红日', type: 'scatter', data: Object.keys(divByDay).map(d => [d, +(t.find(x => x.d === d).value / 10000).toFixed(2)]), symbol: 'circle', symbolSize: 7, itemStyle: { color: '#d9a441', borderColor: '#16211d', borderWidth: 1.5 }, z: 5, tooltip: { trigger: 'item', formatter: p => { const d = p.data[0]; const mm = d.slice(5).replace('-', '月') + '日'; return `<b>${Number(d.slice(0, 4))}年${mm}</b><br/><span style="color:#d9a441">● 分红到账 ${(divByDay[d] / 10000).toFixed(2)}万</span>`; } } },
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
        title: { text: '组合健康', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
        radar: { indicator: [{ name: '分红回报', max: 100 }, { name: '覆盖率', max: 100 }, { name: '分散度', max: 100 }, { name: '回撤控制', max: 100 }, { name: '成长性', max: 100 }], radius: '62%', axisName: { color: '#8fa69c', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.08)' } } },
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
        title: { text: '权重演化（动态再平衡视角）', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
        legend: { top: 16, textStyle: { color: '#8fa69c', fontSize: 10 }, type: 'scroll' },
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
        title: { text: '收益贡献（金=分红 · 红涨/绿赔=价格）', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => p.map(x => x.marker + ' ' + x.seriesName + '：' + x.value + '万').join('<br>') },
        legend: { top: 14, textStyle: { color: '#8fa69c', fontSize: 10 } },
        grid: { left: 76, right: 90, top: 40, bottom: 24 },
        xAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        yAxis: { type: 'category', data: names, axisLabel: { color: '#b8c9c0', fontSize: 12, interval: 0 } },
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
      dcEl.innerHTML = `<div style="font-size:12px;color:#8fa69c;padding:6px 8px 0">📅 组合股息日历（未来12个月 · 估=上年同期推算）</div>` + (ms.length
        ? `<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:4px">${ms.map(m => `<tr style="border-top:1px solid var(--line)"><td style="padding:3px 8px;color:var(--gold);font-weight:700">${m}</td><td style="padding:3px">${months[m].map(x => `${esc(x.name)} ${x.cash.toFixed(2)}`).join(' · ')}</td><td style="padding:3px;text-align:right;color:var(--sub)">${(months[m].reduce((s, x) => s + x.cash, 0)).toFixed(2)}/股</td></tr>`).join('')}</table>`
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
        title: { text: monthlyExp > 0 ? '覆盖率演进（年分红÷月支出×12）' : '覆盖率演进（填月支出后显示）', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => p[0].name + '：' + p[0].value + '%' },
        grid: { left: 40, right: 14, top: 30, bottom: 24 },
        xAxis: { type: 'category', data: ys, axisLabel: { color: '#8fa69c', fontSize: 10 } },
        yAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '%' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        series: [{ name: '覆盖率', type: 'line', data: cov, smooth: true, showSymbol: false, lineStyle: { color: '#5aa9e6', width: 2 }, areaStyle: { color: 'rgba(90,169,230,.12)' }, markLine: { data: [{ yAxis: 100, lineStyle: { color: '#4caf7d', type: 'dashed' }, label: { formatter: '100%', color: '#4caf7d', fontSize: 10 } }] } }],
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
        title: { text: '分红复投 vs 提取（复利的力量）', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
        legend: { top: 14, textStyle: { color: '#8fa69c', fontSize: 10 } },
        /* v3.6.1 P0-2（大师）：默认 tooltip 显示原始元数值不可读 → 自定义：中文日期 + 万单位 */
        tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: ps => { if (!ps.length) return ''; const d = ps[0].data ? ps[0].data[0] : ''; const ds = String(d); const mm = ds.length >= 10 ? (Number(ds.slice(5, 7)) + '月' + Number(ds.slice(8, 10)) + '日') : ''; let s = `<b>${Number(ds.slice(0, 4))}年${mm}</b>`; ps.forEach(x => { s += `<br/>${x.marker} ${x.seriesName} <b>${(x.value / 10000).toFixed(1)}万</b>`; }); return s; } },
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
        title: { text: '行业分布' + (maxInd && maxInd.value / (combo.items.reduce((s, it) => s + (it.amount || 0), 0) || 1) > 0.5 ? ' · ⚠️集中' : ''), left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: p => p[0].name + '：' + (p[0].value / 10000).toFixed(1) + '万' },
        grid: { left: 34, right: 50, top: 28, bottom: 20 },
        xAxis: { type: 'value', axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => (v / 10000).toFixed(0) + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
        yAxis: { type: 'category', data: rows2.map(r => r.name), axisLabel: { color: '#b8c9c0', fontSize: 12, interval: 0 } },
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
          <div style="font-size:10px;color:var(--muted);margin-top:2px">${label}</div>
        </div>`;
      };
      let html = `<div style="font-size:10px;color:#8fa69c;padding:0 2px">🔁 回本进度（累计分红÷投入）：</div>`;
      html += ringHtml('组合', res.divRatio, '#d9a441');
      res.perStock.forEach(p => { html += ringHtml(p.name.length > 4 ? p.name.slice(0, 4) : p.name, p.divRatio, p.divRatio >= 30 ? '#4caf7d' : p.divRatio >= 15 ? '#d9a441' : '#5aa9e6'); });
      pbEl.innerHTML = html;
    }
    /* v3.2 S4：逐年分红柱（三态色：增长绿/下滑红/断档灰）+ 增长率双轴（右轴域锁死防误导）
     * 增长率线只连有分红年（断档断开防假负增长）；CAGR 3/5 年徽章；年/季切换 */
    const barEl3 = document.getElementById('cockpitDivBar');
    if (barEl3 && typeof echarts !== 'undefined') {
      const _comboPalette = window._comboPalette || ['#4caf7d', '#d9a441', '#5aa9e6', '#c46ae0', '#e05a5a', '#5b8db8', '#8fa69c', '#e68a5a'];
      const buildDivSeq = (g) => {
        if (g === 'year') {
          const ys = Object.keys(res.divByYear).sort();
          return ys.map((y, i) => ({ key: y, div: res.divByYear[y], yoy: i > 0 && res.divByYear[ys[i - 1]] > 0 ? (res.divByYear[y] - res.divByYear[ys[i - 1]]) / res.divByYear[ys[i - 1]] * 100 : null }));
        }
        if (g === 'month') {
          /* 月粒度：totalAsset 每天有 cumDiv，按月归集增量 */
          const map = {};
          res.totalAsset.forEach(x => { const m = x.d.slice(0, 7); map[m] = x.cumDiv; });
          const ms = Object.keys(map).sort();
          return ms.map((k, i) => ({ key: k.slice(0, 4) + '年' + Number(k.slice(5)) + '月', div: +(map[k] - (i > 0 ? map[ms[i - 1]] : 0)).toFixed(2), yoy: i > 0 && map[ms[i - 1]] > 0 ? (map[k] - map[ms[i - 1]]) / map[ms[i - 1]] * 100 : null }));
        }
        if (g === 'day') {
          /* 日粒度：每天 cumDiv 增量 >0 即分红日（D4 统一粒度切换器·精确到每一天） */
          const map = {};
          let prev = 0;
          res.totalAsset.forEach(x => { const d = x.cumDiv - prev; map[x.d] = d; prev = x.cumDiv; });
          const ds = Object.keys(map).sort();
          return ds.map((k, i) => ({ key: Number(k.slice(5, 7)) + '月' + Number(k.slice(8, 10)) + '日', div: +map[k].toFixed(2), yoy: null }));
        }
        const map = {};
        res.totalAsset.forEach(x => { const q = x.d.slice(0, 4) + 'Q' + Math.ceil(+x.d.slice(5, 7) / 3); map[q] = x.cumDiv; });
        const qs = Object.keys(map).sort();
        return qs.map((k, i) => ({ key: k, div: +(map[k] - (i > 0 ? map[qs[i - 1]] : 0)).toFixed(2), yoy: i > 0 && map[qs[i - 1]] > 0 ? (map[k] - map[qs[i - 1]]) / map[qs[i - 1]] * 100 : null }));
      };
      const drawDivBar = (g) => {
        const seq = buildDivSeq(g);
        const vals = seq.map(s => s.div);
        /* v3.5 P1-3 ③：累计分红曲线数据（逐段累加） */
        let cum = 0;
        const cumVals = seq.map(s => { cum += s.div; return +cum.toFixed(2); });
        const colors = seq.map((s, i) => {
          if (s.div <= 0) return '#2a3d36'; /* 断档灰 */
          if (i === 0 || seq[i - 1].div <= 0) return '#5b8db8'; /* 首段/断档后首段：中性蓝 */
          return s.div >= seq[i - 1].div ? '#4caf7d' : '#e05a5a';
        });
        /* 增长率线：只连有分红年（div>0），断档断开 */
        const yoyData = seq.map(s => (s.div > 0 && s.yoy != null) ? +s.yoy.toFixed(1) : null);
        /* CAGR 徽章 */
        const badgeEl = document.getElementById('divCagrBadge');
        if (badgeEl) {
          const pos = seq.filter(s => s.div > 0);
          const cagr = (n) => {
            if (pos.length < n + 1) return null;
            const last = pos[pos.length - 1].div, base = pos[pos.length - n].div;
            if (!(base > 0)) return null;
            const yearsSpan = pos[pos.length - 1].key.slice(0, 4) - pos[pos.length - n].key.slice(0, 4);
            if (yearsSpan <= 0) return null;
            return (Math.pow(last / base, 1 / yearsSpan) - 1) * 100;
          };
          const c3 = cagr(3), c5 = cagr(5);
          badgeEl.innerHTML = (c3 != null ? `近3年分红平均每年涨 <b>${c3 >= 0 ? '+' : ''}${c3.toFixed(1)}%</b>` : '近3年分红平均每年涨 —') + ' · ' + (c5 != null ? `近5年 <b>${c5 >= 0 ? '+' : ''}${c5.toFixed(1)}%</b>` : '近5年 —');
        }
        /* 稳定度警示：断档或连降≥2年 */
        const warnEl = document.getElementById('divStabWarn');
        if (warnEl) {
          let warn = '';
          const pos = seq.filter(s => s.div > 0);
          for (let i = pos.length - 1; i >= 2; i--) { if (pos[i].div < pos[i - 1].div && pos[i - 1].div < pos[i - 2].div) { warn = `⚠️ 分红连降 ${pos[i - 2].key}→${pos[i].key}，关注持续性`; break; } }
          if (!warn && pos.length && pos[pos.length - 1].div <= 0) warn = '⚠️ 最近一期无分红';
          warnEl.innerHTML = warn ? `<span style="color:#e05a5a">${warn}</span>` : '';
        }
        const inst = echarts.getInstanceByDom(barEl3) || echarts.init(barEl3);
        /* 右轴域锁死 [-100, 300] 防双轴误导；超限标 * */
        const yoyShow = yoyData.map(v => v == null ? null : (v > 300 || v < -100 ? '*' : v));
        inst.setOption({
          tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 },
            formatter: ps => { let h = ''; ps.forEach(p => { const s = seq[p.dataIndex]; const nm = p.seriesName === '分红' ? '分红' : p.seriesName === 'YoY' ? 'YoY' : '累计分红'; const vv = p.seriesName === '分红' ? (s.div / 10000).toFixed(2) + ' 万' : p.seriesName === 'YoY' ? (s.yoy != null ? (s.yoy >= 0 ? '+' : '') + s.yoy.toFixed(1) + '%' : '—') : (cumVals[p.dataIndex] / 10000).toFixed(2) + ' 万'; h += `${p.marker}${s.key} · ${nm}: <b>${vv}</b><br/>`; }); return h; } },
          legend: { top: 4, textStyle: { color: '#8fa69c', fontSize: 10 }, data: ['分红', 'YoY', '累计分红'] },
          grid: { left: 56, right: 46, top: 28, bottom: 24 },
          xAxis: { type: 'category', data: seq.map(s => s.key), axisLabel: { color: '#8fa69c', fontSize: 10, interval: g === 'day' ? Math.ceil(seq.length / 8) : (g === 'month' ? 'auto' : 0), rotate: g === 'day' ? 45 : 0 } },
          yAxis: [
            { type: 'value', name: '分红', nameTextStyle: { color: '#8fa69c', fontSize: 10 }, axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => (v / 10000).toFixed(0) + '万' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,.06)' } } },
            { type: 'value', name: 'YoY%', nameTextStyle: { color: '#8fa69c', fontSize: 10 }, min: -100, max: 300, axisLabel: { color: '#8fa69c', fontSize: 10, formatter: v => v + '%' }, splitLine: { show: false } },
          ],
          series: [
            { name: '分红', type: 'bar', data: vals, barMaxWidth: g === 'quarter' ? 14 : 30, itemStyle: { color: p => colors[p.dataIndex], borderRadius: [3, 3, 0, 0] },
              label: { show: true, position: 'top', fontSize: 10, color: '#8fa69c', formatter: p => { const s = seq[p.dataIndex]; if (s.div <= 0) return '—'; const n = seq.length; const mark = p.dataIndex === 0 || p.dataIndex === n - 1 || vals[p.dataIndex] === Math.max.apply(null, vals) ? (s.div / 10000).toFixed(1) + '万' : ''; return mark; } } },
            { name: 'YoY', type: 'line', yAxisIndex: 1, data: yoyShow, connectNulls: false, symbolSize: 5, lineStyle: { color: '#d9a441', width: 1.5 }, itemStyle: { color: '#d9a441' }, label: { show: true, position: 'top', fontSize: 10, color: '#d9a441', formatter: p => yoyData[p.dataIndex] != null ? (p.value === '*' ? (yoyData[p.dataIndex] > 0 ? '+' : '') + yoyData[p.dataIndex].toFixed(0) + '%*' : p.value + '%') : '' } },
            /* v3.5 P1-3 ③：累计分红曲线（金色实线，右轴）——补组合页缺项 */
            { name: '累计分红', type: 'line', data: cumVals, symbolSize: 3, lineStyle: { color: '#e8b84b', width: 1.8 }, itemStyle: { color: '#e8b84b' }, yAxisIndex: 0, label: { show: false } },
          ],
          animationDuration: 600,
        });
      };
      drawDivBar('year');
      const sw = document.getElementById('divGranSwitch');
      if (sw) sw.querySelectorAll('button[data-g]').forEach(b => {
        b.onclick = () => { sw.querySelectorAll('button').forEach(x => x.style.background = ''); b.style.background = 'rgba(217,164,65,.25)'; drawDivBar(b.dataset.g); };
      });
    }
  }

  function bindCockpitEvents(res) {
    /* v3.2 S12：快照对比折叠——点开才加载（懒 init 防平板卡） */
    try {
      const sc = document.getElementById('cockpitSnapCmp');
      if (sc) {
        const det = sc.closest('details');
        if (det) det.addEventListener('toggle', () => { if (det.open && !sc.dataset.loaded) { sc.dataset.loaded = '1'; renderSnapCompare(sc); } });
      }
    } catch (e) { }
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
    /* v3.5 AC-U2/U3：个股卡片点击 → 逐年详情弹层（手风琴互斥 + 同卡 toggle；默认展开贡献最大那只） */
    try {
      const grid = document.getElementById('stockCardsGrid');
      if (grid) {
        grid.querySelectorAll('.v3-stock-card').forEach(card => {
          const code = card.dataset.code;
          card.onclick = () => {
            const cur = document.getElementById('stockDetail_' + code);
            /* 手风琴：关掉其它已开的 */
            grid.querySelectorAll('.v3-stock-detail').forEach(d => { if (d.id !== 'stockDetail_' + code) d.remove(); });
            if (cur) { cur.remove(); return; } /* 同卡 toggle 关闭 */
            const p = (res.perStock || []).find(x => x.code === code);
            if (!p) return;
            const det = document.createElement('div');
            det.id = 'stockDetail_' + code;
            det.className = 'v3-stock-detail';
            det.style.cssText = 'grid-column:1/-1;margin-top:2px;padding:10px 12px;background:var(--card);border:1px solid var(--line);border-radius:10px;font-size:11px';
            det.innerHTML = renderStockDetail(res, p);
            card.after(det);
            try { initStockDetailCharts(res, p, det); } catch (e) { console.warn('stock detail chart fail', e); }
            /* 面板内点击任意处收起（与 bindYearRowClick 先例一致） */
            det.onclick = () => { det.remove(); };
            det.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          };
        });
      }
    } catch (e) { }
    /* v3.5 AC-U5：排序切换器（市值占比默认） */
    try {
      const sel = document.getElementById('stockSortSel');
      if (sel && !sel.dataset.bound) {
        sel.dataset.bound = '1';
        sel.onchange = () => {
          window._stockSortKey = sel.value;
          const grid2 = document.getElementById('stockCardsGrid');
          if (grid2) {
            const container = grid2.closest('#pfbtResult');
            if (container) {
              const snap = document.createElement('div'); snap.style.display = 'none'; snap.innerHTML = renderStockCards(res, _cockpitPool || {});
              const ng = snap.querySelector('#stockCardsGrid');
              if (ng) grid2.innerHTML = ng.innerHTML;
              /* 重新绑定点击 */
              try { bindCockpitEvents(res); } catch (e) { }
            }
          }
        };
      }
    } catch (e) { }
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
      const cacheKey = 'combo_bt_v2_' + combo.id + '_' + y + '_' + mode; /* v3.6 P2-2：schema 版本 v2——旧缓存（无 mSeries/yearly）不再命中 */
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
      const meta = { modeTxt: mode === 'weight' ? '按初始权重分配' : mode === 'fixed' ? '每只固定' : '智慧定投（按分位）', cacheNote, failed, cashTxt: (combo.cashPct || 0) > 0 ? `现金仓位 ${combo.cashPct}% 按 1.5%/年滚入（近似货基/短债，可改）；` : '', ver: (typeof APP_VERSION !== 'undefined') ? APP_VERSION : '' };
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
    /* v3.9.0 分步进度（接手 AI E4）：显示"K线 3/8 · 分红 5/8"，不再是黑盒等待 */
    const total = combo.items.length;
    let doneN = 0;
    const prog = (tag) => {
      try {
        const el = document.getElementById('pfbtResult');
        if (el) el.innerHTML = `<div class="hint">⏳ 正在拉取数据 ${++doneN}/${total}（${tag}）…<span style="color:var(--muted)">首次较慢，二次跑命中本地缓存秒出</span></div>`;
      } catch (e) {}
    };
    for (let i = 0; i < combo.items.length; i += 4) {
      const batch = combo.items.slice(i, i + 4);
      await Promise.all(batch.map(async (it) => {
        try {
          prog(it.name + ' K线');
          const [divs, kline] = await Promise.all([DL.fetchDividendsOne(it.code), DL.getKline(it.code, from, DL.todayStr())]);
          if (!divs || !divs.length || !kline || !Object.keys(kline).length) { failed.push(it.name); return; }
          prog(it.name + ' 分红');
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
          /* v3.6.1 P0-2（大师）：元→万 + 中文日期 */
          tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: ps => { if (!ps.length) return ''; const d = ps[0].data ? ps[0].data[0] : ''; const ds = String(d); const mm = ds.length >= 10 ? (Number(ds.slice(5, 7)) + '月' + Number(ds.slice(8, 10)) + '日') : ''; let s = `<b>${Number(ds.slice(0, 4))}年${mm}</b>`; ps.forEach(x => { s += `<br/>${x.marker} ${x.seriesName} <b>${(x.value / 10000).toFixed(1)}万</b>`; }); return s; } },
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
  if (total <= 0) { _comboItems[idx].amount = pct * 1000; _comboTotal = pct * 1000; return; }
  /* v3.9.0 A8（接手 AI，方案 V3-3）：默认等比缩放（改这只%→其余按原比例缩，Σ 恒=总额），
   * 主人铁律"输入不被改"保留为锁定模式（lock=false，只改这只）
   * 旧调用无第三参=锁定模式（向后兼容）；编辑器输入走等比缩放 */
  if (lock) {
    _comboItems[idx].amount = Math.round(total * pct / 100);
    const otherSum = _comboItems.reduce((s, x, i) => s + (i === idx ? 0 : (x.amount || 0)), 0);
    if (otherSum > 0) {
      const remain = Math.max(0, total - _comboItems[idx].amount);
      _comboItems.forEach((x, i) => {
        if (i !== idx) x.amount = Math.round((x.amount || 0) / otherSum * remain);
      });
    }
    _comboTotal = total;
  } else {
    _comboItems[idx].amount = Math.round(total * pct / 100);
    _comboTotal = total;
  }
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
      <span style="font-size:11px;color:var(--sub)">%</span><input type="number" data-pct="${i}" value="${pct.toFixed(pct % 1 === 0 ? 0 : 1)}" min="0" max="100" style="width:52px;padding:3px 5px;background:var(--card);border:1px solid var(--line);border-radius:5px;color:var(--txt);font-size:11px" title="目标占比：改这个=其余等比缩放（Σ 恒=总投资）">
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
  /* % 输入 → 只改这只（v3.2 S8：其他股不动，总和≠100% 提示差额） */
  wrap.querySelectorAll('[data-pct]').forEach(inp => inp.onchange = () => {
    comboPushUndo(); const i = +inp.dataset.pct; let v = parseFloat(inp.value);
    if (isNaN(v) || v < 0) v = 0;
    if (v > 100) { toast('单只不能超 100%'); v = 100; }
    const before = comboSumAmt();
    comboScaleTo(i, v, true); renderComboList();   /* v3.9.0：改%默认等比缩放 */
    const sumPct = _comboTotal > 0 ? comboSumAmt() / _comboTotal * 100 : 0;
    if (Math.abs(sumPct - 100) > 0.5) toast(`⚠️ 已只改「${_comboItems[i].name}」为 ${v}%，其他未动——当前合计 ${sumPct.toFixed(1)}%，差额 ${(100 - sumPct).toFixed(1)}%（可改金额或再加股）`);
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
              el2.innerHTML += ` <span style="color:${col};border:1px solid ${col};border-radius:4px;padding:0 4px;font-size:10px;cursor:help" title="估值分位 ${p.toFixed(0)}%（近5年股息率滚动分位）">${tag}</span>`;
            }
          }
        } catch (e) {}
      } else {
        const sp = document.querySelector(`[data-spark="${i}"]`);
        if (sp) sp.innerHTML = '<span style="color:var(--muted);font-size:10px">—</span>';
      }
    } catch (e) {
      const sp = document.querySelector(`[data-spark="${i}"]`);
      if (sp) sp.innerHTML = '<span style="color:var(--muted);font-size:10px">—</span>';
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
          if (el2) el2.innerHTML = `<span style="color:${col};border:1px solid ${col};border-radius:4px;padding:0 4px;font-size:10px">${tag} ${dy.toFixed(1)}%</span>`;
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
    /* v3.2 S8（主人铁律：输入不被改）：加股只加新股，旧股金额不动；新股默认=总额均分份额 */
    const amt = Math.round(t / n2);
    _comboItems.push({ code: r.code, name: r.name, amount: amt, monthly: 0 });
    _comboTotal = comboSumAmt();
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
  /* 快捷键（Ctrl+Z 撤销 / Ctrl+S 保存 / Ctrl+Enter 回测）
   * 修复 C2（2026-08-23 接手 AI）：原绑定在 renderComboCard 内，每次 renderHome 重渲染都新增一个全局 keydown
   * 监听（dataset.bound 只保护了按钮没保护本监听）→ Ctrl+S 触发多次保存。改 body dataset 标记，全局只绑定一次。 */
  if (!document.body.dataset.comboKeysBound) {
    document.body.dataset.comboKeysBound = '1';
    document.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { if (typeof comboUndo === 'function') { e.preventDefault(); comboUndo(); } }
      if ((e.ctrlKey || e.metaKey) && k === 's') { const sb = $('#comboSave'); if (sb && sb.dataset.bound) { e.preventDefault(); sb.click(); } }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { const rb = $('#pfbtRun'); if (rb) { e.preventDefault(); rb.click(); } }
    });
  }
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
      title: { text: '组合净值曲线', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
      /* v3.6.1 P0-2（大师）：元→万 + 中文日期 */
      tooltip: { trigger: 'axis', backgroundColor: '#1b2a25', borderColor: '#2a3d36', textStyle: { color: '#e8efe9', fontSize: 11 }, formatter: ps => { if (!ps.length) return ''; const d = ps[0].data ? ps[0].data[0] : ''; const ds = String(d); const mm = ds.length >= 10 ? (Number(ds.slice(5, 7)) + '月' + Number(ds.slice(8, 10)) + '日') : ''; let s = `<b>${Number(ds.slice(0, 4))}年${mm}</b>`; ps.forEach(x => { s += `<br/>${x.marker} ${x.seriesName} <b>${(x.value / 10000).toFixed(1)}万</b>`; }); return s; } },
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
      title: { text: '市值占比', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#8fa69c' } },
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

// v1.8.13 BUG-3：views.js 就绪标志（index.html 自动运行等此标志）
window.__viewsReady = true;
(window.__viewsReadyCallbacks || []).forEach(function (f) { try { f(); } catch (e) { } });
