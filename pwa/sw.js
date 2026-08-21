/* ============================================================
   Octogo Tracker — service worker
   - Versioned, cache-first app shell (bump VERSION to ship updates)
   - Runtime stale-while-revalidate cache for Google Fonts
   - Never touches non-GET requests (API POSTs always hit network)
   - skipWaiting + clientsClaim so updates apply on next load
   ============================================================ */
'use strict';

const VERSION = 'v2.7.6';
const SHELL_CACHE = 'octogo-shell-' + VERSION;
const FONT_CACHE = 'octogo-fonts-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== SHELL_CACHE && k !== FONT_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // API mutations and anything non-GET go straight to the network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Google Fonts: stale-while-revalidate runtime cache.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(fontStaleWhileRevalidate(req));
    return;
  }

  // App shell: cache-first, network fallback, offline navigate -> index.
  if (url.origin === self.location.origin) {
    event.respondWith(shellCacheFirst(req));
  }
});

async function fontStaleWhileRevalidate(req) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await refresh) || Response.error();
}

async function shellCacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}
