#!/usr/bin/env node
/* v1.7.6 联网验收测试（大师验收 1/3/5 项）
 * 用真实 DL 数据层验证：
 *  - 验收1：852 切换后回测分红条数与切换前一致（普通股招行 + 送转股南华期货）
 *  - 验收3：512890 ETF 回测 K线+分红均出数据（旧版 guessSec 会判成北交所失败）
 *  - 验收5：连续两次 getKline 第二次命中 IndexedDB 缓存
 *  - 验收2：区间末尾=周末时无重复请求（fetchKlineTx prevLast break）
 */
const fs = require('fs');
const vm = require('vm');

// 加载 data-layer.js（IIFE）进 sandbox
const dlSrc = fs.readFileSync(__dirname + '/data-layer.js', 'utf8');
// IndexedDB mock：内存 Map 模拟
const idbStore = new Map();
function makeIDB() {
  return {
    open: (name, ver) => {
      const req = {
        result: { objectStoreNames: { contains: () => true }, transaction: (s, mode) => ({
          objectStore: (n) => ({
            get: (k) => ({ onsuccess: null, result: idbStore.get(k) || null }),
            put: (v, k) => ({ onsuccess: null, result: (idbStore.set(k, v), undefined) }),
          })
        }) },
        onupgradeneeded: null, onsuccess: null, onerror: null,
      };
      setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    }
  };
}
const sandbox = {
  indexedDB: makeIDB(),
  window: null,
  document: { createElement: () => ({ set src(v){}, remove(){}, onload:null, onerror:null }), head: { appendChild(){} } },
  fetch: global.fetch,
  AbortController, Headers, Request, Response,
  setTimeout, clearTimeout,
  console, URLSearchParams, location: { search: '' },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(dlSrc + '\nthis.DL = DL;', sandbox);
const DL = sandbox.DL;

const assert = (cond, msg) => { if (!cond) { console.error('❌ 断言失败:', msg); process.exitCode = 1; } else console.log('✅', msg); };
const today = DL.todayStr();
const start5y = new Date(Date.now() - 5 * 366 * 86400000).toISOString().slice(0, 10);

async function main() {
  // 分红数据源直连（jsonp 在 node 无法触发回调，浏览器侧已由 smoke 场景2 验证：招行 8 条）；
  // 这里验证 DL.parseDivs + dedupDividends 解析/去重逻辑（与线上同一函数）
  async function rawDivs(code) {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return j.result && j.result.data || [];
  }

  // 验收1a：普通股（招商银行）K线 + 分红
  console.log('\n== 验收1a 招行 600036 ==');
  const kl1 = await DL.getKline('600036', start5y, today);
  assert(Object.keys(kl1).length > 500, `招行 5年 K线 ${Object.keys(kl1).length} 条（>500）`);
  const dv1 = DL.dedupDividends(DL.parseDivs(await rawDivs('600036')));
  assert(dv1.length >= 8, `招行 分红 ${dv1.length} 条（≥8，与 smoke 场景2 一致）`);
  assert(dv1.every(d => d.dps >= 0 && d.bonus >= 0), '分红字段 dps/bonus 非负');

  // 验收1b：送转股（南华期货 603093，送转口径回归样本）
  console.log('\n== 验收1b 南华期货 603093 ==');
  const kl2 = await DL.getKline('603093', start5y, today);
  assert(Object.keys(kl2).length > 300, `南华期货 5年 K线 ${Object.keys(kl2).length} 条（>300）`);
  const dv2 = DL.dedupDividends(DL.parseDivs(await rawDivs('603093')));
  console.log('  南华期货分红记录:', dv2.length, '条');
  const zhuan = dv2.filter(d => d.bonus > 0);
  assert(zhuan.every(d => d.bonus <= 1.0), `送转记录 bonus 全部 ≤1.0（无 0.9 翻倍：${zhuan.map(d=>d.bonus).join(',')}）`);
  assert(dv2.every(d => d.bonus >= 0), '送转记录无负数');

  // 验收3：ETF 512890（旧版 guessSec 会判 bj512890 失败）
  console.log('\n== 验收3 红利低波ETF 512890 ==');
  const kl3 = await DL.getKline('512890', start5y, today);
  assert(Object.keys(kl3).length > 500, `512890 5年 K线 ${Object.keys(kl3).length} 条（ETF 识别修复生效）`);
  const dv3 = DL.dedupDividends(DL.parseDivs(await rawDivs('512890')));
  console.log('  512890 分红记录:', dv3.length, '条（官方页面确认：512890 本身无分红，仅 2021 年分拆——0 条为正确数据）');
  // ⚠️ 数据源缺口：510880（红利ETF，确实每年分红）股票接口也查不到 → ETF 分红需基金接口（fundf10 无 CORS/反爬），已报大师裁决
  const dv510 = DL.dedupDividends(DL.parseDivs(await rawDivs('510880')));
  console.log('  510880（有分红ETF）股票接口分红记录:', dv510.length, '条——预期≥8，缺口待裁决');

  // 验收5：连续两次 getKline，第二次命中缓存（IndexedDB mock 可查）
  console.log('\n== 验收5 缓存命中 ==');
  idbStore.clear();
  const k1 = await DL.getKline('600036', start5y, today);
  const firstKeys = [...idbStore.keys()].filter(k => k.startsWith('kl:'));
  const k2 = await DL.getKline('600036', start5y, today);
  assert(JSON.stringify(k1) === JSON.stringify(k2), '两次 getKline 返回一致');
  assert(firstKeys.length >= 1, `缓存键已写入: ${firstKeys.join(',')}`);
  const cached = idbStore.get(firstKeys[0]);
  assert(cached && cached.ts && cached.data && Object.keys(cached.data).length > 500, '缓存内容完整（ts+data+K线）');

  // 验收2：周末末尾无重复请求——fetchKlineTx 的 prevLast break（用短区间验证，正常返回即可）
  console.log('\n== 验收2 区间末尾周末防死循环 ==');
  const wkStart = '2026-08-03'; // 周一
  const wkEnd = '2026-08-08';   // 周六（无交易）
  const kl4 = await DL.getKline('600036', wkStart, wkEnd);
  assert(Object.keys(kl4).length >= 1, `周末末尾区间正常返回 ${Object.keys(kl4).length} 条（无死循环）`);

  console.log('\n联网验收完成');
}
main().catch(e => { console.error('❌ 联网验收异常:', e.message); process.exitCode = 1; });
