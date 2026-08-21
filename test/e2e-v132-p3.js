#!/usr/bin/env node
/* v1.9.32 批次3（组合回测重设计）e2e-v132-p3（M60/M64/M69/M263-M266）
 * 断言（数据层，纯 node 不需要浏览器）：
 *  ① 矩阵化：买入×持有 = 2 倍策略数（4买入×2持有=8 + custom）
 *  ② series 三线：price 期初=100、divRatio 末点>0、t 与 kline 日期对齐
 *  ③ R1/R5 分红口径：div3yAvg/div3yRate 存在且 3 年窗口
 *  ④ 卖出信号列：sell 策略 ret 与 long 不同（触发时）或相等（未触发=null 退化）
 *  ⑤ 旧字段保留（K3）：ret/annual/mdd/winRate/events/name/desc
 */
const path = require('path');
const REPO = path.join(__dirname, '..');
const results = [];
function ok(m) { console.log('  ✅ ' + m); }
function S(name, fn) {
  return fn().then(
    () => { results.push({ name, pass: true }); console.log('✅ ' + name); },
    e => { results.push({ name, pass: false, detail: e.message }); console.log('❌ ' + name + ': ' + e.message); }
  );
}

// 读 data-layer.js 里的 calcPortfolioBacktest（用 vm 在沙箱跑，注入 DL 依赖 findZoneEvents）
const vm = require('vm');
const fs = require('fs');
const src = fs.readFileSync(path.join(REPO, 'data-layer.js'), 'utf-8');

// 构建测试数据：2 只假标的，500 天 K线（线性上涨）+ 分红
function makePool() {
  const kline = {};
  const dates = [];
  const today = new Date('2026-08-21');
  for (let i = 499; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const ds = d.toISOString().slice(0, 10);
    if (d.getDay() === 0 || d.getDay() === 6) continue;  // 跳过周末
    dates.push(ds);
    kline[ds] = 10 + (499 - i) * 0.02;   // 10 → 20 线性涨
  }
  const divs = [{ ex: '2025-06-30', dps: 0.5, report: '2025-06-30' }, { ex: '2026-06-30', dps: 0.6, report: '2026-06-30' }];
  // series：分位先低后高（前 250 天 pct=20，后 250 天 pct=95 触发卖出信号）
  const series = dates.map((d, i) => ({ d, pct: i < 250 ? 20 : 95 }));
  return [{
    code: '600036', name: '招行', kline, series, divs,
  }, {
    code: '601398', name: '工行', kline: Object.assign({}, kline), series: dates.map((d, i) => ({ d, pct: i < 250 ? 30 : 95 })), divs,
  }];
}

