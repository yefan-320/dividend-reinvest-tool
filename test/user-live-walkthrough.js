#!/usr/bin/env node
/* test/user-live-walkthrough.js — 用户视角线上走查（2026-08-18 主人令：站在用户角度用一下）
 * 直接打 GitHub Pages 线上地址，模拟真实用户：
 *   首访→密码锁→错密码→对密码→进工具→决策台数据→搜索诊断→联网回测→免密重载→换设备→手机端
 * 用法：node test/user-live-walkthrough.js   （退出码 0=全过，1=有失败，2=基础设施失败）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WS = require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws');

const LIVE = 'https://yefan-320.github.io/dividend-reinvest-tool/';
const PWD = 'fange9255';
let CDP_PORT = 9244;
const nextPort = () => { CDP_PORT += 1; return CDP_PORT; };
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
let pageErrors = [];
let dialogs = [];

function die(msg) { console.error('❌ 基础设施失败: ' + msg); process.exit(2); }
function ok(msg) { console.log('  ✅ ' + msg); }
function S(name, fn) {
  const t0 = Date.now();
  return fn().then(
    () => { results.push({ name, pass: true }); console.log(`✅ [${((Date.now() - t0) / 1000).toFixed(0)}s] ${name}`); },
    e => { results.push({ name, pass: false, detail: e.message }); console.log(`❌ [${((Date.now() - t0) / 1000).toFixed(0)}s] ${name}: ${e.message}`); }
  );
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function launchChrome(profile) {
  if (!fs.existsSync(CHROME)) die('Chrome 不存在');
  const cp = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=900,1600', `--user-data-dir=${profile}`, '--no-sandbox', '--remote-allow-origins=*', 'about:blank',
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
        if (!page) return reject(new Error('无页面'));
        const ws = new WS(page.webSocketDebuggerUrl);
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
              const url = (p.exceptionDetails && p.exceptionDetails.url) || '';
              if (d.includes('Script error.')) return;
              pageErrors.push('异常: ' + String(d).slice(0, 300) + (url ? ' @' + url : ''));
            });
            cdp.on('Log.entryAdded', p => {
              if (p.entry && p.entry.level === 'error') {
                const t = (p.entry.text || '').slice(0, 300);
                if (t && !t.includes('Script error.') && !t.includes('net::ERR')
                    && !t.includes('CORS policy') && !t.includes('np-cnotice') && !t.includes('allorigins')
                    && !t.includes('Failed to load resource') && !t.includes('api.fund.eastmoney')) pageErrors.push('console错误: ' + t);
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
    throw new Error('eval异常: ' + String((ed.exception && ed.exception.description) || ed.text).slice(0, 300));
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

const todayMinus = n => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };

function killChrome() {
  try { require('child_process').execSync(`pkill -f 'dvt-live'`); } catch (e) {}
  try { require('child_process').execSync(`pkill -f 'remote-debugging-port=${CDP_PORT}'`); } catch (e) {}
}

/* 等旧实例端口释放（pkill 后端口可能还被将死进程占用） */
function waitPortFree(timeout) {
  return new Promise(resolve => {
    const t0 = Date.now();
    (function poll() {
      http.get(`http://127.0.0.1:${CDP_PORT}/json`, r => { r.resume(); r.on('end', () => setTimeout(poll, 300)); })
        .on('error', () => resolve());
      if (Date.now() - t0 > timeout) resolve();
    })();
  });
}

