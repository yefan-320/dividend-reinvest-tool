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
    const timer = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, timeout);
    function cleanup() { clearTimeout(timer); script.remove(); try { delete window[cb]; } catch (e) { window[cb] = undefined; } }
    window[cb] = data => { cleanup(); resolve(data); };
    script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + paramName + '=' + cb;   // 2026-08-17：URL 无 query 时用 ?（曾写死 &，无 query 的 URL 会拼出裸 & 被拒）
    script.onerror = () => { cleanup(); reject(new Error('网络错误')); };
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
    if (pn > 20) break;   // 保险丝
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
  return emQueue.push(() => fetchJson(url));
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
      pn++;
    }
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
function ttmDivsAt(divs, dateStr) {
  // v1.9.1 P8 优化：预排序 + 二分（原实现每次全量 filter+sort，500 只标的性能 O(n·m) 不可接受）
  let c = _ttmCache.get(divs);
  if (!c) {
    const sorted = divs.filter(d => d.ex && d.dps > 0).sort((a, b) => a.ex < b.ex ? -1 : 1);
    const gaps = [];
    for (let i = 1; i < sorted.length && i <= 6; i++) gaps.push((new Date(sorted[i].ex) - new Date(sorted[i - 1].ex)) / 86400000);
    const med = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor((gaps.length - 1) / 2)] : 365;
    const perYear = Math.max(1, Math.min(12, Math.round(365 / Math.max(30, med))));
    c = { sorted, perYear };
    _ttmCache.set(divs, c);
  }
  // 二分：找 ex < dateStr 的最后一条
  let lo = 0, hi = c.sorted.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c.sorted[mid].ex < dateStr) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx < 0) return 0;
  let sum = 0;
  for (let i = 0; i < c.perYear && idx - i >= 0; i++) sum += c.sorted[idx - i].dps;
  return sum;
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
 * 返回 [{d, dy(平滑股息率%), pct(滚动分位 0-100)}]
 * 口径：TTM 滚动 366 天分红 ÷ 当日价（366 覆盖闰年）；5日均线平滑；滚动窗口=近 375 交易日；样本<250 天 pct=null */
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
  // 5 日均线平滑
  for (let i = 0; i < series.length; i++) {
    const lo = Math.max(0, i - 2), hi = Math.min(series.length - 1, i + 2);
    let s = 0, n = 0;
    for (let j = lo; j <= hi; j++) { s += series[j].dy; n++; }
    series[i].dyS = s / n;
  }
  // 滚动分位
  for (let i = 0; i < series.length; i++) {
    if (i < 250) { series[i].pct = null; continue; }
    const lo = Math.max(0, i - win + 1);
    const window = series.slice(lo, i + 1).map(x => x.dyS);
    const sorted = window.slice().sort((a, b) => a - b);
    const less = sorted.filter(v => v <= series[i].dyS).length;
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
  // 可等90（13）：年化等待收益>20pp/年（40只实证 R12）
  '600036': 'wait90', '601398': 'wait90', '601988': 'wait90', '000001': 'wait90',
  '600519': 'wait90', '000858': 'wait90', '601318': 'wait90', '601899': 'wait90',
  '601668': 'wait90', '600104': 'wait90', '600019': 'wait90', '600887': 'wait90', '600031': 'wait90',
  // 中性（6）：10-20pp/年，展示数字自决
  '600016': 'neutral', '000651': 'neutral', '601166': 'neutral', '601006': 'neutral', '601288': 'neutral', '600690': 'neutral',
  // 分红陷阱（6）：报告期归组连续2年下降（R14 修正后真名单：周期行业）
  '600188': 'trap', '600585': 'trap', '601225': 'trap', '600028': 'trap', '601390': 'trap', '601111': 'trap',
  // 低估值钝化（6）：分红健康但90档收益差（R14 误报纠正后）
  '601601': 'dull', '600795': 'dull', '000100': 'dull', '601985': 'dull', '600027': 'dull', '600886': 'dull',
};
const TIER_CLASS_LABEL = {
  wait90: { label: '可等90', color: '#3aa76d', detail: '历史等90档平均7个月、10年收益+18~22pp——可等更极端（年化等待收益>20pp/年）' },
  direct: { label: '80直接买', color: '#8fa69c', detail: '历史等90档年化收益<10pp/年或数据不足——80档即买，等90不值' },
  neutral: { label: '中性', color: '#5aa9e6', detail: '等90档年化收益10-20pp/年——按自身风险偏好自决（数字见详情）' },
  trap: { label: '⚠分红陷阱', color: '#e05a5a', detail: '分红连续2年下降（报告期归组）——高股息率分位=分红下调信号，全档位降权，建议回避/小仓' },
  dull: { label: '低估值钝化', color: '#d9a45b', detail: '分红健康但90档后价格长期不修复——等90意义小，80档建仓长期持有等均值回归' },
};
function classifyTier(code) {
  const cls = TIER_CLASS_TABLE[code] || 'direct';
  return { cls, ...TIER_CLASS_LABEL[cls] };
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
    return { zone: 'extreme', label: '95+ 极值确认', action: '当前仓位 ' + posTxt + ' · 历史 95 分位胜率 41/43 · 剩余 20% 现金可自决追加（不建议常规操作）', mode, pct, currentTier: tiers[tiers.length - 1], nextTier: null };
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

/* ---------- 对外导出 ---------- */
window.DL = {
  CALIB, fmt, fmtPct, $, todayStr, RateLimitedQueue, jsonp, fetchJson, loadSinaKline, loadQtQuotes,
  guessSec, emSecidOf, txCodeOf, toPush2, toPlain, parseSecInput,
  fetchName, fetchDividendsAll, fetchDividendsOne, parseDivs, dedupDividends, calcAnnualDivYield,
  parseEtfAnnList, parseEtfAnnouncement, fetchEtfDividends,
  getKline, getMarketSnapshot, getStockQuotes, getIndexKline, ETF_PRESETS,
  Watchlist, cacheGet, cacheSet, cacheGetFresh,
  /* v1.9.0 新增：滚动分位/分红CAGR/除息锁定TTM/报告期归组 */
  calcRollingPercentile, calcDivCAGR, calcReportYearDivs, calcLockedTTM, computeZone,
  /* v1.9.1 新增：生态判定/起建线偏移/分位事件 */
  calcEcoType, findZoneEvents,
  /* v1.9.3 新增：分红趋势/档位五态分类/窗口预设 */
  calcDivTrend, classifyTier, DEFAULT_WINDOW_DAYS, WINDOW_PRESETS,
  /* v1.9.2 新增：组合级回测 */
  calcPortfolioBacktest,
}
})();
