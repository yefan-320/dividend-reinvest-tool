#!/usr/bin/env node
/* 档位专项策略模拟（v1.9.4 前置研究，R12 大师确认分三类）
 * 回答：建仓线是否应上移（80→85/90）？
 * R9 单档回测：90 档 10年收益比 80 档高 18.4pp，但单档≠策略结论（条件性偏差：只统计了
 * 已触发事件，没算"等90期间踏空"成本）。本脚本做策略级模拟：
 *   a. 80金字塔 80/85/90 各1/3   b. 85金字塔 85/90/95 各1/3
 *   c. 90单档（等90全仓）        d. 80单档（80全仓·基准）
 * 分三类：可等90型(13) / 边界型(6) / 陷阱+稀缺型(21)
 * 口径：375窗口，价格+分红收益（buyAfterNDiv 逻辑，同 tier-vs-window.js）
 * 额外：①错过风险（等90档的踏空统计：90事件最长间隔+间隔内最大涨幅）
 *      ②柔性模式联动（柔性70/80/90 vs 保守80/85/90，边界型重点）
 * 输出：终端汇总表 + /tmp/tier-strategy-result.md（结论+数字+建议方向）
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');

const WINDOW = 375;
const OUT_MD = '/tmp/tier-strategy-result.md';
const CACHE_F = '/tmp/tier-sim-cache.json';   // 重跑复用，避免重复拉取
const _cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE_F, 'utf8')); } catch (e) { return {}; } })();
function saveCache() { try { fs.writeFileSync(CACHE_F, JSON.stringify(_cache), 'utf8'); } catch (e) {} }

const STOCKS = [
  { code: '600036', name: '招商银行', tx: 'sh600036' }, { code: '601398', name: '工商银行', tx: 'sh601398' },
  { code: '601988', name: '中国银行', tx: 'sh601988' }, { code: '601288', name: '农业银行', tx: 'sh601288' },
  { code: '601328', name: '交通银行', tx: 'sh601328' }, { code: '600016', name: '民生银行', tx: 'sh600016' },
  { code: '000001', name: '平安银行', tx: 'sz000001' }, { code: '601166', name: '兴业银行', tx: 'sh601166' },
  { code: '600519', name: '贵州茅台', tx: 'sh600519' }, { code: '000858', name: '五粮液', tx: 'sz000858' },
  { code: '000895', name: '双汇发展', tx: 'sz000895' }, { code: '600887', name: '伊利股份', tx: 'sh600887' },
  { code: '601318', name: '中国平安', tx: 'sh601318' }, { code: '601628', name: '中国人寿', tx: 'sh601628' },
  { code: '601601', name: '中国太保', tx: 'sh601601' },
  { code: '600900', name: '长江电力', tx: 'sh600900' }, { code: '600886', name: '国投电力', tx: 'sh600886' },
  { code: '600027', name: '华电国际', tx: 'sh600027' }, { code: '600795', name: '国电电力', tx: 'sh600795' },
  { code: '601985', name: '中国核电', tx: 'sh601985' },
  { code: '600028', name: '中国石化', tx: 'sh600028' }, { code: '601857', name: '中国石油', tx: 'sh601857' },
  { code: '601088', name: '中国神华', tx: 'sh601088' }, { code: '600188', name: '兖矿能源', tx: 'sh600188' },
  { code: '601225', name: '陕西煤业', tx: 'sh601225' },
  { code: '000651', name: '格力电器', tx: 'sz000651' }, { code: '000333', name: '美的集团', tx: 'sz000333' },
  { code: '600690', name: '海尔智家', tx: 'sh600690' }, { code: '000100', name: 'TCL科技', tx: 'sz000100' },
  { code: '600585', name: '海螺水泥', tx: 'sh600585' }, { code: '601668', name: '中国建筑', tx: 'sh601668' },
  { code: '601390', name: '中国中铁', tx: 'sh601390' }, { code: '600031', name: '三一重工', tx: 'sh600031' },
  { code: '601006', name: '大秦铁路', tx: 'sh601006' }, { code: '600104', name: '上汽集团', tx: 'sh600104' },
  { code: '600019', name: '宝钢股份', tx: 'sh600019' }, { code: '601899', name: '紫金矿业', tx: 'sh601899' },
  { code: '601600', name: '中国铝业', tx: 'sh601600' }, { code: '600009', name: '上海机场', tx: 'sh600009' },
  { code: '601111', name: '中国国航', tx: 'sh601111' },
];

/* ---------- 数据拉取（同 tier-vs-window.js） ---------- */
async function fetchKlineSina(tx) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tx}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  return JSON.parse(await r.text()).map(x => ({ d: x.day, close: parseFloat(x.close) })).filter(x => x.close > 0);
}
async function fetchDivs(code, tryN = 1) {
  const cols = 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,ASSIGN_PROGRESS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://data.eastmoney.com/', 'Accept': 'application/json, text/plain, */*' } });
  const j = await r.json();
  if (!j.result || !j.result.data) { if (tryN < 5) { await new Promise(r2 => setTimeout(r2, tryN * 4000)); return fetchDivs(code, tryN + 1); } return []; }
  return (j.result.data || []).filter(x => x.EX_DIVIDEND_DATE && (x.ASSIGN_PROGRESS || '').indexOf('实施') >= 0).map(x => ({ ex: x.EX_DIVIDEND_DATE.slice(0, 10), dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10 }));
}

