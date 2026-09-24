// FPV Sim service worker — caches the app shell (this page, its modules, the
// pinned CDN libraries and the sky/terrain assets) so the simulator installs
// as a PWA and keeps flying offline after the first successful visit.
//
// Bump CACHE when the asset list changes or when returning users need a clean
// slate (stale-while-revalidate below self-heals routine code edits).
const CACHE = 'fpv-sim-v3';

// Versioned CDN URLs never change content, so they are served cache-first.
// Keep in sync with the import map in index.html (a full load requests all of these).
const CDN = [
  'https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.core.js',
  'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/csm/CSM.js',
  'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/csm/CSMFrustum.js',
  'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/csm/CSMShader.js',
  'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/postprocessing/Pass.js',
  'https://cdn.jsdelivr.net/npm/postprocessing@6.39.5/build/index.js',
  'https://cdn.jsdelivr.net/npm/n8ao@2.0.1/dist/N8AO.js',
  'https://cdn.jsdelivr.net/npm/@dgreenheck/ez-tree@1.1.0/build/ez-tree.es.js',
];

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-512-maskable.png',
  './src/main.js',
  './src/ui/stats.js',
  './src/render/environment.js',
  './src/render/fpvcam.js',
  './src/render/gates.js',
  './src/render/grass.js',
  './src/render/materials.js',
  './src/render/post.js',
  './src/render/props.js',
  './src/render/renderer.js',
  './src/render/sky.js',
  './src/render/terrain.js',
  './src/render/vegetation.js',
  './src/worlds/splatmap.js',
];

const ASSETS = [
  './assets/maps/maps.json',
  ...['midday', 'golden', 'overcast', 'night'].flatMap(p =>
    ['meta.json', 'gain.png', 'sky_2k.jpg', 'sky_4k.jpg'].map(f => `./assets/env/${p}/${f}`)),
  ...['grass', 'meadow', 'dirt', 'asphalt'].flatMap(n =>
    [`./assets/textures/${n}_albedo_1k.jpg`, `./assets/textures/${n}_nr_1k.jpg`]),
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll([...SHELL, ...CDN, ...ASSETS]))
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

const isImmutable = url => url.startsWith('https://cdn.jsdelivr.net/npm/') || url.includes('/assets/');

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        // Pinned libraries and assets: cache-first (their URLs are versioned).
        if (cached && isImmutable(url)) return cached;
        // Everything else: stale-while-revalidate — answer instantly from cache
        // (offline-safe) and refresh it in the background for next time.
        const network = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
