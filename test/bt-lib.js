#!/usr/bin/env node
/* bt-lib.js — v9.2 回测公共库（P1/P2/P4/P5/P6 共用）
 * 数据源：
 *   - 日K+分红：data/rule-tree-cache.json（42 只，真实历史，宇通/移动已补拉）
 *   - 财务年报序列：东财 F10（扣非/OCF/毛利率/BPS），本地缓存 test/.f10-cache.json
 *   - 指数：沪深300（sina 全量）、中证红利 000922（腾讯 ifzq 分页），本地缓存 test/.index-cache.json
 * 口径：与 test/signal-effectiveness.js 同源（DL.calcRollingPercentile / zoneEvents / buyReturn / baseline）
 */
'use strict';
global.window = global;
require(require('path').resolve(__dirname, '..', 'data-layer.js'));
const DL = global.window.DL;
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'data', 'rule-tree-cache.json');
const F10_CACHE = path.join(__dirname, '.f10-cache.json');
const IDX_CACHE = path.join(__dirname, '.index-cache.json');

/* ---------- 42 只标的（行业分组） ---------- */
const STOCKS = [
  { code: '600036', name: '招商银行', ind: 'bank' }, { code: '601398', name: '工商银行', ind: 'bank' },
  { code: '601988', name: '中国银行', ind: 'bank' }, { code: '601288', name: '农业银行', ind: 'bank' },
  { code: '601328', name: '交通银行', ind: 'bank' }, { code: '600016', name: '民生银行', ind: 'bank' },
  { code: '000001', name: '平安银行', ind: 'bank' }, { code: '601166', name: '兴业银行', ind: 'bank' },
  { code: '600519', name: '贵州茅台', ind: 'consumer' }, { code: '000858', name: '五粮液', ind: 'consumer' },
  { code: '000895', name: '双汇发展', ind: 'consumer' }, { code: '600887', name: '伊利股份', ind: 'consumer' },
  { code: '000651', name: '格力电器', ind: 'consumer' }, { code: '000333', name: '美的集团', ind: 'consumer' },
  { code: '600690', name: '海尔智家', ind: 'consumer' },
  { code: '601318', name: '中国平安', ind: 'insurer' }, { code: '601628', name: '中国人寿', ind: 'insurer' },
  { code: '601601', name: '中国太保', ind: 'insurer' },
  { code: '600900', name: '长江电力', ind: 'utility' }, { code: '600886', name: '国投电力', ind: 'utility' },
  { code: '600027', name: '华电国际', ind: 'utility' }, { code: '600795', name: '国电电力', ind: 'utility' },
  { code: '601985', name: '中国核电', ind: 'utility' },
  { code: '600028', name: '中国石化', ind: 'energy' }, { code: '601857', name: '中国石油', ind: 'energy' },
  { code: '601088', name: '中国神华', ind: 'energy' }, { code: '600188', name: '兖矿能源', ind: 'energy' },
  { code: '601225', name: '陕西煤业', ind: 'energy' }, { code: '601899', name: '紫金矿业', ind: 'metal' },
  { code: '601600', name: '中国铝业', ind: 'metal' },
  { code: '000100', name: 'TCL科技', ind: 'manu' }, { code: '600585', name: '海螺水泥', ind: 'manu' },
  { code: '601668', name: '中国建筑', ind: 'manu' }, { code: '601390', name: '中国中铁', ind: 'manu' },
  { code: '600031', name: '三一重工', ind: 'manu' }, { code: '600104', name: '上汽集团', ind: 'manu' },
  { code: '600019', name: '宝钢股份', ind: 'manu' }, { code: '600066', name: '宇通客车', ind: 'manu' },
  { code: '601006', name: '大秦铁路', ind: 'trans' }, { code: '600009', name: '上海机场', ind: 'trans' },
  { code: '601111', name: '中国国航', ind: 'trans' },
  { code: '600941', name: '中国移动', ind: 'telecom' },
];
const IND = {};
STOCKS.forEach(s => { (IND[s.ind] = IND[s.ind] || []).push(s.code); });
const NAME = {};
STOCKS.forEach(s => { NAME[s.code] = s.name; });
/* 命门包分组（P4） */
const P4_PACK = {
  bank:    { label: '银行', codes: IND.bank,     signals: ['扣非转负', '扣非下滑', 'OCF<0.5'] },
  insurer: { label: '保险', codes: IND.insurer,  signals: ['扣非转负', '扣非下滑', 'OCF<0.5'] },
  telecom: { label: '电信', codes: IND.telecom,  signals: ['扣非转负', '扣非下滑'] },
  manuCon: { label: '制造消费', codes: [...IND.manu, ...IND.consumer, ...IND.trans], signals: ['扣非转负', '扣非下滑', 'OCF<0.5', '毛利率连降'] },
};

