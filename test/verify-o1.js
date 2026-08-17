#!/usr/bin/env node
/* O1 补验 v2：curl 拉东财 JSON → 构造 divs → 验证 366 天窗口非闰年无多包 */
const { execSync } = require('child_process');
global.window = global;
require('../data-layer.js');
const DL = global.window.DL;

// 拉招行分红（东财 datacenter，直接 JSON 不带 callback）
const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,PLAN_NOTICE_DATE,NOTICE_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,IT_RATIO,ASSIGN_PROGRESS,IMPL_PLAN_PROFILE,BASIC_EPS,TOTAL_SHARES&pageNumber=1&pageSize=500&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=(SECURITY_CODE%3D%22600036%22)';
let raw;
try { raw = execSync(`curl -s --max-time 20 "${url}"`, { encoding: 'utf8' }); }
catch (e) { console.log('❌ curl 失败:', e.message); process.exit(1); }
let data;
try { data = JSON.parse(raw); } catch (e) { console.log('❌ JSON 解析失败，响应前 200 字:', raw.slice(0, 200)); process.exit(1); }
const rows = (data.result && data.result.data) || [];
if (!rows.length) { console.log('❌ 无数据，响应:', raw.slice(0, 300)); process.exit(1); }

// 构造与 parseDivs 同构的 divs
const divs = rows.map(r => ({
  code: r.SECURITY_CODE || '',
  report: (r.REPORT_DATE || '').slice(0, 10),
  ex: (r.EX_DIVIDEND_DATE || '').slice(0, 10),
  dps: (parseFloat(r.PRETAX_BONUS_RMB) || 0) / 10,
  pending: false,
})).filter(x => x.ex && x.dps > 0).sort((a, b) => a.ex < b.ex ? -1 : 1);

console.log('招行近 6 次派息（ex 升序）:');
divs.slice(-6).forEach(d => console.log(`  ${d.ex} 报告期${d.report} dps=${d.dps.toFixed(3)}`));

const d2021 = divs.find(d => d.ex.startsWith('2021-07'));
const d2022 = divs.find(d => d.ex.startsWith('2022-07'));
const d2020 = divs.find(d => d.ex.startsWith('2020-07'));
if (!d2021 || !d2022 || !d2020) { console.log('❌ 缺 2020-2022 记录'); process.exit(1); }
const gap = (new Date(d2022.ex) - new Date(d2021.ex)) / 86400000;
console.log(`\n2021→2022 派息间隔: ${gap} 天（${gap > 366 ? '闰年间隔' : '非闰年间隔'}）`);

const locked = DL.calcLockedTTM(divs);
const l2022 = locked[d2022.ex];
const l2021 = locked[d2021.ex];
console.log(`2022-${d2022.ex} 锁定 TTM: ${l2022 ? l2022.lockedDps.toFixed(3) : '无'}（预期≈${d2021.dps.toFixed(3)} 恰好1次年度派息）`);
console.log(`2021-${d2021.ex} 锁定 TTM: ${l2021 ? l2021.lockedDps.toFixed(3) : '无'}（预期≈${d2020.dps.toFixed(3)}）`);

const ok1 = l2022 && Math.abs(l2022.lockedDps - d2021.dps) < d2021.dps * 0.01;
const ok2 = l2021 && Math.abs(l2021.lockedDps - d2020.dps) < d2020.dps * 0.01;
const notDouble = l2022 && l2022.lockedDps < (d2021.dps + d2022.dps) * 0.99;
console.log(`\n✅ 2022 锁定=前年度派息: ${ok1}`);
console.log(`✅ 2021 锁定=前年度派息: ${ok2}`);
console.log(`✅ 未多包两次派息: ${notDouble}`);
if (ok1 && ok2 && notDouble) { console.log('\n🎉 O1 补验通过：366 天窗口非闰年无多包'); process.exit(0); }
else { console.log('\n❌ O1 补验失败'); process.exit(1); }