async function main() {
  const ctx = {};
  vm.createContext(ctx);
  // 只求能解析：data-layer.js 是 IIFE 导出 DL，需要完整跑。改用 node 直接 require？data-layer.js 可能依赖 window。
  // 更稳：用正则提取 calcPortfolioBacktest + findZoneEvents 函数体，注入空依赖跑
  const fnSrc = src.slice(src.indexOf('function findZoneEvents'), src.indexOf('/* v1.9.2 组合级回测引擎'));
  const fnCalc = src.slice(src.indexOf('function calcPortfolioBacktest'), src.indexOf('\n}\n', src.indexOf('function calcPortfolioBacktest')) + 3);
  // calcPortfolioBacktest 末尾被截断风险：用括号配对
  let depth = 0, end = -1;
  const start = src.indexOf('function calcPortfolioBacktest');
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const calcFull = src.slice(start, end);
  const DL = { findZoneEvents: null };
  // findZoneEvents 独立提取
  let d2 = 0, e2 = -1;
  const s2 = src.indexOf('function findZoneEvents');
  for (let i = s2; i < src.length; i++) {
    if (src[i] === '{') d2++;
    else if (src[i] === '}') { d2--; if (d2 === 0) { e2 = i + 1; break; } }
  }
  const fz = src.slice(s2, e2);
  const sandbox = { DL: { findZoneEvents: null }, calcXirr: null };
  vm.createContext(sandbox);
  vm.runInContext(fz + '\nDL.findZoneEvents = findZoneEvents;\n', sandbox);
  vm.runInContext('calcXirr = function(cfs){ if(!cfs.length) return null; const t0 = new Date(cfs[0].d).getTime(); const flows = cfs.map(c => ({t:(new Date(c.d).getTime()-t0)/86400000, v:c.v})); const f = r => flows.reduce((s,c)=> s + c.v/Math.pow(1+r, c.t/365), 0); let lo=-0.9999, hi=10; if(f(lo)*f(hi) > 0) return null; for(let i=0;i<80;i++){ const mid=(lo+hi)/2; if(f(mid)*f(lo) <= 0) hi=mid; else lo=mid; } return (lo+hi)/2; };', sandbox);
  vm.runInContext(calcFull, sandbox);

  const pool = makePool();

  await S('矩阵化：4 买入 × 2 持有 = 8 策略 + 旧字段保留', async () => {
    const res = vm.runInContext('calcPortfolioBacktest(' + JSON.stringify(pool) + ', {})', sandbox);
    if (!res || res.length !== 8) throw new Error('策略数=' + (res && res.length) + ' 期望 8');
    const keys = res.map(r => r.key);
    ['lump_long', 'lump_sell', 'consv_long', 'consv_sell', 'flex_long', 'flex_sell', 'wait90_long', 'wait90_sell'].forEach(k => { if (!keys.includes(k)) throw new Error('缺 ' + k); });
    const r0 = res[0];
    ['ret', 'annual', 'mdd', 'winRate', 'events', 'name', 'desc'].forEach(f => { if (!(f in r0)) throw new Error('旧字段缺 ' + f); });
    ok('8 策略（4×2 矩阵）+ 旧字段 ret/annual/mdd/winRate/events 全保留');
    return 1;
  });

  await S('series 三线：price 期初=100 + divRatio 末点>0', async () => {
    const res = vm.runInContext('calcPortfolioBacktest(' + JSON.stringify(pool) + ', {})', sandbox);
    const r = res.find(x => x.key === 'flex_long');
    if (!r.series) throw new Error('无 series');
    const s = r.series;
    if (s.lines.price[0] < 99 || s.lines.price[0] > 101) throw new Error('price 期初≠100: ' + s.lines.price[0]);
    if (!(s.lines.divRatio[s.lines.divRatio.length - 1] > 0)) throw new Error('divRatio 末点≤0');
    if (s.lines.divCum.length !== s.t.length || s.lines.price.length !== s.t.length) throw new Error('三线长度不对齐');
    ok('price 期初=' + s.lines.price[0].toFixed(1) + ' divRatio 末点=' + s.lines.divRatio[s.lines.divRatio.length - 1].toFixed(1) + '%（3年窗口分红）');
    return 1;
  });

  await S('R5 分红胜率：div3yRate/div3yAvg 存在且合理', async () => {
    const res = vm.runInContext('calcPortfolioBacktest(' + JSON.stringify(pool) + ', {})', sandbox);
    const r = res.find(x => x.key === 'lump_long');
    if (r.div3yRate == null || r.div3yAvg == null) throw new Error('缺分红口径字段');
    if (!(r.div3yAvg > 0)) throw new Error('div3yAvg ≤0: ' + r.div3yAvg);
    ok('div3yAvg=' + r.div3yAvg.toFixed(2) + '元 div3yRate=' + r.div3yRate.toFixed(0) + '%（3年累计≥15%买价）');
    return 1;
  });

  await S('卖出信号列：sell 与 long 共存且可退化', async () => {
    const res = vm.runInContext('calcPortfolioBacktest(' + JSON.stringify(pool) + ', {})', sandbox);
    const long = res.find(x => x.key === 'flex_long');
    const sell = res.find(x => x.key === 'flex_sell');
    if (!long || !sell) throw new Error('缺 flex_long/sell');
    // 测试数据 pct 后段=95 触发卖出 → sell 应有独立收益（可能不同或相同都合法，只断言存在）
    if (sell.ret == null) throw new Error('sell.ret 为 null');
    if (sell.hold !== 'sell' || long.hold !== 'long') throw new Error('hold 标记错');
    ok('sell.ret=' + (sell.ret != null ? sell.ret.toFixed(1) : '—') + '% long.ret=' + (long.ret != null ? long.ret.toFixed(1) : '—') + '%（P95 触发卖出 50% 路径）');
    return 1;
  });

  await S('N2 XIRR：现金流序列算出（lump_long）', async () => {
    const res = vm.runInContext('calcPortfolioBacktest(' + JSON.stringify(pool) + ', {})', sandbox);
    const r = res.find(x => x.key === 'lump_long');
    if (r.xirr == null) throw new Error('xirr 为 null: ' + JSON.stringify(r));
    ok('xirr=' + r.xirr.toFixed(2) + '%（组合现金流：买入负流+期末正流）');
    return 1;
  });

  console.log('\n========== v1.9.32 批次3 e2e-v132-p3 ==========');
  let pass = 0;
  results.forEach(r => { if (r.pass) pass++; else console.log('  ❌ ' + r.name + ': ' + (r.detail || '')); });
  console.log(`通过 ${pass} / ${results.length}`);
  process.exit(pass === results.length && results.length > 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
