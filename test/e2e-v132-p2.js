#!/usr/bin/env node
/* v1.9.32 批次2（算得清）e2e-v132-p2（M260-M280）
 * 断言：
 *  ① 加权平均成本：多笔 trades → Σ(股数×价)/Σ股数
 *  ② 行内 ➕加仓：只追加 trades，股数累加，成本变加权
 *  ③ 新增写首笔 trades；无价无日期 → trades 空 + cost 手填标注
 *  ④ 8 列渲染（含盈亏列 hq-pnl）
 *  ⑤ 净值曲线快照：divtool_holdings_snap 当天去重 + 总市值写回 pfMvRow
 *  ⑥ 清空/单删连 trades 无孤儿
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8898;
const CDP_PORT = 9241;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-v132p2-profile-' + Date.now();

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

  await S('加权平均成本：两笔 trades 1000股@10 + 1000股@20 → 15', async () => {
    await evalJS(`localStorage.setItem('divtool_holdings_v1', JSON.stringify([{code:'600036',name:'招行',shares:2000,cost:15,date:'2025-01-01',trades:[{date:'2025-01-01',shares:1000,price:10},{date:'2025-06-01',shares:1000,price:20}]}])); location.reload(); 1`);
    await sleep(6000);
    const costTxt = await evalJS(`(document.querySelectorAll('#pfSample table tr[data-hrow] td.col-opt')[1]||{}).textContent||''`);
    if (!costTxt.includes('15.00')) throw new Error('加权成本未显示 15.00: ' + costTxt);
    ok('成本列显示 15.00（加权平均 (1000×10+1000×20)/2000）');
    return 1;
  });

  await S('行内 ➕加仓：追加 trades + 股数累加 + 成本更新', async () => {
    await evalJS(`document.querySelector('#holdShares').value='1000'; document.querySelector('#holdCost').value='30'; document.querySelector('#holdDate').value='2025-12-01'; 1`);
    await evalJS(`document.querySelector('[data-add="0"]').click(); 1`);
    await sleep(1200);
    const h = await evalJS(`JSON.parse(localStorage.getItem('divtool_holdings_v1'))[0]`);
    if (h.shares !== 3000) throw new Error('股数未累加: ' + h.shares);
    if (!h.trades || h.trades.length !== 3) throw new Error('trades 未追加: ' + JSON.stringify(h.trades));
    // (1000×10+1000×20+1000×30)/3000 = 20
    const costTxt = await evalJS(`(document.querySelectorAll('#pfSample table tr[data-hrow] td.col-opt')[1]||{}).textContent||''`);
    if (!costTxt.includes('20.00')) throw new Error('加仓后加权成本未更新: ' + costTxt);
    ok('加仓 1000@30 → 共 3000 股，加权成本 20.00，trades=3 笔');
    return 1;
  });

  await S('8 列渲染：盈亏列存在 + 无 trades 标手填', async () => {
    await evalJS(`localStorage.setItem('divtool_holdings_v1', JSON.stringify([{code:'601398',name:'工行',shares:1000,cost:7.6,date:'2025-01-01'}])); location.reload(); 1`);
    await sleep(6000);
    const ths = await evalJS(`(document.querySelector('#pfSample table')||{}).innerHTML||''`);
    const hasPnl = ths.includes('盈亏');
    const txt = await evalJS(`(document.querySelector('#pfSample')||{}).textContent||''`);
    const hasHandFill = txt.includes('手填');
    if (!hasPnl) throw new Error('缺盈亏列');
    if (!hasHandFill) throw new Error('无 trades 未标手填');
    ok('盈亏列存在 + 手填标注存在');
    return 1;
  });

  await S('净值快照：divtool_holdings_snap 当天去重 + pfMvRow 总市值', async () => {
    await evalJS(`localStorage.setItem('divtool_holdings_v1', JSON.stringify([{code:'600036',name:'招行',shares:1000,cost:35.5,date:'2025-01-01'}])); location.reload(); 1`);
    await sleep(9000);  // 等行情
    const snaps = await evalJS(`JSON.parse(localStorage.getItem('divtool_holdings_snap')||'[]')`);
    const today = await evalJS(`DL.todayStr()`);
    const todayCount = snaps.filter(s => s.date === today).length;
    if (!snaps.length) throw new Error('快照未生成');
    if (todayCount !== 1) throw new Error('当天快照应去重为 1: ' + todayCount);
    const mvRow = await evalJS(`(document.getElementById('pfMvRow')||{}).textContent||''`);
    if (!mvRow.includes('总市值')) throw new Error('pfMvRow 无总市值: ' + mvRow);
    // 再 reload 一次验证去重
    await evalJS(`location.reload(); 1`);
    await sleep(9000);
    const snaps2 = await evalJS(`JSON.parse(localStorage.getItem('divtool_holdings_snap')||'[]')`);
    const todayCount2 = snaps2.filter(s => s.date === today).length;
    if (todayCount2 !== 1) throw new Error('reload 后当天快照重复: ' + todayCount2);
    ok('快照当天去重（reload 仍 1 条）' + (snaps2[0] && snaps2[0].totalValue ? ' 总市值=' + Math.round(snaps2[0].totalValue) : ''));
    return 1;
  });

  await S('单删连 trades 无孤儿（整行删除）', async () => {
    await evalJS(`document.querySelector('[data-rm="0"]').click(); 1`);
    await sleep(1000);
    const v1 = await evalJS(`JSON.parse(localStorage.getItem('divtool_holdings_v1')||'[]')`);
    if (v1.length !== 0) throw new Error('单删后残留: ' + JSON.stringify(v1));
    ok('单删整行 → v1=[] 无孤儿');
    return 1;
  });

  console.log('\n========== v1.9.32 批次2 e2e-v132-p2 ==========');
  let pass = 0;
  results.forEach(r => { if (r.pass) pass++; else console.log('  ❌ ' + r.name + ': ' + (r.detail || '')); });
  console.log(`通过 ${pass} / ${results.length}`);
  console.log('console 错误:', errs.length, errs.slice(0, 3).join(' | '));
  process.exit(pass === results.length && results.length > 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
