#!/usr/bin/env node
/* 本地前复权验证：新浪不复权K + 东财分红 → 自算前复权 vs 腾讯qfq（重叠区间应一致）
 * 前复权算法：从最新往历史逐日，除权日 D（dps 现金分红、bonus 送转/10股）：
 *   调整因子 f = (prev_close - dps) / (prev_close * (1 + bonus/10))
 *   该日之前所有价格 ×= f
 */
const STOCKS = [
  { code: '600036', name: '招商银行', tx: 'sh600036' },
  { code: '601398', name: '工商银行', tx: 'sh601398' },
  { code: '600519', name: '贵州茅台', tx: 'sh600519' },
  { code: '600900', name: '长江电力', tx: 'sh600900' },
];

async function fetchKlineSina(tx, n = 2000) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tx}&scale=240&ma=no&datalen=${n}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  return JSON.parse(await r.text()).map(x => ({ d: x.day, close: parseFloat(x.close) }));
}
async function fetchDivsDirect(code) {
  const cols = 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,IT_RATIO,ASSIGN_PROGRESS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://data.eastmoney.com/' } });
  const j = await r.json();
  const rows = (j && j.result && j.result.data) || [];
  return rows.map(x => ({
    ex: (x.EX_DIVIDEND_DATE || '').slice(0, 10),
    dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10,
    bonus: (parseFloat(x.BONUS_IT_RATIO) || 0) / 10,   // 送转合计（每10股）
    progress: x.ASSIGN_PROGRESS || '',
  }));
}
async function fetchTxQfq(tx, n = 2000) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tx},day,,,${n},qfq`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://gu.qq.com/' } });
  const j = await r.json();
  const arr = (j.data && j.data[tx] && j.data[tx].qfqday) || [];
  return arr.map(x => ({ d: x[0], close: parseFloat(x[2]) }));
}

function localQfq(klines, divs) {
  // 按日期排序
  const ks = [...klines].sort((a, b) => a.d < b.d ? -1 : 1);
  const dates = ks.map(x => x.d);
  const price = {}; ks.forEach(x => price[x.d] = x.close);
  // 只处理已实施的除权
  const exDivs = divs.filter(d => d.ex && d.ex >= dates[0] && d.ex <= dates[dates.length - 1] && d.progress.indexOf('实施') >= 0);
  exDivs.sort((a, b) => a.ex < b.ex ? -1 : 1);
  // 减差法（与腾讯 qfq 一致）：前复权价 = 原价 - 该日之后累计分红（送转用等比因子叠加）
  let sum = 0;
  let mul = 1;
  const out = {};
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    out[d] = price[d] * mul - sum;
    const ex = exDivs.find(x => x.ex === d);
    if (ex) {
      sum += ex.dps;                    // 现金分红：减法累积
      if (ex.bonus > 0) mul /= (1 + ex.bonus);   // 送转：等比调整（送转后历史价更低）
    }
  }
  return dates.map(d => ({ d, close: out[d] }));
}

async function main() {
  for (const s of STOCKS) {
    const sina = await fetchKlineSina(s.tx, 2000);
    const divs = await fetchDivsDirect(s.code);
    const local = localQfq(sina, divs);
    let txq = [];
    try { txq = await fetchTxQfq(s.tx); } catch (e) { console.log(s.name, '腾讯qfq失败', e.message); }
    // 对比重叠区间（腾讯 641 根的最后部分 vs 本地同日期）
    const txMap = {}; txq.forEach(x => txMap[x.d] = x.close);
    const localMap = {}; local.forEach(x => localMap[x.d] = x.close);
    const common = Object.keys(txMap).filter(d => localMap[d] != null).sort();
    let maxDiff = 0, sumDiff = 0, n = 0, over1pct = 0;
    for (const d of common) {
      const diff = Math.abs(txMap[d] - localMap[d]);
      const pct = diff / txMap[d] * 100;
      maxDiff = Math.max(maxDiff, pct);
      sumDiff += pct; n++;
      if (pct > 1) over1pct++;
    }
    console.log(`\n${s.name}: 本地复权 ${local.length} 根（${local[0].d}~${local[local.length-1].d}）| 腾讯qfq ${txq.length} 根（${txq[0] ? txq[0].d : '?'}~）`);
    console.log(`  重叠 ${n} 天：最大偏差 ${maxDiff.toFixed(3)}%，平均 ${n ? (sumDiff / n).toFixed(3) : 0}%，偏差>1%天数 ${over1pct}`);
    // 展示最近 3 天对比
    common.slice(-3).forEach(d => console.log(`  ${d}: 本地=${localMap[d].toFixed(3)} 腾讯=${txMap[d].toFixed(3)}`));
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
