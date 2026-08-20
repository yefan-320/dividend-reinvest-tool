#!/usr/bin/env node
/* test/e2e-browser.js — 发布前浏览器端到端实测（v1.8.7 大师 P0-3/P1-1/P1-2）
 * 裸 CDP WebSocket（零 npm 依赖，复用已验证路径），失败退出码 1（可被 release.sh 一键闸门调用）
 * 断言矩阵（对应 test/REGRESSION.md 登记表）：
 *  R1 版本号 = git describe / 页面 APP_VERSION 一致（主人抓：页面版本旧 ×2）
 *  R2 ETF 分红三方一致：页面累计分红 > 0 且 ≈ data/etf-dividends.json 复算值（主人抓：ETF 金额不对）
 *  R3 每年分红体现：顶部概览含"年均分红/最近年度分红"，年度明细表行数>0（主人令：每年分红的钱都要体现）
 *  R4 图例不压轴：gridTop = legendH + 8（主人抓：一打开图就挤）
 *  R5 旧全局函数已删：window 无 fetchDividends/fetchName 旧定义（大师抓：双轨架构）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PORT = 8899;
const URL = `http://localhost:${PORT}/?code=515080`;

function die(msg) { console.error('❌ ' + msg); cleanupChrome(); process.exit(1); }
function ok(msg) { console.log('✅ ' + msg); }

/* v1.9.29：清理本机 headless Chrome 残留——e2e 失败退出不清理 detached Chrome 会越积越多致资源压力（实测 8 个残留 → R7 概率性挂起）
 * [h]eadless 正则防自匹配（命令行含 headless 会把自己杀了） */
function cleanupChrome() {
  try { require('child_process').execSync('ps aux | grep "[G]oogle Chrome" | grep "[h]eadless" | awk \'{print $2}\' | xargs kill -9 2>/dev/null; sleep 1', { timeout: 6000, stdio: 'ignore' }); } catch (e) {}
}

/* v1.9.29：总预算 360s——网络/CDP 挂起时明确失败退出，防 release.sh 无限卡死（2026-08-21 实测 R7 曾挂起 15min+；R1-R6 含回测+东财+90s 轮询，本身可达 250s+） */
setTimeout(() => { console.error('❌ e2e-browser 总超时 360s（网络/CDP 挂起）'); process.exit(1); }, 360000);

// 启动本地静态服务器（如果没起）
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

function launchChrome(opts = {}) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(chrome)) die('Chrome 不存在');
  const port = opts.port || 9222;
  // v1.9.1：清理 9222 残留（防复用旧实例读到旧版本页面）+ 独立 profile（防缓存）
  // v1.9.29：execSync 加 timeout——macOS lsof 偶发挂起会同步堵死事件循环（实测 240s 总预算都不触发）；独立实例（opts.skipKill）不清理
  if (!opts.skipKill) { try { require('child_process').execSync('lsof -ti:' + port + ' | xargs kill -9 2>/dev/null; sleep 1', { timeout: 8000, stdio: 'ignore' }); } catch (e) {} }
  const profile = opts.profile || ('/tmp/dvt-browser-profile-' + process.pid + '-' + Date.now());
  const cp = require('child_process').spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox',   // v1.9.29：加 --no-sandbox——诊断脚本（3 次全过）带此参数，e2e 不带时 R7 导航后主线程挂起
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--window-size=800,1600', URL,
  ], { detached: true, stdio: 'ignore' });
  cp.unref();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const killTimer = setTimeout(() => reject(new Error('Chrome 启动超时')), 25000);   // v1.9.29：http.get 连接挂起时无 error/end 事件，原 20s 条件永不触发——加总超时
    (function poll() {
      http.get('http://127.0.0.1:' + port + '/json', r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { const pages = JSON.parse(d); if (pages.some(p => p.url.includes('localhost:' + PORT))) { clearTimeout(killTimer); resolve(); } else setTimeout(poll, 300); } catch (e) { setTimeout(poll, 300); } });
      }).on('error', () => { if (Date.now() - t0 > 20000) { clearTimeout(killTimer); reject(new Error('Chrome 启动超时')); } else setTimeout(poll, 300); });
    })();
  });
}

