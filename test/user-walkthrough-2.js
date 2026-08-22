#!/usr/bin/env node
/* test/user-walkthrough-2.js — 用户视角全功能核对 v2（2026-08-17 主人令：每一项功能都测试到）
 * 第一轮漫游覆盖主流程；本轮逐项点开每个功能点，记录 DOM 状态/内容摘要/错误。
 * 覆盖：回测细节(税/复投/月供/上市日/自定义日期) / 诊断全部卡片内容 /
 *       对比细节(严格同期/月供/排序/警告) / 决策台(机会速览/自选/日历/总览展开/资金模拟/横幅) /
 *       组合回测(周期/自定义档位/预设) / URL参数往返 / 移动端全tab
 * 用法：node test/user-walkthrough-2.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8899;
const CDP_PORT = 9235;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-userwalk2-' + Date.now();
const SHOTDIR = '/tmp/userwalk2-' + Date.now();
fs.mkdirSync(SHOTDIR, { recursive: true });

const pageErrors = [];
const dialogs = [];
const notes = [];
const fails = [];

function ok(msg) { console.log('  ✅ ' + msg); }
function warn(msg) { console.log('  ⚠️ ' + msg); }
function fail(name, msg) { fails.push({ name, msg }); console.log('  ❌ ' + name + ': ' + msg); }
function note(name, val) { notes.push({ name, val: String(val).slice(0, 600) }); console.log('  📝 ' + name + ': ' + String(val).slice(0, 350)); }
function die(msg) { console.error('❌ 基础设施失败: ' + msg); process.exit(2); }

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
  const cp = require('child_process').spawn(chrome, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=800,1700', `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  cp.unref();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { if (JSON.parse(d).length >= 0) resolve(); } catch (e) { setTimeout(poll, 300); } });
      }).on('error', () => { if (Date.now() - t0 > 25000) reject(new Error('Chrome 启动超时')); else setTimeout(poll, 300); });
    })();
  });
}
function cdpConnect() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        const page = JSON.parse(d).find(t => t.type === 'page');
        const ws = new (require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws'))(page.webSocketDebuggerUrl);
        let id = 0; const pend = new Map(); const handlers = new Map();
        ws.onmessage = ev => {
          const m = JSON.parse(ev.data);
          if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
          if (m.method && handlers.has(m.method)) handlers.get(m.method).forEach(fn => fn(m.params));
        };
        ws.onopen = () => {
          const cdp = {
            send: (method, params = {}) => new Promise(res => { const mid = ++id; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); }),
            on: (method, fn) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn); },
            close: () => ws.close(),
          };
          Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]).then(() => {
            cdp.on('Runtime.exceptionThrown', p => {
              const d = (p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description) || (p.exceptionDetails && p.exceptionDetails.text) || 'unknown';
              if (!d.includes('Script error.')) pageErrors.push('异常: ' + String(d).slice(0, 400));
            });
            cdp.on('Log.entryAdded', p => {
              if (p.entry && p.entry.level === 'error') {
                const t = (p.entry.text || '').slice(0, 300);
                if (t && !t.includes('Script error.') && !t.includes('net::ERR') && !t.includes('CORS policy')
                    && !t.includes('np-cnotice') && !t.includes('allorigins') && !t.includes('api.fund.eastmoney')
                    && !t.includes('Failed to load resource')) pageErrors.push('console错误: ' + t);
              }
            });
            cdp.on('Page.javascriptDialogOpening', async p => {
              dialogs.push(p.message || '');
              await cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
            });
            resolve(cdp);
          }).catch(reject);
        };
        ws.onerror = e => reject(e);
      });
    }).on('error', reject);
  });
}
async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) {
    const ed = r.result.exceptionDetails;
    return 'EVAL_ERR:' + String((ed.exception && ed.exception.description) || ed.text).slice(0, 200);
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}
async function waitFor(cdp, expr, timeout, desc, interval = 2000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try { last = await evalIn(cdp, expr); } catch (e) { last = null; }
    if (last) return last;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error('等待超时(' + (timeout / 1000) + 's): ' + desc);
}
async function nav(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, `typeof APP_VERSION !== 'undefined'`, 30000, '页面加载');
}
let shotSeq = 0;
async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const data = r.result ? r.result.data : undefined;
  if (!data) throw new Error('截图无数据');
  const f = `${SHOTDIR}/${String(++shotSeq).padStart(2, '0')}-${name}.png`;
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  ok('截图 ' + path.basename(f));
}
async function click(cdp, sel) {
  const r = await evalIn(cdp, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'MISSING:' + ${JSON.stringify(sel)}; el.click(); return 'clicked'; })()`);
  if (String(r).startsWith('MISSING')) warn('元素缺失: ' + sel);
  return r;
}
/* 取某 id 元素文本（不存在返回 null） */
const text = (id) => `(() => { const el = document.getElementById(${JSON.stringify(id)}); return el ? el.innerText.slice(0, 500) : null; })()`;
/* 取某容器内全部卡片文本 */
const cardTexts = (tabId) => `(() => [...document.querySelectorAll('#${tabId} .card')].map(c => (c.querySelector('h2')||{}).innerText + '=>' + c.innerText.slice(0, 300)).join('\\n---\\n'))()`;

