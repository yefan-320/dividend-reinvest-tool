#!/usr/bin/env node
/* extract-tier-data.js — 提取 data-layer.js 硬编码决策表 → data/tier-data.json
 * 背景：优化方案要求把 TIER_LINE / BENCH / RULE_STATS / SIG_STATS / MAX_DD /
 *       P95_TRIGGERS / TREASURY_NOW 数据化到 data/ 目录 JSON，便于脚本自动重算。
 * 用法：node scripts/extract-tier-data.js
 * 幂等：若 data/tier-data.json 已存在且内容与当前 data-layer.js 完全一致，
 *       打印"无变更"且不覆盖（避免无谓的 git 改动）。
 * 注意：data-layer.js 是浏览器 IIFE，require 前必须先 global.window = global
 *       （与 watch.js 相同）；TREASURY_NOW / TREASURY_ASOF 是 getter，需经
 *       DL 的 getter 读取（防导出快照陈旧）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* 与 watch.js 相同的 require 姿势：先挂 window，再 require，再取 global.window.DL */
global.window = global;
require('../data-layer.js');
const DL = global.window.DL;

const OUT = path.join(__dirname, '..', 'data', 'tier-data.json');

/* 本地日期（全站惯例：禁用 toISOString 截日期——UTC 差一天，深夜 0-8 点起点变昨天） */
const now = new Date();
const generatedAt = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');

/* 按原始结构组装（key 插入顺序即 data-layer.js 源码顺序，JSON.stringify 保持） */
const data = {
  generatedAt,
  source: 'data-layer.js v3.8.0',
  tierLine: DL.TIER_LINE,
  bench: DL.BENCH,
  ruleStats: DL.RULE_STATS,
  sigStats: DL.SIG_STATS,
  maxDd: DL.MAX_DD,
  p95Triggers: DL.P95_TRIGGERS,
  treasuryNow: DL.TREASURY_NOW,
  treasuryAsOf: DL.TREASURY_ASOF,
};

/* 摘要日志：每个表的大小 */
console.log('[extract-tier-data] 摘要：');
console.log('  TIER_LINE    :', Object.keys(DL.TIER_LINE).length, '只股票');
console.log('  BENCH        :', Object.keys(DL.BENCH).length, '个行业');
console.log('  RULE_STATS   :', Object.keys(DL.RULE_STATS).length, '个档位');
console.log('  SIG_STATS    :', Object.keys(DL.SIG_STATS).length, '个行业');
console.log('  MAX_DD       :', Object.keys(DL.MAX_DD).length, '个行业');
console.log('  P95_TRIGGERS :', Object.keys(DL.P95_TRIGGERS).length, '只股票');
console.log('  TREASURY_NOW :', DL.TREASURY_NOW, '· ASOF:', DL.TREASURY_ASOF);

const json = JSON.stringify(data, null, 2) + '\n';

/* 幂等：已存在且内容相同 → 不覆盖 */
let existing = null;
try { existing = fs.readFileSync(OUT, 'utf8'); } catch (e) { /* 首次运行：不存在 */ }
if (existing === json) {
  console.log('无变更（' + path.relative(process.cwd(), OUT) + ' 与当前 data-layer.js 内容一致）');
} else {
  fs.writeFileSync(OUT, json);
  console.log('已写入:', OUT, '（' + Buffer.byteLength(json, 'utf8') + ' 字节）');
}
