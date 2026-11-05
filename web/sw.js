'use strict'
// Installable-app shell only. API calls, the event stream and static files
// always go to the live local backend and are never cached. When the backend
// is not running, page navigations get a small "start it" page instead of a
// browser error.
const CACHE = 'aihub-shell-v1'
const OFFLINE = '/offline.html'
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll([OFFLINE, '/icons/icon-192.png'])).then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)))
})
