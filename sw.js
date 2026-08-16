// FPV Sim service worker — caches the app shell (this page, its icons, and the
// three.js CDN script) so the simulator installs as a PWA and keeps flying
// offline after the first successful visit.
//
// Bump CACHE when index.html changes in a way that needs a clean slate for
// returning users (stale-while-revalidate below usually self-heals without
// this, but a version bump guarantees old entries are dropped).
const CACHE = 'fpv-sim-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-512-maskable.png',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: answer instantly from cache (so it works offline
// and feels instant online), while refetching in the background to keep the
// cache fresh for next time — no manual version bump needed for routine edits.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
