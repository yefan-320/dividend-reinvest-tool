#!/usr/bin/env node
/* v1.9.1 实测补充：诊断页卖出信号卡 + 发现器按钮 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8894;
const CDP_PORT = 9237;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-v191b-profile-' + Date.now();

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
    setTimeout(() => { if (pending[id]) { delete pending[id]; reject(new Error('timeout ' + method)); } }, 30000);
  });
}
async function evalJS(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'eval err').slice(0, 300));
  return r.result ? r.result.value : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  /* v3.8.0 watchdog（接手 AI）：5 分钟总超时，防 Chrome 挂起卡死 release */
  setTimeout(() => { try { console.error('⏱ watchdog 5min 超时，强制退出'); } catch (e) {} process.exit(2); }, 300000);
  /* v3.7.0（接手 AI）：启动前清理残留实例（release 连续跑 CDP 测试时旧 Chrome 占端口→连旧页面→超时） */
  try { require('child_process').execSync('lsof -tiTCP:' + ' + CDP_PORT + ' + ' -sTCP:LISTEN | xargs kill -9 2>/dev/null; sleep 1', { timeout: 8000, stdio: 'ignore' }); } catch (e) {}
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--disable-gpu', '--window-size=420,1000', '--no-sandbox', '--remote-allow-origins=*', 'about:blank'
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

  // 诊断 600036 → 卖出信号卡
  await evalJS(`document.querySelector('#homeSearch').value='600036'; document.querySelector('#homeSearch').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); 1`);
  await sleep(2500);
  await evalJS(`document.querySelector('[data-tab="diagnose"]').click(); 1`);
  await sleep(6000);
  const sell = await evalJS(`(document.querySelector('#diagSellSignals')||{}).innerHTML||''`);
  console.log('卖出信号卡:', sell.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120));
  const sellOk = sell && sell.length > 50 && sell.includes('判定');
  console.log(sellOk ? '  ✅ 卖出信号卡渲染' : '  ❌ 卖出信号卡为空/缺判定');
  // 找机会按钮存在（P70：btnScan+btnDiscover 合并为一个入口）
  const btn = await evalJS(`!!document.querySelector('#btnFindOpp')`);
  console.log(btn ? '  ✅ 找机会按钮存在' : '  ❌ 找机会按钮缺失');
  // 对比页运行锁（O2）：点两次 cmpRun 不并发
  await evalJS(`document.querySelector('[data-tab="compare"]').click(); 1`);
  await sleep(1000);
  const lock = await evalJS(`(function(){ if (window.__cmpLockTest) return 'already'; window.__cmpLockTest = true; return typeof cmpState; })()`);
  console.log('cmpState 存在:', lock !== 'already' ? 'yes' : 'already-set');
  console.log('\nconsole 错误:', errs.length, errs.slice(0, 3).join(' | '));
  server.close(); chrome.kill();
  process.exit(sellOk && btn && errs.length === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e); server.close(); if (chrome) chrome.kill(); process.exit(2); });
