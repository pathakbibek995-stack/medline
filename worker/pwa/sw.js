// Online-only PWA. Never cache records, app pages, API responses or writes.
const NO_CONNECTION_HTML = '__NO_CONNECTION_HTML__';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate' ||
      url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request, {cache: 'no-store'}).catch(() =>
    new Response(NO_CONNECTION_HTML, {
      status: 503,
      headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'},
    })
  ));
});
