/* ============================================================
 * data-layer.js — 红利工具数据层 v1.7.0
 * 统一管理：数据源接口 / IndexedDB 缓存 / 限流队列 / 失败回退 / 去重 / 口径 / watchlist
 * 设计出处：deliverables/红利工具完善/review-master-三轮-20260816.md（P1-20/P1-22）
 * 页面只调 getXxx() / watchlist.xxx()，不直接碰 fetch。
 * ============================================================ */
'use strict';
(function(){

/* ---------- 口径常量（防回归：BONUS_IT_RATIO 语义实测于 2026-08-16 三源抽样 13773 条） ---------- */
const CALIB = {
  // BONUS_IT_RATIO = 送转合计（每10股）；IT_RATIO = 转增部分（纯转增时相等、纯送股为 null）
  BONUS_IT_RATIO_IS_TOTAL: true,
  DIVIDEND_WINDOW_DAYS: 365,       // 股息率口径：近12个月已宣告分红
  CACHE_TTL: { kline: 86400000, snapshot: 900000, dividends: 86400000 },  // 1天 / 15分钟 / 1天
  THRESHOLDS: { divYield: 4, divYears: 3, marketCap: 50e8, excludeST: true },  // 扫描默认阈值（可调）
};

/* ---------- 工具函数 ---------- */
const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtPct = (n, d = 2) => (n == null ? '—' : (n * 100).toFixed(d) + '%');
/* 选择器规范（2026-08-16 大师 P2-31）：统一接受带/不带 #；新代码一律用原生 getElementById(id) 或 $('id')（不带 #），
 * 禁止再引入其他选择器风格（如 jQuery $ 语义、querySelector 混用）——$ bug 就是风格混用 9 轮未暴露的教训 */
const $ = id => document.getElementById(String(id).replace(/^#/, ''));
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

/* ---------- 限流队列（串行 + 间隔 + 重试指数退避；腾讯/东财时间窗口型限流应对 P2-19） ---------- */
class RateLimitedQueue {
  constructor(intervalMs = 300, maxRetry = 2) { this.interval = intervalMs; this.maxRetry = maxRetry; this.q = []; this.running = false; }
  push(fn) {
    return new Promise((resolve, reject) => {
      this.q.push({ fn, resolve, reject });
      if (!this.running) this._pump();
    });
  }
  async _pump() {
    this.running = true;
    while (this.q.length) {
      const { fn, resolve, reject } = this.q.shift();
      let lastErr;
      for (let attempt = 0; attempt <= this.maxRetry; attempt++) {
        if (attempt > 0) await sleep(Math.pow(2, attempt - 1) * 1000);   // 1s / 2s 退避
        try { resolve(await fn()); break; }
        catch (e) { lastErr = e; }
      }
      if (lastErr) reject(lastErr);
      if (this.q.length) await sleep(this.interval);
    }
    this.running = false;
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txQueue = new RateLimitedQueue(300, 2);   // 腾讯行情队列
const emQueue = new RateLimitedQueue(300, 2);   // 东财队列

/* ---------- JSONP / fetch（带超时，CORS 直连用 fetch） ---------- */
function jsonp(url, paramName, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const cb = 'cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    let done = false;
    const timer = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, timeout);
    // v1.9.5：cleanup 不再 delete 回调——东财限流时深分页响应可能 >15s 迟到，
    // 删掉回调后迟到响应执行未定义函数 → Uncaught ReferenceError 污染控制台（e2e-full 实测 2 条）
    // 改为替换为 no-op：迟到响应安全吞掉，防双回调（done 标志）
    function cleanup() { clearTimeout(timer); script.remove(); window[cb] = () => {}; }
    window[cb] = data => { if (done) return; done = true; cleanup(); resolve(data); };
    script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + paramName + '=' + cb;   // 2026-08-17：URL 无 query 时用 ?（曾写死 &，无 query 的 URL 会拼出裸 & 被拒）
    script.onerror = () => { if (done) return; done = true; cleanup(); reject(new Error('网络错误')); };
    document.head.appendChild(script);
  });
}
function fetchJson(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { signal: ctrl.signal }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).finally(() => clearTimeout(t));
}
function loadSinaKline(url, timeout = 15000) {
  // v1.7.4 修复：新浪 jsonp_v2.php 用 URL 中函数名做回调（如 var%20_sina_kline_ 或自定义名）
  // 原实现固定 var _sina_kline_ 返回 `var _sina_kline_([...])`（无等号）→ 语法错误 Unexpected token '('，
  // script.onerror 不触发（语法错误不触发 onerror）→ 静默失败。改用动态回调名 + 双保险（onerror + 超时）。
  return new Promise((resolve, reject) => {
    // 回调名白名单校验（大师 P4-补①：防注入）
    const cbName = 'sina_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    if (!/^[a-zA-Z_][\w]*$/.test(cbName)) return reject(new Error('非法回调名'));
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, timeout);
    let done = false;
    function cleanup() { clearTimeout(timer); script.remove(); try { delete window[cbName]; } catch (e) { window[cbName] = undefined; } }
    window[cbName] = data => { if (done) return; done = true; cleanup(); resolve(Array.isArray(data) ? data : []); };
    script.onload = () => { if (done) return; done = true; cleanup(); resolve([]); };   // 已回调则上面已 resolve；未回调(空数据)给空数组
    script.onerror = () => { if (done) return; done = true; cleanup(); reject(new Error('网络错误')); };
    script.src = url.replace('var%20_sina_kline_', encodeURIComponent(cbName));
    document.head.appendChild(script);
  });
}

/* ---------- IndexedDB 缓存（K线/分红/快照 分层 TTL） ---------- */
const DB_NAME = 'divtool-cache', DB_VER = 1, STORE = 'kv';
let _db = null;
/* openDB 带超时：IndexedDB 异常/挂起时降级为无缓存（缓存是优化不是依赖，2026-08-16 headless 实测发现） */
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('IndexedDB 超时')); } }, 5000);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => { if (done) return; done = true; clearTimeout(timer); _db = req.result; resolve(_db); };
    req.onerror = () => { if (done) return; done = true; clearTimeout(timer); reject(req.error); };
  });
}
async function cacheGet(key) {
  try { const db = await openDB(); return await Promise.race([
    new Promise((res, rej) => { const r = db.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); }),
    sleep(8000).then(() => { throw new Error('缓存读超时'); }),
  ]); }
  catch (e) { return null; }
}
async function cacheSet(key, val) {
  try { const db = await openDB(); await Promise.race([
    new Promise((res, rej) => { const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }),
    sleep(8000).then(() => { throw new Error('缓存写超时'); }),
  ]); }
  catch (e) { /* 缓存失败不影响主流程 */ }
}
async function cacheGetFresh(key, ttl) {
  const hit = await cacheGet(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttl) return null;   // 过期
  return hit;
}

/* ---------- 代码/市场映射 ---------- */
function parseSecInput(v) {
  // 2026-08-17 C2：显式后缀解析 000300.SH / 000001.SZ（大师裁决：程序不猜，歧义代码必须显式声明）
  const m = String(v || '').trim().match(/^(\d{6})\.(SH|SZ)$/i);
  return m ? { code: m[1], market: m[2].toLowerCase() } : { code: String(v || '').trim(), market: null };
}
function guessSec(code, market) {
  // 东财 secid: 沪 1.xxx / 深 0.xxx / 北 0.xxx(4/8/92开头)；腾讯: sh/sz/bj
  // 2026-08-16 修复：5开头=沪ETF(510/512/515/588)、1开头=深ETF(159xxx)、4/8/92=北交所
  // 2026-08-17 C2：market 显式指定（指数 000xxx.SH → sh000300）优先，避免指数被当深市股票
  if (market === 'sh') return { em: '1.' + code, tx: 'sh' + code };
  if (market === 'sz') return { em: '0.' + code, tx: 'sz' + code };
  if (/^6/.test(code)) return { em: '1.' + code, tx: 'sh' + code };
  if (/^5/.test(code)) return { em: '1.' + code, tx: 'sh' + code };   // 沪 ETF（512890 红利低波等）
  if (/^(0|3|1)/.test(code)) return { em: '0.' + code, tx: 'sz' + code };  // 深市 + 深ETF(159xxx)
  return { em: '0.' + code, tx: 'bj' + code };   // 北交所 4/8/92 开头
}
const emSecidOf = (code, market) => guessSec(code, market).em;
const txCodeOf = (code, market) => guessSec(code, market).tx;
/* push2 代码格式 sh600000 ↔ datacenter 600000 映射（P2-5） */
const toPush2 = code => guessSec(code).tx;
const toPlain = code => code.replace(/^(sh|sz|bj)/, '');

/* ---------- 股票名称 ---------- */
async function fetchName(code, market) {
  try {
    // ⚠️ 2026-08-16 修复：东财 suggest 的 JSONP 参数名是 cb（callback= 返回纯 JSON 不触发回调，曾致添加/搜索干等15秒超时）
    // 2026-08-17 C2：类型过滤（MktNum 字符串：'0'=股票 '1'=指数 '150'=基金）——显式 .SH 取指数，默认股票优先指数兜底
    const d = await jsonp('https://searchapi.eastmoney.com/api/suggest/get?input=' + code + '&type=14&count=5', 'cb');
    const list = d && d.QuotationCodeTable && d.QuotationCodeTable.Data || [];
    const hit = market === 'sh'
      ? (list.find(x => x.Code === code && x.MktNum === '1') || list.find(x => x.Code === code))
      : (list.find(x => x.Code === code && x.MktNum === '0') || list.find(x => x.Code === code && x.MktNum === '1') || list.find(x => x.Code === code));
    if (hit && hit.Name) return hit.Name;
  } catch (e) { /* 换备源 */ }
  try {
    const name = await loadSmartbox(code);
    if (name) return name;
  } catch (e) { }
  return code;
}
function loadSmartbox(code, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const t = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, timeout);
    function cleanup() { clearTimeout(t); script.remove(); }
    const old = window.v_hint;
    script.onload = () => {
      cleanup();
      const raw = window.v_hint || ''; window.v_hint = old;
      const parts = String(raw).split('~');
      resolve(parts.length >= 3 && parts[1] === code ? parts[2] : null);
    };
    script.onerror = () => { cleanup(); window.v_hint = old; reject(new Error('网络错误')); };
    script.src = 'https://smartbox.gtimg.cn/s3/?v=2&q=' + code + '&t=all';
    document.head.appendChild(script);
  });
}

