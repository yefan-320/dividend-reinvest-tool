#!/usr/bin/env node
/* v3.2 S14 e2e：对账 + 快照 + 输入不被改（核心验收 ACC1/ACC3）
 * 1. 组合 divByYear == Σ个股 yearlyDivs ±0.01（对账，数据源=快照）
 * 2. 快照自动存进 divtool-bt（IndexedDB 独立库，含 navSeries）
 * 3. 加股不重置旧股金额（S8 输入不被改，DOM 真实流程）
 * 4. 年度战绩表已渲染（S3 分红列优先）+ 主图净值从 1 起（S5）
 * 用法：先本地起服务（python3 -m http.server 8899），再 node test/e2e-v32-reconcile.js */
const http = require('http');
const WS = require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws');
const PORT = 8899, CDP_PORT = 9236;
let pass = 0, fail = 0;
function T(name, cond, extra) { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (extra != null ? ' | ' + extra : '')); } }
function launchChrome() {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { require('child_process').execSync('lsof -tiTCP:' + CDP_PORT + ' -sTCP:LISTEN | xargs kill -9 2>/dev/null; sleep 1', { timeout: 8000, stdio: 'ignore' }); } catch (e) {}
  const cp = require('child_process').spawn(chrome, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1400,2400', '--hide-scrollbars', '--user-data-dir=/tmp/dvt-e2e-v32-' + Date.now(), 'http://localhost:' + PORT + '/index.html'], { detached: true, stdio: 'ignore' });
  cp.unref();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      http.get('http://127.0.0.1:' + CDP_PORT + '/json', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try { if (JSON.parse(d).some(p=>p.url.includes('localhost:'+PORT))) resolve(); else setTimeout(poll,300); } catch(e){ setTimeout(poll,300); } }); }).on('error', () => { if (Date.now()-t0>25000) reject(new Error('超时')); else setTimeout(poll,300); });
    })();
  });
}
function cdpConnect() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + CDP_PORT + '/json', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{
      const page = JSON.parse(d).find(t=>t.type==='page' && t.url.includes('localhost:'+PORT));
      const ws = new WS(page.webSocketDebuggerUrl);
      let id=0; const pend=new Map();
      ws.onmessage = ev => { const m=JSON.parse(ev.data); if (m.id&&pend.has(m.id)){ pend.get(m.id)(m); pend.delete(m.id); } };
      ws.onopen = () => {
        const cdp={ send:(method,params={})=>new Promise(res=>{ const mid=++id; pend.set(mid,res); ws.send(JSON.stringify({id:mid,method,params})); }) };
        Promise.all([cdp.send('Page.enable'),cdp.send('Runtime.enable')]).then(()=>resolve(cdp));
      };
    }); }).on('error', reject);
  });
}
async function evl(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const rr = r.result && r.result.result; /* CDP 嵌套：{result:{result:{type,value}}} */
  if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text));
  return rr && rr.value;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await launchChrome();
  const cdp = await cdpConnect();
  await sleep(3000);

  /* 等工具加载（views.js 就绪标志） */
  let ready = false;
  let dbg = null;
  for (let i = 0; i < 40; i++) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'typeof DL !== "undefined" && window.__viewsReady === true', returnByValue: true });
    dbg = r;
    if (r.result && r.result.result && r.result.result.value) { ready = true; break; }
    await sleep(500);
  }
  console.log('DEBUG ready=' + ready + ' resp=' + JSON.stringify(dbg).slice(0, 400));

  /* 造测试组合：3 只，存 combos，切 pfbt 页（DOM 点击） */
  const setup = await evl(cdp, `(async () => {
    const c = DL.loadCombos();
    const id = 'e2e-v32-' + Date.now();
    c.combos.push({ id, name: '对账测试', items: [
      { code: '600036', name: '招商银行', amount: 400000, monthly: 1000 },
      { code: '601398', name: '工商银行', amount: 300000, monthly: 1000 },
      { code: '600900', name: '长江电力', amount: 300000, monthly: 1000 },
    ], savedAt: Date.now() });
    c.activeId = id; DL.saveCombos(c);
    const sel = document.getElementById('pfbtComboSel');
    if (sel) { sel.innerHTML = ''; c.combos.forEach(cm => { const o = document.createElement('option'); o.value = cm.id; o.textContent = cm.name; sel.appendChild(o); }); sel.value = id; }
    document.querySelector('[data-tab="pfbt"]').click();
    return id;
  })()`);
  T('测试组合创建并切到驾驶舱', !!setup);

  /* 点运行，等主图出现 */
  await sleep(1200);
  await evl(cdp, `document.getElementById('pfbtRun') && document.getElementById('pfbtRun').click()`);
  let done = false;
  for (let i = 0; i < 60; i++) {
    const st = await evl(cdp, `(document.getElementById('cockpitMain') && document.getElementById('cockpitMain').children.length ? 'ok' : 'wait')`);
    if (st === 'ok') { done = true; break; }
    await sleep(1500);
  }
  T('回测驾驶舱渲染完成（主图出现）', done);

  if (done) {
    /* 1. 年度战绩表（S3） */
    const yt = await evl(cdp, `(() => { const t = document.querySelector('.v3-year-table'); return !!t && t.querySelectorAll('th').length >= 6; })()`);
    T('年度战绩表渲染（≥6列：年份/分红/YoY/收益率/XIRR/年末资产）', yt);

    /* 2. 对账：从快照读 res，组合 divByYear == Σ个股 yearlyDivs（验证快照+对账双功能） */
    const rec = await evl(cdp, `(async () => {
      const c = DL.loadCombos();
      const full = await DL.btGet('full:auto:' + c.activeId);
      if (!full || !full.res) return null;
      const res = full.res;
      const sum = {};
      res.perStock.forEach(p => Object.keys(p.yearlyDivs || {}).forEach(y => { sum[y] = (sum[y] || 0) + p.yearlyDivs[y]; }));
      let ok = true, worst = 0, worstY = '';
      Object.keys(res.divByYear).forEach(y => { const d = Math.abs((sum[y] || 0) - res.divByYear[y]); if (d > worst) { worst = d; worstY = y; } if (d > 0.01) ok = false; });
      return { ok, worst, worstY, years: Object.keys(res.divByYear).length, per: res.perStock.length };
    })()`);
    T('S14 对账：组合 divByYear == Σ个股 yearlyDivs ±0.01', rec && rec.ok, rec ? '最差偏差 ' + rec.worst + '（' + rec.worstY + '）' : '无结果');

    /* 3. 快照自动存（S2：divtool-bt 独立库 + navSeries） */
    const snap = await evl(cdp, `(async () => {
      const metas = await DL.btList('meta:auto:');
      const fulls = await DL.btList('full:auto:');
      return { meta: metas.length, full: fulls.length, hasNav: fulls.length ? !!fulls[0].val.res.perStock[0].navSeries : false };
    })()`);
    T('快照自动存（divtool-bt meta+full 分存）', snap && snap.meta >= 1 && snap.full >= 1, JSON.stringify(snap));
    T('快照含 navSeries（卡片迷你图数据）', snap && snap.hasNav);

    /* 4. 分红柱双轴（S4） */
    const db = await evl(cdp, `!!document.getElementById('cockpitDivBar') && !!document.getElementById('divCagrBadge')`);
    T('分红柱双轴 + CAGR 徽章容器渲染', db);

    /* 5. 个股卡片区（S6/S7） */
    const cards = await evl(cdp, `document.querySelectorAll('.v3-stock-card').length`);
    T('个股卡片区渲染（≥3 只）', cards >= 3, cards + ' 张');

    /* 6. 主图净值从 1 起（S5，从 echarts 实例读） */
    const nav1 = await evl(cdp, `(() => {
      const el = document.getElementById('cockpitMain');
      const ch = echarts.getInstanceByDom(el);
      if (!ch) return null;
      const opt = ch.getOption();
      const s = opt.series.find(x => x.name === '组合净值');
      return s && s.data.length ? Math.abs(s.data[0][1] - 1) < 0.001 : null;
    })()`);
    T('主图净值从 1 起（雪球口径）', nav1 === true);

    /* 7. S8 输入不被改：DOM 真实加股，旧股金额不变 */
    const s8 = await evl(cdp, `(async () => {
      document.querySelector('[data-tab="home"]').click();
      await new Promise(r => setTimeout(r, 900));
      const amtsBefore = {};
      document.querySelectorAll('[data-amt]').forEach(i => { amtsBefore[i.dataset.amt] = i.value; });
      if (!Object.keys(amtsBefore).length) return { err: '组合未加载' };
      const search = document.getElementById('comboSearch');
      if (!search) return { err: 'no search box' };
      search.value = '600028'; /* 中石化：不在测试组合里 */
      const btn = document.getElementById('comboAdd');
      btn.click();
      await new Promise(r => setTimeout(r, 3000)); /* 等网络解析名字 */
      const amtsAfter = {};
      document.querySelectorAll('[data-amt]').forEach(i => { amtsAfter[i.dataset.amt] = i.value; });
      const realKeys = Object.keys(amtsBefore).filter(k => amtsBefore[k] != null && amtsBefore[k] !== '');
      const unchanged = realKeys.every(k => amtsAfter[k] !== undefined && amtsBefore[k] === amtsAfter[k]);
      const diffs = realKeys.filter(k => amtsAfter[k] !== undefined && amtsBefore[k] !== amtsAfter[k]).map(k => ({ idx: k, before: amtsBefore[k], after: amtsAfter[k] }));
      return { unchanged, nBefore: realKeys.length, nAfter: Object.keys(amtsAfter).filter(k => amtsAfter[k] != null && amtsAfter[k] !== '').length, diffs };
    })()`);
    T('S8 输入不被改：加股后旧股金额全部不变', s8 && s8.unchanged === true && s8.nAfter === s8.nBefore + 1, JSON.stringify(s8));
  }

  console.log(fail === 0 ? '\n🎉 全部通过 (' + pass + ')' : '\n❌ ' + fail + ' 项失败 (' + pass + ' 通过)');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
