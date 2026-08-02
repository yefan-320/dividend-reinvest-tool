#!/usr/bin/env node
/* 联网测试：验证页面新数据层（腾讯分段CORS → 新浪备源）能拉到任意股票 */
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const start = html.indexOf('/* fetch + 超时');
const end = html.indexOf('/* ================= 回测核心');
const core = html.slice(start, end);

const sandbox = { window: {}, document: { createElement: () => ({ set src(v){}, remove(){} }), head: { appendChild(){} } } };
sandbox.window = sandbox;
sandbox.fetch = global.fetch;
sandbox.AbortController = global.AbortController;
sandbox.Headers = global.Headers;
sandbox.Request = global.Request;
sandbox.Response = global.Response;
sandbox.setTimeout = global.setTimeout;
sandbox.clearTimeout = global.clearTimeout;
vm.createContext(sandbox);
vm.runInContext(core + '\nthis.fetchKline = fetchKline;', sandbox);

async function main(){
  const today = '2026-08-03';
  const tests = [
    ['sz000001', '2016-08-03', '平安银行'],
    ['sh600519', '2016-08-03', '贵州茅台'],
    ['sz300750', '2016-08-03', '宁德时代'],
    ['sh600036', '2016-08-03', '招商银行'],
  ];
  for(const [prefix, start, name] of tests){
    const t0 = Date.now();
    const m = await sandbox.fetchKline(prefix, start, today);
    const dates = Object.keys(m).sort();
    const ms = Date.now() - t0;
    if(dates.length){
      const gap = (new Date(dates[1]) - new Date(dates[0])) / 86400000;
      console.log(`✅ ${name}(${prefix}): ${dates.length} 条 | ${dates[0]} ~ ${dates[dates.length-1]} | ${ms}ms | 首两日间隔 ${gap}天`);
    } else {
      console.log(`❌ ${name}(${prefix}): 拉取失败 (${ms}ms)`);
    }
  }
}
main().catch(e => { console.error('测试异常:', e); process.exit(1); });