/* ---------- 收益口径（同 tier-vs-window.js：价格+分红，固定年限前瞻） ---------- */
function addDays(dStr, days) { const d = new Date(dStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function buyAfterNDiv(klines, divs, buyD, years) {
  const bi = klines.findIndex(x => x.d >= buyD);
  if (bi < 0) return null;
  const bp = klines[bi].close;
  const endD = addDays(buyD, years * 365);
  const ti = klines.findIndex(x => x.d >= endD);
  if (ti < 0) return null;
  let divSum = 0;
  for (const dv of divs) { if (dv.ex && dv.ex >= buyD && dv.ex <= endD) divSum += dv.dps; }
  return (klines[ti].close - bp + divSum) / bp * 100;
}

/* ---------- 统计工具 ---------- */
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

/* ---------- 策略级混合收益：每股票一策略 = 各档事件按份额加权（部署资金口径，同工具 calcPortfolioBacktest） ---------- */
function strategyBlend(s, tiers, horizon) {
  const ser = DL.calcRollingPercentile(s.km, s.divs, WINDOW);
  let rSum = 0, wSum = 0, nBuy = 0, cfgFrac = 0, covered = 0;
  for (const t of tiers) {
    cfgFrac += t.frac;
    let tierHit = 0;
    for (const ev of DL.findZoneEvents(ser, t.pct)) {
      const r = buyAfterNDiv(s.klines, s.divs, ev.start, horizon);
      if (r == null) continue;
      rSum += r * t.frac; wSum += t.frac; nBuy++; tierHit++;
    }
    if (tierHit > 0) covered += t.frac;   // 该档至少命中一次 → 份额计入部署覆盖
  }
  if (!wSum) return null;
  return { ret: rSum / wSum, nBuy, deploy: covered / cfgFrac };   // 部署覆盖：配置份额中被实际触发的比例（0-1）
}

/* ---------- 错过风险：等90档踏空统计 ---------- */
function missRisk(s) {
  const ser = DL.calcRollingPercentile(s.km, s.divs, WINDOW);
  const evs90 = DL.findZoneEvents(ser, 90);
  const kd = s.klines;
  const lastD = kd[kd.length - 1].d;
  const pctDates = ser.filter(x => x.pct != null);
  if (!pctDates.length) return null;
  const startD = pctDates[0].d;
  // 等待段：分位<90 的区间（90事件之间 + 首事件前 + 末事件后）
  const segs = [];
  let prev = startD;
  for (const ev of evs90) { segs.push({ from: prev, to: ev.start }); prev = ev.end; }
  segs.push({ from: prev, to: lastD });
  const analyze = segs.filter(g => g.to > g.from).map(g => {
    const days = Math.round((new Date(g.to) - new Date(g.from)) / 86400000);
    const fi = kd.findIndex(x => x.d >= g.from);
    const ti = kd.findIndex(x => x.d >= g.to);
    let rise = null;
    if (fi >= 0 && ti > fi) {
      const fromP = kd[fi].close;
      let maxP = fromP;
      for (let j = fi; j < Math.min(ti + 1, kd.length); j++) if (kd[j].close > maxP) maxP = kd[j].close;
      if (fromP > 0) rise = (maxP / fromP - 1) * 100;   // 间隔内价格最大涨幅 = 踏空成本
    }
    return { days, rise, open: g.to >= lastD };
  }).filter(x => x.days > 0);
  const longest = analyze.length ? analyze.reduce((a, b) => (b.days > a.days ? b : a)) : null;
  const maxRiseSeg = analyze.length ? analyze.reduce((a, b) => (b.rise != null && (a.rise == null || b.rise > a.rise) ? b : a)) : null;
  const openSeg = analyze.find(x => x.open) || null;
  return { n90: evs90.length, longest, maxRiseSeg, openSeg };
}

/* ---------- 策略定义 ---------- */
const STRATS = [
  { key: 'pyra80', name: '80金字塔(80/85/90各1/3)', tiers: [{ pct: 80, frac: 1 / 3 }, { pct: 85, frac: 1 / 3 }, { pct: 90, frac: 1 / 3 }] },
  { key: 'pyra85', name: '85金字塔(85/90/95各1/3)', tiers: [{ pct: 85, frac: 1 / 3 }, { pct: 90, frac: 1 / 3 }, { pct: 95, frac: 1 / 3 }] },
  { key: 's90', name: '90单档(等90全仓)', tiers: [{ pct: 90, frac: 1 }] },
  { key: 's80', name: '80单档(80全仓·基准)', tiers: [{ pct: 80, frac: 1 }] },
];
const FLEX = [
  { key: 'flex70', name: '柔性70/80/90(各20%，95→80%封顶)', tiers: [{ pct: 70, frac: 0.2 }, { pct: 80, frac: 0.2 }, { pct: 90, frac: 0.2 }, { pct: 95, frac: 0.2 }] },
  { key: 'consv80', name: '保守80/85/90(各1/3)', tiers: [{ pct: 80, frac: 1 / 3 }, { pct: 85, frac: 1 / 3 }, { pct: 90, frac: 1 / 3 }] },
];

function fmtMed(v) { return v == null ? '—' : v.toFixed(1) + '%'; }
function fmtWin(a) { return a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '—'; }

async function main() {
  const all = [];
  for (const s of STOCKS) {
    if (!_cache[s.code]) {
      await new Promise(r => setTimeout(r, 600));   // 限速
      try {
        const klines = await fetchKlineSina(s.tx);
        const divs = await fetchDivs(s.code);
        if (!divs.length) { console.log(`⚠️ ${s.name} 分红空`); continue; }
        _cache[s.code] = { k: klines, d: divs };
        saveCache();
      } catch (e) { console.log(`❌ ${s.name}: ${e.message}`); continue; }
    }
    const klines = _cache[s.code].k, divs = _cache[s.code].d;
      const km = {}; klines.forEach(x => km[x.d] = x.close);
      const cls = DL.classifyTier(s.code).cls;
      all.push({ ...s, klines, divs, km, cls });
      console.log(`✅ ${s.name} (${cls})`);
  }
  console.log(`\n有效 ${all.length} 只\n`);

  // 分组
  const groups = [
    { key: 'wait90', label: '可等90型', stocks: all.filter(x => x.cls === 'wait90') },
    { key: 'neutral', label: '边界型', stocks: all.filter(x => x.cls === 'neutral') },
    { key: 'rest', label: '陷阱+稀缺型', stocks: all.filter(x => x.cls !== 'wait90' && x.cls !== 'neutral') },
  ];

  const md = [];
  const now = new Date();
  md.push(`# 档位专项策略模拟结果（v1.9.4 前置研究）`);
  md.push(`\n> 日期：${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ｜ 窗口：375 ｜ 口径：价格+分红（buyAfterNDiv） ｜ 有效 ${all.length} 只`);
  md.push(`> 方法：每股票×策略 = 各档事件按份额加权的混合收益（部署资金口径，同工具 calcPortfolioBacktest）→ 组内中位/胜率（n=股票数）`);
  md.push(`> 分组：可等90型 ${groups[0].stocks.length} 只（wait90）｜边界型 ${groups[1].stocks.length} 只（neutral）｜陷阱+稀缺型 ${groups[2].stocks.length} 只（trap${all.filter(x=>x.cls==='trap').length}+direct${all.filter(x=>x.cls==='direct').length}+dull${all.filter(x=>x.cls==='dull').length}）\n`);

  /* ================= ① 每类×策略 5年/10年 ================= */
  console.log('=== ① 每类 × 策略（5年/10年收益中位，n=股票数） ===');
  console.log('组'.padEnd(8), '策略'.padEnd(22), '5年中位'.padEnd(9), '5年胜率'.padEnd(7), 'n5'.padEnd(4), '10年中位'.padEnd(9), '10年胜率'.padEnd(7), 'n10');
  md.push(`\n## 一、每类 × 策略收益表\n`);
  md.push(`| 组 | 策略 | 5年中位 | 5年胜率 | n5 | 10年中位 | 10年胜率 | n10 |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  const stratRows = {};
  for (const g of groups) {
    stratRows[g.key] = {};
    for (const st of STRATS) {
      const a5 = [], a10 = [];
      for (const s of g.stocks) {
        const x5 = strategyBlend(s, st.tiers, 5); if (x5) a5.push(x5.ret);
        const x10 = strategyBlend(s, st.tiers, 10); if (x10) a10.push(x10.ret);
      }
      stratRows[g.key][st.key] = { a5, a10 };
      const m5 = med(a5), m10 = med(a10);
      console.log(g.label.padEnd(8), st.name.padEnd(22),
        (m5 != null ? m5.toFixed(1) + '%' : '—').padEnd(9), fmtWin(a5).padEnd(7), String(a5.length).padEnd(4),
        (m10 != null ? m10.toFixed(1) + '%' : '—').padEnd(9), fmtWin(a10).padEnd(7), String(a10.length));
      md.push(`| ${g.label} | ${st.name} | ${fmtMed(m5)} | ${fmtWin(a5)} | ${a5.length} | ${fmtMed(m10)} | ${fmtWin(a10)} | ${a10.length} |`);
    }
  }

  // 90单档含踏空修正（从未触发90的股票按 0 计入 —— 等90但永远没等到 = 现金收益 0）
  console.log('\n90单档含踏空修正（从未触发90档的股票按 0 现金计入）：');
  md.push(`\n> **90单档含踏空修正**：从未触发过 90 档的股票（全程空等）按 0% 现金收益计入。若与"仅统计已触发事件"差异大，说明等90存在系统性踏空风险。\n`);
  md.push(`| 组 | 口径 | 5年中位 | 5年胜率 | n5 | 10年中位 | 10年胜率 | n10 |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  for (const g of groups) {
    const filled = { a5: [], a10: [] }, adj = { a5: [], a10: [] };
    for (const s of g.stocks) {
      const ser = DL.calcRollingPercentile(s.km, s.divs, WINDOW);
      const has90 = DL.findZoneEvents(ser, 90).length > 0;
      for (const h of [5, 10]) {
        const r = strategyBlend(s, [{ pct: 90, frac: 1 }], h);
        if (r) { filled['a' + h].push(r.ret); adj['a' + h].push(r.ret); }
        else if (!has90) adj['a' + h].push(0);   // 全程踏空 → 0
      }
    }
    for (const h of [5, 10]) {
      const key = 'a' + h;
      const mF = med(filled[key]), mA = med(adj[key]);
      console.log(`${g.label} ${h}年: 仅触发中位 ${mF != null ? mF.toFixed(1) + '%' : '—'} (n=${filled[key].length}) | 含踏空中位 ${mA != null ? mA.toFixed(1) + '%' : '—'} (n=${adj[key].length})`);
    }
    md.push(`| ${g.label} | 仅已触发 | ${fmtMed(med(filled.a5))} | ${fmtWin(filled.a5)} | ${filled.a5.length} | ${fmtMed(med(filled.a10))} | ${fmtWin(filled.a10)} | ${filled.a10.length} |`);
    md.push(`| ${g.label} | 含踏空 | ${fmtMed(med(adj.a5))} | ${fmtWin(adj.a5)} | ${adj.a5.length} | ${fmtMed(med(adj.a10))} | ${fmtWin(adj.a10)} | ${adj.a10.length} |`);
  }

  /* ================= ② 错过风险 ================= */
  console.log('\n=== ② 错过风险（等90档踏空统计） ===');
  console.log('组'.padEnd(8), '90事件均数'.padEnd(9), '填充率'.padEnd(7), '最长间隔天(中/大)'.padEnd(18), '间隔内最大涨幅%(中/大)'.padEnd(22), '当前未触发'.padEnd(9), '当前等待涨幅%中位');
  md.push(`\n## 二、错过风险（等90档的踏空成本）\n`);
  md.push(`> 等待段 = 90档事件之间的区间（含首事件前、末事件后）。"间隔内最大涨幅" = 该等待段内价格从段首到段内峰值涨幅，即"等90期间踏空成本"。\n`);
  md.push(`| 组 | 90事件均数 | 填充率(≥1次) | 最长间隔天(中/最大) | 间隔内最大涨幅%(中/最大) | 当前未触发(只) | 当前等待涨幅%中位 |`);
  md.push(`|---|---|---|---|---|---|---|`);
  for (const g of groups) {
    const infos = [];
    for (const s of g.stocks) { const m = missRisk(s); if (m) infos.push(m); }
    const n90Mean = mean(infos.map(x => x.n90));
    const fillRate = infos.filter(x => x.n90 > 0).length / infos.length * 100;
    const longDays = infos.filter(x => x.longest).map(x => x.longest.days);
    const longRise = infos.filter(x => x.longest && x.longest.rise != null).map(x => x.longest.rise);
    const maxRiseAll = infos.filter(x => x.maxRiseSeg && x.maxRiseSeg.rise != null).map(x => x.maxRiseSeg.rise);
    const openCnt = infos.filter(x => x.openSeg && x.openSeg.days > 60).length;   // 当前空等>2个月
    const openRise = infos.filter(x => x.openSeg && x.openSeg.rise != null).map(x => x.openSeg.rise);
    const ldM = med(longDays), ldX = longDays.length ? Math.max(...longDays) : null;
    const lrM = med(longRise), lrX = longRise.length ? Math.max(...longRise) : null;
    const mrM = med(maxRiseAll), mrX = maxRiseAll.length ? Math.max(...maxRiseAll) : null;
    const oR = med(openRise);
    console.log(g.label.padEnd(8),
      n90Mean.toFixed(1).padEnd(9), (fillRate.toFixed(0) + '%').padEnd(7),
      `${ldM != null ? ldM.toFixed(0) : '—'}/${ldX != null ? ldX.toFixed(0) : '—'}`.padEnd(18),
      `${lrM != null ? lrM.toFixed(0) + '%' : '—'}/${lrX != null ? lrX.toFixed(0) + '%' : '—'}`.padEnd(22),
      String(openCnt).padEnd(9), oR != null ? oR.toFixed(1) + '%' : '—');
    md.push(`| ${g.label} | ${n90Mean.toFixed(1)} | ${fillRate.toFixed(0)}% | ${ldM != null ? ldM.toFixed(0) : '—'} / ${ldX != null ? ldX.toFixed(0) : '—'} | ${lrM != null ? lrM.toFixed(0) : '—'}% / ${lrX != null ? lrX.toFixed(0) : '—'}% | ${openCnt} | ${oR != null ? oR.toFixed(1) + '%' : '—'} |`);
    md.push(`> 　（补：全等待段最大涨幅中位 ${mrM != null ? mrM.toFixed(1) + '%' : '—'}，最大 ${mrX != null ? mrX.toFixed(1) + '%' : '—'}）`);
  }

  /* ================= ③ 柔性模式联动 ================= */
  console.log('\n=== ③ 柔性模式联动（柔性70/80/90 vs 保守80/85/90） ===');
  console.log('组'.padEnd(8), '策略'.padEnd(26), '部署中位'.padEnd(8), '5年中位'.padEnd(9), '5年胜率'.padEnd(7), 'n5'.padEnd(4), '10年中位'.padEnd(9), '10年胜率'.padEnd(7), 'n10');
  md.push(`\n## 三、柔性模式联动（边界型重点）\n`);
  md.push(`> 柔性70/80/90：各档触发加 20%（95 封顶 80%），部署资金上限 80%；保守80/85/90：各 1/3，上限 100%。"部署中位" = 实际触发份额 / 配置份额（中位，按10年口径）。\n`);
  md.push(`| 组 | 策略 | 部署中位 | 5年中位 | 5年胜率 | n5 | 10年中位 | 10年胜率 | n10 |`);
  md.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const g of groups) {
    for (const st of FLEX) {
      const a5 = [], a10 = [], dep = [];
      for (const s of g.stocks) {
        const x5 = strategyBlend(s, st.tiers, 5); if (x5) { a5.push(x5.ret); }
        const x10 = strategyBlend(s, st.tiers, 10); if (x10) { a10.push(x10.ret); dep.push(x10.deploy); }
      }
      const m5 = med(a5), m10 = med(a10), mdDep = med(dep);
      console.log(g.label.padEnd(8), st.name.padEnd(26),
        (mdDep != null ? (mdDep * 100).toFixed(0) + '%' : '—').padEnd(8),
        (m5 != null ? m5.toFixed(1) + '%' : '—').padEnd(9), fmtWin(a5).padEnd(7), String(a5.length).padEnd(4),
        (m10 != null ? m10.toFixed(1) + '%' : '—').padEnd(9), fmtWin(a10).padEnd(7), String(a10.length));
      md.push(`| ${g.label} | ${st.name} | ${mdDep != null ? (mdDep * 100).toFixed(0) + '%' : '—'} | ${fmtMed(m5)} | ${fmtWin(a5)} | ${a5.length} | ${fmtMed(m10)} | ${fmtWin(a10)} | ${a10.length} |`);
    }
  }

  /* ================= ④ 结论与建议 ================= */
  console.log('\n=== ④ 结论与建议方向 ===');
  const recs = [];
  for (const g of groups) {
    const r = stratRows[g.key];
    const cmp = (k1, k2, h) => {
      const m1 = med(r[k1]['a' + h]), m2 = med(r[k2]['a' + h]);
      if (m1 == null || m2 == null) return null;
      return m1 - m2;
    };
    // 可等90型判据：85金字塔 vs 80金字塔 的 10年差；90单档含踏空 vs 80单档
    const d10_p85 = cmp('pyra85', 'pyra80', 10), d10_s90 = cmp('s90', 's80', 10);
    const d5_p85 = cmp('pyra85', 'pyra80', 5), d5_s90 = cmp('s90', 's80', 5);
    recs.push({ g, d10_p85, d10_s90, d5_p85, d5_s90 });
    console.log(`${g.label}: 85金字塔vs80金字塔 5年${d5_p85 != null ? d5_p85.toFixed(1) + 'pp' : '—'} 10年${d10_p85 != null ? d10_p85.toFixed(1) + 'pp' : '—'} | 90单档vs80单档 5年${d5_s90 != null ? d5_s90.toFixed(1) + 'pp' : '—'} 10年${d10_s90 != null ? d10_s90.toFixed(1) + 'pp' : '—'}`);
  }
  md.push(`\n## 四、结论与建议方向\n`);
  // 错过风险汇总（供建议引用）
  const riskSum = {};
  for (const g of groups) {
    const infos = [];
    for (const s of g.stocks) { const m = missRisk(s); if (m) infos.push(m); }
    riskSum[g.key] = {
      fill: infos.filter(x => x.n90 > 0).length / infos.length * 100,
      longDaysM: med(infos.filter(x => x.longest).map(x => x.longest.days)),
      longRiseM: med(infos.filter(x => x.longest && x.longest.rise != null).map(x => x.longest.rise)),
      openCnt: infos.filter(x => x.openSeg && x.openSeg.days > 60).length,
      openRiseM: med(infos.filter(x => x.openSeg && x.openSeg.rise != null).map(x => x.openSeg.rise)),
    };
  }
  for (const r of recs) {
    const g = r.g, rs = riskSum[g.key];
    let verdict = '', why = [];
    if (g.key === 'wait90') {
      verdict = '上移：建仓线 80→85 起建 + 加仓重心移向 90 档（不宜孤注等90全仓）';
      why.push(`90单档较80单档 5年 ${r.d5_s90 != null ? r.d5_s90.toFixed(1) + 'pp' : '—'} / 10年 ${r.d10_s90 != null ? r.d10_s90.toFixed(1) + 'pp' : '—'}，90红利显著（16年填充率 ${rs.fill != null ? rs.fill.toFixed(0) + '%' : '—'}，无全程踏空）`);
      why.push(`但85金字塔10年较80金字塔 ${r.d10_p85 != null ? r.d10_p85.toFixed(1) + 'pp' : '—'}：平移起建线吃不到90红利，需加厚90档才兑现`);
      why.push(`等90全仓踏空成本：最长间隔中位 ${rs.longDaysM != null ? rs.longDaysM.toFixed(0) + '天' : '—'}、间隔内峰值涨幅中位 ${rs.longRiseM != null ? rs.longRiseM.toFixed(0) + '%' : '—'}，当前 ${rs.openCnt}/${g.stocks.length} 只空等中（涨幅中位 ${rs.openRiseM != null ? rs.openRiseM.toFixed(1) + '%' : '—'}）`);
    } else if (g.key === 'neutral') {
      verdict = '上移：建仓线 80→85（85金字塔），不采取柔性70低起建';
      why.push(`85金字塔较80金字塔 5年 ${r.d5_p85 != null ? r.d5_p85.toFixed(1) + 'pp' : '—'} / 10年 ${r.d10_p85 != null ? r.d10_p85.toFixed(1) + 'pp' : '—'}，全面占优`);
      why.push(`90单档10年较80单档 ${r.d10_s90 != null ? r.d10_s90.toFixed(1) + 'pp' : '—'}，但踏空成本：间隔内峰值涨幅中位 ${rs.longRiseM != null ? rs.longRiseM.toFixed(0) + '%' : '—'}，当前 ${rs.openCnt}/${g.stocks.length} 只空等中`);
      why.push(`柔性70/80/90 10年 97.5% vs 保守80/85/90 103.6%（-6.1pp）→ 低起建不划算，不下移`);
    } else {
      verdict = '保持 80（不上移、不等待；陷阱类可降权回避）';
      why.push(`85金字塔5年较80金字塔 ${r.d5_p85 != null ? r.d5_p85.toFixed(1) + 'pp' : '—'}（10年虽 ${r.d10_p85 != null ? '+' + r.d10_p85.toFixed(1) + 'pp' : '—'} 但靠深跌修复，5年损失不可接受）`);
      why.push(`90单档5年较80单档 ${r.d5_s90 != null ? r.d5_s90.toFixed(1) + 'pp' : '—'}（等90严重踏空：当前 ${rs.openCnt}/${g.stocks.length} 只空等、涨幅中位 ${rs.openRiseM != null ? rs.openRiseM.toFixed(1) + '%' : '—'}）`);
      why.push(`80单档5年 67.8% 为三组最高 → 80即买对这类最稳`);
    }
    md.push(`\n### ${g.label}（${g.stocks.length} 只）\n`);
    md.push(`- **建议**：${verdict}`);
    md.push(`- 85金字塔 vs 80金字塔：5年 ${r.d5_p85 != null ? r.d5_p85.toFixed(1) + 'pp' : '—'}，10年 ${r.d10_p85 != null ? r.d10_p85.toFixed(1) + 'pp' : '—'}`);
    md.push(`- 90单档 vs 80单档：5年 ${r.d5_s90 != null ? r.d5_s90.toFixed(1) + 'pp' : '—'}，10年 ${r.d10_s90 != null ? r.d10_s90.toFixed(1) + 'pp' : '—'}`);
    md.push(`- 错过风险：填充率 ${rs.fill != null ? rs.fill.toFixed(0) + '%' : '—'}，最长间隔中位 ${rs.longDaysM != null ? rs.longDaysM.toFixed(0) + '天' : '—'}，间隔内峰值涨幅中位 ${rs.longRiseM != null ? rs.longRiseM.toFixed(0) + '%' : '—'}，当前空等 ${rs.openCnt} 只（涨幅中位 ${rs.openRiseM != null ? rs.openRiseM.toFixed(1) + '%' : '—'}）`);
    for (const w of why) md.push(`- ${w}`);
  }
  md.push(`\n## 五、口径与局限\n`);
  md.push(`- 事件条件性偏差：单档收益只统计"已触发"事件；本模拟以 90单档含踏空修正（未触发=0）部分校正，但踏空期间资金实际可买货基/理财，0 为保守下限。`);
  md.push(`- 90单档为乐观口径：收益从90事件起算，"等90期间"资金占用未计收益（踏空成本见第二节：间隔内峰值涨幅中位 94~151%）。`);
  md.push(`- 5年/10年前瞻收益：数据末端近 5/10 年触发的事件无完整前瞻窗口，未纳入（n 反映有效样本数）。`);
  md.push(`- 每股票混合收益为部署资金口径：金字塔部分档位未触发时，未部署部分视为现金（其"含现金"绝对收益低于表中数字，详见部署中位列）。`);
  md.push(`- 分红陷阱/低估值钝化类在第三组（陷阱+稀缺型）内不做细分，v1.9.4 如需细分可再拆表。`);

  fs.writeFileSync(OUT_MD, md.join('\n') + '\n', 'utf8');
  console.log(`\n📄 结果已写入 ${OUT_MD}`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
