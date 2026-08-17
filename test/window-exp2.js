#!/usr/bin/env node
/* R2 补验（大师 R1 要求 3 项 + 我的独立验证）
 * ① 375 vs 500 按生态拆分：确认生态不改变窗口优劣
 * ② W750≥50 硬校验 vs 双值展示：硬校验滤掉多少事件、滤后胜率变化
 * ③ 交易成本敏感性：千分之一佣金下短窗口收益缩水
 * ④ 独立补充：W500+W250 双触发（大师否决方案对照）+ 各窗口信号年化频率
 */
const fs = require('fs');
global.window = global;
require('../data-layer.js');
const DL = global.window.DL;

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

async function fetchKline(code, market) {
  const sym = (market === 1 ? 'sh' : 'sz') + code;
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://finance.sina.com.cn/' } });
  const j = JSON.parse(await r.text());
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
function pctAt(series, d) { const x = series.find(v => v.d >= d); return x ? x.pct : null; }
function priceAt(klines, d) { const x = klines.find(v => v.d >= d); return x ? x.close : null; }
function klineMap(klines) { const m = {}; klines.forEach(k => m[k.d] = k.close); return m; }
function buyAfter(klines, buyD, days) {
  const bi = klines.findIndex(x => x.d >= buyD);
  if (bi < 0) return null;
  const bp = klines[bi].close;
  const ti = klines.findIndex(x => x.d >= addDays(buyD, days));
  if (ti < 0) return null;
  return (klines[ti].close - bp) / bp * 100;
}
function addDays(dStr, days) { const d = new Date(dStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }

async function main() {
  const all = [];
  for (const s of STOCKS) { const k = await fetchKline(s.code, s.market); all.push({ ...s, klines: k }); }

  // ① 生态拆分：375 vs 500 在低波/高波组的买点质量
  console.log('=== ① 生态拆分（工具 calcEcoType 真实判定） ===');
  const ecoOf = {};
  for (const s of all) {
    const km = klineMap(s.klines);
    const ser500 = calcSeries(s.klines, 500);
    const eco = DL.calcEcoType(km, ser500);
    ecoOf[s.name] = eco.type + '(起建' + eco.ecoStart + ')';
  }
  console.log('生态判定:', JSON.stringify(ecoOf));
  for (const [W, W2] of [[375, 500]]) {
    for (const group of ['low', 'high']) {
      let b1 = [], b3 = [], n = 0;
      for (const s of all) {
        if (!ecoOf[s.name].startsWith(group)) continue;
        const ser = calcSeries(s.klines, W);
        for (const ev of findEvents(ser, 80)) {
          const r1 = buyAfter(s.klines, ev, 365); if (r1 != null) b1.push(r1);
          const r3 = buyAfter(s.klines, ev, 1095); if (r3 != null) b3.push(r3);
          n++;
        }
      }
      const avg = a => a.length ? (a.reduce((s, v) => s + v, 0) / a.length).toFixed(1) + '%' : '—';
      const win = a => a.length ? (a.filter(v => v > 0).length / a.length * 100).toFixed(0) + '%' : '—';
      console.log(`W${W} ${group === 'low' ? '低波组' : '高波组'}: 事件${n} 买后1年 ${avg(b1)} 胜率 ${win(b1)} | 3年 ${avg(b3)} 胜率 ${win(b3)}`);
    }
  }
  for (const W of [375, 500]) {
    let b1 = [], b3 = [];
    for (const s of all) {
      const ser = calcSeries(s.klines, W);
      for (const ev of findEvents(ser, 80)) {
        const r1 = buyAfter(s.klines, ev, 365); if (r1 != null) b1.push(r1);
        const r3 = buyAfter(s.klines, ev, 1095); if (r3 != null) b3.push(r3);
      }
    }
    const avg = a => a.length ? (a.reduce((s, v) => s + v, 0) / a.length).toFixed(1) + '%' : '—';
    const win = a => a.length ? (a.filter(v => v > 0).length / a.length * 100).toFixed(0) + '%' : '—';
    console.log(`W${W} 全体: 事件${b1.length} 1年 ${avg(b1)} 胜率 ${win(b1)} | 3年 ${avg(b3)} 胜率 ${win(b3)}`);
  }

  // ② 硬校验实测：W500 事件中 W750≥50 的比例 + 滤后胜率
  console.log('\n=== ② W500+W750≥50 硬校验（大师备选）实测 ===');
  let allE = 0, pass = 0, p1 = [], f1 = [], p3 = [], f3 = [];
  for (const s of all) {
    const ser5 = calcSeries(s.klines, 500), ser7 = calcSeries(s.klines, 750);
    for (const ev of findEvents(ser5, 80)) {
      allE++;
      const p7 = pctAt(ser7, ev);
      const r1 = buyAfter(s.klines, ev, 365), r3 = buyAfter(s.klines, ev, 1095);
      if (p7 != null && p7 >= 50) { pass++; if (r1 != null) p1.push(r1); if (r3 != null) p3.push(r3); }
      else { if (r1 != null) f1.push(r1); if (r3 != null) f3.push(r3); }
    }
  }
  const avg = a => a.length ? (a.reduce((s, v) => s + v, 0) / a.length).toFixed(1) + '%' : '—';
  const win = a => a.length ? (a.filter(v => v > 0).length / a.length * 100).toFixed(0) + '%' : '—';
  console.log(`W500 事件总数 ${allE}，W750≥50 通过 ${pass}（${(pass / allE * 100).toFixed(0)}%）`);
  console.log(`通过组: 1年 ${avg(p1)} 胜率 ${win(p1)} | 3年 ${avg(p3)} 胜率 ${win(p3)}`);
  console.log(`滤掉组: 1年 ${avg(f1)} 胜率 ${win(f1)} | 3年 ${avg(f3)} 胜率 ${win(f3)}（被滤掉的事件买点质量对比）`);

  // ③ 交易成本：千分之一单边，全事件金字塔收益缩水
  console.log('\n=== ③ 交易成本敏感性（佣金+滑点 0.1% 单边） ===');
  for (const W of [125, 250, 500, 750]) {
    let ret = 0, wsum = 0, evTotal = 0;
    for (const s of all) {
      const ser = calcSeries(s.klines, W);
      for (const t of [80, 85, 90]) {
        for (const ev of findEvents(ser, t)) {
          evTotal++;
          const bp = priceAt(s.klines, ev);
          if (bp == null) continue;
          const ep = s.klines[s.klines.length - 1].close;
          ret += ((ep - bp) / bp - 0.002) * 100 / 3;
          wsum += 1 / 3;
        }
      }
    }
    console.log(`W${W}: 触发 ${evTotal} 次，成本扣 0.2%(买卖各0.1%) 后收益 ${(ret / wsum).toFixed(1)}%（未扣前参考 R1: 125=58.6/250=58.2/500=51.0/750=34.0）`);
  }

  // ④ 独立补充：信号年化频率（每只每年触发几次）
  console.log('\n=== ④ 信号年化频率（80分位事件/只/年） ===');
  for (const W of WINDOWS) {
    let evTotal = 0, years = 0;
    for (const s of all) {
      const ser = calcSeries(s.klines, W);
      evTotal += findEvents(ser, 80).length;
      years = Math.max(years, (new Date(s.klines[s.klines.length - 1].d) - new Date(s.klines[0].d)) / (365 * 86400000));
    }
    console.log(`W${W}: ${(evTotal / 8 / years).toFixed(1)} 次/只/年`);
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
