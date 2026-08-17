#!/usr/bin/env node
/* v1.9.2 分位窗口合理性实验（真实数据，东财前复权日K 2010-2026）
 * 问题：滚动 500 个交易日的价格百分位，这个窗口合理吗？
 * 方法：8 只覆盖低波/中波/高波/阴跌生态的股票，测 6 种窗口(125/250/375/500/750/1000天)
 * 对每窗口统计：触发频率、买后1/2/3年收益、胜率、金字塔策略收益/回撤、当前分位漂移
 */
const fs = require('fs');

const STOCKS = [
  { code: '600036', market: 1, name: '招商银行' },
  { code: '601398', market: 1, name: '工商银行' },
  { code: '600519', market: 1, name: '贵州茅台' },
  { code: '601318', market: 1, name: '中国平安' },
  { code: '600900', market: 1, name: '长江电力' },
  { code: '000001', market: 0, name: '平安银行' },
  { code: '600028', market: 1, name: '中国石化' },
  { code: '601988', market: 1, name: '中国银行' },
];
const WINDOWS = [125, 250, 375, 500, 750, 1000];
const TIERS = [80, 85, 90, 95];

async function fetchKline(code, market) {
  const sym = (market === 1 ? 'sh' : 'sz') + code;
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Referer': 'https://finance.sina.com.cn/', 'Accept': '*/*' } });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error(code + ' 解析失败: ' + txt.slice(0, 80)); }
  if (!Array.isArray(j) || !j.length) throw new Error(code + ' 无数据');
  return j.map(x => ({ d: x.day, close: parseFloat(x.close) })).filter(x => x.close > 0);
}

function calcSeries(klines, W) {
  const series = [];
  for (let i = 0; i < klines.length; i++) {
    if (i < W - 1) { series.push({ d: klines[i].d, pct: null }); continue; }
    const win = klines.slice(i - W + 1, i + 1).map(x => x.close).sort((a, b) => a - b);
    const cur = klines[i].close;
    let less = 0;
    for (const v of win) { if (v <= cur) less++; }
    series.push({ d: klines[i].d, pct: less / W * 100 });
  }
  return series;
}

function findEvents(series, tier) {
  const ev = []; let inZ = false, start = null;
  for (const x of series) {
    if (x.pct == null) continue;
    if (x.pct >= tier) { if (!inZ) { inZ = true; start = x.d; } }
    else { if (inZ) { ev.push(start); inZ = false; } }
  }
  if (inZ) ev.push(start);
  return ev;
}

function buyHold(klines, buyD, years) {
  const bi = klines.findIndex(x => x.d >= buyD);
  if (bi < 0) return null;
  const buyP = klines[bi].close;
  const ti = klines.findIndex(x => x.d >= addDays(buyD, years * 365));
  if (ti < 0) return null;
  return (klines[ti].close - buyP) / buyP * 100;
}

