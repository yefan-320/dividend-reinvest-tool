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
/* P111/P123（2026-08-21）：本地日期工具——全站禁用 toISOString 截日期（UTC 差一天，深夜 0-8 点起点变昨天） */
const fmtDate = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const fmtMonth = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return fmtDate(d); };

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

/* W10（2026-08-21）：数据源状态记录——渲染层徽章三态（实时 net/缓存 cache/降级 fallback）
 * 不改返回结构（下游大量依赖），独立日志表供徽章读取 */
const _srcLog = {};
function srcMark(key, s) { _srcLog[key] = { s, ts: Date.now() }; }
function srcOf(key) { const v = _srcLog[key]; return v || null; }
function srcLogAll() { return Object.keys(_srcLog).map(k => Object.assign({ key: k }, _srcLog[k])); }

/* ---------- v2.0 批次1：#9 异常分级（防狼来了） ----------
 * major（全挂）=横幅 / mid（缓存）=标注 / minor（备源降级）=小字
 * 输入：key（srcLog key）、有缓存？ */
function dataHealthLevel(key, hasCache) {
  const r = _srcLog[key];
  if (!r) return hasCache ? { level: 'mid', msg: '数据来自缓存（来源待刷新）' } : { level: 'major', msg: '数据源全挂：无实时无缓存' };
  if (r.s === 'fallback') return { level: 'minor', msg: '数据来自备源（新浪降级）' };
  if (r.s === 'proxy') return { level: 'minor', msg: '数据经代理获取' };
  if (r.s === 'cache') return { level: 'mid', msg: '数据来自缓存' };
  return { level: 'ok', msg: '' };
}

/* ---------- v2.0 批次1：#6 运行时口径自检核心（?debug=caliber 用） ----------
 * 返回 { key, caliber, func, ok }[]——遍历 srcLog + 已知口径函数表，核对标注×实现
 * 外部 TTM 豁免：ETF/基金无报告期 → TTM 口径合法 */
function caliberAudit() {
  const CALIBER_FUNCS = {
    'annual-2y': ['calcAnnualDivYield', 'reportYearDivAt', 'latestAnnouncedYear'],
    'report-year': ['reportYearDivAt', 'calcReportYearDivs', 'calcDivCAGR', 'ttmDivsAtMode'],
    'ttm': ['ttmDivsAt', 'ttmDivsAtMode'],
    'locked-ttm': ['calcLockedTTM'],
  };
  const rows = [];
  Object.keys(_srcLog).forEach(key => {
    const r = _srcLog[key];
    rows.push({ key, caliber: r.caliber || (r.s === 'cache' ? 'cache' : 'net'), func: '—', ok: true });
  });
  Object.keys(CALIBER_FUNCS).forEach(cal => {
    CALIBER_FUNCS[cal].forEach(fn => {
      rows.push({ key: fn, caliber: cal, func: fn, ok: typeof DL[fn] === 'function' });
    });
  });
  return rows;
}

/* P39（2026-08-21）：IndexedDB 缓存卫生——>7天 且 >50MB 才 prune（防误删高频小缓存），
 * 删除 7 天前写入的 key（30 天访问 key 保留策略：ts=写入时间，保留近 7 天；高频 key 会持续刷新 ts） */
async function cachePrune() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const entries = await new Promise((res, rej) => {
      const out = [];
      const cur = store.openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c) { out.push({ key: c.key, val: c.value }); c.continue(); } else res(out); };
      cur.onerror = () => rej(cur.error);
    });
    if (!entries.length) return;
    const total = entries.reduce((s, e) => s + JSON.stringify(e.val).length, 0);
    if (total < 50 * 1024 * 1024) return;   // <50MB 不动
    const now = Date.now();
    const delTx = db.transaction(STORE, 'readwrite');
    entries.forEach(e => { const ts = (e.val && e.val.ts) || 0; if (now - ts > 7 * 86400000) delTx.objectStore(STORE).delete(e.key); });
    await new Promise((res, rej) => { delTx.oncomplete = res; delTx.onerror = () => rej(delTx.error); });
  } catch (e) { /* 卫生清理失败不影响主流程 */ }
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
/* ---------- 清洗层三级（2026-08-21 大师裁决 B：单位/行业/逻辑三级） ----------
 * 1. 单位级（硬拦截）：dps 单笔 > 30 元 → 疑似“每10股未除10”（茅台 27.6 是真实每股，上限 30 放过）
 *    且与历史均值比 >8 倍 → 必错，剔除（8/20 宇通/移动 618% 根因）
 * 2. 行业级（警告标注）：股息率超行业合理区间 → 标注 suspicious（不剔除，防误杀真高息）
 * 3. 逻辑级（硬拦截）：除息日非法、DPS 为负/超限 → 必错，剔除
 */
function sanitizeDividends(code, divs) {
  const out = (divs || []).map(d => ({ ...d }));
  const valid = out.filter(d => d.ex && d.dps > 0);
  if (!valid.length) return out;
  const dropped = [];
  // 逻辑级：除息日格式 + dps 范围
  const logical = valid.filter(d => {
    const okDate = /^\d{4}-\d{2}-\d{2}$/.test(d.ex || '');
    const okDps = d.dps > 0 && d.dps < 1000;
    if (!okDate) dropped.push({ report: d.report, ex: d.ex, dps: d.dps, reason: '除息日非法' });
    else if (!okDps) dropped.push({ report: d.report, ex: d.ex, dps: d.dps, reason: 'DPS超限' });
    return okDate && okDps;
  });
  // 单位级：单笔异常大 → 对比历史均值（8/20 漏除10 根因：单笔 10x 历史）
  const mean = logical.reduce((s, d) => s + d.dps, 0) / Math.max(1, logical.length);
  const unitOk = logical.filter(d => {
    const ok = d.dps <= 30 || d.dps <= mean * 8;
    if (!ok) dropped.push({ report: d.report, ex: d.ex, dps: d.dps, reason: '单笔异常大(' + d.dps + ' vs 均值' + mean.toFixed(2) + ')' });
    return ok;
  });
  // 行业级：股息率合理区间（警告不剔除）——按 TIER_LINE 行业
  const ind = (DL.TIER_LINE && DL.TIER_LINE[code] && DL.TIER_LINE[code].ind) || '';
  const IND_RANGE = { bank: [0, 8], consumer: [0, 10], manufacture: [0, 10], telecom: [0, 8], energy: [0, 15], utility: [0, 12] };
  const range = IND_RANGE[DL.SIG_STATS && DL.SIG_STATS[ind] ? ind : ''] || [0, 15];
  const suspicious = [];
  const withSusp = unitOk.map(d => {
    if (d.exPrice && d.dps / d.exPrice * 100 > range[1] * 3) { d.suspicious = true; suspicious.push({ report: d.report, ex: d.ex, dps: d.dps }); }
    return d;
  });
  /* #7 数据源头校验（v2.0 批次1）：剔除留标记——UI 警示"该年分红异常已剔除" */
  if (dropped.length) withSusp._dropped = dropped;
  if (suspicious.length) withSusp._suspicious = suspicious;
  return withSusp;
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
  const cleaned = sanitizeDividends(code, out);   // 2026-08-21 清洗层三级（大师裁决 B）
  cacheSet('dv:' + code, { ts: Date.now(), data: cleaned });   // P2-30: 供除权日缓存失效检查
  srcMark(code + ':div', 'net');   // W10：实时拉取成功
  return cleaned;
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
  // 实时抓取段（2026-08-18 加总超时预算：512890 无分红公告时 allorigins 链路可挂 30s+，拖卡加自选/诊断）
  const REALTIME_BUDGET = 10000;   // 10s 总预算，超时=数据暂缺（null），不阻塞 UI
  const realtime = (async () => {
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
  })();
  return await Promise.race([
    realtime,
    new Promise(res => setTimeout(() => res(null), REALTIME_BUDGET)),
  ]);
}

