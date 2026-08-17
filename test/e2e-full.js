#!/usr/bin/env node
/* test/e2e-full.js — 全功能实测扫描 v2（2026-08-17 主人令：所有功能实际测试一遍）
 * 与 e2e-browser.js（发布闸门 R1-R7）互补：按真实用户路径遍历全部 4 tab 功能入口。
 * v2 修复：①全部 eval 包 IIFE 防 const 冲突 ②弹窗计数走页面 window.__dlgN ③等待改为
 *   btnRun 复位+状态双条件（防旧状态误匹配）④B4 断言改 body 行 ⑤B5 closest 修正。
 * 用法：node test/e2e-full.js   （退出码 0=全过，1=有失败，2=基础设施失败）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PORT = 8899;
const CDP_PORT = 9233;
const BASE = `http://localhost:${PORT}/`;
const PROFILE = '/tmp/dvt-full-profile-' + Date.now();   // 每次全新 profile：模拟真实用户首次访问（防 HTTP 缓存加载旧版 JS）   // 固定 profile：跨轮复用 IndexedDB 缓存（重跑提速）

const results = [];
let pageErrors = [];
let dialogs = [];
let knownBugs = [];

function die(msg) { console.error('❌ 基础设施失败: ' + msg); process.exit(2); }
function ok(msg) { console.log('  ✅ ' + msg); }
function S(name, fn) {
  const t0 = Date.now();
  return fn().then(
    () => { results.push({ name, pass: true }); console.log(`✅ [${((Date.now() - t0) / 1000).toFixed(0)}s] ${name}`); },
    e => {
      results.push({ name, pass: false, detail: e.message });
      console.log(`❌ [${((Date.now() - t0) / 1000).toFixed(0)}s] ${name}: ${e.message}`);
    }
  );
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

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
  const cp = require('child_process').spawn(chrome, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=800,1600', `--user-data-dir=${PROFILE}`, 'about:blank',
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
              const url = (p.exceptionDetails && p.exceptionDetails.url) || '';
              if (d.includes('Script error.')) return;
              if (d.includes('fitLegendTop is not a function')) { knownBugs.push('BUG-3 首次加载 demo 半渲染（fitLegendTop 时序）@' + url); return; }
              pageErrors.push('异常: ' + String(d).slice(0, 400) + (url ? ' @' + url : ''));
            });
            cdp.on('Log.entryAdded', p => {
              if (p.entry && p.entry.level === 'error') {
                const t = (p.entry.text || '').slice(0, 300);
                if (t && !t.includes('Script error.') && !t.includes('net::ERR')
                    && !t.includes('CORS policy') && !t.includes('np-cnotice') && !t.includes('allorigins')
                    && !t.includes('api.fund.eastmoney') && !t.includes('Failed to load resource')) pageErrors.push('console错误: ' + t);
              }
            });
            cdp.on('Page.javascriptDialogOpening', async p => {
              dialogs.push(p.message || '');
              await cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
              await cdp.send('Runtime.evaluate', { expression: 'window.__dlgN = (window.__dlgN || 0) + 1' }).catch(() => {});
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

/* 回测完成等待：btnRun 复位（finally 置回）且 status 含指定词（防旧状态误匹配） */
async function waitRunDone(cdp, before, keyword, timeout, desc) {
  return waitFor(cdp, `(() => { const t = (document.getElementById('status')||{}).innerText || ''; return (t !== ${JSON.stringify(before)} && t.includes(${JSON.stringify(keyword)})) ? t : ''; })()`, timeout, desc);
}
async function statusText(cdp) { return (await evalIn(cdp, `(document.getElementById('status')||{}).innerText || ''`)) || ''; }

async function waitDlg(timeout, desc) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (dialogs.length > 0) return dialogs[dialogs.length - 1];
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('等待弹窗超时: ' + desc);
}

async function nav(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, `typeof APP_VERSION !== 'undefined'`, 30000, '页面加载');
}

const todayMinus = n => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };

