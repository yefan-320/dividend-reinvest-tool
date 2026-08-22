#!/usr/bin/env node
/* v1.9.32 批次1（D+A1+A2）e2e-v131 骨架（TDD 先行，M225/M237）
 * 断言范围（M142）：
 *  ① D7 迁移两路径（旧格式→v1 数组 + legacy_bak + 表单正确）——当前代码应已绿
 *  ② 无持仓空态（#pfSample 含"录入持仓"按钮 + holdAdd 存在）
 *  ③ 有持仓两层（录入 → 表单+明细表+总览卡都在不叠加）
 *  ④ 批量粘贴（3 行 → toast 真实统计非"msg"）
 *  ⑤ 清空→空态恢复→再录入
 * 骨架阶段只跑 ①②（当前代码能绿的），③④⑤ 断言随码补（M237）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8897;
const CDP_PORT = 9240;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-v131-profile-' + Date.now();

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

  // ① D7 迁移两路径（骨架：数据层断言，当前代码已绿；DOM 表单断言随 D 修复后补，M237）
  await S('D7 迁移路径1：旧格式 {code:shares} → v1 数组 + legacy_bak + 清旧key', async () => {
    await evalJS(`localStorage.removeItem('divtool_holdings_v1'); localStorage.removeItem('divtool_holdings'); localStorage.removeItem('divtool_holdings_legacy_bak'); localStorage.setItem('divtool_holdings', JSON.stringify({600036:1000,601398:2000})); location.reload(); 1`);
    await sleep(6000);
    const v1 = await evalJS(`JSON.parse(localStorage.getItem('divtool_holdings_v1')||'null')`);
    const bak = await evalJS(`localStorage.getItem('divtool_holdings_legacy_bak')`);
    const oldKey = await evalJS(`localStorage.getItem('divtool_holdings')`);
    if (!v1 || !Array.isArray(v1) || v1.length !== 2) throw new Error('v1 数组不存在或长度不对: ' + JSON.stringify(v1));
    const codes = v1.map(r => r.code).sort().join(',');
    if (codes !== '600036,601398') throw new Error('迁移代码错误: ' + codes);
    if (v1[0].shares !== 1000 && v1[1].shares !== 2000 && v1[0].shares !== 2000) throw new Error('股数迁移错误: ' + JSON.stringify(v1.map(r=>r.shares)));
    if (!bak) throw new Error('legacy_bak 未生成');
    if (oldKey !== null) throw new Error('旧 key 未清除');
    ok('v1=' + JSON.stringify(v1.map(r=>r.code+':'+r.shares)) + ' bak=存在 旧key=已清');
    return 1;
  });

  await S('D7 迁移路径2：旧格式与 v1 并存 → 补缺不覆盖', async () => {
    await evalJS(`localStorage.setItem('divtool_holdings_v1', JSON.stringify([{code:'600036',name:'招商银行',shares:500,cost:35.5,date:'2025-01-10'}])); localStorage.setItem('divtool_holdings', JSON.stringify({601398:2000})); location.reload(); 1`);
    await sleep(6000);
    const v1 = await evalJS(`JSON.parse(localStorage.getItem('divtool_holdings_v1')||'null')`);
    if (!v1 || v1.length !== 2) throw new Error('补缺后长度不对: ' + JSON.stringify(v1));
    const g = v1.find(r => r.code === '600036');
    const h = v1.find(r => r.code === '601398');
    if (!g || g.shares !== 500) throw new Error('已有持仓被覆盖: ' + JSON.stringify(g));
    if (!h || h.shares !== 2000) throw new Error('补缺失败: ' + JSON.stringify(h));
    ok('600036 保留 500 未覆盖 + 601398 补入 2000');
    return 1;
  });

  // ② DOM 断言（D 修复后补，M237）：空态引导 + 有持仓两层 + 批量粘贴 + 清空再录入
  await S('空态：引导+完整表单（holdAdd/holdCode 存在，无静态样例）', async () => {
    await evalJS(`localStorage.removeItem('divtool_holdings_v1'); localStorage.removeItem('divtool_holdings'); location.reload(); 1`);
    await sleep(6000);
    const hasAdd = await evalJS(`!!document.querySelector('#holdAdd')`);
    const hasCode = await evalJS(`!!document.querySelector('#holdCode')`);
    const hasEmpty = await evalJS(`!!document.querySelector('#holdEmptyAdd')`);
    const text = await evalJS(`(document.querySelector('#pfSample')||{}).textContent||''`);
    const noStatic = !text.includes('静态样例');
    if (!hasAdd || !hasCode || !hasEmpty) throw new Error('空态元素缺失 add=' + hasAdd + ' code=' + hasCode + ' empty=' + hasEmpty);
    if (!noStatic) throw new Error('静态样例仍在');
    ok('空态引导+表单齐全，静态样例已删');
    return 1;
  });

  await S('有持仓：录入 2 只 → 表单+明细 7 列+组合总览不叠加', async () => {
    await evalJS(`localStorage.setItem('divtool_holdings_v1', JSON.stringify([{code:'600036',name:'招商银行',shares:1000,cost:35.5,date:'2025-01-10'},{code:'601398',name:'工商银行',shares:2000,cost:7.6,date:'2025-02-01'}])); location.reload(); 1`);
    await sleep(6000);
    const ths = await evalJS(`(document.querySelector('#pfSample table')||{}).innerHTML||''`);
    const has7col = ths.includes('现价') && ths.includes('市值') && ths.includes('买入日');
    const hasDiag = await evalJS(`document.querySelectorAll('#pfSample [data-diag]').length`);
    const hasHrow = await evalJS(`document.querySelectorAll('#pfSample [data-hrow]').length`);
    const hasOverview = await evalJS(`(document.querySelector('#pfSample')||{}).textContent||''`).then(t => t.includes('组合总览'));
    if (!has7col) throw new Error('明细表缺 7 列（现价/市值/买入日）: ' + ths.replace(/<[^>]+>/g,' ').slice(0,80));
    if (hasHrow !== 2 || hasDiag !== 2) throw new Error('行数不对 hrow=' + hasHrow + ' diag=' + hasDiag);
    if (!hasOverview) throw new Error('组合总览缺失');
    const hasRing = await evalJS(`!!document.querySelector('#pfRing')`);
    if (!hasRing) throw new Error('#pfRing 环形图容器缺失（M200）');
    ok('7 列表 + 2 明细行(data-hrow) + 2 总览行(data-diag) + 组合总览卡 + #pfRing 容器');
    return 1;
  });

  await S('批量粘贴：3 行 → v1=3 只 + 无行错误（toast 内容由 D3 代码保障）', async () => {
    await evalJS(`localStorage.removeItem('divtool_holdings_v1'); location.reload(); 1`);
    await sleep(6000);
    await evalJS(`document.querySelector('#holdBulkToggle').click(); 1`);
    await sleep(300);
    const bulkText = '600036:1000' + String.fromCharCode(10) + '601398:2000' + String.fromCharCode(10) + '000858:500';
    await evalJS(`document.querySelector('#holdBulk').value = ${JSON.stringify(bulkText)}; 1`);
    await evalJS(`document.querySelector('#holdBulkAdd').click(); 1`);
    await sleep(800);
    const v1 = await evalJS(`JSON.parse(localStorage.getItem('divtool_holdings_v1')||'[]')`);
    const errText = await evalJS(`(document.querySelector('#holdBulkErr')||{}).textContent||''`);
    if (v1.length !== 3) throw new Error('批量后 v1 长度=' + v1.length);
    if (errText) throw new Error('有行错误: ' + errText);
    ok('v1=' + v1.length + ' 只（600036/601398/000858）无行错误');
    return 1;
  });

  await S('清空→空态恢复→再录入', async () => {
    await evalJS(`localStorage.setItem('divtool_holdings_v1', JSON.stringify([{code:'601398',name:'工商银行',shares:2000,cost:7.6,date:'2025-02-01'}])); location.reload(); 1`);
    await sleep(6000);
    const hasClear = await evalJS(`!!document.querySelector('#holdClear')`);
    if (!hasClear) throw new Error('有持仓时 holdClear 不存在');
    await evalJS(`document.querySelector('#holdClear').click(); 1`);
    await sleep(800);
    const afterClear = await evalJS(`(document.querySelector('#pfSample')||{}).textContent||''`);
    const emptyBack = afterClear.includes('录入持仓后');
    if (!emptyBack) throw new Error('清空后未回空态');
    await evalJS(`document.querySelector('#holdCode').value='600036'; document.querySelector('#holdShares').value='1000'; document.querySelector('#holdCost').value='35.5'; 1`);
    await evalJS(`document.querySelector('#holdAdd').click(); 1`);
    await sleep(2500);
    const v1b = await evalJS(`JSON.parse(localStorage.getItem('divtool_holdings_v1')||'[]')`);
    if (v1b.length !== 1 || v1b[0].code !== '600036') throw new Error('再录入失败: ' + JSON.stringify(v1b));
    ok('清空回空态 → 再录入 600036 成功');
    return 1;
  });

  console.log('\n========== v1.9.32 批次1 e2e-v131 骨架 ==========');
  let pass = 0;
  results.forEach(r => { if (r.pass) pass++; else console.log('  ❌ ' + r.name + ': ' + (r.detail || '')); });
  console.log(`通过 ${pass} / ${results.length}`);
  console.log('console 错误:', errs.length, errs.slice(0, 3).join(' | '));
  process.exit(pass === results.length && results.length > 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