/* ---------- K线（腾讯主源分段 / 新浪备源；缓存走 IndexedDB） ---------- */
async function fetchKlineTx(txPrefix, start, end) {
  const map = {}; let cur = start; let guard = 0; let prevLast = null;
  // 2026-08-21 主人抓 R2 卡死（90s 超时）：腾讯 K线白天被风控挂起（Chrome 无 Cookie/UA 被拒），无总预算时
  // 5 段 × 15s 超时 = 200s+ 才转新浪备源（1.4s 即成功）→ 加 25s 总预算：腾讯不通时快速失败切备源，腾讯通时不受影响（每段 <1s）
  const BUDGET = 12000, t0 = Date.now();
  while (cur < end && guard++ < 12 && Date.now() - t0 < BUDGET) {
    const d0 = new Date(cur);
    const segEnd = new Date(Date.UTC(d0.getUTCFullYear() + 2, d0.getUTCMonth() + 6, d0.getUTCDate()));
    const endStr = segEnd > new Date(end) ? end : fmtDate(segEnd);
    // v1.7.2: 必须用不复权(真实价)K线！回测模型自带分红复投，前复权价已折算分红 → 双重计算虚高
    // 实测：2016-08-16 真实价 18.31 vs qfq 4.419（差 4 倍）；qfq 导致持股/总资产/累计投入全部虚高
    const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + txPrefix + ',day,' + cur + ',' + endStr + ',800,';
    let rows = [];
    try {
      // 2026-08-21 R6 修复：不走 txQueue（maxRetry=2 → 每段 8s×3+退避=27s，且队列全局串行让多标的互相排队 160s+）
      // 腾讯被风控挂起时重试无意义 → 单次请求 8s 超时立即失败；BUDGET 兜底总时长；恢复后段间由 BUDGET+段数自然限流
      const d = await fetchJson(url, 8000);
      const node = d && d.data && d.data[txPrefix];
      rows = (node && node.day) || [];
    } catch (e) { /* 尝试下一段 */ }
    if (!rows.length) {
      // v1.8.2 修复：上市晚的标的（515080 2019 上市），起点前段为空 → 跳过该段继续，不提前终止（曾致 10 年周期下无数据）
      const nd = new Date(segEnd); nd.setDate(nd.getDate() + 1);
      cur = fmtDate(nd);
      continue;
    }
    rows.forEach(r => { map[r[0]] = parseFloat(r[2]); });
    const last = rows[rows.length - 1][0];
    if (last >= end) break;
    // v1.7.3: 区间末尾遇周末/节假日无交易时，同一 last 不再前进 → 提前终止（防重复请求耗限流配额）
    if (last === prevLast) break;
    prevLast = last;
    const nd = new Date(last); nd.setDate(nd.getDate() + 1);
    cur = fmtDate(nd);
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
  if (hit) { srcMark(code + ':k', 'cache'); return hit.data; }
  const g = guessSec(code, market);
  let m = {};
  try { m = await fetchKlineTx(g.tx, start, end); } catch (e) { }
  if (!Object.keys(m).length) { try { m = await fetchKlineSina(g.tx); } catch (e) { } }
  if (Object.keys(m).length) { await cacheSet(key, { ts: Date.now(), data: m }); srcMark(code + ':k', 'net'); }
  else { srcMark(code + ':k', 'fallback'); }
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
  if (hit) { srcMark('qt:' + codes.join(','), 'cache'); return hit.data; }
  let out = {};
  // 2026-08-21：不走 txQueue（maxRetry=2 → 快照失败 15s×3+退避=47s，拖垮对比页/加自选）；单次 8s，失败即返回空（调用方 K线末价兑底）
  try { out = await loadQtQuotes(codes, 8000); } catch (e) { }
  if (Object.keys(out).length) { await cacheSet(key, { ts: Date.now(), data: out }); srcMark('qt:' + codes.join(','), 'net'); }
  else { srcMark('qt:' + codes.join(','), 'fallback'); }
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
  divs = alignSendZhuan(divs);   // F8 送转对齐（2026-08-20）
  divs = splitSpecialDivs(divs); // F4 特别分红拆分（2026-08-20）：用经常性 regular
  const years = {};
  divs.forEach(d => {
    if (d.pending || !d.ex || !d.report) return;
    const y = d.report.slice(0, 4);
    if (!y) return;
    years[y] = (years[y] || 0) + (d.regular != null ? d.regular : d.dps);
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
/* F8 送转勘误（2026-08-20 方案 v9.2 落地）：送转年后 DPS 按新股本公告 → 与送转年前不可比
 * 实测案例：宁德时代 2022年报 10转8（DPS 2.52，除权前股本24.4亿）→ 2023年报 DPS 2.011（股本44亿）
 *   用 DPS 看分红 -20%（假下降）；总分红口径 +44%（61.5→88.5亿）——工具原算法 dy 虚降 20% → 触发失真
 * 修复：折算到"当前股本"口径——送转除权日之前（含该笔自身）的 DPS 除以累计送转因子
 * 输出：对齐后的副本数组（不修改原数组）
 */
function alignSendZhuan(divs) {
  const list = (divs || [])
    .filter(d => !d.pending && d.ex && d.dps > 0)
    .map(d => ({ ...d }))
    .sort((a, b) => (a.ex || '') < (b.ex || '') ? -1 : 1);
  let factor = 1; // 当前股本倍数（1=最新股本）
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (d.bonus > 0) {
      factor *= (1 + d.bonus);      // 该笔之前的更旧股本
      d.dps = d.dps / (1 + d.bonus); // 该笔自身按旧股本公告 → 折算
      d.bonus = 0;                  // 已折算 → 清 0（幂等：二次对齐不再重复折算）
    } else {
      d.dps = d.dps / factor;        // 折算到当前股本口径
    }
  }
  return list;
}

/* F4 DPS 拆分（2026-08-20 方案 v9.2 盲区13 落地）：经常性(年度常规) vs 特别(一次性)
 * 问题：大额特别分红（兖矿 2022年报 DPS 3.07 含特别派息，次年回归 1.49）→ dy 虚高 → 触发价/分位线失真
 * 检测：报告期 DPS > 该股历史中位数 × 2 → 判定含特别分红
 * 拆分：经常性 = 中位数（保守），特别 = DPS − 中位数（标注展示）
 * 使用：TTM/分位线/触发价用经常性 DPS（与方案盲区13一致）
 * 输入：已 F8 对齐的 divs；输出：每笔附 regular（经常性）字段
 */
function splitSpecialDivs(divs) {
  const list = (divs || []).map(d => ({ ...d }));
  // 报告期归组 → 各年 DPS
  const byY = {};
  list.forEach(d => { if (d.report && !d.pending && d.dps > 0) { const y = d.report.slice(0, 4); byY[y] = (byY[y] || 0) + d.dps; } });
  const years = Object.keys(byY).map(Number).sort((a, b) => a - b);
  if (years.length < 4) { list.forEach(d => d.regular = d.dps); return list; } // 样本不足不拆
  // 2026-08-21 F4 重写（原“全历史中位数×2”误伤长期递增股——招行近5年全被拆成特别分红）：
  //   正确判据=当年 DPS vs 相邻年（前后各≤2年）均值，跳升 ≥80% 才算特别分红（兖矿 2022: 3.07 vs 邻年 1.55 = 2.0x ✓；招行 2024: 2.0 vs 邻年 1.97 = 1.02x ✗）
  const idx = {}; years.forEach((y, i) => idx[y] = i);
  const isSpecial = {};
  years.forEach((y, i) => {
    const v = byY[y];
    const neighbors = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(years.length - 1, i + 2); j++) {
      if (j !== i) neighbors.push(byY[years[j]]);
    }
    const nb = neighbors.filter(x => x > 0);
    const nbAvg = nb.length ? nb.reduce((s, x) => s + x, 0) / nb.length : 0;
    isSpecial[y] = nbAvg > 0 && v > nbAvg * 1.8;   // 跳升≥80%
  });
  list.forEach(d => {
    if (!d.report || d.pending || !(d.dps > 0)) { d.regular = d.dps; return; }
    const y = d.report.slice(0, 4);
    if (isSpecial[y]) {
      // 该报告期含特别分红：经常性=邻年均值，特别=当年−邻年均值（按比例摊到该期各笔）
      const nb = [];
      const i = idx[y];
      for (let j = Math.max(0, i - 2); j <= Math.min(years.length - 1, i + 2); j++) {
        if (j !== i) nb.push(byY[years[j]]);
      }
      const nbF = nb.filter(x => x > 0);
      const base = nbF.length ? nbF.reduce((s, x) => s + x, 0) / nbF.length : 0;
      const ratio = base > 0 && byY[y] > 0 ? base / byY[y] : 1;
      d.regular = d.dps * ratio;
      d.special = d.dps - d.regular;
    } else {
      d.regular = d.dps;
      d.special = 0;
    }
  });
  return list;
}

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
  /* 2026-08-21 主人抓"平安缩水-26%"是假数据：calcReportYearDivs 含未完成财年（2026 只有中期 0.98，年报未派）
   * → lastY=2026 分子只算 0.98 → 假缩水。修复：只保留有年报(-12-31)记录的完整财年 */
  const ys = calcReportYearDivs(divs).filter(y =>
    divs.some(d => (d.report || '').slice(0, 4) === y && /-12-31$/.test(d.report || '') && !d.pending));
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
    divs = alignSendZhuan(divs);   // F8 送转对齐（2026-08-20）
    divs = splitSpecialDivs(divs); // F4 特别分红拆分（2026-08-20）
    const sorted = divs.filter(d => d.ex && d.dps > 0).sort((a, b) => a.ex < b.ex ? -1 : 1);
    const byRepYear = {};
    divs.forEach(d => {
      if (!d.report || d.pending || !(d.dps > 0)) return;
      const y = d.report.slice(0, 4);
      if (!byRepYear[y]) byRepYear[y] = { sum: 0, hasAnnual: false };
      byRepYear[y].sum += (d.regular != null ? d.regular : d.dps);
      if (/-12-31$/.test(d.report)) byRepYear[y].hasAnnual = true;
    });
    c = { sorted, byRepYear };
    _ttmCache.set(divs, c);
  }
  const yearNow = parseInt(dateStr.slice(0, 4), 10);
  // v1.9.27 前瞻口径（主人钦定 2026-08-21：股票本来就是预测未来，公告就算数）：
  //   B 口径=“已公告”的最近完整财年（planNotice ≤ dateStr，预案公告即算；无 planNotice 时退回 ex ≤ dateStr）
  //   ——已公告未派发计入（宇通 2026-04-01: 2025末期 plan=2026-03-31 已公告 → 2.5 计入 ✓）；
  //   ——未公告不计入（宇通 2023-01-03: 2022年报 plan=2023-03-28 未公告 → 仍只算 0.5，13% bug 不复发）
  const completeYears = Object.keys(c.byRepYear).map(Number)
    .filter(y => c.byRepYear[y].hasAnnual && y < yearNow)
    .sort((a, b) => b - a);
  if (completeYears.length) {
    for (const y of completeYears) {
      const yrDivs = divs.filter(d => d.report && d.report.startsWith(String(y)) && d.dps > 0);
      const announced = yrDivs.length > 0 && yrDivs.every(d =>
        (d.planNotice && d.planNotice <= dateStr) || (!d.planNotice && d.ex && d.ex <= dateStr));
      if (announced) {
        const bVal = yrDivs.reduce((s, d) => s + (d.regular != null ? d.regular : d.dps), 0);
        if (bVal > 0) return { v: bVal, mode: 'B' };
      }
    }
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
/* M304（2026-08-21 大师裁定）：最近已公告完整财年——供空窗期 UI 提示（"最新年报未出，基于 XX 财年"）
 * 返回数字年份（如 2024）；无任何已公告完整财年时返回 null */
function latestAnnouncedYear(divs, dateStr) {
  divs = alignSendZhuan(divs);
  divs = splitSpecialDivs(divs);
  const byRepYear = {};
  divs.forEach(d => {
    if (!d.report || d.pending || !(d.dps > 0)) return;
    const y = d.report.slice(0, 4);
    if (!byRepYear[y]) byRepYear[y] = { sum: 0, hasAnnual: false };
    byRepYear[y].sum += (d.regular != null ? d.regular : d.dps);
    if (/-12-31$/.test(d.report)) byRepYear[y].hasAnnual = true;
  });
  const yearNow = parseInt(dateStr.slice(0, 4), 10);
  const completeYears = Object.keys(byRepYear).map(Number)
    .filter(y => byRepYear[y].hasAnnual && y < yearNow)
    .sort((a, b) => b - a);
  for (const y of completeYears) {
    const yrDivs = divs.filter(d => d.report && d.report.startsWith(String(y)) && d.dps > 0);
    const announced = yrDivs.length > 0 && yrDivs.every(d =>
      (d.planNotice && d.planNotice <= dateStr) || (!d.planNotice && d.ex && d.ex <= dateStr));
    if (announced) return y;
  }
  return null;
}
function reportYearDivAt(divs, dateStr) {
  /* 2026-08-21 主人抓"宇通股息率上蹿下跳"：带状图原用 ttmDivsAt（含 A 兜底 366 天滚动窗口）
   * A 窗口在一年多派时滑入滑出混 1.5 个财年 → 分子翻倍跳变 → 曲线锯齿
   * 修复：纯报告期口径——每点分子=最近完整财年（报告期归组）分红合计，无 A 兜底
   * 前瞻保留（v1.9.27 钦定：公告即算）；返回 0=无完整财年（调用方显示断档） */
  divs = alignSendZhuan(divs);
  divs = splitSpecialDivs(divs);
  const byRepYear = {};
  divs.forEach(d => {
    if (!d.report || d.pending || !(d.dps > 0)) return;
    const y = d.report.slice(0, 4);
    if (!byRepYear[y]) byRepYear[y] = { sum: 0, hasAnnual: false };
    byRepYear[y].sum += (d.regular != null ? d.regular : d.dps);
    if (/-12-31$/.test(d.report)) byRepYear[y].hasAnnual = true;
  });
  const yearNow = parseInt(dateStr.slice(0, 4), 10);
  const completeYears = Object.keys(byRepYear).map(Number)
    .filter(y => byRepYear[y].hasAnnual && y < yearNow)
    .sort((a, b) => b - a);
  /* 2026-08-21：最近已公告完整财年——最新财年未全公告（年报预案未出）时往前找，
   * 避免空窗期返回 0 断档（宇通 2025-01~04：2024 财年待公告 → 用 2023 财年 1.5，曲线连续） */
  for (const y of completeYears) {
    const yrDivs = divs.filter(d => d.report && d.report.startsWith(String(y)) && d.dps > 0);
    const announced = yrDivs.length > 0 && yrDivs.every(d =>
      (d.planNotice && d.planNotice <= dateStr) || (!d.planNotice && d.ex && d.ex <= dateStr));
    if (announced) {
      const bVal = yrDivs.reduce((s, d) => s + (d.regular != null ? d.regular : d.dps), 0);
      if (bVal > 0) return bVal;
    }
    /* 未全公告 → 继续往前找更早的已公告完整财年（曲线不跳不断） */
  }
  return 0;
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
  // 2026-08-21 主人拍板（宇通一年多派暴露）：决策信号去 A 兜底，改纯报告期口径
  // 原 ttmDivsAt = B主（财年归组）+ A兜底（366天滚动窗口）——A 触发时分子混 1.5 财年
  // → 分位序列里一部分点用"财年尺"、一部分用"12个月到账尺"，尺子不统一，分位失真
  // 改 reportYearDivAt（纯报告期）：每点=最近已公告完整财年分红÷当日价，全序列同一把尺子
  // 除息锁定 calcLockedTTM 一并去掉：报告期口径分子不在除息日跳变（只在公告日切），锁定已无必要
  const series = [];
  dates.forEach(d => {
    const price = kline[d];
    if (!(price > 0)) return;
    const t = reportYearDivAt(divs, d);
    if (t > 0) series.push({ d, dy: t / price * 100 });
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
  wait90: { label: '可等90型', color: '#3aa76d', detail: '详见下方权衡提示（建议词仅个股提示一处）' },
  direct: { label: '80直接买', color: '#8fa69c', detail: '历史等90档年化收益<10pp/年或数据不足——80档即买，等90不值' },
  neutral: { label: '中性', color: '#5aa9e6', detail: '等90档年化收益10-20pp/年——按自身风险偏好自决（数字见详情）' },
  trap: { label: '⚠分红陷阱', color: '#e05a5a', detail: '分红连续2年下降（报告期归组）——高股息率分位=分红下调信号，全档位降权，建议回避/小仓' },
  dull: { label: '低估值钝化', color: '#d9a441', detail: '分红健康但90档后价格长期不修复——等90意义小，80档建仓长期持有等均值回归' },
};
function classifyTier(code) {
  const row = TIER_CLASS_TABLE[code];
  const cls = row ? row[0] : 'direct';
  const base = TIER_CLASS_LABEL[cls];
  const profile = row && row.length > 1 ? { annual: row[1], gap90: row[2], diff: row[3] } : null;
  return { cls, ...base, profile };
}

/* M5 分红预测引擎（决策点4·阶段3·2026-08-20 落地）
 * 三情景 DPS 区间：输入=历史分红序列+覆盖率+周期定位；输出=保守/中性/乐观 DPS+股息率
 * 方法（宇通研究同源）：
 *   乐观 = 最近年度 DPS（近1年派息能力）
 *   中性 = 近7年周期均值 DPS（周期真锤）
 *   保守 = 近10年周期均值 DPS（含底部年份，周期底锚）
 * 注：数据不足（<3年）→ 只给最近年度，不假装有区间（8/18 原则）
 */
function divForecast(divs, price) {
  if (!divs || !divs.length) return null;
  const ys = {};
  divs.forEach(d => {
    if (d.pending || !(d.dps > 0) || !d.ex) return;
    const y = d.ex.slice(0, 4);
    ys[y] = (ys[y] || 0) + d.dps;
  });
  const years = Object.keys(ys).sort();
  if (years.length < 1) return null;
  const lastY = years[years.length - 1];
  const lastDps = ys[lastY];
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const last10 = years.slice(-10).map(y => ys[y]);
  const last7 = years.slice(-7).map(y => ys[y]);
  const base = avg(last10);        // 保守：十年周期均值（含底部）
  const mid = avg(last7);         // 中性：七年周期均值
  const opt = lastDps;            // 乐观：最近年度实际派息
  const p = price > 0 ? price : null;
  const fmt = v => v.toFixed(2) + ' 元' + (p ? `（股息率 ${(v / p * 100).toFixed(1)}%）` : '');
  return {
    years: { last: lastY, n: years.length },
    dps: { conservative: +base.toFixed(2), base: +mid.toFixed(2), optimistic: +opt.toFixed(2) },
    text: { conservative: fmt(base), base: fmt(mid), optimistic: fmt(opt) },
    note: years.length < 7 ? '数据不足7年：区间参考性弱，仅展示最近年度派息' : null
  };
}

/* ---------- v2.0 批次3：#12 退休时间点模拟 ----------
 * 输入：annualDivNow(当前年分红元), cagr(分红增速), inflation(通胀), monthlyExp(月支出元)
 * 逐年推：覆盖率 = 年分红×(1+cagr)^y / (月支出×12×(1+通胀)^y)
 * 返回 { 达标年, 表 }；永不达标 → 达标年=null + 提示 */
function retirementSim(annualDivNow, cagr, inflation, monthlyExp, yearsMax) {
  const Y = yearsMax || 30;
  if (!(annualDivNow > 0) || !(monthlyExp > 0)) return null;
  const rows = [];
  let hit = null;
  for (let y = 0; y <= Y; y++) {
    const div = annualDivNow * Math.pow(1 + cagr, y);
    const exp = monthlyExp * 12 * Math.pow(1 + inflation, y);
    const cov = div / exp * 100;
    rows.push({ y, div, exp, cov });
    if (hit == null && cov >= 100) hit = y;
  }
  return { hitYear: hit, rows };
}

/* ---------- v2.0 批次3：#13 反向本金（要月支出 W 需本金 X） ----------
 * 双答案：当前股息率（dyCur）/ 预期股息率（dyExp，默认 5%） */
function requiredPrincipal(monthlyExp, dyCur, dyExp) {
  if (!(monthlyExp > 0)) return null;
  const annual = monthlyExp * 12;
  const d = dyCur || 0.05;
  const e = dyExp || 0.05;
  return {
    atCurrent: annual / d,
    atExpected: annual / e,
    dyCur: d,
    dyExp: e,
  };
}

/* ---------- v2.0 批次2：#1 决策语言（组合级，M373：Σ每股DPS×股数） ----------
 * pool: [{ code, name, shares, price, divs }]
 * opts: { yearsN(默认5), monthlyExp, cagrAssumption(默认0.08中性) }
 * 三情景 = divForecast 每股 DPS 三情景 × 股数 × (1+cagr)^N（分红增长）
 */
function decisionSentence(pool, opts) {
  const o = opts || {};
  const yearsN = o.yearsN || 5;
  const cagr = o.cagrAssumption != null ? o.cagrAssumption : 0.08;
  const monthlyExp = o.monthlyExp || 0;
  if (!pool || !pool.length) return null;
  let invest = 0, cons = 0, base = 0, opt = 0, divsN = 0;
  const grow = Math.pow(1 + cagr, yearsN);
  pool.forEach(p => {
    const shares = p.shares || 0;
    if (p.price > 0) invest += shares * p.price;
    const f = divForecast(p.divs, p.price);
    if (!f) return;
    cons += f.dps.conservative * shares;
    base += f.dps.base * shares;
    opt += f.dps.optimistic * shares;
    divsN++;
  });
  if (!divsN || !invest) return null;
  const consY = cons * grow, baseY = base * grow, optY = opt * grow;
  const cov = monthlyExp > 0 ? (baseY / 12) / monthlyExp * 100 : null;
  return {
    invest, yearsN, cagr,
    annual: { conservative: consY, base: baseY, optimistic: optY },
    monthly: { conservative: consY / 12, base: baseY / 12, optimistic: optY / 12 },
    coverage: cov,
    sentence: `投入 ${(invest / 10000).toFixed(1)} 万，${yearsN} 年后中性每年分红 ${(baseY / 10000).toFixed(1)} 万（保守 ${(consY / 10000).toFixed(1)} ~ 乐观 ${(optY / 10000).toFixed(1)}）${cov != null ? '覆盖月支出 ' + cov.toFixed(0) + '%' : ''}`,
  };
}

/* ---------- v2.0 批次2：#2 无风险基准对比（吃分红 vs 存银行） ----------
 * 输入：组合市值 + 年分红；输出对比（名义口径未扣通胀） */
function riskFreeCompare(marketValue, annualDiv, treasuryNow) {
  const t = treasuryNow != null ? treasuryNow : TREASURY_NOW;
  const bank = marketValue * t / 100;
  return {
    treasury: t,
    bankAnnual: bank,
    divAnnual: annualDiv,
    diff: annualDiv - bank,
    better: annualDiv >= bank ? '分红' : '国债',
    note: '名义口径·未扣通胀',
  };
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
    const m = fmtMonth(estEx);
    const code = d.code;
    const shares = (holdings && holdings[code]) || 0;
    const dup = (byMonth[m] || []).some(x => x.code === code && !x.est);
    if (dup) return;
    push(m, { code, name: d.name, ex: fmtDate(estEx), dps: d.dps, shares, est: true });
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
    /* v1.9.15 情绪反色（大师 M2）：极值区=股息率历史高位=估值低位=买点区，非风险警示；仓位纪律保留、风险色删除 */
    return { zone: 'extreme', label: '95+ 极值区（股息率历史高位=估值低位）', action: '当前仓位 ' + posTxt + ' · 历史 95+ 分位 3 年胜率 97/133 · 按档执行，剩余 20% 现金可自决追加（不建议常规操作）', mode, pct, currentTier: tiers[tiers.length - 1], nextTier: null };
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
  /* v1.9.32 批次3 重设计（M60/M64/M69/M263-M266）：
   * 矩阵策略池：买入方式（闭眼/保守/柔性/等90/自定义）× 持有方式（长期不卖 / 卖出信号）
   * 卖出信号（M64 简化版）：触发 P95 极值区卖出 50%，回落 P90 以下买回（用 findZoneEvents，零新数据）
   * 输出新增：series（三线：价格归一化/累计分红/累计分红÷投入）、div3yRate（分红口径胜率 3年累计≥15%×买价）、
   *   div3yAvg（3年累计分红÷买入价）、divCum/divRatio（曲线数据）、xirr（组合现金流，N2 口径）
   * 旧字段（ret/annual/mdd/winRate/events/desc/name）保留=加字段不破坏消费（K3） */
  opts = opts || {};
  const rows = [
    { key: 'lump', name: '闭眼全仓', desc: '期初一次买入持有', tiers: null },
    { key: 'consv', name: '保守金字塔', desc: '80/85/90 分位各 1/3', tiers: [{ pct: 80, frac: 1 / 3 }, { pct: 85, frac: 1 / 3 }, { pct: 90, frac: 1 / 3 }] },
    { key: 'flex', name: '柔性金字塔', desc: '70/80/90/95 → 20/40/60/80%', tiers: [{ pct: 70, frac: 0.2 }, { pct: 80, frac: 0.2 }, { pct: 90, frac: 0.2 }, { pct: 95, frac: 0.2 }] },
    { key: 'wait90', name: '等 90 分位', desc: '90+ 一次性全仓', tiers: [{ pct: 90, frac: 1 }] },
  ];
  if (opts.customTiers && opts.customTiers.length) {
    opts.customTiers.forEach((cs, i) => {
      rows.push({ key: 'custom' + i, name: cs.name || '自定义方案', desc: cs.desc || cs.tiers.map(t => t.pct + '档 ' + Math.round(t.frac * 100) + '%').join(' / '), tiers: cs.tiers });
    });
  }
  /* 矩阵化（M69）：买入方式 × 持有方式（long 长期不卖 / sell 卖出信号） */
  const strategies = [];
  rows.forEach(r => {
    strategies.push({ key: r.key + '_long', name: r.name, desc: r.desc, tiers: r.tiers, hold: 'long' });
    strategies.push({ key: r.key + '_sell', name: r.name, desc: r.desc + ' · 卖出信号(P95卖50%/回落P90买回)', tiers: r.tiers, hold: 'sell' });
  });
  /* 工具：区间分红累加（按年窗口，从 fromD 到 toD 的年份） */
  function divsBetween(divsByYear, fromD, toD) {
    const y0 = (fromD || '').slice(0, 4), y1 = (toD || '').slice(0, 4);
    if (!y0 || !y1) return 0;
    let s = 0;
    Object.keys(divsByYear).forEach(y => { if (y >= y0 && y <= y1) s += divsByYear[y]; });
    return s;
  }
  /* 卖出信号持有段（M64）：buyP 后首个 P95 极值区首日卖 50%，回落 P90 以下买回；未触发=null=长期持有 */
  function sellHoldRet(buyP, buyDate, dates, kline, series, divsByYear) {
    const evs95 = DL.findZoneEvents(series, 95).filter(e => e.start >= buyDate);
    if (!evs95.length) return null;
    const sellD = evs95[0].start;
    const sellIdx = dates.indexOf(sellD);
    if (sellIdx < 0 || !(kline[sellD] > 0)) return null;
    const sellP = kline[sellD];
    const sellDiv = divsBetween(divsByYear, buyDate, sellD);
    const sellRet = (sellP + sellDiv) / buyP;
    let rebuyD = null;
    for (const x of series) { if (x.d > sellD && x.pct != null && x.pct < 90) { rebuyD = x.d; break; } }
    if (!rebuyD) return sellRet;
    const rebuyIdx = dates.indexOf(rebuyD);
    if (rebuyIdx < 0 || !(kline[rebuyD] > 0)) return sellRet;
    const endD = dates[dates.length - 1];
    const rebuyDiv = divsBetween(divsByYear, rebuyD, endD);
    const rebuyRet = (kline[endD] + rebuyDiv) / kline[rebuyD];
    return 0.5 * sellRet + 0.5 * rebuyRet;
  }
  const out = [];
  for (const st of strategies) {
    let totRet = 0, totMdd = 0, totWin = 0, totEv = 0, totAnnual = 0, totDiv3y = 0, totDiv3yRate = 0, n = 0;
    let aggr = null;   // 三线聚合（等权均值）
    let cashflows = [];   // N2 组合 XIRR（各事件批次买入负流 + 期末市值正流）
    for (const it of pool) {
      if (!it.series || !it.kline) continue;
      const dates = Object.keys(it.kline).sort();
      if (dates.length < 250) continue;
      const endD = dates[dates.length - 1];
      const endP = it.kline[endD];
      const divsByYear = {};
      (it.divs || []).forEach(d => { if (d.ex && d.dps > 0) { const y = d.ex.slice(0, 4); divsByYear[y] = (divsByYear[y] || 0) + d.dps; } });
      let ret = 0, mdd = 0, winCnt = 0, evCnt = 0, div3ySum = 0, div3yCnt = 0;
      const buys = [];
      if (st.tiers) {
        for (const t of st.tiers) {
          const evs = DL.findZoneEvents(it.series, t.pct);
          for (const ev of evs) {
            const idx = dates.indexOf(ev.start);
            if (idx < 0) continue;
            const buyP = it.kline[ev.start];
            if (!(buyP > 0)) continue;
            buys.push({ d: ev.start, price: buyP, frac: t.frac });
            evCnt++;
            const y1 = dates[idx + 250];
            if (y1 && it.kline[y1] > buyP) winCnt++;
            /* R5/R1（M263）：分红口径——3 年窗口累计分红 ≥ 买入价 15%（div3y=买入后 3 年，非买入年到期末） */
            const d3 = divsBetween(divsByYear, ev.start, dates[Math.min(idx + 750, dates.length - 1)]);
            div3ySum += d3; div3yCnt++;
            if (d3 >= buyP * 0.15) totDiv3yRate++;
          }
        }
        if (!buys.length) continue;
        let wSum = 0;
        for (const b of buys) {
          let r;
          if (st.hold === 'sell') {
            const sr = sellHoldRet(b.price, b.d, dates, it.kline, it.series, divsByYear);
            r = (sr != null ? sr : (endP + divsBetween(divsByYear, b.d, endD)) / b.price) - 1;
          } else {
            r = (endP + divsBetween(divsByYear, b.d, endD)) / b.price - 1;
          }
          ret += r * b.frac;
          wSum += b.frac;
          if (b.price > 0 && b.frac > 0) cashflows.push({ d: b.d, v: -b.price * b.frac });
        }
        if (wSum > 0) ret /= wSum;
        for (const b of buys) {
          let peak = -Infinity, md = 0;
          const si = dates.indexOf(b.d);
          for (let j = si; j < dates.length; j++) { const p = it.kline[dates[j]]; if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > md) md = dd; }
          mdd += md * b.frac;
        }
        if (wSum > 0) mdd /= wSum;
      } else {
        const buyP = it.kline[dates[0]];
        if (!(buyP > 0)) continue;
        let r;
        if (st.hold === 'sell') {
          const sr = sellHoldRet(buyP, dates[0], dates, it.kline, it.series, divsByYear);
          r = (sr != null ? sr : (endP + divsBetween(divsByYear, dates[0], endD)) / buyP) - 1;
        } else {
          r = (endP + divsBetween(divsByYear, dates[0], endD)) / buyP - 1;
        }
        ret = r;
        let peak = -Infinity, md = 0;
        for (let j = 0; j < dates.length; j++) { const p = it.kline[dates[j]]; if (p > peak) peak = p; const dd = (peak - p) / peak; if (dd > md) md = dd; }
        mdd = md;
        evCnt = 1;
        const y1 = dates[250];
        if (y1 && it.kline[y1] > buyP) winCnt = 1;
        const d3 = divsBetween(divsByYear, dates[0], dates[Math.min(750, dates.length - 1)]);
        div3ySum += d3; div3yCnt++;
        if (d3 >= buyP * 0.15) totDiv3yRate++;
        if (buyP > 0) cashflows.push({ d: dates[0], v: -buyP });
      }
      const span = (() => { const t0 = buys.length ? buys[0].d : dates[0]; const s = (new Date(endD) - new Date(t0)) / (365 * 86400000); return Math.max(s, 0.01); })();   // 修复 B6（2026-08-23 接手 AI）：年化分母用持有期（首笔买入→期末），原用数据起点 dates[0]（可能远早于买入）拉低年化
      totRet += ret; totMdd += mdd; totWin += winCnt; totEv += evCnt; n++;
      if (div3yCnt > 0) totDiv3y += div3ySum / div3yCnt;
      if (span > 0 && (1 + ret) > 0) totAnnual += Math.pow(1 + ret, 1 / span) - 1;
      /* M60 series 聚合：价格归一化(期初=100)、累计分红(每股累计/期初价×100)、累计分红÷投入% */
      const t0 = dates[0], p0 = it.kline[t0];
      if (p0 > 0) {
        if (!aggr) aggr = { t: dates, price: new Array(dates.length).fill(0), divCum: new Array(dates.length).fill(0), divRatio: new Array(dates.length).fill(0) };
        let cumDiv = 0;
        for (let j = 0; j < dates.length; j++) {
          const d = dates[j];
          const py = d.slice(0, 4);
          if (divsByYear[py]) {
            /* 该年分红按日近似累计：取该年全年（简化：年份边界一次性累加） */
          }
          aggr.price[j] += (it.kline[d] / p0) * 100;
          /* 逐年分红累计：用年份切换 */
        }
        /* 逐年累计分红：按年边界累加（该年首次出现的日期处累加全年） */
        let lastY = null, cum = 0;
        for (let j = 0; j < dates.length; j++) {
          const y = dates[j].slice(0, 4);
          if (lastY && y !== lastY) { cum += divsByYear[lastY] || 0; }
          lastY = y;
          const divPct = (cum / p0) * 100;
          aggr.divCum[j] += divPct;
          aggr.divRatio[j] += (cum / p0) * 100;
        }
      }
      /* N2：期末市值正流（按期末价+期末年分红近似） */
      if (cashflows.length && endP > 0) cashflows.push({ d: endD, v: endP });
    }
    if (!n) { out.push({ key: st.key, name: st.name, desc: st.desc, ret: null, annual: null, mdd: null, winRate: null, events: 0, n: 0, series: null, div3yRate: null, div3yAvg: null, divCum: null, divRatio: null, hold: st.hold }); continue; }
    /* 三线平均（等权） */
    let series = null;
    if (aggr) {
      for (let j = 0; j < aggr.t.length; j++) {
        aggr.price[j] /= n; aggr.divCum[j] /= n; aggr.divRatio[j] /= n;
      }
      series = { t: aggr.t, lines: { price: aggr.price, divCum: aggr.divCum, divRatio: aggr.divRatio } };
    }
    /* N2 组合 XIRR：现金流序列（批次买入负流 + 期末市值正流），复用 DL.xirr（views 2188 同算法在 DL） */
    let xirr = null;
    try {
      const flows = cashflows.filter(c => c.v !== 0 && c.d);
      if (flows.length >= 2) xirr = (typeof calcXirr === 'function') ? calcXirr(flows) : null;
    } catch (e) { xirr = null; }
    out.push({
      key: st.key, name: st.name, desc: st.desc,
      ret: totRet / n * 100, annual: totAnnual / n * 100, mdd: totMdd / n * 100,
      winRate: totEv ? totWin / totEv * 100 : null, events: totEv, n,
      series, div3yRate: totEv ? totDiv3yRate / totEv * 100 : null,
      div3yAvg: totEv ? totDiv3y / totEv : null,
      divCum: series ? series.lines.divCum[series.lines.divCum.length - 1] : null,
      divRatio: series ? series.lines.divRatio[series.lines.divRatio.length - 1] : null,
      xirr: xirr != null ? xirr * 100 : null,
      hold: st.hold,
    });
  }
  /* v2.0 #10/#11：真实持仓回测——真实成本/股数/买入日/trades流水 → 真实 XIRR + 累计分红 vs 浮盈亏 */
  const realHold = [];
  try {
    pool.forEach(p => {
      if (!p.hold || !p.hold.shares) return;
      const h = p.hold;
      const ks = Object.keys(p.kline || {}).sort();
      const endP = ks.length ? p.kline[ks[ks.length - 1]] : 0;
      if (!(endP > 0)) return;
      const flows = [];
      let shares = 0, totalCost = 0, firstD = null;
      if (h.trades && h.trades.length) {
        h.trades.forEach(t => { if (t && t.date && t.shares > 0) { flows.push({ d: t.date, v: -(t.shares * (t.price || 0)) }); shares += t.shares; totalCost += t.shares * (t.price || 0); if (!firstD || t.date < firstD) firstD = t.date; } });
      } else if (h.date && h.cost != null && h.shares > 0) {
        flows.push({ d: h.date, v: -(h.shares * h.cost) });
        shares = h.shares; totalCost = h.shares * h.cost; firstD = h.date;
      }
      if (!flows.length) return;
      flows.push({ d: ks[ks.length - 1], v: shares * endP });
      const x = (typeof calcXirr === 'function') ? calcXirr(flows) : null;
      let cumDiv = 0;
      (p.divs || []).forEach(d => { if (d.ex && d.dps > 0 && (!firstD || d.ex >= firstD)) cumDiv += d.dps * shares; });
      const mktVal = shares * endP;
      const pnl = mktVal - totalCost;
      realHold.push({ code: p.code, name: p.name, shares, cost: totalCost, mktVal, pnl, pnlPct: totalCost > 0 ? pnl / totalCost * 100 : null, cumDiv, divVsPnl: totalCost > 0 ? cumDiv / totalCost * 100 : null, xirr: x != null ? x * 100 : null });
    });
  } catch (e) {}
  out.realHold = realHold;
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
  strong: [43, 74, 684],
  buy: [37.6, 72, 1468],
  watch: [42.2, 77, 1029],
  avoid: [33, 67, 30],
  avoid_small: [16.5, 55, 11],
  wait: [0.8, 52, 958]
};
const RULE_TIER_LABEL = { strong: '条件建仓（小仓）', buy: '可建仓', watch: '观望', wait: '等待', avoid: '回避', avoid_small: '回避/小仓' };
/* v1.9.15 语义修正：strong 档文案（强烈建仓→条件建仓（小仓））——防'强烈'二字诱导重仓（大师验收动作，规则树/卡面/日志三处同步） */

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
  // P7（2026-08-18）：财报季感知 TTL——4 月（年报集中披露）/8 月（中报）缩到 1 天，其余 7 天（防陷阱预警用旧数据延迟一周）
  const _f10TtlMs = (() => { const m = new Date().getMonth() + 1; return (m === 4 || m === 8) ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000; })();
  if (hit && Date.now() - hit.ts < _f10TtlMs) return Object.assign({ cached: true, cachedAt: fmtDate(new Date(hit.ts)) }, hit.data);
  // v1.9.17 修复：SECUCODE 需要带交易所后缀（600066.SH / 000333.SZ），纯数字 code 直接过滤会拿不到数据（既有 bug：
  // 报告卡 F10 一直静默失败靠静态数据兜底；6 开头=沪.SH，0/3 开头=深.SZ）
  const secuCode = /^\d+$/.test(code) ? code + (/^6/.test(code) ? '.SH' : '.SZ') : code;
  const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=(SECUCODE%3D%22${secuCode}%22)&pageNumber=1&pageSize=100&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`;
  try {
    const [r, r2, r3] = await Promise.all([
      fetch(url, { headers: { 'Referer': 'https://emweb.securities.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 Chrome/126.0' } }),
      fetch(`https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO&columns=ALL&filter=(SECUCODE%3D%22${code}%22)&pageNumber=1&pageSize=1&source=HSF10&client=PC`, { headers: { 'Referer': 'https://emweb.securities.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 Chrome/126.0' } }),
      // v1.9.18 决策层：资产负债表接口（短债/货币资金/流动比/商誉/审计意见——财报全景判读用）
      fetch(`https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_GBALANCE&columns=ALL&filter=(SECUCODE%3D%22${secuCode}%22)&pageNumber=1&pageSize=6&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`, { headers: { 'Referer': 'https://emweb.securities.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 Chrome/126.0' } }),
    ]);
    const j = await r.json();
    let csrc = '';
    try { const j2 = await r2.json(); const b = (j2 && j2.result && j2.result.data) || []; csrc = (b[0] && b[0].CSRC_INDUSTRY_NAME) || ''; } catch (e2) {}
    // v1.9.18：资产负债表（GBALANCE）——最新年报行 + 最新中报行（中报检测·卖出信号时效 2 年→6 个月）
    let bal = {}, balH1 = {};
    try {
      const j3 = await r3.json(); const b3 = (j3 && j3.result && j3.result.data) || [];
      const annualRow3 = b3.find(x => /12-31/.test(x.REPORT_DATE || '')) || b3[0] || {};
      const h1Row = b3.find(x => /06-30/.test(x.REPORT_DATE || '')) || null;
      const pick = (row) => ({
        shortLoan: row.SHORT_LOAN != null ? parseFloat(row.SHORT_LOAN) / 1e8 : null,
        monetaryFunds: row.MONETARYFUNDS != null ? parseFloat(row.MONETARYFUNDS) / 1e8 : null,
        currentAssets: row.TOTAL_CURRENT_ASSETS != null ? parseFloat(row.TOTAL_CURRENT_ASSETS) / 1e8 : null,
        currentLiab: row.TOTAL_CURRENT_LIAB != null ? parseFloat(row.TOTAL_CURRENT_LIAB) / 1e8 : null,
        goodwill: row.GOODWILL != null ? parseFloat(row.GOODWILL) / 1e8 : null,
        auditOpinion: row.OPINION_TYPE || null,
        unassignProfit: row.UNASSIGN_RPOFIT != null ? parseFloat(row.UNASSIGN_RPOFIT) / 1e8 : null,
        minorityEquity: row.MINORITY_EQUITY != null ? parseFloat(row.MINORITY_EQUITY) / 1e8 : null,
        totalEquity: row.TOTAL_EQUITY != null ? parseFloat(row.TOTAL_EQUITY) / 1e8 : null,
        totalAssets: row.TOTAL_ASSETS != null ? parseFloat(row.TOTAL_ASSETS) / 1e8 : null,
        date: (row.REPORT_DATE || '').slice(0, 10),
      });
      bal = pick(annualRow3);
      if (h1Row) balH1 = pick(h1Row);
    } catch (e3) {}
    const rows = (j && j.result && j.result.data) || [];
    // 所有完整年报序列（接口降序 → 保持降序），全量保留（回放验收需 2018 年前数据，实测 pageSize=100 覆盖至 2006）
    const annuals = rows.filter(x => /12-31/.test(x.REPORT_DATE || '')).map(x => ({
      reportDate: (x.REPORT_DATE || '').slice(0, 10),
      netProfit: x.PARENTNETPROFIT != null ? parseFloat(x.PARENTNETPROFIT) / 1e8 : null,   // 元→亿
      deductNetProfit: x.KCFJCXSYJLR != null ? parseFloat(x.KCFJCXSYJLR) / 1e8 : null,     // 扣非净利·元→亿（v1.9.17 财报证据层）
      roe: x.ROEJQ != null ? parseFloat(x.ROEJQ) : null,
      grossMargin: x.XSMLL != null ? parseFloat(x.XSMLL) : null,        // 毛利率%（v1.9.17）
      bps: x.BPS != null ? parseFloat(x.BPS) : null,                    // 每股净资产（F6 估值双锚·PB 分位 2026-08-20）
      netMargin: x.XSJLL != null ? parseFloat(x.XSJLL) : null,         // 销售净利率%（v1.9.17）
      ocf: x.NETCASH_OPERATE_PK != null ? parseFloat(x.NETCASH_OPERATE_PK) / 1e8 : null,  // 经营现金流·元→亿（v1.9.17）
      ocfPerShare: x.MGJYXJJE != null ? parseFloat(x.MGJYXJJE) : null,  // 每股经营现金流·元（v1.9.17）
      receivable: x.ACCOUNTS_RECE ? parseFloat(x.ACCOUNTS_RECE) / 1e8 : null,   // 应收账款·元→亿（D1b 应收账期拉长信号）
      revenue: x.TOTAL_OPERATE_INCOME != null ? parseFloat(x.TOTAL_OPERATE_INCOME) / 1e8 : null,  // 营业总收入·亿（D1b 应收/营收比）
      liabilityRatio: x.ZCFZL != null ? parseFloat(x.ZCFZL) : null,    // 资产负债率%（v1.9.17）
      dpsUndistributed: x.MGWFPLR != null ? parseFloat(x.MGWFPLR) : null,  // 每股未分配利润·元（v1.9.17）
    }));
    const annual = annuals[0] || null;   // 最近完整年报
    const annualRow = rows.find(x => /12-31/.test(x.REPORT_DATE || ''));   // 原始行（mgwfplr/ORG_TYPE 回源）
    if (!annual) return null;
    // 净利同比：最新年报 vs 上一年报（%），任一缺失/基期为 0 → null（宁缺勿误报）
    let netProfitYoY = null;
    if (annuals[0] && annuals[1] && annuals[0].netProfit != null && annuals[1].netProfit != null && annuals[1].netProfit !== 0) {
      netProfitYoY = (annuals[0].netProfit / annuals[1].netProfit - 1) * 100;
    }
    // 扣非同比：最新年报 vs 上一年报（%），任一缺失/基期为 0 → null（v1.9.17 财报证据层·trap 扣非重算用）
    let deductYoY = null;
    if (annuals[0] && annuals[1] && annuals[0].deductNetProfit != null && annuals[1].deductNetProfit != null && annuals[1].deductNetProfit !== 0) {
      deductYoY = (annuals[0].deductNetProfit / annuals[1].deductNetProfit - 1) * 100;
    }
    // ROE 趋势：连续 N 年下滑判定（v1.9.17 质量层·巴菲特 ROE 退化信号）
    let roeDownYears = 0;
    for (let i = 0; i + 1 < annuals.length; i++) {
      if (annuals[i].roe != null && annuals[i + 1].roe != null && annuals[i].roe < annuals[i + 1].roe) roeDownYears++;
      else break;
    }
    const out = {
      roe: annual.roe,
      netProfit: annual.netProfit,
      netProfitYoY,       // P0-3：最新完整年报净利同比（%）
      deductNetProfit: annual.deductNetProfit,   // v1.9.17：扣非净利（亿）
      deductYoY,                                // v1.9.17：扣非同比（%）
      roeDownYears,                             // v1.9.17：ROE 连续下滑年数（质量层）
      grossMargin: annual.grossMargin,          // v1.9.17：毛利率（%）
      netMargin: annual.netMargin,              // v1.9.17：销售净利率（%）
      ocf: annual.ocf,                          // v1.9.17：经营现金流（亿）
      ocfPerShare: annual.ocfPerShare,          // v1.9.17：每股经营现金流（元）
      liabilityRatio: annual.liabilityRatio,    // v1.9.17：资产负债率（%）
      auditOpinion: bal.auditOpinion || null,  // D1b：最新年报审计意见（非标=硬红灯）
      receivable: annuals[0] ? annuals[0].receivable : null,   // D1b：最新年报应收（亿）
      revenue: annuals[0] ? annuals[0].revenue : null,         // D1b：最新年报营收（亿）
      receivablePrev: annuals[1] ? annuals[1].receivable : null,
      revenuePrev: annuals[1] ? annuals[1].revenue : null,
      annuals,            // P0-3：年报序列（降序，{reportDate,netProfit,roe,...}）
      orgType: annualRow ? (annualRow.ORG_TYPE || '') : '',
      csrcIndustry: csrc,   // 证监会行业（第二判据，Q1）
      reportDate: annual.reportDate,
    };
    // mgwfplr：从原始行回源（annuals 映射未保留该字段）
    if (annualRow) out.mgwfplr = annualRow.MGWFPLR != null ? parseFloat(annualRow.MGWFPLR) : null;
    // v1.9.17：总股本（分红/OCF 覆盖率精确口径：dps×总股本÷OCF）
    if (annualRow) out.totalShare = annualRow.TOTAL_SHARE != null ? parseFloat(annualRow.TOTAL_SHARE) : null;
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
function trapFilter({ netProfitYoY, payout, dy, p90Line, deductYoY, payoutHigh }) {
  // v1.9.17 财报证据层·扣非重算：支付率>90%（吃老本风险）时优先用扣非同比判断净利趋势——
  // 归母可能被理财收益/政府补助虚增（宇通：归母-3.52%但扣非+15.83%，用归母会误判）；
  // 反过来归母正增长但扣非负增长=利润质量差（理财撑数），也要用扣非戳穿。
  const useDeduct = payoutHigh || (payout != null && payout > 0.9);
  const trendYoY = (useDeduct && deductYoY != null) ? deductYoY : netProfitYoY;
  if (trendYoY == null || !(trendYoY < 0)) {
    // 扣非口径下不触发，但归母口径下滑→提示质量差（软信号，不拦截）
    if (useDeduct && netProfitYoY != null && netProfitYoY < 0 && deductYoY != null && deductYoY >= 0) {
      return { level: 'soft', msg: `观察：归母同比 ${netProfitYoY.toFixed(1)}% 下滑但扣非 ${deductYoY.toFixed(1)}%（理财/补助虚增嫌疑，盯质量）` };
    }
    return { level: null, msg: null };
  }
  const highYield = p90Line != null ? (dy != null && dy >= p90Line) : (dy != null && dy >= 5);
  if (trendYoY < -10 && highYield && payout != null && payout > 0.5) {
    return { level: 'hard', msg: `陷阱确认：${useDeduct ? '扣非' : '净利'}同比 ${trendYoY.toFixed(1)}% 下滑 + 支付率 ${(payout * 100).toFixed(0)}%（覆盖<2）` };
  }
  return { level: 'soft', msg: `观察：${useDeduct ? '扣非' : '净利'}同比 ${trendYoY.toFixed(1)}% 下滑（覆盖尚可，盯年报）` };
}

/* 行业校准信号包（2026-08-20 最终执行方案v2·持仓回测实证）
 * 实证：银行 OCF/净利常年<0.5=特性（触发后+47%/+76%反向）；电信 S1 结构性下降（+34%~45%反向）
 *      制造/消费 扣非+OCF+S1 有效（宇通 2017 双信号-37%）；S1 在制造/消费=单独硬红灯（35次-19.2pp）
 * 输入：industry(csrc 行业)、最新年报财务（kf=扣非亿、kfPrev=上一年扣非、ocf=经营现金流亿、np=净利亿、
 *       xsmll=毛利率%、xsmllPrev/xsmllPrev2=前两年、netProfitYoY=净利同比%、code）
 * 输出：{ signals:[...], level:'hard'|'soft'|'watch'|null, msg }
 *   hard=硬红灯（清仓）/ soft=软恶化（减半）/ watch=观察（单信号）/ null=干净
 */
/* 财报确认闸（2026-08-20 主人令：买卖必须依据财报——财报是买入的必要条件，价格只定时机）
 * 硬闸（不过=禁止买入，即使 P95 触发）：
 *   全行业：净利>0 / 扣非>0 / 扣非同比>-10%
 *   制造/消费：OCF/净利≥0.5 / 毛利率连降S1 不过
 *   银行/保险/电信：豁免 OCF/S1（行业特性，用净利+扣非趋势）
 * 输出：{ pass, checks:[...] }
 */
function finConfirm({ industry, kf, kfPrev, ocf, np, xsmll, xsmllPrev, xsmllPrev2 }) {
  const ind = (industry || '').toLowerCase();
  const isManu = ind.includes('制造') || ind.includes('汽车') || ind.includes('机械') || ind.includes('电气') || ind.includes('家电');
  const isConsumer = ind.includes('食品') || ind.includes('饮料') || ind.includes('消费') || ind.includes('农牧');
  const isReal = isManu || isConsumer;
  const checks = [];
  let pass = true;
  if (np != null && np <= 0) { pass = false; checks.push(`净利${np}亿为负`); }
  if (kf != null && kf <= 0) { pass = false; checks.push(`扣非${kf}亿为负`); }
  if (kf != null && kfPrev != null && kfPrev > 0) {
    const yoy = kf / kfPrev - 1;
    if (yoy < -0.1) { pass = false; checks.push(`扣非同比${(yoy * 100).toFixed(0)}%（恶化>10%）`); }
  }
  if (isReal) {
    if (ocf != null && np != null && np > 0 && ocf / np < 0.5) { pass = false; checks.push(`OCF/净利${(ocf / np).toFixed(2)}（<0.5）`); }
    if (xsmll != null && xsmllPrev != null && xsmllPrev2 != null &&
        xsmll < xsmllPrev - 0.5 && xsmllPrev < xsmllPrev2 - 0.5) { pass = false; checks.push('毛利率连降(S1)'); }
  }
  return { pass, checks };
}

/* 标的分层（2026-08-20 大师最终方案 A-·实测验证）：
 * 自动层（招行/工行/美的/宇通）：2年胜率 75% 平均+35.3% → 自动买卖信号
 * 事件层（伊利/平安）：2年胜率 49% 中位-1.8%（历史任何买法都难赚，行业事件驱动测不到）
 *   → 工具只做财报监控+风险提示，不自动给买卖信号，买入=人工事件判断，仓位≤10%
 * 实测：B 行业强度过滤（60%→56%）、C 季度止损（57%→52%）、右侧买入（撞股灾）全部失败
 */
const TRADE_LAYER = {
  '600036': 'auto', '601398': 'auto', '000333': 'auto', '600066': 'auto', '600941': 'auto',
  '600887': 'event', '601318': 'event',
};

/* 买入触发配置（2026-08-20 全标的优化矩阵实验结论·主人令"工具明确提示买卖"）
 * 每只最优组合（2年胜率优先）：冷却60日+档位定制+趋势确认+双闸
 * 招行 p75 / 宇通 p95+趋势+双闸 / 伊利 p95+趋势 / 移动 p90 / 平安 p75 / 工行 p95+趋势 / 美的 p95+趋势
 */
const BUY_CFG = {
  '600036': { minTier: 'p75' },                // 招行
  '600066': { minTier: 'p95', trend: true, gate: true, fxSensitive: true },  // 宇通（海外收入57.8%→汇率敏感度监测）
  '600887': { minTier: 'p95', trend: true },   // 伊利
  '600941': { minTier: 'p90' },                // 移动
  '601318': { minTier: 'p75' },                // 平安
  '601398': { minTier: 'p95', trend: true },   // 工行
  '000333': { minTier: 'p95', trend: true },   // 美的
};

/* 买卖等级引擎 v2（2026-08-20 主人批评"一买就重仓"→ 大师两轮 A 定稿等级制）
 * 输入：code、dy（当前股息率%）、tier（分位档 p75/p90/p95/null）、trendOk（趋势确认）、
 *       finOk（财报双闸过）、finGood（财报好：扣非同比>0，可选）、lastBuyDays（距上次买入触发天数，冷却60日）、
 *       industrySignals（行业校准信号结果）、industry（行业中文名，背书用）、valuation（PB分位 pct，可选）
 * 输出：{ action, text, reason, evidence, level, strength }
 *   action: buy_L1..buy_L5=等级买入 / hold=持有 / watch=S1观察 / reduce=S2减半 / sell=S3清仓
 * 等级体系（大师 A 定稿）：
 *   买入 5 级：L1观察(0%) → L2试探(1/6) → L3小仓(1/3) → L4加仓(2/3) → L5重仓(上限)
 *   卖出 3 级：S1观察(0.15-0.2) → S2减半(0.3-0.5) → S3清仓(1.0)
 * 铁律：
 *   1. 财报否决（finOk=false 禁买，即使 P95）
 *   2. 首触降档（主人 08-19 铁律落地）：个股 P95 历史触发 0 次 或 行业无背书 → 最高 L3，等验证
 *   3. 双背书（个股触发≥1 且 行业 heavy 胜率≥80% n≥10）才可 L4/L5
 *   4. 等级=风险提示+建议强度，最终动作主人拍板
 */
const P95_TRIGGERS = {  // 个股 P95 线历史触发次数（脚本 scripts/refresh-p95-triggers.js 自动刷新；口径=TIER_LINE.p95+TREASURY_NOW 绝对线，zoneEvents 连续段首日）
  '600036': 20, '600066': 3, '600887': 1, '600941': 3, '601318': 0, '601398': 20, '000333': 2,
};
function indKeyOf(industry) {
  const t = (industry || '').toLowerCase();
  if (t.includes('银行') || t.includes('货币金融')) return 'bank';
  if (t.includes('保险')) return 'insurer';
  if (t.includes('电信') || t.includes('移动') || t.includes('通信')) return 'telecom';
  if (t.includes('食品') || t.includes('饮料') || t.includes('酒') || t.includes('农副') || t.includes('医药') || t.includes('汽车') || t.includes('家电') || t.includes('电气') || t.includes('制造') || t.includes('manufacture') || t.includes('机械')) return 'consumer';
  if (t.includes('电力') || t.includes('燃气') || t.includes('公用')) return 'utility';
  if (t.includes('煤炭') || t.includes('石油') || t.includes('开采') || t.includes('有色')) return 'energy';
  return null;
}
function hasBacking(code, industry) {
  const st = SIG_STATS[indKeyOf(industry)] && SIG_STATS[indKeyOf(industry)].heavy;
  const indOk = !!(st && parseFloat(st.all) >= 80 && st.n >= 10);
  const stockOk = (P95_TRIGGERS[code] || 0) >= 1;
  return { indOk, stockOk, ok: indOk && stockOk };
}
function levelFromScore(score, backing) {
  if (score >= 5 && backing.ok) return 'L5';
  if (score === 4 && backing.ok) return 'L4';
  if (score >= 3) return 'L3';
  if (score === 2) return 'L2';
  return 'L1';
}
function tradingSignal({ code, dy, tier, trendOk, finOk, finChecks, lastBuyDays, industrySignals, industry, finGood, valuation, indOverLimit }) {
  const cfg = BUY_CFG[code] || { minTier: 'p75' };
  const lvl = { p75: 1, p90: 2, p95: 3 };
  const backing = hasBacking(code, industry);
  // 1. 卖出优先：行业校准信号（财报恶化=卖出主依据）→ S1/S2/S3 等级；盲区14 税务提示（<1年持仓缴10%红利税）
  const TAX_NOTE = '；⚠️ <1年持仓卖出需缴10%红利税（>1年免税，FIFO持有期）';
  if (industrySignals && industrySignals.level === 'hard') {
    return { action: 'sell', level: 'S3', strength: '1.0', text: '🔴 S3 清仓（强度 1.0）', reason: industrySignals.msg + TAX_NOTE, evidence: '财报硬红灯（行业校准）' };
  }
  if (industrySignals && industrySignals.level === 'soft') {
    return { action: 'reduce', level: 'S2', strength: '0.3-0.5', text: '🟠 S2 减半（建议卖出 30-50%）', reason: industrySignals.msg + TAX_NOTE, evidence: '财报软恶化（行业校准）' };
  }
  if (industrySignals && industrySignals.level === 'watch') {
    return { action: 'watch', level: 'S1', strength: '0.15-0.2', text: '🟡 S1 观察（强度 0.15-0.2）', reason: industrySignals.msg + TAX_NOTE, evidence: '财报单信号（行业校准）' };
  }
  // 2. 买入触发：财报确认（主依据·硬闸）→ 价格分位（定时机）→ 等级（证据强度动态）
  const minLvl = lvl[cfg.minTier];
  const curLvl = tier ? lvl[tier] : -1;
  if (tier && curLvl >= minLvl) {
    // 财报确认硬闸：不过关=禁止买入（即使 P95）——主人令：买卖依据财报
    // 修复 B3（2026-08-23 接手 AI）：原 `finOk === false` 在 F10 数据获取失败（finOk 为 null/undefined）时
    // fail-open 放行买入，违背"财报是买入主依据"。改为 finOk !== true：数据缺失同样禁买，宁缺勿买。
    if (finOk !== true) {
      return { action: 'hold', level: null, strength: '0%', text: '❌ 禁止买入（财报不过关/数据缺失）', reason: `dy已到${tier.toUpperCase()}但财报确认${finOk === false ? '失败' : '数据缺失'}：${(finChecks && finChecks.length) ? finChecks.join('；') : 'F10 财报数据未获取，暂不可决策'}`, evidence: '财报确认闸（主依据）' };
    }
    // 冷却：距上次买入 <60 交易日 → 提示但不动
    if (lastBuyDays != null && lastBuyDays < 60) {
      return { action: 'hold', level: null, strength: '0%', text: '🟡 持有（冷却中）', reason: `已触发${tier.toUpperCase()}但距上次买入仅${lastBuyDays}日（冷却60日）`, evidence: '冷却期' };
    }
    // 趋势确认（配置开启）
    if (cfg.trend && !trendOk) {
      return { action: 'hold', level: null, strength: '0%', text: '🟡 等待（趋势未确认）', reason: `dy已到${tier.toUpperCase()}但仍在下跌通道（60日新低附近），等企稳`, evidence: '趋势确认' };
    }
    // 加严双闸（配置开启，宇通）
    if (cfg.gate && !trendOk) {
      return { action: 'hold', level: null, strength: '0%', text: '🟡 等待（加严双闸）', reason: '宇通定制：需趋势确认+财报双闸全过', evidence: '宇通专属规则' };
    }
    // 等级制：证据强度打分 → 等级（大师 A 定稿映射）
    // 价格档位：P75=1 / P90=2 / P95=3；财报：过=+0 好=+1 差=-2否决；行业：无=0 好=+1 硬红灯否决；估值：中=0 低=+1 高=-1
    let score = lvl[tier];
    if (finGood) score += 1;
    if (industrySignals && industrySignals.level == null) score += 1;
    if (valuation != null && valuation.pct != null) {
      if (valuation.pct < 30) score += 1;
      else if (valuation.pct > 70) score -= 1;
    }
    const L0 = levelFromScore(score, backing);
    // 组合约束（v7 大师 A）：行业超限（同行业≥3只）→ 强度×0.5 降级（非禁止；主人明确加仓例外→UI 标注）
    const L = indOverLimit ? ({ L5: 'L4', L4: 'L3', L3: 'L3', L2: 'L2', L1: 'L1' }[L0] || L0) : L0;
    const L_NAME = { L1: '观察', L2: '试探', L3: '小仓', L4: '加仓', L5: '重仓' }[L];
    const L_STR = { L1: '0%', L2: '1/6', L3: '1/3', L4: '2/3', L5: '上限' }[L];
    const L_ICON = { L1: '👁️', L2: '🟢', L3: '🟢', L4: '🟢', L5: '✅' }[L];
    const comboNote = indOverLimit ? `；⚠️ 行业超限（同行业≥3只，组合约束→强度×0.5，建议换仓分散）` : '';
    const degradeNote = (score >= 4 && !backing.ok)
      ? `（首触降档：P95历史触发${P95_TRIGGERS[code] || 0}次${backing.indOk ? '' : '+行业无背书（胜率<80%或n<10）'}，最高L3，等验证）`
      : '';
    const tierNote = `dy ${dy != null ? dy.toFixed(2) + '%' : '—'} 达 ${tier.toUpperCase()}`;
    const evParts = [tierNote, finGood ? '财报好' : '财报过', industrySignals && industrySignals.level == null ? '行业无恶化' : '', valuation != null && valuation.pct != null ? (valuation.pct < 30 ? '估值低估' : valuation.pct > 70 ? '估值高估' : '估值中性') : '', backing.ok ? '双背书✅' : `无背书（触发${P95_TRIGGERS[code] || 0}次${backing.indOk ? '' : '/行业无背书'}）`, indOverLimit ? '行业超限' : ''].filter(Boolean);
    return { action: 'buy_' + L, level: L, strength: L_STR, text: `${L_ICON} ${L} ${L_NAME}（建议 ${L_STR}）${comboNote}`, reason: `证据${score}分：${evParts.join('+')}${degradeNote}`, evidence: '财报确认✅+价格分位+证据强度' };
  }
  // 3. 默认持有
  return { action: 'hold', level: null, strength: '0%', text: '⚪ 持有', reason: dy != null ? `财报${finOk === false ? '❌未过' : '确认✅'}，dy ${dy.toFixed(2)}% 未达买入线（${cfg.minTier.toUpperCase()}起）` : '数据不足', evidence: '财报确认+' + (tier ? '未达档位' : '无触发') };
}

/* F6 估值双锚·PB 分位（2026-08-20 实测+大师终审裁决：PB>P95 后 3 年 60% 继续涨=卖出大概率卖飞 → 估值极端降级为“仅提醒”，不触发卖出动作；硬红灯（S1 2年/审计非标）才是卖出）
 * 输入：kline（历史日K）、annuals（含 bps 的年报序列，降序）、dateStr（当前日）
 * 输出：{ pb, pct, lvl: 'P95'|'P90'|'P75'|null, signal }
 *   signal: 'hint'(PB>P95·估值极端·仅提醒不动作) / 'hint'(PB>P90·仅提醒) / 'hint'(PB>P75·仅提示) / null
 */
function calcPbPercentile(kline, annuals, dateStr) {
  if (!kline || !annuals || !annuals.length) return null;
  /* 修复 C5（2026-08-23 接手 AI）：原实现假设 kline 为数组 [{d,close}]，但全文件其余处 kline 均为对象 {date:price}，
   * 形状不符导致 filter() 报错/静默 null。此处加适配层：数组照用，对象转数组。 */
  const karr = Array.isArray(kline)
    ? kline.map(x => ({ d: x.d, close: x.close }))
    : Object.keys(kline).sort().map(d => ({ d, close: kline[d] }));
  const rows = karr.filter(x => x.close != null && x.close > 0).map(x => ({ d: x.d, c: parseFloat(x.close) })).sort((a, b) => a.d < b.d ? -1 : 1);
  const date = dateStr || (rows.length ? rows[rows.length - 1].d : '');
  const limit = (() => { const y = parseInt(date.slice(0, 4), 10); const m = parseInt(date.slice(5, 7), 10) - 5; return y + '-' + String(m <= 0 ? 12 + m : m).padStart(2, '0'); })();
  // 当日 BPS（≤limit 的最新年报）
  const cur = annuals.find(x => x.bps != null && x.bps > 0 && x.d.slice(0, 7) <= limit);
  if (!cur) return null;
  // 历史 PB 序列（每交易日：价格/当时最近年报 BPS）
  const pbHist = [];
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i].d;
    const l2 = (() => { const y = parseInt(d.slice(0, 4), 10); const m = parseInt(d.slice(5, 7), 10) - 5; return y + '-' + String(m <= 0 ? 12 + m : m).padStart(2, '0'); })();
    const b = annuals.find(x => x.bps != null && x.bps > 0 && x.d.slice(0, 7) <= l2);
    if (b) pbHist.push(rows[i].c / b.bps);
  }
  if (pbHist.length < 250) return null;
  const curPb = rows[rows.length - 1].c / cur.bps;
  const window = pbHist.slice(-500);
  const sorted = [...window].sort((a, b) => a - b);
  const pct = (() => { const idx = sorted.findIndex(x => x >= curPb); return idx < 0 ? 100 : idx / sorted.length * 100; })();
  let lvl = null;
  if (pct >= 95) lvl = 'P95'; else if (pct >= 90) lvl = 'P90'; else if (pct >= 75) lvl = 'P75';
  // 大师终审裁决（2026-08-20）：PB 高分位≠卖出依据（P5 实锤 3 年 60% 继续涨）——统一为仅提醒，不产生卖出动作
  const signal = lvl ? 'hint' : null;
  return { pb: +curPb.toFixed(2), pct: +pct.toFixed(0), lvl, signal };
}

function assessIndustrySignals({ industry, code, kf, kfPrev, ocf, np, xsmll, xsmllPrev, xsmllPrev2, netProfitYoY }) {
  const signals = [];
  const ind = (industry || '').toLowerCase();
  const isBank = ind.includes('银行') || ind.includes('货币金融');
  const isInsurer = ind.includes('保险');
  const isTelecom = ind.includes('电信') || ind.includes('移动') || ind.includes('通信');
  const isManu = ind.includes('制造') || ind.includes('汽车') || ind.includes('机械') || ind.includes('电气') || ind.includes('家电');
  const isConsumer = ind.includes('食品') || ind.includes('饮料') || ind.includes('消费') || ind.includes('农牧');
  const isReal = isManu || isConsumer; // 校准信号全用的行业
  if (isReal) {
    if (kf != null && kf < 0) signals.push('扣非转负');
    if (kf != null && kfPrev != null && kfPrev > 0 && kf < kfPrev * 0.95) signals.push('扣非下滑');
    if (ocf != null && np != null && np > 0 && ocf / np < 0.5) signals.push(`OCF/净利${(ocf / np).toFixed(2)}`);
    if (xsmll != null && xsmllPrev != null && xsmllPrev2 != null &&
        xsmll < xsmllPrev - 0.5 && xsmllPrev < xsmllPrev2 - 0.5) signals.push('毛利率连降S1');
  } else if (isBank) {
    if (netProfitYoY != null && netProfitYoY < 5) signals.push(`净利增速低(${netProfitYoY.toFixed(0)}%)`);
    if (netProfitYoY != null && netProfitYoY < 0) signals.push('净利转负');
  } else if (isInsurer) {
    if (netProfitYoY != null && netProfitYoY < 0) signals.push(`净利转负(${netProfitYoY.toFixed(0)}%)`);
  } else if (isTelecom) {
    if (netProfitYoY != null && netProfitYoY < 0) signals.push(`净利转负(${netProfitYoY.toFixed(0)}%)`);
  }
  // 分级：S1 在制造/消费=单独硬红灯（回测强有效）；宇通双信号=立即硬红灯（2017 -37% 实证）
  const n = signals.length;
  if (signals.includes('毛利率连降S1') && isReal) return { signals, level: 'hard', msg: `硬红灯：${signals.join('、')}（S1 回测35次-19.2pp强有效）` };
  if (code === '600066' && n >= 2) return { signals, level: 'hard', msg: `硬红灯：${signals.join('、')}（宇通双信号已验证-37%，立即行动）` };
  if (n >= 3) return { signals, level: 'hard', msg: `硬红灯：${signals.join('、')}（三共振）` };
  if (n === 2) return { signals, level: 'soft', msg: `软恶化：${signals.join('、')}（双信号→减半观察）` };
  if (n === 1) return { signals, level: 'watch', msg: `观察：${signals.join('、')}（单信号）` };
  return { signals, level: null, msg: null };
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
  /* v1.9.15 词表分离（大师 M1）：估值系词（低估一档/低估二档/深度低估）——与图2 执行系词（80建/85加/95满）区分，防同名异物 */
  if (dy != null && midLine != null && !(tl && tl.pending)) {
    if (dy >= heavyLine) curTier = { name: '深度低估', note: '已到深度低估线 ' + heavyLine.toFixed(1) + '%（溢价分位 P95）' };
    else if (dy >= line) curTier = { name: '低估二档', note: '已到低估二档线 ' + line.toFixed(1) + '%（溢价分位 P90）' };
    else if (dy >= midLine) curTier = { name: '低估一档', note: '已可低估一档（≥' + midLine.toFixed(1) + '%，溢价分位 P75），未到低估二档线 ' + line.toFixed(1) + '%' };
    else curTier = { name: '等待', note: '未达低估一档线 ' + midLine.toFixed(1) + '%；现价买入仍可吃分红（' + dy.toFixed(2) + '%），三档为买入节奏参考非买入否决' };
  }
  /* P0-3/P0-4：陷阱过滤器接入（回放校准 v3：hard 仅守重仓档）——重仓硬排除 / 加仓软降级 */
  out.trap = null;
  if (netProfitYoY != null && netProfitYoY < 0) {
    const tr = trapFilter({ netProfitYoY, payout: coverage, dy, p90Line: line });
    if (tr.level === 'hard' && curTier && curTier.name === '深度低估') {   // 修复 C4（2026-08-23 接手 AI）：原 '重仓区' 在 v1.9.15 词表分离后永不成立（死代码），hard 陷阱拦截从未触发；深度低估=重仓档
      out.trap = { level: 'hard', msg: tr.msg + '——重仓线拦截，降级观察' };
      curTier = { name: '深度低估(陷阱拦截)', note: '陷阱确认：净利下滑+支付率过高，深度低估线不生效，降级观察' };
    } else if (tr.level) {
      out.trap = { level: 'soft', msg: tr.msg + '——加仓线降为小仓' };
      if (curTier && curTier.name === '低估二档') curTier = { name: '低估二档(观察)', note: '净利同比下滑，低估二档降为低估一档，等年报确认' };
    }
  }
  const tiers = [];
  /* M47 Q1：三档结构化（股息率主显 + 价格附注小字）——rate 为档位股息率，price 为换算价（附注用）
   * v1.9.13：pending（线待补）不展示三档——只展示不触发 */
  if (!(tl && tl.pending)) {
    if (curTier) tiers.push({ type: 'cur', text: '📍 当前：' + curTier.name + '（' + curTier.note + '）' });
    if (midLine != null) tiers.push({ type: 'small', label: '低估一档', rate: midLine, price: bp(midLine), hit: dy != null && dy >= midLine });
    if (buyP) tiers.push({ type: 'add', label: '低估二档', rate: line, price: buyP, hit: dy != null && dy >= line });
    if (heavyP) tiers.push({ type: 'full', label: '深度低估', rate: heavyLine, price: heavyP, hit: dy != null && dy >= heavyLine });
  }
  /* v1.9.13：线源标注（溢价分位 vs 行业参考）+ 语义行 + 过滤层黄灯（优先级：trap>红线>短样本>漂移）
   * 大师第5轮：过滤层只降级不改数；黄灯原因优先级排序，显示前 2 条 */
  if (tl) {
    if (tl.pending) {
      out.lineNote = '⚠️ 溢价分位线待补（K线源故障）·当前显示股息率线（口径不同）·仅展示不触发';
    } else {
      out.lineNote = '三档=溢价分位线（近3年：dy−国债；P75/P90/P95=' + tl.p75.toFixed(2) + '/' + tl.p90.toFixed(2) + '/' + tl.p95.toFixed(2) + 'pp，国债锚 ' + TREASURY_NOW.toFixed(2) + '%·' + TREASURY_ASOF + '）'
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
    if (absLevel === '高' && curTier && (curTier.name === '等待' || curTier.name === '低估一档')) {
      out.conflicts.push('绝对股息率高于行业参考，但分位仅' + curTier.name + '——该股历史整体高息，绝对高≠相对机会');
    }
    if (absLevel === '低' && curTier && (curTier.name === '深度低估' || curTier.name === '低估二档')) {
      out.conflicts.push('分位已到' + curTier.name + '，但绝对股息率低于行业参考——利率环境或该股历史低息所致');
    }
    if (tl.quality === '负增长' && curTier && (curTier.name === '深度低估' || curTier.name === '低估二档')) {
      out.conflicts.push('分位已到' + curTier.name + '，但分红负增长——陷阱风险（价值毁灭型高股息）');
    }
  }
  out.tiers = tiers;
  /* 文本形态（向后兼容：summary 等使用处） */
  out.tiersTxt = tiers.map(t => t.type === 'cur' ? t.text : (t.label || t.type) + '=' + t.rate.toFixed(1) + '%·' + t.price + ' 元' + (t.hit ? ' ✅' : '')).join(' / ');
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
    small: { all: '74%', n: 98, seg: '33-96%', last: '68%', lastN: 69, note: '随机等效；拆子类(D6)：煤炭100%胜率/石化72%（n=39）' },
    add:   { all: '61%', n: 59, seg: '51-100%', last: '65%', lastN: 26, note: '石化拖累；拆子类(D6)：煤炭100%（n=18）/石化85%（n=20）' },
    heavy: { all: '69%', n: 52, seg: '60-88%', last: '88%', lastN: 17, note: '石化拖累；拆子类(D6)：煤炭100%（n=11）/石化89%（n=9）' },
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

/* D7 分时段最大浮亏（2026-08-18 实测：1年持有含分红，事件收益 min；脚本 /tmp/maxdd.js）
 * 展示：重仓/加仓区显示"该档位历史最大浮亏 X%（最差时段）"——回答核心三问之"最坏扛得住吗"
 * 注意：全周期单值会被 2015 股灾污染，用分时段最差；样本<5 的档位不显示 */
const MAX_DD = {
  bank:    { add: { dd: -25, seg: '2018-21' }, heavy: { dd: -23, seg: '2018-21' } },
  consumer: { add: { dd: -45, seg: '2014-17' }, heavy: { dd: -49, seg: '2014-17' } },
  insurer: { add: null, heavy: null },
  utility: { add: { dd: -12, seg: '2014-17' }, heavy: { dd: 0, seg: '—' } },
  energy:  { add: { dd: -28, seg: '2022-26' }, heavy: { dd: -27, seg: '2022-26' } },
  telecom: { add: null, heavy: null },
};
function ddNote(ind, tierKey) {
  const m = MAX_DD[ind] && MAX_DD[ind][tierKey];
  if (!m) return null;
  return `该档位历史最大浮亏 ${m.dd}%（${m.seg} 时段，1 年含分红口径）`;
}

/* 历史战绩静态数据（2026-08-18 招行案例优化，大师三轮裁决 B/D/E + Q5/Q6）
 * 数据源：data/track-record.js（window.TRACK_RECORD；node 测试环境 require 后挂 global）
 * 口径：29只×16年真实日K+分红，工具当前线打标，分红复投，样本内校准（2026线回看历史）
 * 结构：tiers{small/add/heavy}·waitGap{near/mid/far}·waitDur{near/mid/far}，各含 {ind|all}.{r1|r3|r5} → {n,mid,loss} */
function trackRec() {
  const g = (typeof window !== 'undefined') ? window : global;
  return (g && g.TRACK_RECORD) || null;
}
/* 取统计：scope=ind 优先，all 兜底；路径 = bucket.scope[sub].hk；返回 {n,mid,loss} 或 null */
function trackStat(bucket, scope, sub, hk) {
  const tr = trackRec();
  if (!tr || !bucket || !hk) return null;
  const byScope = tr[bucket];
  if (!byScope) return null;
  const node = (byScope[scope] && byScope[scope][sub]) || (byScope.all && byScope.all[sub]) || null;
  return (node && node[hk]) || null;
}
/* wait gap 分桶：gapAdd(pp) → near/mid/far */
function waitGapKey(gap) {
  if (gap == null) return null;
  if (gap < 1) return 'near';
  if (gap <= 3) return 'mid';
  return 'far';
}
/* 触发档战绩行（大师 Q1/Q4：行业桶优先+全池附注；Q5 带样本量）
 * 输入：行业+档位key(small/add/heavy/wait)+当前 gapAdd；输出 HTML 或 null */
function tierTrackNote(ind, tierKey, gap) {
  const tr = trackRec();
  if (!tr || !tierKey) return null;
  const isWait = tierKey === 'wait';
  if (isWait) {
    const gk = waitGapKey(gap);
    if (!gk) return null;
    const b5 = trackStat('waitGap', ind, gk, 'r5');
    const b1 = trackStat('waitGap', ind, gk, 'r1');
    const wd = trackStat('waitDur', ind, gk, null) ? null : null;
    const wdNode = (tr.waitDur[ind] || tr.waitDur.all || {})[gk];
    if (!b5) return null;
    const label = gk === 'near' ? '接近触发' : gk === 'mid' ? '中间区' : '远离触发';
    const upRate = b1 ? (100 - b1.loss) : null;   // 踏空率=1年上涨占比（Q6 纪律诚实双向）
    const wdTxt = wdNode ? `；预计等待 P50 ${wdNode.p50} 天 / P90 ${wdNode.p90} 天` : '';
    const upTxt = upRate != null ? `；1年上涨占比 ${upRate}%（踏空成本）` : '';
    return `等待区·${label}（距线 ${gap != null ? gap.toFixed(1) + 'pp' : '—'}）：历史 5 年复投中位 <b>+${b5.mid}%</b>、亏损率 <b>${b5.loss}%</b>（n=${b5.n}）${wdTxt}${upTxt}`;
  }
  const st = trackStat('tiers', ind, tierKey, 'r5');
  if (!st) return null;
  return `${tierKey === 'small' ? '小仓' : tierKey === 'add' ? '加仓' : '重仓'}线历史（5年复投）：中位 <b>+${st.mid}%</b>、亏损率 <b>${st.loss}%</b>（n=${st.n}，样本内校准口径）`;
}
/* 触发档 1 年胜率替换（E：小仓≈随机旧结论作废→3-5年含分红口径） */
function tierTrackShort(ind, tierKey) {
  const tr = trackRec();
  if (!tr) return null;
  const s3 = trackStat('tiers', ind, tierKey, 'r3');
  if (!s3) return null;
  const label = tierKey === 'small' ? '小仓' : tierKey === 'add' ? '加仓' : '重仓';
  return `${label}线历史 3 年复投中位 +${s3.mid}%、亏损率 ${s3.loss}%（n=${s3.n}）`;
}

/* 国债锚（v1.9.18 正式源）：启动时 refreshTreasury() 从中国货币网官方接口拉取最新 10Y 收益率
 * （2026-08-20 实测接口可用，CORS 全开；失败静默回退静态值 1.681 = 08-18 官方收盘）
 * 影响全站溢价线：触发比较 dy−国债、回算 dy 口径 +TREASURY_NOW */
let TREASURY_NOW = 1.681;
let TREASURY_ASOF = '2026-08-18';
const TREASURY_URL = 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/SddsIntrRateGovYldHis?lang=CN&pageNum=1&pageSize=1';
async function refreshTreasury() {
  try {
    const hit = await cacheGetFresh('tr:10y', 86400000);   // 1 天 TTL（国债收益率日频）
    if (hit && hit.v > 0) { TREASURY_NOW = hit.v; TREASURY_ASOF = hit.d || TREASURY_ASOF; return { v: hit.v, d: hit.d, cached: true }; }
    const d = await fetchJson(TREASURY_URL);
    const rec = d && d.records && d.records[0];
    const v = rec ? parseFloat(rec.tenRate) : NaN;
    if (v > 0 && v < 10) {
      TREASURY_NOW = v; TREASURY_ASOF = rec.dateString || TREASURY_ASOF;
      await cacheSet('tr:10y', { ts: Date.now(), v, d: rec.dateString });
      return { v, d: rec.dateString, cached: false };
    }
  } catch (e) { /* 网络失败静默，保持静态兜底 */ }
  return null;
}
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
  '600887': { name: '伊利股份', ind: 'consumer', p75: 2.86, p90: 3.7, p95: 3.85, p90_1y: 3.87, cagr: 9.9, payout: 82, quality: '稳定增长', redLine: false, pending: false, eventRisk: '澳优2026H1预亏6.85-7.85亿·中报8月底披露' },
  '600900': { name: '长江电力', ind: 'utility', p75: 1.78, p90: 2.16, p95: 2.23, p90_1y: 2.24, cagr: 5.4, payout: 71, quality: '稳定增长', redLine: false, pending: false },
  '600941': { name: '中国移动', ind: 'telecom', p75: 2.76, p90: 3.4, p95: 3.51, p90_1y: 3.51, cagr: 6.7, payout: 73, quality: '稳定增长', redLine: false, pending: false },
  '601088': { name: '中国神华', ind: 'energy', p75: 5.85, p90: 6.49, p95: 6.64, p90_1y: 4.38, cagr: -7.6, payout: 76, quality: '负增长', redLine: false, pending: false },
  '601166': { name: '兴业银行', ind: 'bank', p75: 4.56, p90: 5.08, p95: 5.36, p90_1y: 4.46, cagr: -3.5, payout: 31, quality: '负增长', redLine: false, pending: false },
  '601225': { name: '陕西煤业', ind: 'energy', p75: 8.37, p90: 9.6, p95: 10.11, p90_1y: 5.24, cagr: -24.2, payout: 57, quality: '负增长', redLine: false, pending: false },
  '601288': { name: '农业银行', ind: 'bank', p75: 3.82, p90: 4.11, p95: 4.86, p90_1y: 3.04, cagr: 3.9, payout: 32, quality: '低增长', redLine: false, pending: false },
  '601318': { name: '中国平安', ind: 'insurer', p75: 3.56, p90: 3.89, p95: 4, p90_1y: 3.58, cagr: 3.7, payout: 35, quality: '低增长', redLine: false, pending: false },
  '600066': { name: '宇通客车', ind: 'manufacture', p75: 6.06, p90: 6.66, p95: 7.41, p90_1y: 6.66, cagr: 15.2, payout: 45, quality: '高增长', redLine: false, pending: false, note: '周期股·2年持有窗口·双信号立即硬红灯(2017-37%)' },
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
/* D7（阶段4）：L5 保险丝豁免表埋点——每次豁免/激活计数，样本≥5 自动提示迁移数据驱动
 * 存 window.__fuseStats（session 内）；>=5 次时 sigNote 附迁移提示 */
const fuseStats = { exempt: {}, active: 0 };
function fuseTrack(key) {
  fuseStats.exempt[key] = (fuseStats.exempt[key] || 0) + 1;
  const total = Object.values(fuseStats.exempt).reduce((s, v) => s + v, 0) + fuseStats.active;
  return total >= 5 ? `（D7埋点：豁免样本${total}次，建议迁移为数据驱动阈值，勿长期依赖硬编码）` : '';
}
/* v1.9.15 高估保险丝（极端高估识别·大师终审定稿）：
 * 规则：自身分位<5 且 绝对dy<2.2% → 硬卖提示（消费高分红股核心；2021后几乎不触发=罕见保险丝）
 * 豁免：①bank（dy 常年>2.2，天然不触发；顶后跌20-22%非深跌）②energy（周期顶特征：神华2021-09顶时dy7.54%，绝对线失效）
 *       ③低dy股（近3年dy中位<2.5%：茅台2012/平安2018型分位失效——需PE或相对估值辅助，卡面标注）
 * 回测：43次买入平均 A永不卖+121.1% vs C保险丝+163.9%（18次改善）；PE>25条件回测更差(+142.9%)故不入规则
 * 输出：{ active, msg, exempt } */
function sellFuse(dy, pct, industry, code, divs, kline) {
  if (dy == null || pct == null) return { active: false, msg: '', exempt: '数据不足' };
  if (industry === 'bank' || industry === 'energy') { fuseStats.exempt[industry] = (fuseStats.exempt[industry] || 0) + 1; return { active: false, msg: '', exempt: (industry === 'bank' ? '银行豁免（dy天花板5-6%，信号不存在）' : '周期股豁免（周期顶特征：高dy见顶，保险丝不适用）') + fuseTrack(industry) }; }
  // 低dy股豁免：近3年 dy 中位 <2.5%（茅台2012/平安2018型分位失效）
  let dyMed = null;
  try {
    if (kline && divs && divs.length) {
      const series = calcRollingPercentile(kline, divs, 375);
      const r3 = series.filter(x => x.dy != null && x.d >= '2023-01-01').map(x => x.dy).sort((a, b) => a - b);
      if (r3.length >= 100) dyMed = r3[Math.floor(r3.length / 2)];
    }
  } catch (e) { }
  if (dyMed != null && dyMed < 2.5) { fuseStats.exempt['lowdy'] = (fuseStats.exempt['lowdy'] || 0) + 1; return { active: false, msg: '', exempt: '低dy股豁免（近3年dy中位<2.5%，分位失效，需PE/相对估值辅助）' + fuseTrack('lowdy'), dyMed: dyMed.toFixed(2) }; }
  if (pct < 5 && dy < 2.2) { fuseStats.active++; return { active: true, msg: '极端高估保险丝激活：自身分位' + pct.toFixed(0) + ' + 股息率' + dy.toFixed(2) + '%（<2.2%）——历史该信号=真泡沫顶（伊利2013/美的2021/茅台2020），可考虑卖出；2021后罕见触发，勿常规操作' + fuseTrack('active'), exempt: null }; }
  return { active: false, msg: '', exempt: null };
}

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
      // 历史遗留：移动 K 线源故障时股息率线暂替；2026-08-20 实测腾讯源分段拉取正常（1121 根），已解除 pending（v1.9.18）
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
  CALIB, fmt, fmtPct, $, todayStr, fmtDate, fmtMonth, daysAgo, RateLimitedQueue, jsonp, fetchJson, loadSinaKline, loadQtQuotes,
  guessSec, emSecidOf, txCodeOf, toPush2, toPlain, parseSecInput,
  fetchName, fetchDividendsAll, fetchDividendsOne, parseDivs, dedupDividends, sanitizeDividends, calcAnnualDivYield, reportYearDivAt, latestAnnouncedYear,
  tierSpot, sellSignalQuick, sellFuse, TIER_LINE,
  parseEtfAnnList, parseEtfAnnouncement, fetchEtfDividends,
  getKline, getMarketSnapshot, getStockQuotes, getIndexKline, ETF_PRESETS,
  Watchlist, cacheGet, cacheSet, cacheGetFresh,
  /* v1.9.0 新增：滚动分位/分红CAGR/除息锁定TTM/报告期归组 */
  calcRollingPercentile, calcDivCAGR, calcReportYearDivs, calcLockedTTM, ttmDivsAt, ttmDivsAtMode, alignSendZhuan, splitSpecialDivs, calcPbPercentile, computeZone, BENCH, roeBand,
  reportPeriodLabel, industryOf, verdictEngine, fetchF10Annual, trapFilter, assessIndustrySignals, finConfirm, tradingSignal, BUY_CFG, TRADE_LAYER, sigNote, SIG_STATS, ddNote, MAX_DD, P95_TRIGGERS, indKeyOf, hasBacking,
  /* v1.9.14 新增：历史战绩（招行案例三轮裁决 B/D/E + Q5/Q6） */
  trackRec, trackStat, waitGapKey, tierTrackNote, tierTrackShort,
  /* v1.9.1 新增：生态判定/起建线偏移/分位事件 */
  calcEcoType, findZoneEvents,
  /* P39（2026-08-21）：缓存卫生 */
  cachePrune,
  /* v3.2 S2：回测快照独立库（divtool-bt，不被 cachePrune 误删） */
  btGet, btSet, btDel, btList,
  /* W10（2026-08-21）：数据源状态 */
  srcMark, srcOf, srcLogAll, dataHealthLevel, caliberAudit,
  /* v1.9.3 新增：分红趋势/档位五态分类/窗口预设 */
  calcDivTrend, classifyTier, DEFAULT_WINDOW_DAYS, WINDOW_PRESETS, divForecast,
  decisionSentence, riskFreeCompare, retirementSim, requiredPrincipal,
  calcFutureCashflow,
  /* v1.9.6 新增：结论行规则树 */
  divTrendBadAt, coverageAt, ruleVerdict, RULE_STATS, RULE_TIER_LABEL,
  /* v1.9.2 新增：组合级回测 */
  calcPortfolioBacktest, simulateOne, calcComboBacktest, loadCombos, saveCombos,
  /* v1.9.18 新增：国债正式源刷新（中国货币网）；getter 实时读取（防导出快照陈旧） */
  refreshTreasury,
  get TREASURY_NOW() { return TREASURY_NOW; },
  get TREASURY_ASOF() { return TREASURY_ASOF; },
}
})();

/* ========== v3.0 组合构建器引擎（主人 00:12/00:36 拍板） ========== */
/* 单股模拟（精简版 simulate，供组合工作台/驾驶舱复用）
 * principal 初始金额, monthly 月追加, closes {d:price}, dividends [{ex,dps}], reinvest 复投, taxRate 税 */
function simulateOne(principal, monthly, closes, dividends, reinvest = true, taxRate = 0) {
  /* v3.5 C2：统一走 sim-core.js 共享纯函数（防双份代码分叉——主线程/worker 同源） */
  const r = window.simOneCore ? window.simOneCore(principal, monthly, closes, dividends, reinvest, taxRate) : null;
  if (!r) return null;
  /* 兼容旧调用方：补齐 final 结构 */
  return {
    daily: r.daily,
    buyDateReal: r.buyDateReal,
    buyPrice: r.buyPrice,
    final: r.final,
    cumDiv: r.cumDiv,
    monthlyFlow: r.monthlyFlow,
    reinvested: r.reinvested,
    monthlyTotal: r.monthlyTotal,
    extInvested: r.extInvested,
  };
}

/* 组合构建器回测（v3.0 核心）：
 * combo = [{code, name, amount(初始金额), monthly(月追加)}]
 * pool  = { code: { kline, divs, series } }（series 供智慧分位）
 * opts  = { years, monthlyMode: 'weight'|'fixed'|'smart', reinvest, taxRate }
 * 月追加口径：weight=按初始金额比例分配总月追加（Σmonthly）；fixed=每只独立值；smart=每只×分位系数(<30→2倍,>70→0.5倍)
 * 返回：{ totalAsset:[{d,value,invested,cumDiv}], threeQ:{retDivRatio, yearDiv, ...}, perStock:[...], weightEvol, divByYear, span } */
function calcComboBacktest(combo, pool, opts) {
  opts = opts || {};
  const years = opts.years || 10;
  const monthlyMode = opts.monthlyMode || 'weight';
  const reinvest = opts.reinvest !== false;
  const taxRate = opts.taxRate || 0;
  /* v1（2026-08-22）：现金仓位——初始投入留 cashPct% 现金，按 cashRate 年化滚入（默认 1.5%，货基/短债近似）；月追加全额买入；口径标注见驾驶舱 */
  const cashPct = opts.cashPct || 0;
  const cashRate = opts.cashRate != null ? opts.cashRate : 1.5;
  const from = (() => { const t = new Date(); t.setDate(t.getDate() - years * 366); return t.toISOString().slice(0, 10); })();
  const totalMonthly = (combo || []).reduce((s, x) => s + (x.monthly || 0), 0);
  const totalAmount = (combo || []).reduce((s, x) => s + (x.amount || 0), 0);
  const rows = [];
  const scale = cashPct > 0 ? (1 - cashPct / 100) : 1;
  for (const it of combo) {
    const p = pool[it.code];
    if (!p || !p.kline || !Object.keys(p.kline).length) continue;
    const dates = Object.keys(p.kline).sort();
    const kline = {};
    dates.forEach(d => { if (d >= from) kline[d] = p.kline[d]; });
    if (Object.keys(kline).length < 120) continue;
    let monthly = it.monthly || 0;
    if (monthlyMode === 'weight' && totalMonthly > 0 && totalAmount > 0) monthly = totalMonthly * (it.amount || 0) / totalAmount;
    /* v3.2 S8（主人铁律）：smart 自动乘月追加默认关（smartBoost 显式开启才乘） */
    if (monthlyMode === 'smart' && opts.smartBoost === true && p.series) {
      const last = p.series[p.series.length - 1];
      const pct = last && last.pct != null ? last.pct : 50;
      monthly = (it.monthly || 0) * (pct < 30 ? 2 : pct > 70 ? 0.5 : 1);
    }
    const sim = simulateOne((it.amount || 0) * scale, monthly, kline, p.divs, reinvest, taxRate);
    if (!sim) continue;
    rows.push({ code: it.code, name: it.name || it.code, amount: (it.amount || 0) * scale, monthly, sim });
  }
  /* 现金仓位行：cash0=初始现金，按 cashRate 年化复利滚入（月追加现金部分不另计，口径=初始留现金） */
  if (cashPct > 0 && totalAmount > 0 && rows.length) {
    const cash0 = totalAmount * cashPct / 100;
    const rate = cashRate / 100;
    const t0 = new Date(from).getTime();
    rows.push({
      code: '__CASH__', name: '现金仓位(' + cashPct + '%,年化' + cashRate + '%)', amount: cash0, monthly: 0,
      sim: { daily: null, cumDiv: 0, _cashRow: { cash0, rate, t0 } }
    });
  }
  if (!rows.length) return null;
  /* 组合汇总：按日期对齐 */
  const allDates = [];
  const dateSet = {};
  rows.forEach(r => r.sim.daily ? r.sim.daily.forEach(dd => { if (!dateSet[dd.date]) { dateSet[dd.date] = true; allDates.push(dd.date); } }) : null);
  allDates.sort();
  const totalAsset = allDates.map(d => {
    let value = 0, invested = 0, cumDiv = 0;
    rows.forEach(r => {
      if (r.sim._cashRow) {
        const yrs = Math.max(0, (new Date(d).getTime() - r.sim._cashRow.t0) / 86400000 / 365.25);
        value += r.sim._cashRow.cash0 * Math.pow(1 + r.sim._cashRow.rate, yrs);
        invested += r.sim._cashRow.cash0;
        return;
      }
      const dd = r.sim.daily.find(x => x.date === d); if (dd) { value += dd.value; invested += dd.invested; cumDiv += dd.cumDiv; }
    });
    return { d, value: +value.toFixed(2), invested: +invested.toFixed(2), cumDiv: +cumDiv.toFixed(2) };
  });
  const last = totalAsset[totalAsset.length - 1];
  /* 三问卡 */
  const divByYear = {};
  rows.forEach(r => { if (r.sim._cashRow) return; r.sim.daily.forEach(dd => { const y = dd.date.slice(0, 4); if (dd.cumDiv > 0 && r.sim.daily.find(x => x.date === dd.date).cumDiv > 0) {} }); });
  /* 年度分红：各股按年末 cumDiv 增量（跨年差=该年分红） */
  rows.forEach(r => {
    if (r.sim._cashRow) return;
    const byYear = {};
    r.sim.daily.forEach(dd => { byYear[dd.date.slice(0, 4)] = dd.cumDiv; });
    const ys = Object.keys(byYear).sort();
    let prev = 0;
    ys.forEach(y => { divByYear[y] = (divByYear[y] || 0) + (byYear[y] - prev); prev = byYear[y]; });
  });
  /* 逐年分红（对账用） */
  const divByYearOut = {};
  Object.keys(divByYear).sort().forEach(y => { divByYearOut[y] = +divByYear[y].toFixed(2); });
  /* 回本速度：累计分红÷投入成本 */
  const invested = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const cumDivTotal = rows.reduce((s, r) => s + r.sim.cumDiv, 0);
  const divRatio = invested > 0 ? cumDivTotal / invested * 100 : 0;
  /* 年分红：最近完整年的分红（divByYearOut 最大值年） */
  const ys = Object.keys(divByYearOut).sort();
  const yearDiv = ys.length ? divByYearOut[ys[ys.length - 1]] : 0;
  /* 每只贡献（排除现金行） */
  const perStock = rows.filter(r => !r.sim._cashRow).map(r => {
    const byMonth = {};
    r.sim.daily.forEach(dd => { byMonth[dd.date.slice(0, 7)] = dd; });
    const navSeries = Object.keys(byMonth).sort().map(m => +(byMonth[m].value / Math.max(1, r.amount || 1)).toFixed(3)); /* v3.2 S7：迷你图序列（每月末采样归一化） */
    /* v3.6 F1（大师 P0-3 落点）：月采样曲线内嵌 perStock——快照/缓存/排序切换自包含，个股市值曲线不再依赖外部 pool */
    /* v3.6.1 P0-1：加 cumDiv 字段（tooltip 月分红到账行需要；旧快照 undefined 容错） */
    const mSeries = Object.keys(byMonth).sort().map(m => ({ d: m + '-01', value: +(byMonth[m].value / 10000).toFixed(2), invested: +(byMonth[m].invested / 10000).toFixed(2), cumDiv: +(byMonth[m].cumDiv / 10000).toFixed(2) }));
    const byYear = {};
    r.sim.daily.forEach(dd => { byYear[dd.date.slice(0, 4)] = dd.cumDiv; });
    const ys = Object.keys(byYear).sort(); let prev = 0;
    const yearlyDivs = {};
    ys.forEach(y => { yearlyDivs[y] = +(byYear[y] - prev).toFixed(2); prev = byYear[y]; }); /* v3.2 S1：逐年分红（对账） */
    return {
      code: r.code, name: r.name, amount: r.amount, monthly: +r.monthly.toFixed(2),
      finalValue: r.sim.final.finalValue, invested: r.sim.final.finalInvested, extInvested: r.sim.extInvested,
      cumDiv: +r.sim.cumDiv.toFixed(2), ret: r.sim.final.finalValue / Math.max(1, r.sim.extInvested) - 1,   // 修复 B6（2026-08-23 接手 AI）：分母用 extInvested（本金+月追加），原用初始金额忽略月追加→回报虚高
      divRatio: r.amount > 0 ? r.sim.cumDiv / r.amount * 100 : 0,
      yearlyDivs, navSeries, mSeries, monthlyFlow: r.sim.monthlyFlow || [],
      yearly: (window.simOneCore && window.simOneCore.yearlyOf) ? window.simOneCore.yearlyOf(r.sim) : [],
    };
  });
  /* 权重演化（每年末） */
  const weightEvol = [];
  const yearsList = {};
  totalAsset.forEach(t => { yearsList[t.d.slice(0, 4)] = true; });
  Object.keys(yearsList).sort().forEach(y => {
    const yearEnd = totalAsset.filter(t => t.d.slice(0, 4) === y).pop();
    if (!yearEnd) return;
    const wt = {};
    let sum = 0;
    rows.forEach(r => { const dd = r.sim._cashRow ? null : (r.sim.daily.find(x => x.date === yearEnd.d)); const v = dd ? dd.value : 0; wt[r.code] = v; sum += v; });
    Object.keys(wt).forEach(c => { wt[c] = sum > 0 ? wt[c] / sum * 100 : 0; });
    weightEvol.push({ y, weights: wt });
  });
  return {
    totalAsset, last, divRatio, cumDivTotal, yearDiv, perStock, weightEvol, divByYear: divByYearOut,
    span: years, invested, monthlyMode, rows: rows.length,
  };
}

/* 组合配置存取（localStorage，存配置不存结果） */
const COMBO_KEY = 'divtool_combos_v1';
function loadCombos() { try { return JSON.parse(localStorage.getItem(COMBO_KEY)) || { combos: [], activeId: null }; } catch (e) { return { combos: [], activeId: null }; } }
function saveCombos(c) { localStorage.setItem(COMBO_KEY, JSON.stringify(c)); }

/* ---------- v3.2 S2：回测快照独立库（divtool-bt，不被 cachePrune 误删） ----------
 * 动机（M586）：回测结果之前走 divtool-cache，会被缓存卫生（>50MB 删 7 天前 key）误删。
 * 策略：独立 IndexedDB 库 divtool-bt / store snapshots；分存 meta（列表秒开）+ full（完整结果）。
 * 上限：固定快照 10 + 自动快照 10（滚动删最旧），由调用方 enforce。 */
const BT_DB = 'divtool-bt', BT_VER = 1, BT_STORE = 'snapshots';
let _btDb = null;
function openBtDB() {
  return new Promise((resolve, reject) => {
    if (_btDb) return resolve(_btDb);
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('IndexedDB 超时')); } }, 5000);
    const req = indexedDB.open(BT_DB, BT_VER);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(BT_STORE)) req.result.createObjectStore(BT_STORE); };
    req.onsuccess = () => { if (done) return; done = true; clearTimeout(timer); _btDb = req.result; resolve(_btDb); };
    req.onerror = () => { if (done) return; done = true; clearTimeout(timer); reject(req.error); };
  });
}
async function btGet(key) {
  try { const db = await openBtDB(); return await new Promise((res, rej) => { const r = db.transaction(BT_STORE).objectStore(BT_STORE).get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); }); }
  catch (e) { return null; }
}
async function btSet(key, val) {
  try { const db = await openBtDB(); await new Promise((res, rej) => { const r = db.transaction(BT_STORE, 'readwrite').objectStore(BT_STORE).put(val, key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); return true; }
  catch (e) { return false; }
}
async function btDel(key) {
  try { const db = await openBtDB(); await new Promise((res, rej) => { const r = db.transaction(BT_STORE, 'readwrite').objectStore(BT_STORE).delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); return true; }
  catch (e) { return false; }
}
/* 列出全部快照条目（key 前缀过滤 + 大小估算） */
async function btList(prefix) {
  try {
    const db = await openBtDB();
    const out = [];
    await new Promise((res, rej) => {
      const cur = db.transaction(BT_STORE).objectStore(BT_STORE).openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c) { const k = String(c.key); if (!prefix || k.startsWith(prefix)) out.push({ key: k, val: c.value, size: JSON.stringify(c.value).length }); c.continue(); } else res(); };
      cur.onerror = () => rej(cur.error);
    });
    return out;
  } catch (e) { return []; }
}
