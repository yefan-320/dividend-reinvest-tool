#!/usr/bin/env node
/* F1 数据对账（2026-08-18 P0）：锚点抽样核对 + 核心数字漂移告警
 * 锚点（决策规范第7章 M21/M36 验收锚点）：招行 TTM 2.016 / 工行 0.310 / 美的 4.300
 *   F10：招行 ROEJQ=13.44 / MGWFPLR=26.9551 / 归母净利 1501.81 亿
 * 漂移：与上次运行结果 diff（存 /tmp/verify-anchors-last.json），核心数字变化 >0.5pp 告警
 *   （正常除息/送转会引发跳变，需人工确认；无变化的运行=数据静止=正常）
 * 运行：node test/verify-anchors.js
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');

const ANCHORS = [
  { code: '600036', name: '招行', ttm: 2.016, f10: { roe: 13.44, mgwfplr: 26.9551, netProfit: 1501.81 } },
  { code: '601398', name: '工行', ttm: 0.310 },
  { code: '000333', name: '美的', ttm: 4.300 },
];
const LAST_FILE = '/tmp/verify-anchors-last.json';
const WARN_PP = 0.5;

(async () => {
  let issues = 0;
  const today = DL.todayStr();
  // 数据源：/tmp/rule-tree-cache.json（40 只 16 年 K线+分红缓存，与信号研究同源）
  const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));
  const loadStock = (code) => {
    const karr = cache[code + ':k'] || [];
    const divs = cache[code + ':d'] || [];
    const kline = {};
    karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
    return { kline, divs };
  };
  const out = { ranAt: today, items: [] };
  for (const a of ANCHORS) {
    try {
      const { divs, kline } = loadStock(a.code);
      if (!divs || !divs.length || !Object.keys(kline).length) { console.log(`❌ ${a.name}: 数据获取失败（缓存无）`); issues++; continue; }
      const series = DL.calcRollingPercentile(kline, divs, 375);
      const last = series.filter(x => x.pct != null).pop();
      const ttm = DL.ttmDivsAt(divs, today);
      const cov = DL.coverageAt(divs, parseInt(today.slice(0, 4), 10));
      const it = { code: a.code, name: a.name, date: today, dy: last ? last.dy : null, pct: last ? last.pct : null, ttm, cov, payRate: cov != null ? cov : null };
      // 锚点核对（TTM 数量级/符号 sanity：>0 且 <10 元/股；覆盖率 0-1 或 null）
      if (!(ttm != null && ttm > 0 && ttm < 10)) { console.log(`❌ ${a.name}: TTM 异常 ${ttm}`); issues++; }
      if (cov != null && (cov <= 0 || cov > 1.5)) { console.log(`❌ ${a.name}: 支付率异常 ${cov}`); issues++; }
      // F10 锚点（招行）
      if (a.f10) {
        const SUF = { '600036': '.SH', '601398': '.SH', '000333': '.SZ' };
        const f10 = await DL.fetchF10Annual(a.code + (SUF[a.code] || '.SH'));
        const roeOk = f10 && f10.roe != null && Math.abs(f10.roe - a.f10.roe) < 1.5;
        const npOk = f10 && f10.netProfit != null && Math.abs(f10.netProfit - a.f10.netProfit) < 20;
        it.f10 = { roe: f10 ? f10.roe : null, netProfit: f10 ? f10.netProfit : null, yoy: f10 ? f10.netProfitYoY : null };
        console.log(`${roeOk ? '✅' : '❌'} ${a.name} F10: ROE ${it.f10.roe}（锚 ${a.f10.roe}）| 净利 ${it.f10.netProfit != null ? it.f10.netProfit.toFixed(0) + '亿' : '—'}（锚 ${a.f10.netProfit}）| 同比 ${it.f10.yoy != null ? it.f10.yoy.toFixed(1) + '%' : '—'}`);
        if (!roeOk || !npOk) issues++;
      }
      console.log(`${a.name}: dy ${it.dy != null ? it.dy.toFixed(2) + '%' : '—'} | 分位 ${it.pct != null ? it.pct.toFixed(0) : '—'} | TTM ${it.ttm != null ? it.ttm.toFixed(3) : '—'} | 支付率 ${it.payRate != null ? (it.payRate * 100).toFixed(0) + '%' : '—'}`);
      out.items.push(it);
    } catch (e) {
      console.log(`❌ ${a.name}: ${e.message}`); issues++;
    }
  }
  // 漂移告警：与上次对比
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); } catch (e) {}
  if (prev && prev.items && prev.items.length) {
    console.log('\n漂移检测（vs 上次 ' + prev.ranAt + '）：');
    for (const it of out.items) {
      const p = prev.items.find(x => x.code === it.code);
      if (!p) continue;
      const dDy = (it.dy != null && p.dy != null) ? Math.abs(it.dy - p.dy) : 0;
      const dPct = (it.pct != null && p.pct != null) ? Math.abs(it.pct - p.pct) : 0;
      const dTtm = (it.ttm != null && p.ttm != null) ? Math.abs(it.ttm - p.ttm) : 0;
      if (dDy > WARN_PP || dPct > WARN_PP || dTtm > WARN_PP) {
        console.log(`⚠️  ${it.name}: dy ${p.dy != null ? p.dy.toFixed(2) + '→' + it.dy.toFixed(2) : '—'} | 分位 ${p.pct != null ? p.pct.toFixed(0) + '→' + it.pct.toFixed(0) : '—'} | TTM ${p.ttm != null ? p.ttm.toFixed(3) + '→' + it.ttm.toFixed(3) : '—'} —— 漂移超阈值，需人工确认（除息/送转？）`);
      } else {
        console.log(`✅ ${it.name}: 无显著漂移`);
      }
    }
  } else {
    console.log('\n（首次运行，无上次基准，跳过漂移检测）');
  }
  fs.writeFileSync(LAST_FILE, JSON.stringify(out, null, 1), 'utf8');
  console.log(`\n===== 对账结果：${issues ? '❌ ' + issues + ' 项异常' : '✅ 全部通过'} =====`);
  process.exit(issues ? 1 : 0);
})();
