#!/usr/bin/env node
/* P95_TRIGGERS 自动刷新（大师终审建议 M4 联动项）
 * 口径=与原表完全一致（/tmp/p95-triggers.js 同源）：
 *   P95 线 = TIER_LINE[code].p95 + TREASURY_NOW（绝对 dy 线，与 tierSpot heavy 同口径）
 *   触发 = dy 序列连续达标区间首日（zoneEvents）
 * 用法：node scripts/refresh-p95-triggers.js [--apply]
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');

const cache = JSON.parse(fs.readFileSync('/Users/macbookpro/Documents/deepseek/repo/data/rule-tree-cache.json', 'utf8'));
const TARGETS = Object.keys(DL.BUY_CFG || {}).filter(c => cache[c + ':k'] && cache[c + ':k'].length > 100);

function loadStock(code) {
  const karr = cache[code + ':k'] || [];
  const divs = cache[code + ':d'] || [];
  const kline = {};
  karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { code, kline, divs };
}
function zoneEvents(series, line) {
  const evs = []; let inZ = false, start = null;
  for (const x of series) {
    if (x.dy == null) continue;
    if (x.dy >= line) { if (!inZ) { inZ = true; start = x.d; } }
    else { if (inZ) { evs.push(start); inZ = false; } }
  }
  if (inZ) evs.push(start);
  return evs;
}
(async () => {
  console.log('code | 个股P95线(dy口径) | 历史触发次数 | 最近触发日 | 判定');
  const out = {};
  for (const code of TARGETS) {
    const tl = DL.TIER_LINE[code];
    if (!tl) { console.log(code + ' | 无TIER_LINE | -'); continue; }
    const s = loadStock(code);
    if (!Object.keys(s.kline).length || !s.divs.length) { console.log(code + ' | 无缓存数据'); continue; }
    const series = DL.calcRollingPercentile(s.kline, s.divs, 375);
    const heavy = tl.p95 + DL.TREASURY_NOW;
    const evs = zoneEvents(series, heavy);
    const last = evs.length ? evs[evs.length - 1] : null;
    out[code] = evs.length;
    console.log(`${code} | ${heavy.toFixed(2)}% | ${evs.length} | ${last || '—'} | ${evs.length >= 1 ? '有背书' : '首触(0次)'}`);
  }
  if (process.argv.includes('--apply')) {
    const src = fs.readFileSync('/Users/macbookpro/Documents/deepseek/repo/data-layer.js', 'utf8');
    const lines = Object.entries(out).map(([c, n]) => `'${c}': ${n}`).join(', ');
    const re = /const P95_TRIGGERS = \{[\s\S]*?\n\};/;
    const neu = `const P95_TRIGGERS = {  // 个股 P95 线历史触发次数（脚本 scripts/refresh-p95-triggers.js 自动刷新；口径=TIER_LINE.p95+TREASURY_NOW 绝对线，zoneEvents 连续段首日）\n  ${lines},\n};`;
    fs.writeFileSync('/Users/macbookpro/Documents/deepseek/repo/data-layer.js', src.replace(re, neu));
    console.log('\n✅ 已写入 data-layer.js（请 git diff 复核后提交）');
  }
  process.exit(0);
})();
