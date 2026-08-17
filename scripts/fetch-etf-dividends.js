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
      // 2026-08-17 抗 WAF：每条最多 3 次尝试 + 间隔 800ms（东财按请求频率限流，实测连续 7+ 条后拦截）
      let rec = null;
      for (let attempt = 0; attempt < 3 && !rec; attempt++) {
        try {
          const r = await fetch('https://np-cnotice-stock.eastmoney.com/api/content/ann?art_code=' + a.ID + '&client_source=web&page_index=1', {
            headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
            signal: AbortSignal.timeout(15000),
          });
          const txt = await r.text();
          if (r.status === 567 || txt.includes('501page')) { await new Promise(r2 => setTimeout(r2, 1000)); continue; }  // WAF 拦截 → 等 1s 重试
          const d = JSON.parse(txt);
          const c = (d.data && d.data.notice_content) || '';
          const mAmt = c.match(/本次分红方案[（(][\s\S]{0,80}?[）)][\s\S]{0,80}?([\d.]+)/);
          const mEx = c.match(/除息日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
          if (mAmt && mEx) {
            rec = {
              ex: mEx[1] + '-' + mEx[2].padStart(2, '0') + '-' + mEx[3].padStart(2, '0'),
              dps: parseFloat(mAmt[1]) / 10,   // 每10份 → 每份
            };
          }
        } catch (e) { /* 重试 */ }
        if (!rec) await new Promise(r2 => setTimeout(r2, 1000));
      }
      if (rec) divs.push(rec);
      else console.log(code, '公告解析失败:', a.ID.slice(0, 12));
      await new Promise(r => setTimeout(r, 800));   // 温和限速（实测连续快速请求触发 WAF）
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
  // 2026-08-17 防缩水保护：WAF 拦截导致单只条数少于现有文件时，保留旧数据（宁可旧不可残）
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (old && old.data) {
    for (const code of Object.keys(old.data)) {
      const fresh = out.data[code];
      if (!fresh || fresh.length < old.data[code].length * 0.8) {
        console.log('⚠️', code, '新数据', fresh ? fresh.length : 0, '条 < 现有', old.data[code].length, '条——保留旧数据（防 WAF 缩水）');
        out.data[code] = old.data[code];
      }
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log('✅ 写入', file, '| 覆盖', Object.keys(out.data).length, '只');
  // v1.8.13 BUG-4 硬闸门：预设 ETF 码必须全覆盖（缺码=数据源缺失，明示不静默）
  const PRESET_ETF = ['512890', '515080', '510300', '510500', '588000', '159915'];
  const missing = PRESET_ETF.filter(c => !(out.data[c] && out.data[c].length));
  if (missing.length) {
    console.log('⚠️ 预设 ETF 缺码（东财 FHGG 数据源无分红记录，前端将显示"数据暂缺"而非 0）: ' + missing.join(', '));
  } else {
    console.log('✅ 预设 6 只 ETF 全覆盖');
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
