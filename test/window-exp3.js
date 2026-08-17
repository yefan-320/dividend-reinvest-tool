#!/usr/bin/env node
/* R5 长窗口 × 长期持有验证（主人令：真实数据+多公司+可反驳）
 * 问题：750/1000 天窗口在 3 年维度"迟钝"，但主人是 5-10 年长期持有——长窗口长期维度是否反超？
 * 样本：15 只高股息标的（覆盖银行/白酒/保险/电力/石化/家电/煤炭/基建）
 * 指标：每窗口 × 每持有年限(1/3/5/10) → 事件买后收益(中位/均值/年化) + 胜率 + 样本数
 * 分红视角：买后 5/10 年累计分红 ÷ 买入价
 */
const STOCKS = [
  { code: '600036', market: 1, name: '招商银行' }, { code: '601398', market: 1, name: '工商银行' },
  { code: '600519', market: 1, name: '贵州茅台' }, { code: '601318', market: 1, name: '中国平安' },
  { code: '600900', market: 1, name: '长江电力' }, { code: '000001', market: 0, name: '平安银行' },
  { code: '600028', market: 1, name: '中国石化' }, { code: '601988', market: 1, name: '中国银行' },
  { code: '000651', market: 0, name: '格力电器' }, { code: '000333', market: 0, name: '美的集团' },
  { code: '600585', market: 1, name: '海螺水泥' }, { code: '601088', market: 1, name: '中国神华' },
  { code: '601006', market: 1, name: '大秦铁路' }, { code: '000895', market: 0, name: '双汇发展' },
  { code: '600104', market: 1, name: '上汽集团' },
];
const WINDOWS = [250, 375, 500, 750, 1000];
const HOLD = [1, 3, 5, 10];

async function fetchKline(code, market) {
  const sym = (market === 1 ? 'sh' : 'sz') + code;
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  const j = JSON.parse(await r.text());
  if (!Array.isArray(j) || !j.length) throw new Error(code + ' 无数据');
  return j.map(x => ({ d: x.day, close: parseFloat(x.close) })).filter(x => x.close > 0);
}
function calcSeries(klines, W) {
  const series = [];
  for (let i = 0; i < klines.length; i++) {
    if (i < W - 1) { series.push({ d: klines[i].d, pct: null }); continue; }
    const win = klines.slice(i - W + 1, i + 1).map(x => x.close).sort((a, b) => a - b);
    let less = 0; for (const v of win) { if (v <= klines[i].close) less++; }
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
function addDays(dStr, days) { const d = new Date(dStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function buyAfterN(klines, buyD, years) {
  const bi = klines.findIndex(x => x.d >= buyD);
  if (bi < 0) return null;
  const bp = klines[bi].close;
  const ti = klines.findIndex(x => x.d >= addDays(buyD, years * 365));
  if (ti < 0) return null;
  return { ret: (klines[ti].close - bp) / bp * 100, annual: (Math.pow(klines[ti].close / bp, 1 / years) - 1) * 100 };
}

async function main() {
  const all = [];
  for (const s of STOCKS) {
    try { const k = await fetchKline(s.code, s.market); all.push({ ...s, klines: k }); console.log(`✅ ${s.name}`); }
    catch (e) { console.log(`❌ ${s.name}: ${e.message}`); }
  }
  console.log(`\n有效样本: ${all.length} 只`);

  // 主表：窗口 × 持有年限 → 中位收益/年化/胜率/样本
  console.log('\n=== 80 分位事件 · 窗口 × 持有年限（收益=中位数，括号=样本数） ===');
  const header = ['窗口'].concat(HOLD.map(h => `${h}年收益(n)`), HOLD.map(h => `${h}年胜率`));
  console.log(header.join(' | '));
  for (const W of WINDOWS) {
    const cells = [];
    for (const h of HOLD) {
      const arr = [];
      for (const s of all) {
        const ser = calcSeries(s.klines, W);
        for (const ev of findEvents(ser, 80)) {
          const r = buyAfterN(s.klines, ev, h);
          if (r) arr.push({ ...r, stock: s.name, date: ev });
        }
      }
      const med = arr.length ? [...arr].sort((a, b) => a.ret - b.ret)[Math.floor(arr.length / 2)] : null;
      const win = arr.length ? (arr.filter(x => x.ret > 0).length / arr.length * 100).toFixed(0) + '%' : '—';
      cells.push(`${med ? med.ret.toFixed(1) : '—'}(${arr.length})`, win);
    }
    console.log(String(W).padEnd(6), cells.join(' | '));
  }

  // 年化对比（长期持有视角：5年/10年年化）
  console.log('\n=== 年化收益（长期持有视角核心指标） ===');
  console.log('窗口  5年年化(中位)  5年年化(均值)  10年年化(中位)  10年年化(均值)  10年样本');
  for (const W of WINDOWS) {
    const a5 = [], a10 = [];
    for (const s of all) {
      const ser = calcSeries(s.klines, W);
      for (const ev of findEvents(ser, 80)) {
        const r5 = buyAfterN(s.klines, ev, 5); if (r5) a5.push(r5.annual);
        const r10 = buyAfterN(s.klines, ev, 10); if (r10) a10.push(r10.annual);
      }
    }
    const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
    const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
    console.log(String(W).padEnd(6),
      (med(a5) != null ? med(a5).toFixed(2) + '%' : '—').padEnd(12),
      (avg(a5) != null ? avg(a5).toFixed(2) + '%' : '—').padEnd(12),
      (med(a10) != null ? med(a10).toFixed(2) + '%' : '—').padEnd(13),
      (avg(a10) != null ? avg(a10).toFixed(2) + '%' : '—').padEnd(13),
      a10.length);
  }

  // 分红视角（粗略）：买后累计分红/买入价 —— 用每股分红近似（新浪无分红数据，用东财接口补）
  // 这里先输出价格视角结论 + 说明分红视角需补数据
  console.log('\n说明：分红视角需要逐只分红数据（东财接口），已列入下一步；价格视角结论如上。');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
