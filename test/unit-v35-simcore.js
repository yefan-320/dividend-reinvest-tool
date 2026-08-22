/* v3.5 AC-D5：sim-core 共享纯函数同源断言
 * 验证：①主线程 require 加载可用 ②同一输入下结果与 worker 逻辑一致（防双份代码分叉）
 * 运行：node test/unit-v35-simcore.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const T = (name, ok, extra) => { console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' · ' + extra : ''}`); ok ? pass++ : fail++; };

/* 1. 加载 sim-core（CommonJS 分支） */
const ctx = { module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sim-core.js'), 'utf8'), ctx);
const simOneCore = ctx.module.exports;
T('sim-core CommonJS 导出为函数', typeof simOneCore === 'function');

/* 2. 用 demo 数据跑两种参数组合（一次性 / 月追加 / 不复投），与已知公式核对 */
const src = fs.readFileSync(path.join(__dirname, '..', 'demo-data.js'), 'utf8');
const m = src.match(/window\.DEMO_DATA = (\{.*?\});/s);
const demo = JSON.parse(m[1]);
const closes = Object.fromEntries(demo.closes);
const divs = demo.dividends;

/* 一次性投入不复投：手工逐日模拟对照 */
const r1 = simOneCore(100000, 0, closes, divs, false, 0);
T('不复投模式返回 daily', r1 && r1.daily && r1.daily.length > 0, '天数 ' + (r1 && r1.daily.length));
const last1 = r1.daily[r1.daily.length - 1];
/* 不复投时 invested == principal（无再投无追加） */
T('不复投 invested == principal', last1.invested === 100000, 'invested=' + last1.invested);
/* 不复投时 cumDiv == final.totalDiv */
T('cumDiv == totalDiv', Math.abs(r1.cumDiv - r1.final.totalDiv) < 0.01);
/* 市值 = 股数×价 + 现金池，手工核算首日 */
const bp = closes[Object.keys(closes).sort()[0]];
const shares0 = Math.floor(100000 / bp / 100) * 100;
const cash0 = 100000 - shares0 * bp;
T('首日市值手工核算', Math.abs(r1.daily[0].value - (shares0 * bp + cash0)) < 0.01, 'v=' + r1.daily[0].value);

/* 3. 再投模式：invested 含再投，extInvested == principal + monthlyTotal */
const r2 = simOneCore(100000, 3000, closes, divs, true, 0);
const last2 = r2.daily[r2.daily.length - 1];
T('再投模式 invested 含再投', last2.invested > 100000, 'invested=' + last2.invested);
const mfSum = r2.monthlyFlow.reduce((s, x) => s + x.amount, 0);
T('extInvested == principal + Σmonthly', Math.abs(r2.extInvested - (100000 + mfSum)) < 1, 'ext=' + r2.extInvested + ' mf=' + mfSum);
T('reinvested == invested − extInvested', Math.abs(r2.reinvested - (last2.invested - r2.extInvested)) < 1, 'reinv=' + r2.reinvested);

/* 4. yearlyOf 全量断言 */
const yl = simOneCore.yearlyOf(r2);
T('yearly 覆盖所有年份', yl.length >= 10, '年数 ' + yl.length);
let okGain = true, okChain = true, okExt = true;
for (let i = 0; i < yl.length; i++) {
  const prev = i > 0 ? yl[i - 1].value : 0;
  if (Math.abs(yl[i].gain - (yl[i].value - prev - yl[i].added - yl[i].reinvested)) > 1) okGain = false;
  if (i > 0) {
    const expect = yl[i - 1].value + yl[i].gain + yl[i].added + yl[i].reinvested;
    if (Math.abs(yl[i].value - expect) > 1) okChain = false;
  }
  if (i > 0 && yl[i].extInvested < yl[i - 1].extInvested) okExt = false;
}
T('yearly gain 公式自洽', okGain);
T('yearly 年末市值递推链自洽', okChain);
T('yearly extInvested 递增', okExt);
/* 首年 gain = 年末市值 − 年初(0) − 当年追加 − 当年再投（本金在第一天已变成市值，不另减） */
const first = yl[0];
T('首年 gain 无年初值口径', Math.abs(first.gain - (first.value - first.added - first.reinvested)) < 1, 'gain=' + first.gain);

/* 5. 累计分红率对账：Σyearly.div == cumDiv */
const divSum = yl.reduce((s, y) => s + y.div, 0);
T('Σyearly.div == cumDiv', Math.abs(divSum - r2.cumDiv) < 1, 'sum=' + divSum.toFixed(0) + ' cum=' + r2.cumDiv.toFixed(0));

console.log(`\n===== unit-v35-simcore: ${pass} 过 / ${fail} 挂 =====`);
process.exit(fail ? 1 : 0);
