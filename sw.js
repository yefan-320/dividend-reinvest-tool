/* v3.2 S11：PWA Service Worker——缓存静态资源（加速加载），数据缓存走 IndexedDB（两套不混）
 * 缓存名随版本号（?v= 参数），activate 清旧版本缓存 → 发布后用户不拿旧资源 */
const CACHE = 'divtool-' + (new URL(self.location.href).searchParams.get('v') || '3.2');
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res && res.ok && (e.request.url.includes('.js') || e.request.url.includes('.html') || e.request.url.includes('.css'))) {
          const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
