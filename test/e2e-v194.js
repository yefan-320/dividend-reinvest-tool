#!/usr/bin/env node
/* v1.9.4 自选入口闭环实测：A 决策台➕ / B 诊断页⭐ / C 组合回测空态内联 / 去重
 * 断言 4 条：A 加自选+toast → 去重（重复加只加一次）→ B 已自选检测+取消+再加 → C 空态快捷添加+去决策台按钮 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8896;
const CDP_PORT = 9239;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-v194-profile-' + Date.now();

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  try { const d = fs.readFileSync(path.join(REPO, p)); res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'text/plain' }); res.end(d); }
  catch (e) { res.writeHead(404); res.end('nf'); }
});
server.listen(PORT);

let ws, msgId = 100;
let chrome;
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
async function waitFor(expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evalJS(expr)) return true; } catch (e) { }
    await sleep(300);
  }
  return false;
}

async function main() {
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
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

  // 清空自选 + stub 网络（确定性测试）
  await evalJS(`localStorage.removeItem('divtool_watchlist_v1'); 1`);
  await evalJS(`window.DL.fetchName = async (c) => c==='600036'?'招商银行':c==='601398'?'工商银行':c; 1`);
  await evalJS(`window.DL.getStockQuotes = async (cs) => Object.fromEntries(cs.map(c=>[c,{price:10}])); 1`);
  await evalJS(`window.DL.fetchDividendsOne = async () => []; 1`);
  await evalJS(`window.DL.getKline = async () => []; 1`);
  await evalJS(`window.confirm = () => true; 1`);   // B 路径取消自选 confirm 自动确认
  await sleep(500);

  let pass = 0, fail = 0;
  const check = (name, ok, extra) => { console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra ? ' | ' + extra : '')); ok ? pass++ : fail++; };

  /* ===== A 路径：决策台输入代码 → ➕ 加自选 ===== */
  await evalJS(`document.querySelector('[data-tab="home"]').click(); 1`);
  await sleep(500);
  await evalJS(`(() => { const s=document.getElementById('homeSearch'); s.value='600036'; document.getElementById('homeSearchAdd').click(); return 1; })()`);
  const aCard = await waitFor(`document.querySelectorAll('.wl-card[data-code="600036"]').length === 1`);
  const aToast = await evalJS(`(document.getElementById('toast')||{}).textContent || ''`);
  check('A: ➕ 加自选后自选卡出现 600036', aCard);
  check('A: toast 提示 已加入自选', aToast.includes('已加入自选：600036'), aToast);

  /* ===== 去重：同代码再加一次 ===== */
  await evalJS(`(() => { const s=document.getElementById('homeSearch'); s.value='600036'; document.getElementById('homeSearchAdd').click(); return 1; })()`);
  await sleep(800);
  const dupCount = await evalJS(`JSON.parse(localStorage.getItem('divtool_watchlist_v1')||'[]').length`);
  const dupToast = await evalJS(`(document.getElementById('toast')||{}).textContent || ''`);
  check('D: 重复加只保留 1 条', dupCount === 1, 'len=' + dupCount);
  check('D: 重复加 toast 提示 已在自选中', dupToast.includes('已在自选中'), dupToast);

  /* ===== B 路径：诊断页 ⭐ 加自选 / ✓ 已自选 切换 ===== */
  await evalJS(`document.querySelector('.wl-card[data-code="600036"]').click(); 1`);   // 点自选卡进诊断（闭包 openDiagnose 不经 window）
  const bIn = await waitFor(`document.getElementById('diagWlBtn').textContent === '✓ 已自选'`);
  check('B: 诊断页已自选态 ✓ 已自选', bIn, await evalJS(`document.getElementById('diagWlBtn').textContent`));
  await evalJS(`document.getElementById('diagWlBtn').click(); 1`);   // 取消（confirm 已自动确认）
  const bOff = await waitFor(`document.getElementById('diagWlBtn').textContent === '⭐ 加自选'`);
  const bLen0 = await evalJS(`JSON.parse(localStorage.getItem('divtool_watchlist_v1')||'[]').length`);
  check('B: 点击后切换为 ⭐ 加自选（已取消）', bOff && bLen0 === 0, 'len=' + bLen0);
  await evalJS(`document.getElementById('diagWlBtn').click(); 1`);   // 再加回
  const bBack = await waitFor(`document.getElementById('diagWlBtn').textContent === '✓ 已自选'`);
  const bLen1 = await evalJS(`JSON.parse(localStorage.getItem('divtool_watchlist_v1')||'[]').length`);
  check('B: 再次点击加回 ✓ 已自选', bBack && bLen1 === 1, 'len=' + bLen1);

  /* ===== C 路径：组合回测空态 → 内联快捷添加 + 去决策台按钮 ===== */
  await evalJS(`document.querySelector('.wl-card[data-code="600036"] .wl-del').click(); 1`);   // UI 删除（同步刷新 homeState）
  await sleep(800);
  await evalJS(`document.querySelector('[data-tab="pfbt"]').click(); 1`);
  await sleep(600);
  await evalJS(`document.getElementById('pfbtRun').click(); 1`);
  const cEmpty = await waitFor(`!!document.getElementById('pfbtQuickCode')`);
  const cTxt = await evalJS(`(document.getElementById('pfbtResult')||{}).innerHTML || ''`);
  check('C: 空态文案+内联输入+按钮渲染', cEmpty && cTxt.includes('自选为空：搜索代码'), cTxt.replace(/<[^>]+>/g,' ').slice(0,60));
  await evalJS(`(() => { const i=document.getElementById('pfbtQuickCode'); i.value='601398'; document.getElementById('pfbtQuickAdd').click(); return 1; })()`);
  const cAdded = await waitFor(`(document.getElementById('pfbtResult')||{}).innerHTML.includes('已加入自选：601398')`);
  const cLen = await evalJS(`JSON.parse(localStorage.getItem('divtool_watchlist_v1')||'[]').length`);
  check('C: 内联加自选 601398 成功', cAdded && cLen === 1, 'len=' + cLen);
  await evalJS(`document.getElementById('pfbtGoHome').click(); 1`);
  await sleep(500);
  const cHome = await evalJS(`document.getElementById('tab-home').style.display === 'block'`);
  const cFocus = await evalJS(`document.activeElement && document.activeElement.id === 'homeSearch'`);
  check('C: 去决策台按钮切 tab+聚焦搜索框', cHome && cFocus, 'home=' + cHome + ' focus=' + cFocus);

  console.log('\n结果:', pass + '/' + (pass + fail), '通过');
  console.log('console 错误:', errs.length, errs.slice(0, 3).join(' | '));
  server.close(); chrome.kill();
  process.exit(fail === 0 && errs.length === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e); server.close(); if (chrome) chrome.kill(); process.exit(2); });
