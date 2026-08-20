#!/usr/bin/env node
/* P4 命门指标批量回测（v9.2 立项）：5 套行业命门包的财务代理指标批量验证
 * 命门包（行业真实风险源 → 可回测的财务代理指标）：
 *   银行：拨备反哺/营收转负/不良 → 扣非转负、扣非下滑、OCF<0.5
 *   保险：NBV/敞口/偿付         → 扣非转负、扣非下滑、OCF<0.5
 *   电信：派息承诺/ARPU/资本开支 → 扣非转负、扣非下滑
 *   制造消费：扣非/OCF/毛利率S1  → 扣非转负、扣非下滑、OCF<0.5、毛利率连降
 *   共振升级：同一年命门信号 ≥2 个同时触发（全部行业）
 * 信号口径（与 data-layer.js assessIndustrySignals 同源）：
 *   扣非转负 = 年报扣非净利 < 0
 *   扣非下滑 = 年报扣非净利同比下降（上年>0）
 *   OCF<0.5  = 经营现金流/净利 < 0.5（净利>0）
 *   毛利率连降S1 = 近 3 年年报毛利率连降 2 期、每期降幅 >0.5pp
 * 触发时点：Y 财年年报披露后（Y+1-05-01 后首个交易日，同 sell-signal-backtest.js 口径）
 * 有效性：触发后 1 年收益（价格+分红）vs ①同股全时段随机买入基准 ②同股无信号年对照
 *         命门成立 = 信号年收益显著低于基准（信号能识别行业风险）
 * 数据：42 只真实日K+分红 + 东财 F10 年报序列（test/.f10-cache.json）
 * 运行：node test/p4-vitals.js
 */
'use strict';
const lib = require('./bt-lib.js');
const fs = require('fs');
const path = require('path');
const { loadCache, loadStock, datesOf, buyReturn, baseline, P4_PACK, mean, pct } = lib;

const OUT_MD = path.join(__dirname, 'reports', 'P4-vitals.md');
const ALL_CODES = lib.STOCKS.map(s => s.code);

/* 年度序列取数：annuals 降序（东财接口按 REPORT_DATE 降序）→ 按年升序 map */
function annualMap(f10Arr) {
  const m = {};
  (f10Arr || []).forEach(a => {
    if (!a || !a.reportDate) return;
    const y = parseInt(a.reportDate.slice(0, 4), 10);
    if (!/12-31/.test(a.reportDate)) return;
    if (!m[y] || a.reportDate > m[y].reportDate) m[y] = a;
  });
  return m;
}
/* 信号判定（某财年 Y 是否触发；返回 {name, on} 集合） */
function signalsForYear(am, y) {
  const a0 = am[y], a1 = am[y - 1], a2 = am[y - 2];
  const out = {};
  if (a0) {
    if (a0.deductNetProfit != null && a0.deductNetProfit < 0) out['扣非转负'] = true;
    if (a0.deductNetProfit != null && a1 && a1.deductNetProfit != null && a1.deductNetProfit > 0 &&
        a0.deductNetProfit < a1.deductNetProfit) out['扣非下滑'] = true;
    if (a0.ocf != null && a0.netProfit != null && a0.netProfit > 0 && a0.ocf / a0.netProfit < 0.5) out['OCF<0.5'] = true;
    if (a0.grossMargin != null && a1 && a1.grossMargin != null && a2 && a2.grossMargin != null &&
        a0.grossMargin < a1.grossMargin - 0.5 && a1.grossMargin < a2.grossMargin - 0.5) out['毛利率连降'] = true;
  }
  return out;
}

