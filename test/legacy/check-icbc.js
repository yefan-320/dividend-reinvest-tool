const fs = require('fs');
const vm = require('vm');
const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.location = { search: '' };
sandbox.document = { write: ()=>{} };
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.fetch = fetch;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('data-layer.js','utf8'), sandbox);
const DL = sandbox.window.DL;

(async () => {
  console.log('=== 工行真实分红数据 ===');
  const divs = await DL.fetchDividendsOne('601398');
  console.log('条数:', divs.length);
  divs.slice(0, 30).forEach(d => {
    console.log(`${d.ex} 报告期=${d.report} 每股=${d.dps} 送转=${d.bonus||0} ${d.pending?'[待实施]':''}`);
  });
  const price = 6.5;
  const dy = DL.calcAnnualDivYield(divs, price);
  console.log('\n=== 年化股息率(近2报告年度平均÷现价) ===');
  console.log('现价', price, '→', JSON.stringify(dy, null, 1));
})().catch(e => console.error('ERR', e.message));
