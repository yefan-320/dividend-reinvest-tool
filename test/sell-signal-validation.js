#!/usr/bin/env node
/* 卖出信号历史回测验证（2026-08-20 主人令）：6 个新卖出信号在历史上触发后，真的跌了吗？
 * 池子：40 只历史标的 + 伊利 + 宇通（F10 财务序列：净利/扣非/毛利率/OCF/ROE）
 * 方法：每只每信号 → 历史触发点（2010-2025）→ 触发后 1/2 年收益（价格+分红）
 *      vs 该股全时段随机买入基准（超额=信号增益）
 * 信号定义（可回测）：
 *  S1 毛利率连续2期下滑>2pp → 减仓
 *  S2 净利增速连续2期<10% → 减仓
 *  S3 OCF含量(OCF/净利)<0.5 连续2年 → 卖出
 *  S4 扣非背离（归母正/扣非负）→ 硬红灯
 *  S5 分红率连续2年下降（复用现有逻辑）
 *  S6 ROE连续下滑≥3年 → 黄灯
 */
global.window = global;
require('/Users/macbookpro/Documents/deepseek/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');
const cache = JSON.parse(fs.readFileSync('/tmp/rule-tree-cache.json', 'utf8'));

const POOL = ['600036','601398','601988','601288','601328','600016','000001','601166',  // 银行
  '600519','000858','000895','600887','000651','000333','600690',  // 消费
  '601318','601628','601601',  // 保险
  '600900','600886','600027','600795','601985',  // 公用
  '600028','601857','601088','600188','601225',  // 能源
  '600941', '600066'];  // 电信+宇通

function loadStock(code) {
  const karr = cache[code + ':k'] || []; const divs = cache[code + ':d'] || [];
  const kline = {}; karr.forEach(x => { const c = parseFloat(x.close); if (c > 0) kline[x.d] = c; });
  return { kline, divs };
}
/* 年度分红（报告期归组） */
function annualDivs(divs) {
  const m = {}; divs.forEach(d => { if (d.dps > 0 && d.report && /12-31/.test(d.report)) { const y = d.report.slice(0,4); m[y] = (m[y]||0) + d.dps; } });
  return m;
}

/* 信号检测：输入财务序列（按年升序）→ 触发年份数组 */
function sigMargin(rows) { // S1 毛利率连续2期下滑>2pp
  const evs = [];
  for (let i = 2; i < rows.length; i++) {
    const a = rows[i-2], b = rows[i-1], c = rows[i];
    if (a.gm != null && b.gm != null && c.gm != null && b.gm < a.gm - 2 && c.gm < b.gm - 2) evs.push(c.y);
  }
  return evs;
}
function sigGrowth(rows) { // S2 净利增速连续2期<10%
  const evs = [];
  for (let i = 3; i < rows.length; i++) {
    const a = rows[i-3], b = rows[i-2], c = rows[i-1], d = rows[i];
    if (a.np != null && b.np != null && c.np != null && d.np != null && a.np > 0 && b.np > 0 && c.np > 0) {
      const g1 = b.np / a.np - 1, g2 = c.np / b.np - 1, g3 = d.np / c.np - 1;
      if (g1 < 0.10 && g2 < 0.10 && g3 < 0.10) evs.push(d.y);
    }
  }
  return evs;
}
function sigOcf(rows) { // S3 OCF含量<0.5 连续2年
  const evs = [];
  for (let i = 2; i < rows.length; i++) {
    const a = rows[i-2], b = rows[i-1], c = rows[i];
    if (a.ocf != null && a.np != null && a.np > 0 && b.ocf != null && b.np != null && b.np > 0 && c.ocf != null && c.np != null && c.np > 0) {
      const r1 = a.ocf / a.np, r2 = b.ocf / b.np, r3 = c.ocf / c.np;
      if (r1 < 0.5 && r2 < 0.5 && r3 < 0.5) evs.push(c.y);
    }
  }
  return evs;
}
function sigDeduct(rows) { // S4 扣非背离（归母正/扣非负）
  const evs = [];
  for (const r of rows) if (r.np != null && r.dd != null && r.np > 0 && r.dd < 0) evs.push(r.y);
  return evs;
}
function sigRoe(rows) { // S6 ROE连续下滑≥3年
  const evs = [];
  for (let i = 3; i < rows.length; i++) {
    const a = rows[i-3], b = rows[i-2], c = rows[i-1], d = rows[i];
    if (a.roe != null && b.roe != null && c.roe != null && d.roe != null) {
      if (d.roe < c.roe && c.roe < b.roe && b.roe < a.roe) evs.push(d.y);
    }
  }
  return evs;
}
function sigPayout(divs) { // S5 分红率连续2年下降（简化：年度每股分红连续下降）
  const m = annualDivs(divs); const ys = Object.keys(m).sort(); const evs = [];
  for (let i = 2; i < ys.length; i++) {
    const a = m[ys[i-2]], b = m[ys[i-1]], c = m[ys[i]];
    if (b < a && c < b) evs.push(parseInt(ys[i], 10));
  }
  return evs;
}

