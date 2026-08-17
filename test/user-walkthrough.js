#!/usr/bin/env node
/* test/user-walkthrough.js — 用户视角真实使用漫游 v1（2026-08-17 主人令）
 * 像真人一样打开页面，逐项操作每个功能：每步截图 + 记录页面状态 + 收集 JS 错误/弹窗。
 * 目的：找出"功能通了但用户用起来有问题"的体验/渲染/可读性问题。
 * 用法：node test/user-walkthrough.js   （退出码 0=走完，1=有异常）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8899;
const CDP_PORT = 9234;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-userwalk-' + Date.now();
const SHOTDIR = '/tmp/userwalk-' + Date.now();

fs.mkdirSync(SHOTDIR, { recursive: true });

const pageErrors = [];
const dialogs = [];
const notes = [];

function ok(msg) { console.log('  ✅ ' + msg); }
function warn(msg) { console.log('  ⚠️ ' + msg); }
function note(name, val) { notes.push({ name, val: String(val).slice(0, 500) }); console.log('  📝 ' + name + ': ' + String(val).slice(0, 300)); }
function die(msg) { console.error('❌ 基础设施失败: ' + msg); process.exit(2); }

function ensureServer() {
  return new Promise(resolve => {
    http.get(`http://localhost:${PORT}/`, r => { r.resume(); r.on('end', () => resolve(true)); })
      .on('error', () => {
        const cp = require('child_process').spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, detached: true, stdio: 'ignore' });
        cp.unref();
        setTimeout(resolve, 1500, true);
      });
  });
}

function launchChrome() {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(chrome)) die('Chrome 不存在');
  const cp = require('child_process').spawn(chrome, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=800,1700', `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  cp.unref();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { if (JSON.parse(d).length >= 0) resolve(); } catch (e) { setTimeout(poll, 300); } });
      }).on('error', () => { if (Date.now() - t0 > 25000) reject(new Error('Chrome 启动超时')); else setTimeout(poll, 300); });
    })();
  });
}

function cdpConnect() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        const page = JSON.parse(d).find(t => t.type === 'page');
        if (!page) return reject(new Error('无页面'));
        const ws = new (require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws'))(page.webSocketDebuggerUrl);
        let id = 0; const pend = new Map(); const handlers = new Map();
        ws.onmessage = ev => {
          const m = JSON.parse(ev.data);
          if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
          if (m.method && handlers.has(m.method)) handlers.get(m.method).forEach(fn => fn(m.params));
        };
        ws.onopen = () => {
          const cdp = {
            send: (method, params = {}) => new Promise(res => { const mid = ++id; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); }),
            on: (method, fn) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn); },
            close: () => ws.close(),
          };
          Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]).then(() => {
            cdp.on('Runtime.exceptionThrown', p => {
              const d = (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) || (p.exceptionDetails && p.exceptionDetails.text) || 'unknown';
              const url = (p.exceptionDetails && p.exceptionDetails.url) || '';
              if (d.includes('Script error.')) return;
              pageErrors.push('异常: ' + String(d).slice(0, 400) + (url ? ' @' + url : ''));
            });
            cdp.on('Log.entryAdded', p => {
              if (p.entry && p.entry.level === 'error') {
                const t = (p.entry.text || '').slice(0, 300);
                if (t && !t.includes('Script error.') && !t.includes('net::ERR')
                    && !t.includes('CORS policy') && !t.includes('np-cnotice') && !t.includes('allorigins')
                    && !t.includes('api.fund.eastmoney') && !t.includes('Failed to load resource')) pageErrors.push('console错误: ' + t);
              }
            });
            cdp.on('Page.javascriptDialogOpening', async p => {
              dialogs.push(p.message || '');
              await cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
            });
            resolve(cdp);
          }).catch(reject);
        };
        ws.onerror = e => reject(e);
      });
    }).on('error', reject);
  });
}

async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    const ed = r.result.exceptionDetails;
    throw new Error('eval异常: ' + String((ed.exception && ed.exception.description) || ed.text).slice(0, 300));
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function waitFor(cdp, expr, timeout, desc, interval = 2000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try { last = await evalIn(cdp, expr); } catch (e) { last = null; }
    if (last) return last;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('等待超时(' + (timeout / 1000) + 's): ' + desc);
}

async function nav(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, `typeof APP_VERSION !== 'undefined'`, 30000, '页面加载');
}

let shotSeq = 0;
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const data = r.result ? r.result.data : undefined;
  if (!data) throw new Error('截图无数据');
  const f = `${SHOTDIR}/${String(++shotSeq).padStart(2, '0')}-${name}.png`;
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  ok('截图 ' + path.basename(f));
}

async function click(cdp, sel) {
  const r = await evalIn(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'MISSING:' + ${JSON.stringify(sel)}; el.click(); return 'clicked'; })()`);
  if (String(r).startsWith('MISSING')) warn(r);
  return r;
}

async function main() {
  await ensureServer();
  await launchChrome();
  let cdp;
  try { cdp = await cdpConnect(); } catch (e) { die('CDP 连接失败: ' + e.message); }

  /* ===== 1. 首屏：决策台（离线演示自动跑） ===== */
  await nav(cdp, BASE);
  await waitFor(cdp, `document.querySelectorAll('canvas').length > 0 || (document.getElementById('status')||{}).innerText`, 30000, '首屏渲染');
  await new Promise(r => setTimeout(r, 3000));
  note('首屏版本', await evalIn(cdp, `(document.getElementById('verBar')||{}).innerText || document.title`));
  note('首屏自选列表', await evalIn(cdp, `(document.getElementById('watchlist')||{}).innerText ? document.getElementById('watchlist').innerText.slice(0,200) : '(无 #watchlist)'`));
  note('首屏可见tab', await evalIn(cdp, `[...document.querySelectorAll('.tabbar button')].map(b=>b.textContent.trim()+'('+(b.className.includes('active')?'激活':'')+')').join(' | ')`));
  await shot(cdp, '01-首屏-决策台');

  /* ===== 2. 逐 tab 切换 ===== */
  for (const [tab, label] of [['diagnose', '诊断'], ['compare', '对比'], ['backtest', '回测'], ['pfbt', '组合回测'], ['home', '决策台']]) {
    await click(cdp, `.tabbar button[data-tab="${tab}"]`);
    await new Promise(r => setTimeout(r, 800));
    const vis = await evalIn(cdp, `[...document.querySelectorAll('.tab-panel')].filter(p=>p.style.display!=='none').map(p=>p.id).join(',')`);
    note('切换tab=' + label, '可见面板: ' + vis);
    await shot(cdp, '02-tab-' + label);
  }

  /* ===== 3. 回测页：默认 600036 回测 ===== */
  await click(cdp, `.tabbar button[data-tab="backtest"]`);
  await shot(cdp, '03-回测-初始表单');
  await click(cdp, '#btnRun');
  try {
    await waitFor(cdp, `(() => { const t = (document.getElementById('status')||{}).innerText || ''; return t.includes('完成') || t.includes('失败') || t.includes('错误') ? t : ''; })()`, 120000, '回测完成');
  } catch (e) { warn('回测等待超时: ' + e.message); }
  note('回测状态', await evalIn(cdp, `(document.getElementById('status')||{}).innerText || ''`));
  note('回测结果-资产', await evalIn(cdp, `(() => { const el = document.getElementById('assetSummary') || document.querySelector('.card h3'); return el ? el.innerText.slice(0,300) : '(无资产摘要)'; })()`));
  note('回测-canvas数', await evalIn(cdp, `document.querySelectorAll('#tab-backtest canvas').length`));
  await shot(cdp, '04-回测-结果');

  /* 口径切换 */
  await click(cdp, `input[name="divMode"][value="report"]`);
  await new Promise(r => setTimeout(r, 1500));
  await shot(cdp, '05-回测-分红口径报告期');

  /* 10年前快捷 */
  await click(cdp, `#tab-backtest button[data-y="10"]`);
  await new Promise(r => setTimeout(r, 800));
  note('10年前按钮后买入日期', await evalIn(cdp, `document.getElementById('buyDate').value`));
  await click(cdp, '#btnRun');
  try {
    await waitFor(cdp, `(() => { const t = (document.getElementById('status')||{}).innerText || ''; return t.includes('完成') ? t : ''; })()`, 120000, '10年回测完成');
  } catch (e) { warn('10年回测等待超时'); }
  await shot(cdp, '06-回测-10年结果');

  /* 演示数据按钮 */
  await click(cdp, '#btnDemo');
  await new Promise(r => setTimeout(r, 2500));
  await shot(cdp, '07-回测-演示数据');

  /* ===== 4. 诊断页 ===== */
  await click(cdp, `.tabbar button[data-tab="diagnose"]`);
  const diagInput = await evalIn(cdp, `document.querySelector('#tab-diagnose input') ? document.querySelector('#tab-diagnose input').id : '(无输入框)'`);
  note('诊断页输入框', diagInput);
  // 用搜索框进诊断（真实用户路径）
  await click(cdp, `.tabbar button[data-tab="home"]`);
  const setVal = await evalIn(cdp, `(() => { const el = document.getElementById('homeSearch'); if (!el) return 'NO homeSearch'; el.value = '600036'; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); return 'entered'; })()`);
  note('搜索600036', setVal);
  try {
    await waitFor(cdp, `document.getElementById('diagName') && document.getElementById('diagName').innerText.includes('招商')`, 60000, '诊断加载');
  } catch (e) { warn('诊断加载超时: ' + e.message); }
  note('诊断标题', await evalIn(cdp, `(document.getElementById('diagName')||{}).innerText || '(无 diagName)'`));
  note('诊断卡片数', await evalIn(cdp, `document.querySelectorAll('#tab-diagnose .card').length`));
  note('诊断canvas数', await evalIn(cdp, `document.querySelectorAll('#tab-diagnose canvas').length`));
  note('加自选按钮可见', await evalIn(cdp, `(() => { const b = document.getElementById('diagWlBtn'); return b ? (b.style.display !== 'none' ? '可见' : '隐藏') : '(无)'; })()`));
  await shot(cdp, '08-诊断-600036');

  /* 诊断年数切换 10年 */
  await click(cdp, `#tab-diagnose button[data-y="10"]`);
  await new Promise(r => setTimeout(r, 6000));
  await shot(cdp, '09-诊断-10年');

  /* 诊断页回测验证跳转 */
  await click(cdp, '#btnDiagBacktest');
  await new Promise(r => setTimeout(r, 800));
  note('回测验证跳转后代码框', await evalIn(cdp, `document.getElementById('code').value`));
  await shot(cdp, '10-诊断-跳转回测');

  /* ===== 5. 对比页 ===== */
  await click(cdp, `.tabbar button[data-tab="compare"]`);
  await shot(cdp, '11-对比-初始');
  // 添加 ETF chip
  const chipAdd = await evalIn(cdp, `(() => { const chips = [...document.querySelectorAll('#tab-compare .chip')]; if (!chips.length) return 'NO chips'; chips[0].click(); return 'clicked ' + chips[0].innerText; })()`);
  note('对比chips添加', chipAdd);
  await new Promise(r => setTimeout(r, 1000));
  // 输入代码 601398 工行
  const cmpIn = await evalIn(cdp, `(() => { const el = document.getElementById('cmpInput'); if (!el) return 'NO cmpInput'; el.value = '601398'; el.dispatchEvent(new Event('input', {bubbles:true})); return 'typed'; })()`);
  note('对比输入601398', cmpIn);
  await click(cdp, '#btnCmpAdd');
  await new Promise(r => setTimeout(r, 2500));
  note('对比列表', await evalIn(cdp, `(() => { const box = document.getElementById('cmpList') || document.querySelector('#tab-compare .watchlist') || document.querySelector('#tab-compare ul'); return box ? box.innerText.slice(0,200) : '(找列表失败)'; })()`));
  await click(cdp, '#btnCmpRun');
  try {
    await waitFor(cdp, `(() => { const els = [...document.querySelectorAll('#tab-compare td')]; return els.length > 10 ? 'rows' : ''; })()`, 90000, '对比运行');
  } catch (e) { warn('对比运行超时: ' + e.message); }
  note('对比表格行', await evalIn(cdp, `document.querySelectorAll('#tab-compare tbody tr').length`));
  note('对比canvas数', await evalIn(cdp, `document.querySelectorAll('#tab-compare canvas').length`));
  await shot(cdp, '12-对比-结果');

  /* 每年分红图口径切换 */
  await click(cdp, `input[name="cmpAnnualMode"][value="report"]`);
  await new Promise(r => setTimeout(r, 1500));
  await shot(cdp, '13-对比-年度分红报告期');

  /* 日期输入 */
  const dset = await evalIn(cdp, `(() => { const el = document.getElementById('cmpStartDate'); if (!el) return 'NO cmpStartDate'; el.value = '2020-01-02'; el.dispatchEvent(new Event('change', {bubbles:true})); return 'set ' + el.value; })()`);
  note('对比起始日期', dset);
  await new Promise(r => setTimeout(r, 1000));
  await shot(cdp, '14-对比-日期2020');

  /* ===== 6. 决策台：扫描器 + 发现器 ===== */
  await click(cdp, `.tabbar button[data-tab="home"]`);
  await click(cdp, '#btnScan');
  try {
    await waitFor(cdp, `(() => { const t = (document.getElementById('scanStatus')||{}).innerText || ''; return t.includes('完成') || t.includes('失败') ? t : ''; })()`, 150000, '扫描器完成');
  } catch (e) { warn('扫描器等待超时: ' + e.message); }
  note('扫描器状态', await evalIn(cdp, `(document.getElementById('scanStatus')||{}).innerText || '(无scanStatus)'`));
  note('扫描结果行数', await evalIn(cdp, `document.querySelectorAll('#scanResults tbody tr, #scanResults tr').length`));
  await shot(cdp, '15-决策台-扫描器');

  await click(cdp, '#btnDiscover');
  try {
    await waitFor(cdp, `(() => { const t = (document.getElementById('discoverStatus')||{}).innerText || ''; return t.includes('完成') || t.includes('失败') ? t : ''; })()`, 150000, '发现器完成');
  } catch (e) { warn('发现器等待超时: ' + e.message); }
  note('发现器状态', await evalIn(cdp, `(document.getElementById('discoverStatus')||{}).innerText || '(无discoverStatus)'`));
  await shot(cdp, '16-决策台-发现器');

  /* 组合总览卡展开 */
  const ovBtn = await evalIn(cdp, `(() => { const b = document.getElementById('btnPortfolioOverview'); return b ? '有' : '无'; })()`);
  note('组合总览按钮', ovBtn);
  if (ovBtn === '有') {
    await click(cdp, '#btnPortfolioOverview');
    await new Promise(r => setTimeout(r, 4000));
    await shot(cdp, '17-决策台-组合总览');
  }

  /* ===== 7. 组合回测 ===== */
  await click(cdp, `.tabbar button[data-tab="pfbt"]`);
  await shot(cdp, '18-组合回测-初始');
  await click(cdp, '#pfbtRun');
  try {
    await waitFor(cdp, `(() => { const t = (document.getElementById('pfbtStatus')||{}).innerText || ''; return t.includes('完成') ? t : ''; })()`, 90000, '组合回测完成');
  } catch (e) { warn('组合回测等待超时: ' + e.message); }
  note('组合回测状态', await evalIn(cdp, `(document.getElementById('pfbtStatus')||{}).innerText || '(无pfbtStatus)'`));
  note('组合回测结果行', await evalIn(cdp, `document.querySelectorAll('#tab-pfbt tbody tr, #tab-pfbt .result-row, #tab-pfbt tr').length`));
  await shot(cdp, '19-组合回测-结果');

  /* ===== 8. 移动端 390px ===== */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await new Promise(r => setTimeout(r, 1500));
  await shot(cdp, '20-移动端-决策台');
  await click(cdp, `.tabbar button[data-tab="backtest"]`);
  await new Promise(r => setTimeout(r, 1500));
  await shot(cdp, '21-移动端-回测');
  await click(cdp, `.tabbar button[data-tab="compare"]`);
  await new Promise(r => setTimeout(r, 1500));
  await shot(cdp, '22-移动端-对比');

  /* ===== 汇总 ===== */
  console.log('\n================ 漫游汇总 ================');
  console.log('截图目录: ' + SHOTDIR);
  console.log('页面错误 ' + pageErrors.length + ' 条:');
  pageErrors.forEach(e => console.log('  ❌ ' + e));
  console.log('弹窗 ' + dialogs.length + ' 个:');
  dialogs.forEach(d => console.log('  ⚠️ ' + d));
  console.log('笔记 ' + notes.length + ' 条（详见上方 📝）');
  fs.writeFileSync(SHOTDIR + '/notes.json', JSON.stringify({ notes, pageErrors, dialogs }, null, 2));
  console.log('笔记存档: ' + SHOTDIR + '/notes.json');
  cdp.close();
  process.exit(pageErrors.length > 0 ? 1 : 0);
}

main().catch(e => { console.error('漫游中断: ' + e.message); process.exit(2); });