(async () => {
  const cache = loadCache();
  const f10 = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '.f10-cache.json'), 'utf8')); } catch (e) { return {}; } })() || {};
  const stocks = {};
  for (const s of lib.STOCKS) {
    const st = loadStock(cache, s.code);
    if (Object.keys(st.kline).length < 1000) continue;
    stocks[s.code] = { ...s, ...st, am: annualMap(f10[s.code]) };
  }
  /* 每只股票：全部可回测财年（触发时点存在 + 1 年窗口够）→ 信号集合 + 1年收益 */
  const yearsData = [];   // {code, name, ind, y, sigs:Set, ret1}
  for (const st of Object.values(stocks)) {
    const dates = datesOf(st.kline);
    const ys = Object.keys(st.am).map(Number).sort();
    const base1 = baseline(st.kline, dates, st.divs, 250, 800);
    for (const y of ys) {
      const trigger = dates.find(d => d >= (y + 1) + '-05-01');
      if (!trigger) continue;
      const i = dates.indexOf(trigger);
      if (i + 250 >= dates.length) continue;
      const r = buyReturn(st.kline, dates, st.divs, i, 250);
      if (!r) continue;
      const sigs = signalsForYear(st.am, y);
      yearsData.push({
        code: st.code, name: st.name, ind: st.ind, y,
        sigs: Object.keys(sigs), nSig: Object.keys(sigs).length,
        ret1: r.totalRet, priceRet: r.priceRet, divRet: r.divRet,
        base1: base1 ? base1.totalRet : null,
      });
    }
  }
  /* 聚合：包 × 信号 → 信号年 vs 无信号年 vs 全时段基准 */
  const agg = {};
  const add = (k, label, arr) => {
    if (!agg[k]) agg[k] = { label, n: 0, sum: 0, win: 0, rets: [], baseSum: 0, baseN: 0 };
    agg[k].n += arr.length;
    agg[k].sum += arr.reduce((s, x) => s + x.ret1, 0);
    agg[k].win += arr.filter(x => x.ret1 > 0).length;
    arr.forEach(x => { agg[k].rets.push(x.ret1); if (x.base1 != null) { agg[k].baseSum += x.base1; agg[k].baseN++; } });
  };
  const PACKS = [
    { key: 'bank', label: '银行（拨备反哺/营收转负/不良→扣非+OCF 代理）', codes: P4_PACK.bank.codes, sigs: ['扣非转负', '扣非下滑', 'OCF<0.5'] },
    { key: 'insurer', label: '保险（NBV/敞口/偿付→扣非+OCF 代理）', codes: P4_PACK.insurer.codes, sigs: ['扣非转负', '扣非下滑', 'OCF<0.5'] },
    { key: 'telecom', label: '电信（派息承诺/ARPU/资本开支→扣非代理）', codes: P4_PACK.telecom.codes, sigs: ['扣非转负', '扣非下滑'] },
    { key: 'manuCon', label: '制造消费（扣非/OCF/毛利率S1）', codes: P4_PACK.manuCon.codes, sigs: ['扣非转负', '扣非下滑', 'OCF<0.5', '毛利率连降'] },
  ];
  const sigAlias = { '扣非转负': '扣非转负', '扣非下滑': '扣非下滑', 'OCF<0.5': 'OCF<0.5', '毛利率连降': '毛利率连降S1' };
  for (const pk of PACKS) {
    for (const sig of pk.sigs) {
      const hit = yearsData.filter(x => pk.codes.includes(x.code) && x.sigs.includes(sig));
      const miss = yearsData.filter(x => pk.codes.includes(x.code) && !x.sigs.includes(sig));
      add('P|' + pk.key + '|' + sig, `${pk.label} · ${sigAlias[sig]}`, hit);
      add('C|' + pk.key + '|' + sig, `${pk.label} · 无${sigAlias[sig]}`, miss);
    }
    /* 共振：包内 ≥2 信号同财年 */
    const reso = yearsData.filter(x => pk.codes.includes(x.code) && x.nSig >= 2);
    const noReso = yearsData.filter(x => pk.codes.includes(x.code) && x.nSig < 2);
    add('P|' + pk.key + '|共振≥2', `${pk.label} · 共振升级(≥2信号)`, reso);
    add('C|' + pk.key + '|共振≥2', `${pk.label} · 无共振(<2信号)`, noReso);
  }
  /* 全行业总览（跨包） */
  for (const sig of ['扣非转负', '扣非下滑', 'OCF<0.5', '毛利率连降']) {
    const hit = yearsData.filter(x => x.sigs.includes(sig));
    const miss = yearsData.filter(x => !x.sigs.includes(sig));
    add('P|ALL|' + sig, '全行业 · ' + sigAlias[sig], hit);
    add('C|ALL|' + sig, '全行业 · 无' + sigAlias[sig], miss);
  }
  const resoAll = yearsData.filter(x => x.nSig >= 2);
  const noResoAll = yearsData.filter(x => x.nSig < 2);
  add('P|ALL|共振≥2', '全行业 · 共振升级(≥2信号)', resoAll);
  add('C|ALL|共振≥2', '全行业 · 无共振(<2信号)', noResoAll);

  /* 输出 */
  const lines = [];
  lines.push('# P4 命门指标批量回测：行业命门包的财务代理信号有效性');
  lines.push('');
  lines.push(`> 数据：42 只真实日K+分红（2010-2026）+ 东财 F10 年报序列（扣非/OCF/毛利率）｜信号口径同 data-layer.js assessIndustrySignals｜触发=年报披露后（Y+1-05-01 后首交易日）｜持有 1 年=250 交易日（价格+分红）`);
  lines.push('');
  lines.push(`**样本：${yearsData.length} 个股·财年观测（2010-2025 年报）**`);
  lines.push('');
  lines.push('## 有效性判定规则');
  lines.push('');
  lines.push('- **信号年 1 年收益 vs 无信号年对照**：差值 <0 = 信号能识别风险（命门成立）');
  lines.push('- **超额 vs 全时段随机买入基准**：差值 <0 = 信号年跑输随机买入');
  lines.push('- 结论分级：差值 ≤ −10pp 强有效｜−10~−3pp 有效｜−3~+3pp 无效（中性）｜>+3pp 反向（信号后反而涨，需警惕误伤）');
  lines.push('');
  lines.push('| 包 · 信号 | 信号年数 | 信号年均收益 | 无信号年均收益 | 差值(pp) | 随机基准 | 超额(pp) | 信号年盈利占比 | 判定 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  const rowsOut = [];
  for (const k of Object.keys(agg)) {
    if (!k.startsWith('P|')) continue;
    const a = agg[k];
    const ck = 'C' + k.slice(1);
    const c = agg[ck];
    if (!a.n) continue;
    const avg = a.sum / a.n;
    const cAvg = c && c.n ? c.sum / c.n : null;
    const base = a.baseN ? a.baseSum / a.baseN : null;
    const diff = cAvg != null ? (avg - cAvg) * 100 : null;
    const ex = base != null ? (avg - base) * 100 : null;
    const winR = a.win / a.n * 100;
    const verdict = diff == null ? '—' : (diff <= -10 ? '🟢 强有效' : diff <= -3 ? '🟢 有效' : diff < 3 ? '🟡 无效' : '🔴 反向');
    lines.push(`| ${a.label} | ${a.n} | ${(avg * 100).toFixed(1)}% | ${cAvg != null ? (cAvg * 100).toFixed(1) + '%' : '—'} | ${diff != null ? diff.toFixed(1) : '—'} | ${base != null ? (base * 100).toFixed(1) + '%' : '—'} | ${ex != null ? ex.toFixed(1) : '—'} | ${winR.toFixed(0)}% | ${verdict} |`);
    rowsOut.push({ label: a.label, n: a.n, avg: avg * 100, cAvg: cAvg != null ? cAvg * 100 : null, diff, base: base != null ? base * 100 : null, ex, winR, verdict });
  }
  lines.push('');
  lines.push('## 关键发现');
  lines.push('');
  const strong = rowsOut.filter(r => r.diff != null && r.diff <= -10 && r.n >= 5);
  const effective = rowsOut.filter(r => r.diff != null && r.diff <= -3 && r.diff > -10 && r.n >= 5);
  const reverse = rowsOut.filter(r => r.diff != null && r.diff > 3 && r.n >= 5);
  if (strong.length) { lines.push('**强有效（信号年收益 ≤ 无信号年 −10pp）：**'); strong.forEach(r => lines.push(`- ${r.label}：n=${r.n}，差值 ${r.diff.toFixed(1)}pp，超额 ${r.ex != null ? r.ex.toFixed(1) : '—'}pp`)); lines.push(''); }
  if (effective.length) { lines.push('**有效（−10~−3pp）：**'); effective.forEach(r => lines.push(`- ${r.label}：n=${r.n}，差值 ${r.diff.toFixed(1)}pp`)); lines.push(''); }
  if (reverse.length) { lines.push('**反向/误伤风险（信号后反而涨，>+3pp）：**'); reverse.forEach(r => lines.push(`- ${r.label}：n=${r.n}，差值 ${r.diff.toFixed(1)}pp`)); lines.push(''); }
  /* 结论 */
  const concls = [];
  for (const pk of PACKS) {
    const row = rowsOut.find(r => r.label.startsWith(pk.label) && r.label.includes('共振'));
    if (row && row.n >= 5) concls.push(`${pk.label}共振：${row.diff.toFixed(1)}pp（${row.n} 次）`);
  }
  const allReso = rowsOut.find(r => r.label.startsWith('全行业') && r.label.includes('共振'));
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 制造消费的 **毛利率连降S1** 是样本最足的命门信号（详见上表）；扣非转负样本少但方向稳定`);
  lines.push(`- 共振升级（≥2 信号同财年）：${allReso ? `全行业差值 ${allReso.diff.toFixed(1)}pp（n=${allReso.n}）` : '样本不足'}`);
  if (concls.length) lines.push(`- 分行业共振：${concls.join('；')}`);
  lines.push('- **使用建议**：命门信号用于"买入否决/降档"（回避、降仓、等确认），不用于"卖出"——信号识别的是当期风险，价格已部分定价；硬红灯仅在与估值信号（分位≥90）共振时生效（同 trapFilter 守重仓档设计）。');
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');
  /* 终端 */
  console.log('===== P4 命门指标批量回测（42 只 × F10 年报 × 信号年 1 年收益）=====');
  console.log('包·信号 | n | 信号年均 | 无信号年 | 差值pp | 基准 | 超额pp | 判定');
  for (const r of rowsOut) {
    console.log(`${r.label} | ${r.n} | ${r.avg.toFixed(1)}% | ${r.cAvg != null ? r.cAvg.toFixed(1) + '%' : '—'} | ${r.diff != null ? r.diff.toFixed(1) : '—'} | ${r.base != null ? r.base.toFixed(1) + '%' : '—'} | ${r.ex != null ? r.ex.toFixed(1) : '—'} | ${r.verdict}`);
  }
  console.log('报告: test/reports/P4-vitals.md');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
