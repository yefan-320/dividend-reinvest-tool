// 集成验证：ETF 分红接入后对比页数据正确性（515080 vs 600036，5年·100万·复投）
// Node 环境：jsonp 用 fetch 模拟（返回解析对象）；simulate/yieldSeries 从源码提取
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const simMatch = src.match(/function simulate[\s\S]*?\n}/);
const xirrMatch = src.match(/function calcXirr[\s\S]*?\n}/);
if (!simMatch || !xirrMatch) throw new Error('提取失败');
const simulate = eval('(' + simMatch[0].replace('function simulate', 'function') + ')');
const calcXirr = eval('(' + xirrMatch[0].replace('function calcXirr', 'function') + ')');

// jsonp 模拟：FHGG（JSONP 文本剥壳）与东财 datacenter（JSONP 文本剥壳）
async function jsonpFetch(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fundf10.eastmoney.com/fhsp_515080.html' } });
  const t = await r.text();
  const m = t.match(/^[\w.]*\(([\s\S]*)\)\s*;?\s*$/);
  return m ? JSON.parse(m[1]) : JSON.parse(t);
}
async function etfDividends(code) {
  const anns = (await jsonpFetch('https://api.fund.eastmoney.com/f10/FHGG?callback=cb&fundcode=' + code + '&pageSize=50&pageIndex=1')).Data || [];
  const out = [];
  for (const a of anns) {
    const d = await (await fetch('https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=' + a.ID + '&client_source=web&page_index=1', { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/' } })).json();
    const c = d.data && d.data.notice_content || '';
    const mAmt = c.match(/本次分红方案[（(][\s\S]{0,80}?[）)][\s\S]{0,80}?([\d.]+)/);
    const mEx = c.match(/除息日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (!mAmt || !mEx) continue;
    out.push({ ex: mEx[1] + '-' + mEx[2].padStart(2, '0') + '-' + mEx[3].padStart(2, '0'), dps: parseFloat(mAmt[1]) / 10, report: (a.TITLE.match(/(\d{4})\s*年度/) || [])[1] + '-12-31', pending: false });
  }
  return out.sort((a, b) => a.ex < b.ex ? 1 : -1);
}
async function stockDividends(code) {
  const filter = encodeURIComponent('(SECURITY_CODE="' + code + '")');
  const d = await jsonpFetch('https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=SECURITY_CODE,REPORT_DATE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,ASSIGN_PROGRESS&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=' + filter);
  return ((d.result && d.result.data) || []).filter(x => x.ASSIGN_PROGRESS === '实施分配').map(x => ({
    ex: (x.EX_DIVIDEND_DATE || '').slice(0, 10), dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10, report: (x.REPORT_DATE || '').slice(0, 10), pending: false,
  })).filter(x => x.dps > 0);
}
async function kline(code, market, start) {
  const tx = (market || (/^6|5/.test(code) ? 'sh' : 'sz')) + code;
  const map = {}; let cur = start;
  for (let i = 0; i < 6 && cur < '2026-08-17'; i++) {
    const segEnd = new Date(new Date(cur).getTime() + 730 * 86400000).toISOString().slice(0, 10);
    const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + tx + ',day,' + cur + ',' + segEnd + ',800,';
    const d = await (await fetch(url)).json();
    const node = d.data && d.data[tx];
    (node && node.day || []).forEach(r => map[r[0]] = parseFloat(r[2]));
    const last = node && node.day && node.day.length ? node.day[node.day.length - 1][0] : cur;
    if (!node || !node.day || !node.day.length) break;
    cur = new Date(new Date(last).getTime() + 86400000).toISOString().slice(0, 10);
  }
  return map;
}

(async () => {
  const start = '2021-08-12', end = '2026-08-16';
  const targets = [
    { name: '中证红利ETF招商', code: '515080', market: 'sh', etf: true },
    { name: '招商银行', code: '600036', market: 'sh', etf: false },
  ];
  console.log('=== 对比 ' + start + ' → ' + end + '（5年·100万·复投·零月供）===');
  for (const t of targets) {
    const divs = t.etf ? await etfDividends(t.code) : await stockDividends(t.code);
    const kl = await kline(t.code, t.market, start);
    const dates = Object.keys(kl).sort();
    const actualStart = dates[0] > start ? dates[0] : start;
    const res = simulate(1000000, actualStart, true, kl, divs, 0);
    // 逐年股息率（B3 同逻辑）
    const annual = {};
    divs.forEach(d => { if (d.report) { const ry = d.report.slice(0, 4); annual[ry] = (annual[ry] || 0) + d.dps; } });
    const repYrs = Object.keys(annual).map(Number).sort();
    const series = repYrs.map(yy => { const dps = annual[yy]; const yDates = dates.filter(d => d.startsWith(String(yy))); const price = yDates.length ? kl[yDates[yDates.length - 1]] : res.final.lastClose; return yy + ':' + (dps / price * 100).toFixed(2) + '%'; });
    console.log(`\n【${t.name}】K线 ${dates.length} 点 · 分红 ${divs.length} 条`);
    console.log('  期末总资产:', Math.round(res.final.finalValue), '累计分红:', Math.round(res.final.totalDiv), 'XIRR:', (res.final.xirr * 100).toFixed(2) + '%');
    console.log('  逐年股息率(报告期归组÷年末价):', series.join(' '));
    // 验收断言
    const okDiv = res.final.totalDiv > 0;
    const okSeries = series.length >= 3;
    console.log('  ' + (t.etf ? 'ETF' : '股票') + ' 断言：累计分红>0 ' + (okDiv ? '✅' : '❌') + ' · 逐年序列≥3年 ' + (okSeries ? '✅' : '❌'));
  }
})().catch(e => { console.error('崩溃:', e.message); process.exit(1); });