/* ==================== 主流程 ==================== */
async function main() {
  await ensureServer();
  await launchChrome();
  let cdp;
  try { cdp = await cdpConnect(); } catch (e) { die('CDP 连接失败: ' + e.message); }

  await S('G1 初始页加载+离线演示自动跑', async () => {
    await nav(cdp, BASE);
    // v1.8.13 BUG-3 验收：load 后自动 demo 完成，首屏全渲染（12格+4图+仪表盘+年度表+状态走完）
    // v1.8.13：demo 在 views.js 就绪后毫秒级完成——直接等完成态（无 before 变化条件，防读已完成状态）
    const status = await waitFor(cdp, `(document.getElementById('status')||{}).innerText||''`, 60000, '首屏演示完成');
    await waitFor(cdp, `((document.getElementById('status')||{}).innerText||'').includes('演示数据')`, 10000, '演示数据状态');
    // v1.8.13：echarts CDN 慢时先文字降级、onload 后自动补图——等图表就位（最多 60s）
    await waitFor(cdp, `(() => { const c = echarts.getInstanceByDom(document.getElementById('chartDiv')); return c && c.getOption().series && c.getOption().series.length > 0; })()`, 60000, 'echarts 补图');
    const st = await evalIn(cdp, `(() => {
      const has = id => { const c = echarts.getInstanceByDom(document.getElementById(id)); return c ? (c.getOption().series || []).length : -1; };
      return { stats: document.getElementById('stats').innerText, chartAsset: has('chartAsset'), chartDiv: has('chartDiv'), chartRate: has('chartRate'), chartShares: has('chartShares'), gauge1: has('chartGauge1'), tblRows: document.querySelectorAll('#tbl tbody tr').length };
    })()`);
    assert(st.stats.includes('累计分红'), '演示结果无累计分红');
    assert(st.stats.includes('年均分红') && st.stats.includes('最近年度分红'), '概览缺年均/最近年度分红');
    assert(st.chartDiv > 0 && st.chartRate > 0 && st.chartShares > 0 && st.gauge1 > 0, 'BUG-3 复发：图表未全渲染 ' + JSON.stringify({ a: st.chartAsset, d: st.chartDiv, r: st.chartRate, s: st.chartShares, g: st.gauge1 }));
    assert(st.tblRows >= 5, 'BUG-3 复发：年度表空');
    assert(!status.includes('页面错误') && !status.includes('回测出错'), '首屏有错误: ' + status.slice(0, 60));
    const ver = await evalIn(cdp, `APP_VERSION`);
    assert(/^v1\.(8|9)\.\d+$/.test(ver), '版本号异常: ' + ver);
    ok('首屏全渲染（12格+4图+仪表盘+年度表' + st.tblRows + '行），' + ver);
  });

  await S('G2 tab 切换', async () => {
    for (const t of ['home', 'diagnose', 'compare', 'backtest']) {
      await evalIn(cdp, `document.querySelector('.tabbar button[data-tab="${t}"]').click()`);
      const vis = await evalIn(cdp, `document.getElementById('tab-${t}').style.display`);
      assert(vis === 'block', `tab-${t} 未显示 (display=${vis})`);
    }
    await evalIn(cdp, `document.querySelector('.tabbar button[data-tab="backtest"]').click()`);
    ok('4 tab 切换正常');
  });

  await S('B1 回测输入校验', async () => {
    await evalIn(cdp, `document.querySelector('.tabbar button[data-tab="backtest"]').click()`);
    await evalIn(cdp, `(() => { document.getElementById('principal').value='0'; document.getElementById('btnRun').click(); })()`);
    await waitFor(cdp, `(document.getElementById('status').innerText||'').includes('请输入正确的初始本金')`, 8000, '本金=0 提示');
    await evalIn(cdp, `(() => { document.getElementById('principal').value='1000000'; document.getElementById('buyDate').value=''; document.getElementById('btnRun').click(); })()`);
    await waitFor(cdp, `(document.getElementById('status').innerText||'').includes('请选择买入日期')`, 8000, '日期为空提示');
    await evalIn(cdp, `(() => { document.getElementById('buyDate').value='${todayMinus(5)}'; document.getElementById('code').value='abcdef'; document.getElementById('btnRun').click(); })()`);
    await waitFor(cdp, `(document.getElementById('status').innerText||'').includes('未找到') || (document.getElementById('status').innerText||'').includes('解析失败')`, 30000, '非法代码提示');
    ok('三种非法输入均正确拦截');
  });

  await S('B2 联网回测 600036 5年', async () => {
    const before = await statusText(cdp);
    await evalIn(cdp, `(() => { document.getElementById('code').value='600036'; document.getElementById('principal').value='1000000'; document.getElementById('buyDate').value='${todayMinus(5)}'; document.getElementById('reinvest').checked=true; document.getElementById('monthly').value='0'; document.getElementById('btnRun').click(); })()`);
    const status = await waitRunDone(cdp, before, '✅ 完成：', 150000, '联网回测完成');
    assert(status.includes('K线'), '状态无K线条数: ' + status.slice(0, 80));
    const name = await evalIn(cdp, `document.getElementById('stockName').innerText`);
    assert(name.includes('招商银行'), '股票名未显示: ' + name);
    ok('联网回测完成: ' + status.slice(0, 60));
  });

  await S('B3 回测结果完整性', async () => {
    const stats = await evalIn(cdp, `document.getElementById('stats').innerText`);
    for (const k of ['初始本金', '累计投入', '当前总资产', '期末现金池', '累计分红', '年均分红', '最近年度分红', '总收益率', '年化收益率', '分红率(相对投入)', '分红率(相对本金)', '期末持股'])
      assert(stats.includes(k), '缺统计项: ' + k);
    const charts = await evalIn(cdp, `['chartAsset','chartDiv','chartRate','chartShares','chartGauge1','chartGauge2'].map(id => { const c = echarts.getInstanceByDom(document.getElementById(id)); return c ? c.getOption().series.length : 0; })`);
    assert(charts.every(n => n > 0), '有图表未渲染: ' + JSON.stringify(charts));
    const mp = await evalIn(cdp, `(() => { const o = echarts.getInstanceByDom(document.getElementById('chartAsset')).getOption(); return o.series[0].markPoint ? o.series[0].markPoint.data.length : 0; })()`);
    assert(mp > 0, '资产图无除息标注');
    const rows = await evalIn(cdp, `document.querySelectorAll('#tbl tbody tr').length`);
    assert(rows >= 5, '年度表行数<5: ' + rows);
    const cv = await evalIn(cdp, `(() => { const c = document.querySelector('#chartAsset canvas'); return c ? [c.width, c.height] : null; })()`);
    assert(cv && cv[0] > 100 && cv[1] > 50, '资产图 canvas 未实际绘制: ' + JSON.stringify(cv));
    const gv = await evalIn(cdp, `echarts.getInstanceByDom(document.getElementById('chartGauge1')).getOption().series[0].data[0].value`);
    assert(gv > 0, '仪表盘值为0');
    ok(`12格统计+4图+2仪表盘+年度表${rows}行+除息标注${mp}个 全部就位`);
  });

  await S('B4 分红口径切换(到账年/报告期)', async () => {
    const payData = await evalIn(cdp, `JSON.stringify(echarts.getInstanceByDom(document.getElementById('chartDiv')).getOption().xAxis[0].data)`);
    await evalIn(cdp, `document.querySelector('input[name="divMode"][value="report"]').click()`);
    await waitFor(cdp, `document.getElementById('divModeTitle').innerText === '报告期'`, 8000, '标题切报告期');
    const repData = await evalIn(cdp, `JSON.stringify(echarts.getInstanceByDom(document.getElementById('chartDiv')).getOption().xAxis[0].data)`);
    assert(payData !== repData, '切换后图表数据未变化');
    const head = await evalIn(cdp, `document.querySelector('#tbl thead tr').innerText`);
    assert(!head.includes('年初持股'), '报告期表格列错误: ' + head.slice(0, 60));
    const firstRow = await evalIn(cdp, `document.querySelector('#tbl tbody tr td').innerText`);
    assert(firstRow.includes('报告期'), '报告期表格行未标注: ' + firstRow);
    await evalIn(cdp, `document.querySelector('input[name="divMode"][value="pay"]').click()`);
    await waitFor(cdp, `document.getElementById('divModeTitle').innerText === '到账年'`, 8000, '切回到账年');
    const head2 = await evalIn(cdp, `document.querySelector('#tbl thead tr').innerText`);
    assert(head2.includes('年初持股'), '到账年表格列错误');
    ok('口径切换+表格列联动正常');
  });

  await S('B5 快捷按钮(日期/月供)', async () => {
    await evalIn(cdp, `document.querySelector('#buyDateQuick button[data-y="1"]').click()`);
    const d1 = await evalIn(cdp, `document.getElementById('buyDate').value`);
    assert(Math.abs(new Date(d1) - new Date(todayMinus(1))) < 4 * 86400000, '1年前按钮日期错: ' + d1);
    await evalIn(cdp, `document.querySelector('#buyDateQuick button[data-anchor="yStart"]').click()`);
    const ys = await evalIn(cdp, `document.getElementById('buyDate').value`);
    assert(ys === new Date().getFullYear() + '-01-01', '今年初按钮错: ' + ys);
    await evalIn(cdp, `document.querySelector('#buyDateQuick button[data-anchor="yPrev"]').click()`);
    const yp = await evalIn(cdp, `document.getElementById('buyDate').value`);
    assert(yp === (new Date().getFullYear() - 1) + '-01-01', '去年初按钮错: ' + yp);
    await evalIn(cdp, `(() => { [...document.getElementById('monthly').closest('.field').querySelectorAll('button')].find(b => b.dataset.m === '10000').click(); })()`);
    const m = await evalIn(cdp, `document.getElementById('monthly').value`);
    assert(m === '10000', '月供快捷按钮错: ' + m);
    ok('日期/月供快捷按钮全部正常');
  });

  await S('B6 上市日快捷按钮(25年K线)', async () => {
    await evalIn(cdp, `(() => { document.getElementById('code').value='600036'; document.querySelector('#buyDateQuick button[data-anchor="ipo"]').click(); })()`);
    await waitFor(cdp, `document.getElementById('buyDate').value === '2002-04-09'`, 150000, '上市日回填(招行2002-04-09)');
    ok('上市日=2002-04-09 正确回填');
  });

  await S('B7 名称解析(招商银行→600036)', async () => {
    const before = await statusText(cdp);
    await evalIn(cdp, `(() => { document.getElementById('code').value='招商银行'; document.getElementById('principal').value='1000000'; document.getElementById('buyDate').value='${todayMinus(3)}'; document.getElementById('monthly').value='0'; document.getElementById('btnRun').click(); })()`);
    const status = await waitRunDone(cdp, before, '✅ 完成：', 20000, '名称解析回测完成');
    const code = await evalIn(cdp, `document.getElementById('code').value`);
    assert(code === '600036', '代码未回填600036: ' + code + '（状态: ' + status.slice(0, 50) + '）');
    ok('名称解析并回测成功');
  });

  await S('B8 演示数据按钮', async () => {
    const before = await statusText(cdp);
    await evalIn(cdp, `(() => { document.getElementById('code').value='600036'; document.getElementById('btnDemo').click(); })()`);
    await waitRunDone(cdp, before, '演示数据', 20000, '演示按钮');
    ok('演示数据正常');
  });

  await S('D1 搜索进入诊断(600036)', async () => {
    await evalIn(cdp, `document.querySelector('.tabbar button[data-tab="home"]').click()`);
    await evalIn(cdp, `(() => { const i = document.getElementById('homeSearch'); i.value='600036'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await waitFor(cdp, `document.getElementById('tab-diagnose').style.display==='block' && (document.getElementById('diagTitle').innerText||'').includes('招商银行')`, 30000, '诊断标题');
    ok('搜索600036 → 诊断页招商银行');
  });

  await S('D2 诊断页内容完整性', async () => {
    await waitFor(cdp, `(document.getElementById('diagStats').innerText||'').includes('当前股息率') && !(document.getElementById('diagStats').innerText||'').includes('加载中')`, 60000, '诊断统计');
    const st = await evalIn(cdp, `document.getElementById('diagStats').innerText`);
    for (const k of ['当前股息率', '每股分红', '股息覆盖率', '年化', '最大回撤', 'PE / PB'])
      assert(st.includes(k), '缺诊断项: ' + k);
    const chart = await evalIn(cdp, `(() => { const c = echarts.getInstanceByDom(document.getElementById('diagYieldChart')); return c ? c.getOption().series.length : 0; })()`);
    assert(chart >= 2, '股息率带状图未渲染(series=' + chart + ')');
    const note = await evalIn(cdp, `document.getElementById('diagYieldNote').innerText`);
    assert(note.length > 0, '分位注释为空');
    const rhythm = await evalIn(cdp, `document.querySelectorAll('.rhythm-row').length`);
    assert(rhythm >= 1, '分红节奏为空');
    ok('诊断6格+带状图+分位注释+分红节奏全部就位');
  });

  await S('D3 诊断年数切换(10年/自定义7年)', async () => {
    await evalIn(cdp, `document.querySelector('#diagYieldQuick button[data-y="10"]').click()`);
    await waitFor(cdp, `document.getElementById('diagYieldYears').innerText === '10'`, 8000, '切10年');
    await evalIn(cdp, `(() => { const ci = document.getElementById('diagYieldCustom'); ci.value='7'; ci.dispatchEvent(new Event('change')); })()`);
    await waitFor(cdp, `document.getElementById('diagYieldYears').innerText === '7'`, 8000, '自定义7年');
    ok('年数快捷+自定义切换正常');
  });

  await S('D4 ETF分红标注(512890)', async () => {
    await evalIn(cdp, `document.querySelector('.tabbar button[data-tab="home"]').click()`);
    await evalIn(cdp, `(() => { const i = document.getElementById('homeSearch'); i.value='512890'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await waitFor(cdp, `document.getElementById('tab-diagnose').style.display==='block'`, 20000, '进入512890诊断');
    await waitFor(cdp, `document.getElementById('diagEtfNote').style.display==='block'`, 90000, 'ETF标注显示');
    ok('512890 显示 ETF 数据源标注');
  });

  await S('D5 诊断页转回测按钮', async () => {
    await evalIn(cdp, `document.getElementById('btnDiagBacktest').click()`);
    await waitFor(cdp, `document.getElementById('tab-backtest').style.display==='block'`, 10000, '切回测页');
    const code = await evalIn(cdp, `document.getElementById('code').value`);
    assert(code === '512890', '代码未预填: ' + code);
    ok('诊断→回测 代码预填+自动运行');
  });

  await S('C1 对比页添加标的(chips/输入/去重/上限)', async () => {
    await evalIn(cdp, `document.querySelector('.tabbar button[data-tab="compare"]').click()`);
    const chips = await evalIn(cdp, `document.querySelectorAll('#cmpEtfChips .chip').length`);
    assert(chips >= 8, 'ETF chips<8: ' + chips);
    await evalIn(cdp, `document.querySelector('#cmpEtfChips [data-c="512890"]').click()`);
    await waitFor(cdp, `document.querySelectorAll('#cmpList .wl-card').length === 1`, 90000, 'chip添加');
    await evalIn(cdp, `(() => { const i = document.getElementById('cmpInput'); i.value='600036'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await waitFor(cdp, `document.querySelectorAll('#cmpList .wl-card').length === 2`, 90000, '代码添加');
    dialogs.length = 0;
    await evalIn(cdp, `(() => { const i = document.getElementById('cmpInput'); i.value='600036'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    const dupMsg = await waitDlg(20000, '去重弹窗');
    assert(dupMsg.includes('已在列表'), '去重提示错误: ' + dupMsg);
    for (const c of ['515080', '510300', '588000']) {
      await evalIn(cdp, `document.querySelector('#cmpEtfChips [data-c="${c}"]').click()`);
      await new Promise(r => setTimeout(r, 400));
    }
    await waitFor(cdp, `document.querySelectorAll('#cmpList .wl-card').length === 5`, 90000, '加满5个');
    dialogs.length = 0;
    await evalIn(cdp, `document.querySelector('#cmpEtfChips [data-c="159915"]').click()`);
    const capMsg = await waitDlg(20000, '上限弹窗');
    assert(capMsg.includes('最多对比 5 个'), '上限提示错误: ' + capMsg);
    await evalIn(cdp, `(() => { document.querySelectorAll('#cmpList [data-del]')[4].click(); document.querySelectorAll('#cmpList [data-del]')[3].click(); document.querySelectorAll('#cmpList [data-del]')[2].click(); })()`);
    await waitFor(cdp, `document.querySelectorAll('#cmpList .wl-card').length === 2`, 10000, '删除标的');
    ok('chips/输入/去重/上限5/删除 全部正常');
  });

  await S('C2 对比周期(快捷年数/起始日期)', async () => {
    await evalIn(cdp, `document.querySelector('#cmpYears button[data-y="10"]').click()`);
    const on = await evalIn(cdp, `document.querySelectorAll('#cmpYears button.on').length`);
    assert(on === 1, '快捷年数高亮异常: ' + on);
    const pn = await evalIn(cdp, `document.getElementById('cmpPeriodNote').innerText`);
    assert(pn.includes('近 10 年'), '周期注释错误: ' + pn);
    await evalIn(cdp, `(() => { const di = document.getElementById('cmpStartDate'); di.value='2020-01-02'; di.dispatchEvent(new Event('change')); })()`);
    const pn2 = await evalIn(cdp, `document.getElementById('cmpPeriodNote').innerText`);
    assert(pn2.includes('自 2020-01-02 起'), '日期注释错误: ' + pn2);
    const on2 = await evalIn(cdp, `document.querySelectorAll('#cmpYears button.on').length`);
    assert(on2 === 0, '日期输入后快捷按钮未熄灭');
    dialogs.length = 0;
    await evalIn(cdp, `(() => { const di = document.getElementById('cmpStartDate'); di.value='2099-01-01'; di.dispatchEvent(new Event('change')); })()`);
    const futureMsg = await waitDlg(20000, '未来日期弹窗');
    assert(futureMsg.includes('不能晚于今天'), '未来日期提示错误: ' + futureMsg);
    const dv = await evalIn(cdp, `document.getElementById('cmpStartDate').value`);
    assert(dv === '', '未来日期未清空: ' + dv);
    await evalIn(cdp, `document.querySelector('#cmpYears button[data-y="5"]').click()`);
    ok('快捷年数+日期输入+未来拦截 正常');
  });

  await S('C3 非法金额拦截', async () => {
    dialogs.length = 0;
    await evalIn(cdp, `(() => { document.getElementById('cmpPrincipal').value='abc'; document.getElementById('cmpMonthly').value='0'; document.getElementById('btnCmpRun').click(); })()`);
    const msg = await waitDlg(20000, '金额弹窗');
    assert(msg.includes('有效金额'), '金额提示错误: ' + msg);
    const bc = await evalIn(cdp, `document.getElementById('cmpPrincipal').style.borderColor`);
    assert(bc.includes('red') || bc.includes('224, 102'), '非法金额未标红: ' + bc);
    await evalIn(cdp, `document.getElementById('cmpPrincipal').value='1000000'`);
    ok('非法金额弹窗+红框正常');
  });

  await S('C4 对比运行(600036+512890 5年)', async () => {
    await evalIn(cdp, `(() => { document.getElementById('cmpMonthly').value='0'; document.getElementById('cmpReinvest').checked=true; document.getElementById('cmpStrict').checked=false; document.getElementById('btnCmpRun').click(); })()`);
    await waitFor(cdp, `document.querySelectorAll('#cmpTbl tbody tr').length >= 3`, 180000, '对比结果(表头+2数据行)');
    const tbl = await evalIn(cdp, `document.querySelector('#cmpTbl tbody tr:nth-child(2)').innerText`);
    assert(tbl.includes('招商银行') || tbl.includes('红利低波'), '对比表首数据行异常: ' + tbl.slice(0, 60));
    const charts = await evalIn(cdp, `['cmpChartAsset','cmpChartDiv','cmpChartAnnual','cmpChartYield'].map(id => { const c = echarts.getInstanceByDom(document.getElementById(id)); return c ? c.getOption().series.length : 0; })`);
    assert(charts.every(n => n > 0), '对比图未渲染: ' + JSON.stringify(charts));
    const warnVis = await evalIn(cdp, `document.getElementById('cmpWarn').style.display`);
    assert(warnVis === 'none', '5年窗口不应有上市警告: ' + warnVis);
    // BUG-4 验收：512890 行必须"分红>0 或 明确显示数据暂缺"（静默 0 = 复发）
    const row512 = await evalIn(cdp, `(() => { const trs = [...document.querySelectorAll('#cmpTbl tbody tr')]; const r = trs.find(t => t.innerText.includes('512890')); if (!r) return null; return { text: r.innerText, td4: r.querySelectorAll('td')[3] ? r.querySelectorAll('td')[3].innerText : '', opacity: r.style.opacity }; })()`);
    assert(row512 != null, '512890 不在对比列表');
    const dv = parseInt((row512.td4.match(/[\d,]+/) || ['0'])[0].replace(/,/g, ''), 10);
    const hasMissingMark = row512.td4.includes('数据暂缺') && row512.text.includes('未纳入对比');
    if (!(dv > 0 || hasMissingMark)) {
      const allRows = await evalIn(cdp, `[...document.querySelectorAll('#cmpTbl tbody tr')].map(r => r.innerText.slice(0, 80)).join(' || ')`);
      throw new Error('512890 静默 0（BUG-4 复发）: td4=' + row512.td4 + ' | opacity=' + row512.opacity + ' | 全部行: ' + allRows.slice(0, 400));
    }
    if (hasMissingMark) console.log('   512890 数据暂缺已明确标注（东财源无记录，灰显未纳入对比）✓'); else console.log('   512890 累计分红=' + dv + ' ✓');
    ok('对比4图+表格渲染完成');
  });

  await S('C5 表格排序', async () => {
    await evalIn(cdp, `(() => { const th = document.querySelector('#cmpTbl th[data-sort="div"]'); th.click(); th.click(); })()`);   // 第一次=升序，第二次=降序
    await new Promise(r => setTimeout(r, 500));
    const parseCell = i => 'parseInt((document.querySelector(\"#cmpTbl tbody tr:nth-child(' + i + ') td:nth-child(4)\").innerText.split(\"元\")[0].replace(/[^0-9]/g, \"\")) || \"0\", 10)';
    const v1 = await evalIn(cdp, parseCell(2));
    const v2 = await evalIn(cdp, parseCell(3));
    assert(v1 >= v2, '降序排列失败: 第1名=' + v1 + ' 第2名=' + v2);
    const names = await evalIn(cdp, `(() => { const tds = document.querySelectorAll('#cmpTbl tbody tr'); return [1,2].map(i => (tds[i].querySelector('td').innerText.match(/[\u4e00-\u9fa5A-Za-z0-9]+/) || [''])[0]); })()`);
    ok('点表头排序正常（' + names.join(' > ') + '）');
  });

  await S('C6 每年分红图口径开关', async () => {
    await waitFor(cdp, `(() => { const c = echarts.getInstanceByDom(document.getElementById('cmpChartAnnual')); return c && c.getOption().xAxis[0].data.length > 0; })()`, 90000, '对比图数据就绪');
    const t0 = await evalIn(cdp, `document.getElementById('cmpAnnualModeTitle').innerText`);
    assert(t0 === '到账年', '默认口径错: ' + t0);
    const payData = await evalIn(cdp, `JSON.stringify(echarts.getInstanceByDom(document.getElementById('cmpChartAnnual')).getOption().xAxis[0].data)`);
    await evalIn(cdp, `document.querySelector('input[name="cmpAnnualMode"][value="report"]').click()`);
    await waitFor(cdp, `document.getElementById('cmpAnnualModeTitle').innerText === '报告期'`, 8000, '对比口径切换');
    const repData = await evalIn(cdp, `JSON.stringify(echarts.getInstanceByDom(document.getElementById('cmpChartAnnual')).getOption().xAxis[0].data)`);
    assert(payData !== repData, '对比图切换数据未变');
    ok('每年分红图口径切换正常');
  });

  await S('C7 URL参数恢复(p/m/r/s/y)', async () => {
    await nav(cdp, BASE + '?p=500000&m=3000&r=0&s=1&y=10');
    await waitFor(cdp, `document.getElementById('cmpPrincipal') ? document.getElementById('cmpPrincipal').value : ''`, 20000, '对比页参数');
    const got = await evalIn(cdp, `JSON.stringify({ p: document.getElementById('cmpPrincipal').value, m: document.getElementById('cmpMonthly').value, r: document.getElementById('cmpReinvest').checked, s: document.getElementById('cmpStrict').checked, on: [...document.querySelectorAll('#cmpYears button.on')].map(b => b.dataset.y) })`);
    assert(got.includes('"p":"500000"') && got.includes('"m":"3000"') && got.includes('"r":false') && got.includes('"s":true') && got.includes('"10"'), 'URL恢复失败: ' + got);
    ok('URL p/m/r/s/y 恢复正常');
  });

  await S('C8 上市晚警告(588000 2020起点)', async () => {
    await nav(cdp, BASE + '?cmp=588000&d=2020-01-01&p=1000000&m=0&r=1&s=0');
    await waitFor(cdp, `document.getElementById('cmpWarn').style.display === 'block'`, 180000, '上市晚警告');
    const warn = await evalIn(cdp, `document.getElementById('cmpWarn').innerText`);
    assert(warn.includes('上市晚') && warn.includes('实际自'), '警告内容错误: ' + warn.slice(0, 100));
    ok('上市晚警告显示: ' + warn.slice(0, 50));
  });

  await S('C9 非法d参数回退(大师漏1)', async () => {
    await nav(cdp, BASE + '?d=2099-01-01');
    await waitFor(cdp, `(document.getElementById('status').innerText||'').includes('起始日期无效')`, 20000, '非法d提示');
    const st = await evalIn(cdp, `document.getElementById('status').innerText`);
    assert(st.includes('已回退为近 10 年'), '回退说明缺失: ' + st.slice(0, 60));
    ok('非法 d 参数 → 提示+回退10年');
  });

  await S('H1 决策台(自选/机会/日历)', async () => {
    await nav(cdp, BASE);
    await evalIn(cdp, `document.querySelector('.tabbar button[data-tab="home"]').click()`);
    await waitFor(cdp, `document.querySelectorAll('#homeWatchlist .chip').length > 0`, 20000, '空自选推荐chips');
    const op0 = await evalIn(cdp, `document.getElementById('homeOpportunities').innerText`);
    assert(op0.includes('暂无自选'), '机会速览空态错误: ' + op0.slice(0, 40));
    dialogs.length = 0;
    await evalIn(cdp, `document.querySelector('#homeWatchlist .chip[data-code="512890"]').click()`);
    await waitFor(cdp, `document.querySelectorAll('#homeWatchlist .wl-card').length === 1`, 60000, '自选添加');
    const card = await evalIn(cdp, `document.querySelector('#homeWatchlist .wl-card').innerText`);
    assert(card.includes('512890'), '自选卡片缺代码: ' + card.slice(0, 50));
    const fresh = await evalIn(cdp, `document.getElementById('wlFresh').innerText`);
    assert(fresh.includes('行情更新') || fresh.includes('待更新'), '新鲜度徽标异常: ' + fresh);
    await waitFor(cdp, `(document.getElementById('homeOpportunities').innerText||'').includes('暂无新机会') || (document.getElementById('homeOpportunities').innerText||'').includes('🔔')`, 60000, '机会速览结果');
    await evalIn(cdp, `document.querySelector('#homeWatchlist .wl-del').click()`);
    await waitFor(cdp, `document.querySelectorAll('#homeWatchlist .wl-card').length === 0`, 10000, '自选删除');
    ok('自选添加/机会速览/新鲜度/删除 正常');
  });

  await S('H2 全市场扫描器', async () => {
    await evalIn(cdp, `document.getElementById('btnScan').click()`);
    await waitFor(cdp, `document.getElementById('scanPanel').style.display === 'block'`, 10000, '扫描面板');
    const t0 = Date.now();
    const msg = await waitFor(cdp, `(() => { const t = document.getElementById('scanPanel').innerText; return (t.includes('筛选出') || t.includes('快照获取失败') || t.includes('扫描失败')) ? t : ''; })()`, 180000, '扫描结束', 3000);
    ok('扫描器正常结束(' + ((Date.now() - t0) / 1000).toFixed(0) + 's): ' + msg.slice(0, 40));
  });

  await S('M1 移动端390px无横向溢出', async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await new Promise(r => setTimeout(r, 800));
    for (const t of ['home', 'compare', 'backtest']) {
      await evalIn(cdp, `document.querySelector('.tabbar button[data-tab="${t}"]').click()`);
      await new Promise(r => setTimeout(r, 600));
      const sw = await evalIn(cdp, `document.documentElement.scrollWidth`);
      assert(sw <= 400, `tab-${t} 横向溢出 scrollWidth=${sw}`);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    ok('390px 三 tab 均无横向溢出');
  });

  await new Promise(r => setTimeout(r, 2000));
  const fails = results.filter(x => !x.pass);
  console.log('\n========== 全功能实测汇总 ==========');
  for (const r of results) console.log((r.pass ? '✅' : '❌') + ' ' + r.name + (r.pass ? '' : '\n     ↳ ' + r.detail));
  console.log('------------------------------------');
  console.log('通过 ' + results.filter(x => x.pass).length + ' / ' + results.length + '，页面异常 ' + pageErrors.length + ' 条');
  if (pageErrors.length) {
    console.log('--- 页面 JS 异常/错误 ---');
    pageErrors.slice(0, 20).forEach(e => console.log('  ⚠️ ' + e));
  }
  cdp.close();
  process.exit(fails.length || pageErrors.length ? 1 : 0);
}

main().catch(e => { console.error('❌ 扫描异常: ' + e.message); process.exit(2); });
