# RELEASE.md — 发布检查清单（2026-08-18 大师裁决：发布流程从"人记"变"清单勾"）

> 教训来源：① 8/17 APP_VERSION 漏更（页面显示 v1.8.0）② 8/18 复发（v1.9.11 发布页面仍 v1.9.6）
> ③ 8/18 P0-C TDZ 崩溃：unit 测试全过但打开诊断页即炸——**代码层验收≠页面级冒烟**
> 每次推送 GitHub Pages 前逐项勾选，缺一项不得发布。

## 发布前清单

- [ ] **版本号核对**：`index.html` 的 `APP_VERSION` == CHANGELOG 最新版本 == git commit 信息（三处一致）
- [ ] **关键修复逐项勾选**：对照 CHANGELOG 本次条目，逐项在线上文件 grep 验证特征代码（例：`grep SELL_WINDOW_YEARS 线上 views.js`）
- [ ] **页面级冒烟**：本次改动涉及的每个页面**打开一次确认渲染**（回测页/诊断页/决策台/组合回测/对比），无 JS 异常（headless Chrome + console 监听）
- [ ] **回归**：`node test/unit-v195.js` + 关键 e2e（`test/e2e-full.js` 或定向脚本）通过
- [ ] **数据真值核对**：涉及数字改动时抽 3 个数字回源（东财 F10/年报），防"自洽≠正确"

## 发布后清单

- [ ] **线上确认**：curl 线上文件 grep 版本号 + 本次修复特征代码
- [ ] **线上与本地一致性核验**：curl 线上 index.html/views.js/data-layer.js 的 sha256 == 本地仓库 sha256（防"本地改了一堆、线上没同步"）
- [ ] **用户视角走查**：密码锁/自选/诊断/回测 核心流程过一遍（可用 `test/user-live-walkthrough.js`）
- [ ] **CHANGELOG 更新**：本次变更 + 版本号 + 日期

## 历史发布核对记录

| 版本 | 日期 | 版本号 | 关键修复 grep | 页面冒烟 | 回归 | 备注 |
|---|---|---|---|---|---|---|
| v1.9.13 | 2026-08-18 | ✅ 三处一致 | trapFilter / SIG_STATS / MAX_DD / 卖出行业有效性 / 生活视角卡 / 决策日志 / 导出导入 | 回测/诊断/对比/决策台/组合回测 + 生活视角/决策日志/密码锁 | unit-v195 + e2e-full 27/27 + e2e-browser 全过 | P0 七项+P1 十一项+P2 六项（24 项路线图全落地） |
| v1.9.11 | 2026-08-18 | ✅ 三处一致（修复后） | SELL_WINDOW_YEARS=5 / ttmDivsAt / coverageAt / 40.7 / verdictEngine | 诊断/回测/组合回测/对比/决策台 | unit-v195 + 走查 | P0 四件套+TDZ+自选snap 修复 |
