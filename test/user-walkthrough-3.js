#!/usr/bin/env node
/* test/user-walkthrough-3.js — 布局 DOM 检测 + 慢功能正确复测（2026-08-17）
 * 1) 布局检测：遍历全部 tab，找文本重叠/溢出/空白卡/canvas 异常/元素越界
 * 2) 扫描器/发现器用正确等待条件（#scanPanel 内容变化）复测
 * 3) 回测结果 #stats 记录
 * 4) 对比 588000+严格+月供 复测（确认是否限流）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8899;
const CDP_PORT = 9236;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-userwalk3-' + Date.now();
const SHOTDIR = '/tmp/userwalk3-' + Date.now();
fs.mkdirSync(SHOTDIR, { recursive: true });

const pageErrors = [];
const dialogs = [];
const notes = [];
const issues = [];

function ok(msg) { console.log('  ✅ ' + msg); }
function warn(msg) { console.log('  ⚠️ ' + msg); }
function issue(level, name, msg) { issues.push({ level, name, msg }); console.log(`  ${level === 'BUG' ? '❌' : '⚠️'} [${level}] ${name}: ${msg}`); }
function note(name, val) { notes.push({ name, val: String(val).slice(0, 500) }); console.log('  📝 ' + name + ': ' + String(val).slice(0, 350)); }
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
              if (!d.includes('Script error.')) pageErrors.push('异常: ' + String(d).slice(0, 400));
            });
            cdp.on('Log.entryAdded', p => {
              if (p.entry && p.entry.level === 'error') {
                const t = (p.entry.text || '').slice(0, 300);
                if (t && !t.includes('Script error.') && !t.includes('net::ERR') && !t.includes('CORS policy')
                    && !t.includes('np-cnotice') && !t.includes('allorigins') && !t.includes('api.fund.eastmoney')
                    && !t.includes('Failed to load resource')) pageErrors.push('console错误: ' + t);
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
    return 'EVAL_ERR:' + String((ed.exception && ed.exception.description) || ed.text).slice(0, 200);
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function waitFor(cdp, expr, timeout, desc, interval = 3000) {
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
async function click(cdp, sel) {
  const r = await evalIn(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'MISSING'; el.click(); return 'clicked'; })()`);
  if (r !== 'clicked') warn('元素缺失: ' + sel);
  return r;
}

/* ============ 布局检测（核心） ============ */
const LAYOUT_CHECK = `(() => {
  const out = [];
  const vis = el => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const hasText = el => (el.innerText || '').trim().length > 0;
  const hasCanvas = el => !!el.querySelector('canvas');
  // 1. 文本元素溢出容器（横向）
  document.querySelectorAll('div,span,td,th,h1,h2,h3,label,button,input').forEach(el => {
    if (!vis(el) || !hasText(el)) return;
    if (el.scrollWidth > el.clientWidth + 3 && el.clientWidth > 0) {
      const s = getComputedStyle(el);
      if (!['hidden','auto','scroll'].includes(s.overflowX)) {
        out.push('溢出: <' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '> 文本' + el.innerText.slice(0, 30) + ' scrollW=' + el.scrollWidth + ' clientW=' + el.clientWidth);
      }
    }
  });
  // 2. canvas 尺寸异常
  document.querySelectorAll('canvas').forEach(c => {
    if (!vis(c)) return;
    if (c.width < 50 || c.height < 20) out.push('canvas异常: ' + (c.id || '无名') + ' w=' + c.width + ' h=' + c.height);
    const r = c.getBoundingClientRect();
    if (r.width < 50 || r.height < 20) out.push('canvas布局异常: ' + (c.id || '无名') + ' rectW=' + r.width.toFixed(0) + ' rectH=' + r.height.toFixed(0));
  });
  // 3. 空白卡片（有标题但内容空）
  document.querySelectorAll('.card').forEach(c => {
    if (!vis(c)) return;
    const h2 = c.querySelector('h2');
    const body = c.innerText.replace((h2 ? h2.innerText : ''), '').trim();
    if (h2 && body.length === 0 && !hasCanvas(c)) out.push('空白卡: ' + h2.innerText.slice(0, 30));
  });
  // 4. 关键元素重叠（文本块互相覆盖，仅检测可见的较大块）
  const blocks = [];
  document.querySelectorAll('h1,h2,h3,.btn,.chip,label,th,.status').forEach(el => {
    if (!vis(el) || !hasText(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return;
    blocks.push({ el, r });
  });
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i].r, b = blocks[j].r;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > Math.min(a.width, b.width) * 0.4 && oy > Math.min(a.height, b.height) * 0.4) {
        // 父子关系不算重叠
        if (blocks[i].el.contains(blocks[j].el) || blocks[j].el.contains(blocks[i].el)) continue;
        out.push('重叠: <' + blocks[i].el.tagName.toLowerCase() + (blocks[i].el.id ? '#' + blocks[i].el.id : '') + ':' + blocks[i].el.innerText.slice(0, 20) + '> × <' + blocks[j].el.tagName.toLowerCase() + (blocks[j].el.id ? '#' + blocks[j].el.id : '') + ':' + blocks[j].el.innerText.slice(0, 20) + '>');
      }
    }
  }
  // 5. 视口横向溢出
  if (document.documentElement.scrollWidth > window.innerWidth + 2) {
    out.push('横向溢出: scrollW=' + document.documentElement.scrollWidth + ' innerW=' + window.innerWidth);
  }
  // 6. 元素超出视口右边界（>20px）
  document.querySelectorAll('.card,button,input,.chart,.tabbar').forEach(el => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 20 && r.left < window.innerWidth) {
      out.push('越界右: <' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '> right=' + r.right.toFixed(0) + ' > innerW=' + window.innerWidth);
    }
  });
  return out;
})()`;

