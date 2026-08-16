#!/usr/bin/env node
/* v1.7.6 M8 (T11)：送转口径回归单测
 * 样本：南华期货 10转4.5 → bonus=0.45（旧版 bug 算 0.9 翻倍）
 * parseDivs 在 data-layer.js IIFE 内，用括号匹配提取后测试 */
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(__dirname + '/data-layer.js', 'utf8');
// 提取 parseDivs 函数（含内部依赖 parseFloat 等原生，无闭包依赖）
const m = src.match(/function parseDivs\(rows\) \{/);
if (!m) { console.error('找不到 parseDivs'); process.exit(1); }
const start = m.index;
let depth = 0, i = src.indexOf('{', m.index), end = i;
while (i < src.length) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  i++;
}
const fnSrc = src.slice(start, end) + '\nthis.parseDivs = parseDivs;';
const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fnSrc, sandbox);

const assert = (cond, msg) => { if (!cond) { console.error('❌ 断言失败:', msg); process.exitCode = 1; } else console.log('✅', msg); };

// 用例1：纯转增（南华期货回归样本）
const rows = [
  { SECURITY_CODE:'603093', REPORT_DATE:'2025-06-30', EX_DIVIDEND_DATE:'2025-08-12', PRETAX_BONUS_RMB:'0', BONUS_IT_RATIO:'4.5', IT_RATIO:'4.5', ASSIGN_PROGRESS:'实施分配', IMPL_PLAN_PROFILE:'10转4.5' },
  { SECURITY_CODE:'603093', REPORT_DATE:'2024-12-31', EX_DIVIDEND_DATE:'2025-06-10', PRETAX_BONUS_RMB:'30', BONUS_IT_RATIO:'0', IT_RATIO:null, ASSIGN_PROGRESS:'实施分配', IMPL_PLAN_PROFILE:'10派3' },
];
const parsed = sandbox.parseDivs(rows);
assert(parsed.length === 2, '两条记录都被解析');
const zhuan = parsed.find(x => x.bonus > 0);
assert(zhuan && Math.abs(zhuan.bonus - 0.45) < 1e-9, '纯转增 10转4.5 → bonus=0.45（非 0.9，送转口径修复回归）');
assert(zhuan && Math.abs(zhuan.zhuanOnly - 0.45) < 1e-9, 'zhuanOnly=转增部分 0.45');
const pai = parsed.find(x => x.dps > 0);
assert(pai && Math.abs(pai.dps - 3.0) < 1e-9, '10派3 → dps=3.0（PRETAX/10）');

// 用例2：送+转混合（10送2转3 = BONUS_IT_RATIO=5 → bonus=0.5）
const mixed = sandbox.parseDivs([
  { SECURITY_CODE:'600000', REPORT_DATE:'2024-12-31', EX_DIVIDEND_DATE:'2025-07-01', PRETAX_BONUS_RMB:'10', BONUS_IT_RATIO:'5', IT_RATIO:'3', ASSIGN_PROGRESS:'实施分配', IMPL_PLAN_PROFILE:'10送2转3派1' },
]);
assert(mixed[0] && Math.abs(mixed[0].bonus - 0.5) < 1e-9, '10送2转3 → bonus=0.5（送转合计/10）');
assert(mixed[0] && Math.abs(mixed[0].zhuanOnly - 0.3) < 1e-9, '转增部分 0.3');

// 用例3：无除息日的预案记录被过滤（dps/bonus 都 0 或 ex 空）
const pending = sandbox.parseDivs([
  { SECURITY_CODE:'600001', REPORT_DATE:'2025-06-30', EX_DIVIDEND_DATE:'', PRETAX_BONUS_RMB:'20', BONUS_IT_RATIO:'0', IT_RATIO:null, ASSIGN_PROGRESS:'预案', IMPL_PLAN_PROFILE:'10派2' },
]);
assert(pending.filter(x => x.ex).length === 0, '预案记录（无除息日）被过滤');

console.log('\n送转单测完成');
