#!/usr/bin/env node
/* UI 买卖指令条验证（2026-08-20 v9.2）：报告卡渲染"自动层/事件层徽章+买卖指令" */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const REPO = __dirname.replace(/\/test$/, '');
const PORT = 9388, CDP_PORT = 9254;
const PROFILE = '/tmp/chrome-ui-check-' + Date.now();
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function launchChrome() {
  return spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1000,1800', `--user-data-dir=${PROFILE}`, '--no-sandbox', '--remote-allow-origins=*', 'about:blank'], { detached: true, stdio: 'ignore' });
}
async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const d = await new Promise((res, rej) => http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => { let s = ''; r.on('data', c => s += c); r.on('end', () => res(JSON.parse(s))); }).on('error', rej));
      const page = d.find(x => x.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('CDP 启动失败');
}
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = {}; }
  async connect() {
    const WebSocket = require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws');
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    this.ws.on('message', d => { const m = JSON.parse(d); if (m.id && this.pending[m.id]) { this.pending[m.id](m); delete this.pending[m.id]; } });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise(res => this.pending[id] = res); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; }
}
(async () => {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, detached: true, stdio: 'ignore' });
  const chrome = launchChrome();
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => { console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`); ok ? pass++ : fail++; };
  try {
    const wsUrl = await getWs();
    const cdp = new CDP(wsUrl); await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await new Promise(r => setTimeout(r, 3000));
    // 搜索招行打开报告卡
    await cdp.eval(`(() => { const inp = document.querySelector('#homeSearch'); if (inp) { inp.value = '600036'; inp.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); } })()`);
    await new Promise(r => setTimeout(r, 6000));
    const body = await cdp.eval(`document.body.innerText.slice(0, 6000)`);
    // 检查关键元素
    check('报告卡区域存在', body.includes('报告卡'), '');
    check('自动层徽章存在（招行）', body.includes('自动层'), '');
    check('买卖指令文本存在', /持有|买入|卖出|减半/.test(body), body.match(/买入（[^）]*）|⚪ 持有|🔴 卖出|🟠 卖出|🟢 买入/)?.[0] || '');
    // 检查指令条颜色容器
    const instr = await cdp.eval(`(() => { const els = [...document.querySelectorAll('div')].filter(x => x.textContent && x.textContent.includes('自动层') && x.style && x.style.fontWeight === '700'); return els.length ? els[0].textContent.slice(0, 80) : null; })()`);
    check('指令条渲染（自动层+动作）', instr != null, instr || '');
  } catch (e) {
    console.log('❌ 异常:', e.message);
    fail++;
  } finally {
    try { chrome.kill(); } catch (e) { }
    try { server.kill(); } catch (e) { }
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }
  }
  console.log(`\n结果: ${pass} / ${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})();
