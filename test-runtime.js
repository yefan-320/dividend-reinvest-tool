#!/usr/bin/env node
/* 模拟浏览器环境运行页面全部 JS，捕获运行时错误 */
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
// 提取全部内嵌 script（排除 src 的）
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

// 最小 DOM mock
function makeEl(id){
  return {
    id, value:'', textContent:'', innerHTML:'', className:'', style:{}, checked:false, disabled:false,
    dataset:{}, onclick:null,
    querySelectorAll: () => [],   // v1.7.6 M7: 页面有 bdq.querySelectorAll('button')，mock 缺失会报错
    closest: () => null,          // v1.7.6 M7: 页面有 $('monthly').closest('.field')
    remove(){}, classList: { toggle(){}, add(){}, remove(){} },
    addEventListener(){}, dispatchEvent(){},
    setOption(){}, dispose(){}, resize(){},
  };
}
const els = {};
['code','codeHint','principal','buyDate','reinvest','btnRun','btnDemo','status','headerInfo',
 'stockName','stats','cardSummary','cardGauge','gaugeNote','cardAsset','cardDiv','cardRate','cardShares','cardTable',
 'chartAsset','chartDiv','chartRate','chartShares','chartGauge1','chartGauge2','tbl'
].forEach(id => els[id] = makeEl(id));

const sandbox = {
  window: null, location: { search:'', href:'https://test/' },
  addEventListener(){}, 
  document: {
    getElementById: id => els[id] || makeEl(id),
    querySelectorAll: () => [],
    createElement: () => ({ set src(v){}, remove(){}, onload:null, onerror:null }),
    head: { appendChild(){} },
  },
  console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('network blocked')),
  AbortController, URLSearchParams, Event: class { constructor(t){ this.type=t; } },
  localStorage: { getItem:()=>null, setItem(){} },
  echarts: { init: el => el },
  history: {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);

let errors = 0;
for(const code of scripts){
  try{
    vm.runInContext(code, sandbox, {timeout: 3000});
  }catch(e){
    errors++;
    console.log('❌ 运行时错误:', e.message);
    console.log('   片段:', code.split('\n').slice(0,3).join(' | '));
  }
}
// 触发异步回调（setTimeout 已被 mock 为真实 setTimeout，等待）
setTimeout(()=>{
  console.log(errors === 0 ? '✅ 页面 JS 无初始化错误' : '⚠️ 发现 '+errors+' 个错误');
  // 检查自动演示是否触发（run('demo') 应执行 simulate）
  console.log('status 文本:', JSON.stringify(els.status.textContent));
  console.log('headerInfo 文本:', JSON.stringify(els.headerInfo.textContent));
}, 1500);
