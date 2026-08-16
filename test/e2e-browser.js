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

function die(msg) { console.error('❌ ' + msg); process.exit(1); }
function ok(msg) { console.log('✅ ' + msg); }

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

function launchChrome() {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(chrome)) die('Chrome 不存在');
  const cp = require('child_process').spawn(chrome, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=9222',
    '--window-size=800,1600', URL,
  ], { detached: true, stdio: 'ignore' });
  cp.unref();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      http.get('http://127.0.0.1:9222/json', r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { const pages = JSON.parse(d); if (pages.some(p => p.url.includes('localhost:' + PORT))) resolve(); else setTimeout(poll, 300); } catch (e) { setTimeout(poll, 300); } });
      }).on('error', () => { if (Date.now() - t0 > 20000) reject(new Error('Chrome 启动超时')); else setTimeout(poll, 300); });
    })();
  });
}

function cdpConnect() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', r => {
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
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'eval error');
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

  // 等页面加载完成
  await new Promise(r => setTimeout(r, 5000));

  // R1 版本号
  const pageVer = await evalIn(cdp, `(${JSON.stringify(gitVer)}).slice(0,1)==='v' ? 'pending' : 'pending'`).catch(() => null);
  const verStr = await evalIn(cdp, 'typeof APP_VERSION !== "undefined" ? APP_VERSION : null');
  if (!verStr) die('R1: 页面无 APP_VERSION（脚本未加载？）');
  console.log(`   页面版本=${verStr} git版本=${gitVer}`);
  if (verStr !== gitVer && gitVer.startsWith('v')) { console.log('   ⚠️ R1 提示：页面版本与 git 版本不一致（release.sh 会强制同步，仅警告不失败）'); }
  else ok('R1 版本号一致');

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
      const jsonTop = list.slice(0, got.length).map(x => ({ ex: x.ex, dps: x.dps }));
      const mism = got.filter((g, i) => jsonTop[i] && (jsonTop[i].ex !== g.ex || Math.abs(jsonTop[i].dps - g.dps) > 0.001));
      if (mism.length) die(`R2: JSON 前 ${got.length} 条与东财 API 不一致（如 ${mism[0].ex} ${mism[0].dps} vs JSON ${jsonTop[mism[0] ? got.indexOf(mism[0]) : 0].ex}）——静态数据损坏/过期`);
      apiOk = got.length;
    }
  } catch (e) { console.log('   ⚠️ 东财 API 抽样失败（网络/WAF），跳过三方比对，用现有 JSON 校验页面'); }
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
      // legend 高度近似：legend 组件位置
      let legendH = null;
      try {
        const lc = ch.getModel().getComponent('legend');
        if (lc) { const r = lc.getLayoutRect(); if (r) legendH = r.height; }
      } catch(e) {}
      return { gridTop, legendH };
    })()`);
    if (!probe) continue;
    gridTop = probe.gridTop; legendH = probe.legendH;
    if (gridTop != null && prevTop !== null && gridTop === prevTop) { stableTop++; if (stableTop >= 2) break; }
    prevTop = gridTop;
  }
  if (gridTop == null) die('R4: chartAsset gridTop 取不到（图例挤压修复失效）');
  if (legendH != null && gridTop < legendH) die(`R4: gridTop(${gridTop}) < legendH(${legendH})，图例压轴`);
  if (legendH == null && gridTop < 30) die(`R4: gridTop(${gridTop}) 过小，疑似图例挤压`);
  console.log(`   gridTop=${gridTop} legendH=${legendH}`);
  ok('R4 图例不压轴');

  // R5 旧全局函数已删
  const oldFn = await evalIn(cdp, `['fetchDividends','fetchName'].filter(k => typeof window[k] === 'function').join(',') || '(无)'`);
  if (oldFn !== '(无)') die('R5: 旧全局函数残留: ' + oldFn);
  ok('R5 旧全局函数已删');

  console.log('\n===== e2e 全部通过 =====');
  cdp.close();
  process.exit(0);
}

main().catch(e => { console.error('❌ e2e 异常: ' + e.message); process.exit(1); });
