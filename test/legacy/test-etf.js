// 验证 ETF 分红完整链路：FHGG 公告列表 → 公告正文解析
const FHGG = 'https://api.fund.eastmoney.com/f10/FHGG?callback=cb&fundcode=515080&pageSize=20&pageIndex=1';
async function main() {
  const r1 = await fetch(FHGG, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fundf10.eastmoney.com/fhsp_515080.html' } });
  const t1 = await r1.text();
  const jsonStr = t1.slice(t1.indexOf('(') + 1, t1.lastIndexOf(')'));
  const list = JSON.parse(jsonStr);
  console.log('公告条数:', list.Data.length);
  const anns = list.Data.slice(0, 10);
  const out = [];
  for (const a of anns) {
    const r2 = await fetch(`https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=${a.ID}&client_source=web&page_index=1`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://data.eastmoney.com/' } });
    const d = await r2.json();
    const c = (d.data && d.data.notice_content) || '';
    const idx = c.indexOf('本次分红方案');
    const seg = c.slice(idx, idx + 150);
    const m1 = seg.match(/本次分红方案[（(][\s\S]{0,80}?[）)][\s\S]{0,80}?([\d.]+)/);
    const m2 = c.match(/除息日\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/);
    const m3 = c.match(/权益登记日\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/);
    const m4 = c.match(/现金红利发放日\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/);
    const amt = m1 ? parseFloat(m1[1]) : null;
    console.log(`[${a.PUBLISHDATEDesc}] 每10份=${amt}元 除息=${m2 ? m2[1] : '?'} 登记=${m3 ? m3[1] : '?'} 发放=${m4 ? m4[1] : '?'}`);
    if (amt != null && m2) out.push({ amt, ex: m2[1].replace(/\s/g, '').replace('年','-').replace('月','-').replace('日','') });
  }
  console.log('\n解析成功:', out.length + '/' + anns.length);
  console.log(JSON.stringify(out, null, 1));
}
main().catch(e => console.error('ERR', e.message));
