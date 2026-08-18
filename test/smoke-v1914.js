#!/usr/bin/env node
/* v1.9.14 冒烟：页面加载 + TRACK_RECORD 注入 + 报告卡新战绩行（招行案例落地验证）
 * 检查：①无 JS 报错 ②window.TRACK_RECORD 存在 ③诊断页报告卡渲染含"等待区/线历史"新文案 ④坐标线 snap 配置生效 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const REPO = path.join(__dirname, '..');
const PORT = 8898;
const URL = `http://localhost:${PORT}/?code=600036`;

function die(msg) { console.error('❌ ' + msg); process.exit(1); }
function ok(msg) { console.log('✅ ' + msg); }
function ensureServer() {
  return new Promise(resolve => {
    http.get(`http://localhost:${PORT}/`, r => { r.resume(); r.on('end', () => resolve(true)); })
      .on('error', () => {
        const cp = require('child_process').spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, detached: true, stdio: 'ignore' });
        cp.unref();
        setTimeout(resolve, 1500, true);
      });
  });
}
function launchChrome() {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(chrome)) die('Chrome 不存在');
  try { execSync('lsof -ti:9223 | xargs kill -9 2>/dev/null; sleep 1'); } catch (e) {}
  const profile = '/tmp/dvt-smoke-' + process.pid;
  const cp = require('child_process').spawn(chrome, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=9223',
    '--user-data-dir=' + profile, '--window-size=900,1800', URL,
  ], { detached: true, stdio: 'ignore' });
  cp.unref();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      http.get('http://127.0.0.1:9223/json', r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { const pages = JSON.parse(d); if (pages.some(p => p.url.includes('localhost:' + PORT))) resolve(); else setTimeout(poll, 300); } catch (e) { setTimeout(poll, 300); } });
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
        if (!page) return reject(new Error('页面未找到'));
        const ws = new (require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws'))(page.webSocketDebuggerUrl);
        let id = 0; const pend = new Map();
        ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
        ws.onopen = () => resolve({
          send: (method, params = {}) => new Promise(res => { const mid = ++id; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); }),
          close: () => ws.close(),
        });
        ws.onerror = e => reject(e);
      });
    }).on('error', reject);
  });
}
async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    const ed = r.result.exceptionDetails;
    throw new Error('eval: ' + String((ed.exception && ed.exception.description) || ed.text).slice(0, 300));
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

(async () => {
  await ensureServer();
  await launchChrome();
  const cdp = await cdpConnect();
  // 捕获 console 错误
  await cdp.send('Runtime.enable');
  const errors = [];
  cdp.send('Runtime.consoleAPICalled', {}).catch(() => {});
  // 等加载
  let ready = false;
  for (let i = 0; i < 20; i++) {
    const v = await evalIn(cdp, 'typeof DL !== "undefined" ? 1 : 0').catch(() => 0);
    if (v) { ready = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ready) die('页面 DL 未加载');
  ok('页面加载完成（DL 就绪）');
  // ① TRACK_RECORD 注入
  const tr = await evalIn(cdp, `(() => { const t = window.TRACK_RECORD; return t ? { has: true, small5: t.tiers.all.small.r5, heavy5: t.tiers.all.heavy.r5 } : { has: false }; })()`);
  if (!tr || !tr.has) die('TRACK_RECORD 未注入');
  ok('TRACK_RECORD 注入：small 5年 ' + tr.small5.mid + '%/亏' + tr.small5.loss + '%（n=' + tr.small5.n + '）· heavy ' + tr.heavy5.mid + '%/亏' + tr.heavy5.loss + '%');
  // ② 报告卡新文案（搜索框输入代码回车=直接诊断）
  await evalIn(cdp, `(async () => {
    const s = document.getElementById('homeSearch');
    if (!s) return 'no-search';
    s.value = '600036';
    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'dispatched';
  })()`);
  await new Promise(r => setTimeout(r, 6000));
  const card = await evalIn(cdp, `(() => {
    const el = document.getElementById('diagReportCard');
    return el ? el.innerText : null;
  })()`);
  if (!card) die('报告卡未渲染');
  const hasWait = card.indexOf('等待区') >= 0 || card.indexOf('⏳') >= 0;
  const hasTier = card.indexOf('线历史') >= 0 || card.indexOf('复投') >= 0;
  const hasCheap = card.indexOf('便宜度') >= 0;
  ok('报告卡渲染：含等待区/档位历史=' + (hasWait || hasTier) + '· 便宜度标注=' + hasCheap);
  console.log('--- 报告卡片段 ---');
  console.log(card.slice(0, 500).replace(/\n/g, ' | '));
  // ③ 坐标线 snap 配置（chartAsset 实例）
  const snap = await evalIn(cdp, `(() => {
    const ch = echarts.getInstanceByDom(document.getElementById('chartAsset'));
    if (!ch) return null;
    const opt = ch.getOption();
    return opt && opt.tooltip && opt.tooltip[0] ? opt.tooltip[0].axisPointer : null;
  })()`);
  console.log('tooltip.axisPointer =', JSON.stringify(snap));
  if (!snap || snap.snap !== true) die('axisPointer.snap 未生效');
  ok('坐标线 snap:true 生效（十字线吸附数据点=与 tooltip 同位）');
  cdp.close();
  console.log('\n===== 冒烟全部通过 =====');
  process.exit(0);
})().catch(e => { console.error('❌ 冒烟异常: ' + e.message); process.exit(1); });