/* ---------- 分红数据（datacenter，全市场/单股；去重：代码+报告期，优先实施状态 P1-6） ---------- */
const DIV_COLS = 'SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,PLAN_NOTICE_DATE,NOTICE_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,IT_RATIO,ASSIGN_PROGRESS,IMPL_PLAN_PROFILE,BASIC_EPS,TOTAL_SHARES';
function parseDivs(rows) {
  // ⚠️ 口径：BONUS_IT_RATIO=送转合计(每10股)，IT_RATIO=转增部分；bonus = BONUS_IT_RATIO/10（2026-08-16 实测，修复旧版翻倍 bug）
  return rows.map(r => ({
    code: r.SECURITY_CODE || '',
    report: (r.REPORT_DATE || '').slice(0, 10),
    ex: (r.EX_DIVIDEND_DATE || '').slice(0, 10),
    record: (r.EQUITY_RECORD_DATE || '').slice(0, 10),
    planNotice: (r.PLAN_NOTICE_DATE || '').slice(0, 10),
    notice: (r.NOTICE_DATE || '').slice(0, 10),
    dps: (parseFloat(r.PRETAX_BONUS_RMB) || 0) / 10,        // 元/股（PRETAX 为每10股）
    bonus: (parseFloat(r.BONUS_IT_RATIO) || 0) / 10,        // 每股送转合计（修复后口径）
    zhuanOnly: (parseFloat(r.IT_RATIO) || 0) / 10,          // 仅展示：每股转增部分
    progress: r.ASSIGN_PROGRESS || '',
    profile: r.IMPL_PLAN_PROFILE || '',
    eps: parseFloat(r.BASIC_EPS) || null,
    totalShares: parseFloat(r.TOTAL_SHARES) || null,
    name: r.SECURITY_NAME_ABBR || '',
  })).filter(x => (x.dps > 0 || x.bonus > 0));
}
function dedupDividends(list) {
  // 去重：代码+报告期（P1-6）→ 优先"实施分配"；预案记录（无除息日）保留但标记 pending
  const map = new Map();
  list.forEach(x => {
    const key = (x.code || '?') + '|' + (x.report || x.ex);   // ⚠️ 必须带 code！仅按报告期会误合并不同股票
    const score = (x.progress.includes('实施') ? 2 : 1) + (x.ex ? 1 : 0);
    const old = map.get(key);
    if (!old || score > old._score) { x._score = score; x._pending = !x.ex; map.set(key, x); }
  });
  return Array.from(map.values()).map(({ _score, _pending, ...x }) => ({ ...x, pending: _pending }));
}
async function fetchDividendsAll(fromDate) {
  // 全市场近 N 天分红（pageSize=500 实测生效，10 页拉完 4888 条）
  const filter = `(EX_DIVIDEND_DATE>='${fromDate}')`;
  const all = [];
  let pn = 1, pages = 1;
  do {
    const d = await emQueue.push(() => jsonp(
      `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${DIV_COLS}&pageNumber=${pn}&pageSize=500&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent(filter)}`, 'callback'));
    const rows = (d && d.result && d.result.data) || [];
    pages = (d && d.result && d.result.pages) || 1;
    all.push(...rows);
    pn++;
    if (pn > 40) break;   // 保险丝（v1.9.6：连分判定需 3 年数据，约 30 页）
  } while (pn <= pages);
  return dedupDividends(parseDivs(all));
}
async function fetchDividendsOne(code) {
  // 单股全历史分红（回测用，保留全部历史）
  // 2026-08-17 C1：ETF/基金代码（5xx 沪ETF/LOF、159/16x 深ETF/LOF）直接走基金公告源（股票接口无 ETF 数据）
  // v1.8.13 BUG-4：数据暂缺（获取失败）返回带 _missing 标记的空数组——调用方区分"暂缺≠0"
  if (/^(5|159|16)/.test(code)) {
    try {
      const r = await fetchEtfDividends(code);
      if (r == null) { const out = []; out._missing = true; return out; }
      return r;
    } catch (e) { const out = []; out._missing = true; return out; }
  }
  const filter = `(SECURITY_CODE="${code}")`;
  const d = await emQueue.push(() => jsonp(
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${DIV_COLS}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent(filter)}`, 'callback'));
  const rows = (d && d.result && d.result.data) || [];
  const out = dedupDividends(parseDivs(rows));
  cacheSet('dv:' + code, { ts: Date.now(), data: out });   // P2-30: 供除权日缓存失效检查
  return out;
}

/* ---------- ETF/基金分红（东财基金公告源，2026-08-17 C1 接入） ----------
 * 链路：FHGG 公告列表（JSONP 免 CORS）→ 公告正文（2026-08-17 实测：np-cnotice-stock/fund 在浏览器均被 CORS 拦→用 allorigins 代理兜底，直连保留给 Node/直连可用环境）→ 解析每10份金额+除息日
 * 缓存：dv:code 复用（TTL 1 天，符合大师"1请求/标的+缓存1天"限流策略）
 * 降级：任一步失败 → 返回 []（调用方显示"数据源暂缺"，不显示 0） */
function parseEtfAnnList(data) {
  // 兼容：jsonp 已解析对象 或 JSONP 文本（Node 测试用）
  let obj = data;
  if (typeof data === 'string') {
    const m = data.match(/^[\w.]*\(([\s\S]*)\)\s*;?\s*$/);
    obj = JSON.parse(m ? m[1] : data);
  }
  return ((obj && obj.Data) || []).map(a => ({
    id: a.ID || '', title: a.TITLE || a.ShortTitle || '', publish: (a.PUBLISHDATEDesc || a.PUBLISHDATE || '').slice(0, 10),
  })).filter(a => a.id);
}
function parseEtfAnnouncement(title, content) {
  // 正文解析：本次分红方案（单位：元/10 份基金份额）X + 除息日；报告期取公告标题年度
  const t = String(content || '');
  const mAmt = t.match(/本次分红方案[（(][\s\S]{0,80}?[）)][\s\S]{0,80}?([\d.]+)/);
  const mEx = t.match(/除息日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const mRec = t.match(/权益登记日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const mRep = String(title || '').match(/(\d{4})\s*年度/);
  if (!mAmt || !mEx) return null;
  const fmt = (m, i) => m[i].padStart(2, '0');
  return {
    code: '', report: (mRep ? mRep[1] : mEx[1]) + '-12-31',
    ex: mEx[1] + '-' + fmt(mEx, 2) + '-' + fmt(mEx, 3),
    record: mRec ? mRec[1] + '-' + fmt(mRec, 2) + '-' + fmt(mRec, 3) : '',
    planNotice: '', notice: String(title || '').slice(0, 10),
    dps: parseFloat(mAmt[1]) / 10,            // 每10份 → 每份（单位换算，大师验收项2）
    bonus: 0, zhuanOnly: 0, progress: '实施分配',
    profile: '每10份派' + mAmt[1] + '元',
    eps: null, totalShares: null, name: '', pending: false,
  };
}
async function fetchEtfAnnouncement(artCode) {
  // 2026-08-17：np-cnotice 在浏览器被 CORS 拦 → 直连失败走 allorigins 代理（实测：顺序/低并发+重试 成功率 5/6+，并发 4+ 触发限流）
  const direct = 'https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=' + artCode + '&client_source=web&page_index=1';
  for (let attempt = 0; attempt < 2; attempt++) {
    // ① 直连
    try {
      const d = await fetchJson(direct);
      if (d && d.data) return d;
    } catch (e) { /* 直连失败 → 代理 */ }
    // ② allorigins 代理
    try {
      const proxied = await fetchJson('https://api.allorigins.win/get?url=' + encodeURIComponent(direct));
      if (proxied && proxied.contents) {
        try { return JSON.parse(proxied.contents); } catch (e) { /* 解析失败重试 */ }
      }
    } catch (e) { /* 代理失败重试 */ }
    if (attempt === 0) await new Promise(r => setTimeout(r, 500));
  }
  return null;
}
async function fetchEtfDividends(code) {
  const cacheKey = 'dv:' + code;
  let jsonHad = false;   // v1.8.13 BUG-4：JSON 有该码（即使 0 条）= 权威"确实无分红"；JSON 无码且实时抓不到 = 数据暂缺
  // 2026-08-17：静态 JSON 优先（GitHub Actions/本机 cron 每日更新，同源零 CORS，最权威）——排在缓存前，避免旧缓存挡住新数据
  try {
    const stat = await fetchJson('data/etf-dividends.json');
    const list = stat && stat.data && stat.data[code];
    if (list && list.length) {
      const out = list.map(x => Object.assign({ code, pending: false, progress: '实施分配', planNotice: '', notice: '', bonus: 0, zhuanOnly: 0, eps: null, totalShares: null, name: '', report: x.ex.slice(0, 4) + '-12-31' }, x));
      try { await cacheSet(cacheKey, { ts: Date.now(), data: out }); } catch (e) { }
      return out;
    }
    if (list) jsonHad = true;   // JSON 有码但空记录：视为权威无分红（不再走实时）
  } catch (e) { /* 静态文件缺失（首次部署前）→ 走缓存/实时 */ }
  try {
    const hit = await cacheGetFresh(cacheKey, CALIB.CACHE_TTL.dividends);
    if (hit && hit.data && hit.data.length) return hit.data;
  } catch (e) { }
  const anns = parseEtfAnnList(await jsonp(
    'https://api.fund.eastmoney.com/f10/FHGG?fundcode=' + code + '&pageSize=50&pageIndex=1', 'callback'));   // 2026-08-17：URL 去掉 callback=?（jsonp 自动追加 &callback=cb_xxx；写死 ?= 会返回 ?(...) 无法解析→超时）
  // 2026-08-17 性能+稳定：并发 2 + 每条重试（并发 4 触发 allorigins 限流，实测 5/6 成功率需低并发）
  const out = [];
  const CONC = 2;
  for (let i = 0; i < anns.length; i += CONC) {
    const batch = anns.slice(i, i + CONC);
    const parsed = await Promise.all(batch.map(async a => {
      try {
        const d = await fetchEtfAnnouncement(a.id);   // 2026-08-17：直连+allorigins 代理双层（np-cnotice 在浏览器被 CORS 拦）
        const rec = parseEtfAnnouncement(a.title, d && d.data && d.data.notice_content);
        if (rec) { rec.code = code; rec.notice = a.publish || rec.notice; return rec; }
      } catch (e) { /* 单条失败跳过，保整体 */ }
      return null;
    }));
    parsed.forEach(r => { if (r) out.push(r); });
  }
  out.sort((x, y) => x.ex < y.ex ? 1 : -1);   // 与股票通道一致：除息日倒序
  if (out.length) { try { await cacheSet(cacheKey, { ts: Date.now(), data: out }); } catch (e) { } return out; }
  // v1.8.13 BUG-4：实时抓取结束仍 0 条 → JSON 权威=空数组（确实无分红）；JSON 无此码=数据暂缺（null）
  return jsonHad ? [] : null;
}

/* ---------- K线（腾讯主源分段 / 新浪备源；缓存走 IndexedDB） ---------- */
async function fetchKlineTx(txPrefix, start, end) {
  const map = {}; let cur = start; let guard = 0; let prevLast = null;
  while (cur < end && guard++ < 12) {
    const d0 = new Date(cur);
    const segEnd = new Date(Date.UTC(d0.getUTCFullYear() + 2, d0.getUTCMonth() + 6, d0.getUTCDate()));
    const endStr = segEnd > new Date(end) ? end : segEnd.toISOString().slice(0, 10);
    // v1.7.2: 必须用不复权(真实价)K线！回测模型自带分红复投，前复权价已折算分红 → 双重计算虚高
    // 实测：2016-08-16 真实价 18.31 vs qfq 4.419（差 4 倍）；qfq 导致持股/总资产/累计投入全部虚高
    const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + txPrefix + ',day,' + cur + ',' + endStr + ',800,';
    let rows = [];
    try {
      const d = await txQueue.push(() => fetchJson(url));
      const node = d && d.data && d.data[txPrefix];
      rows = (node && node.day) || [];
    } catch (e) { /* 尝试下一段 */ }
    if (!rows.length) {
      // v1.8.2 修复：上市晚的标的（515080 2019 上市），起点前段为空 → 跳过该段继续，不提前终止（曾致 10 年周期下无数据）
      const nd = new Date(segEnd); nd.setDate(nd.getDate() + 1);
      cur = nd.toISOString().slice(0, 10);
      continue;
    }
    rows.forEach(r => { map[r[0]] = parseFloat(r[2]); });
    const last = rows[rows.length - 1][0];
    if (last >= end) break;
    // v1.7.3: 区间末尾遇周末/节假日无交易时，同一 last 不再前进 → 提前终止（防重复请求耗限流配额）
    if (last === prevLast) break;
    prevLast = last;
    const nd = new Date(last); nd.setDate(nd.getDate() + 1);
    cur = nd.toISOString().slice(0, 10);
  }
  return map;
}
async function fetchKlineSina(txPrefix) {
  const map = {};
  const url = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_sina_kline_/CN_MarketDataService.getKLineData?symbol=' + txPrefix + '&scale=240&ma=no&datalen=1023';
  const d = await loadSinaKline(url);
  (Array.isArray(d) ? d : []).forEach(r => { map[r.day] = parseFloat(r.close); });
  return map;
}
async function getKline(code, start, end, market) {
  // 缓存键：code+start（端日期不参与键，避免同段多次拉）
  const key = 'kl:v2:' + code + ':' + (market || '') + ':' + start;   // v2: 不复权价（v1 是 qfq 前复权，双重计算 bug）；C2: market 入键防指数/股票同码串缓存
  // P2-30: 今日有除权（除息日=今天）→ 该代码 K 线缓存强制失效（qfq 序列当天重算）
  try {
    const today = todayStr();
    const divHit = await cacheGet('dv:' + code);
    if (divHit && divHit.data && divHit.data.some(d => d.ex === today)) {
      await cacheSet(key, null);   // 置空触发重拉
    }
  } catch (e) { }
  const hit = await cacheGetFresh(key, CALIB.CACHE_TTL.kline);
  if (hit) return hit.data;
  const g = guessSec(code, market);
  let m = {};
  try { m = await fetchKlineTx(g.tx, start, end); } catch (e) { }
  if (!Object.keys(m).length) { try { m = await fetchKlineSina(g.tx); } catch (e) { } }
  if (Object.keys(m).length) await cacheSet(key, { ts: Date.now(), data: m });
  return m;
}

/* ---------- 行情快照（腾讯 qt 批量实时行情，JSONP 免 CORS；TTL 15分钟） ---------- */
/* 字段：1名称 2代码 3现价 39PE 44流通市值(亿) 45总市值(亿) 46PB */
async function loadQtQuotes(codes, timeout = 15000) {
  // v1.7.1：fetch + TextDecoder('gbk')，替代 script 标签（消除跨域 Script error + 名称乱码）
  // qt.gtimg.cn CORS 实测支持 *（2026-08-16）
  const txList = codes.map(c => guessSec(c).tx).join(',');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch('https://qt.gtimg.cn/q=' + txList, { signal: ctrl.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const out = {};
    codes.forEach(c => {
      const m = text.match(new RegExp('v_' + guessSec(c).tx + '="([^"]*)"'));
      if (!m) return;
      const p = m[1].split('~');
      if (p.length > 46 && p[3] && p[3] !== '') {
        out[c] = {
          name: p[1] || '', price: parseFloat(p[3]),
          pe: parseFloat(p[39]) || null,
          floatCap: parseFloat(p[44]) ? parseFloat(p[44]) * 1e8 : null,
          marketCap: parseFloat(p[45]) ? parseFloat(p[45]) * 1e8 : null,
          pb: parseFloat(p[46]) || null,
        };
      }
    });
    return out;
  } finally { clearTimeout(t); }
}
async function getStockQuotes(codes) {
  // 批量行情（≤60只/次），缓存 15 分钟；空/全失败返回 {}
  if (!codes.length) return {};
  const key = 'qt:' + codes.join(',');
  const hit = await cacheGetFresh(key, CALIB.CACHE_TTL.snapshot);
  if (hit) return hit.data;
  let out = {};
  try { out = await txQueue.push(() => loadQtQuotes(codes)); } catch (e) { }
  if (Object.keys(out).length) await cacheSet(key, { ts: Date.now(), data: out });
  return out;
}

/* ---------- 全市场快照（仅扫描器用；push2delay CORS 实测可用；TTL 15分钟；防重入单例） ---------- */
const SNAP_FIELDS = 'f2,f3,f9,f12,f14,f20,f21,f23,f100';
async function fetchSnapshotPage(pn) {
  // 排除北交所 fs；pageSize=100；push2delay 实测支持 CORS（2026-08-16）
  const fs = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
  const url = `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=${SNAP_FIELDS}`;
  // v1.9.6 P0-10：clist 自动重试 2 次（1.5s 间隔，避瞬时限流）
  const doFetch = () => emQueue.push(() => fetchJson(url));
  for (let i = 0; ; i++) {
    try { return await doFetch(); } catch (e) {
      if (i >= 2) throw e;
      await sleep(1500);
    }
  }
}
let _snapPromise = null;
async function getMarketSnapshot() {
  // 全市场快照（缓存 15 分钟），返回 { code: {name,price,marketCap,pe,pb,industry} }；防重入：并发调用共享同一任务
  const key = 'snap:all';
  const hit = await cacheGetFresh(key, CALIB.CACHE_TTL.snapshot);
  if (hit) return hit.data;
  if (_snapPromise) return _snapPromise;
  _snapPromise = (async () => {
    const out = {};
    let pn = 1, total = Infinity;
    const meta = { total: 0, actual: 0 };   // v1.9.6 P0-4：完整性统计（扫描器据 warning）
    while ((pn - 1) * 100 < total && pn <= 70) {
      const d = await fetchSnapshotPage(pn);
      const diff = d && d.data && d.data.diff || [];
      total = (d && d.data && d.data.total) || total;
      diff.forEach(x => {
        out[x.f12] = {
          name: x.f14, price: x.f2, pct: x.f3, marketCap: x.f20, floatCap: x.f21,
          pe: x.f9, pb: x.f23, industry: x.f100,
        };
      });
      meta.total = total; meta.actual += diff.length;
      pn++;
    }
    out.__meta = meta;
    await cacheSet(key, { ts: Date.now(), data: out });
    return out;
  })();
  try { return await _snapPromise; } finally { _snapPromise = null; }
}

/* ---------- 指数/ETF K线（对比卡用；腾讯 qfq，指数/ETF 也走分段） ---------- */
const ETF_PRESETS = [
  { code: '512890', name: '红利低波ETF', type: 'etf' },
  { code: '515080', name: '红利ETF', type: 'etf' },
  { code: '510300', name: '沪深300ETF', type: 'etf' },
  { code: '510500', name: '中证500ETF', type: 'etf' },
  { code: '588000', name: '科创50ETF', type: 'etf' },
  { code: '159915', name: '创业板ETF', type: 'etf' },
  { code: '000922', name: '中证红利', type: 'index', market: 'sh' },   // C2: 指数显式市场，防被当深市股票
  { code: '000300', name: '沪深300', type: 'index', market: 'sh' },
];
async function getIndexKline(code, start, end) {
  // 东财指数K线（全量），缓存复用 getKline 同层
  const key = 'ix:' + code + ':' + start;
  const hit = await cacheGetFresh(key, CALIB.CACHE_TTL.kline);
  if (hit) return hit.data;
  const secid = /^9/.test(code) ? '2.' + code : '1.' + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=0&beg=   // v1.7.2: 不复权（fqt=1 前复权同样双重计算）${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}`;
  const d = await emQueue.push(() => fetchJson(url));
  const map = {};
  ((d && d.data && d.data.klines) || []).forEach(k => { const p = k.split(','); map[p[0]] = parseFloat(p[2]); });
  if (Object.keys(map).length) await cacheSet(key, { ts: Date.now(), data: map });
  return map;
}

/* ---------- watchlist（P1-22 写路径统一）
 * v1.7.1 修复：改用 localStorage（自选清单=小型结构化数据；IndexedDB 写入失败会静默失效，headless 实测暴露）；
 * IndexedDB 只保留给大缓存（K线/快照/分红） ---------- */
const WL_KEY = 'divtool_watchlist_v1';
const Watchlist = {
  list() {
    try { return JSON.parse(localStorage.getItem(WL_KEY) || '[]'); }
    catch (e) { return []; }
  },
  add(code, name, snapshot) {
    const list = this.list();
    if (!list.find(x => x.code === code)) {
      list.push({ code, name: name || code, addedAt: Date.now(), snapshot: snapshot || null });
      try { localStorage.setItem(WL_KEY, JSON.stringify(list)); } catch (e) { }
    }
    return list;
  },
  remove(code) {
    const next = this.list().filter(x => x.code !== code);
    try { localStorage.setItem(WL_KEY, JSON.stringify(next)); } catch (e) { }
    return next;
  },
  updateSnapshot(code, snapshot) {
    const list = this.list();
    const it = list.find(x => x.code === code);
    if (it) { it.snapshot = snapshot; try { localStorage.setItem(WL_KEY, JSON.stringify(list)); } catch (e) { } }
    return list;
  },
};

/* ---------- 股息率（v1.7.4 方案C：按报告期归组，最近2个报告年度平均，大师P7裁决） ---------- */
/* 口径：分红按报告期年份分组求和 → 取最近2个已派息报告年度 → 算术平均 → 年化每股分红 ÷ 现价
 * 解决 365天滚动窗口的硬伤（工行一年两派：2025-07 派息被窗口挤出 → 4.10% 低估；
 * 年末派息后窗口只剩 1 笔 → 2.2% 腰斩）。同口径跨公司可比。 */
function calcAnnualDivYield(divs, price) {
  if (!price || price <= 0) return null;
  const years = {};
  divs.forEach(d => {
    if (d.pending || !d.ex || !d.report) return;
    const y = d.report.slice(0, 4);
    if (!y) return;
    years[y] = (years[y] || 0) + d.dps;
  });
  const yearList = Object.keys(years).filter(y => years[y] > 0).sort().reverse();
  if (!yearList.length) return null;
  const recent = yearList.slice(0, 2);
  const sum = recent.reduce((s, y) => s + years[y], 0);
  const annualDps = sum / recent.length;
  return { annualDps, yieldPct: annualDps / price * 100, years: recent, count: recent.length };
}

/* ---------- v1.9.0 核心计算函数（22轮红利讨论落地） ---------- */

/* 报告期归组：按 REPORT_DATE 年份汇总每股分红（含中期+末期），返回 {year: dps} 排序升序 */
function calcReportYearDivs(divs) {
  const years = {};
  divs.forEach(d => {
    if (d.pending || !d.ex) return;
    const y = (d.report || d.ex).slice(0, 4);
    if (!y || !(d.dps > 0)) return;
    years[y] = (years[y] || 0) + d.dps;
  });
  return Object.keys(years).filter(y => years[y] > 0).sort();
}

/* 分红 CAGR（报告期归组）：近 N 年（默认3年）复合增长率。返回百分比小数（0.095=9.5%）或 null
 * 口径：首年/末年都用报告期归组；基数检查：首年 <0.1 元视为低基数，返回 null 防高基数假象（好想你案例） */
function calcDivCAGR(divs, yearsN) {
  const n = yearsN || 3;
  const ys = calcReportYearDivs(divs);
  if (ys.length < n + 1) return null;
  const firstY = ys[ys.length - 1 - n];
  const lastY = ys[ys.length - 1];
  const v0 = ys.reduce((s, y) => s + (y === firstY ? divs.filter(d => (d.report || d.ex).slice(0,4) === firstY && !d.pending && d.dps > 0).reduce((t,d)=>t+d.dps,0) : 0), 0);
  const v1 = ys.reduce((s, y) => s + (y === lastY ? divs.filter(d => (d.report || d.ex).slice(0,4) === lastY && !d.pending && d.dps > 0).reduce((t,d)=>t+d.dps,0) : 0), 0);
  if (!v0 || v0 < 0.1) return null;   // 低基数防假象
  return Math.pow(v1 / v0, 1 / n) - 1;
}

/* 除息锁定 TTM：除息日当天/次日用除息前 TTM（防 10.24% 假高点误触发）
 * v1.9.0-O1 修复：固定 365/366 天窗口会因派息日漂移+闰年漏掉上次派息（2021-07-13→2022-07-15 间隔 367 天）
 * 改为派息次数自适应：按最近派息间隔中位数估算一年应含几次，按次数取（天然容忍漂移） */
const _ttmCache = new WeakMap();   // 按 divs 数组引用缓存（不同标的互不串）
/* Q3（M30）：mode 感知的 TTM 口径——B=财年归组（主）、A=366天滚动（兜底，过渡期标注用）
 * 返回 { v, mode }；ttmDivsAt 只取 v（保持既有 API 兼容） */
function ttmDivsAtMode(divs, dateStr) {
  let c = _ttmCache.get(divs);
  if (!c) {
    const sorted = divs.filter(d => d.ex && d.dps > 0).sort((a, b) => a.ex < b.ex ? -1 : 1);
    const byRepYear = {};
    divs.forEach(d => {
      if (!d.report || d.pending || !(d.dps > 0)) return;
      const y = d.report.slice(0, 4);
      if (!byRepYear[y]) byRepYear[y] = { sum: 0, hasAnnual: false };
      byRepYear[y].sum += d.dps;
      if (/-12-31$/.test(d.report)) byRepYear[y].hasAnnual = true;
    });
    c = { sorted, byRepYear };
    _ttmCache.set(divs, c);
  }
  const yearNow = parseInt(dateStr.slice(0, 4), 10);
  const completeYears = Object.keys(c.byRepYear).map(Number)
    .filter(y => c.byRepYear[y].hasAnnual && y < yearNow)
    .sort((a, b) => b - a);
  if (completeYears.length) {
    const bVal = c.byRepYear[completeYears[0]].sum;
    if (bVal > 0) return { v: bVal, mode: 'B' };
  }
  const sorted = c.sorted;
  if (!sorted.length) return { v: 0, mode: 'A' };
  const loDate = shiftDate(dateStr, -366);
  let lo = 0, hi = sorted.length - 1, right = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid].ex < dateStr) { right = mid; lo = mid + 1; } else hi = mid - 1; }
  if (right < 0) return { v: 0, mode: 'A' };
  lo = 0; hi = right; let leftBefore = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid].ex < loDate) { leftBefore = mid; lo = mid + 1; } else hi = mid - 1; }
  let sum = 0;
  for (let i = right; i > leftBefore; i--) sum += sorted[i].dps;
  if (sum > 0) return { v: sum, mode: 'A' };
  return { v: leftBefore >= 0 ? sorted[leftBefore].dps : 0, mode: 'A' };
}
function ttmDivsAt(divs, dateStr) {
  // P0-A v1.9.7（2026-08-18）：B主（财年归组）+ A兜底（366天滚动窗口）
  // 问题（回源实锤）：366 天窗口在一年两派过渡期混入“2024末期+2025中期”=1.5 个财年
  //   → 招行 3.013/36.76=8.20% 虚高、分位 100% 是失真产物（钱没变，纯拆分式两派）
  // B 口径（主）：最近完整财年归属分红合计（按 REPORT_DATE 归属财年）
  //   ——“最近完整财年”= 有年报(-12-31)报告记录、且财年 < dateStr 年份的最近一年
  //   —— 计入锚（Q1/Q2 确认）：有除息日（pending=false）——A 股实施公告即定除息日，
  //      与 M2 定案“实施公告日”数据等价；预案记录（无除息日、金额可能被股东大会改）不计入
  //   —— 年度分红水平代表值：拆派/频率突变天然稳定，不混跨财年；除息日无跳变
  //   —— 验证：招行 2026-06-24 B=2.016→5.48%；6-24 与 7-10 无跳变（大师免检）
  // A 口径（兜底）：366 天滚动窗口（v1.9.5 逻辑，B 不可用时回退）
  return ttmDivsAtMode(divs, dateStr).v;
}
function calcLockedTTM(divs) {
  const exDates = divs.filter(d => d.ex && d.dps > 0).map(d => d.ex).sort();
  const map = {};
  exDates.forEach(ex => {
    // 除息前 TTM（不含当天）
    const ttm = ttmDivsAt(divs, ex);
    map[ex] = { lockedDps: ttm, exDate: ex };
    // 次日也算锁定（市场未完全消化）
    const next = shiftDate(ex, 1);
    map[next] = { lockedDps: ttm, exDate: ex };
  });
  return map;
}
function shiftDate(dateStr, days) {
  // 本地时区组件构造，避免 UTC 偏移（曾致 +1 天被 -8h 抵消成同日，除息次日锁定失效）
  const p = dateStr.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* 滚动分位（默认 375 天窗口，无未来函数）：
 * v1.9.3（R6-R9 窗口讨论）：默认 500→375——40 只实证 250-500 差异小（6pp），375 均衡+覆盖 A 股中级调整中段（100-800 天）；
 * 预设 250（深熊灵敏型）/375（默认）/500（极简型）可切换。
 * 输入 kline（{date: price}，升序）, divs（已 parse）
 * 返回 [{d, dy(股息率%·滚动366天TTM), pct(滚动分位 0-100)}]
 * 口径：TTM 滚动 366 天分红 ÷ 当日价（366 覆盖闰年；除息日/次日锁定除息前 TTM）；
 * v1.9.5：去平滑（真实值直算，无未来函数）；滚动窗口=近 375 交易日；样本<250 天 pct=null */
const DEFAULT_WINDOW_DAYS = 375;
const WINDOW_PRESETS = [250, 375, 500];
function calcRollingPercentile(kline, divs, windowDays) {
  const win = windowDays || DEFAULT_WINDOW_DAYS;
  const dates = Object.keys(kline).sort();
  if (!dates.length) return [];
  // 除息锁定表
  const locked = calcLockedTTM(divs);
  // TTM 序列
  const series = [];
  dates.forEach(d => {
    const price = kline[d];
    if (!(price > 0)) return;
    let ttm = 0;
    if (locked[d]) {
      ttm = locked[d].lockedDps;   // 除息日/次日锁定：用除息前 TTM
    } else {
      ttm = ttmDivsAt(divs, d);
    }
    if (ttm > 0) series.push({ d, dy: ttm / price * 100 });
  });
  // v1.9.5：去掉 5 日均线平滑（大师 A- 裁决）——居中 MA 用未来数据（i±2）违反"无未来函数"声明；
  // 平滑值≠真实值会误导（主人点名"为什么是平滑的"）；除息锁定已覆盖跳空，平滑多余。分位直接用真实值。
  // 滚动分位
  for (let i = 0; i < series.length; i++) {
    if (i < 250) { series[i].pct = null; continue; }
    const lo = Math.max(0, i - win + 1);
    const window = series.slice(lo, i + 1).map(x => x.dy);
    const sorted = window.slice().sort((a, b) => a - b);
    const less = sorted.filter(v => v <= series[i].dy).length;
    series[i].pct = less / window.length * 100;
  }
  return series;
}

/* v1.9.3：分红趋势（报告期归组）——连续下降年数 + 是否恶化（连续>=2年）
 * 输入 divs（已 parse，含 report 字段）；复用 calcReportYearDivs 报告期归组口径（R14 修正：相邻除息对比会混入中期/特别分红假下降，必须报告期归组）
 * 返回 { seq: [{year, dps}], decStreak: 连续下降年数, degraded: 是否恶化, last3: 近3年变化% } 或 null（样本不足） */
function calcDivTrend(divs) {
  const years = calcReportYearDivs(divs);
  if (!years || years.length < 3) return null;
  const seq = years.map(y => ({ year: +y, dps: divs.filter(d => (d.report || d.ex).slice(0, 4) === y && !d.pending && d.dps > 0).reduce((t, d) => t + d.dps, 0) }));
  let decStreak = 0;
  for (let i = seq.length - 1; i > 0; i--) {
    if (seq[i].dps < seq[i - 1].dps - 0.001) decStreak++;
    else break;
  }
  const last = seq[seq.length - 1].dps;
  const y3 = seq.length >= 4 ? seq[seq.length - 4].dps : null;
  const last3 = y3 != null && y3 > 0.1 ? (last - y3) / y3 * 100 : null;
  return { seq, decStreak, degraded: decStreak >= 2, last3 };
}

/* v1.9.3：档位五态分类（R9-R14 研究固化表 + 默认保守）
 * 判定源统一（大师 R15 隐藏1：四态标签+钝化标注必须同一函数产出，防判定漂移）
 * 分类：
 *   wait90  可等90（年化等待收益>20pp/年）——等更极端划算
 *   direct  80直接买（年化<10pp/年 或 默认保守）——等90不值
 *   neutral 中性（10-20pp/年）——展示数据自决
 *   trap    分红陷阱（报告期归组连续2年下降=分红恶化）——全档位降权回避
 *   dull    低估值钝化（分红健康但90档收益差/价格长期不修复）——80建仓持有等均值回归
 * 返回 { cls, label, detail }；不在表内=direct（与工具现状保守一致） */
const TIER_CLASS_TABLE = {
  // 可等90（13）：年化等待收益>20pp/年（40只实证 R12）——格式 [cls, 年化pp/年, 间隔天, 90-80收益差pp]
  '600036': ['wait90', 59.2, 206, 33.4], '601398': ['wait90', 33.1, 196, 17.8], '601988': ['wait90', 44.5, 147, 17.9], '000001': ['wait90', 80.7, 177, 39.1],
  '600519': ['wait90', 96.4, 202, 53.4], '000858': ['wait90', 49.3, 278, 37.6], '601318': ['wait90', 112.3, 155, 47.7], '601899': ['wait90', 55.5, 228, 34.7],
  '601668': ['wait90', 39.8, 131, 14.3], '600104': ['wait90', 35.4, 285, 27.6], '600019': ['wait90', 29.8, 235, 19.2], '600887': ['wait90', 26.6, 183, 13.3], '600031': ['wait90', 111.2, 261, 79.5],
  // 中性（6）：10-20pp/年，展示数字自决
  '600016': ['neutral', 16.8, 227, 10.5], '000651': ['neutral', 16.4, 356, 16.0], '601166': ['neutral', 15.8, 227, 9.8], '601006': ['neutral', 15.6, 239, 10.2], '601288': ['neutral', 12.1, 130, 4.3], '600690': ['neutral', 10.0, 205, 5.6],
  // 直接买（9）：<10pp/年 或负值
  '601628': ['direct', 9.8, 295, 7.9], '600900': ['direct', 9.6, 528, 13.9], '601088': ['direct', 5.5, 143, 2.1], '601328': ['direct', 4.5, 137, 1.7],
  '601600': ['direct', 3.0, 160, 1.3], '601857': ['direct', 1.9, 187, 1.0], '000895': ['direct', 1.6, 285, 1.3], '600009': ['direct', 0.0, 211, 0.0], '000333': ['direct', -2.3, 348, -2.2],
  // 分红陷阱（6）：报告期归组连续2年下降（R14 修正后真名单：周期行业）
  '600188': ['trap'], '600585': ['trap'], '601225': ['trap'], '600028': ['trap'], '601390': ['trap'], '601111': ['trap'],
  // 低估值钝化（6）：分红健康但90档收益差（R14 误报纠正后）
  '601601': ['dull'], '600795': ['dull'], '000100': ['dull'], '601985': ['dull'], '600027': ['dull'], '600886': ['dull'],
};
const TIER_CLASS_LABEL = {
  wait90: { label: '可等90', color: '#3aa76d', detail: '历史等90档平均7个月、10年收益+18~22pp——可等更极端（年化等待收益>20pp/年）' },
  direct: { label: '80直接买', color: '#8fa69c', detail: '历史等90档年化收益<10pp/年或数据不足——80档即买，等90不值' },
  neutral: { label: '中性', color: '#5aa9e6', detail: '等90档年化收益10-20pp/年——按自身风险偏好自决（数字见详情）' },
  trap: { label: '⚠分红陷阱', color: '#e05a5a', detail: '分红连续2年下降（报告期归组）——高股息率分位=分红下调信号，全档位降权，建议回避/小仓' },
  dull: { label: '低估值钝化', color: '#d9a45b', detail: '分红健康但90档后价格长期不修复——等90意义小，80档建仓长期持有等均值回归' },
};
function classifyTier(code) {
  const row = TIER_CLASS_TABLE[code];
  const cls = row ? row[0] : 'direct';
  const base = TIER_CLASS_LABEL[cls];
  const profile = row && row.length > 1 ? { annual: row[1], gap90: row[2], diff: row[3] } : null;
  return { cls, ...base, profile };
}

/* v1.9.3：未来分红到账预测（已宣告 + 上年同期估计）
 * 输入 divs（已 parse）, holdings { code: shares }, todayStr 'YYYY-MM-DD', monthsN（默认12）
 * 返回 [{ month:'YYYY-MM', total, items:[{ code, name, ex, dps, shares, est(是否估计) }] }] 按月份升序
 * 已宣告（ex>=today）直接计入；未宣告用上年同期除息日+365 天估计（est=true，标“估”） */
function calcFutureCashflow(divs, holdings, todayStr, monthsN) {
  const months = monthsN || 12;
  const today = new Date(todayStr + 'T00:00:00');
  const horizon = new Date(today.getTime() + months * 30.4 * 86400000);
  const byMonth = {};
  const push = (m, item) => { if (!byMonth[m]) byMonth[m] = []; byMonth[m].push(item); };
  divs.forEach(d => {
    if (d.pending || !(d.dps > 0) || !d.ex) return;
    const code = d.code;
    const shares = (holdings && holdings[code]) || 0;
    const exD = new Date(d.ex + 'T00:00:00');
    if (exD >= today && exD <= horizon) {
      push(d.ex.slice(0, 7), { code, name: d.name, ex: d.ex, dps: d.dps, shares, est: false });
    }
  });
  // 估计未宣告：去年对应除息（ex 在今天之后 11 个月内且今年无对应宣告）——用“上年同月”近似
  const declaredMonths = {};
  Object.keys(byMonth).forEach(m => { declaredMonths[m] = true; });
  divs.forEach(d => {
    if (d.pending || !(d.dps > 0) || !d.ex) return;
    const exY = new Date(d.ex + 'T00:00:00');
    const estEx = new Date(exY.getTime() + 365 * 86400000);
    if (estEx <= today || estEx > horizon) return;
    // 若该 code 已有宣告落在同年份估计月附近（±1月），跳过防重复
    const m = estEx.toISOString().slice(0, 7);
    const code = d.code;
    const shares = (holdings && holdings[code]) || 0;
    const dup = (byMonth[m] || []).some(x => x.code === code && !x.est);
    if (dup) return;
    push(m, { code, name: d.name, ex: estEx.toISOString().slice(0, 10), dps: d.dps, shares, est: true });
  });
  const out = Object.keys(byMonth).sort().map(m => {
    const items = byMonth[m].sort((a, b) => a.ex < b.ex ? -1 : 1);
    const total = items.reduce((s, x) => s + x.dps * x.shares, 0);
    return { month: m, total, items };
  });
  return out;
}

/* 建仓区判定（v1.9.1 柔性模式 + 生态起建线偏移）
 * 输入 pct（当前滚动分位）, opts { mode: 'conservative'|'flexible', ecoStart: 起建线 }
 * 保守档：起建线 s / s+5 / s+10 → 各 1/3；95+ 已加满（可自决追加）
 * 柔性档：起建线 s / s+10 / s+20 → 20%/40%/60%；95+ → 80% 封顶（留 20% 现金）
 * 生态起建线（P0.5/P1）：低波 70 / 中波 80（默认）/ 高波 85 / 阴跌 85
 * 只进不退：触发过的档位由调用方维护（position 状态），回落不撤；本函数给“当前档+下一档” */
function computeZone(pct, opts) {
  opts = opts || {};
  const mode = opts.mode === 'flexible' ? 'flexible' : 'conservative';
  const s = opts.ecoStart || 80;   // 生态起建线（默认中波 80）
  if (pct == null) return { zone: 'nodata', label: '数据不足', action: '', mode, pct, currentTier: null, nextTier: null };
  // 档位表（95+ 极值统一收尾）
  const tiers = [];
  if (mode === 'flexible') {
    [0, 1, 2].forEach(i => { const t = s + i * 10; if (t < 95) tiers.push({ pct: t, pos: (i + 1) * 20, key: i === 0 ? 'start' : (i === 1 ? 'add' : 'full') }); });
    tiers.push({ pct: 95, pos: 80, key: 'full' });
  } else {
    [0, 1, 2].forEach(i => { const t = s + i * 5; if (t < 95) tiers.push({ pct: t, pos: Math.round(100 / 3 * (i + 1)), key: i === 0 ? 'start' : (i === 1 ? 'add' : 'full') }); });
    tiers.push({ pct: 95, pos: 100, key: 'full' });
  }
  // 95+ 极值（两模式统一文案：剩余 20% 可自决追加-不建议）
  if (pct >= 95) {
    const posTxt = mode === 'flexible' ? '80%（封顶）' : '已加满';
    return { zone: 'extreme', label: '95+ 极值确认', action: '当前仓位 ' + posTxt + ' · 历史 95+ 分位 3 年胜率 97/133 · 剩余 20% 现金可自决追加（不建议常规操作）', mode, pct, currentTier: tiers[tiers.length - 1], nextTier: null };
  }
  // 已触发档（当前分位 ≥ 档位线的最高档）
  let current = null;
  for (const t of tiers) { if (pct >= t.pct) current = t; }
  if (current) {
    const next = tiers.find(t => t.pct > current.pct) || null;
    return { zone: current.key, label: '已触发 ' + current.pct + ' 分位档', action: '已建 ' + current.pos + '% 仓位' + (next ? '，距下一档（' + next.pct + ' 分位）差 ' + (next.pct - pct).toFixed(0) : '（已达上限）'), mode, pct, currentTier: current, nextTier: next };
  }
  // 未触发
  const gap = s - pct;
  if (gap <= 5) {
    return { zone: 'watch', label: '距 ' + s + ' 起建线差 ' + gap.toFixed(0), action: '接近建仓区，可提前观察', mode, pct, currentTier: null, nextTier: tiers[0] };
  }
  return {
    zone: 'wait',
    label: mode === 'flexible' ? '距 ' + s + ' 分位建仓线差 ' + gap.toFixed(0) + '，可提前观察' : '未触发建仓线（' + s + ' 分位）',
    action: mode === 'flexible' ? '柔性模式：分位未到，继续等待' : '空仓者等待或切换柔性模式，持有者继续收息',
    mode, pct, currentTier: null, nextTier: tiers[0]
  };
}

/* 生态类型判定（P0.5，组合框架）：
 * 输入 kline（{date:price}）+ 滚动分位序列 series（calcRollingPercentile 输出）
 * 返回 'low'低波动 | 'mid'中波动 | 'high'高波动 | 'declining'阴跌
 * 规则：先判阴跌（250日线下方 + 当前分位≥75 且高位持续≥60天），再判波动（近5年最大回撤 <-35% 高 / <-25% 中 / ≥-25% 低）
 * 阴跌优先；生态起建线映射：low 70 / mid 80 / high 85 / declining 85 */
function calcEcoType(kline, series) {
  const ECO_START = { low: 70, mid: 80, high: 85, declining: 85 };
  const dates = Object.keys(kline).sort();
  if (!dates.length) return { type: 'mid', ecoStart: 80 };
  // 近5年最大回撤（限近 1250 交易日）
  const win = dates.slice(-1250);
  let peak = -Infinity, mdd = 0;
  win.forEach(d => { const p = kline[d]; if (!(p > 0)) return; if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > mdd) mdd = dd; });
  // 当前分位 + 高位持续天数
  const last = series.filter(x => x.pct != null).pop();
  const curPct = last ? last.pct : null;
  let highDays = 0;
  if (curPct != null && curPct >= 75) {
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].pct != null && series[i].pct >= 75) highDays++;
      else break;
    }
  }
  // 250 日线：当前价 vs 250 日均价
  const lastPrice = kline[dates[dates.length - 1]];
  const ma250 = win.length >= 250 ? win.slice(-250).reduce((s, d) => s + kline[d], 0) / 250 : null;
  const belowMa = ma250 != null && lastPrice < ma250;
  const declining = belowMa && curPct != null && curPct >= 75 && highDays >= 60;
  if (declining) return { type: 'declining', ecoStart: ECO_START.declining };
  const ddPct = mdd * 100;   // mdd 为正数（如 50 = 回撤 50%），阈值用正数比较
  let type = 'mid';
  if (ddPct > 35) type = 'high';
  else if (ddPct <= 25) type = 'low';
  return { type, ecoStart: ECO_START[type] };
}

