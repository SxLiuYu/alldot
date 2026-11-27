/*
 * alldot PWA service worker。
 * 只缓存应用外壳（聊天页 + 图标 + manifest），让「添加到主屏幕」后能秒开。
 * 接口（/api/*、/mcp、/health）一律不走缓存，保证任务状态是实时的。
 *
 * 路径都按 SW 自身位置算（支持挂在 /dot/ 这种子路径下），不写死根路径。
 *
 * 缓存策略分两种（2026-11-27 改）：
 * - 聊天页 /chat 走网络优先、断网回落缓存。原来是缓存优先，改一次 chat.html 就得手动升
 *   版本号，忘了升就出现「代码改了、手机上还是旧页面」，实测踩过一次。
 * - 图标和 manifest 走缓存优先、后台更新，它们几乎不改。
 */
const CACHE = 'alldot-shell-v2';
const BASE = new URL('./', self.location.href).pathname.replace(/\/$/, '');
const CHAT = BASE + '/chat';
const SHELL = ['/chat', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'].map((p) => BASE + p);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** 取一份新的并写回缓存；失败就抛，让调用方回落到缓存。 */
async function fresh(request) {
  const res = await fetch(request);
  if (res.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, res.clone());
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // 接口和动态页面不缓存
  if (url.pathname.startsWith(BASE + '/api/') || url.pathname === BASE + '/mcp' ||
      url.pathname === BASE + '/health' || url.pathname === BASE + '/' ||
      url.pathname.startsWith(BASE + '/artifact/')) return;
  if (!SHELL.includes(url.pathname)) return;

  event.respondWith(
    (async () => {
      const hit = await caches.match(event.request);
      if (url.pathname === CHAT) {
        // 网络优先：改了页面立刻能看到，断网时退回上次缓存的那份。
        try {
          return await fresh(event.request);
        } catch (e) {
          if (hit) return hit;
          throw e;
        }
      }
      if (hit) {
        // 缓存优先：先给快的，顺手在后台更新。
        fresh(event.request).catch(() => {});
        return hit;
      }
      return fresh(event.request);
    })(),
  );
});
