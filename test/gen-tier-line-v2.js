#!/usr/bin/env node
/* 生成 TIER_LINE 溢价分位数据块 v2（2026-08-18 第5轮定案）
 * 分子=风险溢价（dy−历史国债_t，年度锚点插值近似序列·三重标注）
 * 存溢价分位（pp），tierSpot 用 dy−TREASURY_NOW 比较触发
 * 移动：K线源故障 → 股息率线暂替（只展示不触发，pending 标记）
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
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
// 国债年度锚点近似序列（三重标注：近似序列·年度锚点插值·正式源待接入；覆盖2010-2026）
const ANCHOR = [['2010-01-01', 4.0], ['2011-01-01', 3.8], ['2012-01-01', 3.5], ['2013-01-01', 4.0], ['2014-01-01', 3.9], ['2015-01-01', 3.5], ['2016-01-01', 3.0], ['2017-01-01', 3.9], ['2018-01-01', 3.5], ['2019-01-01', 3.2], ['2020-01-01', 3.2], ['2021-01-01', 3.1], ['2022-01-01', 2.8], ['2023-01-01', 2.6], ['2024-01-01', 2.2], ['2025-01-01', 1.7], ['2026-01-01', 1.55]];
function treasuryAt(d) {
  const t = new Date(d + 'T00:00:00Z').getTime();
  let lo = ANCHOR[0], hi = ANCHOR[ANCHOR.length - 1];
  for (let i = 1; i < ANCHOR.length; i++) {
    if (new Date(ANCHOR[i][0] + 'T00:00:00Z').getTime() > t) { hi = ANCHOR[i]; lo = ANCHOR[i - 1]; break; }
  }
  const t0 = new Date(lo[0] + 'T00:00:00Z').getTime(), t1 = new Date(hi[0] + 'T00:00:00Z').getTime();
  return lo[1] + (hi[1] - lo[1]) * (t - t0) / (t1 - t0);
}

(async () => {
  const out = {};
  for (const [ind, codes] of Object.entries(IND)) {
    for (const code of codes) {
      const karr = cache[code + ':k'] || [], divs = cache[code + ':d'] || [];
      const kline = {};
      karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
      if (!Object.keys(kline).length || !divs.length) continue;
      const series = DL.calcRollingPercentile(kline, divs, 375);
      const r3 = series.filter(x => x.dy != null && x.d >= '2023-01-01');
      if (r3.length < 400) continue;
      const sp = r3.map(x => x.dy - treasuryAt(x.d)).sort((a, b) => a - b);
      const q = (p) => sp[Math.min(sp.length - 1, Math.floor(p / 100 * sp.length))];
      // 近1年参考窗（大师第4轮 A2：只展示不触发，防"线含过去时"——工行近1年P90=4.52 vs 近3年6.57）
      const r1 = series.filter(x => x.dy != null && x.d >= '2025-01-01').map(x => x.dy - treasuryAt(x.d)).sort((a, b) => a - b);
      const q1 = (p) => r1.length >= 100 ? r1[Math.min(r1.length - 1, Math.floor(p / 100 * r1.length))] : null;
      const byRep = {}, epsY = {};
      divs.forEach(d => { if (d.pending || !d.report) return; const y = d.report.slice(0, 4); if (!y) return; byRep[y] = (byRep[y] || 0) + (d.dps || 0); if (/-12-31$/.test(d.report) && d.eps != null) epsY[y] = d.eps; });
      const yrs = Object.keys(byRep).filter(y => byRep[y] > 0).sort();
      const cagr = yrs.length >= 4 && byRep[yrs[yrs.length - 4]] > 0.1 ? (Math.pow(byRep[yrs[yrs.length - 1]] / byRep[yrs[yrs.length - 4]], 1 / 3) - 1) * 100 : null;
      const last2 = yrs.slice(-2).filter(y => epsY[y] > 0);
      const payout = last2.length >= 2 ? (byRep[last2[1]] + byRep[last2[0]]) / (epsY[last2[1]] + epsY[last2[0]]) : null;
      let quality = '—';
      if (cagr != null) quality = cagr >= 10 ? '高增长' : cagr >= 5 ? '稳定增长' : cagr >= 0 ? '低增长' : '负增长';
      out[code] = {
        name: NAME[code] || code, ind,
        p75: +q(75).toFixed(2), p90: +q(90).toFixed(2), p95: +q(95).toFixed(2),
        p90_1y: q1(90) != null ? +q1(90).toFixed(2) : null,
        cagr: cagr != null ? +cagr.toFixed(1) : null,
        payout: payout != null ? +(payout * 100).toFixed(0) : null,
        quality,
        redLine: payout != null && (payout > 0.9 || payout < 0.2),
        sampleDays: r3.length, asOf: '2026-08-18', window: '近3年溢价',
      };
    }
  }
  // 移动：K线源故障 → 股息率线暂替（pending：只展示不触发）
  const m = { name: '中国移动', ind: 'telecom', p75: 4.49, p90: 4.97, p95: 5.06, p90_1y: null, cagr: 6.7, payout: 73, quality: '稳定增长', redLine: false, sampleDays: 877, asOf: '2026-08-18', window: '股息率线暂替', pending: true };
  out['600941'] = m;
  const lines = [];
  for (const [code, o] of Object.entries(out).sort()) {
    lines.push(`  '${code}': { name: '${o.name}', ind: '${o.ind}', p75: ${o.p75}, p90: ${o.p90}, p95: ${o.p95}, p90_1y: ${o.p90_1y != null ? o.p90_1y : 'null'}, cagr: ${o.cagr}, payout: ${o.payout}, quality: '${o.quality}', redLine: ${o.redLine}, pending: ${!!o.pending} },`);
  }
  fs.writeFileSync('/tmp/tier-line-block-v2.js', 'const TIER_LINE = {\n' + lines.join('\n') + '\n};\n');
  console.log('生成 ' + Object.keys(out).length + ' 只溢价分位数据块 → /tmp/tier-line-block-v2.js');
  console.log('\n6 只持仓（溢价分位 pp）：');
  ['600036', '601398', '600887', '600941', '000333', '601318'].forEach(c => { const o = out[c]; if (o) console.log('  ' + o.name + ' P75=' + o.p75 + ' P90=' + o.p90 + ' P95=' + o.p95 + 'pp 近1年P90=' + (o.p90_1y != null ? o.p90_1y : '—') + 'pp' + (o.pending ? ' [股息率线暂替·只展示不触发]' : '') + ' CAGR=' + o.cagr + ' 支付率=' + o.payout + '%'); });
  process.exit(0);
})();