/* 分位独立事件（轻量组合参考用）：
 * 输入 series（calcRollingPercentile 输出，升序），tierPct（档位阈值）
 * 返回 [{ start, end }]：分位 ≥ 阈值的连续区间第一日（独立低估事件，沿用 48/48 口径） */
function findZoneEvents(series, tierPct) {
  const events = [];
  let inZone = false, start = null;
  for (const x of series) {
    if (x.pct == null) continue;
    if (x.pct >= tierPct) {
      if (!inZone) { inZone = true; start = x.d; }
    } else {
      if (inZone) { events.push({ start, end: x.d }); inZone = false; start = null; }
    }
  }
  if (inZone) events.push({ start, end: series[series.length - 1].d });
  return events;
}

/* v1.9.2 组合级回测引擎（纯函数，可单测）：
 * 输入 pool = [{ code, name, series, kline, divs }]，opts = { years }
 * 策略：闭眼全仓 / 保守金字塔(80/85/90各1/3) / 柔性金字塔(70/80/90/95→20/40/60/80%) / 等90分位
 * 买入规则：档位独立事件首日买入该档份额（findZoneEvents）；收益=价格+期间分红÷买入价；组合=标的等权
 * 输出：每策略 { key, name, desc, ret(总收益%), annual(年化%), mdd(最大回撤%), winRate(事件胜率-买后1年正收益比例), events } */
