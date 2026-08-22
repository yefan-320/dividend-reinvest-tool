#!/usr/bin/env node
/* 生成 TIER_LINE 分位线数据块（季度重算用；2026-08-18 首版）
 * 每只：近3年 dy 分布 P75/P90/P95 + 分红CAGR(3y) + 支付率(近2财年) + 增速质量 + 红线检测
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));

const IND = {
  bank: ['600036', '601398', '601988', '601288', '601328', '600016', '000001', '601166'],
  consumer: ['600519', '000858', '000895', '600887', '000651', '000333', '600690'],
  insurer: ['601318', '601628', '601601'],
  utility: ['600900', '600886', '600027', '600795', '601985'],
  energy: ['600028', '601857', '601088', '600188', '601225'],
};
const NAME = { '600036': '招商银行', '601398': '工商银行', '601988': '中国银行', '601288': '农业银行', '601328': '交通银行', '600016': '民生银行', '000001': '平安银行', '601166': '兴业银行', '600519': '贵州茅台', '000858': '五粮液', '000895': '双汇发展', '600887': '伊利股份', '601318': '中国平安', '601628': '中国人寿', '601601': '中国太保', '600900': '长江电力', '600886': '国投电力', '600027': '华电国际', '600795': '国电电力', '601985': '中国核电', '600028': '中国石化', '601857': '中国石油', '601088': '中国神华', '600188': '兖矿能源', '601225': '陕西煤业', '000651': '格力电器', '000333': '美的集团', '600690': '海尔智家', '600941': '中国移动' };

function loadStock(code) {
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { code, kline, divs, cached: true };
}
async function loadMobile() {
  const cols = 'SECURITY_CODE,REPORT_DATE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,BASIC_EPS';
  const r = await fetch('https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=' + cols + '&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=' + encodeURIComponent('(SECURITY_CODE="600941")'), { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://data.eastmoney.com/' } });
  const j = await r.json();
  const divs = DL.dedupDividends(DL.parseDivs(j.result.data));
  let kline = {};
  for (let t = 1; t <= 3; t++) {
    try {
      const r2 = await fetch('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh600941&scale=240&ma=no&datalen=4000', { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://finance.sina.com.cn/' } });
      const txt = await r2.text();
      if (!txt.startsWith('[')) throw new Error('x');
      const arr = JSON.parse(txt);
      arr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.day] = c; });
      break;
    } catch (e) { await new Promise(r => setTimeout(r, t * 4000)); }
  }
  return { code: '600941', kline, divs, cached: false };
}

(async () => {
  const out = {};
  for (const [ind, codes] of Object.entries(IND)) {
    for (const code of codes) {
      const s = loadStock(code);
      if (!Object.keys(s.kline).length || !s.divs.length) continue;
      const dates = Object.keys(s.kline).sort();
      if (dates.length < 800) continue;
      const series = DL.calcRollingPercentile(s.kline, s.divs, 375);
      const r3 = series.filter(x => x.dy != null && x.d >= '2023-01-01').map(x => x.dy).sort((a, b) => a - b);
      if (r3.length < 400) continue;
      const q = (p) => r3[Math.min(r3.length - 1, Math.floor(p / 100 * r3.length))];
      const byRep = {}, epsY = {};
      s.divs.forEach(d => { if (d.pending || !d.report) return; const y = d.report.slice(0, 4); if (!y) return; byRep[y] = (byRep[y] || 0) + (d.dps || 0); if (/-12-31$/.test(d.report) && d.eps != null) epsY[y] = d.eps; });
      const yrs = Object.keys(byRep).filter(y => byRep[y] > 0).sort();
      const cagr = yrs.length >= 4 && byRep[yrs[yrs.length - 4]] > 0.1 ? (Math.pow(byRep[yrs[yrs.length - 1]] / byRep[yrs[yrs.length - 4]], 1 / 3) - 1) * 100 : null;
      // 支付率近2财年
      const last2 = yrs.slice(-2).filter(y => epsY[y] > 0);
      const payout = last2.length >= 2 ? (byRep[last2[1]] + byRep[last2[0]]) / (epsY[last2[1]] + epsY[last2[0]]) : null;
      // 增速质量
      let quality = '—';
      if (cagr != null) quality = cagr >= 10 ? '高增长' : cagr >= 5 ? '稳定增长' : cagr >= 0 ? '低增长' : '负增长';
      out[code] = {
        name: NAME[code] || code, ind,
        p75: +q(75).toFixed(2), p90: +q(90).toFixed(2), p95: +q(95).toFixed(2),
        cagr: cagr != null ? +cagr.toFixed(1) : null,
        payout: payout != null ? +(payout * 100).toFixed(0) : null,
        quality,
        redLine: payout != null && (payout > 0.9 || payout < 0.2),
        sampleDays: r3.length, asOf: '2026-08-18', window: '近3年',
      };
    }
  }
  // 移动
  const m = await loadMobile();
  if (Object.keys(m.kline).length) {
    const series = DL.calcRollingPercentile(m.kline, m.divs, 375);
    const r3 = series.filter(x => x.dy != null && x.d >= '2023-01-01').map(x => x.dy).sort((a, b) => a - b);
    const q = (p) => r3[Math.min(r3.length - 1, Math.floor(p / 100 * r3.length))];
    const byRep = {}, epsY = {};
    m.divs.forEach(d => { if (d.pending || !d.report) return; const y = d.report.slice(0, 4); if (!y) return; byRep[y] = (byRep[y] || 0) + (d.dps || 0); if (/-12-31$/.test(d.report) && d.eps != null) epsY[y] = d.eps; });
    const yrs = Object.keys(byRep).filter(y => byRep[y] > 0).sort();
    const cagr = yrs.length >= 4 && byRep[yrs[yrs.length - 4]] > 0.1 ? (Math.pow(byRep[yrs[yrs.length - 1]] / byRep[yrs[yrs.length - 4]], 1 / 3) - 1) * 100 : null;
    const last2 = yrs.slice(-2).filter(y => epsY[y] > 0);
    const payout = last2.length >= 2 ? (byRep[last2[1]] + byRep[last2[0]]) / (epsY[last2[1]] + epsY[last2[0]]) : null;
    out['600941'] = {
      name: '中国移动', ind: 'telecom',
      p75: +q(75).toFixed(2), p90: +q(90).toFixed(2), p95: +q(95).toFixed(2),
      cagr: cagr != null ? +cagr.toFixed(1) : null,
      payout: payout != null ? +(payout * 100).toFixed(0) : null,
      quality: cagr != null ? (cagr >= 10 ? '高增长' : cagr >= 5 ? '稳定增长' : cagr >= 0 ? '低增长' : '负增长') : '—',
      redLine: payout != null && (payout > 0.9 || payout < 0.2),
      sampleDays: r3.length, asOf: '2026-08-18', window: '近3年', shortSample: true,
    };
  }
  const lines = [];
  for (const [code, o] of Object.entries(out).sort()) {
    lines.push(`  '${code}': { name: '${o.name}', ind: '${o.ind}', p75: ${o.p75}, p90: ${o.p90}, p95: ${o.p95}, cagr: ${o.cagr}, payout: ${o.payout}, quality: '${o.quality}', redLine: ${o.redLine}, shortSample: ${!!o.shortSample} },`);
  }
  fs.writeFileSync('/tmp/tier-line-block.js', 'const TIER_LINE = {\n' + lines.join('\n') + '\n};\n');
  console.log('生成 ' + Object.keys(out).length + ' 只分位线数据块 → /tmp/tier-line-block.js');
  console.log('红线标的（支付率>90%或<20%）:');
  Object.entries(out).filter(([, o]) => o.redLine).forEach(([c, o]) => console.log('  ' + c + ' ' + o.name + ' 支付率=' + o.payout + '%'));
  console.log('\n6 只持仓:');
  ['600036', '601398', '600887', '600941', '000333', '601318'].forEach(c => { const o = out[c]; if (o) console.log('  ' + o.name + ' P75=' + o.p75 + ' P90=' + o.p90 + ' P95=' + o.p95 + ' CAGR=' + o.cagr + ' 支付率=' + o.payout + '% ' + o.quality + (o.shortSample ? ' [短样本]' : '')); });
  process.exit(0);
})();
