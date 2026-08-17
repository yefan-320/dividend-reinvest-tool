#!/usr/bin/env node
/* v1.9.5 e2e：去平滑 + 口径标注实测
 * 断言：1) 信号线 tooltip 文本含"滚动 366 天 TTM"且无"平滑" 2) 带状图 note 含口径标注（逐年滚动+TTM）
 * 3) diagStats 标"当前股息率(年化)" 4) 无 console 错误 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8897;
const CDP_PORT = 9240;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-v195-profile-' + Date.now();

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  try { const d = fs.readFileSync(path.join(REPO, p)); res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'text/plain' }); res.end(d); }
  catch (e) { res.writeHead(404); res.end('nf'); }
});
server.listen(PORT);

let ws, msgId = 100;
const pending = {};
function cdp(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending[id] = { resolve, reject };
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('timeout ' + method)); } }, 40000);
  });
}
async function evalJS(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'eval err').slice(0, 300));
  return r.result ? r.result.value : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(expr, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evalJS(expr)) return true; } catch (e) { }
    await sleep(300);
  }
  return false;
}

async function main() {
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--disable-gpu', '--window-size=420,1000', 'about:blank'
  ]);
  let ready = false;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { ready = true; break; } } catch (e) {} await sleep(500); }
  if (!ready) { console.error('CDP 未就绪'); process.exit(2); }
  const tabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = tabs.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.addEventListener('message', e => {
    try { const d = JSON.parse(e.data); if (d.id && pending[d.id]) { pending[d.id].resolve(d.result || d); delete pending[d.id]; } } catch (x) {}
  });
  const errs = [];
  ws.addEventListener('message', e => {
    try { const d = JSON.parse(e.data); if (d.method === 'Runtime.exceptionThrown') errs.push((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description || '').slice(0, 200)); } catch (x) {}
  });
  await cdp('Page.enable', {});
  await cdp('Runtime.enable', {});
  await cdp('Page.navigate', { url: BASE });
  await sleep(8000);
  // v1.9.5：连续跑多个 Chrome 实例时启动可能慢，改为等 DL 就绪（防 window.DL undefined）
  if (!(await waitFor(`typeof window.DL !== 'undefined' && typeof window.DL.fetchName === 'function'`, 30000))) {
    console.error('页面 DL 未就绪'); process.exit(2);
  }

  // stub 数据：招行真实分红（2025-07-11 派 2.00 / 2026-01-16 派 1.013 / 2026-07-10 派 1.003）+ 300 天 K线
  await evalJS(`localStorage.removeItem('divtool_watchlist_v1'); 1`);
  await evalJS(`window.DL.fetchName = async () => '招商银行'; 1`);
  await evalJS(`window.DL.getStockQuotes = async (cs) => Object.fromEntries(cs.map(c=>[c,{price:38.5}])); 1`);
  await evalJS(`window.DL.fetchDividendsOne = async () => [
    { ex:'2024-07-11', report:'2024-06-30', dps:1.972 },
    { ex:'2025-07-11', report:'2024-12-31', dps:2.000 },
    { ex:'2026-01-16', report:'2025-06-30', dps:1.013 },
    { ex:'2026-07-10', report:'2025-12-31', dps:1.003 },
  ]; 1`);
  await evalJS(`(() => {
    const fmt = d => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const k = {};
    const end = new Date('2026-01-20');
    for (let i=299;i>=0;i--){ const d=new Date(end); d.setDate(d.getDate()-i); k[fmt(d)]=40; }
    k['2026-01-16']=38.55; k['2026-01-19']=38.6; k['2026-01-20']=38.5;
    window.DL.getKline = async () => k;
    return 1;
  })()`);
  await sleep(500);

  let pass = 0, fail = 0;
  const check = (name, ok, extra) => { console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra ? ' | ' + extra : '')); ok ? pass++ : fail++; };

  // 搜索进诊断（回车触发 openDiagnose）
  await evalJS(`(() => { const s=document.getElementById('homeSearch'); s.value='600036'; s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'})); return 1; })()`);
  const chartReady = await waitFor(`typeof echarts !== 'undefined' && echarts.getInstanceByDom(document.getElementById('diagSignalChart')) !== undefined`);
  check('诊断页信号线图已渲染', chartReady);

  // 1. tooltip formatter 文本（调用闭包 formatter，断言口径）
  const tip = await evalJS(`(() => {
    const chart = echarts.getInstanceByDom(document.getElementById('diagSignalChart'));
    const opt = chart.getOption();
    const fmt = opt.tooltip[0].formatter;
    const lastIdx = opt.xAxis[0].data.length - 1;
    return fmt([{ dataIndex: lastIdx }]);
  })()`);
  check('tooltip 含"滚动 366 天 TTM"', tip.includes('滚动 366 天 TTM'), tip.replace(/<[^>]+>/g, ''));
  check('tooltip 无"平滑"字样', !tip.includes('平滑'), tip.replace(/<[^>]+>/g, ''));

  // 2. 带状图 note 口径标注
  const note = await waitFor(`(document.getElementById('diagYieldNote')||{}).textContent && document.getElementById('diagYieldNote').textContent.includes('滚动 366 天 TTM')`);
  const noteTxt = await evalJS(`document.getElementById('diagYieldNote').textContent`);
  check('带状图 note 含 TTM 口径', note && noteTxt.includes('滚动 366 天 TTM'), noteTxt.slice(0, 80));
  check('带状图 note 含逐年滚动标注', noteTxt.includes('逐年滚动'), noteTxt.slice(0, 80));

  // 3. diagStats 年化口径标注
  const stats = await evalJS(`document.getElementById('diagStats').textContent`);
  check('diagStats 标"当前股息率(年化)"', stats.includes('当前股息率(年化)'), stats.slice(0, 60));

  console.log('\n结果:', pass + '/' + (pass + fail), '通过');
  console.log('console 错误:', errs.length, errs.slice(0, 3).join(' | '));
  server.close(); chrome.kill();
  process.exit(fail === 0 && errs.length === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e); server.close(); if (chrome) chrome.kill(); process.exit(2); });