function calcPortfolioBacktest(pool, opts) {
  opts = opts || {};
  const strategies = [
    { key: 'lump', name: '闭眼全仓', desc: '期初一次买入持有', tiers: null },
    { key: 'consv', name: '保守金字塔', desc: '80/85/90 分位各 1/3', tiers: [{ pct: 80, frac: 1 / 3 }, { pct: 85, frac: 1 / 3 }, { pct: 90, frac: 1 / 3 }] },
    { key: 'flex', name: '柔性金字塔', desc: '70/80/90/95 → 20/40/60/80%', tiers: [{ pct: 70, frac: 0.2 }, { pct: 80, frac: 0.2 }, { pct: 90, frac: 0.2 }, { pct: 95, frac: 0.2 }] },
    { key: 'wait90', name: '等 90 分位', desc: '90+ 一次性全仓', tiers: [{ pct: 90, frac: 1 }] },
  ];
  // v1.9.3-D：自定义档位方案（金字塔模拟器）——{ name, desc, tiers: [{pct, frac}] } 数组
  if (opts.customTiers && opts.customTiers.length) {
    opts.customTiers.forEach((cs, i) => {
      strategies.push({ key: 'custom' + i, name: cs.name || '自定义方案', desc: cs.desc || cs.tiers.map(t => t.pct + '档 ' + Math.round(t.frac * 100) + '%').join(' / '), tiers: cs.tiers });
    });
  }
  const out = [];
  for (const st of strategies) {
    let totRet = 0, totMdd = 0, totWin = 0, totEv = 0, totAnnual = 0, n = 0;
    for (const it of pool) {
      if (!it.series || !it.kline) continue;
      const dates = Object.keys(it.kline).sort();
      if (dates.length < 250) continue;   // 样本不足
      const endD = dates[dates.length - 1];
      const endP = it.kline[endD];
      const divsByYear = {};
      (it.divs || []).forEach(d => { if (d.ex && d.dps > 0) { const y = d.ex.slice(0, 4); divsByYear[y] = (divsByYear[y] || 0) + d.dps; } });
      let ret = 0, mdd = 0, winCnt = 0, evCnt = 0;
      const buys = [];
      if (st.tiers) {
        // 金字塔：各档独立事件首日买入
        for (const t of st.tiers) {
          const evs = DL.findZoneEvents(it.series, t.pct);
          for (const ev of evs) {
            const idx = dates.indexOf(ev.start);
            if (idx < 0) continue;
            const buyP = it.kline[ev.start];
            if (!(buyP > 0)) continue;
            buys.push({ d: ev.start, price: buyP, frac: t.frac });
            evCnt++;
            // 买后 1 年正收益（胜率）
            const y1 = dates[idx + 250];
            if (y1 && it.kline[y1] > buyP) winCnt++;
          }
        }
        if (!buys.length) continue;   // 未触发
        // 各批收益加权
        let wSum = 0;
        for (const b of buys) {
          const endY = (b.d || '').slice(0, 4);
          let divSum = 0;
          Object.keys(divsByYear).forEach(y => { if (y >= endY) divSum += divsByYear[y]; });
          const r = (endP + divSum) / b.price - 1;
          ret += r * b.frac;
          wSum += b.frac;
        }
        if (wSum > 0) ret /= wSum;
        // 回撤：各批买入后最大回撤加权
        for (const b of buys) {
          let peak = -Infinity, md = 0;
          const si = dates.indexOf(b.d);
          for (let j = si; j < dates.length; j++) { const p = it.kline[dates[j]]; if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > md) md = dd; }
          mdd += md * b.frac;
        }
        if (wSum > 0) mdd /= wSum;
      } else {
        // 闭眼全仓：期初买入
        const buyP = it.kline[dates[0]];
        if (!(buyP > 0)) continue;
        let divSum = 0;
        Object.keys(divsByYear).forEach(y => { if (y >= dates[0].slice(0, 4)) divSum += divsByYear[y]; });
        ret = (endP + divSum) / buyP - 1;
        let peak = -Infinity, md = 0;
        for (let j = 0; j < dates.length; j++) { const p = it.kline[dates[j]]; if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > md) md = dd; }
        mdd = md;
        evCnt = 1;
        const y1 = dates[250];
        if (y1 && it.kline[y1] > buyP) winCnt = 1;
      }
      // 年化（按回测区间跨度）
      const span = (new Date(endD) - new Date(dates[0])) / (365 * 86400000);
      totRet += ret; totMdd += mdd; totWin += winCnt; totEv += evCnt; n++;
      if (span > 0 && (1 + ret) > 0) totAnnual += Math.pow(1 + ret, 1 / span) - 1;
    }
    if (!n) { out.push({ key: st.key, name: st.name, desc: st.desc, ret: null, annual: null, mdd: null, winRate: null, events: 0, n: 0 }); continue; }
    out.push({
      key: st.key, name: st.name, desc: st.desc,
      ret: totRet / n * 100, annual: totAnnual / n * 100, mdd: totMdd / n * 100,
      winRate: totEv ? totWin / totEv * 100 : null, events: totEv, n,
    });
  }
  return out;
}

