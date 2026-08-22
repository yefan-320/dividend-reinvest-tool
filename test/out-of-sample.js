#!/usr/bin/env node
/* 样本外验证（v3.10+ 选股可信度增强，接手 AI 2026-08-23）
 * 核心问题：全样本线（40只×16年定线又回测）有过拟合嫌疑。
 * 本脚本：前 8 年（2010-2017）数据独立定线 → 后 8 年（2018-2025）用该线触发 → 统计 3 年收益/胜率
 * 输出：每条线（P75小仓/P90加仓/P95重仓）的【样本外真实预测力】vs 全样本线战绩对比
 * 用法：node test/out-of-sample.js [--stocks 5]  （默认全 40 只；--stocks N 只跑前 N 只快速验证）
 */
'use strict';
global.window = global;
require(require('path').join(__dirname, '..', 'data-layer.js'));
const DL = global.window.DL;

const TRAIN_END = '2017-12-31';   // 前 8 年定线
const TEST_START = '2018-01-01';  // 后 8 年验证
const WINDOW = 375;

const STOCKS = [
  { code: '600036', tx: 'sh600036' }, { code: '601398', tx: 'sh601398' }, { code: '601988', tx: 'sh601988' },
  { code: '601288', tx: 'sh601288' }, { code: '601328', tx: 'sh601328' }, { code: '600016', tx: 'sh600016' },
  { code: '000001', tx: 'sz000001' }, { code: '601166', tx: 'sh601166' }, { code: '600519', tx: 'sh600519' },
  { code: '000858', tx: 'sz000858' }, { code: '000895', tx: 'sz000895' }, { code: '600887', tx: 'sh600887' },
  { code: '601318', tx: 'sh601318' }, { code: '601628', tx: 'sh601628' }, { code: '601601', tx: 'sh601601' },
  { code: '600900', tx: 'sh600900' }, { code: '600886', tx: 'sh600886' }, { code: '600027', tx: 'sh600027' },
  { code: '600795', tx: 'sh600795' }, { code: '601985', tx: 'sh601985' }, { code: '600028', tx: 'sh600028' },
  { code: '601857', tx: 'sh601857' }, { code: '601088', tx: 'sh601088' }, { code: '600188', tx: 'sh600188' },
  { code: '601225', tx: 'sh601225' }, { code: '000651', tx: 'sz000651' }, { code: '000333', tx: 'sz000333' },
  { code: '600690', tx: 'sh600690' }, { code: '000100', tx: 'sz000100' }, { code: '600585', tx: 'sh600585' },
  { code: '601668', tx: 'sh601668' }, { code: '601390', tx: 'sh601390' }, { code: '600031', tx: 'sh600031' },
  { code: '601006', tx: 'sh601006' }, { code: '600104', tx: 'sh600104' }, { code: '600019', tx: 'sh600019' },
  { code: '601899', tx: 'sh601899' }, { code: '601600', tx: 'sh601600' }, { code: '600009', tx: 'sh600009' },
  { code: '601111', tx: 'sh601111' },
];

