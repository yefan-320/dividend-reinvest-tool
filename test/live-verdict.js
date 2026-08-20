#!/usr/bin/env node
/* 买入触发优化（2026-08-20 主人令·全标的优化矩阵实验结论）：
 * ①冷却 60 交易日（季度级）：触发 91→33 次，质量提升（原月去重=接刀）
 * ②每只最优组合（2 年胜率优先，样本>10）：
 *   招行 p75       1年71%/2年80%（33次）基础档位即可
 *   宇通 p95+趋势+双闸 2年90%（12次）深度便宜+确认+财报闸
 *   伊利 p95+趋势    2年60%（17次）价格信号弱，事件驱动为主
 *   移动 p90       2年100%（8次）
 *   平安 p75       2年61%（37次）优化空间有限（保险估值波动）
 *   工行 p95+趋势    2年76%（17次）
 *   美的 p95+趋势    2年100%（9次）
 * ③主口径=2 年胜率（长期持有；1 年=短期噪声+熊市）
 */
const BUY_CFG = {
  '600036': { minTier: 'p75' },                // 招行
  '600066': { minTier: 'p95', trend: true, gate: true },  // 宇通
  '600887': { minTier: 'p95', trend: true, eventBlock: ['澳优减值', '短债冲高'] },  // 伊利
  '600941': { minTier: 'p90' },                // 移动
  '601318': { minTier: 'p75' },                // 平安
  '601398': { minTier: 'p95', trend: true },   // 工行
  '000333': { minTier: 'p95', trend: true },   // 美的
};
/* 真实买卖点检测（2026-08-20 主人问"你能真实抓到买卖点吗"）
 * 用行业校准信号包+双闸+共振规则，对 7 只持仓【当前真实状态】判定买卖点
 * 证据链：财报证据（最新年报扣非/OCF/毛利率，行业校准）+ 价格证据（dy分位）+ 估值证据（PB分位）
 */
const fs = require('fs');
const fin = JSON.parse(fs.readFileSync('/tmp/holdings-fin.json', 'utf8'));
const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));

const INDUSTRY = {
  '600036': 'bank', '601398': 'bank', '600887': 'consumer', '600941': 'telecom',
  '000333': 'consumer', '601318': 'insurer', '600066': 'manufacture'
};
const IND_NAME = { bank: '银行', insurer: '保险', telecom: '电信', consumer: '消费', manufacture: '制造' };
// 分位线（dy%）：溢价pp+国债1.681
const LINES = {
  bank: { p75: 5.57, p90: 5.83, p95: 5.98 }, insurer: { p75: 5.24, p90: 5.57, p95: 5.68 },
  telecom: { p75: 4.58, p90: 5.08, p95: 5.28 }, consumer: { p75: 4.78, p90: 5.38, p95: 5.68 },
  manufacture: { p75: 4.88, p90: 5.58, p95: 5.78 },
};
const NAMES = { '600036': '招行', '601398': '工行', '600887': '伊利', '600941': '移动', '000333': '美的', '601318': '平安', '600066': '宇通' };

