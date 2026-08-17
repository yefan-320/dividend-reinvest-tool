#!/usr/bin/env node
/* 规则树回测 v1（v1.9.6 P0-9：结论行数据基座）
 * 对 40 只 × ~16 年逐日跑规则树 → 五档结论事件 → 每档 1/3/5 年收益+胜率
 * 口径：375 窗口分位，买入持有（价格+分红），与策略对比表同口径
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');

const WINDOW = 375;
const CACHE_F = '/tmp/rule-tree-cache.json';
const OUT_MD = '/tmp/rule-tree-result.md';
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

async function fetchKlineSina(tx) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tx}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  const j = await r.json();
  return (Array.isArray(j) ? j : []).map(x => ({ d: x.day, close: parseFloat(x.close) })).filter(x => x.close > 0);
}
async function fetchDivsFull(code, tryN = 1) {
  const cols = 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,ASSIGN_PROGRESS,REPORT_DATE,BASIC_EPS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://data.eastmoney.com/', 'Accept': 'application/json, text/plain, */*' } });
  const j = await r.json();
  if (!j.result || !j.result.data) { if (tryN < 5) { await new Promise(r2 => setTimeout(r2, tryN * 4000)); return fetchDivsFull(code, tryN + 1); } return []; }
  return (j.result.data || []).filter(x => x.EX_DIVIDEND_DATE && (x.ASSIGN_PROGRESS || '').indexOf('实施') >= 0).map(x => ({
    ex: x.EX_DIVIDEND_DATE.slice(0, 10),
    dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10,
    report: (x.REPORT_DATE || x.EX_DIVIDEND_DATE).slice(0, 10),
    eps: parseFloat(x.BASIC_EPS) || 0,
  }));
}

/* ---------- 收益 ---------- */
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

/* ---------- 规则树 ---------- */
function divTrendBad(divs, asOfYear) {
  const byRep = {};
  divs.forEach(d => { if (d.pending || !d.report) return; const y = parseInt(d.report.slice(0, 4), 10); if (!y || y >= asOfYear) return; byRep[y] = (byRep[y] || 0) + (d.dps || 0); });
  const ys = Object.keys(byRep).map(Number).sort((a, b) => b - a);
  if (ys.length < 3) return false;
  return byRep[ys[0]] < byRep[ys[1]] * 0.99 && byRep[ys[1]] < byRep[ys[2]] * 0.99;
}
function coverageRatio(divs, asOfYear) {
  const byRep = {};
  divs.forEach(d => { if (d.pending || !d.report) return; const y = parseInt(d.report.slice(0, 4), 10); if (!y || y >= asOfYear) return; if (!byRep[y]) byRep[y] = { dps: 0, eps: 0 }; byRep[y].dps += d.dps || 0; byRep[y].eps = Math.max(byRep[y].eps, d.eps || 0); });
  const ys = Object.keys(byRep).map(Number).sort((a, b) => b - a).slice(0, 2);
  if (ys.length < 2 || !byRep[ys[0]].eps || !byRep[ys[1]].eps) return null;
  return (byRep[ys[0]].dps + byRep[ys[1]].dps) / (byRep[ys[0]].eps + byRep[ys[1]].eps);
}
function ruleFor(pct, cls, trendBad, cov) {
  if (trendBad) return 'avoid';                    // 第1层：分红趋势一票否决
  if (cls === 'trap') return 'avoid_small';        // 第3层：陷阱型分位信号不适用
  let tier;
  if (pct >= 90) tier = 'strong';
  else if (cls === 'wait90') tier = pct >= 80 ? 'buy' : 'wait';
  else if (cls === 'boundary') tier = pct >= 85 ? 'buy' : (pct >= 80 ? 'watch' : 'wait');
  else if (cls === 'scarce') tier = pct >= 80 ? 'buy' : 'wait';
  else tier = pct >= 85 ? 'buy' : (pct >= 80 ? 'watch' : 'wait');   // direct/未分类默认
  if (tier === 'strong' && cov != null && cov < 0.35) tier = 'buy'; // 第2层：覆盖率不足降级
  if (tier === 'buy' && cov != null && cov < 0.25) tier = 'watch';
  if (tier === 'watch' && cov != null && cov < 0.25) tier = 'wait';
  return tier;
}
const TIER_NAMES = { strong: '强烈建仓', buy: '可建仓', watch: '观望', wait: '等待', avoid: '回避', avoid_small: '回避/小仓' };