/* ---------- v1.9.6：结论行规则树（P0-9，规则与 test/rule-tree-backtest.js 一致） ---------- */
/* 五档结论：strong强烈建仓 / buy可建仓 / watch观望 / wait等待 / avoid回避 / avoid_small回避(陷阱型) */
function divTrendBadAt(divs, asOfYear) {
  const byRep = {};
  divs.forEach(d => { if (d.pending || !d.report) return; const y = parseInt(d.report.slice(0, 4), 10); if (!y || y >= asOfYear) return; byRep[y] = (byRep[y] || 0) + (d.dps || 0); });
  const ys = Object.keys(byRep).map(Number).sort((a, b) => b - a);
  if (ys.length < 3) return false;
  return byRep[ys[0]] < byRep[ys[1]] * 0.99 && byRep[ys[1]] < byRep[ys[2]] * 0.99;
}
function coverageAt(divs, asOfYear) {
  /* P0-B 修复（2026-08-18）：EPS 年度终值口径
   * 旧：同财年 Math.max(eps) —— 若该财年仅有中报记录，半年累计 EPS 被当全年 → 覆盖率虚高（神华 -58% 假象根因）
   * 新：年报(12-31) EPS 优先=年度终值；无年报记录该财年不参与覆盖率计算（返回 null=数据不足，宁可不说）
   * 归属财年对齐：分红与 EPS 均按 REPORT_DATE 归属财年（分红 2024 财年÷EPS 2024 财年，到账年不影响）
   * 覆盖率 = 最近 2 个有年度终值 EPS 的完整财年（分红合计÷EPS合计） */
  const byRep = {};
  divs.forEach(d => {
    if (d.pending || !d.report) return;
    const y = parseInt(d.report.slice(0, 4), 10);
    if (!y || y >= asOfYear) return;
    if (!byRep[y]) byRep[y] = { dps: 0, eps: null, hasAnnual: false };
    byRep[y].dps += d.dps || 0;
    if (/-12-31$/.test(d.report)) {
      // 年报记录：EPS=年度终值（覆盖之前的非年报值）
      byRep[y].eps = parseFloat(d.eps) || byRep[y].eps;
      byRep[y].hasAnnual = true;
    }
    // 非年报记录不设置 EPS（仅累计 dps；EPS 只认年报终值）
  });
  const ys = Object.keys(byRep).map(Number).sort((a, b) => b - a).filter(y => byRep[y].hasAnnual && byRep[y].eps).slice(0, 2);
  // M31 Q2 实锤：eps 必须为正且有限（负 EPS=亏损年、0=字段缺失 → 覆盖率无意义，返回 null 而非负数/0）
  if (ys.length < 2 || !(byRep[ys[0]].eps > 0) || !(byRep[ys[1]].eps > 0)) return null;
  const epsSum = byRep[ys[0]].eps + byRep[ys[1]].eps;
  if (!(epsSum > 0)) return null;
  return (byRep[ys[0]].dps + byRep[ys[1]].dps) / epsSum;
}
/* 结论规则树：返回 { tier, steps: [{layer, msg}] }——steps 供展开详情 */
function ruleVerdict(pct, cls, trendBad, cov) {
  const steps = [];
  if (trendBad) { steps.push({ layer: 1, msg: '分红趋势：近2个完整财年连续下降（一票否决）' }); return { tier: 'avoid', steps }; }
  steps.push({ layer: 1, msg: '分红趋势：健康' });
  if (cls === 'trap') { steps.push({ layer: 3, msg: '生态类型：陷阱型（分位信号不适用，历史1年收益-16%/胜率18%）' }); return { tier: 'avoid_small', steps }; }
  steps.push({ layer: 3, msg: '生态类型：' + (cls === 'wait90' ? '可等90型' : cls === 'boundary' ? '边界型' : cls === 'scarce' ? '稀缺型' : '常规型') });
  let tier;
  if (pct >= 90) tier = 'strong';
  else if (cls === 'wait90') tier = pct >= 80 ? 'buy' : 'wait';
  else if (cls === 'boundary') tier = pct >= 85 ? 'buy' : (pct >= 80 ? 'watch' : 'wait');
  else if (cls === 'scarce') tier = pct >= 80 ? 'buy' : 'wait';
  else tier = pct >= 85 ? 'buy' : (pct >= 80 ? 'watch' : 'wait');
  steps.push({ layer: 3, msg: `分位：${pct != null ? pct.toFixed(0) + '%' : '—'}（档位线 ${tier === 'buy' ? (cls === 'boundary' ? 85 : 80) : (cls === 'boundary' ? 80 : 80)}）` });
  /* 2026-08-18（主人令真实数据验证）：cov 语义统一=支付率（分红÷EPS，coverageAt 实现口径）
   * 阈值 0.35/0.25 = 支付率过低 → 分红不慷慨 → 降级（与 verdictEngine 的 Q1 判定区分：
   * verdictEngine 管“支付率过高=吃老本/偏紧”，此处管“支付率过低=分红吸引力不足”） */
  if (tier === 'strong' && cov != null && cov < 0.35) { steps.push({ layer: 2, msg: '分红率 ' + (cov * 100).toFixed(0) + '% < 35%，强烈建仓降级为可建仓' }); tier = 'buy'; }
  else if (cov != null) steps.push({ layer: 2, msg: '分红率（近2财年）：' + (cov * 100).toFixed(0) + '%' });
  if (tier === 'buy' && cov != null && cov < 0.25) { steps.push({ layer: 2, msg: '分红率 ' + (cov * 100).toFixed(0) + '% < 25%，可建仓降级为观望' }); tier = 'watch'; }
  if (tier === 'watch' && cov != null && cov < 0.25) { steps.push({ layer: 2, msg: '分红率 ' + (cov * 100).toFixed(0) + '% < 25%，观望降级为等待' }); tier = 'wait'; }
  return { tier, steps };
}
/* 结论行历史胜率表（由 test/rule-tree-backtest.js 产出）：[3年收益%, 3年胜率%, 事件数]
 * P0-E 修复（2026-08-18）：重跑规则树（40只×16年）——本地复制版 divTrendBad/coverageRatio 改用 DL 修复版
 * （P0-B 年度终值 EPS + P0-A 财年归组 TTM），旧表（44.8/41.8/39.1）为 P0 修复前脏输入产物 */
const RULE_STATS = {
  strong: [40.7, 70, 2205], buy: [37.6, 69, 4545], watch: [39.6, 74, 3225],
  avoid: [33.2, 67, 95], avoid_small: [17.4, 55, 32], wait: [null, null, 976],
};
const RULE_TIER_LABEL = { strong: '强烈建仓', buy: '可建仓', watch: '观望', wait: '等待', avoid: '回避', avoid_small: '回避/小仓' };

/* ---------- O1：行业基准表（初始版·2026-08-18 已回源样本） ----------
 * 用途：报告卡③质量趋势对比（ROE vs 行业）、买点目标股息率标定（M24 Q4 行业标定前初始版）
 * 来源：6 只持仓 2025 年报实测 + 公开行业常识区间；样本 N 标注，禁止当权威阈值
 * 覆盖率口径（2026-08-18 更新）：全站统一=支付率（分红÷EPS，coverageAt 实现口径）；
 * 倍数（EPS÷派息）仅作展示换算（1/cov）；旧 M23 注脚“倍数全站唯一”已作废（实现从未如此） */
const BENCH = {
  /* 来源标注（Q1 纪律）：初始版=6 只持仓样本实测 + 行业常识区间；样本≥5 只后再定权威区间（M21 Q4）
   * 买点线 = yieldMid + yieldUp（M24 Q4：行业基准中位数上浮 1-2pp，禁止全局 6%/7%） */
  // 银行：样本 招行5.26/工行4.05 股息率，中位≈4.5%，上浮 1.5pp → 买点线 6.0%
  // M45 权威化（10 样本实测：股息率中位 5.27%、范围 3.73~5.97；ROE 4.9~13.4）——三档 5.0/6.0/7.0
  bank:    { roe: [7, 9, 11],     yieldMid: 5.0, yieldUp: 1.0, note: '银行 10 样本实测（2026-08-18）：中位 5.27%；资本约束分红率 30-35%；三档 5.0/6.0/7.0' },
  // 消费：样本 伊利5.49/美的5.16，中位≈4.0%，上浮 1.5pp → 买点线 5.5%
  // M45 权威化（9 样本实测：中位 5.36%；重仓线 7.5% 历史 0 触发 → 降 7.0）——⚠️ 弱依据：持仓样本 2 只+触发 0 次，待扩充
  consumer:{ roe: [15, 20, 24],  yieldMid: 5.0, yieldUp: 1.0, note: '消费 9 样本实测（2026-08-18）：中位 5.36%；高分红率 70%+ 常见；三档 5.0/6.0/7.0（弱依据·样本2持仓·待扩充）' },
  // 电信：样本 移动4.91，中位≈5.0%，上浮 1.0pp → 买点线 6.0%
  // M45：样本 3 只（移动/电信/联通，A 股仅 3 家）未达权威线（≥5）→ 维持 + 标注
  // M47 Q3：小仓线 5.0→4.5（个股可达性修正：移动 4.91% 已是全市场高分红，5.0 过严卡等待）；加仓 6.0/重仓 7.0 不变
  telecom: { roe: [8, 10, 13],   yieldMid: 4.5, yieldUp: 1.5, note: '电信实测（3 样本·未达权威线）：中位 4.14%；三档 4.5/6.0/7.0（4.5 基于个股可达性修正）' },
  // 保险：样本 平安5.27，中位≈4.5%，上浮 1.0pp → 买点线 5.5%（Q2 修正：与"45加仓"自洽，2.70/0.055≈49 元）
  // M45 权威化（5 样本实测：中位 3.84%；NBV 年度概念禁季度判趋势）——三档 4.0/5.5/6.5（平安 49.1 已核）
  insurer: { roe: [14, 18, 28],   yieldMid: 4.0, yieldUp: 1.5, note: '保险 5 样本实测（2026-08-18）：中位 3.84%；平安 5.26 特例拉高；三档 4.0/5.5/6.5' },
  // 公用：初始标定（样本待补≥5 只）
  // M45 权威化（6 样本实测：中位 3.70%；现金流稳、分红率高）——三档 4.0/5.5/6.5（长电 5.5 已核）
  utility: { roe: [11, 12, 16],   yieldMid: 4.0, yieldUp: 1.5, note: '公用事业 6 样本实测（2026-08-18）：中位 3.70%；三档 4.0/5.5/6.5' },
  // 能源：初始标定（样本待补≥5 只）——⚠️ M40 Q1：持仓无能源标的，7.0% 未经验证
  // M45：周期行业·中位数法不适用（6 样本中位 3.95% 但周期底部/顶部差异大）→ 维持临时线 + 标注，待周期样本扩充（含 2015 底/2021 顶）
  energy:  { roe: [10, 11, 13],   yieldMid: 5.5, yieldUp: 1.5, note: '能源 6 样本实测（2026-08-18）：中位 3.95%；⚠️ 周期行业·中位数法不适用·临时线 7.0%（待周期样本扩充）' },
};
function roeBand(industry) {
  const b = BENCH[industry];
  if (!b) return null;
  return { lo: b.roe[0], mid: b.roe[1], hi: b.roe[2], note: b.note };
}

