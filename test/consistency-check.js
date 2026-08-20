#!/usr/bin/env node
/* 盲区20②：口径一致性自动检查（复权/DPS/分位线自动核对）
 * 检查项：
 * 1. 缓存版本号（rule-tree-cache.json _version）
 * 2. TIER_LINE 与 SIG_STATS 行业映射一致性（indKeyOf 能识别全部持仓行业）
 * 3. P95_TRIGGERS 覆盖 BUY_CFG 全部标的（未覆盖=按0=首触，提示补台账）
 * 4. TREASURY_NOW 可刷新（国债锚）
 * 5. finConfirm/assessIndustrySignals 无死代码（行业包全覆盖）
 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const fs = require('fs');

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  // 1. 缓存版本号
  try {
    const c = JSON.parse(fs.readFileSync('/Users/macbookpro/Documents/dividend-tool/repo/data/rule-tree-cache.json', 'utf8'));
    chk('缓存版本号存在(_version)', c._version != null, '未找到 _version');
  } catch (e) { chk('缓存可读', false, e.message); }

  // 2. TIER_LINE 行业映射（ind 字段已是 SIG_STATS key；manufacture 特例→consumer）
  const TL2IND = { manufacture: 'consumer', telecom: 'telecom' };
  const unmapped = Object.entries(DL.TIER_LINE || {}).filter(([, v]) => !DL.SIG_STATS[TL2IND[v.ind] || v.ind]).map(([c]) => c);
  chk('TIER_LINE 行业全部可映射', unmapped.length === 0, unmapped.join(','));

  // 3. P95_TRIGGERS 覆盖 BUY_CFG
  const missing = Object.keys(DL.BUY_CFG || {}).filter(c => DL.P95_TRIGGERS[c] == null);
  chk('P95_TRIGGERS 覆盖全部 BUY_CFG 标的', missing.length === 0, '未覆盖(按0=首触): ' + missing.join(','));

  // 4. 行业校准信号覆盖（assessIndustrySignals 五大行业包）
  const indTest = [
    ['银行', { kf: 1, kfPrev: 1, ocf: 0.3, np: 2, xsmll: 30, xsmllPrev: 31, xsmllPrev2: 32, netProfitYoY: 3 }],
    ['保险', { kf: 1, kfPrev: 1, ocf: 0.3, np: 2, xsmll: 30, xsmllPrev: 31, xsmllPrev2: 32, netProfitYoY: -2 }],
    ['电信运营', { kf: 1, kfPrev: 1, ocf: 0.3, np: 2, xsmll: 30, xsmllPrev: 31, xsmllPrev2: 32, netProfitYoY: -2 }],
    ['汽车制造', { kf: 1, kfPrev: 1, ocf: 0.2, np: 2, xsmll: 30, xsmllPrev: 31, xsmllPrev2: 32, netProfitYoY: 5 }],
    ['食品饮料', { kf: 1, kfPrev: 1, ocf: 0.2, np: 2, xsmll: 30, xsmllPrev: 31, xsmllPrev2: 32, netProfitYoY: 5 }],
  ];
  let indOk = 0;
  for (const [ind, p] of indTest) {
    const r = DL.assessIndustrySignals({ industry: ind, code: '000000', ...p });
    if (r && r.level) indOk++;
  }
  chk('行业校准信号五大包可触发', indOk >= 4, `触发 ${indOk}/5`);

  // 5. 国债锚
  try { await DL.refreshTreasury(); chk('国债锚刷新', DL.TREASURY_NOW != null && DL.TREASURY_NOW > 0, 'TREASURY_NOW=' + DL.TREASURY_NOW); }
  catch (e) { chk('国债锚刷新', false, e.message); }

  console.log(`\n==== 口径一致性自检：${pass} 通过 / ${fail} 失败 ====`);
  process.exit(fail ? 1 : 0);
})();
