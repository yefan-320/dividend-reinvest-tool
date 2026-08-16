// scripts/fetch-etf-dividends.js — GitHub Actions 定时生成 ETF 分红静态数据
// 用途：浏览器直连东财公告被 WAF 拦（反爬 567），Node 无浏览器特征可直连 → 生成 JSON 供前端同源读取
// 运行：node scripts/fetch-etf-dividends.js （输出 data/etf-dividends.json）
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
// 预置 ETF/指数基金代码（前端 ETF_PRESETS 同源，可扩展）
const CODES = ['515080', '512890', '510300', '510500', '588000', '159915', '159905', '512100', '515180', '563300', '510880', '512690'];

async function fetchEtfDivs(code) {
  try {
    const rt = await (await fetch('https://api.fund.eastmoney.com/f10/FHGG?callback=cb&fundcode=' + code + '&pageSize=50&pageIndex=1', {
      headers: { 'User-Agent': UA, 'Referer': 'https://fundf10.eastmoney.com/fhsp_' + code + '.html' },
      signal: AbortSignal.timeout(15000),
    })).text();
    const body = rt.slice(rt.indexOf('(') + 1, rt.lastIndexOf(')'));
    const anns = (JSON.parse(body).Data) || [];
    const divs = [];
    for (const a of anns) {
      try {
        const d = await (await fetch('https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=' + a.ID + '&client_source=web&page_index=1', {
          headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
          signal: AbortSignal.timeout(15000),
        })).json();
        const c = (d.data && d.data.notice_content) || '';
        const mAmt = c.match(/本次分红方案[（(][\s\S]{0,80}?[）)][\s\S]{0,80}?([\d.]+)/);
        const mEx = c.match(/除息日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        if (mAmt && mEx) {
          divs.push({
            ex: mEx[1] + '-' + mEx[2].padStart(2, '0') + '-' + mEx[3].padStart(2, '0'),
            dps: parseFloat(mAmt[1]) / 10,   // 每10份 → 每份
          });
        }
      } catch (e) { /* 单条失败跳过 */ }
      await new Promise(r => setTimeout(r, 150));   // 温和限速
    }
    divs.sort((a, b) => a.ex < b.ex ? 1 : -1);
    return divs;
  } catch (e) {
    console.log(code, '失败:', e.message);
    return null;
  }
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), data: {} };
  for (const code of CODES) {
    const divs = await fetchEtfDivs(code);
    if (divs && divs.length) out.data[code] = divs;
    console.log(code, ':', divs ? divs.length + ' 条' : '失败');
  }
  const file = path.join(__dirname, '..', 'data', 'etf-dividends.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log('✅ 写入', file, '| 覆盖', Object.keys(out.data).length, '只');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
