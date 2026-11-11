/* App-shell cache. Wikipedia data is stored by the app in IndexedDB, not here. */
const CACHE = 'wikiwalk-v1.2.1';
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
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
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
  // Cache-first for the app shell; navigation falls back to the cached index page.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      });
    })
  );
});
