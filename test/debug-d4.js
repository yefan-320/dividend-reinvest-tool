#!/usr/bin/env node
/* 复现 D4 失败 v2：走真实用户路径（搜索框），分阶段打印状态 + 抓 console 错误 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8892;
const CDP_PORT = 9235;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-d4b-profile-' + Date.now();

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
ws = null;
async function evalJS(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'eval err').slice(0, 400));
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
    '--no-first-run', '--disable-gpu', '--window-size=420,900', '--no-sandbox', '--remote-allow-origins=*', 'about:blank'
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
    try { const d = JSON.parse(e.data); if (d.method === 'Runtime.exceptionThrown') errs.push((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description || '').slice(0, 250)); } catch (x) {}
  });
  await cdp('Page.enable', {});
  await cdp('Runtime.enable', {});
  await cdp('Page.navigate', { url: BASE });
  await sleep(8000);
  console.log('页面加载完成，检查基础状态:');
  console.log('  APP_VERSION:', await evalJS('APP_VERSION'));
  console.log('  echarts:', await evalJS('typeof echarts'));
  console.log('  DL:', await evalJS('typeof DL'));
  console.log('  搜索框存在:', await evalJS(`!!document.getElementById('homeSearch')`));
  console.log('  搜索框绑定:', await evalJS(`(document.getElementById('homeSearch').onkeydown ? 'inline' : (typeof document.getElementById('homeSearch').getAttribute('onkeydown') !== 'undefined' ? 'attr' : '需要看addEventListener'))`));
  // 检查 homeSearch 的 Enter 绑定方式
  console.log('  搜索框监听器:', await evalJS(`(function(){ const i = document.getElementById('homeSearch'); return i.dataset.bound || 'unbound-flag'; })()`));
  // 直接调 search 流程：看看 enter 触发的代码
  await evalJS(`(() => { const i = document.getElementById('homeSearch'); i.value='512890'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(3000);
  console.log('Enter 后 3s:');
  console.log('  tab-diagnose display:', await evalJS(`document.getElementById('tab-diagnose').style.display`));
  console.log('  diagTitle:', await evalJS(`document.getElementById('diagTitle').textContent`));
  console.log('  diagStats:', (await evalJS(`document.getElementById('diagStats').innerHTML`)).slice(0, 80));
  console.log('  diagEtfNote display:', await evalJS(`document.getElementById('diagEtfNote').style.display`));
  console.log('  console 错误数:', errs.length);
  errs.slice(0, 5).forEach(e => console.log('    ❌', e));
  await sleep(12000);
  console.log('Enter 后 15s:');
  console.log('  diagEtfNote display:', await evalJS(`document.getElementById('diagEtfNote').style.display`));
  console.log('  diagStats:', (await evalJS(`document.getElementById('diagStats').innerHTML`)).slice(0, 120));
  console.log('  diagZone len:', (await evalJS(`(document.getElementById('diagZone')||{}).innerHTML||''`)).length);
  console.log('  console 错误数:', errs.length);
  errs.slice(0, 8).forEach(e => console.log('    ❌', e));
  server.close(); chrome.kill();
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e); server.close(); process.exit(2); });
