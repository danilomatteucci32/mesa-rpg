// Service worker: guarda a "casca" do app para abrir rápido / instalar. Dados ao vivo vêm do Socket.IO.
const CACHE = 'mesa-rpg-v2.1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/socket.io') || u.pathname.startsWith('/api/') || u.pathname.startsWith('/m/')) return;
  if (u.pathname.startsWith('/uploads/')) { // imagens: cache primeiro
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return res; })));
    return;
  }
  // casca: rede primeiro, cache se offline
  e.respondWith(fetch(e.request).then((res) => { if (res.ok && SHELL.includes(u.pathname)) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return res; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