/* ---------- O1：报告卡引擎（数据层/结论层分离，M22 三问模板） ---------- */
function reportPeriodLabel(divs) {
  /* 返回最近完整财年标注：'2025年报' / '2025三季报' 等 */
  const reports = divs.filter(d => d.report).map(d => d.report).sort();
  const last = reports[reports.length - 1];
  if (!last) return null;
  const y = last.slice(0, 4);
  const md = last.slice(5);
  const map = { '03-31': '一季报', '06-30': '中报', '09-30': '三季报', '12-31': '年报' };
  return y + (map[md] ? map[md] : last);
}
/* ---------- O2：F10 年报数据接入（2026-08-18，M35 Q3/Q4/Q5） ----------
 * fetchF10Annual(code)：拉最近完整年报（REPORT_DATE 以 12-31 结尾）
 * 字段：ROEJQ（加权ROE%）、MGWFPLR（每股未分配·元）、PARENTNETPROFIT（归母净利·元）
 * 单位锚定（Q3 CI）：PARENTNETPROFIT=元（招行 150181000000=1501.81亿）、MGWFPLR=元/股（26.9551）、ROEJQ=%
 * 缓存：TTL 7 天（年报+CSRC 行业均年频静态，Q3）；缓存命中标 cachedAt（卡面血缘脚注 Q5）
 * 报告期：动态找最近完整年报（接口按 REPORT_DATE 降序，取第一条 12-31 结尾）
 * P0-3（2026-08-18）：pageSize 5→100 + annuals 序列 + netProfitYoY——
 *   5 条会被季报挤占拿不到历史年报（实测格力 5 条仅回 2025Q1~2026Q1，无 2023/2024 年报）；
 *   100 条覆盖 2006 年至今全序列（实测格力），支撑净利同比/趋势判据/回放验收（P0-4） */