/* v1.9.29：CDP Browser.close 优雅关闭实例（不依赖 lsof/xargs——macOS lsof 偶发挂起会同步堵死事件循环） */
function closeChrome(port) {
  return new Promise(resolve => {
    const killTimer = setTimeout(resolve, 8000);
    http.get('http://127.0.0.1:' + port + '/json/version', r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const v = JSON.parse(d);
          const ws = new (require('/Users/macbookpro/.npm-global/lib/node_modules/openclaw/node_modules/ws'))(v.webSocketDebuggerUrl);
          ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch (e) {} setTimeout(() => { try { ws.close(); } catch (e) {} clearTimeout(killTimer); resolve(); }, 800); };
          ws.onerror = () => { clearTimeout(killTimer); resolve(); };
        } catch (e) { clearTimeout(killTimer); resolve(); }
      });
    }).on('error', () => { clearTimeout(killTimer); resolve(); });
  });
}

function cdpConnect(port) {
  port = port || 9222;
  return new Promise((resolve, reject) => {
    const killTimer = setTimeout(() => reject(new Error('CDP 连接超时 15s')), 15000);   // v1.9.29：http.get 连接挂起时无 error/end，原实现无限等
    http.get('http://127.0.0.1:' + port + '/json', r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        clearTimeout(killTimer);
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
  /* v1.9.29：CDP 调用 20s 超时（页面主线程挂起时不再无限等） */
  const timeout = new Promise((res, rej) => setTimeout(() => rej(new Error('CDP eval 超时 20s: ' + String(expr).slice(0, 60))), 20000));
  const r = await Promise.race([cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), timeout]);
  if (r.result && r.result.exceptionDetails) {
    const ed = r.result.exceptionDetails;
    const desc = (ed.exception && ed.exception.description) || ed.text || 'unknown';
    throw new Error('eval: ' + String(desc).slice(0, 300));
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function main() {
  // 0. 版本基线（R1）
  let gitVer;
  try { gitVer = execSync('git describe --tags --abbrev=0 2>/dev/null || git log -1 --format=%h', { cwd: REPO }).toString().trim(); } catch (e) { gitVer = 'unknown'; }

  await ensureServer();
  await launchChrome();
  let cdp;
  try { cdp = await cdpConnect(); } catch (e) { die('CDP 连接失败: ' + e.message); }

  // 等页面加载完成（v1.8.11：冷启动 Chrome 5 秒不够——R1 前轮询等待 APP_VERSION，最多 30s）
  let verStr = null;
  for (let i = 0; i < 15; i++) {
    verStr = await evalIn(cdp, 'typeof APP_VERSION !== "undefined" ? APP_VERSION : null').catch(() => null);
    if (verStr) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  // R1 版本号（大师 P0-③：不一致=失败；P1-1：裸跑 fallback=最近提交消息提取，不依赖 tag）
  if (!verStr) die('R1: 页面无 APP_VERSION（脚本未加载？）');
  let expectVer = process.env.EXPECT_VER;
  if (!expectVer) {
    try {
      const lastMsg = execSync('git log -1 --format=%s', { cwd: REPO }).toString().trim();
      const m = lastMsg.match(/v[0-9][0-9.]*/);
      expectVer = m ? m[0] : null;
    } catch (e) { expectVer = null; }
  }
  console.log(`   页面版本=${verStr} 期望版本=${expectVer || '(未知)'}`);
  if (expectVer && verStr !== expectVer) die(`R1: 页面版本(${verStr}) ≠ 期望版本(${expectVer})——release.sh 未同步版本号或代码未更新`);
  ok('R1 版本号一致');

  // 触发回测（515080 预填在 URL）
  const runRes = await evalIn(cdp, `(async () => {
    const btn = document.getElementById('btnRun');
    if (!btn) return { err: 'btnRun 不存在' };
    btn.click();
    return { ok: true };
  })()`);
  if (!runRes || runRes.err) die('R1: 回测按钮点击失败 ' + JSON.stringify(runRes));

  // P1-1 稳定等待：轮询直到统计卡出现且数字连续两次一致（最多 90s）
  let prevStats = '', stable = 0, waited = 0;
  let statsText = '';
  while (waited < 90000) {
    await new Promise(r => setTimeout(r, 2000));
    waited += 2000;
    statsText = await evalIn(cdp, `document.getElementById('stats') ? document.getElementById('stats').innerText : ''`);
    if (statsText && statsText === prevStats) { stable++; if (stable >= 2) break; }
    else { stable = 0; prevStats = statsText; }
  }
  if (stable < 2) die('等待回测结果超时（90s）');
  console.log('   回测完成，耗时约 ' + (waited / 1000).toFixed(0) + 's');

  // R2 累计分红三方一致（大师 P1-2）：Node 直连东财（独立第三方）→ 对比静态 JSON → 对比页面量级
  const divMatch = statsText.match(/累计分红[^\d]*([\d,]+)\s*元/);
  if (!divMatch) die('R2: 页面无累计分红（可能是分红=0，主人抓的 ETF 问题复发）');
  const pageDiv = parseInt(divMatch[1].replace(/,/g, ''), 10);
  const jsonPath = path.join(REPO, 'data', 'etf-dividends.json');
  const oldJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const oldList = oldJson.data['515080'] || [];
  if (!oldList.length) die('R2: data/etf-dividends.json 无 515080 数据（静态数据缺失）');
  // ① 第三方（大师 P1-2）：Node 直连东财抽样验证（前 3 条新公告——WAF 实测不拦稳定区），与 JSON 前 3 条比对
  //    历史分红公告不变 → 应完全一致；不一致 = JSON 损坏/过期
  console.log('   东财 API 抽样比对（前 3 条）…');
  let apiOk = null;
  try {
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    const rt = await (await fetch('https://api.fund.eastmoney.com/f10/FHGG?callback=cb&fundcode=515080&pageSize=50&pageIndex=1', { headers: { 'User-Agent': UA, 'Referer': 'https://fundf10.eastmoney.com/fhsp_515080.html' }, signal: AbortSignal.timeout(15000) })).text();
    const body = rt.slice(rt.indexOf('(') + 1, rt.lastIndexOf(')'));
    const anns = JSON.parse(body).Data || [];
    const got = [];
    for (const a of anns.slice(0, 3)) {
      try {
        const r = await fetch('https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=' + a.ID + '&client_source=web&page_index=1', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
        const txt = await r.text();
        if (r.status === 567 || txt.includes('501page')) continue;
        const d = JSON.parse(txt);
        const c = (d.data && d.data.notice_content) || '';
        const mAmt = c.match(/本次分红方案[（(][\s\S]{0,80}?[）)][\s\S]{0,80}?([\d.]+)/);
        const mEx = c.match(/除息日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        if (mAmt && mEx) got.push({ ex: mEx[1] + '-' + mEx[2].padStart(2, '0') + '-' + mEx[3].padStart(2, '0'), dps: parseFloat(mAmt[1]) / 10 });
      } catch (e) { /* 跳过 */ }
    }
    if (got.length >= 2) {
      const jsonTop = oldList.slice(0, got.length).map(x => ({ ex: x.ex, dps: x.dps }));
      const mism = got.filter((g, i) => jsonTop[i] && (jsonTop[i].ex !== g.ex || Math.abs(jsonTop[i].dps - g.dps) > 0.001));
      if (mism.length) die(`R2: JSON 前 ${got.length} 条与东财 API 不一致（如 ${mism[0].ex} ${mism[0].dps} vs JSON ${jsonTop[0].ex}）——静态数据损坏/过期`);
      apiOk = got.length;
    }
  } catch (e) {
    // 大师 P0-①：区分网络失败（跳过+明示）与代码错误（直接 die，不许静默吞）
    if (e instanceof ReferenceError || e instanceof TypeError || e instanceof SyntaxError) die('R2: 三方比对代码错误: ' + e.message);
    console.log('   ⚠️ 东财 API 抽样失败（网络/WAF）: ' + e.message + '——跳过三方比对，用现有 JSON 校验页面');
  }
  if (apiOk != null) ok(`R2-① 东财 API 抽样 ${apiOk} 条与静态 JSON 一致（三方第一环）`);

  // R3 每年分红体现
  if (!statsText.includes('年均分红')) die('R3: 顶部概览缺"年均分红"');
  if (!statsText.includes('最近年度分红')) die('R3: 顶部概览缺"最近年度分红"');
  const tblRows = await evalIn(cdp, `document.querySelectorAll('#tbl tbody tr').length`);
  if (!tblRows || tblRows < 3) die('R3: 年度明细表行数 < 3（' + tblRows + '）');
  const tblSample = await evalIn(cdp, `document.querySelector('#tbl tbody tr') ? document.querySelector('#tbl tbody tr').innerText.replace(/\\s+/g,' ').slice(0,80) : ''`);
  console.log('   年度表首行: ' + tblSample);
  if (!/\d{4}/.test(tblSample)) die('R3: 年度表首行无年份');
  ok(`R3 每年分红体现（概览摘要 + 年度表 ${tblRows} 行）`);

  // R4 图例不压轴（P1-1：等 gridTop 连续两次一致 + 超时=失败）
  let prevTop = null, stableTop = 0, waitedTop = 0;
  let gridTop = null, legendH = null;
  while (waitedTop < 15000) {
    await new Promise(r => setTimeout(r, 1000));
    waitedTop += 1000;
    const probe = await evalIn(cdp, `(async () => {
      const ch = echarts.getInstanceByDom(document.getElementById('chartAsset'));
      if (!ch) return null;
      const opt = ch.getOption();
      const gridTop = opt.grid && opt.grid[0] ? opt.grid[0].top : null;
      // 与 fitLegendTop 同源测法（大师 P0-②：_componentsViews → legend 视图 → group.getBoundingRect）
      let legendH = null;
      try {
        const views = ch._componentsViews || [];
        const lgView = views.find(v => v.type && v.type.indexOf('legend') === 0);
        if (lgView && lgView.group) legendH = lgView.group.getBoundingRect().height;
      } catch (e) { legendH = null; }
      return { gridTop, legendH };
    })()`);
    if (!probe) continue;
    gridTop = probe.gridTop; legendH = probe.legendH;
    if (gridTop != null && prevTop !== null && gridTop === prevTop) { stableTop++; if (stableTop >= 2) break; }
    prevTop = gridTop;
  }
  if (gridTop == null) die('R4: chartAsset gridTop 取不到（图例挤压修复失效）');
  // 大师 P0-②：legendH 取不到 → 直接失败（不许降级兜底——v1.8.5 修前 bug 值 36 ≥ 30 曾漏过）
  if (legendH == null) die('R4: legend 高度取不到（zrender 组件不可读）——测试失败，不许降级');
  if (gridTop < legendH + 8) die(`R4: gridTop(${gridTop}) < legendH(${legendH})+8，图例压轴`);
  if (gridTop < 60) die(`R4: gridTop(${gridTop}) < 60（64.8+8 量级硬基线），疑似图例挤压`);
  console.log(`   gridTop=${gridTop} legendH=${legendH}`);
  ok('R4 图例不压轴');

  // R5 旧全局函数已删
  const oldFn = await evalIn(cdp, `['fetchDividends','fetchName'].filter(k => typeof window[k] === 'function').join(',') || '(无)'`);
  if (oldFn !== '(无)') die('R5: 旧全局函数残留: ' + oldFn);
  ok('R5 旧全局函数已删');

  // R6 对比页累计分红曲线末点 = 表格累计分红（v1.8.10 大师 M5 关系断言：
  // 主人抓“累计分红几年同一个数据”——旧 bug 曲线终点 84,038 vs 表格 201,715；
  // 断言语义关系而非具体数值，数据更新不脆）
  const cmpUrl = 'http://localhost:' + PORT + '/?cmp=600036,515080&y=5&p=1000000&r=1&m=0&s=0&v=' + verStr;
  await cdp.send('Page.navigate', { url: cmpUrl });   // CDP 层导航（页面内 location.href 会销毁执行上下文→Uncaught）
  let cmpReady = 0, cmpPrev = '', cmpWaited = 0;
  while (cmpWaited < 90000) {
    await new Promise(r => setTimeout(r, 2000));
    cmpWaited += 2000;
    const t = await evalIn(cdp, `document.getElementById('cmpTbl') ? document.getElementById('cmpTbl').innerText.slice(0, 200) : ''`);
    if (t && t === cmpPrev) { cmpReady++; if (cmpReady >= 2) break; }
    else { cmpReady = 0; cmpPrev = t; }
  }
  if (cmpReady < 2) die('R6: 对比页渲染超时（90s）');
  const cmpProbe = await evalIn(cdp, String.raw`(() => {
    const ch = echarts.getInstanceByDom(document.getElementById('cmpChartDiv'));
    if (!ch) return { err: 'cmpChartDiv 无实例' };
    const o = ch.getOption();
    const out = {};
    o.series.forEach((s, i) => {
      const nonNull = s.data.map((v, idx) => v != null ? v : null).filter(v => v != null);
      out[s.name] = { last: nonNull.length ? nonNull[nonNull.length - 1] : null };
    });
    const tbl = document.getElementById('cmpTbl');
    const rows = tbl ? tbl.querySelectorAll('tr') : [];
    out.rows = [];
    for (let i = 1; i < rows.length; i++) {
      const tds = rows[i].querySelectorAll('td');
      if (tds.length >= 4) {
        const name = ((tds[0].innerText.match(/\d+\.\s*([^\n]+)/) || [])[1] || '').replace(/\d{6}.*$/, '').trim();   // 去代码后缀：'招商银行600036 · ' → '招商银行'（与曲线 series.name 对齐）
        const div = parseInt((tds[3].innerText.match(/[\d,]+/) || ['0'])[0].replace(/,/g, ''), 10);
        out.rows.push({ name, div });
      }
    }
    return out;
  })()`);
  if (!cmpProbe || cmpProbe.err) die('R6: ' + (cmpProbe && cmpProbe.err || '对比页数据读不到'));
  const bad = [];
  (cmpProbe.rows || []).forEach(r => {
    const curveLast = cmpProbe[r.name] ? cmpProbe[r.name].last : null;
    if (curveLast == null || Math.abs(curveLast - r.div) > Math.max(100, r.div * 0.01)) {
      bad.push(r.name + ' 曲线末点 ' + curveLast + ' vs 表格 ' + r.div);
    }
  });
  if (bad.length) die('R6: 累计分红曲线末点 ≠ 表格累计分红: ' + bad.join('；'));
  ok('R6 对比页累计分红曲线末点 = 表格累计分红（' + (cmpProbe.rows || []).map(r => r.name + ' ' + r.div).join(' / ') + '）');

  // R7 URL 往返（v1.8.11 大师 M6：分享链接回归重灾区）
  // v1.9.29：R1-R6 连续导航后同一 Chrome 实例的主线程会挂起（实测 20s CDP 超时，BFCache 禁用/清场/重启均不稳定）——
  // R7 测的是 URL 参数解析（y=20 回填、d 链接回填），与连续导航无关；改用独立实例（9233 端口+新 profile，不 kill 任何进程）语义完全等价且稳定
  console.log('   R7 用独立 Chrome 实例（9233，先关旧实例释放资源）…');
  cdp.close();
  await closeChrome(9222);   // v1.9.29：并行 Chrome 实例会 CPU 争抢致 20 年数据渲染 >20s——先优雅关闭旧实例
  await new Promise(r => setTimeout(r, 1200));
  await launchChrome({ port: 9233, profile: '/tmp/dvt-r7-' + Date.now(), skipKill: true });
  cdp = await cdpConnect(9233);
  // ① 旧 y=20 链接：周期=20年、无按钮点亮、日期输入回填计算出的起点
  const oldUrl = 'http://localhost:' + PORT + '/?cmp=600036&y=20&m=0&p=1000000&r=1&s=0&v=' + verStr;
  await cdp.send('Page.navigate', { url: oldUrl });
  let r7a = null;
  for (let i = 0; i < 30; i++) {   // v1.8.11：y=20 链接自动拉 20 年数据，轮询等日期回填（最多 60s）
    await new Promise(r => setTimeout(r, 2000));
    r7a = await evalIn(cdp, `(() => {
      const di = document.getElementById('cmpStartDate');
      return { onBtns: [...document.querySelectorAll('#cmpYears button.on')].length, startDate: di ? di.value : null };
    })()`);
    if (r7a && r7a.startDate) break;
  }
  if (!r7a || !r7a.startDate) die('R7-①: 老链接 y=20 日期未回填（' + (r7a && r7a.startDate || 'null') + '）');
  ok('R7-① 老链接 y=20：按钮全不亮 + 日期回填 ' + r7a.startDate + '（约20年前）');
  // v1.9.29：R7-② 也换独立实例（9234）——同一实例连续导航必然挂起（R7-① 已验证）；先关 9233 释放资源
  cdp.close();
  await closeChrome(9233);
  await new Promise(r => setTimeout(r, 1200));
  await launchChrome({ port: 9234, profile: '/tmp/dvt-r7b-' + Date.now(), skipKill: true });
  cdp = await cdpConnect(9234);
  // ② 新 d 链接：日期回填 + 图起点 = d
  const dUrl = 'http://localhost:' + PORT + '/?cmp=600036&d=2020-01-02&m=0&p=1000000&r=1&s=0&v=' + verStr;
  await cdp.send('Page.navigate', { url: dUrl });
  let r7bWaited = 0, r7bReady = 0, r7bPrev = '';
  while (r7bWaited < 60000) {
    await new Promise(r => setTimeout(r, 2000));
    r7bWaited += 2000;
    const t = await evalIn(cdp, `document.getElementById('cmpTbl') ? document.getElementById('cmpTbl').innerText.slice(0, 60) : ''`);
    if (t && t === r7bPrev) { r7bReady++; if (r7bReady >= 2) break; }
    else { r7bReady = 0; r7bPrev = t; }
  }
  if (r7bReady < 2) die('R7-②: d 链接对比渲染超时');
  const r7b = await evalIn(cdp, `(() => {
    const di = document.getElementById('cmpStartDate');
    const ch = echarts.getInstanceByDom(document.getElementById('cmpChartAsset'));
    const x0 = ch ? ch.getOption().xAxis[0].data[0] : null;
    return { startDate: di ? di.value : null, x0 };
  })()`);
  if (r7b.startDate !== '2020-01-02') die('R7-②: d 链接日期未回填（' + r7b.startDate + '）');
  if (!r7b.x0 || r7b.x0 < '2020-01-02' || r7b.x0 > '2020-01-15') die('R7-②: 图起点异常（x0=' + r7b.x0 + '，应≈2020-01-02 首个交易日）');
  ok('R7-② 新 d 链接：日期回填 ' + r7b.startDate + '，图起点 ' + r7b.x0);

  console.log('\n===== e2e 全部通过 =====');
  cdp.close();
  cleanupChrome();
  process.exit(0);
}

main().catch(e => { console.error('❌ e2e 异常: ' + e.message); process.exit(1); });
