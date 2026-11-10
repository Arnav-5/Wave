const CACHE_NAME = 'wave-chat-v5'; // bump this whenever a cached file changes
// Wave Chat service worker
const CACHE_NAME = 'wave-chat-v4'; // bump this whenever a cached file changes

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

// Cache each file separately so one missing file can't break installation
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(APP_SHELL.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

// Remove old caches and take control of open pages
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network first, cache as the offline fallback (same-origin GET requests only)
self.addEventListener('fetch', event => {
  const req = event.request;
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

// Opens the right chat when the user taps a notification
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const chat = event.notification.data?.chat;
  const url = chat ? `./?chat=${encodeURIComponent(chat)}` : './';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) {
      await all[0].focus();
      return all[0].navigate(url).catch(() => {});
    }
    return clients.openWindow(url);
  })());
});