const _f10Cache = new Map();
async function fetchF10Annual(code, tryN = 1) {
  const key = 'f10:' + code;
  const hit = _f10Cache.get(key);
  // Q3（M37）：年报+CSRC 行业均年频静态 → TTL 7 天（原 24h 过保守）
  if (hit && Date.now() - hit.ts < 7 * 24 * 3600 * 1000) return Object.assign({ cached: true, cachedAt: new Date(hit.ts).toISOString().slice(0, 10) }, hit.data);
  const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECUCODE%3D%22${code}%22)&pageNumber=1&pageSize=100&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`;
  try {
    const [r, r2] = await Promise.all([
      fetch(url, { headers: { 'Referer': 'https://emweb.securities.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 Chrome/126.0' } }),
      fetch(`https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO&columns=ALL&filter=(SECUCODE%3D%22${code}%22)&pageNumber=1&pageSize=1&source=HSF10&client=PC`, { headers: { 'Referer': 'https://emweb.securities.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 Chrome/126.0' } }),
    ]);
    const j = await r.json();
    let csrc = '';
    try { const j2 = await r2.json(); const b = (j2 && j2.result && j2.result.data) || []; csrc = (b[0] && b[0].CSRC_INDUSTRY_NAME) || ''; } catch (e2) {}
    const rows = (j && j.result && j.result.data) || [];
    // 所有完整年报序列（接口降序 → 保持降序），全量保留（回放验收需 2018 年前数据，实测 pageSize=100 覆盖至 2006）
    const annuals = rows.filter(x => /12-31/.test(x.REPORT_DATE || '')).map(x => ({
      reportDate: (x.REPORT_DATE || '').slice(0, 10),
      netProfit: x.PARENTNETPROFIT != null ? parseFloat(x.PARENTNETPROFIT) / 1e8 : null,   // 元→亿
      roe: x.ROEJQ != null ? parseFloat(x.ROEJQ) : null,
    }));
    const annual = annuals[0] || null;   // 最近完整年报
    const annualRow = rows.find(x => /12-31/.test(x.REPORT_DATE || ''));   // 原始行（mgwfplr/ORG_TYPE 回源）
    if (!annual) return null;
    // 净利同比：最新年报 vs 上一年报（%），任一缺失/基期为 0 → null（宁缺勿误报）
    let netProfitYoY = null;
    if (annuals[0] && annuals[1] && annuals[0].netProfit != null && annuals[1].netProfit != null && annuals[1].netProfit !== 0) {
      netProfitYoY = (annuals[0].netProfit / annuals[1].netProfit - 1) * 100;
    }
    const out = {
      roe: annual.roe,
      netProfit: annual.netProfit,
      netProfitYoY,       // P0-3：最新完整年报净利同比（%）
      annuals,            // P0-3：年报序列（降序，{reportDate,netProfit,roe}）
      orgType: annualRow ? (annualRow.ORG_TYPE || '') : '',
      csrcIndustry: csrc,   // 证监会行业（第二判据，Q1）
      reportDate: annual.reportDate,
    };
    // mgwfplr：从原始行回源（annuals 映射未保留该字段）
    if (annualRow) out.mgwfplr = annualRow.MGWFPLR != null ? parseFloat(annualRow.MGWFPLR) : null;
    _f10Cache.set(key, { ts: Date.now(), data: out });
    return Object.assign({ cached: false }, out);
  } catch (e) {
    if (tryN < 3) { await new Promise(r2 => setTimeout(r2, tryN * 2000)); return fetchF10Annual(code, tryN + 1); }
    return null;
  }
}

function industryOf(secuType) {
  /* 行业识别（M36 Q1：双判据）
   * 判据1：CSRC 证监会行业名（RPT_F10_ORG_BASICINFO，可靠）
   * 判据2：ORG_TYPE / 英文名（兜底，实测大量"通用"不可靠） */
  const t = (secuType || '').toLowerCase();
  // 判据1：CSRC 证监会行业
  if (t.includes('货币金融') || t.includes('银行') || t.includes('bank')) return 'bank';
  if (t.includes('保险') || t.includes('insur')) return 'insurer';
  if (t.includes('电信') || t.includes('广播') || t.includes('卫星') || t.includes('telecom')) return 'telecom';
  if (t.includes('食品') || t.includes('饮料') || t.includes('酒') || t.includes('农副') || t.includes('医药')) return 'consumer';
  if (t.includes('电气机械') || t.includes('家电') || t.includes('家用电器') || t.includes('汽车')) return 'consumer';
  if (t.includes('电力') || t.includes('燃气') || t.includes('水生产') || t.includes('公用')) return 'utility';
  if (t.includes('煤炭') || t.includes('石油') || t.includes('开采') || t.includes('有色') || t.includes('能源')) return 'energy';
  // 判据2：ORG_TYPE / 英文兜底
  if (t.includes('银行') || t.includes('bank')) return 'bank';
  if (t.includes('保险') || t.includes('insur')) return 'insurer';
  if (t.includes('电信') || t.includes('telecom')) return 'telecom';
  if (t.includes('食品') || t.includes('消费')) return 'consumer';
  if (t.includes('电力') || t.includes('公用')) return 'utility';
  if (t.includes('煤炭') || t.includes('能源')) return 'energy';
  return null;   // 未知 → 报告卡只显示通用三问核心，不挂行业维度（M22 Q2：挂错比不挂更糟）
}
/* P0-3/P0-4 陷阱过滤器（2026-08-18 主人拍板：先默认共现版，P0-4 回放校准定稿）
 * 定位：重仓线守门员（硬排除）+ 加仓线降级（软观察）——拦截"价值毁灭型"高股息（格力 2021/兖矿 2024 型）
 * 回放校准结论（test/trap-replay.js v3，942 事件）：
 *   v1 共现版（同比<0）精确率仅 31%、神华周期底部误伤 88% ❌
 *   v3（同比<-10% + 支付率>50% + 高股息画像，hard 仅守重仓档）：精确率 100%（6/6 全对）、误伤 0% ✅
 * 输入：netProfitYoY（最新完整年报净利同比%，null=不判）、payout（支付率 0.35=35%，
 *       与决策规范第1章对应：覆盖倍数=EPS÷派息，覆盖<2 ⇔ 支付率>50%）、
 *       dy（当前股息率）、p90Line（加仓线=个股分位P90，高股息画像判定：股息率>行业分位90）
 * 输出：{ level:'hard'|'soft'|null, msg }
 *   hard：净利同比<-10%（毁灭信号）且 支付率>50%（覆盖<2）且 dy>=P90线（高股息画像）——仅守重仓档（引擎层落实）
 *   soft：净利同比<0 但不满足 hard → 观察型（加仓降级小仓）
 * 周期豁免：净利小负（-10% 内）不判 hard——神华 2020/2021 周期底部天然豁免；煤炭 2015 同理 */
function trapFilter({ netProfitYoY, payout, dy, p90Line }) {
  if (netProfitYoY == null || !(netProfitYoY < 0)) return { level: null, msg: null };
  const highYield = p90Line != null ? (dy != null && dy >= p90Line) : (dy != null && dy >= 5);
  if (netProfitYoY < -10 && highYield && payout != null && payout > 0.5) {
    return { level: 'hard', msg: `陷阱确认：最新年报净利同比 ${netProfitYoY.toFixed(1)}% 下滑 + 支付率 ${(payout * 100).toFixed(0)}%（覆盖<2）` };
  }
  return { level: 'soft', msg: `观察：最新年报净利同比 ${netProfitYoY.toFixed(1)}% 下滑（覆盖尚可，盯年报）` };
}

function verdictEngine({ divs, coverage, reserveYears, payoutRate, eps, dps, price, dy, pct, industry, roe, roeTrend, dividendCagr, code, netProfitYoY }) {
  const out = { q1: null, q2: null, q3: null, summary: null };
  /* Q1 这笔分红可靠吗？ */
  if (coverage == null) {
    // null 分支（M28 Q5）：覆盖数据不足 → 以储备年数为准
    if (reserveYears != null) out.q1 = { verdict: '覆盖数据不足', msg: `覆盖率数据不足，以储备年数为准：${reserveYears.toFixed(1)} 年储备` };
    else out.q1 = { verdict: '数据不足', msg: '分红可靠性数据不足，不可决策' };
  } else if (coverage > 0.9) {
    /* 2026-08-18 修复（主人令真实数据验证实锤）：cov=支付率（分红÷EPS）被当覆盖倍数 → 全站“吃老本”误判
     * 真值：招行 0.35=支付率 35%，利润覆盖 2.86 倍=安全。Q1 改按支付率语义：>90% 吃老本 / 70-90% 偏紧 / <70% 安全 */
    out.q1 = { verdict: '🔴 吃老本', msg: `近2财年分红占利润 ${(coverage * 100).toFixed(0)}%（支付率过高，利润几乎全分，吃老本信号）` };
  } else if (coverage > 0.7) {
    out.q1 = { verdict: '🟡 高分红率', msg: `近2财年分红占利润 ${(coverage * 100).toFixed(0)}%（支付率偏高，增长空间受限）` };
  } else {
    out.q1 = { verdict: '✅ 安全', msg: `近2财年分红占利润 ${(coverage * 100).toFixed(0)}%，利润留存充足` };
  }
  /* Q2 现在这个价格值不值？ */
  const yieldBand = BENCH[industry] || null;
  if (dy == null) out.q2 = { verdict: '数据不足', msg: '股息率数据不足' };
  else if (yieldBand) {
    const mid = yieldBand.yieldMid, up = yieldBand.yieldUp;
    const buyLine = mid + up;   // 行业买点线 = 基准中位 + 上浮 pp（M24 Q4：不许全局 6%/7%）
    const buyPrice = dps != null && dps > 0 ? (dps / (buyLine / 100)).toFixed(1) : null;
    if (dy >= buyLine) out.q2 = { verdict: '✅ 可买', msg: `股息率 ${dy.toFixed(2)}% ≥ 行业买点线 ${buyLine.toFixed(1)}%（${industry} 中位 ${mid}%+${up}pp），可买${buyPrice ? '，买点 ' + buyPrice + ' 元' : ''}` };
    else if (dy >= mid) out.q2 = { verdict: '✅ 可买', msg: `股息率 ${dy.toFixed(2)}% ≥ 行业基准 ${mid.toFixed(1)}%（${industry}）可小仓，加仓线 ${buyLine.toFixed(1)}%（${buyPrice ? buyPrice + ' 元' : '—'}）` };
    else out.q2 = { verdict: '🟡 等更低', msg: `股息率 ${dy.toFixed(2)}% 低于行业基准 ${mid.toFixed(1)}%（${industry}），等更低，买点线 ${buyLine.toFixed(1)}%（${buyPrice ? buyPrice + ' 元' : '—'}）` };
  } else {
    // 无行业基准 → 通用：用分位辅助
    if (pct != null && pct >= 80) out.q2 = { verdict: '🟡 等更低', msg: `股息率 ${dy.toFixed(2)}%，分位 ${pct.toFixed(0)}% 高位，等更低` };
    else if (dy >= 5) out.q2 = { verdict: '✅ 可买', msg: `股息率 ${dy.toFixed(2)}% ≥5%，分位 ${pct != null ? pct.toFixed(0) + '%' : '—'}` };
    else out.q2 = { verdict: '🟡 等更低', msg: `股息率 ${dy.toFixed(2)}% <5%，等更低（买点=派息÷目标股息率）` };
  }
  /* Q3 最坏情况我扛得住吗？ */
  const risks = [];
  if (roe != null && roeBand(industry)) {
    const b = roeBand(industry);
    if (roe < b.lo) risks.push(`ROE ${roe.toFixed(1)}% 低于行业低档 ${b.lo}%`);
  }
  if (roeTrend != null && roeTrend < 0) risks.push(`ROE 连降（${Math.abs(roeTrend)} 年）`);
  if (dividendCagr != null && dividendCagr < 0) risks.push(`分红 CAGR ${dividendCagr.toFixed(1)}% 负增长`);
  if (payoutRate != null && payoutRate > 0.7) risks.push(`分红率 ${(payoutRate * 100).toFixed(0)}% 高企，增长空间受限`);
  if (!risks.length) out.q3 = { verdict: '✅ 无明显风险', msg: '未见显著风险' };
  else out.q3 = { verdict: '⚠️ ' + risks.length + ' 项风险', msg: risks.join('；') };
  /* 综合句（三问拼接 + 三档买点）
   * v1.9.13 分位定线（2026-08-18 三轮定案）：三档=个股近3年 dy 分位（小仓P75/加仓P90/重仓P95）优先，
   * 行业线（BENCH）=数据不足兜底 + 卡面参考；分位线=市场对分红可持续增长信心的定价 */
  const parts = [out.q1.verdict, out.q2.verdict, out.q3.verdict];
  const yb = BENCH[industry] || null;
  const tl = code && TIER_LINE[code] ? TIER_LINE[code] : null;
  /* v1.9.13 溢价分位：TIER_LINE 存溢价 pp，触发判定等价（dy≥p+国债 ⟺ dy−国债≥p），显示回算 dy 口径 */
  const midLine = tl ? (tl.pending ? tl.p75 : tl.p75 + TREASURY_NOW) : (yb ? yb.yieldMid : null);
  const line = tl ? (tl.pending ? tl.p90 : tl.p90 + TREASURY_NOW) : (yb ? yb.yieldMid + yb.yieldUp : null);
  const heavyLine = tl ? (tl.pending ? tl.p95 : tl.p95 + TREASURY_NOW) : (line != null ? line + 1 : null);
  const indLine = yb ? yb.yieldMid + yb.yieldUp : null;
  const bp = (r) => dps != null && dps > 0 && r != null ? (dps / (r / 100)).toFixed(1) : null;
  const buyP = bp(line), heavyP = bp(heavyLine);
  /* Q1（M38）：当前档位指示——现价股息率落在哪个区 */
  let curTier = null;
  if (dy != null && midLine != null && !(tl && tl.pending)) {
    if (dy >= heavyLine) curTier = { name: '重仓区', note: '已到重仓线 ' + heavyLine.toFixed(1) + '%' };
    else if (dy >= line) curTier = { name: '加仓区', note: '已到加仓线 ' + line.toFixed(1) + '%' };
    else if (dy >= midLine) curTier = { name: '小仓区', note: '已可小仓（≥' + midLine.toFixed(1) + '%），未到加仓线 ' + line.toFixed(1) + '%' };
    else curTier = { name: '等待区', note: '未达小仓线 ' + midLine.toFixed(1) + '%；现价买入仍可吃分红（' + dy.toFixed(2) + '%），三档为加仓节奏参考非买入否决' };
  }
  /* P0-3/P0-4：陷阱过滤器接入（回放校准 v3：hard 仅守重仓档）——重仓硬排除 / 加仓软降级 */
  out.trap = null;
  if (netProfitYoY != null && netProfitYoY < 0) {
    const tr = trapFilter({ netProfitYoY, payout: coverage, dy, p90Line: line });
    if (tr.level === 'hard' && curTier && curTier.name === '重仓区') {
      out.trap = { level: 'hard', msg: tr.msg + '——重仓线拦截，降级观察' };
      curTier = { name: '重仓区(陷阱拦截)', note: '陷阱确认：净利下滑+支付率过高，重仓线不生效，降级观察' };
    } else if (tr.level) {
      out.trap = { level: 'soft', msg: tr.msg + '——加仓线降为小仓' };
      if (curTier && curTier.name === '加仓区') curTier = { name: '加仓区(观察)', note: '净利同比下滑，加仓线降为小仓，等年报确认' };
    }
  }
  const tiers = [];
  /* M47 Q1：三档结构化（股息率主显 + 价格附注小字）——rate 为档位股息率，price 为换算价（附注用）
   * v1.9.13：pending（线待补）不展示三档——只展示不触发 */
  if (!(tl && tl.pending)) {
    if (curTier) tiers.push({ type: 'cur', text: '📍 当前：' + curTier.name + '（' + curTier.note + '）' });
    if (midLine != null) tiers.push({ type: 'small', rate: midLine, price: bp(midLine), hit: dy != null && dy >= midLine });
    if (buyP) tiers.push({ type: 'add', rate: line, price: buyP, hit: dy != null && dy >= line });
    if (heavyP) tiers.push({ type: 'full', rate: heavyLine, price: heavyP, hit: dy != null && dy >= heavyLine });
  }
  /* v1.9.13：线源标注（溢价分位 vs 行业参考）+ 语义行 + 过滤层黄灯（优先级：trap>红线>短样本>漂移）
   * 大师第5轮：过滤层只降级不改数；黄灯原因优先级排序，显示前 2 条 */
  if (tl) {
    if (tl.pending) {
      out.lineNote = '⚠️ 溢价分位线待补（K线源故障）·当前显示股息率线（口径不同）·仅展示不触发';
    } else {
      out.lineNote = '三档=溢价分位线（近3年：dy−国债；P75/P90/P95=' + tl.p75.toFixed(2) + '/' + tl.p90.toFixed(2) + '/' + tl.p95.toFixed(2) + 'pp，国债锚 ' + TREASURY_NOW.toFixed(2) + '% 近似）'
        + (indLine != null ? '；行业参考 ' + indLine.toFixed(1) + '%' : '')
        + '；线高=市场对其分红增长信心低（分红CAGR ' + (tl.cagr != null ? tl.cagr.toFixed(1) + '%' : '—') + '）';
      if (tl.redLine) out.lineNote += '；⚠️ 支付率 ' + tl.payout + '% 超红线，分位线仅供参考';
    }
    /* 过滤层黄灯数组（只降级不改数） */
    const filters = [];
    if (out.trap) filters.push({ sev: 1, txt: (out.trap.level === 'hard' ? '🚫' : '⚠️') + ' ' + out.trap.msg });
    if (tl.redLine) filters.push({ sev: 2, txt: '⚠️ 支付率 ' + tl.payout + '% 超红线（>90%/<20%），分位线仅供参考' });
    if (tl.pending) filters.push({ sev: 2, txt: '⚠️ K线源故障，股息率线暂替（口径不同），仅展示不触发' });
    if (tl.shortSample) filters.push({ sev: 3, txt: '⚠️ 样本不足 5 年，分位线稳定性待观察' });
    if (tl.drift) filters.push({ sev: 4, txt: '⚠️ 线漂移中（连续 3 季累计下移 >0.8pp，阴跌锚定风险）' });
    out.filters = filters.sort((a, b) => a.sev - b.sev).slice(0, 2);
    /* 三维参考（参照系层并列展示·黑盒加权禁令：矛盾展示不做加权） */
    const absLevel = (dy != null && indLine != null) ? (dy >= indLine ? '高' : (dy >= indLine * 0.85 ? '中' : '低')) : null;
    const pctLevel = curTier ? curTier.name : null;
    const finLevel = tl.quality || null;
    out.ref3D = {
      abs: absLevel ? { label: '绝对', val: dy != null ? dy.toFixed(2) + '%' : '—', ref: indLine != null ? '行业 ' + indLine.toFixed(1) + '%' : null, level: absLevel } : null,
      pct: pctLevel ? { label: '分位', val: curTier.name, ref: tl.p90_1y != null ? '近1年P90 ' + (tl.p90_1y + TREASURY_NOW).toFixed(2) + '%' : null, level: pctLevel } : null,
      fin: finLevel ? { label: '财报', val: (tl.cagr != null ? 'CAGR ' + tl.cagr.toFixed(1) + '%' : '—'), ref: '支付率 ' + (tl.payout != null ? tl.payout + '%' : '—'), level: finLevel } : null,
    };
    /* 矛盾检测（展示不裁决）：绝对高但分位低 / 分位极值但绝对低 / 财报负增长但分位极值 */
    out.conflicts = [];
    if (absLevel === '高' && curTier && (curTier.name === '等待区' || curTier.name === '小仓区')) {
      out.conflicts.push('绝对股息率高于行业参考，但分位仅' + curTier.name + '——该股历史整体高息，绝对高≠相对机会');
    }
    if (absLevel === '低' && curTier && (curTier.name === '重仓区' || curTier.name === '加仓区')) {
      out.conflicts.push('分位已到' + curTier.name + '，但绝对股息率低于行业参考——利率环境或该股历史低息所致');
    }
    if (tl.quality === '负增长' && curTier && (curTier.name === '重仓区' || curTier.name === '加仓区')) {
      out.conflicts.push('分位已到' + curTier.name + '，但分红负增长——陷阱风险（价值毁灭型高股息）');
    }
  }
  out.tiers = tiers;
  /* 文本形态（向后兼容：summary 等使用处） */
  out.tiersTxt = tiers.map(t => t.type === 'cur' ? t.text : (t.type === 'small' ? '小仓' : t.type === 'add' ? '加仓' : '重仓') + '=' + t.rate.toFixed(1) + '%·' + t.price + ' 元' + (t.hit ? ' ✅' : '')).join(' / ');
  out.curTier = curTier;
  let summaryPrefix = '';
  if (out.trap) summaryPrefix = (out.trap.level === 'hard' ? '🚫 ' : '⚠️ ') + out.trap.msg + '；';
  out.summary = summaryPrefix + `${parts.join(' · ')}` + (out.tiersTxt ? '；' + out.tiersTxt : '');
  return out;
}

/* P0-6 信号分层标注（2026-08-18 三维表实测，docs/信号三维表-20260818.md；1年持有含分红·无复投）
 * 分时段=2010-13/2014-17/2018-21/2022-26；标注规则（大师三审）：
 *   n<10 只标样本数不标胜率；n<5 不置顶不参与排序；全周期均值仅 tooltip；
 *   小仓线≈随机买入（V1 实测剔除陷阱后 66→67%，本质随机）——标注"随机等效"
 * 字段：all=全周期胜率、n=全周期样本、seg=分时段区间（去空段）、last=最近时段胜率、lastN=最近时段样本 */
const SIG_STATS = {
  bank: {
    small: { all: '58%', n: 210, seg: '43-69%', last: '69%', lastN: 69, note: '随机等效' },
    add:   { all: '82%', n: 118, seg: '65-100%', last: '91%', lastN: 47, note: '' },
    heavy: { all: '96%', n: 80,  seg: '75-100%', last: '100%', lastN: 50, note: '' },
  },
  consumer: {
    small: { all: '76%', n: 75, seg: '69-100%', last: '83%', lastN: 24, note: '随机等效' },
    add:   { all: '80%', n: 46, seg: '75-85%', last: '75%', lastN: 20, note: '' },
    heavy: { all: '62%', n: 32, seg: '50-81%', last: '50%', lastN: 4, note: '2021 格力时段全亏' },
  },
  insurer: {
    small: { all: '58%', n: 24, seg: '27-100%', last: '80%', lastN: 10, note: '随机等效' },
    add:   { all: '100%', n: 8, seg: '', last: '', lastN: 0, note: '样本不足(n=8)' },
    heavy: { all: '100%', n: 1, seg: '', last: '', lastN: 0, note: '样本不足(n=1)' },
  },
  utility: {
    small: { all: '68%', n: 99, seg: '53-85%', last: '76%', lastN: 25, note: '随机等效' },
    add:   { all: '79%', n: 29, seg: '66-100%', last: '100%', lastN: 3, note: '' },
    heavy: { all: '100%', n: 11, seg: '100%', last: '100%', lastN: 7, note: '' },
  },
  energy: {
    small: { all: '74%', n: 98, seg: '33-96%', last: '68%', lastN: 69, note: '随机等效' },
    add:   { all: '61%', n: 59, seg: '51-100%', last: '65%', lastN: 26, note: '石化拖累' },
    heavy: { all: '69%', n: 52, seg: '60-88%', last: '88%', lastN: 17, note: '石化拖累' },
  },
  telecom: {
    small: { all: '', n: 0, seg: '', last: '', lastN: 0, note: '样本不足' },
    add:   { all: '', n: 0, seg: '', last: '', lastN: 0, note: '样本不足' },
    heavy: { all: '', n: 0, seg: '', last: '', lastN: 0, note: '样本不足' },
  },
};
/* 档位历史标注文案（P0-6）：
 * 输入 ind+档位；输出标注（"历史 65-100%（最近 91%，n=118）· 历史胜率≠本次会赢"）或 null */
function sigNote(ind, tierKey) {
  const st = SIG_STATS[ind] && SIG_STATS[ind][tierKey];
  if (!st || !st.n) return null;
  if (st.n < 10) return `历史样本不足（n=${st.n}）· 历史胜率≠本次会赢`;
  const segTxt = st.seg ? `${st.seg}` : '';
  const lastTxt = st.last ? `最近 ${st.last}%` : '';
  const noteTxt = st.note ? `· ${st.note}` : '';
  return `历史 1 年胜率 ${segTxt}（${lastTxt}，n=${st.n}）${noteTxt} · 历史胜率≠本次会赢`;
}

/* 国债锚（v1.9.13 溢价分位：触发比较 dy−国债；2026-08 近似 1.55%，正式源待接入 backlog） */
const TREASURY_NOW = 1.55;
const TIER_LINE = {
  '000001': { name: '平安银行', ind: 'bank', p75: 4.35, p90: 5.07, p95: 5.28, p90_1y: 3.99, cagr: 27.9, payout: 29, quality: '高增长', redLine: false, pending: false },
  '000333': { name: '美的集团', ind: 'consumer', p75: 3.22, p90: 3.88, p95: 4.03, p90_1y: 4.04, cagr: 19.8, payout: 69, quality: '高增长', redLine: false, pending: false },
  '000651': { name: '格力电器', ind: 'consumer', p75: 5.73, p90: 6.19, p95: 6.42, p90_1y: 6.43, cagr: -20.6, payout: null, quality: '负增长', redLine: false, pending: false },
  '000858': { name: '五粮液', ind: 'consumer', p75: 3.16, p90: 3.63, p95: 5.1, p90_1y: 5.18, cagr: 10.9, payout: 104, quality: '高增长', redLine: true, pending: false },
  '000895': { name: '双汇发展', ind: 'consumer', p75: 4.08, p90: 4.28, p95: 4.44, p90_1y: 4.38, cagr: -3.2, payout: 98, quality: '负增长', redLine: true, pending: false },
  '600016': { name: '民生银行', ind: 'bank', p75: 3.66, p90: 3.89, p95: 4.21, p90_1y: 3.88, cagr: -4.1, payout: 30, quality: '负增长', redLine: false, pending: false },
  '600027': { name: '华电国际', ind: 'utility', p75: 2.41, p90: 3.07, p95: 3.38, p90_1y: 3.41, cagr: 4.8, payout: 46, quality: '低增长', redLine: false, pending: false },
  '600028': { name: '中国石化', ind: 'energy', p75: 3.61, p90: 4.22, p95: 4.5, p90_1y: 3.48, cagr: -17.4, payout: 72, quality: '负增长', redLine: false, pending: false },
  '600036': { name: '招商银行', ind: 'bank', p75: 3.78, p90: 4.09, p95: 4.24, p90_1y: 3.82, cagr: 5.1, payout: 35, quality: '稳定增长', redLine: false, pending: false },
  '600188': { name: '兖矿能源', ind: 'energy', p75: 7.83, p90: 12.92, p95: 13.65, p90_1y: 4.47, cagr: -45.4, payout: 55, quality: '负增长', redLine: false, pending: false },
  '600519': { name: '贵州茅台', ind: 'consumer', p75: 1.98, p90: 2.2, p95: 2.51, p90_1y: 2.54, cagr: 26.1, payout: 77, quality: '高增长', redLine: false, pending: false },
  '600690': { name: '海尔智家', ind: 'consumer', p75: 2.19, p90: 3.79, p95: 4.07, p90_1y: 4.08, cagr: 27, payout: 51, quality: '高增长', redLine: false, pending: false },
  '600795': { name: '国电电力', ind: 'utility', p75: 2.79, p90: 3.38, p95: 3.51, p90_1y: 3.54, cagr: null, payout: 46, quality: '—', redLine: false, pending: false },
  '600886': { name: '国投电力', ind: 'utility', p75: 1.62, p90: 2.22, p95: 2.31, p90_1y: 2.31, cagr: 22.7, payout: 54, quality: '高增长', redLine: false, pending: false },
  '600887': { name: '伊利股份', ind: 'consumer', p75: 2.86, p90: 3.7, p95: 3.85, p90_1y: 3.87, cagr: 9.9, payout: 82, quality: '稳定增长', redLine: false, pending: false },
  '600900': { name: '长江电力', ind: 'utility', p75: 1.78, p90: 2.16, p95: 2.23, p90_1y: 2.24, cagr: 5.4, payout: 71, quality: '稳定增长', redLine: false, pending: false },
  '600941': { name: '中国移动', ind: 'telecom', p75: 4.49, p90: 4.97, p95: 5.06, p90_1y: null, cagr: 6.7, payout: 73, quality: '稳定增长', redLine: false, pending: true },
  '601088': { name: '中国神华', ind: 'energy', p75: 5.85, p90: 6.49, p95: 6.64, p90_1y: 4.38, cagr: -7.6, payout: 76, quality: '负增长', redLine: false, pending: false },
  '601166': { name: '兴业银行', ind: 'bank', p75: 4.56, p90: 5.08, p95: 5.36, p90_1y: 4.46, cagr: -3.5, payout: 31, quality: '负增长', redLine: false, pending: false },
  '601225': { name: '陕西煤业', ind: 'energy', p75: 8.37, p90: 9.6, p95: 10.11, p90_1y: 5.24, cagr: -24.2, payout: 57, quality: '负增长', redLine: false, pending: false },
  '601288': { name: '农业银行', ind: 'bank', p75: 3.82, p90: 4.11, p95: 4.86, p90_1y: 3.04, cagr: 3.9, payout: 32, quality: '低增长', redLine: false, pending: false },
  '601318': { name: '中国平安', ind: 'insurer', p75: 3.56, p90: 3.89, p95: 4, p90_1y: 3.58, cagr: 3.7, payout: 35, quality: '低增长', redLine: false, pending: false },
  '601328': { name: '交通银行', ind: 'bank', p75: 4.08, p90: 4.38, p95: 4.84, p90_1y: 3.65, cagr: -4.5, payout: 31, quality: '负增长', redLine: false, pending: false },
  '601398': { name: '工商银行', ind: 'bank', p75: 3.89, p90: 4.21, p95: 4.37, p90_1y: 2.87, cagr: 0.7, payout: 31, quality: '低增长', redLine: false, pending: false },
  '601601': { name: '中国太保', ind: 'insurer', p75: 1.78, p90: 2.16, p95: 2.31, p90_1y: 2.14, cagr: 4.1, payout: 22, quality: '低增长', redLine: false, pending: false },
  '601628': { name: '中国人寿', ind: 'insurer', p75: 0.04, p90: 0.71, p95: 0.84, p90_1y: 0.84, cagr: 20.4, payout: 16, quality: '高增长', redLine: true, pending: false },
  '601857': { name: '中国石油', ind: 'energy', p75: 3.83, p90: 4.27, p95: 5.07, p90_1y: 4.21, cagr: 3.6, payout: 53, quality: '低增长', redLine: false, pending: false },
  '601985': { name: '中国核电', ind: 'utility', p75: 0.27, p90: 0.51, p95: 0.56, p90_1y: 0.56, cagr: 1.9, payout: 37, quality: '低增长', redLine: false, pending: false },
  '601988': { name: '中国银行', ind: 'bank', p75: 3.52, p90: 3.9, p95: 4.44, p90_1y: 2.84, cagr: -0.8, payout: 31, quality: '负增长', redLine: false, pending: false },
};



/* P2 机会雷达（2026-08-18 大师裁决）：轻量三档定位——给定当前股息率+行业 → 落档 + 距加仓线差
 * 与 verdictEngine 同源（BENCH 零硬编码）；雷达展示用，不含价格换算（价格差易误导 M47 教训） */
/* P2 机会雷达（2026-08-18 大师裁决）：轻量三档定位——分位线优先，行业线兜底
 * v1.9.13 分位定线（2026-08-18 三轮定案）：三档线=个股近3年 dy 分布分位（小仓P75/加仓P90/重仓P95）
 * ——分位线=市场对分红可持续增长信心的定价（线高=信心低，工行 6.57；线低=信心高，移动 4.97）
 * ——行业线（BENCH）=数据不足（<3年日K）兜底 + 卡面参考；红线（支付率>90%/<20%）降级仅参考 */
function tierSpot(dy, industry, code) {
  const tl = code && TIER_LINE[code] ? TIER_LINE[code] : null;
  let mid, line, heavy, src = 'ind', redLine = false, shortSample = false, pending = false;
  if (tl) {
    /* v1.9.13 溢价分位：TIER_LINE 存溢价分位（pp），触发比较 dy−国债；回算 dy 口径供显示（+TREASURY_NOW）
     * 数学：dy ≥ p+国债 ⟺ dy−国债 ≥ p，等价判定 */
    if (tl.pending) {
      // 移动类：K线源故障，股息率线暂替——只展示不触发（大师第5轮）
      return { mid: tl.p75, line: tl.p90, heavy: tl.p95, cur: null, gapAdd: Math.max(0, tl.p90 - dy), src: 'pct-pending', redLine: !!tl.redLine, shortSample: true, pending: true, tl };
    }
    mid = tl.p75 + TREASURY_NOW; line = tl.p90 + TREASURY_NOW; heavy = tl.p95 + TREASURY_NOW;
    src = 'prem'; redLine = !!tl.redLine;
  } else {
    const yb = BENCH[industry];
    if (!yb || dy == null) return null;
    mid = yb.yieldMid; line = yb.yieldMid + yb.yieldUp; heavy = line + 1;
  }
  let cur;
  if (dy >= heavy) cur = 'heavy';
  else if (dy >= line) cur = 'add';
  else if (dy >= mid) cur = 'small';
  else cur = 'wait';
  return { mid, line, heavy, cur, gapAdd: Math.max(0, line - dy), src, redLine, shortSample, pending, tl };
}

/* O3 卖出信号轻量判定（2026-08-18）：自选卡角标用——只依赖 divs（1 请求），不依赖 kline（分位放大器属诊断页完整版）
 * 与 views.js renderSellSignals 的 epsConsec/divConsec 计算逐行同源（改动必须同步） */
function sellSignalQuick(divs) {
  const SELL_WINDOW_YEARS = 5;
  /* 2026-08-18 修复（主人令真实数据验证实锤）：EPS 同键后写覆盖=中报(06-30)覆盖年报(12-31)
   * → 一年两派后工行 2024=中报 0.47 vs 2023 年报 0.98 = 假 -52% 误报
   * 修：①年报优先（12-31 记录优先，中报仅兜底）②无年报财年不参与判定（宁缺勿误报）
   * ③收紧：最近两年年报同比连续为负才算（历史下滑已恢复的不算——平安 2021-22 案例） */
  const epsByYear = {}, epsAnnual = {};
  divs.forEach(d => {
    if (d.eps == null) return;
    const rep = d.report || ''; const y = rep.slice(0, 4);
    if (!y) return;
    const isAnnual = /-12-31$/.test(rep);
    if (isAnnual) { epsByYear[y] = d.eps; epsAnnual[y] = true; }
    else if (epsByYear[y] == null) epsByYear[y] = d.eps;   // 中报仅兜底（年报优先）
  });
  const years = Object.keys(epsByYear).sort();
  const epsTrend = [];
  for (let i = 1; i < years.length; i++) {
    const prev = epsByYear[years[i - 1]], cur = epsByYear[years[i]];
    if (prev != null && cur != null) epsTrend.push({ y: years[i], pct: (cur - prev) / prev * 100 });
  }
  const epsLastYear = years.length ? years[years.length - 1] : null;
  const epsWindowed = epsTrend.filter(t => epsLastYear != null && epsAnnual[t.y] && t.y >= epsLastYear - SELL_WINDOW_YEARS + 1);
  // 收紧：最近两个完整财年（年报口径）同比连续为负
  const epsBad = epsWindowed.length >= 2 && epsWindowed[epsWindowed.length - 1].pct < 0 && epsWindowed[epsWindowed.length - 2].pct < 0;
  const byYear = {};
  divs.forEach(d => { if (d.pending || !d.ex || !(d.dps > 0)) return; const y = (d.report || d.ex).slice(0, 4); byYear[y] = (byYear[y] || 0) + d.dps; });
  const ys = Object.keys(byYear).filter(y => byYear[y] > 0).sort();
  const yoy = [];
  for (let i = 1; i < ys.length; i++) { const prev = byYear[ys[i - 1]], cur = byYear[ys[i]]; yoy.push({ y: ys[i], pct: prev > 0 ? (cur - prev) / prev * 100 : null }); }
  const lastFullYear = ys.length ? ys[ys.length - 1] : null;
  const yoyWindowed = yoy.filter(t => lastFullYear != null && t.y >= lastFullYear - SELL_WINDOW_YEARS + 1);
  // 分红通道同收紧：最近两年同比连续为负
  const divBad = yoyWindowed.length >= 2 && yoyWindowed[yoyWindowed.length - 1].pct != null && yoyWindowed[yoyWindowed.length - 1].pct < 0 && yoyWindowed[yoyWindowed.length - 2].pct != null && yoyWindowed[yoyWindowed.length - 2].pct < 0;
  return { epsBad, divBad };
}

/* ---------- 对外导出 ---------- */
window.DL = {
  CALIB, fmt, fmtPct, $, todayStr, RateLimitedQueue, jsonp, fetchJson, loadSinaKline, loadQtQuotes,
  guessSec, emSecidOf, txCodeOf, toPush2, toPlain, parseSecInput,
  fetchName, fetchDividendsAll, fetchDividendsOne, parseDivs, dedupDividends, calcAnnualDivYield,
  tierSpot, sellSignalQuick, TIER_LINE,
  parseEtfAnnList, parseEtfAnnouncement, fetchEtfDividends,
  getKline, getMarketSnapshot, getStockQuotes, getIndexKline, ETF_PRESETS,
  Watchlist, cacheGet, cacheSet, cacheGetFresh,
  /* v1.9.0 新增：滚动分位/分红CAGR/除息锁定TTM/报告期归组 */
  calcRollingPercentile, calcDivCAGR, calcReportYearDivs, calcLockedTTM, ttmDivsAt, ttmDivsAtMode, computeZone, BENCH, roeBand,
  reportPeriodLabel, industryOf, verdictEngine, fetchF10Annual, trapFilter, sigNote, SIG_STATS,
  /* v1.9.1 新增：生态判定/起建线偏移/分位事件 */
  calcEcoType, findZoneEvents,
  /* v1.9.3 新增：分红趋势/档位五态分类/窗口预设 */
  calcDivTrend, classifyTier, DEFAULT_WINDOW_DAYS, WINDOW_PRESETS,
  calcFutureCashflow,
  /* v1.9.6 新增：结论行规则树 */
  divTrendBadAt, coverageAt, ruleVerdict, RULE_STATS, RULE_TIER_LABEL,
  /* v1.9.2 新增：组合级回测 */
  calcPortfolioBacktest,
}
})();
