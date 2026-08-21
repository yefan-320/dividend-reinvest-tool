#!/usr/bin/env node
/* v1.9.5 单测：ttmDivsAt 366 窗口重写（大师 A- 边界钉死）
 * 1) 真实招行：2026-01-19 TTM=3.013 / 2026-08-17 TTM=2.016（旧实现 1.013/1.003 断崖）
 * 2) 合成数据：年度→一年两派频率突变，断言无断崖（旧实现腰斩）
 * 3) 回退语义：派息日漂移 >366 天空窗，回退=窗口左边界前最近一笔（不是最近一笔） */
global.window = global;
require('../data-layer.js');
const DL = global.window.DL;

let pass = 0, fail = 0;
function T(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

// ===== 1. 真实招行 2026-01-16 起一年两派 =====
// 分红序列（真实：2025-07-11 派 2.00，2026-01-16 派 1.013，2026-07-10 派 1.003）
const zhao = [
  { ex: '2024-07-11', dps: 1.972 },
  { ex: '2025-07-11', dps: 2.000 },
  { ex: '2026-01-16', dps: 1.013 },
  { ex: '2026-07-10', dps: 1.003 },
];
T('招行 2026-01-13：TTM=2.00（中期分红前）', Math.abs(DL.ttmDivsAt(zhao, '2026-01-13') - 2.00) < 1e-9, DL.ttmDivsAt(zhao, '2026-01-13'));
T('招行 2026-01-19：TTM=3.013（2.00+1.013，旧实现断崖成 1.013）', Math.abs(DL.ttmDivsAt(zhao, '2026-01-19') - 3.013) < 1e-9, DL.ttmDivsAt(zhao, '2026-01-19'));
T('招行 2026-08-17：TTM=2.016（1.013+1.003，2.00 已出窗口）', Math.abs(DL.ttmDivsAt(zhao, '2026-08-17') - 2.016) < 1e-9, DL.ttmDivsAt(zhao, '2026-08-17'));
T('招行 2026-07-10 除息日当天不算新笔（窗口右开）', Math.abs(DL.ttmDivsAt(zhao, '2026-07-10') - 3.013) < 1e-9, DL.ttmDivsAt(zhao, '2026-07-10'));

// ===== 2. 合成：年度派息 → 一年两派突变（无断崖） =====
// 2020-2024 每年 7 月派 1.0；2025-07 派 1.0；2026-01 起半年派（2026-01-15 派 0.5）
const synth = [
  { ex: '2021-07-10', dps: 1.0 }, { ex: '2022-07-08', dps: 1.0 },
  { ex: '2023-07-12', dps: 1.0 }, { ex: '2024-07-10', dps: 1.0 },
  { ex: '2025-07-11', dps: 1.0 }, { ex: '2026-01-15', dps: 0.5 },
];
// 2025-12-01：TTM 应为 1.0（2024-07 已出窗口）
T('合成 2025-12-01：TTM=1.0（旧年度频率）', Math.abs(DL.ttmDivsAt(synth, '2025-12-01') - 1.0) < 1e-9, DL.ttmDivsAt(synth, '2025-12-01'));
// 2026-01-20：TTM 应为 1.5（1.0+0.5，旧实现只算 0.5 断崖）
T('合成 2026-01-20：TTM=1.5（频率突变无断崖）', Math.abs(DL.ttmDivsAt(synth, '2026-01-20') - 1.5) < 1e-9, DL.ttmDivsAt(synth, '2026-01-20'));
// 2026-06-01：TTM 仍 1.5
T('合成 2026-06-01：TTM=1.5', Math.abs(DL.ttmDivsAt(synth, '2026-06-01') - 1.5) < 1e-9, DL.ttmDivsAt(synth, '2026-06-01'));
// 2026-08-01：2025-07-11 出窗口（>366 天）→ TTM=0.5
T('合成 2026-08-01：TTM=0.5（2025-07 出窗）', Math.abs(DL.ttmDivsAt(synth, '2026-08-01') - 0.5) < 1e-9, DL.ttmDivsAt(synth, '2026-08-01'));

// ===== 3. 回退语义：派息日漂移 >366 天空窗 =====
// 每年 7 月派 1.0，某年推迟 400 天（2025 年 7 月无派息，2026-08-15 才派）
const drift = [
  { ex: '2022-07-10', dps: 1.0 }, { ex: '2023-07-12', dps: 1.0 },
  { ex: '2024-07-10', dps: 1.0 }, { ex: '2026-08-15', dps: 1.0 },  // 跳过 2025 年度（漂移 400 天）
];
// 2026-08-01：窗口 [2025-07-31, 2026-08-01) 为空（2026-08-15 未到，2024-07-10 出窗）
// 正确回退 = 窗口左边界前最近一笔 = 2024-07-10 的 1.0（旧频率最后一笔）
T('漂移空窗 2026-08-01：回退=左边界前最近一笔 1.0', Math.abs(DL.ttmDivsAt(drift, '2026-08-01') - 1.0) < 1e-9, DL.ttmDivsAt(drift, '2026-08-01'));
// 2026-08-20：窗口 [2025-08-19, 2026-08-20) 含 2026-08-15 → 1.0（正常窗口值，非回退）
T('漂移后 2026-08-20：窗口值 1.0（新笔进窗）', Math.abs(DL.ttmDivsAt(drift, '2026-08-20') - 1.0) < 1e-9, DL.ttmDivsAt(drift, '2026-08-20'));
// 2024-07-10 除息次日锁定值 = 除息前 TTM（2023-07-12 那笔，窗口 [2023-07-11, 2024-07-10) 空 → 回退 2023-07-12 的 1.0）
const locked = DL.calcLockedTTM(drift);
T('calcLockedTTM 除息前 TTM 正确（2024-07-10 锁定=1.0）', Math.abs((locked['2024-07-10'] || {}).lockedDps - 1.0) < 1e-9, JSON.stringify(locked['2024-07-10']));

// ===== 4. 去平滑 + 报告期口径（v1.9.35 主人拍板：决策信号改纯报告期，去 A 兜底） =====
const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const kline2 = {};
const end = new Date('2026-01-20');
for (let i = 299; i >= 0; i--) { const d = new Date(end); d.setDate(d.getDate() - i); kline2[fmt(d)] = 40; }
kline2['2026-01-16'] = 38.55;   // 除息日（1.013 派息）
kline2['2026-01-19'] = 38.6;
kline2['2026-01-20'] = 38.5;
// 带 report 字段的招行数据（2026-01-20 时点：2025 财年未全公告 → 用 2024 财年 2.0）
const zhaoRep = [
  { ex: '2024-07-11', report: '2023-12-31', dps: 1.972 },
  { ex: '2025-07-11', report: '2024-12-31', dps: 2.000 },
  { ex: '2026-01-16', report: '2025-06-30', dps: 1.013 },
  { ex: '2026-07-10', report: '2025-12-31', dps: 1.003 },
];
const s2 = DL.calcRollingPercentile(kline2, zhaoRep, 375);
const last2 = s2[s2.length - 1];
T('去平滑：输出无 dyS 字段（平滑已删）', last2.dyS === undefined, JSON.stringify(last2));
T('报告期口径：末点 dy=最近已公告完整财年÷价（2.0/38.5=5.19%，非 366 窗口 3.013）', Math.abs(last2.dy - 2.0 / 38.5 * 100) < 0.02, last2.dy.toFixed(2));
const ex16 = s2.find(x => x.d === '2026-01-16');
T('报告期口径：除息日无窗口翻倍假象（2.0/38.55=5.19%，非 3.013/38.55）', ex16 && Math.abs(ex16.dy - 2.0 / 38.55 * 100) < 0.02, ex16 && ex16.dy.toFixed(2));
T('去平滑：末点分位非空且 0-100', last2.pct != null && last2.pct >= 0 && last2.pct <= 100, last2.pct);

// ===== 5. 报告期口径新增单测（2026-08-21 主人拍板 + 大师 M284-M311） =====
// 5a. 空窗期：年报未公告时用上年财年（latestAnnouncedYear + reportYearDivAt 往前找）
const gapDivs = [
  { ex: '2024-07-11', report: '2023-12-31', dps: 1.972, planNotice: '2024-03-26' },
  { ex: '2025-07-11', report: '2024-12-31', dps: 2.000, planNotice: '2025-03-26' },
  // 2025 财年有中期（2026-01-16 派 1.013）但年报未公告 → 空窗
  { ex: '2026-01-16', report: '2025-06-30', dps: 1.013, planNotice: '2025-12-30' },
];
T('空窗期：2026-03-01 最近已公告财年=2024（年报未出）', DL.latestAnnouncedYear(gapDivs, '2026-03-01') === 2024, String(DL.latestAnnouncedYear(gapDivs, '2026-03-01')));
T('空窗期：reportYearDivAt 用 2024 财年 2.0（非 2025 中期 1.013）', Math.abs(DL.reportYearDivAt(gapDivs, '2026-03-01') - 2.0) < 1e-9, DL.reportYearDivAt(gapDivs, '2026-03-01'));
T('空窗期：2026-04-01 年报公告后（planNotice=2026-03-31 假想）用 2025 财年', (() => {
  const d2 = gapDivs.concat([{ ex: '2026-07-10', report: '2025-12-31', dps: 1.003, planNotice: '2026-03-31' }]);
  return Math.abs(DL.reportYearDivAt(d2, '2026-04-01') - (1.013 + 1.003)) < 1e-9;
})(), String(DL.reportYearDivAt(gapDivs.concat([{ ex: '2026-07-10', report: '2025-12-31', dps: 1.003, planNotice: '2026-03-31' }]), '2026-04-01')));
// 5b. 决策链路：calcRollingPercentile 用报告期（非 ttmDivsAt A 兜底）——除息日无窗口翻倍假象（已在上方测）
// 5c. 一年多派：报告期分子=财年归属，不随 366 天窗口滑入滑出（宇通案例）
const yutong = [
  { ex: '2024-05-16', report: '2023-12-31', dps: 1.5, planNotice: '2024-04-02' },
  { ex: '2024-12-05', report: '2024-09-30', dps: 0.5, planNotice: '2024-10-29' },
  { ex: '2025-05-14', report: '2024-12-31', dps: 1.0, planNotice: '2025-04-01' },
  { ex: '2025-09-11', report: '2025-06-30', dps: 0.5, planNotice: '2025-08-26' },
  { ex: '2026-05-15', report: '2025-12-31', dps: 2.0, planNotice: '2026-03-31' },
];
T('宇通一年多派：2026-04-01（2025年报公告后）分子=2.5（2025财年 0.5+2.0）', Math.abs(DL.reportYearDivAt(yutong, '2026-04-01') - 2.5) < 1e-9, DL.reportYearDivAt(yutong, '2026-04-01'));
T('宇通一年多派：2025-05-15（2024财年已公告）分子=1.5（1.0+0.5）不混 2025 中期', Math.abs(DL.reportYearDivAt(yutong, '2025-05-15') - 1.5) < 1e-9, DL.reportYearDivAt(yutong, '2025-05-15'));
T('宇通一年多派：2025-10-01（2025中报已派）分子仍=1.5（财年归属未变）', Math.abs(DL.reportYearDivAt(yutong, '2025-10-01') - 1.5) < 1e-9, DL.reportYearDivAt(yutong, '2025-10-01'));
// 5d. 储备年数 max 防虚高（M295）：报告期 dps < 年化 dps 时取大值（views.js 1930 逻辑）
const maxDivs = [
  { ex: '2024-07-11', report: '2023-12-31', dps: 2.0, planNotice: '2024-03-26' },
  { ex: '2025-07-11', report: '2024-12-31', dps: 2.0, planNotice: '2025-03-26' },
  { ex: '2026-01-16', report: '2025-06-30', dps: 1.0, planNotice: '2025-12-30' },
];
T('储备年数 max 防虚高：报告期(2024=2.0) vs 年化(近2财年(2.0+1.0)/2=1.5) → 取 2.0', (() => {
  const repDps = DL.reportYearDivAt(maxDivs, '2026-03-01');
  const ad = DL.calcAnnualDivYield(maxDivs, 40);
  const maxDps = Math.max(repDps, ad.annualDps);
  return maxDps === 2.0;
})(), 'reportYearDivAt 空窗=2024 财年 2.0');

console.log('\n结果:', pass + '/' + (pass + fail), '通过');
process.exit(fail === 0 ? 0 : 1);
