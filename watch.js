#!/usr/bin/env node
/* watch.js — 通用财报监测引擎 v0.1（2026-08-20 大师评审 MVP）
 * 功能：持仓+自选每周全量跑 → 每只"现在：可买/等/观望+一句话依据"
 *       只推变化（state.json 对比）；财报日历+公告检测（定期报告→强制全面更新）
 * 用法：node watch.js            （跑全量，输出报告 JSON + 变化项）
 *       node watch.js --force     （忽略状态，全量输出）
 * 成本：纯脚本查免费接口，0 LLM；变化才由上层（cron agentTurn）生成报告
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');
const path = require('path');

const ROOT = __dirname + '/..';
const WATCH_FILE = process.env.WATCH_FILE || ROOT + '/watchlist.json';
const STATE_FILE = process.env.STATE_FILE || ROOT + '/.state/watch-state.json';

/* ---------- 配置：持仓+自选（登记一行即监测，通用） ---------- */
function loadWatchlist() {
  const def = {
    holdings: ['600036', '601398', '600887', '600941', '000333', '601318'],
    watch: ['600066'],
  };
  try { return JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8')); } catch (e) { return def; }
}
/* ---------- 工具函数 ---------- */
const sec = c => ({ tx: (/^6/.test(c) ? 'sh' : 'sz') + c });
async function getQuotes(codes) {
  const url = 'https://qt.gtimg.cn/q=' + codes.map(c => sec(c).tx).join(',');
  const r = await fetch(url);
  const buf = await r.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buf);
  const out = {};
  codes.forEach(c => {
    const m = text.match(new RegExp('v_' + sec(c).tx + '="([^"]*)"'));
    if (!m) return;
    const p = m[1].split('~');
    if (p.length > 46 && p[3]) out[c] = { name: p[1] || '', price: parseFloat(p[3]), pe: parseFloat(p[39]) || null, pb: parseFloat(p[46]) || null };
  });
  return out;
}
async function getAnnouncements(code, days = 45) {
  // 东财公告接口：检测"定期报告/业绩预告/业绩快报"
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=30&page_index=1&ann_type=A&client_source=web&stock_list=${code}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/' } });
    const j = await r.json();
    const list = (j.data && j.data.list) || [];
    const cutoff = Date.now() - days * 864e5;
    return list
      .filter(a => new Date(a.notice_date).getTime() >= cutoff)
      .map(a => ({ date: a.notice_date.slice(0, 10), title: a.title }))
      .filter(a => /定期报告|年度报告|半年度报告|季度报告|业绩预告|业绩快报|盈利警告|预亏|预增/.test(a.title));
  } catch (e) { return []; }
}
/* ---------- 财报信号（已回测验证的进决策；未验证的仅展示） ---------- */
function finSignals(f, code) {
  const sigs = [];
  if (!f || !f.annuals || f.annuals.length < 3) return sigs;
  const a = f.annuals; // 降序
  // S1 毛利率连2期降>2pp（已验证✅ 2年超额-19.2pp）→ 卖出信号
  if (a[0].grossMargin != null && a[1].grossMargin != null && a[2].grossMargin != null
      && a[1].grossMargin < a[2].grossMargin - 2 && a[0].grossMargin < a[1].grossMargin - 2) {
    sigs.push({ sig: 'S1', level: '🔴', txt: `毛利率连降2期(${a[2].grossMargin.toFixed(1)}→${a[1].grossMargin.toFixed(1)}→${a[0].grossMargin.toFixed(1)}%)` });
  }
  // S5 每股分红连降2年（已验证🟡 弱有效）
  if (a[0].dpsUndistributed == null) { /* 跳过 */ }
  // S4 扣非背离（已验证❌反向→底部候选，不卖出）
  if (a[0].netProfit != null && a[0].deductNetProfit != null && a[0].netProfit > 0 && a[0].deductNetProfit < 0) {
    sigs.push({ sig: 'S4', level: '🟢', txt: '扣非为负/归母为正（历史反向信号→底部反转候选，非卖出）' });
  }
  // 覆盖率（分红/OCF<60% 黄灯；分红/OCF<100% 靠家底）
  if (f.ocf != null && f.netProfit != null && f.netProfit > 0 && f.ocf / f.netProfit < 0.6) {
    sigs.push({ sig: 'S7', level: '🟡', txt: `OCF/净利 ${(f.ocf / f.netProfit * 100).toFixed(0)}% 偏低` });
  }
  // D1b（阶段4）：卖出信号补全——①盈利连2期收缩（分红能力预警）②应收账期拉长 ③审计意见变化
  // ① 净利连 2 期降 >30% → 分红能力收缩预警（分红=利润分配，利润腰斩分红必然受冲击）
  if (f.annuals && f.annuals[0] && f.annuals[1] && f.annuals[2]
      && f.annuals[0].netProfit != null && f.annuals[1].netProfit != null && f.annuals[2].netProfit != null
      && f.annuals[1].netProfit < f.annuals[2].netProfit * 0.7 && f.annuals[0].netProfit < f.annuals[1].netProfit * 0.7) {
    sigs.push({ sig: 'D1b', level: '🟡', txt: `净利连2期收缩>30%（${f.annuals[2].netProfit.toFixed(0)}→${f.annuals[1].netProfit.toFixed(0)}→${f.annuals[0].netProfit.toFixed(0)}亿）——分红能力预警` });
  }
  // ② 应收账期拉长：应收/营收 同比升 >10pp（赊销堆积=回款恶化）
  if (f.receivable != null && f.revenue != null && f.revenue > 0 && f.receivablePrev != null && f.revenuePrev != null && f.revenuePrev > 0) {
    const r1 = f.receivable / f.revenue, r0 = f.receivablePrev / f.revenuePrev;
    if (r1 > r0 + 0.10) sigs.push({ sig: 'D1b', level: '🟡', txt: `应收/营收 ${(r0 * 100).toFixed(0)}%→${(r1 * 100).toFixed(0)}%（赊销堆积，回款恶化）` });
  }
  // ③ 审计意见非标（非“标准无保留”）→ 硬红灯
  if (f.auditOpinion && !/标准/.test(f.auditOpinion)) {
    sigs.push({ sig: 'AUD', level: '🔴', txt: `审计意见非标：${f.auditOpinion}（硬红灯）` });
  }
  // 汇率敏感度（补漏：海外收入>30%标的→监测加信号；宇通已配 fxSensitive）
  if (DL.BUY_CFG && DL.BUY_CFG[code] && DL.BUY_CFG[code].fxSensitive) {
    sigs.push({ sig: 'FX', level: '🟡', txt: '汇率敏感度：海外收入>30%，人民币升值5%影响净利约2-2.5%（监测信号）' });
  }
  return sigs;
}
/* ---------- 单只判定（可买/等/观望 + 依据） ---------- */
function judge({ code, quote, dps, dy, f, tierLine, treasury, kline, lastBuyDays, susp, divYears, indOverLimit }) {
  const name = quote ? quote.name : code;
  const signals = finSignals(f, code);
  // 盲区15：停牌检测（现价连续 N 日不变→标停牌跳过；由主流程 kline 尾段判定传入）
  if (susp) return { code, name, price: quote ? quote.price : null, dy: dy != null ? dy : null, tier: '停牌', tierNote: '停牌中（连续多日无成交价变动），跳过判定', verdict: '⏸️ 停牌', verdictNote: '停牌检测：现价连续多日不变，跳过买卖判定', signals, action: 'hold', actionText: '⏸️ 停牌跳过' };
  // v5 补漏：成长股独立通道——分红历史<3年 → 不入红利框架，走 PE/PB+增速逻辑（防硬塞）
  if (divYears != null && divYears < 3) {
    return { code, name, price: quote ? quote.price : null, dy: dy != null ? dy : null, tier: null, tierNote: `分红历史仅${divYears}年（<3年）`, verdict: '📈 成长股独立通道', verdictNote: '分红历史<3年，不入红利框架；走 PE/PB+增速逻辑（成长股独立通道，防硬塞）', signals, action: 'hold', actionText: '📈 成长股通道（非红利标的）' };
  }
  // 盲区15：流动性检查（日成交额<1000万 → 强度×0.7 提示）——用 K 线尾段量能估算（kline 带 volume 时）
  let liqNote = '';
  if (kline && kline.length >= 20 && quote && quote.price > 0) {
    const vols = kline.slice(-20).map(x => x.volume).filter(v => v != null && v > 0);
    if (vols.length >= 10) {
      const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length;
      const avgAmt = avgVol * quote.price;   // 手×100股×价
      if (avgAmt < 1000e4) liqNote = `；⚠️ 流动性低（日均成交额≈${(avgAmt / 1e4).toFixed(0)}万<1000万）→ 强度×0.7`;
    }
  }
  // 档位：溢价分位线（dy − 国债 vs P75/P90/P95）
  let tier = null, tierNote = '';
  if (tierLine && !tierLine.pending && dy != null) {
    const prem = dy - treasury;
    if (prem >= tierLine.p95) tier = 'p95';       // 重仓区
    else if (prem >= tierLine.p90) tier = 'p90';   // 加仓区
    else if (prem >= tierLine.p75) tier = 'p75';   // 小仓区
    else tier = null;
    tierNote = `dy ${dy.toFixed(2)}%-国债${treasury.toFixed(2)}%=溢价${prem.toFixed(2)}pp vs P75/P90/P95=${tierLine.p75}/${tierLine.p90}/${tierLine.p95}pp`;
  } else if (dy != null) {
    tier = dy >= 5 ? 'p75' : null;
    tierNote = `dy ${dy.toFixed(2)}%（无分位线，通用5%参考）`;
  }
  // 趋势确认：近60日是否创新低（接刀过滤）
  let trendOk = true;
  if (kline && kline.length >= 60 && quote && quote.price > 0) {
    const low60 = Math.min(...kline.slice(-60).map(x => x.low || x.close || Infinity));
    if (quote.price <= low60 * 1.02) trendOk = false;
  }
  // 财报确认闸（主依据·完整版）：净利/扣非/OCF/S1 行业校准
  let finOk = true, finChecks = [];
  if (f && f.annuals && f.annuals.length >= 1) {
    const a = f.annuals;
    const fc = DL.finConfirm({
      industry: (f.industry || f.csrcIndustry || ''), code,
      kf: a[0].deductNetProfit, kfPrev: a[1] && a[1].deductNetProfit,
      ocf: f.ocf, np: a[0].netProfit,
      xsmll: a[0].grossMargin, xsmllPrev: a[1] && a[1].grossMargin, xsmllPrev2: a[2] && a[2].grossMargin,
    });
    finOk = fc.pass; finChecks = fc.checks;
  }
  // 行业校准信号（assessIndustrySignals：扣非/OCF/S1 分级 hard/soft/watch）
  let indSignals = null;
  if (f && f.annuals && f.annuals.length >= 3) {
    const a = f.annuals;
    indSignals = DL.assessIndustrySignals({
      industry: (f.industry || f.csrcIndustry || ''), code,
      kf: a[0].deductNetProfit, kfPrev: a[1].deductNetProfit,
      ocf: f.ocf, np: a[0].netProfit,
      xsmll: a[0].grossMargin, xsmllPrev: a[1].grossMargin, xsmllPrev2: a[2].grossMargin,
      netProfitYoY: a[0].netProfitYoY,
    });
  }
  // 买卖指令引擎（2026-08-20 主人令：工具明确提示买卖；08-20 晚等级制：L1-L5/S1-S3）
  const a0 = (f && f.annuals && f.annuals[0]) || null;
  const a1 = (f && f.annuals && f.annuals[1]) || null;
  const finGood = !!(a0 && a1 && a1.deductNetProfit != null && a1.deductNetProfit > 0 && a0.deductNetProfit > a1.deductNetProfit);
  let ts = DL.tradingSignal({ code, dy, tier, trendOk, finOk, finChecks, lastBuyDays, industrySignals: indSignals, industry: (f && (f.industry || f.csrcIndustry)) || '', finGood, valuation: null, indOverLimit: !!indOverLimit });
  // 标的分层（大师最终方案）：事件层（伊利/平安）只监控不自动买卖——买入信号降级为提示
  const layer = DL.TRADE_LAYER[code] || 'auto';
  if (layer === 'event' && ts.action.startsWith('buy_')) {
    ts = { ...ts, action: 'monitor', text: '🔎 提示（事件层·人工决策）', reason: `${ts.reason}——但伊利/平安=事件驱动股（历史2年胜率49%中位-1.8%），自动信号无效，买入需人工事件判断（利空出尽+财报确认反转），仓位≤10%`, evidence: '标的分层·事件驱动层' };
  }
  // M4（阶段3）：买入强制体检轻量版——财报确认闸通过但体检数据不全（缺扣非/OCF/毛利率任一）=未体检黄标
  let examNote = '';
  if (ts.action.startsWith('buy_')) {
    const hasKf = a0 && a1 && a0.deductNetProfit != null && a1.deductNetProfit != null;
    const hasOcf = f && f.ocf != null;
    const hasGm = a0 && a0.grossMargin != null;
    if (!(hasKf && hasOcf && hasGm)) examNote = `；⚠️ 未完成体检（缺 ${[!hasKf ? '扣非' : '', !hasOcf ? 'OCF' : '', !hasGm ? '毛利率' : ''].filter(Boolean).join('/')} 数据）——建议先看体检卡再决定`;
  }
  if (examNote) ts = { ...ts, reason: ts.reason + examNote };
  // 兼容旧字段（变化检测/上层）
  const oldTier = { p75: '低估一档', p90: '低估二档', p95: '深度低估' }[tier] || '等待';
  let verdict = ts.text;
  let verdictNote = `${ts.reason}（${ts.evidence}）`;
  if (signals.length) verdictNote += `；信号: ${signals.map(s => s.txt).join('; ')}`;
  if (liqNote) verdictNote += liqNote;
  return { code, name, price: quote ? quote.price : null, dy: dy != null ? dy : null, tier: oldTier, tierNote, verdict, verdictNote, signals, action: ts.action, actionText: ts.text, signalLevel: ts.level };
}
/* ---------- 主流程 ---------- */
(async () => {
  const force = process.argv.includes('--force');
  const cfg = loadWatchlist();
  const codes = [...new Set([...cfg.holdings, ...cfg.watch])];
  const quotes = await getQuotes(codes);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
  const report = { ts: (() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + "T" + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0"); })(), items: [], changes: [], portfolio: null };
  // v5 补漏：国债利率漂移>50bp → 触发价全部重算（含已命中，标注"利率重算"）
  let rateShift = false, rateNote = '';
  try {
    await DL.refreshTreasury();
    const prevRate = (state && state._treasury) != null ? state._treasury : null;
    if (prevRate != null && DL.TREASURY_NOW != null && Math.abs(DL.TREASURY_NOW - prevRate) > 0.5) {
      rateShift = true; rateNote = `⚠️ 国债利率漂移 ${prevRate.toFixed(2)}%→${DL.TREASURY_NOW.toFixed(2)}%（>50bp）→ 全部触发价按新利率重算`;
    }
    if (DL.TREASURY_NOW != null) state._treasury = DL.TREASURY_NOW;
  } catch (e) {}
  if (rateShift) report.rateShift = rateNote;
  // v7 暴跌时卖出提示：大盘（沪深300）分位<20% → 提示"卖出可能在底部，可分批"（附在报告层，不拦自动卖出）
  try {
    const ix = await DL.getIndexKline('000300', '2016-01-01', DL.todayStr());
    const closes = Object.entries(ix).filter(([, c]) => c > 0).map(([, c]) => c);
    if (closes.length >= 250) {
      const cur = closes[closes.length - 1];
      const sorted = closes.slice(-250).sort((a, b) => a - b);
      const pct = sorted.filter(c => c <= cur).length / sorted.length * 100;
      report.marketPct = pct;
      if (pct < 20) report.marketNote = `🌊 大盘处于近1年低位（沪深300分位 ${pct.toFixed(0)}%）——若触发卖出，注意可能卖在底部，可分批执行`;
    }
  } catch (e) {}
  // 组合行业分布（v7 大师 A）：单行业≤2只+≤40%；行业超限（≥3只）→ 新买入降强度×0.5
  const indCount = {};
  for (const code of cfg.holdings) {
    try {
      const f0 = await DL.fetchF10Annual(code);
      const ind0 = f0 && (f0.industry || f0.csrcIndustry || '');
      const key0 = DL.indKeyOf(ind0) || ind0 || '未知';
      indCount[key0] = (indCount[key0] || 0) + 1;
    } catch (e) {}
  }
  const overLimit = Object.entries(indCount).filter(([, n]) => n >= 3).map(([k, n]) => `${k}×${n}`);
  if (overLimit.length) report.portfolio = { indCount, overLimit };
  const indOverLimitCodes = {};
  for (const code of cfg.holdings) {
    try {
      const f0 = await DL.fetchF10Annual(code);
      const ind0 = f0 && (f0.industry || f0.csrcIndustry || '');
      const key0 = DL.indKeyOf(ind0) || ind0 || '未知';
      if ((indCount[key0] || 0) >= 3) indOverLimitCodes[code] = true;
    } catch (e) {}
  }
  for (const code of codes) {
    let f = null;
    try { f = await DL.fetchF10Annual(code); } catch (e) {}
    // v7 财报披露 13 步⑨⑩：新财报 vs 上期对比表 + diff（state 存上期财务，变化即输出）
    let finDiff = null;
    if (f && f.annuals && f.annuals[0]) {
      const a = f.annuals[0];
      const prevFin = state[code] && state[code].fin;
      const curFin = { p: (a.reportPeriod || '').slice(0, 10), np: a.netProfit, kf: a.deductNetProfit, gm: a.grossMargin };
      if (prevFin && prevFin.p !== curFin.p && curFin.np != null) {
        const diffParts = [];
        if (prevFin.np != null && curFin.np != null) diffParts.push(`净利 ${prevFin.np}→${curFin.np}亿（${((curFin.np / prevFin.np - 1) * 100).toFixed(0)}%）`);
        if (prevFin.kf != null && curFin.kf != null) diffParts.push(`扣非 ${prevFin.kf}→${curFin.kf}亿（${((curFin.kf / prevFin.kf - 1) * 100).toFixed(0)}%）`);
        if (prevFin.gm != null && curFin.gm != null) diffParts.push(`毛利率 ${prevFin.gm}→${curFin.gm}%`);
        if (diffParts.length) finDiff = { from: prevFin.p, to: curFin.p, parts: diffParts };
      }
      state[code] = Object.assign({}, state[code], { fin: curFin });
    }
    // 最近年度 DPS（工具同源：fetchDividendsOne 全历史分红 → 报告期归组）
    let dps = null, dy = null;
    try {
      const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=(SECURITY_CODE%3D%22${code}%22)`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/' } });
      const j = await r.json();
      const rows = (j.result && j.result.data) || [];
      const byY = {};
      rows.forEach(x => { const report = (x.REPORT_DATE || '').slice(0, 10); const y = report.slice(0, 4); if (x.PRETAX_BONUS_RMB) byY[y] = (byY[y] || 0) + (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10; });
      const ys = Object.keys(byY).sort();
      if (ys.length) dps = byY[ys[ys.length - 1]];
      // v5 成长股通道：分红年份数（连续分红年数）
      var divYears = ys.length;
    } catch (e) {}
    if (dps != null && dps > 0 && quotes[code] && quotes[code].price > 0) dy = dps / quotes[code].price * 100;
    const tierLine = DL.TIER_LINE && DL.TIER_LINE[code] ? DL.TIER_LINE[code] : null;
    const treasury = DL.TREASURY_NOW != null ? DL.TREASURY_NOW : 1.68;
    // 变化检测用上一次状态（放最前）
    const prev = state[code];
    // 近60日K线（趋势确认用；缓存优先）
    let kline = null;
    try { kline = await DL.getKline(code, 90); } catch (e) {}
    // 盲区15：停牌检测——K线尾段连续≥5日收盘价不变 → 停牌（跳过判定）
    let susp = false;
    if (kline && kline.length >= 8) {
      const tail = kline.slice(-8);
      const closes = tail.map(x => x.close).filter(c => c != null && c > 0);
      if (closes.length >= 5 && new Set(closes.map(c => c.toFixed(2))).size === 1) susp = true;
    }
    // 盲区15：流动性检查（日成交额<1000万 → 强度×0.7 提示；无成交额数据时跳过）
    // 冷却：距上次买入触发天数（state.lastBuyTs）
    let lastBuyDays = null;
    if (prev && prev.lastBuyTs) lastBuyDays = Math.round((Date.now() - prev.lastBuyTs) / 86400000);
    const item = judge({ code, quote: quotes[code], dps, dy, f, tierLine, treasury, kline, lastBuyDays, susp, divYears, indOverLimit: !!indOverLimitCodes[code] });
    if (!force) {
      if (!prev) item.changed = true;
      else if (prev.verdict !== item.verdict) item.changed = true;
      else if (prev.tier !== item.tier) item.changed = true;
    } else item.changed = true;
    // 公告检测：定期报告/业绩预告 → 标记新财报
    const anns = await getAnnouncements(code);
    if (anns.length) item.announcements = anns;
    report.items.push(item);
    if (item.changed) report.changes.push(item);
    if (finDiff) { item.finDiff = finDiff; report.changes.push(item); }
    // 盲区19 犹豫双通道：硬红灯（S3）连续5日未执行 → 升级强提醒；软恶化（S2）未执行→只记录尊重主人
    let stale = 0;
    if (prev && prev.signalLevel && prev.signalLevel === item.signalLevel && item.signalLevel) {
      stale = (prev.staleDays || 0) + 1;
    }
    if (item.signalLevel === 'S3' && stale >= 5) item.staleAlert = `🚨 硬红灯 S3 已连续${stale}日未执行——请尽快处理（清仓或明确豁免）`;
    else if (item.signalLevel === 'S2') item.staleNote = '🟠 软恶化未执行=尊重主人选择（仅记录）';
    state[code] = { verdict: item.verdict, tier: item.tier, price: item.price, dy: item.dy, ts: report.ts,
      signalLevel: item.signalLevel || null, staleDays: stale,
      lastBuyTs: (item.action && item.action.startsWith('buy_')) ? Date.now() : (prev && prev.lastBuyTs) };
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  fs.writeFileSync('/tmp/watch-report.json', JSON.stringify(report, null, 1));
  // v5 失效条件（组合层面信号，区别于单只卖出分级）：观察级/暂停级/恢复级
  // 利率连续上行检测（TREASURY 状态历史）→ 观察级×0.5 / 暂停级暂停新买入 / 恢复级反转
  const rateHist = state._rateHist || [];
  if (DL.TREASURY_NOW != null) {
    rateHist.push({ d: report.ts.slice(0, 10), r: DL.TREASURY_NOW });
    if (rateHist.length > 730) rateHist.shift();
    state._rateHist = rateHist;
  }
  const last4 = rateHist.slice(-4).filter(x => x.r != null);
  let regime = null;
  if (last4.length >= 4) {
    const upCount = last4.filter((x, i) => i > 0 && x.r > last4[i - 1].r).length;
    if (upCount >= 4) regime = { level: '观察级', note: `利率连续上行（最近${last4.length}次采样${upCount}次上行）→ 买入强度×0.5+卖出提前触发` };
    else if (upCount >= 3 && (state._regimeLevel === '观察级')) regime = { level: '暂停级', note: '观察级持续（利率持续上行）→ 暂停新买入（保留持有+卖出规则）' };
    else if (upCount <= 1) regime = { level: '恢复级', note: '利率信号反转 → 恢复正常' };
  }
  if (regime) { report.regime = regime; state._regimeLevel = regime.level; }
  // 输出：有变化→只输出变化项；无变化→空数组（上层 cron 据此不触发=不花 LLM 钱）；--force→全部
  const out = force ? report.items : report.changes;
  // D1/D2（阶段4）：触发式精读请求——硬红灯/审计非标时输出精读任务清单（供上层 LLM 管道按决策卡三关执行：页码锚定/双通道交叉/抽样复核）
  const deepRead = out.filter(x => x.signalLevel === 'S3' || (x.signals || []).some(s => s.sig === 'AUD'));
  if (deepRead.length) {
    report.deepRead = deepRead.map(x => ({
      code: x.code, name: x.name, reason: x.verdictNote,
      checklist: ['核对最新年报原文关键页（营收/净利/扣非/OCF）', '审计意见段落原文摘录', '分红/覆盖率/应收三勾稽', '结论写决策卡（deliverables/财报研究/）——页码锚定，禁二手']
    }));
  }
  const pushUrl = (() => { try { return fs.readFileSync(__dirname + '/../.state/push-url.txt', 'utf8').trim(); } catch (e) { return ''; } })();
  // D5（阶段4）：主动 push——硬红灯（S3 清仓/审计非标）→ webhook 推送主人（无配置静默跳过）
  if (pushUrl && (force || out.some(x => x.signalLevel === 'S3' || (x.signals || []).some(s => s.sig === 'AUD')))) {
    const alerts = out.filter(x => x.signalLevel === 'S3' || (x.signals || []).some(s => s.sig === 'AUD'));
    try {
      const text = `🚨 红利工具重大风险（${report.ts}）\n${alerts.map(x => `${x.name}（${x.code}）：${x.actionText}｜${x.verdictNote}`).join('\n')}`;
      fetch(pushUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text } }) })
        .then(() => console.log('✅ push 已发送（S3/审计非标）'))
        .catch(e => console.log('⚠️ push 失败:', e.message));
    } catch (e) {}
  }
  console.log(JSON.stringify(out, null, 1));
})();