async function layoutCheck(cdp, label) {
  const r = await evalIn(cdp, LAYOUT_CHECK);
  const arr = Array.isArray(r) ? r : [];
  if (!arr.length) ok('布局检查[' + label + '] 干净');
  else arr.forEach(x => issue('BUG', '布局[' + label + ']', x));
  return arr.length;
}

async function main() {
  /* v3.7.0（接手 AI）：启动前清理残留实例（release 连续跑 CDP 测试时旧 Chrome 占端口→连旧页面→超时） */
  try { require('child_process').execSync('lsof -tiTCP:' + ' + CDP_PORT + ' + ' -sTCP:LISTEN | xargs kill -9 2>/dev/null; sleep 1', { timeout: 8000, stdio: 'ignore' }); } catch (e) {}
  await ensureServer();
  await launchChrome();
  let cdp;
  try { cdp = await cdpConnect(); } catch (e) { die('CDP 连接失败: ' + e.message); }

  /* ===== 1. 初始 + 布局检测（离线 demo） ===== */
  await nav(cdp, BASE);
  await new Promise(r => setTimeout(r, 6000));
  await layoutCheck(cdp, '决策台-初始');

  /* ===== 2. 回测（联网）后布局检测 ===== */
  await click(cdp, `.tabbar button[data-tab="backtest"]`);
  await click(cdp, '#btnRun');
  try { await waitFor(cdp, `(() => { const t = (document.getElementById('status')||{}).innerText || ''; return t.includes('完成') ? t : ''; })()`, 120000, '回测'); } catch (e) { issue('BUG', '回测', e.message); }
  note('回测 #stats', await evalIn(cdp, `(document.getElementById('stats')||{}).innerText.slice(0, 400) || '(无)'`));
  note('回测 #stockName', await evalIn(cdp, `(document.getElementById('stockName')||{}).innerText || '(无)'`));
  note('年度明细表', await evalIn(cdp, `document.getElementById('tbl').innerText.slice(0, 300)`));
  await new Promise(r => setTimeout(r, 2000));
  await layoutCheck(cdp, '回测-结果');

  /* ===== 3. 诊断布局 ===== */
  await click(cdp, `.tabbar button[data-tab="home"]`);
  await evalIn(cdp, `(() => { const el = document.getElementById('homeSearch'); el.value = '600036'; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); return 1; })()`);
  try { await waitFor(cdp, `document.getElementById('diagStats') && document.getElementById('diagStats').innerText.length > 20`, 60000, '诊断'); } catch (e) { issue('BUG', '诊断加载', e.message); }
  await new Promise(r => setTimeout(r, 4000));
  await layoutCheck(cdp, '诊断-600036');

  /* ===== 4. 对比布局（600036+512890） ===== */
  await click(cdp, `.tabbar button[data-tab="compare"]`);
  await evalIn(cdp, `(() => { const chip = document.querySelector('#tab-compare .chip'); if (chip) chip.click(); return 1; })()`);
  await new Promise(r => setTimeout(r, 1200));
  await evalIn(cdp, `(() => { const el = document.getElementById('cmpInput'); el.value = '600036'; el.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await click(cdp, '#btnCmpAdd');
  await new Promise(r => setTimeout(r, 2500));
  await click(cdp, '#btnCmpRun');
  try { await waitFor(cdp, `(() => { const els = [...document.querySelectorAll('#cmpTbl tr')]; return els.length > 5 ? 'rows' : ''; })()`, 120000, '对比'); } catch (e) { issue('BUG', '对比600036+512890', e.message); }
  await new Promise(r => setTimeout(r, 2000));
  await layoutCheck(cdp, '对比-结果');

  /* ===== 5. 扫描器正确等待 ===== */
  await click(cdp, `.tabbar button[data-tab="home"]`);
  await click(cdp, '#btnScan');
  try {
    const t = await waitFor(cdp, `(() => { const t = (document.getElementById('scanPanel')||{}).innerText || ''; return (t.includes('✅ 筛选出') || t.includes('失败') || t.includes('获取失败')) ? t.slice(0, 120) : ''; })()`, 300000, '扫描器');
    note('扫描器结果', t);
    note('扫描器行数', await evalIn(cdp, `document.querySelectorAll('#scanPanel .scan-row').length`));
    await new Promise(r => setTimeout(r, 1000));
    await layoutCheck(cdp, '扫描器结果');
  } catch (e) { issue('BUG', '扫描器 300s 无结果', e.message); }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) fs.writeFileSync(SHOTDIR + '/scan.png', Buffer.from(shot.result.data, 'base64'));

  /* ===== 6. 发现器正确等待（可能慢：80+ 请求） ===== */
  await click(cdp, '#btnDiscover');
  try {
    const t = await waitFor(cdp, `(() => { const t = (document.getElementById('scanPanel')||{}).innerText || ''; return (t.includes('✅ 发现') || t.includes('完成') || t.includes('失败') || t.includes('限流')) ? t.slice(0, 150) : ''; })()`, 300000, '发现器');
    note('发现器结果', t);
    note('发现器候选行', await evalIn(cdp, `document.querySelectorAll('#scanPanel [data-code]').length`));
    await new Promise(r => setTimeout(r, 1000));
    await layoutCheck(cdp, '发现器结果');
  } catch (e) { issue('BUG', '发现器 300s 无结果', e.message); }

  /* ===== 7. 对比 588000+严格+月供 复测 ===== */
  await click(cdp, `.tabbar button[data-tab="compare"]`);
  await evalIn(cdp, `(() => { const el = document.getElementById('cmpInput'); el.value = '588000'; el.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await click(cdp, '#btnCmpAdd');
  await new Promise(r => setTimeout(r, 3000));
  await evalIn(cdp, `document.getElementById('cmpStrict').click()`);
  await evalIn(cdp, `(() => { const el = document.getElementById('cmpMonthly'); el.value = '3000'; el.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await click(cdp, '#btnCmpRun');
  try {
    await waitFor(cdp, `(() => { const els = [...document.querySelectorAll('#cmpTbl tr')]; return els.length > 5 ? 'rows' : ''; })()`, 150000, '对比588000');
    note('588000对比成功', '表格行数: ' + await evalIn(cdp, `document.querySelectorAll('#cmpTbl tr').length`));
    note('cmpWarn', await evalIn(cdp, `(document.getElementById('cmpWarn')||{}).innerText || '(无)'`));
    note('cmpNote', await evalIn(cdp, `(document.getElementById('cmpNote')||{}).innerText.slice(0, 200) || '(无)'`));
  } catch (e) { issue('BUG', '对比588000+严格+月供 150s 无结果', e.message); }

  /* ===== 汇总 ===== */
  console.log('\n================ 汇总 ================');
  console.log('问题 ' + issues.length + ' 条');
  issues.forEach(i => console.log(`  ${i.level === 'BUG' ? '❌' : '⚠️'} ${i.name}: ${i.msg}`));
  console.log('页面错误 ' + pageErrors.length + ' 条');
  pageErrors.forEach(e => console.log('  ❌ ' + e));
  console.log('弹窗 ' + dialogs.length + ' 个');
  dialogs.forEach(d => console.log('  ⚠️ ' + d));
  fs.writeFileSync(SHOTDIR + '/summary.json', JSON.stringify({ issues, pageErrors, dialogs, notes }, null, 2));
  console.log('存档: ' + SHOTDIR + '/summary.json');
  cdp.close();
  process.exit(0);
}

main().catch(e => { console.error('中断: ' + e.message); process.exit(2); });
