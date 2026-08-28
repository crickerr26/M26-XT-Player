/* Media26 service worker — makes the home-screen (installed) app auto-update on every new
   deployment. Strategy: NETWORK-FIRST for the same-origin app shell (index.html, engines,
   icons) so a fresh deploy shows up on the next launch; cache is only a fallback for offline.
   Playback is never touched: stream/proxy/transcoder requests and all cross-origin requests
   bypass the worker entirely, so video never goes through the cache. */
const CACHE = 'media26-shell-v295';

self.addEventListener('install', () => {
  /* activate the new worker immediately instead of waiting for old tabs to close */
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  /* Only ever handle same-origin GETs for the app shell. Everything else — POSTs, cross-origin
     (direct panel streams), and the streaming/proxy endpoints — is left to the browser so the
     worker can never interfere with playback or seeking (range requests). */
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/^\/(proxy|hls|sessions|transcoder|api)(\/|$|\?)/.test(url.pathname)) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-store' });
      /* keep a copy only for offline fallback */
      try { const c = await caches.open(CACHE); c.put(req, fresh.clone()); } catch (_) {}
      return fresh;
    } catch (_) {
      const cached = await caches.match(req);
      return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
