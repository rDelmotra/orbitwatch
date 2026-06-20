// Orbitwatch asset Service Worker — runtime cache for the heavy static binaries
// (Earth KTX2 textures + Basis transcoder + favicon). ~6.5 MB total.
//
// Design: runtime caching by URL pattern, NOT a hardcoded precache list. The
// texture filenames are content-hashed (earth-*.<hash>.ktx2), so a precache list
// would go stale on every regen. Instead we cache on first real request and serve
// from cache thereafter — the Earth always renders on first load, so everything
// ends up cached by the end of the first session. Self-invalidating, no codegen.
//
// Scope is deliberately narrow: only same-origin GETs under /textures/, /basis/,
// and /favicon.svg are touched. Everything else — /api/*, JS/HTML chunks,
// navigations, the TLE/DSO data flows — passes straight through, untouched.

const CACHE = 'orbitwatch-assets-v1';

self.addEventListener('install', () => {
  // No precache — caching happens lazily on first fetch. Activate immediately.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop any superseded asset caches (e.g. orbitwatch-assets-v0).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('orbitwatch-assets-') && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Cache-first: serve from cache if present, else fetch + populate. For immutable,
// content-hashed assets (new content => new URL), so the cache never goes stale.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

// Stale-while-revalidate: serve cache instantly, refresh in the background. For
// stable-URL assets that may change across deploys (basis transcoder, favicon).
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit); // offline: fall back to whatever we have
  return hit || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/textures/')) {
    event.respondWith(cacheFirst(request));
  } else if (url.pathname.startsWith('/basis/') || url.pathname === '/favicon.svg') {
    event.respondWith(staleWhileRevalidate(request));
  }
  // Anything else: do not call respondWith → default browser handling.
});
