#!/usr/bin/env node
/* 持仓买入点完整研究 v2（2026-08-18 主人令：逐只完整、多买入点、分红口径优先）
 * v2 修正：①按档位分表 ②相邻触发合并为独立机会（间隔<250交易日=同一机会，取首日）
 *         ③聚合分母=有数据事件数 ④加"至今收益"列 ⑤5年无数据标注
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');

const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));
const HOLDINGS = [
  { code: '600036', name: '招商银行', ind: 'bank' },
  { code: '601398', name: '工商银行', ind: 'bank' },
  { code: '600887', name: '伊利股份', ind: 'consumer' },
  { code: '600941', name: '中国移动', ind: 'telecom' },
  { code: '000333', name: '美的集团', ind: 'consumer' },
  { code: '601318', name: '中国平安', ind: 'insurer' },
];

async function fetchDivsFull(code, tryN = 1) {
  const cols = 'SECURITY_CODE,REPORT_DATE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,BASIC_EPS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://data.eastmoney.com/' } });
  const j = await r.json();
  if (!j.result || !j.result.data) { if (tryN < 5) { await new Promise(r2 => setTimeout(r2, tryN * 4000)); return fetchDivsFull(code, tryN + 1); } return []; }
  return j.result.data;
}
async function fetchKlineSina(code) {
  const tx = (code.startsWith('0') || code.startsWith('3')) ? 'sz' + code : 'sh' + code;
  const r = await fetch(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tx}&scale=240&ma=no&datalen=4000`, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  const arr = JSON.parse(await r.text());
  const kline = {};
  arr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.day] = c; });
  return kline;
}
async function fetchPriceTx(code) {
  const tx = (code.startsWith('0') || code.startsWith('3')) ? 'sz' + code : 'sh' + code;
  const r = await fetch(`https://qt.gtimg.cn/q=${tx}`, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://gu.qq.com/' } });
  const t = await r.text();
  const m = t.match(/="([^"]+)"/);
  return m ? parseFloat(m[1].split('~')[3]) : null;
}

function zoneEvents(series, line) {
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
function zoneEvents2(series, tierPct) {
  const evs = [];
  let inZ = false, start = null;
  for (const x of series) {
    if (x.pct == null) continue;
    if (x.pct >= tierPct) { if (!inZ) { inZ = true; start = x.d; } }
    else { if (inZ) { evs.push(start); inZ = false; } }
  }
  if (inZ) evs.push(start);
  return evs;
}
/* 相邻事件合并：与前一个触发间隔<250交易日=同一机会（取首个） */
function mergeEvents(dates, evs) {
  const out = [];
  let lastIdx = -1e9;
  for (const d of evs) {
    const idx = dates.indexOf(d);
    if (idx < 0) continue;
    if (idx - lastIdx >= 250) { out.push(d); lastIdx = idx; }
  }
  return out;
}

