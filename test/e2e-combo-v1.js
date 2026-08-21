#!/usr/bin/env node
/* e2e：组合工作台 v1 全链路（验收 1-23 条关键场景） */
const http = require('http');
const WS = require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws');
const PORT = 8899, CDP_PORT = 9236;
let pass = 0, fail = 0;
function T(name, cond, extra) { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (extra != null ? ' | ' + extra : '')); } }
function launchChrome() {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { require('child_process').execSync('lsof -tiTCP:' + CDP_PORT + ' -sTCP:LISTEN | xargs kill -9 2>/dev/null; sleep 1', { timeout: 8000, stdio: 'ignore' }); } catch (e) {}
  const cp = require('child_process').spawn(chrome, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, '--window-size=1400,2400', '--hide-scrollbars', '--user-data-dir=/tmp/dvt-combo-e2e-' + Date.now(), 'http://localhost:' + PORT + '/index.html'], { detached: true, stdio: 'ignore' });
  cp.unref();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      http.get('http://127.0.0.1:' + CDP_PORT + '/json', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try { if (JSON.parse(d).some(p=>p.url.includes('localhost:'+PORT))) resolve(); else setTimeout(poll,300); } catch(e){ setTimeout(poll,300); } }); }).on('error', () => { if (Date.now()-t0>25000) reject(new Error('超时')); else setTimeout(poll,300); });
    })();
  });
}
function cdpConnect() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + CDP_PORT + '/json', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{
      const page = JSON.parse(d).find(t=>t.type==='page');
      const ws = new WS(page.webSocketDebuggerUrl);
      let id=0; const pend=new Map(); const handlers={};
      ws.onmessage = ev => {
        const m=JSON.parse(ev.data);
        if (m.id&&pend.has(m.id)){ pend.get(m.id)(m); pend.delete(m.id); return; }
        if (m.method && handlers[m.method]) handlers[m.method].forEach(fn => fn(m.params));
      };
      ws.onopen = () => {
        const cdp={
          send:(method,params={})=>new Promise(res=>{ const mid=++id; pend.set(mid,res); ws.send(JSON.stringify({id:mid,method,params})); }),
          on:(method,fn)=>{ if(!handlers[method]) handlers[method]=[]; handlers[method].push(fn); },
        };
        Promise.all([cdp.send('Page.enable'),cdp.send('Runtime.enable')]).then(()=>resolve(cdp));
      };
    }); }).on('error', reject);
  });
}
async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error('eval异常: ' + String((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text).slice(0, 300));
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function waitFor(cdp, expr, timeout, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await ev(cdp, expr); if (v) return v; } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('等待超时: ' + desc);
}
(async () => {
  await launchChrome();
  const c = await cdpConnect();
  // 弹窗自动处理（重命名 prompt）
  c.on('Page.javascriptDialogOpening', async p => { await c.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
  await ev(c, `localStorage.setItem('divtool_unlock_ts', String(Date.now()));`);
  await ev(c, `if (navigator.serviceWorker) { navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())); }`);
  await new Promise(r => setTimeout(r, 500));
  await ev(c, `location.reload();`);
  await new Promise(r => setTimeout(r, 9000));

  /* 1. 组合卡新结构 */
  T('组合卡 v1 结构齐全', await ev(c, `(() => ['comboSel','comboName','comboTotal','comboTotalMon','comboCashPct','comboDonut','comboDonutMode','comboEqual','comboNew','comboRename','comboDup','comboDel','comboCheck'].every(i => !!document.getElementById(i)))()`));

  /* 2. 示例组合加载 → 40/30/30 */
  await ev(c, `document.getElementById('comboFromDemo').click();`);
  await new Promise(r => setTimeout(r, 3000));
  T('示例组合 3 只', await ev(c, `document.querySelectorAll('#comboListWrap [data-crow]').length`) === 3, await ev(c, `document.querySelectorAll('#comboListWrap [data-crow]').length`));
  T('环形图 3 扇形', await ev(c, `document.querySelectorAll('#comboDonut path[data-di]').length`) === 3);

  /* 3. 改 % 等比缩放（招行 40→50，其余同缩） */
  await ev(c, `(() => { const i = document.querySelector('[data-pct="0"]'); i.value='50'; i.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 600));
  T('等比缩放 50/25/25', await ev(c, `Array.from(document.querySelectorAll('#comboListWrap [data-pct]')).map(x=>x.value).join('/')`) === '50/25/25', await ev(c, `Array.from(document.querySelectorAll('#comboListWrap [data-pct]')).map(x=>x.value).join('/')`));

  /* 4. 等权 → 33.3/33.3/33.3 */
  await ev(c, `document.getElementById('comboEqual').click();`);
  await new Promise(r => setTimeout(r, 500));
  T('等权 33.3×3', await ev(c, `Array.from(document.querySelectorAll('#comboListWrap [data-pct]')).every(x => Math.abs(parseFloat(x.value) - 33.3) < 0.5)`), await ev(c, `Array.from(document.querySelectorAll('#comboListWrap [data-pct]')).map(x=>x.value).join('/')`));

  /* 5. 总投资 200 万 → 总额更新 */
  await ev(c, `(() => { const t = document.getElementById('comboTotal'); t.value='2000000'; t.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 500));
  T('总投资 200 万', await ev(c, `document.getElementById('comboTotals').innerText.includes('200.0 万')`), await ev(c, `document.getElementById('comboTotals').innerText`));

  /* 6. 现金仓位 15% → 校验提示 */
  await ev(c, `(() => { const t = document.getElementById('comboCashPct'); t.value='15'; t.dispatchEvent(new Event('change')); })()`);
  await new Promise(r => setTimeout(r, 500));
  T('现金仓位 15% 提示', await ev(c, `document.getElementById('comboCheck').innerText.includes('现金仓位 15%')`), await ev(c, `document.getElementById('comboCheck').innerText`));

  /* 7. 命名保存 */
  await ev(c, `(() => { const n = document.getElementById('comboName'); n.value='我的分红组合'; n.dispatchEvent(new Event('change')); document.getElementById('comboSave').click(); })()`);
  await new Promise(r => setTimeout(r, 600));
  const saved = await ev(c, `(() => { const c = JSON.parse(localStorage.getItem('divtool_combos_v1') || 'null'); return c && c.combos.length === 1 && c.combos[0].name === '我的分红组合' && c.combos[0].cashPct === 15; })()`);
  T('保存命名+现金仓位', saved, await ev(c, `localStorage.getItem('divtool_combos_v1')`));

  /* 8. 复制组合 */
  await ev(c, `document.getElementById('comboDup').click();`);
  await new Promise(r => setTimeout(r, 500));
  T('复制组合 → 2 个', await ev(c, `JSON.parse(localStorage.getItem('divtool_combos_v1')).combos.length`) === 2, await ev(c, `JSON.parse(localStorage.getItem('divtool_combos_v1')).combos.length`));

  /* 9. 重命名 */
  await ev(c, `document.getElementById('comboRename').click();`);
  await new Promise(r => setTimeout(r, 400));
  // prompt 弹窗处理（headless 自动 accept）
  await ev(c, `(() => { const s = document.getElementById('comboName'); s.value = '我的分红组合v2'; s.dispatchEvent(new Event('change')); })()`);
  await ev(c, `document.getElementById('comboSave').click();`);
  await new Promise(r => setTimeout(r, 500));
  T('重命名保存', await ev(c, `JSON.parse(localStorage.getItem('divtool_combos_v1')).combos.some(x => x.name === '我的分红组合v2')`), await ev(c, `JSON.parse(localStorage.getItem('divtool_combos_v1')).combos.map(x=>x.name).join(',')`));

  /* 10. 跑回测（缓存拉数据可能较慢，等 120s） */
  await ev(c, `document.getElementById('comboRun').click();`);
  try {
    await waitFor(c, `(() => { const el = document.getElementById('pfbtResult'); if (!el) return ''; const t = el.innerText || ''; return (t.includes('期末总资产') || t.includes('回本速度')) ? t : (t.includes('体检失败') ? 'FAIL' : ''); })()`, 120000, '驾驶舱渲染');
    T('驾驶舱渲染', await ev(c, `!document.getElementById('pfbtResult').innerText.includes('体检失败')`));
  } catch (e) { T('驾驶舱渲染', false, e.message); }

  /* 11. 驾驶舱新可视化存在 */
  await new Promise(r => setTimeout(r, 4000));
  T('收益贡献图', await ev(c, `(() => { const el = document.getElementById('cockpitContrib'); return !!el && el.innerHTML.length > 50; })()`), await ev(c, `(() => { const el = document.getElementById('cockpitContrib'); return el ? el.innerHTML.length : 'MISSING'; })()`));
  T('股息日历', await ev(c, `(() => { const el = document.getElementById('cockpitDivCal'); return !!el && el.innerText.includes('股息日历'); })()`));
  T('覆盖率演进', await ev(c, `(() => { const el = document.getElementById('cockpitCovEvol'); return !!el && el.innerHTML.length > 50; })()`));
  T('复投vs提取', await ev(c, `(() => { const el = document.getElementById('cockpitReinv'); return !!el && el.innerHTML.length > 50; })()`));
  T('行业分布', await ev(c, `(() => { const el = document.getElementById('cockpitIndustry'); return !!el && el.innerHTML.length > 50; })()`));
  T('回本进度环', await ev(c, `(() => { const el = document.getElementById('cockpitPayback'); return !!el && el.innerText.includes('回本进度'); })()`), await ev(c, `(() => { const el = document.getElementById('cockpitPayback'); return el ? el.innerText : 'MISSING'; })()`));
  T('分红柱状堆叠+增速', await ev(c, `(() => { const el = document.getElementById('cockpitDivBar'); return !!el && el.innerHTML.length > 50; })()`), await ev(c, `(() => { const el = document.getElementById('cockpitDivBar'); return el ? el.innerHTML.length : 'MISSING'; })()`));
  T('现金口径标注', await ev(c, `document.getElementById('pfbtResult').innerText.includes('现金仓位 15%')`));

  /* 12. 组合对比 */
  await ev(c, `(() => { const s = document.getElementById('pfbtCmpSel'); if (s.options.length > 1) { s.value = s.options[1].value; } document.getElementById('pfbtCmpRun').click(); })()`);
  try {
    await waitFor(c, `(() => { const el = document.getElementById('pfbtCmpResult'); return el && (el.innerText.includes('回本') || el.innerText.includes('对比失败')); })()`, 90000, '对比结果');
    T('组合对比结果', await ev(c, `document.getElementById('pfbtCmpResult').innerText.includes('回本')`), await ev(c, `document.getElementById('pfbtCmpResult').innerText.slice(0, 200)`));
  } catch (e) { T('组合对比结果', false, e.message); }

  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
