const prefix = 'lichnoe-shell-';
const cacheName = prefix + 'v4';
const home = new URL('./', self.registration.scope);
const shell = new URL('index.html', home);
const syncScript = new URL('google-sync.js?v=auto1', home);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll([shell.href, syncScript.href])));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith(prefix) && key !== cacheName)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.href === syncScript.href) {
    event.respondWith(fetch(event.request).catch(async () => (await caches.open(cacheName).then(cache => cache.match(syncScript.href))) ?? Response.error()));
    return;
  }
  if (event.request.mode !== 'navigate') return;
  if (url.origin !== home.origin || ![home.pathname, shell.pathname].includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    let response;
    try {
      response = await fetch(event.request);
    } catch {
      return await cache.match(shell.href) ?? Response.error();
    }
    if (response.ok) {
      try { await cache.put(shell.href, response.clone()); } catch { /* Storage may be full. */ }
    }
    return response;
  })());
});