/* ---------- 基础加载 ---------- */
function loadCache() { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
function loadStock(cache, code) {
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { code, kline, divs };
}
function datesOf(kline) { return Object.keys(kline).sort(); }
function firstAfter(dates, dStr) { return dates.find(d => d >= dStr) || null; }

/* ---------- 收益口径（同 signal-effectiveness.js） ---------- */
/* buyIdx 日起持有 holdDays 交易日；价格+分红双口径；分红=持有期内除息日 dps 之和 */
function buyReturn(kline, dates, divs, buyIdx, holdDays) {
  const sellIdx = buyIdx + holdDays;
  if (sellIdx >= dates.length) return null;
  const buyP = kline[dates[buyIdx]], sellP = kline[dates[sellIdx]];
  if (!(buyP > 0) || !(sellP > 0)) return null;
  const buyD = dates[buyIdx], sellD = dates[sellIdx];
  let divSum = 0;
  divs.forEach(d => { if (d.ex && d.dps > 0 && d.ex > buyD && d.ex <= sellD) divSum += d.dps; });
  return { priceRet: sellP / buyP - 1, divRet: divSum / buyP, totalRet: (sellP + divSum) / buyP - 1, divYield: divSum / buyP };
}
/* 基准：同股全时段均匀抽样买入的均值收益 */
function baseline(kline, dates, divs, holdDays, nSamples) {
  const maxIdx = dates.length - 1 - holdDays;
  if (maxIdx < 100) return null;
  const step = Math.max(1, Math.floor(maxIdx / (nSamples || 800)));
  let sumP = 0, sumT = 0, sumD = 0, n = 0;
  for (let i = 0; i <= maxIdx; i += step) {
    const r = buyReturn(kline, dates, divs, i, holdDays);
    if (!r) continue;
    sumP += r.priceRet; sumT += r.totalRet; sumD += r.divRet; n++;
  }
  return { priceRet: sumP / n, totalRet: sumT / n, divRet: sumD / n, n };
}

/* ---------- 触发事件（同口径） ---------- */
/* dy 连续达标区间首日（股息率口径） */
function zoneEventsDy(series, line) {
  const evs = [];
  let inZ = false, start = null;
  for (const x of series) {
    if (x.dy == null) continue;
    if (x.dy >= line) { if (!inZ) { inZ = true; start = x.d; } }
    else { if (inZ) { evs.push(start); inZ = false; } }
  }
  if (inZ) evs.push(start);
  return evs;
}
/* 分位口径事件（DL.findZoneEvents 封装，返回 start 数组） */
function zoneEventsPct(series, tierPct) {
  return DL.findZoneEvents(series, tierPct).map(e => e.start);
}
/* 行业买点线（同 BENCH） */
function tierLines(ind) {
  const b = DL.BENCH[ind];
  if (!b) return null;
  return { mid: b.yieldMid, line: b.yieldMid + b.yieldUp, heavy: b.yieldMid + b.yieldUp + 1 };
}

/* ---------- 交易费用（P1 用）：佣金万2.5 双边 + 印花税卖出 0.05%（2023-08 后现行） ---------- */
const COST = { commission: 0.00025, stampSell: 0.0005 };
function buyCost(amount) { return amount * COST.commission; }
function sellCost(amount) { return amount * (COST.commission + COST.stampSell); }

/* ---------- 东财 F10 年报序列（扣非/OCF/毛利率/BPS，真实历史） ---------- */
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJson(f, o) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o), 'utf8'); } catch (e) {} }
async function fetchF10All(codes, force) {
  const cache = readJson(F10_CACHE) || {};
  const missing = codes.filter(c => !force && cache[c] && cache[c].length);
  const todo = codes.filter(c => !missing.includes(c));
  for (const c of todo) {
    try {
      const f10 = await DL.fetchF10Annual(c);
      cache[c] = (f10 && f10.annuals) || [];
      process.stderr.write(`F10 ${c} → ${cache[c].length} 年报\n`);
      writeJson(F10_CACHE, cache);
    } catch (e) {
      cache[c] = cache[c] || [];
      process.stderr.write(`F10 ${c} ERR ${e.message}\n`);
    }
    await new Promise(r => setTimeout(r, 120));
  }
  if (todo.length) writeJson(F10_CACHE, cache);
  return cache;
}

