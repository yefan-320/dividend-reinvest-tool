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
const $ = id => document.getElementById(id);
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
    script.src = url + '&' + paramName + '=' + cb;
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
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const t = setTimeout(() => { cleanup(); reject(new Error('请求超时')); }, timeout);
    function cleanup() { clearTimeout(t); script.remove(); }
    const old = window._sina_kline_;
    script.onload = () => { cleanup(); const d = window._sina_kline_; window._sina_kline_ = old; resolve(d); };
    script.onerror = () => { cleanup(); window._sina_kline_ = old; reject(new Error('网络错误')); };
    script.src = url;
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
function guessSec(code) {
  // 东财 secid: 沪 1.xxx / 深 0.xxx / 北 0.xxx(4/8/92开头)；腾讯: sh/sz/bj
  // 2026-08-16 修复：5开头=沪ETF(510/512/515/588)、1开头=深ETF(159xxx)、4/8/92=北交所
  if (/^6/.test(code)) return { em: '1.' + code, tx: 'sh' + code };
  if (/^5/.test(code)) return { em: '1.' + code, tx: 'sh' + code };   // 沪 ETF（512890 红利低波等）
  if (/^(0|3|1)/.test(code)) return { em: '0.' + code, tx: 'sz' + code };  // 深市 + 深ETF(159xxx)
  return { em: '0.' + code, tx: 'bj' + code };   // 北交所 4/8/92 开头
}
const emSecidOf = code => guessSec(code).em;
const txCodeOf = code => guessSec(code).tx;
/* push2 代码格式 sh600000 ↔ datacenter 600000 映射（P2-5） */
const toPush2 = code => guessSec(code).tx;
const toPlain = code => code.replace(/^(sh|sz|bj)/, '');

