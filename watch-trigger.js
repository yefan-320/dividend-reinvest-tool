// watch.js 变化检测 trigger（0 成本轮询：无变化不 fire，不花 LLM）
// 频率规则（2026-08-20 主人拍板）：财报季(3/4/7/8/10月)每天15:30；非财报季每周一/三/五15:30
const now = new Date();
const month = now.getMonth() + 1;          // 1-12
const dow = now.getDay();                  // 0=周日,1=周一...
const isSeason = [3, 4, 7, 8, 10].includes(month);   // 财报季月份
const isMonWedFri = [1, 3, 5].includes(dow);          // 一/三/五
if (!isSeason && !isMonWedFri) {
  // 非财报季且非一/三/五 → 不检查（0 成本跳过）
  json({ fire: false, state: { last: Date.now(), skipped: true, season: false } });
  return;
}
const res = await tools.call('exec', { command: 'cd ~/Documents/dividend-tool/repo && node watch.js 2>/dev/null' });
const out = String(res?.result?.details?.aggregated ?? res?.result?.details?.stdout ?? '').trim();
let changes = [];
try { changes = JSON.parse(out); } catch (e) {}
if (Array.isArray(changes) && changes.length) {
  const items = changes.slice(0, 10).map(c => `${c.name}: ${c.verdict}（dy ${c.dy != null ? c.dy.toFixed(2) + '%' : '—'}）`).join('；');
  json({ fire: true, message: `📡 红利监测：${changes.length} 项变化\n${items}`, state: { last: Date.now(), count: changes.length } });
} else {
  json({ fire: false, state: { last: Date.now(), count: 0 } });
}
