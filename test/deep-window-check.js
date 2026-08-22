#!/usr/bin/env node
/* 深度验证：250 vs 500 长期收益差异是否真实（主人质疑：为什么短期窗口长期也优？）
 * ① 40 只高股息股票（大幅扩样本） ② 事件重合度 ③ 买入价对比 ④ 同一年份子样本对比 ⑤ 时段分布
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;
const STOCKS = [
  // 银行 8
  { code: '600036', name: '招商银行', tx: 'sh600036' }, { code: '601398', name: '工商银行', tx: 'sh601398' },
  { code: '601988', name: '中国银行', tx: 'sh601988' }, { code: '601288', name: '农业银行', tx: 'sh601288' },
  { code: '601328', name: '交通银行', tx: 'sh601328' }, { code: '600016', name: '民生银行', tx: 'sh600016' },
  { code: '000001', name: '平安银行', tx: 'sz000001' }, { code: '601166', name: '兴业银行', tx: 'sh601166' },
  // 白酒/食品 4
  { code: '600519', name: '贵州茅台', tx: 'sh600519' }, { code: '000858', name: '五粮液', tx: 'sz000858' },
  { code: '000895', name: '双汇发展', tx: 'sz000895' }, { code: '600887', name: '伊利股份', tx: 'sh600887' },
  // 保险 3
  { code: '601318', name: '中国平安', tx: 'sh601318' }, { code: '601628', name: '中国人寿', tx: 'sh601628' },
  { code: '601601', name: '中国太保', tx: 'sh601601' },
  // 电力/公用 5
  { code: '600900', name: '长江电力', tx: 'sh600900' }, { code: '600886', name: '国投电力', tx: 'sh600886' },
  { code: '600027', name: '华电国际', tx: 'sh600027' }, { code: '600795', name: '国电电力', tx: 'sh600795' },
  { code: '601985', name: '中国核电', tx: 'sh601985' },
  // 石化/能源 5
  { code: '600028', name: '中国石化', tx: 'sh600028' }, { code: '601857', name: '中国石油', tx: 'sh601857' },
  { code: '601088', name: '中国神华', tx: 'sh601088' }, { code: '600188', name: '兖矿能源', tx: 'sh600188' },
  { code: '601225', name: '陕西煤业', tx: 'sh601225' },
  // 家电 4
  { code: '000651', name: '格力电器', tx: 'sz000651' }, { code: '000333', name: '美的集团', tx: 'sz000333' },
  { code: '600690', name: '海尔智家', tx: 'sh600690' }, { code: '000100', name: 'TCL科技', tx: 'sz000100' },
  // 基建/建材 4
  { code: '600585', name: '海螺水泥', tx: 'sh600585' }, { code: '601668', name: '中国建筑', tx: 'sh601668' },
  { code: '601390', name: '中国中铁', tx: 'sh601390' }, { code: '600031', name: '三一重工', tx: 'sh600031' },
  // 交运/钢铁/汽车 7
  { code: '601006', name: '大秦铁路', tx: 'sh601006' }, { code: '600104', name: '上汽集团', tx: 'sh600104' },
  { code: '600019', name: '宝钢股份', tx: 'sh600019' }, { code: '601899', name: '紫金矿业', tx: 'sh601899' },
  { code: '601600', name: '中国铝业', tx: 'sh601600' }, { code: '600009', name: '上海机场', tx: 'sh600009' },
  { code: '601111', name: '中国国航', tx: 'sh601111' },
];
const WINDOWS = [250, 375, 500];
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
  return { ret: (klines[ti].close - bp + divSum) / bp * 100, bp };
}

async function main() {
  const all = [];
  for (const s of STOCKS) {
    await new Promise(r => setTimeout(r, 900));
    try {
      const klines = await fetchKlineSina(s.tx);
      const divs = await fetchDivs(s.code);
      if (!divs.length) { console.log(`⚠️ ${s.name} 分红空`); continue; }
      const km = {}; klines.forEach(x => km[x.d] = x.close);
      all.push({ ...s, klines, divs, km });
    } catch (e) { console.log(`❌ ${s.name}: ${e.message}`); }
  }
  console.log(`\n有效 ${all.length} 只\n`);

  // ① 总表：250/375/500 × 1/3/5/10 年（价格+分红）
  console.log('=== ① 40 只大样本：股息率分位 80 事件 × 价格+分红收益 ===');
  const header = ['窗口'].concat([1, 3, 5, 10].map(h => `${h}年中位(n)`), [1, 3, 5, 10].map(h => `${h}年胜率`));
  console.log(header.join(' | '));
  const allEv = {};
  for (const W of WINDOWS) {
    const cells = [], wins = [];
    allEv[W] = [];
    for (const h of [1, 3, 5, 10]) {
      const arr = [];
      for (const s of all) {
        const ser = DL.calcRollingPercentile(s.km, s.divs, W);
        for (const ev of DL.findZoneEvents(ser, 80)) {
          const r = buyAfterNDiv(s.klines, s.divs, ev.start, h);
          if (r != null) arr.push(r.ret);
          if (h === 1) allEv[W].push({ stock: s.name, date: ev.start });
        }
      }
      const med = arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;
      const win = arr.length ? (arr.filter(x => x > 0).length / arr.length * 100).toFixed(0) + '%' : '—';
      cells.push(`${med != null ? med.toFixed(1) : '—'}(${arr.length})`);
      wins.push(win);
    }
    console.log(String(W).padEnd(6), cells.join('  '), ' | ', wins.join('  '));
  }

  // ② 事件重合度（250 vs 500 触发日期有多少相同）
  console.log('\n=== ② 事件重合度（同标的同日期触发占比） ===');
  const s250 = {}, s500 = {};
  for (const s of all) {
    s250[s.name] = new Set(DL.findZoneEvents(DL.calcRollingPercentile(s.km, s.divs, 250), 80).map(e => e.start));
    s500[s.name] = new Set(DL.findZoneEvents(DL.calcRollingPercentile(s.km, s.divs, 500), 80).map(e => e.start));
  }
  let overlap = 0, t250 = 0, t500 = 0;
  for (const n of Object.keys(s250)) {
    overlap += [...s250[n]].filter(d => s500[n].has(d)).length;
    t250 += s250[n].size; t500 += s500[n].size;
  }
  console.log(`250 事件 ${t250}，500 事件 ${t500}，重合 ${overlap}（250 的 ${(overlap / t250 * 100).toFixed(0)}%，500 的 ${(overlap / t500 * 100).toFixed(0)}%）`);

  // ③ 买入价对比（250 vs 500 触发时价格 vs 当日一年后价格）
  console.log('\n=== ③ 买入时股息率对比（250 vs 500 事件日） ===');
  for (const W of [250, 500]) {
    let dySum = 0, n = 0;
    for (const s of all) {
      const ser = DL.calcRollingPercentile(s.km, s.divs, W);
      for (const ev of DL.findZoneEvents(ser, 80)) {
        const x = ser.find(v => v.d === ev.start);
        if (x && x.dyS) { dySum += x.dyS; n++; }
      }
    }
    console.log(`W${W}: 事件日平均股息率 ${(dySum / n).toFixed(2)}%（n=${n}）`);
  }

  // ④ 同一年份子样本对比（10 年收益）
  console.log('\n=== ④ 同一年份买入（2011-2016）10 年收益中位：250 vs 375 vs 500 ===');
  const byYear = { 250: {}, 375: {}, 500: {} };
  for (const W of WINDOWS) {
    for (const s of all) {
      const ser = DL.calcRollingPercentile(s.km, s.divs, W);
      for (const ev of DL.findZoneEvents(ser, 80)) {
        const y = ev.start.slice(0, 4);
        if (y < '2011' || y > '2016') continue;
        const r = buyAfterNDiv(s.klines, s.divs, ev.start, 10);
        if (r != null) (byYear[W][y] = byYear[W][y] || []).push(r.ret);
      }
    }
  }
  const med = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  console.log('年份  W250(中位/n)      W375(中位/n)      W500(中位/n)');
  for (const y of ['2011', '2012', '2013', '2014', '2015', '2016']) {
    const fmt = W => { const a = byYear[W][y]; return a ? `${med(a).toFixed(1)}%/${a.length}` : '—'; };
    console.log(y, fmt(250).padEnd(14), fmt(375).padEnd(14), fmt(500));
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