const LIMIT = (() => { const i = process.argv.indexOf('--stocks'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : STOCKS.length; })();
const CACHE_F = '/tmp/oos-cache.json';
const _cache = (() => { try { return JSON.parse(require('fs').readFileSync(CACHE_F, 'utf8')); } catch (e) { return {}; } })();

async function fetchKlineSina(tx) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${tx}&scale=240&ma=no&datalen=4000`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://finance.sina.com.cn/' } });
  const j = await r.json();
  return (Array.isArray(j) ? j : []).map(x => ({ d: x.day, close: parseFloat(x.close) })).filter(x => x.close > 0);
}
async function fetchDivsFull(code) {
  const cols = 'SECURITY_CODE,EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,ASSIGN_PROGRESS,REPORT_DATE,BASIC_EPS';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${cols}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent('(SECURITY_CODE="' + code + '")')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/126.0', 'Referer': 'https://data.eastmoney.com/' } });
  const j = await r.json();
  return ((j && j.result && j.result.data) || []).map(x => ({
    ex: (x.EX_DIVIDEND_DATE || '').slice(0, 10), report: (x.REPORT_DATE || '').slice(0, 10),
    dps: (parseFloat(x.PRETAX_BONUS_RMB) || 0) / 10, pending: !x.EX_DIVIDEND_DATE, bonus: 0,
  })).filter(x => x.ex && x.dps > 0);
}

async function getStockData(st) {
  if (_cache[st.code]) return _cache[st.code];
  try {
    const rows = await fetchKlineSina(st.tx);
    const divs = await fetchDivsFull(st.code);
    if (!rows.length || !divs.length) return null;
    const kline = {};
    rows.forEach(x => { kline[x.d] = x.close; });
    const out = { kline, divs, rows };
    _cache[st.code] = out;
    require('fs').writeFileSync(CACHE_F, JSON.stringify(_cache));
    return out;
  } catch (e) { return null; }
}

(async () => {
  const tierStats = { small: { n: 0, win: 0, sum: 0 }, add: { n: 0, win: 0, sum: 0 }, heavy: { n: 0, win: 0, sum: 0 } };
  const stocks = STOCKS.slice(0, LIMIT);
  for (const st of stocks) {
    const d = await getStockData(st);
    if (!d) { console.log('跳过（无数据）:', st.code); continue; }
    const all = DL.calcRollingPercentile(d.kline, d.divs, WINDOW);
    /* 训练段：2010-2017 的 dy 分布定线（P75/P90/P95 分位数） */
    const train = all.filter(x => x.d >= '2010-01-01' && x.d <= TRAIN_END && x.dy != null).map(x => x.dy).sort((a, b) => a - b);
    if (train.length < 200) { console.log('跳过（训练样本不足）:', st.code, train.length); continue; }
    const q = p => train[Math.floor(train.length * p)];
    const lines = { p75: q(0.75), p90: q(0.90), p95: q(0.95) };
    /* 测试段：2018-2025 逐日触发（dy ≥ 线）→ 3 年收益/胜率（价格+分红，不复投简化） */
    const test = all.filter(x => x.d >= TEST_START && x.dy != null);
    const dates = test.map(x => x.d);
    const keyOf = { p75: 'small', p90: 'add', p95: 'heavy' };
    for (const [lineKey, line] of Object.entries(lines)) {
      const key = keyOf[lineKey];
      let inEvent = false, eventStart = null;
      for (const x of test) {
        const hit = x.dy >= line;
        if (hit && !inEvent) { inEvent = true; eventStart = x.d; }
        if (!hit && inEvent) { inEvent = false; settle(key, eventStart, x.d, dates, all, d); }
      }
      if (inEvent) settle(key, eventStart, dates[dates.length - 1], dates, all, d);
    }
  }
  console.log('\n===== 样本外验证结果（训练 2010-2017 定线 → 测试 2018-2025 触发，3 年持有）=====');
  for (const [key, s] of Object.entries(tierStats)) {
    const label = { small: 'P75 小仓线', add: 'P90 加仓线', heavy: 'P95 重仓线' }[key];
    if (!s.n) { console.log(`${label}: 无事件`); continue; }
    const winRate = s.win / s.n * 100;
    const avg = s.sum / s.n;
    console.log(`${label}: ${s.n} 次事件 | 3 年胜率 ${winRate.toFixed(0)}% | 3 年收益中位/均值 ${avg.toFixed(1)}%`);
  }
  console.log('\n对照：全样本线战绩（rule-stats.json）——strong 74% 胜率/+43%；若样本外明显低于全样本，说明该线有过拟合成分');

  function settle(key, startD, endD, dates, all, d) {
    if (!startD || !endD) return;
    const s = tierStats[key];
    const idx = dates.indexOf(startD);
    const idxEnd = dates.indexOf(endD);
    if (idx < 0 || idxEnd < 0) return;
    /* 3 年后价格 */
    const kdates = Object.keys(d.kline).sort();
    const buyIdx = kdates.indexOf(startD);
    const hold3 = kdates[buyIdx + 750];
    if (!hold3 || !(d.kline[hold3] > 0)) return;
    const buyP = d.kline[startD];
    if (!(buyP > 0)) return;
    /* 期间分红累计（简化：每股分红×1 股，不算复投） */
    const divSum = d.divs.filter(x => !x.pending && x.ex >= startD && x.ex <= hold3).reduce((t, x) => t + x.dps, 0);
    const ret = (d.kline[hold3] + divSum) / buyP - 1;
    s.n++;
    if (ret > 0) s.win++;
    s.sum += ret * 100;
  }
})();
