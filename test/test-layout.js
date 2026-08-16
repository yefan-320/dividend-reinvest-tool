// test-layout.js — v1.8.4 图例布局修复验收断言（大师修订 7 项中可自动化的 1/2/3/7）
// 基座：~/Documents/dividend-tool/repo（正式仓库，git rev-parse HEAD 锁定）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) { cond ? pass++ : fail++; console.log((cond ? '✅' : '❌') + ' ' + name); }

const views = fs.readFileSync(path.join(ROOT, 'views.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 1. fitLegendTop 全局定义存在（window 挂载，index.html 回测页可调）
ok('1a. window.fitLegendTop 全局定义', /window\.fitLegendTop = function/.test(views));

// 2. 四图统一调用：回测 ch1/ch3 + 对比 ch1/chDiv/ch2（5 处调用点；定义行另计）
const callSites = (views.match(/fitLegendTop\(ch[0-9D]/g) || []).length + (html.match(/fitLegendTop\(ch[0-9D]/g) || []).length;
ok('2a. 5 处调用点', callSites === 5);
ok('2b. 回测 ch1', /fitLegendTop\(ch1, \$\('#chartAsset'\)/.test(html));
ok('2c. 回测 ch3', /fitLegendTop\(ch3, \$\(\'#chartRate\'\)/.test(html));
ok('2d. 对比 ch1', /fitLegendTop\(ch1, \$\(\'#cmpChartAsset\'\)/.test(views));
ok('2e. 对比 chDiv', /fitLegendTop\(chDiv, \$\(\'#cmpChartDiv\'\)/.test(views));
ok('2f. 对比 ch2', /fitLegendTop\(ch2, \$\(\'#cmpChartYield\'\)/.test(views));

// 3. 无残留坏内联（同步读 _componentsViews 的旧补丁）
const badInline = (html.match(/_componentsViews/g) || []).length + (views.match(/_componentsViews/g) || []).length;
// 全局实现内部有 1 处合法读取（views.js 22 行），其余应为 0
ok('3a. 无残留坏内联（仅全局实现 1 处）', badInline <= 1);

// 4. clientWidth>0 守卫存在（M4）
ok('4a. clientWidth 守卫', /clientWidth <= 0/.test(views));

// 5. 股息率图 x 轴显式抽稀兜底（M5）
ok('5a. x 轴抽稀兜底', /interval: yieldYearsAll\.length > 10 \? Math\.ceil\(yieldYearsAll\.length \/ 8\)/.test(views));

// 6. 脚本加载顺序：回测页 fitLegendTop 调用点在 renderAllFull 函数内（用户点击 run 时执行，views.js 已加载）
ok('6a. views.js 后加载（index.html 底部）', /<script src="views\.js"><\/script>/.test(html));
const callPos = html.indexOf('window.fitLegendTop(ch1');
const fnPos = html.indexOf('function renderAllFull(');
ok('6b. ch1 调用在 renderAllFull 内（点击时执行，非顶层）', callPos > fnPos && callPos < html.indexOf('function run('));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
