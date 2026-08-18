#!/usr/bin/env node
/* test/user-touch.js — 真人视角实操记录仪（非断言，记录每一步实际所见）
 * 主人令 2026-08-18：实战使用工具，发散发现问题。重点：自选功能。
 */
const http = require('http');
const WS = require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws');
const LIVE = 'https://yefan-320.github.io/dividend-reinvest-tool/';
const PWD = 'fange9255';
const PORT = 9250;

let errs = [];
let cdp;

function cdpConnect() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        const page = JSON.parse(d).find(t => t.type === 'page');
        const ws = new WS(page.webSocketDebuggerUrl);
        let id = 0; const pend = new Map(); const handlers = new Map();
        ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method && handlers.has(m.method)) handlers.get(m.method).forEach(fn => fn(m.params)); };
        ws.onopen = () => {
          const c = { send: (method, params = {}) => new Promise(res => { const mid = ++id; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); }), on: (method, fn) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn); }, close: () => ws.close() };
          Promise.all([c.send('Page.enable'), c.send('Runtime.enable'), c.send('Log.enable'), c.send('Network.enable')]).then(() => {
            c.on('Runtime.exceptionThrown', p => { const d = (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text; errs.push('JS异常: ' + String(d).slice(0, 200)); });
            c.on('Log.entryAdded', p => { if (p.entry.level === 'error') errs.push('console错误: ' + (p.entry.text || '').slice(0, 200)); });
            c.on('Network.loadingFailed', p => errs.push('网络失败: ' + (p.errorText || '') + ' ' + (p.type || '')));
            c.on('Network.responseReceived', p => { if (p.response.status >= 400) errs.push('HTTP ' + p.response.status + ': ' + p.response.url.slice(0, 120)); });
            resolve(c);
          }).catch(reject);
        };
        ws.onerror = reject;
      });
    }).on('error', reject);
  });
}

async function ev(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return '⚠️eval异常: ' + String((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text).slice(0, 150);
  return r.result && r.result.result ? r.result.result.value : undefined;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(expr, timeout, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const v = await ev(expr); if (v) return v; await wait(1500); }
  return '⏰超时(' + (timeout / 1000) + 's): ' + desc;
}
const step = (t, v) => console.log('\n▶ ' + t + '\n   ' + String(v).replace(/\n/g, '\n   ').slice(0, 500));

async function main() {
  cdp = await cdpConnect();
  await cdp.send('Page.navigate', { url: LIVE });
  await waitFor(`typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''`, 30000, '加载');
  step('版本', await ev(`APP_VERSION`));

  /* 解锁 */
  await waitFor(`document.getElementById('lockScreen') && getComputedStyle(document.getElementById('lockScreen')).display === 'flex'`, 20000, '锁');
  await ev(`(() => { document.getElementById('lockPwd').value='${PWD}'; document.getElementById('lockBtn').click(); })()`);
  await waitFor(`getComputedStyle(document.getElementById('lockScreen')).display === 'none'`, 10000, '解锁');
  console.log('✅ 已解锁进入工具');

  /* ========== 1. 自选功能实战 ========== */
  step('1.1 初始决策台·机会速览', await ev(`document.getElementById('homeOpportunities').innerText`));
  step('1.2 初始自选区', await ev(`(document.getElementById('homeWatchlist').innerText||'<空>').slice(0,300)`));
  step('1.3 分红日历', await ev(`(document.getElementById('homeDivCalendar').innerText||'<空>').slice(0,200)`));

  /* 加自选：模拟真实用户——搜索框输代码 → 点➕ */
  await ev(`(() => { const s=document.getElementById('homeSearch'); s.value='600036'; document.getElementById('homeSearchAdd').click(); })()`);
  await wait(4000);
  step('1.4 加自选 600036 后·自选区', await ev(`(document.getElementById('homeWatchlist').innerText||'<空>').slice(0,400)`));
  step('1.5 加自选后·机会速览', await ev(`(document.getElementById('homeOpportunities').innerText||'<空>').slice(0,300)`));

  /* 连续加多只（主人的6只持仓） */
  for (const c of ['601398', '600887', '600941', '000333', '601318']) {
    await ev(`(() => { const s=document.getElementById('homeSearch'); s.value='${c}'; document.getElementById('homeSearchAdd').click(); })()`);
    await wait(2500);
  }
  await wait(4000);
  step('1.6 加满6只后·自选区全文', await ev(`(document.getElementById('homeWatchlist').innerText||'<空>')`));
  step('1.7 加满6只后·机会速览', await ev(`(document.getElementById('homeOpportunities').innerText||'<空>')`));
  step('1.8 自选卡 HTML 结构(前1张)', await ev(`(() => { const c=document.querySelector('.wl-card'); return c ? c.outerHTML.slice(0,600) : '<无卡片>'; })()`));

  /* 刷新 → 自选还在吗 */
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(`typeof APP_VERSION !== 'undefined'`, 30000, '重载');
  await wait(3000);
  step('1.9 刷新后·自选区', await ev(`(document.getElementById('homeWatchlist').innerText||'<空>').slice(0,400)`));
  step('1.10 刷新后·机会速览', await ev(`(document.getElementById('homeOpportunities').innerText||'<空>').slice(0,300)`));

  /* 点自选卡 → 进诊断 */
  await ev(`(() => { const c=document.querySelector('.wl-card'); if(c) c.click(); })()`);
  await wait(4000);
  step('1.11 点自选卡后·诊断标题', await ev(`document.getElementById('diagTitle').innerText`));
  step('1.12 诊断摘要', await ev(`(document.getElementById('diagSummaryBody').innerText||'<空>').slice(0,400)`));

  /* ========== 2. 其他功能快摸 ========== */
  /* 诊断页完整状态 */
  step('2.1 报告卡', await ev(`(document.getElementById('diagReportCard').innerText||'<空>').slice(0,400)`));
  step('2.2 三档区', await ev(`(() => { const el=document.querySelector('#diagContent'); const t=el?el.innerText:''; const i=t.indexOf('三档'); return i>=0?t.slice(i,i+300):'<无三档>'; })()`));

  /* 对比页 */
  await ev(`document.querySelector('.tabbar button[data-tab="compare"]').click()`);
  await wait(1500);
  step('2.3 对比页初始', await ev(`(document.querySelector('#tab-compare').innerText||'<空>').slice(0,300)`));

  /* 组合回测 */
  await ev(`document.querySelector('.tabbar button[data-tab="pfbt"]').click()`);
  await wait(1500);
  step('2.4 组合回测页初始', await ev(`(document.querySelector('#tab-pfbt').innerText||'<空>').slice(0,300)`));

  /* 诊断页 → 回测 */
  await ev(`document.querySelector('.tabbar button[data-tab="backtest"]').click()`);
  await wait(1000);
  step('2.5 回测页初始', await ev(`(document.querySelector('#tab-backtest').innerText||'<空>').slice(0,200)`));

  console.log('\n\n================ 报错汇总 ================');
  if (!errs.length) console.log('✅ 无错误');
  else { errs.slice(0, 30).forEach(e => console.log('⚠️ ' + e)); console.log('共 ' + errs.length + ' 条'); }
  cdp.close();
  process.exit(0);
}
main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
