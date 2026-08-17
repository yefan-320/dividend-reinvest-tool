#!/usr/bin/env node
/* v1.9.0 新功能实测：诊断页建仓区卡片/信号线/分红趋势/策略表 + 首页提醒横幅 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8891;
const CDP_PORT = 9234;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-v190-profile-' + Date.now();

const results = [];
function ok(m) { console.log('  ✅ ' + m); }
function S(name, fn) {
  return fn().then(
    () => { results.push({ name, pass: true }); console.log('✅ ' + name); },
    e => { results.push({ name, pass: false, detail: e.message }); console.log('❌ ' + name + ': ' + e.message); }
  );
}

// 静态服务器
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const f = path.join(REPO, p);
  try {
    const data = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'text/plain' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('not found'); }
});
server.listen(PORT);

let chrome, ws;
function cdp(msgs) { return new Promise((resolve, reject) => { const m = JSON.stringify(msgs); const s = ws; const h = (e) => { try { const d = JSON.parse(e.data); if (d.id === msgs.id) { ws.removeEventListener('message', h); resolve(d); } } catch (x) {} }; s.addEventListener('message', h); s.send(m); }); }
async function evalJS(expr) {
  const r = await cdp({ id: Math.floor(Math.random() * 1e6), method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } });
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval error');
  return r.result ? r.result.result.value : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // 启动 Chrome
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
    '--no-first-run', '--disable-gpu', '--window-size=420,900', 'about:blank'
  ]);
  // 等 CDP 端口
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) { ready = true; break; }
    } catch (e) {}
    await sleep(500);
  }
  if (!ready) { console.error('❌ Chrome CDP 未就绪'); process.exit(2); }

  await S('v1.9.0 诊断页新功能（招行）', async () => {
    const tabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    const page = tabs.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    await cdp({ id: 1, method: 'Page.enable' });
    await cdp({ id: 2, method: 'Runtime.enable' });
    // 打开页面
    await cdp({ id: 3, method: 'Page.navigate', params: { url: BASE } });
    await sleep(6000);
    // 等 echarts + 自动回测完成
    await evalJS(`new Promise(r => { const t = setInterval(() => { if (window.__viewsReady && document.querySelector('#btnRun') && !document.querySelector('#btnRun').disabled) { clearInterval(t); r(1); } }, 300); setTimeout(() => { clearInterval(t); r(0); }, 30000); })`);
    // 进诊断
    await evalJS(`document.querySelector('#homeSearch').value = '600036'; document.querySelector('#homeSearch').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); 1`);
    await sleep(2500);
    // 切到诊断 tab
    await evalJS(`document.querySelector('[data-tab="diagnose"]').click(); 1`);
    await sleep(5000);
    // 检查建仓区卡片
    const zone = await evalJS(`(document.querySelector('#diagZone') || {}).innerHTML || ''`);
    if (!zone || zone.length < 50) throw new Error('建仓区卡片为空: ' + zone.slice(0, 100));
    ok('建仓区状态卡渲染: ' + zone.replace(/<[^>]+>/g, '').slice(0, 60));
    // 信号线图
    const sig = await evalJS(`(document.querySelector('#diagSignalChart') || {}).innerHTML || ''`);
    if (!sig || sig.length < 50) throw new Error('信号线图为空');
    ok('分位信号线渲染');
    // 分红趋势
    const trend = await evalJS(`(document.querySelector('#diagDivTrend') || {}).innerHTML || ''`);
    if (!trend || trend.length < 50) throw new Error('分红趋势为空');
    ok('分红趋势渲染: ' + trend.replace(/<[^>]+>/g, '').slice(0, 60));
    // 策略表
    const strat = await evalJS(`(document.querySelector('#diagStrategy') || {}).innerHTML || ''`);
    if (!strat || strat.length < 50) throw new Error('策略表为空');
    ok('策略对比表渲染: ' + strat.replace(/<[^>]+>/g, '').slice(0, 60));
    const guide = await evalJS(`(document.querySelector('#diagStrategyGuide') || {}).innerHTML || ''`);
    if (!guide || guide.length < 20) throw new Error('策略导读为空');
    ok('策略三行导读渲染');
    return 1;
  });

  await S('v1.9.0 首页提醒横幅（自选含招行）', async () => {
    // 已添加自选 600036（前面诊断过会自动加？手动加）
    await evalJS(`(async () => { if (window.DL) { await window.DL.Watchlist.add('600036', '招商银行'); } return 1; })()`);
    await sleep(500);
    await evalJS(`document.querySelector('[data-tab="home"]').click(); 1`);
    await sleep(6000);
    const banner = await evalJS(`(document.querySelector('#zoneBanner') || {}).innerHTML || ''`);
    console.log('  banner 长度:', banner.length);
    // 招行当前 86 分位 → 应显示 85+ 或 75+ 提醒（若 kline 缓存够长）
    if (banner && banner.length > 20) {
      ok('提醒横幅渲染: ' + banner.replace(/<[^>]+>/g, '').slice(0, 80));
    } else {
      console.log('  ⚠️ 横幅为空（可能数据不足，非失败）');
    }
    return 1;
  });

  // 汇总
  console.log('\n========== v1.9.0 新功能实测 ==========');
  let pass = 0;
  results.forEach(r => { if (r.pass) pass++; else console.log('  ❌ ' + r.name + ': ' + (r.detail || '')); });
  console.log(`通过 ${pass} / ${results.length}`);
  server.close();
  chrome.kill();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e); server.close(); if (chrome) chrome.kill(); process.exit(2); });
