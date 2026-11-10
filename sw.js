// Wave Chat service worker
const CACHE_NAME = 'wave-chat-v2'; // bump this when you change the cached files

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './notify.mp3',
  './icon-192.png',
  './icon-512.png',
];

// ---- Install: cache each file separately so one missing file can't break installation
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(APP_SHELL.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

// ---- Activate: remove old caches and take control of open pages
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ---- Fetch: network first, cache as the offline fallback (same-origin GET only)
self.addEventListener('fetch', event => {
  const req = event.request;

  // Supabase (API + realtime) and CDN requests go straight to the network
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      const cached =
        (await caches.match(req)) ||
        (req.mode === 'navigate' ? await caches.match('./index.html') : undefined);
      if (cached) return cached;
      throw err;
    }
  })());
});

// ---- Notification click: focus the app and open the sender's chat
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const sender = event.notification.data?.sender || null;
  const scope = self.registration.scope; // e.g. https://user.github.io/repo/

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(c => c.url.startsWith(scope));

    if (client) {
      await client.focus();
      if (sender) client.postMessage({ type: 'OPEN_CHAT', sender });
      return;
    }

    const url = sender ? `${scope}?chat=${encodeURIComponent(sender)}` : scope;
    await clients.openWindow(url);
  })());
});
