/* Daily Reporting service worker.
 * Network-first for same-origin requests (so deploys show up immediately) with
 * a cache fallback for offline. Cross-origin requests (the Firebase SDK on
 * gstatic, and Firestore/Auth on googleapis) are left untouched so realtime
 * data always goes straight to the network. */
const CACHE = 'daily-reporting-v1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/firebase-config.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase SDK & Firestore/Auth: network only

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
  );
});
