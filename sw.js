/* App-shell cache. Wikipedia data is stored by the app in IndexedDB, not here. */
const CACHE = 'wikiwalk-v1.2.2';
const TILES = 'wikiwalk-tiles';
const MAX_TILES = 1500;
const SHELL = [
  './',
  'index.html',
  'style.css',
  'lib.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never installs stale files.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('wikiwalk-v') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

// Map tiles you've actually viewed are kept for offline use (allowed by the OSM tile policy; no bulk prefetch).
let tilePuts = 0;
async function tileFetch(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
  if (res.ok) {
    await cache.put(req.url, res.clone());
    if (++tilePuts % 50 === 0) {
      const keys = await cache.keys();
      if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(k);
    }
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && url.hostname === 'tile.openstreetmap.org') { e.respondWith(tileFetch(e.request)); return; }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // App files: try the network first (so updates show up right away), fall back to the saved copy
  // after 3 seconds or when offline.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(e.request, { ignoreSearch: true }) ||
      (e.request.mode === 'navigate' ? await cache.match('index.html') : undefined);
    const net = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(e.request, res.clone());
      return res;
    });
    if (!cached) return net.catch(() => Response.error());
    const timeout = new Promise((r) => setTimeout(() => r(cached), 3000));
    return Promise.race([net.catch(() => cached), timeout]);
  })());
});