function pointMetrics(kline, dates, divs, buyIdx, curD) {
  const buyP = kline[dates[buyIdx]];
  if (!(buyP > 0)) return null;
  const buyD = dates[buyIdx];
  const exs = divs.filter(d => d.ex && d.dps > 0 && d.ex > buyD).sort((a, b) => a.ex < b.ex ? -1 : 1);
  const out = { buyD, buyP, y1: null, y3: null, y5: null, now: null, payback10: null, divGrow: null };
  const H = [[250, 'y1'], [750, 'y3'], [1250, 'y5']];
  for (const [hd, key] of H) {
    const sellIdx = buyIdx + hd;
    if (sellIdx >= dates.length) break;
    const sellP = kline[dates[sellIdx]];
    const sellD = dates[sellIdx];
    let divSum = 0;
    exs.forEach(d => { if (d.ex <= sellD) divSum += d.dps; });
    out[key] = { divRet: divSum / buyP * 100, totRet: (sellP + divSum) / buyP * 100 - 100 };
  }
  // 至今（含分红）
  if (curD) {
    let divSum = 0;
    exs.forEach(d => { if (d.ex <= curD) divSum += d.dps; });
    const curP = kline[curD] || 0;
    if (curP > 0) out.now = { totRet: (curP + divSum) / buyP * 100 - 100, divRet: divSum / buyP * 100 };
  }
  // 回本 10%
  let acc = 0;
  for (const d of exs) {
    acc += d.dps;
    if (acc >= buyP * 0.10) { out.payback10 = ((new Date(d.ex) - new Date(buyD)) / 86400000 / 365).toFixed(1); break; }
  }
  // 分红持续性：买入后第1个完整财年 vs 第3个完整财年
  const byRep = {};
  divs.forEach(d => { if (d.pending || !d.report) return; const y = parseInt(d.report.slice(0, 4), 10); if (!y) return; byRep[y] = (byRep[y] || 0) + (d.dps || 0); });
  const ys = Object.keys(byRep).map(Number).sort((a, b) => a - b);
  const buyY = parseInt(buyD.slice(0, 4), 10);
  const after = ys.filter(y => y > buyY);
  if (after.length >= 3 && byRep[after[0]] > 0.01) out.divGrow = { y0: after[0], y2: after[2], pct: (byRep[after[2]] - byRep[after[0]]) / byRep[after[0]] * 100 };
  return out;
}

function baseline(kline, dates, divs, nSamples) {
  const step = Math.max(1, Math.floor(dates.length / nSamples));
  let d3 = 0, n3 = 0, t5 = 0, n5 = 0, pb = 0, npb = 0;
  for (let i = 0; i < dates.length; i += step) {
    const m = pointMetrics(kline, dates, divs, i, dates[dates.length - 1]);
    if (!m) continue;
    if (m.y3) { d3 += m.y3.divRet; n3++; }
    if (m.y5) { t5 += m.y5.totRet; n5++; }
    if (m.payback10 != null) { pb += parseFloat(m.payback10); npb++; }
  }
  return { div3: n3 ? d3 / n3 : null, tot5: n5 ? t5 / n5 : null, pb10: npb ? pb / npb : null };
}

