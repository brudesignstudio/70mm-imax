/**
 * sw.js — service worker
 * ---------------------------------------------------------------
 * The app shell is tiny and entirely static, so it is precached on
 * install and served cache-first. Once installed, 70 mm runs with
 * no network at all — which is the point: you shoot where you are,
 * not where the signal is.
 *
 * Recorded takes never touch the cache; they live in IndexedDB.
 */

const VERSION = 'v14';
const CACHE = `imax70-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/reset.css',
  './css/main.css',
  './js/main.js',
  './js/config.js',
  './js/shaders/shaders.js',
  './js/components/CameraManager.js',
  './js/components/FilmRenderer.js',
  './js/components/Developer.js',
  './js/components/Photographer.js',
  './js/components/Recorder.js',
  './js/components/Stabilizer.js',
  './js/components/OrientationGuard.js',
  './js/components/Histogram.js',
  './js/components/GateFit.js',
  './js/components/Playback.js',
  './js/components/Gallery.js',
  './js/components/Settings.js',
  './js/utils/dom.js',
  './js/utils/filmstrip.js',
  './js/utils/format.js',
  './js/utils/haptics.js',
  './js/utils/capabilities.js',
  './js/utils/storage.js',
  './js/utils/share.js',
  './js/utils/webgl.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/favicon.png',
  './assets/film-strip.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is atomic: one missing file would leave the app
    // half-cached, so failures are absorbed per-entry instead.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // never proxy third parties
  if (url.protocol === 'blob:') return;              // recorded takes

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) {
      // Refresh in the background so an update lands on next launch.
      event.waitUntil(revalidate(request));
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      // Navigations fall back to the shell so a cold offline launch
      // still opens the camera rather than the browser error page.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});

async function revalidate(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response);
    }
  } catch { /* offline: keep what we have */ }
}
