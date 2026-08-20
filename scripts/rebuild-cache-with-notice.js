#!/usr/bin/env node
/* rebuild-cache-with-notice.js — 重建 rule-tree-cache.json（带公告日字段 planNotice/notice）
 * 2026-08-21 前瞻口径落地：股息率主口径=已公告年度分红÷现价（主人钦定：所有股票统一）
 * 用法：node scripts/rebuild-cache-with-notice.js
 * 只重建 :d 分红数据（保留原 :k K线），42 只全部重拉（限流：每只间隔 800ms）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE = path.join(__dirname, '..', 'data', 'rule-tree-cache.json');
const DIV_COLS = 'SECURITY_CODE,REPORT_DATE,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,PLAN_NOTICE_DATE,NOTICE_DATE,PRETAX_BONUS_RMB,BONUS_IT_RATIO,IT_RATIO,ASSIGN_PROGRESS,IMPL_PLAN_PROFILE,BASIC_EPS,TOTAL_SHARES';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('parse fail: ' + d.slice(0, 120))); } });
    }).on('error', reject);
  });
}

async function fetchDivs(code) {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=${encodeURIComponent(DIV_COLS)}&pageNumber=1&pageSize=200&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=${encodeURIComponent(`(SECURITY_CODE="${code}")`)}`;
  const d = await get(url);
  const rows = (d && d.result && d.result.data) || [];
  return rows.map(r => ({
    code: r.SECURITY_CODE || '',
    report: (r.REPORT_DATE || '').slice(0, 10),
    ex: (r.EX_DIVIDEND_DATE || '').slice(0, 10),
    record: (r.EQUITY_RECORD_DATE || '').slice(0, 10),
    planNotice: (r.PLAN_NOTICE_DATE || '').slice(0, 10),
    notice: (r.NOTICE_DATE || '').slice(0, 10),
    dps: (parseFloat(r.PRETAX_BONUS_RMB) || 0) / 10,
    bonus: (parseFloat(r.BONUS_IT_RATIO) || 0) / 10,
    zhuanOnly: (parseFloat(r.IT_RATIO) || 0) / 10,
    progress: r.ASSIGN_PROGRESS || '',
    profile: r.IMPL_PLAN_PROFILE || '',
    eps: parseFloat(r.BASIC_EPS) || null,
    totalShares: parseFloat(r.TOTAL_SHARES) || null,
    name: r.SECURITY_NAME_ABBR || '',
  })).filter(x => x.dps > 0 || x.bonus > 0);
}

function dedup(list) {
  const map = new Map();
  list.forEach(x => {
    const key = (x.code || '?') + '|' + (x.report || x.ex);
    const score = (x.progress.includes('实施') ? 2 : 1) + (x.ex ? 1 : 0);
    const old = map.get(key);
    if (!old || score > old._score) { x._score = score; x._pending = !x.ex; map.set(key, x); }
  });
  return Array.from(map.values()).map(({ _score, _pending, ...x }) => ({ ...x, pending: _pending }));
}

(async () => {
  const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const codes = Object.keys(cache).filter(k => /^\d{6}:d$/.test(k)).map(k => k.slice(0, 6));
  console.log('待重建分红:', codes.length, '只');
  let ok = 0, fail = 0;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    try {
      const divs = dedup(await fetchDivs(code));
      cache[code + ':d'] = divs;
      ok++;
      const last = divs[0];
      console.log(`[${i + 1}/${codes.length}] ${code} ${divs.length} 条` + (last && last.planNotice ? ` (planNotice: ${last.planNotice})` : ' (无公告日!)'));
    } catch (e) {
      fail++;
      console.log(`[${i + 1}/${codes.length}] ${code} 失败: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 800));   // 限流
  }
  cache._version = (cache._version || 0) + 1;
  cache._noticeRebuilt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`\n完成: ${ok} 成功 / ${fail} 失败，_version=${cache._version}`);
  process.exit(fail ? 2 : 0);
})();
