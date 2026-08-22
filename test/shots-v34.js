#!/usr/bin/env node
/* v3.4 AC-17：三档截图验收（390/768/1280 同组合同参数） */
const http = require('http');
const WS = require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws');
const fs = require('fs');
const PORT = 8899;
const shots = [390, 768, 1280];
(async () => {
  for (const w of shots) {
    const CDP_PORT = 9250 + Math.round((w % 1000) / 100);
    try { require('child_process').execSync('lsof -tiTCP:' + CDP_PORT + ' -sTCP:LISTEN | xargs kill -9 2>/dev/null; sleep 1', { timeout: 8000, stdio: 'ignore' }); } catch (e) {}
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const cp = require('child_process').spawn(chrome, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, `--window-size=${w},2400`, '--hide-scrollbars', '--user-data-dir=/tmp/dvt-shot-' + w + '-' + Date.now(), 'http://localhost:' + PORT + '/index.html'], { detached: true, stdio: 'ignore' });
    cp.unref();
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        http.get('http://127.0.0.1:' + CDP_PORT + '/json', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try { if (JSON.parse(d).some(p=>p.url.includes('localhost:'+PORT))) resolve(); else setTimeout(poll,300); } catch(e){ setTimeout(poll,300); } }); }).on('error', () => { if (Date.now()-t0>25000) reject(new Error('超时')); else setTimeout(poll,300); });
      })();
    });
    const page = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:' + CDP_PORT + '/json', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ const p = JSON.parse(d).find(t=>t.type==='page' && t.url.includes('localhost:'+PORT)); resolve(p); }); }).on('error', reject);
    });
    const ws = new WS(page.webSocketDebuggerUrl);
    let id=0; const pend=new Map();
    ws.onmessage = ev => { const m=JSON.parse(ev.data); if (m.id&&pend.has(m.id)){ pend.get(m.id)(m); pend.delete(m.id); } };
    await new Promise(res => ws.onopen = res);
    const cdp={ send:(method,params={})=>new Promise(res=>{ const mid=++id; pend.set(mid,res); ws.send(JSON.stringify({id:mid,method,params})); }) };
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 2400, deviceScaleFactor: 2, mobile: w < 768 })]);

    /* 等就绪 + 建组合 + 跑体检 */
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await cdp.send('Runtime.evaluate', { expression: 'typeof DL !== "undefined" && window.__viewsReady === true', returnByValue: true });
      if (r.result && r.result.result && r.result.result.value) { ready = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) { console.log('!! ' + w + 'px 页面未就绪'); continue; }
    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('[data-tab="pfbt"]').click()` });
    await new Promise(r => setTimeout(r, 500));
    const hasDemo = await cdp.send('Runtime.evaluate', { expression: `!!document.getElementById('pfbtDemo')`, returnByValue: true });
    if (hasDemo.result && hasDemo.result.result && hasDemo.result.result.value) {
      await cdp.send('Runtime.evaluate', { expression: `document.getElementById('pfbtDemo').click()` });
    } else {
      await cdp.send('Runtime.evaluate', { expression: `(() => { const c = DL.loadCombos(); c.combos.push({ id:'cshot', name:'截图组合', items:[{ code:'600036', name:'招商银行', amount:500000, monthly:3000 },{ code:'601398', name:'工商银行', amount:300000, monthly:2000 },{ code:'600900', name:'长江电力', amount:200000, monthly:1000 }], savedAt:Date.now() }); c.activeId='cshot'; DL.saveCombos(c); const sel=document.getElementById('pfbtComboSel'); if(sel){ sel.innerHTML=''; c.combos.forEach(cm=>{ const o=document.createElement('option'); o.value=cm.id; o.textContent=cm.name; sel.appendChild(o); }); sel.value='cshot'; } })()` });
    }
    await new Promise(r => setTimeout(r, 300));
    await cdp.send('Runtime.evaluate', { expression: `document.getElementById('pfbtRun').click()` });
    let done = false;
    for (let i = 0; i < 80; i++) {
      const st = await cdp.send('Runtime.evaluate', { expression: `(document.getElementById('cockpitMain') && document.getElementById('cockpitMain').children.length ? 'ok' : 'wait')`, returnByValue: true });
      if (st.result && st.result.result && st.result.result.value === 'ok') { done = true; break; }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (!done) { console.log('!! ' + w + 'px 体检未完成'); continue; }
    await new Promise(r => setTimeout(r, 2500)); /* 等动画+基准异步完成 */

    /* 全页截图 */
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const out = 'deliverables/红利工具优化/ui-shots/v34-' + w + 'px.png';
    fs.mkdirSync('deliverables/红利工具优化/ui-shots', { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('✅ ' + w + 'px → ' + out + ' (' + Math.round(shot.result.data.length / 1024) + 'KB)');
    try { require('child_process').execSync('lsof -tiTCP:' + CDP_PORT + ' -sTCP:LISTEN | xargs kill -9 2>/dev/null', { timeout: 5000, stdio: 'ignore' }); } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('== 截图完成 ==');
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
