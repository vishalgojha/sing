const CACHE = 'sur-guru-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './worklet/dsp.js',
  './worklet/pitch-processor.js',
  './worklet/recorder-processor.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