(async () => {
  const sigs = { 'S1毛利率降2pp': sigMargin, 'S2增速<10%三连': sigGrowth, 'S3_OCF含量<0.5三连': sigOcf, 'S4扣非背离': sigDeduct, 'S5每股分红连降2年': sigPayout, 'S6_ROE连降3年': sigRoe };
  const results = {}; Object.keys(sigs).forEach(k => results[k] = { total: 0, hit: 0, ret1: [], ret2: [], base1: [], base2: [] });

  for (const code of POOL) {
    let rows = [];
    try {
      const f = await DL.fetchF10Annual(code);
      if (f && f.annuals) {
        rows = f.annuals.filter(a => a.netProfit != null).map(a => ({
          y: parseInt(a.reportDate.slice(0,4), 10), np: a.netProfit, dd: a.deductNetProfit,
          gm: a.grossMargin, ocf: a.ocf, roe: a.roe,
        })).sort((a,b) => a.y - b.y);
      }
    } catch(e) {}
    if (rows.length < 5) continue;
    const s = loadStock(code); const dates = Object.keys(s.kline).sort(); if (dates.length < 800) continue;
    const base = []; // 全时段随机基准（每半年采样一次收益）
    for (let i = 0; i + 250 < dates.length; i += 250) {
      const p0 = s.kline[dates[i]]; const p1 = s.kline[dates[i+250]]; const p2 = s.kline[dates[i+500]];
      if (p0 > 0 && p1 > 0) base.push(p1 / p0 - 1);
      if (p0 > 0 && p2 > 0) { let d = 0; s.divs.forEach(x => { if (x.ex && x.dps > 0 && x.ex > dates[i] && x.ex <= dates[i+500]) d += x.dps; }); base.push((p2 + d) / p0 - 1); }
    }
    for (const [name, fn] of Object.entries(sigs)) {
      const evs = fn(rows.length ? rows : undefined) || [];
      // S5 用分红数据
      const evs2 = name.startsWith('S5') ? sigPayout(s.divs) : (name.startsWith('S4') ? sigDeduct(rows) : evs);
      for (const y of evs2) {
        const trigger = dates.find(d => d >= (y + 1) + '-05-01');
        if (!trigger) continue;
        const ti = dates.indexOf(trigger); const h1 = ti + 250, h2 = ti + 500;
        if (h1 >= dates.length || h2 >= dates.length) continue;
        const p0 = s.kline[trigger], p1 = s.kline[dates[h1]], p2 = s.kline[dates[h2]];
        if (!(p0 > 0) || !(p1 > 0) || !(p2 > 0)) continue;
        let d1 = 0, d2 = 0;
        s.divs.forEach(d => { if (d.ex && d.dps > 0 && d.ex > trigger && d.ex <= dates[h1]) d1 += d.dps; if (d.ex && d.dps > 0 && d.ex > trigger && d.ex <= dates[h2]) d2 += d.dps; });
        const r1 = (p1 + d1) / p0 - 1, r2 = (p2 + d2) / p0 - 1;
        results[name].total++; results[name].ret1.push(r1); results[name].ret2.push(r2);
        if (r1 < 0) results[name].hit++;
      }
    }
    const b1 = base.filter((_,i) => i % 2 === 0), b2 = base.filter((_,i) => i % 2 === 1);
    for (const name of Object.keys(sigs)) { results[name].base1 = results[name].base1.concat(b1); results[name].base2 = results[name].base2.concat(b2); }
    console.log('done', code);
  }
  const avg = a => a.length ? a.reduce((x,y) => x+y, 0) / a.length : null;
  console.log('\n===== 卖出信号历史验证（触发后 1/2 年表现 vs 基准）=====');
  for (const [name, r] of Object.entries(results)) {
    if (!r.total) { console.log(`${name}: 无触发`); continue; }
    const a1 = avg(r.ret1), a2 = avg(r.ret2), b1 = avg(r.base1), b2 = avg(r.base2);
    console.log(`\n${name}: 触发 ${r.total} 次 | 触发后1年平均 ${(a1*100).toFixed(1)}% vs 基准 ${(b1*100).toFixed(1)}% (超额 ${((a1-b1)*100).toFixed(1)}pp) | 下跌率 ${(r.hit/r.total*100).toFixed(0)}%`);
    console.log(`         触发后2年平均 ${(a2*100).toFixed(1)}% vs 基准 ${(b2*100).toFixed(1)}% (超额 ${((a2-b2)*100).toFixed(1)}pp)`);
  }
})();
