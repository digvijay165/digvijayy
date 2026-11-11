// Lets the app open without internet and be installed on a phone.
// Own files: try the network first (so updates show up), fall back to the saved copy.
// Libraries from the CDN: use the saved copy (their URLs include a fixed version).
const CACHE = 'forgeflow-cf-v1';
const SHELL = ['./', './index.html', './config.js', './js/cloud.js', './manifest.json', './icon.svg'];
const CDN = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res })));
    return;
  }
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // API and other servers: always live
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)) }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html'))));
});
