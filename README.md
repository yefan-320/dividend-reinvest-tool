# A股红利复投回测工具

价值投资视角的红利复投回测：输入任意 A 股代码，回测「买入持有 + 分红再投资」的每年收益、分红、分红率。

## 文件说明
- `index.html` — 工具本体（单文件，含全部逻辑，移动端适配）
- `demo-data.js` — 招行 600036 内置演示数据（2016-01 至今日K收盘价 + 全部分红记录）
- `make_demo.py` — 重新生成演示数据（需东财 dividends.json + kline.json）
- `test.js` — Node 单元测试（验证回测核心逻辑）
- `kline.json` / `dividends.json` — 东财原始数据缓存

## 使用
- **永久地址（Mac 关机也可访问）：** https://yefan-320.github.io/dividend-reinvest-tool/ （GitHub Pages，2026-08-03 部署）
- 本地调试：`python3 -m http.server 8321` → 打开 `http://localhost:8321`（局域网 `http://<本机IP>:8321`）
- 输入 6 位股票代码 → 点「回测（联网拉最新数据）」；或点「用招行演示数据」离线演示
- **更新部署：** 修改文件后 `git add -A && git commit -m 'update' && git push`，GitHub Pages 自动重新构建（约 1 分钟）

## 模型口径
- **默认参数：初始本金 100 万、买入日期 10 年前、红利复投开**，打开页面即自动演示招行完整结果
- **A股整手规则**：买入按 100 股整数倍建仓，不足一手的零钱存入现金池；分红先入现金池，够一手（100股）时按除息日收盘价买入，零钱继续留存
- 送股/转增按比例增加持股（可产生零股）
- 忽略红利税（持有超 1 年免税）
- **分红率(相对投入) = 当年分红 ÷ (初始本金 + 截至当年累计复投金额)**（老板自定义口径）
- **分红率(相对本金) = 当年分红 ÷ 初始本金**
- 总资产 = 持股市值 + 现金池；年化收益率 = XIRR（现金流：期初投入、期末总资产）
- 图表对比线「分红不买股」= 平行模拟（分红全部留存现金池）

## 数据源与容错
- **K线主源：腾讯行情** web.ifzq.gtimg.cn（CORS 直连 fetch，已验证；每段≤2.5年/800条分段拉取保证全量）
- **K线备源：新浪** quotes.sina.cn（JSONP，仅最近 1023 条）
- **分红主源：东财 datacenter-web**（JSONP callback=）；**备源：东财 datacenter/securities** 域名
- **股票名称：东财 searchapi（JSONP）→ 备源：腾讯 smartbox**（注：searchapi 返回 application/json，iOS Safari 会拦截其 JSONP，已双源兼容）
- **实时拉取全部失败时自动回退招行内置演示数据**并提示，页面永远有完整结果
- 联网测试：`node test-live.js`（真实拉取平安/茅台/宁德/招行）；单测：`node test.js`

## 已知注意
- 演示按钮动态化：输入 600036 显示「离线演示」；其他代码显示「查询 xxx（联网）」并直接联网回测
- iOS Safari 对非 JS MIME 的 script 有拦截策略，JSONP 在个别浏览器可能失败，已用多源+回退覆盖

## 重启命令（Mac 重启后）
```bash
cd ~/Documents/招商银行红利复投工具
python3 -m http.server 8321 &
cloudflared tunnel --url http://localhost:8321 --no-autoupdate > /tmp/cloudflared.log 2>&1 &
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cloudflared.log | head -1
```
