// Service worker: caches the app shell so it works fully offline after one visit.
// app.js registers this as sw.js?v=<VERSION>, so bumping js/version.js installs a
// fresh worker with a clean cache.
// Other apps share this origin (the battle siblings do), so only caches
// with this app's prefix are ours to clean up.
const CACHE_PREFIX = 'rtw-';
const CACHE_NAME = `${CACHE_PREFIX}${new URL(self.location).searchParams.get('v') ?? 'dev'}`;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/audio.js',
  './js/army.js',
  './js/gen.js',
  './js/heraldry.js',
  './js/render.js',
  './js/rng.js',
  './js/sim.js',
  './js/version.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only this app's own URLs: the scope includes the origin and path, and other apps
  // share the origin.
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;

  // Network first, so an update shows up on the very next load and HTML, CSS and JS
  // never mix versions; our own cache is only the offline fallback. 'no-cache'
  // revalidates past the long max-age Cloudflare stamps on scripts. Never use
  // caches.match(): it searches every app's caches on the origin.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(req, { cache: 'no-cache' });
      if (response.ok) cache.put(req, response.clone());
      return response;
    } catch (err) {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) ?? Response.error();
      throw err;
    }
  })());
});