async function main() {
  /* v3.7.0（接手 AI）：启动前清理残留实例（release 连续跑 CDP 测试时旧 Chrome 占端口→连旧页面→超时） */
  try { require('child_process').execSync('lsof -tiTCP:' + ' + CDP_PORT + ' + ' -sTCP:LISTEN | xargs kill -9 2>/dev/null; sleep 1', { timeout: 8000, stdio: 'ignore' }); } catch (e) {}
  await ensureServer();
  await launchChrome();
  let cdp;
  try { cdp = await cdpConnect(); } catch (e) { die('CDP 连接失败: ' + e.message); }

  /* ============ A. 回测页细节 ============ */
  await nav(cdp, BASE);
  await click(cdp, `.tabbar button[data-tab="backtest"]`);
  await new Promise(r => setTimeout(r, 1500));

  note('A1 税下拉选项', await evalIn(cdp, `[...document.querySelectorAll('#taxRate option')].map(o=>o.textContent).join('|')`));
  note('A2 复投开关默认', await evalIn(cdp, `document.getElementById('reinvest').checked`));
  note('A3 月供快捷按钮', await evalIn(cdp, `[...document.querySelectorAll('#tab-backtest button[data-m]')].map(b=>b.textContent).join('|')`));
  note('A4 日期锚点按钮', await evalIn(cdp, `[...document.querySelectorAll('#tab-backtest button[data-anchor]')].map(b=>b.textContent+':'+b.getAttribute('data-anchor')).join('|')`));
  // 上市日快捷
  await click(cdp, `#tab-backtest button[data-anchor="ipo"]`);
  await new Promise(r => setTimeout(r, 500));
  note('A5 上市日按钮后日期', await evalIn(cdp, `document.getElementById('buyDate').value + ' 提示:' + (document.getElementById('codeHint')||{}).innerText`));
  // 月供 5000
  await click(cdp, `#tab-backtest button[data-m="5000"]`);
  await new Promise(r => setTimeout(r, 300));
  note('A6 月供5000按钮', await evalIn(cdp, `document.getElementById('monthly').value`));
  // 税切换
  await evalIn(cdp, `(() => { const s = document.getElementById('taxRate'); s.value = '0.1'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'tax set 10%'; })()`);
  note('A7 税切10%', 'ok');
  // 回测跑一次带月供+税
  await click(cdp, '#btnRun');
  try { await waitFor(cdp, `(() => { const t = (document.getElementById('status')||{}).innerText || ''; return t.includes('完成') ? t : ''; })()`, 90000, '回测完成'); } catch (e) { fail('A8 回测(月供+税)', e.message); }
  note('A8 回测状态', await evalIn(cdp, `(document.getElementById('status')||{}).innerText || ''`));
  note('A9 回测概览卡', await evalIn(cdp, `(() => { const el = document.getElementById('overview') || document.querySelector('#tab-backtest .card:nth-of-type(2)'); return el ? el.innerText.slice(0, 500) : '(找概览失败)'; })()`));
  await shot(cdp, 'A-回测月供税');
  // 年度明细表
  note('A10 年度明细表', await evalIn(cdp, `(() => { const t = document.querySelector('#tab-backtest table'); return t ? t.innerText.slice(0, 400) : '(无表格)'; })()`));

  /* ============ B. 诊断页全部卡片 ============ */
  // 从决策台搜索进入（真实路径）
  await click(cdp, `.tabbar button[data-tab="home"]`);
  await evalIn(cdp, `(() => { const el = document.getElementById('homeSearch'); el.value = '600036'; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); return 1; })()`);
  try { await waitFor(cdp, `document.getElementById('diagStats') && document.getElementById('diagStats').innerText.length > 20`, 60000, '诊断加载'); } catch (e) { fail('B0 诊断加载', e.message); }
  await new Promise(r => setTimeout(r, 3000));
  note('B1 关键数据', await evalIn(cdp, text('diagStats')));
  note('B2 建仓区', await evalIn(cdp, text('diagZone')));
  note('B3 建仓区说明', await evalIn(cdp, text('diagZoneNote')));
  note('B4 信号线说明', await evalIn(cdp, text('diagSignalNote')));
  note('B5 分红趋势', await evalIn(cdp, text('diagDivTrend')));
  note('B6 卖出信号', await evalIn(cdp, text('diagSellSignals')));
  note('B7 档位画像', await evalIn(cdp, text('diagTierProfile')));
  note('B8 策略对比', await evalIn(cdp, text('diagStrategy')));
  note('B9 策略导读', await evalIn(cdp, text('diagStrategyGuide')));
  note('B10 分红节奏', await evalIn(cdp, text('diagRhythm')));
  note('B11 多起点敏感度', await evalIn(cdp, text('diagMultiStart')));
  note('B12 股息率说明', await evalIn(cdp, text('diagYieldNote')));
  await shot(cdp, 'B-诊断全卡-上半');
  // 滚动到页面底部截图
  await evalIn(cdp, `window.scrollTo(0, document.body.scrollHeight)`);
  await new Promise(r => setTimeout(r, 800));
  await shot(cdp, 'B-诊断全卡-下半');
  // 加自选 → 已自选 → 取消
  await evalIn(cdp, `window.scrollTo(0,0)`);
  await new Promise(r => setTimeout(r, 500));
  await click(cdp, '#diagWlBtn');
  await new Promise(r => setTimeout(r, 1200));
  note('B13 加自选后按钮', await evalIn(cdp, `document.getElementById('diagWlBtn').innerText`));
  await click(cdp, '#diagWlBtn');  // 再点=取消（confirm）
  await new Promise(r => setTimeout(r, 800));
  note('B14 取消后按钮', await evalIn(cdp, `document.getElementById('diagWlBtn').innerText + ' 弹窗数:' + ${JSON.stringify('')} + (window.__dlg2 || 0)`));

  /* ============ C. 对比页细节 ============ */
  await click(cdp, `.tabbar button[data-tab="compare"]`);
  // 严格同期 + 月供 + 上市晚警告(588000)
  await evalIn(cdp, `(() => { const el = document.getElementById('cmpInput'); el.value = '588000'; el.dispatchEvent(new Event('input', {bubbles:true})); return 1; })()`);
  await click(cdp, '#btnCmpAdd');
  await new Promise(r => setTimeout(r, 2500));
  await evalIn(cdp, `document.getElementById('cmpStrict').click()`);
  await evalIn(cdp, `(() => { const el = document.getElementById('cmpMonthly'); el.value = '3000'; el.dispatchEvent(new Event('input', {bubbles:true})); return el.value; })()`);
  await click(cdp, '#btnCmpRun');
  try { await waitFor(cdp, `(() => { const els = [...document.querySelectorAll('#cmpTbl tr')]; return els.length > 5 ? 'rows' : ''; })()`, 90000, '对比运行'); } catch (e) { fail('C1 对比运行(严格+月供+588000)', e.message); }
  note('C2 严格同期警告', await evalIn(cdp, `(document.getElementById('cmpWarn')||{}).innerText || '(无警告)'`));
  note('C3 对比说明', await evalIn(cdp, `(document.getElementById('cmpNote')||{}).innerText || '(无cmpNote)'`));
  note('C4 表格内容', await evalIn(cdp, `document.getElementById('cmpTbl').innerText.slice(0, 500)`));
  // 排序点击
  await evalIn(cdp, `(() => { const th = document.querySelector('#cmpTbl th'); if (th) th.click(); return th ? th.innerText : 'NO TH'; })()`);
  await new Promise(r => setTimeout(r, 800));
  note('C5 表头排序后', await evalIn(cdp, `document.querySelector('#cmpTbl thead').innerText.replace(/\\n/g,' ')`));
  await shot(cdp, 'C-对比-严格同期月供');

  /* ============ D. 决策台细节 ============ */
  await click(cdp, `.tabbar button[data-tab="home"]`);
  await new Promise(r => setTimeout(r, 2000));
  note('D1 机会速览', await evalIn(cdp, `(document.getElementById('homeOpportunities')||{}).innerText.slice(0, 400) || '(空)'`));
  note('D2 自选列表', await evalIn(cdp, `(document.getElementById('homeWatchlist')||{}).innerText.slice(0, 400) || '(空)'`));
  note('D3 分红日历', await evalIn(cdp, `(document.getElementById('homeDivCalendar')||{}).innerText.slice(0, 400) || '(空)'`));
  note('D4 横幅区', await evalIn(cdp, `(document.getElementById('zoneBanner')||{}).innerText.slice(0, 300) || '(空)'`));
  // 组合总览展开
  await click(cdp, '#portfolioCard h2');
  await new Promise(r => setTimeout(r, 5000));
  note('D5 组合总览内容', await evalIn(cdp, `(document.getElementById('portfolioBody')||{}).innerText.slice(0, 500) || '(空)'`));
  // 资金分配模拟输入
  const fundInput = await evalIn(cdp, `(() => { const els = [...document.querySelectorAll('#portfolioBody input')]; return els.map(e => e.id + '=' + e.value).join('|') || '(无输入框)'; })()`);
  note('D6 资金模拟输入框', fundInput);
  await shot(cdp, 'D-决策台-总览展开');

  /* ============ E. 组合回测细节 ============ */
  await click(cdp, `.tabbar button[data-tab="pfbt"]`);
  await new Promise(r => setTimeout(r, 800));
  note('E1 周期按钮', await evalIn(cdp, `[...document.querySelectorAll('#tab-pfbt .pfbt-y')].map(b=>b.textContent+(b.className.includes('on')?'(激活)':'')).join('|')`));
  note('E2 预设chips', await evalIn(cdp, `[...document.querySelectorAll('#tab-pfbt .pfbt-preset')].map(b=>b.textContent).join('|')`));
  // 自定义档位
  await evalIn(cdp, `(() => { const el = document.getElementById('pfbtCustom'); el.value = '75:50,85:50'; return 1; })()`);
  await click(cdp, '#pfbtCustomAdd');
  await new Promise(r => setTimeout(r, 600));
  note('E3 自定义档位加入', await evalIn(cdp, `[...document.querySelectorAll('#tab-pfbt .chip')].map(c=>c.textContent).join(' | ')`));
  await click(cdp, '#pfbtRun');
  try { await waitFor(cdp, `(() => { const t = (document.getElementById('pfbtStatus')||{}).innerText || ''; return t.includes('完成') ? t : ''; })()`, 90000, '组合回测'); } catch (e) { fail('E4 组合回测运行', e.message); }
  note('E4 组合回测状态', await evalIn(cdp, `(document.getElementById('pfbtStatus')||{}).innerText || '(无)'`));
  note('E5 组合回测结果', await evalIn(cdp, `(() => { const el = document.querySelector('#tab-pfbt .card:last-child'); return el ? el.innerText.slice(0, 600) : '(无结果卡)'; })()`));
  await shot(cdp, 'E-组合回测-结果');

  /* ============ F. URL 参数往返 ============ */
  await nav(cdp, BASE + '?y=10&r=1&p=500000&m=2000');
  await new Promise(r => setTimeout(r, 2500));
  note('F1 URL参数恢复', await evalIn(cdp, `'代码:' + document.getElementById('code').value + ' 本金:' + document.getElementById('principal').value + ' 月供:' + document.getElementById('monthly').value + ' 复投:' + document.getElementById('reinvest').checked`));
  await nav(cdp, BASE + '?d=2020-01-02');
  await new Promise(r => setTimeout(r, 2500));
  note('F2 d参数', await evalIn(cdp, `document.getElementById('buyDate').value`));

  /* ============ G. 移动端全 tab ============ */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await nav(cdp, BASE);
  await new Promise(r => setTimeout(r, 3000));
  await shot(cdp, 'G-移动-决策台');
  for (const [tab, label] of [['diagnose', '诊断'], ['compare', '对比'], ['backtest', '回测'], ['pfbt', '组合回测']]) {
    await click(cdp, `.tabbar button[data-tab="${tab}"]`);
    await new Promise(r => setTimeout(r, 1500));
    const overflow = await evalIn(cdp, `document.documentElement.scrollWidth > window.innerWidth + 1 ? '横向溢出!' : 'ok'`);
    note('G-移动-' + label, '横向: ' + overflow);
    await shot(cdp, 'G-移动-' + label);
  }

  /* ============ 汇总 ============ */
  console.log('\n================ 核对汇总 ================');
  console.log('截图目录: ' + SHOTDIR);
  console.log('页面错误 ' + pageErrors.length + ' 条:');
  pageErrors.forEach(e => console.log('  ❌ ' + e));
  console.log('弹窗 ' + dialogs.length + ' 个:');
  dialogs.forEach(d => console.log('  ⚠️ ' + d));
  if (fails.length) { console.log('失败项 ' + fails.length + ' 个:'); fails.forEach(f => console.log('  ❌ ' + f.name + ': ' + f.msg)); }
  fs.writeFileSync(SHOTDIR + '/notes.json', JSON.stringify({ notes, pageErrors, dialogs, fails }, null, 2));
  console.log('笔记存档: ' + SHOTDIR + '/notes.json');
  cdp.close();
  process.exit(pageErrors.length ? 1 : 0);
}

main().catch(e => { console.error('核对中断: ' + e.message); process.exit(2); });
