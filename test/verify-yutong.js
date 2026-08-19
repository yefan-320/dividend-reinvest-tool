#!/usr/bin/env node
/* 验证：宇通客车 600066 诊断页——建仓区状态卡 + 图2 note 实际渲染（v1.9.16） */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8899;
const URL = `http://localhost:${PORT}/`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function ensureServer() {
  return new Promise(resolve => {
    http.get(`http://localhost:${PORT}/`, r => { r.resume(); r.on('end', () => resolve()); })
      .on('error', () => {
        const cp = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, detached: true, stdio: 'ignore' });
        cp.unref();
        setTimeout(resolve, 1500);
      });
  });
}
function launchChrome() {
  try { execSync('lsof -ti:9223 | xargs kill -9 2>/dev/null; sleep 1'); } catch (e) {}
  const profile = '/tmp/dvt-verify-profile-' + process.pid;
  const cp = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9223', '--user-data-dir=' + profile, '--window-size=900,1800', URL], { detached: true, stdio: 'ignore' });
  cp.unref();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      http.get('http://127.0.0.1:9223/json', r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { if (JSON.parse(d).some(p => p.url.includes('localhost:' + PORT))) resolve(); else setTimeout(poll, 300); } catch (e) { setTimeout(poll, 300); } });
      }).on('error', () => { if (Date.now() - t0 > 20000) reject(new Error('Chrome 启动超时')); else setTimeout(poll, 300); });
    })();
  });
}
function cdpConnect() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9223/json', r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        const page = JSON.parse(d).find(t => t.url.includes('localhost:' + PORT));
        const ws = new (require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws'))(page.webSocketDebuggerUrl);
        let id = 0; const pend = new Map();
        ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
        ws.onopen = () => resolve({ send: (method, params = {}) => new Promise(res => { const mid = ++id; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); }), close: () => ws.close() });
        ws.onerror = reject;
      });
    }).on('error', reject);
  });
}
async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('eval: ' + String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 300));
  return r.result?.result?.value;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await ensureServer();
  await launchChrome();
  const cdp = await cdpConnect();
  for (let i = 0; i < 15; i++) { if (await evalIn(cdp, 'typeof APP_VERSION !== "undefined"')) break; await sleep(2000); }
  console.log('APP_VERSION =', await evalIn(cdp, 'APP_VERSION'));

  console.log('\n== 搜索进诊断宇通 ==');
  await evalIn(cdp, `(() => { const s=document.getElementById('homeSearch'); s.value='600066'; s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'})); return 1; })()`);
  await sleep(15000);
  const zoneHtml = await evalIn(cdp, `(document.querySelector('.zone-row')||{}).innerHTML || '(无 zone-row)'`);
  console.log('--- 建仓区状态卡（前 2500 字）---');
  console.log(zoneHtml.slice(0, 2500));
  console.log('');
  const note = await evalIn(cdp, `(document.getElementById('diagYieldNote')||{}).textContent || '(无 note)'`);
  console.log('--- 图2 note ---');
  console.log(note);
  const stats = await evalIn(cdp, `(document.getElementById('diagStats')||{}).textContent || '(无)'`);
  console.log('--- diagStats ---');
  console.log(stats.slice(0, 400));

  console.log('\n== 点 10 年 chips ==');
  await evalIn(cdp, `(() => { const q=document.querySelectorAll('#diagYieldQuick button'); for (const b of q) { if (b.dataset.y === '10') b.click(); } return 1; })()`);
  await sleep(15000);
  const note10 = await evalIn(cdp, `(document.getElementById('diagYieldNote')||{}).textContent || '(无 note)'`);
  console.log('--- 10年 note ---');
  console.log(note10);
  const zoneHtml10 = await evalIn(cdp, `(document.querySelector('.zone-row')||{}).innerHTML || '(无)'`);
  console.log('--- 10年 建仓区卡（含长期视角行?）---');
  console.log(zoneHtml10.includes('长期复投视角') ? '✅ 有长期复投视角行' : '❌ 无长期复投视角行');
  const ltMatch = zoneHtml10.match(/长期复投视角[^<]*/);
  console.log('  行内容:', ltMatch ? ltMatch[0].slice(0, 200) : '(整行HTML前300字) ' + zoneHtml10.slice(0, 300));
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