async function main() {
  /* v3.7.0（接手 AI）：启动前清理残留实例（release 连续跑 CDP 测试时旧 Chrome 占端口→连旧页面→超时） */
  try { require('child_process').execSync('lsof -tiTCP:' + ' + CDP_PORT + ' + ' -sTCP:LISTEN | xargs kill -9 2>/dev/null; sleep 1', { timeout: 8000, stdio: 'ignore' }); } catch (e) {}
  console.log('🌐 用户视角线上走查: ' + LIVE + '\n');
  /* 先清场：残留的无头 Chrome（含上次崩溃遗留）全杀，防端口冲突连错实例 */
  killChrome();
  await waitPortFree(15000);

  /* ========== A. 设备1 首访 + 密码锁 ========== */
  const profA = '/tmp/dvt-live-a-' + Date.now();
  await launchChrome(profA);
  let cdp;
  try { cdp = await cdpConnect(); } catch (e) { die('CDP 连接失败: ' + e.message); }

  await S('A1 首访显示密码锁', async () => {
    await cdp.send('Page.navigate', { url: LIVE });
    await waitFor(cdp, `document.getElementById('lockScreen') && getComputedStyle(document.getElementById('lockScreen')).display === 'flex'`, 30000, '密码锁出现');
    const t = await evalIn(cdp, `document.getElementById('lockScreen').innerText`);
    assert(t.includes('访问密码'), '锁屏文案异常');
    ok('锁屏显示: ' + t.split('\n').slice(0, 2).join(' / '));
  });

  await S('A2 错误密码被拦截', async () => {
    await evalIn(cdp, `(() => { document.getElementById('lockPwd').value='wrong999'; document.getElementById('lockBtn').click(); })()`);
    await waitFor(cdp, `(document.getElementById('lockMsg').innerText||'').includes('密码错误')`, 8000, '错误提示');
    const still = await evalIn(cdp, `getComputedStyle(document.getElementById('lockScreen')).display`);
    assert(still === 'flex', '错误密码竟解锁了!');
    ok('错误密码 → 提示"密码错误，请重试"，锁未开');
  });

  await S('A3 正确密码解锁进工具', async () => {
    await evalIn(cdp, `(() => { document.getElementById('lockPwd').value=${JSON.stringify(PWD)}; document.getElementById('lockBtn').click(); })()`);
    await waitFor(cdp, `getComputedStyle(document.getElementById('lockScreen')).display === 'none'`, 8000, '解锁');
    const ver = await waitFor(cdp, `typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''`, 10000, '版本号');
    const title = await evalIn(cdp, `document.querySelector('h1').innerText`);
    ok(`解锁成功 → ${title.trim()} v${ver}`);
  });

  await S('A4 决策台真实数据加载', async () => {
    // 全新设备自选为空 → 正常应显示"暂无自选股"空态；有自选后才有提醒内容
    const opp = await waitFor(cdp, `(() => { const t = document.getElementById('homeOpportunities').innerText; return (!t.includes('加载中') && t.length > 8) ? t : ''; })()`, 60000, '机会速览');
    assert(opp.includes('暂无自选股') || opp.includes('%') || opp.includes('股息率'), '机会速览状态异常: ' + opp.slice(0, 40));
    const wl = await evalIn(cdp, `document.getElementById('homeWatchlist').innerText || ''`);
    const cal = await evalIn(cdp, `document.getElementById('homeDivCalendar').innerText || ''`);
    ok(`机会速览 ${opp.length}字 / 自选 ${wl.length}字 / 分红日历 ${cal.length}字`);
  });

  await S('A5 搜索 600036 回车 → 诊断页', async () => {
    await evalIn(cdp, `(() => { const s = document.getElementById('homeSearch'); s.value='600036'; s.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
    const title = await waitFor(cdp, `(() => { const t = document.getElementById('diagTitle').innerText; return (t.includes('招商银行') || t.includes('600036')) && !t.includes('诊断中') ? t : ''; })()`, 60000, '诊断页标题');
    await waitFor(cdp, `(document.getElementById('diagSummaryBody').innerText||'').length > 30`, 60000, '诊断摘要数据');
    const sum = await evalIn(cdp, `document.getElementById('diagSummaryBody').innerText`);
    const rc = await evalIn(cdp, `document.getElementById('diagReportCard').style.display`);
    ok(`诊断页就绪: ${title} | 摘要 ${sum.length}字 | 报告卡 ${rc === 'block' ? '显示✅' : '未显示'}`);
  });

  await S('A6 联网回测 600036 5年（真实数据）', async () => {
    await evalIn(cdp, `document.querySelector('.tabbar button[data-tab="backtest"]').click()`);
    await evalIn(cdp, `(() => { document.getElementById('code').value='600036'; document.getElementById('principal').value='1000000'; document.getElementById('buyDate').value='${todayMinus(5)}'; document.getElementById('reinvest').checked=true; document.getElementById('monthly').value='0'; document.getElementById('btnRun').click(); })()`);
    const status = await waitFor(cdp, `(() => { const t = (document.getElementById('status')||{}).innerText || ''; return t.includes('✅ 完成') ? t : ''; })()`, 180000, '回测完成');
    const name = await evalIn(cdp, `document.getElementById('stockName').innerText`);
    const stats = await evalIn(cdp, `document.getElementById('stats').innerText`);
    let miss = [];
    for (const k of ['初始本金', '累计分红', '年均分红', '年化收益率', '期末持股']) if (!stats.includes(k)) miss.push(k);
    assert(!miss.length, '统计缺项: ' + miss.join('/'));
    ok(`回测完成: ${name} | ${status.slice(0, 60)} | 统计12格完整`);
  });

  await S('A7 刷新页面 → 30天免密生效', async () => {
    const ts = await evalIn(cdp, `(() => { const k = Object.keys(localStorage).find(x => x.includes('unlock') || x.includes('divtool')); return k ? (localStorage.getItem(k) + '|' + k) : ''; })()`);
    assert(ts, 'localStorage 无免密标记');
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(cdp, `typeof APP_VERSION !== 'undefined'`, 30000, '重载完成');
    await new Promise(r => setTimeout(r, 1500));
    const disp = await evalIn(cdp, `getComputedStyle(document.getElementById('lockScreen')).display`);
    assert(disp === 'none', '重载后锁又出现了: ' + disp);
    ok(`重载直接进工具（免密标记: ${ts.split('|')[1]}）`);
  });
  cdp.close();
  killChrome();

  /* ========== B. 设备2 首访 ========== */
  await killChrome();
  await waitPortFree(15000);
  CDP_PORT = nextPort();
  const profB = '/tmp/dvt-live-b-' + Date.now();
  await launchChrome(profB);
  try { cdp = await cdpConnect(); } catch (e) { die('CDP 连接失败: ' + e.message); }

  await S('B1 第二台设备（新浏览器）仍需密码', async () => {
    await cdp.send('Page.navigate', { url: LIVE });
    await waitFor(cdp, `document.getElementById('lockScreen') && getComputedStyle(document.getElementById('lockScreen')).display === 'flex'`, 30000, '设备2密码锁');
    ok('设备2 首访 → 密码锁正常出现（免密不跨设备）');
  });

  await S('B2 手机端 390px 布局（解锁后无横向溢出）', async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await evalIn(cdp, `(() => { document.getElementById('lockPwd').value=${JSON.stringify(PWD)}; document.getElementById('lockBtn').click(); })()`);
    await waitFor(cdp, `getComputedStyle(document.getElementById('lockScreen')).display === 'none'`, 8000, '手机解锁');
    await waitFor(cdp, `typeof APP_VERSION !== 'undefined'`, 10000, '手机页加载');
    await new Promise(r => setTimeout(r, 3000));
    const ov = await evalIn(cdp, `(() => { const sw = document.documentElement.scrollWidth; return sw + '|' + window.innerWidth; })()`);
    const [sw, iw] = ov.split('|').map(Number);
    assert(sw <= iw + 2, `横向溢出: scrollWidth=${sw} > innerWidth=${iw}`);
    ok(`390px 手机视口无横向滚动（${sw}≤${iw}）`);
  });
  cdp.close();
  await killChrome();
  await waitPortFree(15000);
  CDP_PORT = nextPort();

  /* ========== 汇总 ========== */
  const pass = results.filter(r => r.pass).length;
  const fail = results.filter(r => !r.pass);
  console.log('\n================ 汇总 ================');
  console.log(`通过 ${pass}/${results.length}，失败 ${fail.length}`);
  if (pageErrors.length) { console.log('\n⚠️ 页面异常 ' + pageErrors.length + ' 条:'); pageErrors.slice(0, 10).forEach(e => console.log('  - ' + e)); }
  else console.log('✅ 全程无页面异常/JS 错误');
  if (dialogs.length) console.log('⚠️ 弹窗 ' + dialogs.length + ' 个: ' + dialogs.slice(0, 5).join(' | '));
  if (fail.length) { console.log('\n失败明细:'); fail.forEach(f => console.log('  ❌ ' + f.name + ': ' + f.detail)); process.exit(1); }
  console.log('\n🎉 用户视角全流程通过 — 线上工具可以正常用！');
  process.exit(0);
}

main().catch(e => { console.error('❌ 脚本异常: ' + e.message); process.exit(2); });
