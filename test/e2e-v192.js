#!/usr/bin/env node
/* v1.9.2 组合回测 tab 实测：tab 存在 → 添加自选 → 运行回测 → 策略表渲染 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8895;
const CDP_PORT = 9238;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-v192-profile-' + Date.now();

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

  // 添加 2 只自选
  await evalJS(`(async () => { await window.DL.Watchlist.add('600036','招商银行'); await window.DL.Watchlist.add('601398','工商银行'); return 1; })()`);
  await sleep(500);
  // 切到组合回测 tab
  await evalJS(`document.querySelector('[data-tab="pfbt"]').click(); 1`);
  await sleep(1000);
  const panel = await evalJS(`document.getElementById('tab-pfbt').style.display`);
  const btn = await evalJS(`!!document.getElementById('pfbtRun')`);
  console.log('组合回测 tab:', panel === 'block' ? '✅ 显示' : '❌ 未显示', '| 运行按钮:', btn ? '✅' : '❌');
  // 切 5 年区间
  await evalJS(`document.querySelectorAll('.pfbt-y')[1].click(); 1`);
  await sleep(300);
  const ySel = await evalJS(`document.querySelector('.pfbt-y.on').dataset.y`);
  console.log('区间选择:', ySel);
  // 运行（无组合→空态引导）
  await evalJS(`document.getElementById('pfbtRun').click(); 1`);
  await sleep(3000);
  const emptyHtml = await evalJS(`(document.getElementById('pfbtResult')||{}).innerHTML||''`);
  const hasGuide = emptyHtml.includes('去决策台') && emptyHtml.includes('示例组合');
  console.log('空态引导:', hasGuide ? '✅' : '❌');
  // 建组合（直接注入 localStorage）→ 重跑
  await evalJS(`localStorage.setItem('divtool_combos_v1', JSON.stringify({combos:[{id:'c1',name:'测试组合',items:[{code:'600036',name:'招商银行',amount:500000,monthly:3000},{code:'601398',name:'工商银行',amount:300000,monthly:2000}]}],activeId:'c1'})); location.reload(); 1`);
  await sleep(3500);
  await evalJS(`document.querySelector('[data-tab="pfbt"]').click(); 1`);
  await sleep(600);
  await evalJS(`document.getElementById('pfbtRun').click(); 1`);
  await sleep(25000);
  const resHtml = await evalJS(`(document.getElementById('pfbtResult')||{}).innerHTML||''`);
  const txt = resHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
  console.log('驾驶舱结果:', txt);
  const hasCockpit = resHtml.includes('累计分红÷投入成本') && resHtml.includes('期末总资产') && resHtml.includes('cockpitMain');
  const hasCharts = await evalJS(`!!document.getElementById('cockpitMain') && !!document.getElementById('cockpitMain').querySelector('canvas')`);
  console.log(hasCockpit && hasCharts ? '  ✅ 驾驶舱三问卡 + 主图渲染' : '  ❌ 驾驶舱缺三问/主图');
  console.log('\nconsole 错误:', errs.length, errs.slice(0, 3).join(' | '));
  server.close(); chrome.kill();
  process.exit(panel === 'block' && btn && hasGuide && hasCockpit && hasCharts && errs.length === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e); server.close(); if (chrome) chrome.kill(); process.exit(2); });
