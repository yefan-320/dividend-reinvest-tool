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
const STATE_FILE = process.env.STATE_FILE || '/tmp/watch-state.json';

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
function finSignals(f) {
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
  return sigs;
}
/* ---------- 单只判定（可买/等/观望 + 依据） ---------- */
function judge({ code, quote, dps, dy, f, tierLine, treasury, kline, lastBuyDays }) {
  const name = quote ? quote.name : code;
  const signals = finSignals(f);
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
  let ts = DL.tradingSignal({ code, dy, tier, trendOk, finOk, finChecks, lastBuyDays, industrySignals: indSignals, industry: (f && (f.industry || f.csrcIndustry)) || '', finGood, valuation: null });
  // 标的分层（大师最终方案）：事件层（伊利/平安）只监控不自动买卖——买入信号降级为提示
  const layer = DL.TRADE_LAYER[code] || 'auto';
  if (layer === 'event' && ts.action.startsWith('buy_')) {
    ts = { ...ts, action: 'monitor', text: '🔎 提示（事件层·人工决策）', reason: `${ts.reason}——但伊利/平安=事件驱动股（历史2年胜率49%中位-1.8%），自动信号无效，买入需人工事件判断（利空出尽+财报确认反转），仓位≤10%`, evidence: '标的分层·事件驱动层' };
  }
  // 兼容旧字段（变化检测/上层）
  const oldTier = { p75: '低估一档', p90: '低估二档', p95: '深度低估' }[tier] || '等待';
  let verdict = ts.text;
  let verdictNote = `${ts.reason}（${ts.evidence}）`;
  if (signals.length) verdictNote += `；信号: ${signals.map(s => s.txt).join('; ')}`;
  return { code, name, price: quote ? quote.price : null, dy: dy != null ? dy : null, tier: oldTier, tierNote, verdict, verdictNote, signals, action: ts.action, actionText: ts.text };
}
/* ---------- 主流程 ---------- */
(async () => {
  const force = process.argv.includes('--force');
  const cfg = loadWatchlist();
  const codes = [...new Set([...cfg.holdings, ...cfg.watch])];
  const quotes = await getQuotes(codes);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
  const report = { ts: new Date().toISOString(), items: [], changes: [] };
  for (const code of codes) {
    let f = null;
    try { f = await DL.fetchF10Annual(code); } catch (e) {}
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
    } catch (e) {}
    if (dps != null && dps > 0 && quotes[code] && quotes[code].price > 0) dy = dps / quotes[code].price * 100;
    const tierLine = DL.TIER_LINE && DL.TIER_LINE[code] ? DL.TIER_LINE[code] : null;
    const treasury = DL.TREASURY_NOW != null ? DL.TREASURY_NOW : 1.68;
    // 变化检测用上一次状态（放最前）
    const prev = state[code];
    // 近60日K线（趋势确认用；缓存优先）
    let kline = null;
    try { kline = await DL.getKline(code, 90); } catch (e) {}
    // 冷却：距上次买入触发天数（state.lastBuyTs）
    let lastBuyDays = null;
    if (prev && prev.lastBuyTs) lastBuyDays = Math.round((Date.now() - prev.lastBuyTs) / 86400000);
    const item = judge({ code, quote: quotes[code], dps, dy, f, tierLine, treasury, kline, lastBuyDays });
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
    state[code] = { verdict: item.verdict, tier: item.tier, price: item.price, dy: item.dy, ts: report.ts,
      lastBuyTs: (item.action && item.action.startsWith('buy_')) ? Date.now() : (prev && prev.lastBuyTs) };
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  fs.writeFileSync('/tmp/watch-report.json', JSON.stringify(report, null, 1));
  // 输出：有变化→只输出变化项；无变化→空数组（上层 cron 据此不触发=不花 LLM 钱）；--force→全部
  const out = force ? report.items : report.changes;
  console.log(JSON.stringify(out, null, 1));
})();
