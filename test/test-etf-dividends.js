// ETF 分红通道单测（C1 验收：515080 2025 年 4 笔 + 单位换算）
// 纯函数从 data-layer.js 抽取测试（Node 环境无 document，jsonp 不可用 → 用 fetch 模拟）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../data-layer.js', 'utf8');
// 提取 parseEtfAnnList / parseEtfAnnouncement 函数体
function extract(fnName) {
  const m = src.match(new RegExp('function ' + fnName + '[\\s\\S]*?\\n}'));
  if (!m) throw new Error('未找到 ' + fnName);
  return m[0];
}
const parseEtfAnnList = eval('(' + extract('parseEtfAnnList').replace('function parseEtfAnnList', 'function') + ')');
const parseEtfAnnouncement = eval('(' + extract('parseEtfAnnouncement').replace('function parseEtfAnnouncement', 'function') + ')');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
}

(async () => {
  console.log('== 1. 解析纯函数 ==');
  // 单位换算：每10份 0.2 元 → dps 0.02 元/份
  const r1 = parseEtfAnnouncement('招商中证红利ETF2025年度第四次分红公告',
    '本次分红方案（单位：元/10 份基金份额）\n\n 0.2\n\n除息日 2025 年 12 月 18 日\n权益登记日 2025 年 12 月 17 日\n现金红利发放日 2025 年 12 月 23 日');
  t('每10份0.2 → dps=0.02', r1 && Math.abs(r1.dps - 0.02) < 1e-9, JSON.stringify(r1));
  t('除息日解析', r1 && r1.ex === '2025-12-18', r1 && r1.ex);
  t('报告期=标题年度', r1 && r1.report === '2025-12-31', r1 && r1.report);
  t('登记日', r1 && r1.record === '2025-12-17', r1 && r1.record);

  const r2 = parseEtfAnnouncement('某基金2026年度第二次分红公告', '本次分红方案（单位：元/10 份基金份额） 0.15 除息日 2026 年 3 月 18 日');
  t('0.15 → dps=0.015', r2 && Math.abs(r2.dps - 0.015) < 1e-9);
  t('无登记日 → 空串', r2 && r2.record === '');

  const r3 = parseEtfAnnouncement('坏公告', '没有金额内容');
  t('无法解析 → null', r3 === null);

  const r4 = parseEtfAnnList('cb_123({"Data":[{"ID":"A1","TITLE":"2025年度分红公告","PUBLISHDATEDesc":"2025-06-01"}]})');
  t('JSONP 文本剥壳', r4.length === 1 && r4[0].id === 'A1' && r4[0].publish === '2025-06-01', JSON.stringify(r4));
  const r5 = parseEtfAnnList({ Data: [{ ID: 'A2', TITLE: 'x' }] });
  t('对象直通', r5.length === 1 && r5[0].id === 'A2');

  console.log('== 2. 完整链路（真实接口） ==');
  // FHGG 列表（Node fetch 模拟 jsonp）
  const listRes = await fetch('https://api.fund.eastmoney.com/f10/FHGG?callback=cb&fundcode=515080&pageSize=50&pageIndex=1',
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fundf10.eastmoney.com/fhsp_515080.html' } });
  const listText = await listRes.text();
  const anns = parseEtfAnnList(listText);
  t('515080 公告列表 ≥10 条', anns.length >= 10, anns.length + ' 条');
  t('公告含 2026 年度', anns.some(a => a.title.includes('2026年度')), anns.map(a => a.title.slice(0, 20)).join('|'));

  // 拉全部公告正文解析
  const out = [];
  for (const a of anns) {
    const r = await fetch('https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=' + a.id + '&client_source=web&page_index=1',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/' } });
    const d = await r.json();
    const rec = parseEtfAnnouncement(a.title, d.data && d.data.notice_content);
    if (rec) { rec.code = '515080'; out.push(rec); }
  }
  t('正文解析成功率 100%', out.length === anns.length, out.length + '/' + anns.length);
  // 2025 年 4 笔（大师验收项2）
  const y2025 = out.filter(x => x.ex.startsWith('2025'));
  t('2025 年 4 笔', y2025.length === 4, '实际 ' + y2025.length + ' 笔: ' + y2025.map(x => x.ex + '@' + x.dps).join(', '));
  // 2025 合计：0.015*3 + 0.02 = 0.065 元/份
  const sum2025 = y2025.reduce((s, x) => s + x.dps, 0);
  t('2025 合计 0.065 元/份', Math.abs(sum2025 - 0.065) < 1e-9, sum2025.toFixed(4));
  // 除息日倒序
  const sorted = out.every((x, i) => i === 0 || out[i - 1].ex >= x.ex);
  t('除息日倒序（与股票通道一致）', sorted);
  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e.message); process.exit(1); });
