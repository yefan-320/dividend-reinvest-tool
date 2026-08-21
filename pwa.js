/* v3.2 S11：PWA Service Worker 注册独立文件（从 index.html 挪出，保持主页干净）
 * 缓存名随版本号 → 发布新版本自动建新缓存、activate 清旧缓存（防用户拿旧静态资源） */
try {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const v = (window.APP_VERSION || 'v3.2').replace(/^v/, '');
    navigator.serviceWorker.register('sw.js?v=' + v).catch(() => {});
  }
} catch (e) { /* 失败静默不影响使用 */ }