/* ---------- 主流程 ---------- */
async function main() {
  const stats = { strong: [], buy: [], watch: [], wait: [], avoid: [], avoid_small: [] };
  const perTierN = {};
  for (const s of STOCKS) {
    let klines = _cache[s.code + ':k'];
    let divs = _cache[s.code + ':d'];
    if (!klines) { try { klines = await fetchKlineSina(s.tx); _cache[s.code + ':k'] = klines; } catch (e) { console.log('K线失败', s.code, e.message); continue; } }
    if (!divs) { try { divs = await fetchDivsFull(s.code); _cache[s.code + ':d'] = divs; } catch (e) { console.log('分红失败', s.code, e.message); continue; } }
    if (!klines.length || !divs.length) { console.log('空数据', s.code); continue; }
    saveCache();
    const cls = DL.classifyTier(s.code).cls;
    const km = {}; klines.forEach(k => km[k.d] = k.close);   // calcRollingPercentile 要求 {date:price} 对象
    const series = DL.calcRollingPercentile(km, divs, WINDOW);
    // 逐日规则 → 连续同档合并事件
    const evs = [];
    let curTier = null, curFrom = null;
    for (const pt of series) {
      if (pt.pct == null) { if (curTier) { evs.push({ tier: curTier, from: curFrom, to: pt.d }); curTier = null; } continue; }
      const asOfY = parseInt(pt.d.slice(0, 4), 10);
      const t = ruleFor(pt.pct, cls, divTrendBad(divs, asOfY), coverageRatio(divs, asOfY));
      if (t !== curTier) {
        if (curTier) evs.push({ tier: curTier, from: curFrom, to: pt.d });
        curTier = t; curFrom = pt.d;
      }
    }
    if (curTier) evs.push({ tier: curTier, from: curFrom, to: series[series.length - 1].d });
    // 统计事件收益（1/3/5年）
    for (const ev of evs) {
      if (ev.tier === 'wait') continue;   // 等待档不统计买入收益（其价值=验证等待后买入，单独统计）
      for (const y of [1, 3, 5]) {
        const r = buyAfterNDiv(klines, divs, ev.from, y);
        if (r != null) stats[ev.tier].push({ code: s.code, y, r });
      }
      perTierN[ev.tier] = (perTierN[ev.tier] || 0) + 1;
    }
    // 等待档价值验证：等待后买入（档位线触发后）vs 立即买入（等待起点当天）
    for (const ev of evs.filter(e => e.tier === 'wait')) {
      const buyAt = addDays(ev.from, 365);   // 等 1 年
      const rWait = buyAfterNDiv(klines, divs, buyAt, 3);
      const rNow = buyAfterNDiv(klines, divs, ev.from, 3);
      if (rWait != null && rNow != null) stats.wait.push({ code: s.code, y: 3, r: rWait - rNow });   // 差值为正=等有价值
    }
    console.log('✅', s.code, s.name, 'cls=' + cls, '事件数:', Object.keys(perTierN).map(k => k + ':' + perTierN[k]).join(' '));
  }
  saveCache();
  /* 汇总输出 */
  const mean = a => a.length ? a.reduce((s, x) => s + x.r, 0) / a.length : null;
  const winRate = a => a.length ? a.filter(x => x.r > 0).length / a.length * 100 : null;
  const lines = ['# 规则树回测结果（40只×16年，375窗口，买入持有）', '', '| 结论档 | 1年收益均值 | 1年胜率 | 3年收益均值 | 3年胜率 | 5年收益均值 | 5年胜率 | 事件数 |', '|---|---|---|---|---|---|---|---|'];
  for (const k of ['strong', 'buy', 'watch', 'avoid', 'avoid_small', 'wait']) {
    const a = stats[k];
    if (!a.length) { lines.push(`| ${TIER_NAMES[k]} | — | — | — | — | — | — | 0 |`); continue; }
    const cells = [1, 3, 5].map(y => {
      const sub = a.filter(x => x.y === y);
      return sub.length ? `${mean(sub) != null ? mean(sub).toFixed(1) + '%' : '—'} | ${winRate(sub) != null ? winRate(sub).toFixed(0) + '%' : '—'}` : '— | —';
    });
    lines.push(`| ${TIER_NAMES[k]} | ${cells.join(' | ')} | ${a.length} |`);
  }
  lines.push('', '等待档数值 = 等1年再买 vs 立即买的 3 年收益差（正=等待有价值）', '口径：分位375窗口TTM·价格+分红·不含交易成本·历史不代表未来');
  fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  console.log('\n' + lines.join('\n'));
}
main().catch(e => { console.error('中断:', e); process.exit(2); });