/* ---------- 指数数据 ---------- */
/* 沪深300：sina 全量（已验证到 2026-08-20）；中证红利 000922：腾讯 ifzq 分页（sina 停在 2019，腾讯有全量） */
async function fetchIndexSina(sym) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=10000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  const j = JSON.parse(await r.text());
  const out = {};
  j.forEach(x => { const c = parseFloat(x.close); if (c > 0) out[x.day] = c; });
  return out;
}
async function fetchIndexTencent(sym, fromY) {
  const out = {};
  let end = '2026-08-20';
  for (let guard = 0; guard < 40; guard++) {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,2010-01-01,${end},640,qfq`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://gu.qq.com/' } });
    const j = await r.json();
    const d = j.data && j.data[sym];
    const kl = (d && (d.qfqday || d.day)) || [];
    if (!kl.length) break;
    let oldest = null;
    kl.forEach(row => {
      const dt = row[0];
      const c = parseFloat(row[2]);
      if (c > 0) out[dt] = c;
      if (!oldest || dt < oldest) oldest = dt;
    });
    if (oldest <= (fromY || '2010-01-01')) break;
    end = oldest;
  }
  return out;
}
async function fetchIndexAll(force) {
  const cache = readJson(IDX_CACHE) || {};
  if (!force && cache['000300'] && cache['000922'] && Object.keys(cache['000922']).length > 3000) return cache;
  cache['000300'] = await fetchIndexSina('sh000300');
  cache['000922'] = await fetchIndexTencent('sh000922');
  writeJson(IDX_CACHE, cache);
  return cache;
}

/* ---------- 统计工具 ---------- */
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const stdev = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
};
function pct(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
function annualize(ret, years) { return years > 0 ? Math.pow(1 + ret, 1 / years) - 1 : 0; }
/* 日收益序列 → 年化 + 最大回撤 + 夏普（rf 年化，默认 2%） */
function perfStats(dailyVals, rf = 0.02) {
  const rets = [];
  for (let i = 1; i < dailyVals.length; i++) {
    if (dailyVals[i - 1] > 0) rets.push(dailyVals[i] / dailyVals[i - 1] - 1);
  }
  const n = rets.length;
  if (!n) return null;
  const total = dailyVals[dailyVals.length - 1] / dailyVals[0] - 1;
  const years = n / 250;
  const ann = annualize(total, years);
  const vol = stdev(rets) * Math.sqrt(250);
  const sharpe = vol > 0 ? (ann - rf) / vol : 0;
  let peak = -Infinity, mdd = 0;
  dailyVals.forEach(v => { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > mdd) mdd = dd; });
  return { total, annual: ann, vol, sharpe, mdd, n, years };
}

module.exports = {
  DL, STOCKS, IND, NAME, P4_PACK, ROOT, CACHE_FILE,
  loadCache, loadStock, datesOf, firstAfter, buyReturn, baseline,
  zoneEventsDy, zoneEventsPct, tierLines, COST, buyCost, sellCost,
  fetchF10All, fetchIndexAll, mean, stdev, pct, annualize, perfStats,
};
