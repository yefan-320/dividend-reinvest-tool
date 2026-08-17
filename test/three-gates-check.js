#!/usr/bin/env node
/* R5 三道闸：① calcLockedTTM 锁定验证 ② 股息率分位 W250 vs W500 差异分布 ③ 250 的 10 年样本时段分布 */
global.window = global;
require('/Users/macbookpro/Documents/dividend-tool/repo/data-layer.js');
const DL = global.window.DL;
const STOCKS = [
  { code: '600036', name: '招商银行', tx: 'sh600036' }, { code: '601398', name: '工商银行', tx: 'sh601398' },
  { code: '600519', name: '贵州茅台', tx: 'sh600519' }, { code: '601318', name: '中国平安', tx: 'sh601318' },
  { code: '600900', name: '长江电力', tx: 'sh600900' }, { code: '000001', name: '平安银行', tx: 'sz000001' },
  { code: '600028', name: '中国石化', tx: 'sh600028' }, { code: '601988', name: '中国银行', tx: 'sh601988' },
  { code: '000651', name: '格力电器', tx: 'sz000651' }, { code: '000333', name: '美的集团', tx: 'sz000333' },
  { code: '600585', name: '海螺水泥', tx: 'sh600585' }, { code: '601088', name: '中国神华', tx: 'sh601088' },
  { code: '601006', name: '大秦铁路', tx: 'sh601006' }, { code: '000895', name: '双汇发展', tx: 'sz000895' },
  { code: '600104', name: '上汽集团', tx: 'sh600104' },
];
async function fetchKlineSina(tx) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tx}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  return JSON.parse(await r.text()).map(x => ({ d: x.day, close: parseFloat(x.close) })).filter(x => x.close > 0);
}
async function fetchDivs(code, tryN = 1) {
  const cols = 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,ASSIGN_PROGRESS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://data.eastmoney.com/', 'Accept': 'application/json, text/plain, */*' } });
  const j = await r.json();
  if (!j.result || !j.result.data) { if (tryN < 4) { await new Promise(r2 => setTimeout(r2, tryN * 3000)); return fetchDivs(code, tryN + 1); } return []; }
  return (j.result.data || []).filter(x => x.EX_DIVIDEND_DATE && (x.ASSIGN_PROGRESS || '').indexOf('实施') >= 0).map(x => ({ ex: x.EX_DIVIDEND_DATE.slice(0, 10), dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10 }));
}
function addDays(dStr, days) { const d = new Date(dStr + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function buyAfterNDiv(klines, divs, buyD, years) {
  const bi = klines.findIndex(x => x.d >= buyD);
  if (bi < 0) return null;
  const bp = klines[bi].close;
  const endD = addDays(buyD, years * 365);
  const ti = klines.findIndex(x => x.d >= endD);
  if (ti < 0) return null;
  let divSum = 0;
  for (const dv of divs) { if (dv.ex && dv.ex >= buyD && dv.ex <= endD) divSum += dv.dps; }
  return (klines[ti].close - bp + divSum) / bp * 100;
}

async function main() {
  const all = [];
  for (const s of STOCKS) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const klines = await fetchKlineSina(s.tx);
      const divs = await fetchDivs(s.code);
      if (!divs.length) { console.log(`⚠️ ${s.name} 分红空`); continue; }
      const km = {}; klines.forEach(x => km[x.d] = x.close);
      all.push({ ...s, klines, divs, km });
      console.log(`✅ ${s.name}`);
    } catch (e) { console.log(`❌ ${s.name}: ${e.message}`); }
  }
  console.log(`\n有效 ${all.length} 只\n`);

  // 闸1：calcLockedTTM 锁定验证——除息日 dy 应等于除息前 TTM/除息前价（无跳变）
  console.log('=== 闸1：除息锁定验证（除息日+次日 dy vs 前一日 dy，应无跳变） ===');
  let jumpCnt = 0, total = 0, maxJump = 0;
  for (const s of all) {
    const locked = DL.calcLockedTTM(s.divs);
    for (const ex of Object.keys(locked)) {
      const i = s.klines.findIndex(x => x.d === ex);
      if (i <= 0 || i >= s.klines.length - 1) continue;
      const dyPrev = locked[s.klines[i - 1].d] ? locked[s.klines[i - 1].d].lockedDps / s.klines[i - 1].close * 100
        : (() => { let t = 0; const dv = s.divs.filter(x => x.ex < s.klines[i - 1].d).slice(-6); dv.forEach(d => t += d.dps); return t / s.klines[i - 1].close * 100; })();
      const dyEx = locked[ex].lockedDps / s.klines[i - 1].close * 100;   // 除息日用除息前价（无跳变理想）
      const jump = Math.abs(dyEx - dyPrev);
      total++;
      if (jump > 0.5) { jumpCnt++; maxJump = Math.max(maxJump, jump); }
    }
  }
  console.log(`除息日+次日样本 ${total}，dy 跳变>0.5pp 的 ${jumpCnt}（${(jumpCnt / total * 100).toFixed(1)}%），最大跳变 ${maxJump.toFixed(2)}pp`);

  // 闸2：股息率分位 W250 vs W500 当前分位差异分布
  console.log('\n=== 闸2：股息率分位 W250 vs W500 差异（决定敏感度标注去留） ===');
  const gaps = [];
  for (const s of all) {
    const s250 = DL.calcRollingPercentile(s.km, s.divs, 250);
    const s500 = DL.calcRollingPercentile(s.km, s.divs, 500);
    for (let i = 0; i < s250.length; i++) {
      const a = s250[i].pct, b = s500[i].pct;
      if (a != null && b != null) gaps.push(Math.abs(a - b));
    }
  }
  const med = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const over25 = gaps.filter(x => x > 25).length;
  const over15 = gaps.filter(x => x > 15).length;
  console.log(`W250 vs W500 分位差：中位 ${med.toFixed(1)}pp，>15pp 占 ${(over15 / gaps.length * 100).toFixed(1)}%，>25pp 占 ${(over25 / gaps.length * 100).toFixed(1)}%（n=${gaps.length}）`);
  // 当前分位差
  console.log('当前分位差：');
  for (const s of all.slice(0, 8)) {
    const a = DL.calcRollingPercentile(s.km, s.divs, 250), b = DL.calcRollingPercentile(s.km, s.divs, 500);
    const pa = a[a.length - 1].pct, pb = b[b.length - 1].pct;
    console.log(`  ${s.name.padEnd(6)} W250=${pa != null ? pa.toFixed(0) : '—'} W500=${pb != null ? pb.toFixed(0) : '—'} 差=${pa != null && pb != null ? Math.abs(pa - pb).toFixed(0) : '—'}pp`);
  }

  // 闸3：250 的 10 年样本时段分布
  console.log('\n=== 闸3：W250 10年样本买入年份分布 ===');
  const yDist = {};
  for (const s of all) {
    const ser = DL.calcRollingPercentile(s.km, s.divs, 250);
    for (const ev of DL.findZoneEvents(ser, 80)) {
      const r = buyAfterNDiv(s.klines, s.divs, ev.start, 10);
      if (r != null) yDist[ev.start.slice(0, 4)] = (yDist[ev.start.slice(0, 4)] || 0) + 1;
    }
  }
  const total10 = Object.values(yDist).reduce((s, x) => s + x, 0);
  console.log('年份分布:', Object.entries(yDist).sort((a, b) => a[0] - b[0]).map(([y, n]) => `${y}:${n}(${(n / total10 * 100).toFixed(0)}%)`).join(' '));
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