(async () => {
  // 现价
  const codes = Object.keys(NAMES);
  const q = await (await fetch('https://qt.gtimg.cn/q=' + codes.map(c => (/^6/.test(c) ? 'sh' : 'sz') + c).join(','))).arrayBuffer();
  const qt = new TextDecoder('gbk').decode(q);
  const price = {};
  codes.forEach(c => { const m = qt.match(new RegExp('v_' + (/^6/.test(c) ? 'sh' : 'sz') + c + '="([^"]*)"')); if (m) { const p = m[1].split('~'); price[c] = parseFloat(p[3]); } });

  for (const [code, name] of Object.entries(NAMES)) {
    const ind = INDUSTRY[code];
    const px = price[code];
    // 当前年度 DPS（缓存含中期）
    const divs = cache[code + ':d'] || [];
    const byY = {};
    divs.forEach(d => { if (d.dps > 0 && d.report) { const y = d.report.slice(0, 4); byY[y] = (byY[y] || 0) + d.dps; } });
    const ys = Object.keys(byY).sort();
    const dps = byY[ys[ys.length - 1]] || 0;
    const dy = dps > 0 && px > 0 ? dps / px * 100 : null;
    // 财报证据（最新年报）
    const a = fin[code]?.annuals || [];
    const cur = a[0], prev = a[1];
    const signals = [];
    // 行业校准信号
    if (ind === 'manufacture' || ind === 'consumer') {
      if (cur.kf != null && cur.kf < 0) signals.push('扣非转负');
      if (cur.kf != null && prev && prev.kf != null && prev.kf > 0 && cur.kf < prev.kf * 0.95) signals.push('扣非下滑');
      if (cur.ocf != null && cur.np > 0 && cur.ocf / cur.np < 0.5) signals.push(`OCF/净利${(cur.ocf / cur.np).toFixed(2)}`);
      if (cur.xsmll != null && prev && prev.xsmll != null && a[2] && a[2].xsmll != null) {
        if (cur.xsmll < prev.xsmll - 0.5 && prev.xsmll < a[2].xsmll - 0.5) signals.push('毛利率连降S1');
      }
    } else if (ind === 'bank') {
      if (cur.sjltz != null && cur.sjltz < 0) signals.push(`营收/净利转负(${cur.sjltz}%)`);
      // 拨备反哺无法直接算（需拨备明细），用净利增速+营收增速观察
      if (cur.sjltz != null && cur.sjltz < 5 && cur.ystz != null && cur.ystz < 0) signals.push('净利增速<5%+营收负');
    } else if (ind === 'insurer') {
      if (cur.sjltz != null && cur.sjltz < 0) signals.push(`净利转负(${cur.sjltz}%)`);
    } else if (ind === 'telecom') {
      if (cur.sjltz != null && cur.sjltz < 0) signals.push(`净利转负(${cur.sjltz}%)`);
    }
    // 价格证据（dy 分位）
    let priceEv = null, tier = null;
    if (dy != null) {
      const l = LINES[ind];
      if (dy >= l.p95) { priceEv = `P95触发(${dy.toFixed(2)}%)`; tier = 'p95'; }
      else if (dy >= l.p90) { priceEv = `P90触发(${dy.toFixed(2)}%)`; tier = 'p90'; }
      else if (dy >= l.p75) { priceEv = `P75触发(${dy.toFixed(2)}%)`; tier = 'p75'; }
      else priceEv = `未触发(${dy.toFixed(2)}%)`;
    }
    // 共振/警戒
    let verdict, conf;
    const nSig = signals.length;
    if (ind === 'manufacture' && nSig >= 2) { verdict = '🔴 硬红灯（宇通/制造双信号=立即行动）'; conf = '高'; }
    else if (signals.includes('毛利率连降S1') && (ind === 'manufacture' || ind === 'consumer')) { verdict = '🔴 硬红灯（S1）'; conf = '高'; }
    else if (nSig >= 3) { verdict = '🔴 硬红灯（三共振）'; conf = '高'; }
    else if (nSig === 2) { verdict = '🟠 软恶化（双信号→减半观察）'; conf = '中'; }
    else if (nSig === 1) { verdict = '🟡 观察（单信号）'; conf = '低'; }
    else if (tier) { verdict = tier === 'p95' ? '✅ 重仓买点' : tier === 'p90' ? '✅ 加仓买点' : '🟢 底仓买点'; conf = '中'; }
    else { verdict = '⚪ 持有观望'; conf = '—'; }
    console.log(`\n【${name}】${ind === 'manufacture' ? '（已小仓）' : ''} 现价${px} dy${dy != null ? dy.toFixed(2) + '%' : '—'} ${IND_NAME[ind]}`);
    console.log(`  价格证据: ${priceEv}`);
    console.log(`  财报证据: ${signals.length ? signals.join('、') : '无危险信号（最新年报 净利' + (cur?.np ?? '—') + '亿 扣非' + (cur?.kf ?? '—') + '亿 OCF' + (cur?.ocf ?? '—') + '亿）'}`);
    console.log(`  ➜ ${verdict}（置信度${conf}）`);
  }
})().catch(e => console.error('ERR', e.message));
