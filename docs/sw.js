'use strict';
const prefix = 'lichnoe-shell-';
const version = '2.1.1';
const cacheName = prefix + version;
const scope = self.registration.scope;
const shell = new URL('index.html', scope).href;
const assets = ['relief.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'google-sync.js'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const page = await fetch(shell, {cache: 'reload'});
    if (!page.ok || !(await page.clone().text()).includes('<meta name="panel-build" content="' + version + '">')) {
      throw new Error('Сборка ещё не опубликована полностью.');
    }
    const cache = await caches.open(cacheName);
    await cache.addAll(assets.map(path => new Request(new URL(/\.(js|css)$/.test(path) ? path + '?v=' + version : path, scope), {cache: 'reload'})));
    await cache.put(shell, page);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !url.href.startsWith(scope)) return;
  const path = url.pathname.slice(new URL(scope).pathname.length);
  if (!['', 'index.html', ...assets].includes(path)) return;
  const key = /\.(js|css)$/.test(path) ? request.url : path && path !== 'index.html' ? new URL(path, scope).href : shell;
  event.respondWith(caches.open(cacheName).then(async cache => (await cache.match(key)) || fetch(request)));
});
