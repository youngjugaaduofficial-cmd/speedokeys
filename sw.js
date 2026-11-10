'use strict';
// Cache only the public app shell. Never cache API responses or admin pages.
const CACHE='keystore-shell-v1';
const SHELL=['/','/index.html','/manifest.json','/icon.svg','/offline.html'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const q=e.request,u=new URL(q.url);if(q.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/')||u.pathname.includes('admin'))return;if(q.mode==='navigate'){e.respondWith(fetch(q).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put('/index.html',copy));}return res;}).catch(async()=>await caches.match(q)||await caches.match('/index.html')||await caches.match('/offline.html')));return;}if(SHELL.includes(u.pathname))e.respondWith(caches.match(q).then(hit=>hit||fetch(q)));});