(async () => {
  const lines = [];
  const TODAY = '2026-08-18';
  for (const h of HOLDINGS) {
    let divs, kline;
    try {
      if (cache[h.code + ':d']) { divs = cache[h.code + ':d']; kline = {}; (cache[h.code + ':k'] || []).forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; }); }
      else { divs = DL.dedupDividends(DL.parseDivs(await fetchDivsFull(h.code))); kline = await fetchKlineSina(h.code); }
    } catch (e) { console.log(h.name + ' 数据失败: ' + e.message); continue; }
    const dates = Object.keys(kline).sort();
    if (dates.length < 300) { console.log(h.name + ' K线不足'); continue; }
    const curD = dates[dates.length - 1];
    const series = DL.calcRollingPercentile(kline, divs, 375);
    const price = await fetchPriceTx(h.code);
    const yb = DL.BENCH[h.ind];
    const mid = yb.yieldMid, line = yb.yieldMid + yb.yieldUp, heavy = line + 1;
    const last = series.filter(x => x.pct != null).pop();
    const cls = DL.classifyTier(h.code).cls;
    const cov = DL.coverageAt(divs, 2026);
    const v = DL.ruleVerdict(last ? last.pct : null, cls, DL.calcDivTrend(divs).degraded, cov);
    const base = baseline(kline, dates, divs, 1000);
    const curTier = last ? (last.dy >= heavy ? '重仓区' : last.dy >= line ? '加仓区' : last.dy >= mid ? '小仓区' : '等待区') : '—';

    lines.push(`\n# ${h.name}（${h.code}·${h.ind}）`);
    lines.push(`当前：现价 ${price} 元 | 股息率 ${last ? last.dy.toFixed(2) + '%' : '—'} | 分位 ${last ? last.pct.toFixed(0) + '%' : '—'} | 落档：${curTier} | 规则树：${DL.RULE_TIER_LABEL[v.tier]}`);
    lines.push(`三档线：小仓 ${mid}% / 加仓 ${line}% / 重仓 ${heavy}% | 随机基准：3年分红收益 ${base.div3 == null ? '—' : base.div3.toFixed(1) + '%'}、5年总收益 ${base.tot5 == null ? '—' : base.tot5.toFixed(1) + '%'}、回本10% ${base.pb10 == null ? '—' : base.pb10.toFixed(1) + '年'}`);
    lines.push(`数据区间：${dates[0]} ~ ${curD}（${(dates.length / 250).toFixed(0)} 年）`);

    const tiers = [['小仓线 ' + mid + '%', mid, 'dy'], ['加仓线 ' + line + '%', line, 'dy'], ['重仓线 ' + heavy + '%', heavy, 'dy'], ['分位≥80（建仓参考）', 80, 'pct'], ['分位≥90（强信号参考）', 90, 'pct']];
    for (const [tn, tl, mode] of tiers) {
      let evs = mode === 'dy' ? zoneEvents(series, tl) : zoneEvents2(series, tl);
      evs = mergeEvents(dates, evs);
      if (!evs.length) { lines.push(`\n## ${tn}：**0 次独立触发**（上市以来从未到过此线）`); continue; }
      lines.push(`\n## ${tn}：${evs.length} 次独立机会（相邻<250日合并）`);
      lines.push(`| 买入日 | 买入价 | 1年分红% | 3年分红% | 5年分红% | 1年总% | 3年总% | 5年总% | **至今总%** | 回本10% | 分红3年走势 |`);
      lines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
      let n = 0, d3 = 0, n3 = 0, win3 = 0, t5 = 0, n5 = 0, win5 = 0, nowT = 0, nNow = 0, pb = 0, npb = 0;
      for (const d of evs) {
        const idx = dates.indexOf(d);
        const m = pointMetrics(kline, dates, divs, idx, curD);
        if (!m) continue;
        n++;
        if (m.y3) { d3 += m.y3.divRet; n3++; if (m.y3.totRet > 0) win3++; }
        if (m.y5) { t5 += m.y5.totRet; n5++; if (m.y5.totRet > 0) win5++; }
        if (m.now) { nowT += m.now.totRet; nNow++; }
        if (m.payback10 != null) { pb += parseFloat(m.payback10); npb++; }
        const f = (x, key) => x && x[key] != null ? x[key].toFixed(1) : '—';
        const grow = m.divGrow ? (m.divGrow.pct >= 0 ? '↑+' + m.divGrow.pct.toFixed(0) + '%' : '↓' + m.divGrow.pct.toFixed(0) + '%') : '—';
        lines.push(`| ${m.buyD} | ${m.buyP.toFixed(2)} | ${f(m.y1, 'divRet')} | ${f(m.y3, 'divRet')} | ${f(m.y5, 'divRet')} | ${f(m.y1, 'totRet')} | ${f(m.y3, 'totRet')} | ${f(m.y5, 'totRet')} | ${f(m.now, 'totRet')} | ${m.payback10 || '—'} | ${grow} |`);
      }
      const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
      lines.push(`\n聚合：${n} 次机会 | 3年分红收益均值 ${n3 ? (d3 / n3).toFixed(1) + '%' : '—'}（基准 ${base.div3 == null ? '—' : base.div3.toFixed(1) + '%'}）| 3年总胜率 ${pct(win3, n3)} | 5年总收益均值 ${n5 ? (t5 / n5).toFixed(1) + '%' : '数据不足'} | 5年胜率 ${pct(win5, n5)} | 至今总收益均值 ${nNow ? (nowT / nNow).toFixed(1) + '%' : '—'} | 回本10%均值 ${npb ? (pb / npb).toFixed(1) + '年' : '—'}`);
    }
    lines.push(`\n---`);
  }
  fs.writeFileSync('/Users/macbookpro/Documents/deepseek/repo/docs/持仓买入点完整研究-20260818.md', lines.join('\n'));
  console.log('已生成 docs/持仓买入点完整研究-20260818.md，行数:', lines.length);
  process.exit(0);
})();
