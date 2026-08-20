/**
 * test/div-cases.js — 口径边界案例单测（2026-08-21 大师裁决 C：6 案例必入）
 *
 * 每次修口径函数（ttmDivsAtMode/splitSpecialDivs/alignSendZhuan）必须 6 案例全绿才准提交。
 * 用法：node test/div-cases.js
 */
'use strict';
const fs = require('fs');
global.window = global;
require('../data-layer.js');
const DL = global.window.DL;

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name); } };

/* 案例1：长期递增股不得误拆特别分红（招行近5年被F4误伤根因） */
{
  const divs = [
    { ex: '2022-07-15', dps: 1.522, report: '2021-12-31' },
    { ex: '2023-07-13', dps: 1.738, report: '2022-12-31' },
    { ex: '2024-07-11', dps: 1.972, report: '2023-12-31' },
    { ex: '2025-07-11', dps: 2.0, report: '2024-12-31' },
    { ex: '2026-01-16', dps: 1.013, report: '2025-06-30' },
    { ex: '2026-07-10', dps: 1.003, report: '2025-12-31' },
  ];
  const split = DL.splitSpecialDivs(divs);
  const spSum = split.reduce((s, d) => s + (d.special || 0), 0);
  ok('案例1 递增股不误拆特别分红', spSum === 0);
}

/* 案例2：特别分红正确拆分（兖矿 2022: 3.07 vs 邻年 ~1.55 → 拆出 special） */
{
  const divs = [
    { ex: '2020-06-20', dps: 0.60, report: '2019-12-31' },
    { ex: '2021-06-25', dps: 1.60, report: '2020-12-31' },
    { ex: '2022-06-28', dps: 1.60, report: '2021-12-31' },
    { ex: '2023-07-17', dps: 3.07, report: '2022-12-31' },
    { ex: '2024-07-10', dps: 1.49, report: '2023-12-31' },
    { ex: '2025-07-08', dps: 0.77, report: '2024-12-31' },
  ];
  const split = DL.splitSpecialDivs(divs);
  const y2022 = split.filter(d => d.report.startsWith('2022'));
  const reg = y2022.reduce((s, d) => s + (d.regular || 0), 0);
  const sp = y2022.reduce((s, d) => s + (d.special || 0), 0);
  ok('案例2 特别分红拆分(reg≈1.2/sp≈1.9)', reg > 1.0 && reg < 1.6 && sp > 1.5 && sp < 2.4);
}

/* 案例3：送转对齐（alignSendZhuan 存在且不抛错） */
{
  try {
    const divs = [{ ex: '2024-05-15', dps: 3.0, report: '2023-12-31', zhuanOnly: 0, bonus: 0 }];
    const out = DL.alignSendZhuan(divs);
    ok('案例3 送转对齐函数可用', Array.isArray(out) && out.length === 1);
  } catch (e) { ok('案例3 送转对齐函数可用', false); }
}

/* 案例4：一年两派合并正确（8/18 招行 TTM 混 1.5 财年根因——B 口径取完整财年） */
{
  const divs = [
    { ex: '2025-07-11', dps: 2.0, report: '2024-12-31' },
    { ex: '2026-01-16', dps: 1.013, report: '2025-06-30' },
    { ex: '2026-07-10', dps: 1.003, report: '2025-12-31' },
  ];
  // 2026-06-24：2025 财年未完全到账 → 应取 2024 财年 2.0
  const r1 = DL.ttmDivsAtMode(divs, '2026-06-24');
  ok('案例4a 一年两派未到账取前财年(2024=2.0)', r1.mode === 'B' && Math.abs(r1.v - 2.0) < 0.01);
  // 2026-07-10：2025 财年全到账 → 取 2025 = 2.016
  const r2 = DL.ttmDivsAtMode(divs, '2026-07-10');
  ok('案例4b 一年两派全到账取最新(2025=2.016)', r2.mode === 'B' && Math.abs(r2.v - 2.016) < 0.01);
}

/* 案例5：未到账分红不计入（宇通 2023-01 13.2% 尖峰根因） */
{
  const divs = [
    { ex: '2022-05-25', dps: 0.5, report: '2021-12-31' },
    { ex: '2023-05-19', dps: 1.0, report: '2022-12-31' },
  ];
  // 2023-01-03：2022 末期未到账 → B 不可用 → A 兜底 366 天 = 0.5
  const r = DL.ttmDivsAtMode(divs, '2023-01-03');
  ok('案例5 未到账不计入(2023-01=0.5非1.5)', r.v < 0.7);
}

/* 案例6：样本不足降级（分红历史<3年 → 不假算特别分红） */
{
  const divs = [
    { ex: '2024-07-11', dps: 1.0, report: '2023-12-31' },
    { ex: '2025-07-11', dps: 2.0, report: '2024-12-31' },
  ];
  const split = DL.splitSpecialDivs(divs);
  const spSum = split.reduce((s, d) => s + (d.special || 0), 0);
  ok('案例6 样本不足不拆特别分红', spSum === 0);
}

console.log(`\n口径单测: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
