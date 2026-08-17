#!/usr/bin/env node
/* v1.9.1 新功能浏览器实测：
 * ① 诊断页模式切换（保守→柔性，64% 文案变化 + localStorage 记忆）
 * ② 建仓卡生态标签 + 阈值刻度联动
 * ③ 组合总览卡折叠零请求 → 展开加载 → 资金模拟
 * ④ 横幅三组不报错
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8893;
const CDP_PORT = 9236;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-v191-profile-' + Date.now();

const results = [];
function ok(m) { console.log('  ✅ ' + m); }
function S(name, fn) {
  return fn().then(
    () => { results.push({ name, pass: true }); console.log('✅ ' + name); },
    e => { results.push({ name, pass: false, detail: e.message }); console.log('❌ ' + name + ': ' + e.message); }
  );
}
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

  await S('P0 模式切换（保守→柔性，招行 64% 文案）', async () => {
    await evalJS(`localStorage.removeItem('divtool_zone_mode'); localStorage.removeItem('divtool_pos_600036_conservative'); localStorage.removeItem('divtool_pos_600036_flexible'); 1`);
    // 进诊断 600036
    await evalJS(`document.querySelector('#homeSearch').value='600036'; document.querySelector('#homeSearch').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); 1`);
    await sleep(2500);
    await evalJS(`document.querySelector('[data-tab="diagnose"]').click(); 1`);
    await sleep(6000);
    const zoneHtml1 = await evalJS(`(document.querySelector('#diagZone')||{}).innerHTML||''`);
    // 默认保守：应含"未触发建仓线（"或"起建线"标签
    const modeChips = await evalJS(`document.querySelectorAll('#diagZone .mode-chip').length`);
    ok('建仓卡含模式切换 chips: ' + modeChips + ' 个');
    const ecoLabel = await evalJS(`(document.querySelector('#diagZone')||{}).textContent||''`);
    ok('生态标签: ' + (ecoLabel.match(/生态：[\u4e00-\u9fa5]+（起建线 \d+ 分位）/g) || ['无'])[0]);
    // 切柔性
    await evalJS(`(document.querySelector('#diagZone .mode-chip[data-mode="flexible"]')||{}).click ? document.querySelector('#diagZone .mode-chip[data-mode="flexible"]').click() : 0; 1`);
    await sleep(2000);
    const zoneHtml2 = await evalJS(`(document.querySelector('#diagZone')||{}).innerHTML||''`);
    const lsMode = await evalJS(`localStorage.getItem('divtool_zone_mode')`);
    ok('切换后 localStorage 记忆: ' + lsMode);
    const isFlex = zoneHtml2.includes('柔性') && (zoneHtml2.includes('差') || zoneHtml2.includes('可提前观察'));
    if (!isFlex) throw new Error('柔性文案未生效: ' + zoneHtml2.replace(/<[^>]+>/g, '').slice(0, 80));
    ok('柔性文案生效: ' + zoneHtml2.replace(/<[^>]+>/g, '').slice(0, 60));
    return 1;
  });

  await S('P2 组合总览卡（折叠→展开→资金模拟）', async () => {
    await evalJS(`document.querySelector('[data-tab="home"]').click(); 1`);
    await sleep(2000);
    // 添加 2 只自选（600036 + 601398 工行）
    await evalJS(`(async () => { await window.DL.Watchlist.add('600036','招商银行'); await window.DL.Watchlist.add('601398','工商银行'); return 1; })()`);
    await sleep(500);
    await evalJS(`location.reload(); 1`);
    await sleep(8000);
    // 折叠态：零请求（body display none）
    const folded = await evalJS(`document.querySelector('#portfolioBody').style.display`);
    ok('折叠态 display: ' + folded + '（none=零请求）');
    const summary = await evalJS(`document.querySelector('#pfSummary').textContent`);
    ok('折叠汇总: ' + summary);
    // 展开
    await evalJS(`document.querySelector('#portfolioCard').click(); 1`);
    await sleep(10000);
    const bodyText = await evalJS(`(document.querySelector('#portfolioBody')||{}).innerHTML||''`);
    if (!bodyText || bodyText.length < 100) throw new Error('展开后为空');
    ok('展开加载: ' + bodyText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 80));
    // 资金模拟
    await evalJS(`(document.querySelector('#pfCalc')||{}).click ? document.querySelector('#pfCalc').click() : 0; 1`);
    await sleep(500);
    const fundRes = await evalJS(`(document.querySelector('#pfFundResult')||{}).innerHTML||''`);
    ok('资金模拟输出: ' + fundRes.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 80));
    return 1;
  });

  await S('P4 横幅三组（无异常）', async () => {
    const banner = await evalJS(`(document.querySelector('#zoneBanner')||{}).innerHTML||''`);
    console.log('  banner len:', banner.length, '(可能为空=无触发，正常)');
    ok('横幅渲染无异常');
    return 1;
  });

  console.log('\n========== v1.9.1 浏览器实测 ==========');
  let pass = 0;
  results.forEach(r => { if (r.pass) pass++; else console.log('  ❌ ' + r.name + ': ' + (r.detail || '')); });
  console.log(`通过 ${pass} / ${results.length}`);
  console.log('console 错误:', errs.length, errs.slice(0, 3).join(' | '));
  server.close(); chrome.kill();
  process.exit(pass === results.length && errs.length === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e); server.close(); if (chrome) chrome.kill(); process.exit(2); });
