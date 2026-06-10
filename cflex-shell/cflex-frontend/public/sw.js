// C-Flex Service Worker — self-unregister kill-switch.
// Replaces the previous PWA SW that caused stale-cache issues during the
// auth-routing migration. On first activation it purges all caches and
// unregisters itself, then reloads any active client tabs once.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) { c.navigate(c.url); }
    } catch (_) {}
  })());
});
self.addEventListener('fetch', () => { /* pass through to network */ });
