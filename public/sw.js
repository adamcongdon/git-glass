const CACHE_VERSION = 'v17';
const CACHE_NAME = `feedback-tool-${CACHE_VERSION}`;

const APP_SHELL = [
  '/',
  '/app.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch((err) => {
        // Don't fail install if icons aren't available yet
        console.warn('[SW] App shell cache partial failure:', err);
        return cache.addAll(['/', '/app.html', '/manifest.json']);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: claim clients and delete old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('feedback-tool-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: network-only for API, cache-first for everything else
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-only for API routes
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for app shell
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful responses for app shell resources
        if (response.ok && event.request.method === 'GET') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      }).catch(() => {
        // Return cached app.html for navigation requests when offline
        if (event.request.mode === 'navigate') {
          return caches.match('/app.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