function addDays(dStr, days) {
  const d = new Date(dStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function maxDrawdown(klines, fromD) {
  const si = klines.findIndex(x => x.d >= fromD);
  if (si < 0) return null;
  let peak = -Infinity, md = 0;
  for (let i = si; i < klines.length; i++) {
    const p = klines[i].close;
    if (p > peak) peak = p;
    const dd = (peak - p) / peak * 100;
    if (dd > md) md = dd;
  }
  return md;
}

async function main() {
  const all = [];
  for (const s of STOCKS) {
    const k = await fetchKline(s.code, s.market);
    all.push({ ...s, klines: k });
    console.log(`✅ ${s.name}(${s.code}): ${k.length} 根日K ${k[0].d} ~ ${k[k.length-1].d}`);
  }
  // 汇总行
  const rows = [];
  for (const W of WINDOWS) {
    let n = 0, buy1 = [], buy2 = [], buy3 = [], mddSum = 0, mddN = 0, evCount = { 80: 0, 85: 0, 90: 0, 95: 0 };
    const per = [];
    for (const s of all) {
      const series = calcSeries(s.klines, W);
      for (const t of TIERS) evCount[t] += findEvents(series, t).length;
      // 金字塔（保守：80/85/90 各1/3）模拟
      let ret = 0, wsum = 0;
      for (const t of TIERS.slice(0, 3)) {
        const evs = findEvents(series, t);
        if (!evs.length) continue;
        // 用第一个事件（避免同段重复，保守口径每档只算一次首事件）
        const r = buyHold(s.klines, evs[0], 3);
        if (r != null) { ret += r / 3; wsum += 1 / 3; }
      }
      if (wsum > 0) per.push({ name: s.name, ret: ret / wsum });
      // 买后 1/2/3 年胜率（80分位首事件）
      const evs80 = findEvents(series, 80);
      for (const ev of evs80) {
        const r1 = buyHold(s.klines, ev, 1);
        if (r1 != null) { buy1.push(r1); }
        const r2 = buyHold(s.klines, ev, 2);
        if (r2 != null) buy2.push(r2);
        const r3 = buyHold(s.klines, ev, 3);
        if (r3 != null) buy3.push(r3);
        n++;
      }
      const md = maxDrawdown(s.klines, evs80.length ? evs80[0] : s.klines[0].d);
      if (md != null) { mddSum += md; mddN++; }
    }
    const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const win = a => a.length ? a.filter(v => v > 0).length / a.length * 100 : null;
    rows.push({
      W, n,
      ev80: evCount[80], ev95: evCount[95],
      buy1: avg(buy1), buy2: avg(buy2), buy3: avg(buy3),
      w1: win(buy1), w2: win(buy2), w3: win(buy3),
      med3: med(buy3), mdd: mddN ? mddSum / mddN : null,
      pyr: per.length ? per.reduce((s, p) => s + p.ret, 0) / per.length : null,
    });
  }
  console.log('\n=== 窗口对比汇总（8 只 × 2010-2026 真实数据） ===');
  console.log('窗口  触发80 触发95  买后1年均值 胜率1y  买后3年均值 中位3y  胜率3y  保守金3y收益  首事件后最大浮亏');
  for (const r of rows) {
    console.log(
      String(r.W).padEnd(5), String(r.ev80).padEnd(6), String(r.ev95).padEnd(6),
      (r.buy1 != null ? r.buy1.toFixed(1) + '%' : '—').padEnd(9),
      (r.w1 != null ? r.w1.toFixed(0) + '%' : '—').padEnd(7),
      (r.buy3 != null ? r.buy3.toFixed(1) + '%' : '—').padEnd(9),
      (r.med3 != null ? r.med3.toFixed(1) + '%' : '—').padEnd(8),
      (r.w3 != null ? r.w3.toFixed(0) + '%' : '—').padEnd(7),
      (r.pyr != null ? r.pyr.toFixed(1) + '%' : '—').padEnd(11),
      (r.mdd != null ? '-' + r.mdd.toFixed(1) + '%' : '—')
    );
  }
  // 当前分位漂移：最近交易日各窗口分位
  console.log('\n=== 当前分位（2026 最新交易日）窗口敏感性 ===');
  for (const s of all) {
    let line = s.name.padEnd(6);
    for (const W of WINDOWS) {
      const series = calcSeries(s.klines, W);
      const last = series[series.length - 1];
      line += ` W${W}:${last.pct != null ? last.pct.toFixed(0) : '—'}`;
    }
    console.log(line);
  }
  fs.writeFileSync('/tmp/win-exp.json', JSON.stringify(rows, null, 2));
  console.log('\n结果已存 /tmp/win-exp.json');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });

/* 补充：全事件口径金字塔（每档全部事件，持有至今，等权平均） */
async function extra() {
  const all = [];
  for (const s of STOCKS) all.push({ ...s, klines: await fetchKline(s.code, s.market) });
  console.log('\n=== 全事件口径：保守金字塔(80/85/90各1/3)持有至今 ===');
  console.log('窗口  平均收益  触发总事件  平均浮亏(80事件后)');
  for (const W of WINDOWS) {
    let retSum = 0, wsum = 0, evTotal = 0, mddSum = 0, mddN = 0;
    for (const s of all) {
      const series = calcSeries(s.klines, W);
      for (const t of [80, 85, 90]) {
        const evs = findEvents(series, t);
        evTotal += evs.length;
        for (const ev of evs) {
          const bi = s.klines.findIndex(x => x.d >= ev);
          if (bi < 0) continue;
          const buyP = s.klines[bi].close;
          const endP = s.klines[s.klines.length - 1].close;
          retSum += (endP - buyP) / buyP * 100 / 3;
          wsum += 1 / 3;
        }
      }
      const evs80 = findEvents(series, 80);
      if (evs80.length) { const md = maxDrawdown(s.klines, evs80[0]); if (md != null) { mddSum += md; mddN++; } }
    }
    console.log(String(W).padEnd(5), (wsum ? (retSum / wsum).toFixed(1) + '%' : '—').padEnd(8), String(evTotal).padEnd(8), mddN ? '-' + (mddSum / mddN).toFixed(1) + '%' : '—');
  }
}
if (require.main === module && process.argv[2] === 'extra') extra();
