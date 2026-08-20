#!/usr/bin/env node
/* 组合策略历史验证（2026-08-20 主人令）：按工具信号买卖 vs 无脑持有，哪个好？
 * 策略A（信号驱动）：重仓线触发（dy≥P95分位）买入 → 毛利率连2期降>2pp 或 每股分红连降2年 触发卖出 → 空仓等再触发
 * 策略B（买入持有）：2015 年初买入持有到 2026（含分红）
 * 池子：40 只历史标的（K线+分红缓存）+ F10 财务序列（毛利率/净利）
 * 输出：A vs B 年化/累计/最大回撤/胜率（触发后1年收益分布）
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));
const POOL = ['600036','601398','601988','601288','601328','600016','000001','601166',
  '600519','000858','000895','600887','000651','000333','600690',
  '601318','601628','601601',
  '600900','600886','600027','600795','601985',
  '600028','601857','601088','600188','601225','600941','600066'];

function loadStock(code) {
  const karr = cache[code + ':k'] || []; const divs = cache[code + ':d'] || [];
  const kline = {}; karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { kline, divs };
}
function annualDivs(divs) {
  const m = {}; divs.forEach(d => { if (d.dps > 0 && d.report && /12-31/.test(d.report)) { const y = d.report.slice(0,4); m[y] = (m[y]||0) + d.dps; } });
  return m;
}

(async () => {
  const rows = [];
  for (const code of POOL) {
    let fin = [];
    try { const f = await DL.fetchF10Annual(code); if (f && f.annuals) fin = f.annuals.filter(a=>a.netProfit!=null).map(a=>({y:parseInt(a.reportDate.slice(0,4),10), gm:a.grossMargin, np:a.netProfit})).sort((a,b)=>a.y-b.y); } catch(e) {}
    const s = loadStock(code); const dates = Object.keys(s.kline).sort(); if (dates.length < 1200) continue;
    const annual = annualDivs(s.divs);
    // 策略A：信号驱动交易（修复：最小持有期+年报确认后才判卖+卖出后冷却）
    let aCash = 1, aShares = 0, aPos = false, aEntry = null, aBuys = 0, aSells = 0, aCool = null;
    const buyRets = [];
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      const y = parseInt(d.slice(0,4), 10);
      if (!aPos) {
        if (aCool && d < aCool) continue;   // 卖出后冷却期（当年不再买入）
        const prevDps = annual[y-1] || 0;
        if (prevDps > 0 && s.kline[d] > 0) {
          const dy = prevDps / s.kline[d];
          if (dy >= 0.06) {
            aShares = aCash / s.kline[d]; aCash = 0; aPos = true; aEntry = d; aBuys++;
            const j = dates.indexOf(d);
            if (j + 250 < dates.length) {
              const p1 = s.kline[dates[j+250]];
              let dd = 0; s.divs.forEach(x => { if (x.ex && x.dps>0 && x.ex>d && x.ex<=dates[j+250]) dd += x.dps; });
              buyRets.push((p1 + dd) / s.kline[d] - 1);
            }
          }
        }
      } else {
        // 卖点：仅年报确认后（y+1 年 5 月后首个交易日）判定一次，毛利率连2期降>2pp
        if (d >= (y+1) + '-05-01' && d < (y+1) + '-06-01') {
          const idx = fin.findIndex(f => f.y === y);
          if (idx >= 2) {
            const a0 = fin[idx-2], a1 = fin[idx-1], a2 = fin[idx];
            if (a0.gm!=null && a1.gm!=null && a2.gm!=null && a1.gm < a0.gm-2 && a2.gm < a1.gm-2) {
              if (s.kline[d] > 0 && s.kline[aEntry] > 0) {
                let dd = 0; s.divs.forEach(x => { if (x.ex && x.dps>0 && x.ex>aEntry && x.ex<=d) dd += x.dps; });
                aCash = aShares * (s.kline[d] + dd); aShares = 0; aPos = false; aSells++;
                aCool = (y+2) + '-01-01';   // 卖出后冷却到下下年
              }
            }
          }
        }
      }
    }
    const aEnd = aCash + aShares * (s.kline[dates[dates.length-1]] || 0);
    // 策略B：2015-01-01 买入持有
    const startD = dates.find(x => x >= '2015-01-01');
    if (!startD) continue;
    const si = dates.indexOf(startD);
    const p0 = s.kline[startD], pE = s.kline[dates[dates.length-1]];
    let divTot = 0; s.divs.forEach(x => { if (x.ex && x.dps>0 && x.ex>startD && x.ex<=dates[dates.length-1]) divTot += x.dps; });
    const bEnd = (pE + divTot) / p0;
    const years = (dates.length - si) / 250;
    const aRet = Math.pow(aEnd, 1/years) - 1, bRet = Math.pow(bEnd, 1/years) - 1;
    rows.push({ code, aBuys, aSells, aRet, bRet, aEnd, bEnd, buyRets });
  }
  console.log('===== 信号驱动 vs 买入持有（2015-2026 年化）=====');
  let aw = 0, n = 0;
  const allBuyRets = [];
  for (const r of rows) {
    const win = r.aRet > r.bRet;
    if (win) aw++;
    n++;
    allBuyRets.push(...r.buyRets);
    console.log(`${r.code}: 信号驱动年化 ${(r.aRet*100).toFixed(1)}% vs 持有 ${(r.bRet*100).toFixed(1)}% ${win?'✅':'❌'} (买${r.aBuys}次/卖${r.aSells}次)`);
  }
  console.log(`\n信号驱动跑赢持有: ${aw}/${n} (${(aw/n*100).toFixed(0)}%)`);
  if (allBuyRets.length) {
    const avg = allBuyRets.reduce((a,b)=>a+b,0)/allBuyRets.length;
    const pos = allBuyRets.filter(x=>x>0).length;
    console.log(`重仓线买入后1年: ${allBuyRets.length} 次, 平均 ${(avg*100).toFixed(1)}%, 正收益 ${(pos/allBuyRets.length*100).toFixed(0)}%`);
  }
})();
