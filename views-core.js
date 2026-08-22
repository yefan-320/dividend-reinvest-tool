/* ============================================================
 * views-core.js — views.js 拆分模块 核心/动效/导航/全局状态（switchTab/homeState）
 * 生成：scripts/split-views.py（v3.10+ 接手 AI）
 * 加载顺序：views-core → views-home → views-diag → views-compare → views-pfbt
 * 全局作用域共享（去 IIFE），勿在此文件内重复声明 DL/$/fmt
 * ============================================================ */
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
                const meta = { modeTxt: snap.meta.mode === 'weight' ? '按初始权重分配' : snap.meta.mode === 'fixed' ? '每只固定' : '智慧定投（按分位）', cacheNote: '', failed: [], cashTxt: '', ver: (snap.meta && snap.meta.ver) || '' };
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

  /* ===== v3.9.0 U8 自选机会地图（接手 AI）：X=估值分位（右=便宜）、Y=股息率（上=高）、气泡=市值、颜色=结论档 =====
   * 所有自选一张图定位"便宜的好货（左上）"与"贵的差货（右下）"；点气泡进诊断 */
  /* ===== v3.9.0 今日简报（接手 AI）：打开就知道今天要关注什么——买点区/高息榜/决策待办 ===== */