/* ---------- 股票名称 ---------- */
async function fetchName(code) {
  try {
    const d = await jsonp('https://searchapi.eastmoney.com/api/suggest/get?input=' + code + '&type=14&count=3', 'callback');
    const list = d && d.QuotationCodeTable && d.QuotationCodeTable.Data || [];
    const hit = list.find(x => x.Code === code) || list[0];
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
  const filter = `(SECURITY_CODE="${code}")`;
  const d = await emQueue.push(() => jsonp(
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${DIV_COLS}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent(filter)}`, 'callback'));
  const rows = (d && d.result && d.result.data) || [];
  const out = dedupDividends(parseDivs(rows));
  cacheSet('dv:' + code, { ts: Date.now(), data: out });   // P2-30: 供除权日缓存失效检查
  return out;
}

/* ---------- K线（腾讯主源分段 / 新浪备源；缓存走 IndexedDB） ---------- */
async function fetchKlineTx(txPrefix, start, end) {
  const map = {}; let cur = start; let guard = 0;
  while (cur < end && guard++ < 12) {
    const d0 = new Date(cur);
    const segEnd = new Date(Date.UTC(d0.getUTCFullYear() + 2, d0.getUTCMonth() + 6, d0.getUTCDate()));
    const endStr = segEnd > new Date(end) ? end : segEnd.toISOString().slice(0, 10);
    const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + txPrefix + ',day,' + cur + ',' + endStr + ',800,qfq';
    let rows = [];
    try {
      const d = await txQueue.push(() => fetchJson(url));
      const node = d && d.data && d.data[txPrefix];
      rows = (node && (node.qfqday || node.day)) || [];
    } catch (e) { /* 尝试下一段 */ }
    if (!rows.length) break;
    rows.forEach(r => { map[r[0]] = parseFloat(r[2]); });
    const last = rows[rows.length - 1][0];
    if (last >= end) break;
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
async function getKline(code, start, end) {
  // 缓存键：code+start（端日期不参与键，避免同段多次拉）
  const key = 'kl:' + code + ':' + start;
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
  const g = guessSec(code);
  let m = {};
  try { m = await fetchKlineTx(g.tx, start, end); } catch (e) { }
  if (!Object.keys(m).length) { try { m = await fetchKlineSina(g.tx); } catch (e) { } }
  if (Object.keys(m).length) await cacheSet(key, { ts: Date.now(), data: m });
  return m;
}

/* ---------- 行情快照（腾讯 qt 批量实时行情，JSONP 免 CORS；TTL 15分钟） ---------- */
/* 字段：1名称 2代码 3现价 39PE 44流通市值(亿) 45总市值(亿) 46PB */
function loadQtQuotes(codes, timeout = 15000) {
  const txList = codes.map(c => guessSec(c).tx).join(',');
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.charset = 'GBK';   // 腾讯接口 GBK 编码，必须指定否则名称乱码
    const t = setTimeout(() => { cleanup(); reject(new Error('行情请求超时')); }, timeout);
    function cleanup() { clearTimeout(t); script.remove(); }
    const olds = {};
    codes.forEach(c => { const v = 'v_' + guessSec(c).tx; olds[v] = window[v]; });
    script.onload = () => {
      cleanup();
      const out = {};
      codes.forEach(c => {
        const v = 'v_' + guessSec(c).tx;
        const raw = window[v] || ''; window[v] = olds[v];
        const p = String(raw).split('~');
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
      resolve(out);
    };
    script.onerror = () => { cleanup(); codes.forEach(c => { window['v_' + guessSec(c).tx] = olds['v_' + guessSec(c).tx]; }); reject(new Error('行情网络错误')); };
    script.src = 'https://qt.gtimg.cn/q=' + txList;
    document.head.appendChild(script);
  });
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
  { code: '000922', name: '中证红利', type: 'index' },
  { code: '000300', name: '沪深300', type: 'index' },
];
async function getIndexKline(code, start, end) {
  // 东财指数K线（全量），缓存复用 getKline 同层
  const key = 'ix:' + code + ':' + start;
  const hit = await cacheGetFresh(key, CALIB.CACHE_TTL.kline);
  if (hit) return hit.data;
  const secid = /^9/.test(code) ? '2.' + code : '1.' + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&beg=${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}`;
  const d = await emQueue.push(() => fetchJson(url));
  const map = {};
  ((d && d.data && d.data.klines) || []).forEach(k => { const p = k.split(','); map[p[0]] = parseFloat(p[2]); });
  if (Object.keys(map).length) await cacheSet(key, { ts: Date.now(), data: map });
  return map;
}

/* ---------- watchlist（P1-22 写路径统一） ---------- */
const WL_KEY = 'divtool:watchlist';
const Watchlist = {
  async list() {
    const s = await cacheGet(WL_KEY);
    return (s && s.data) || [];
  },
  async add(code, name, snapshot) {
    const list = await this.list();
    if (!list.find(x => x.code === code)) {
      list.push({ code, name: name || code, addedAt: Date.now(), snapshot: snapshot || null });
      await cacheSet(WL_KEY, { ts: Date.now(), data: list });
    }
    return list;
  },
  async remove(code) {
    const list = await this.list();
    const next = list.filter(x => x.code !== code);
    await cacheSet(WL_KEY, { ts: Date.now(), data: next });
    return next;
  },
  async updateSnapshot(code, snapshot) {
    const list = await this.list();
    const it = list.find(x => x.code === code);
    if (it) { it.snapshot = snapshot; await cacheSet(WL_KEY, { ts: Date.now(), data: list }); }
    return list;
  },
};

/* ---------- 对外导出 ---------- */
window.DL = {
  CALIB, fmt, fmtPct, $, todayStr, RateLimitedQueue, jsonp, fetchJson, loadSinaKline, loadQtQuotes,
  guessSec, emSecidOf, txCodeOf, toPush2, toPlain,
  fetchName, fetchDividendsAll, fetchDividendsOne, parseDivs, dedupDividends,
  getKline, getMarketSnapshot, getStockQuotes, getIndexKline, ETF_PRESETS,
  Watchlist, cacheGet, cacheSet, cacheGetFresh,
}
})();
