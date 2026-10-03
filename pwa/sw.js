/* ============================================================
   Octogo Tracker — service worker
   - The PAGE is network-first with a 2.5s timeout and a cache fallback, so a
     phone with signal always gets the newest version and a phone without one
     still opens instantly (v2.13.4). Other assets stay cache-first.
   - Runtime stale-while-revalidate cache for Google Fonts
   - Never touches non-GET requests (API POSTs always hit network)
   - skipWaiting + clientsClaim so updates apply on next load
   ============================================================ */
'use strict';

const VERSION = 'v2.32.0';
const SHELL_CACHE = 'octogo-shell-' + VERSION;
const FONT_CACHE = 'octogo-fonts-v1';
const PUSH_SETTINGS_CACHE = 'octogo-push-settings-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== SHELL_CACHE && k !== FONT_CACHE && k !== PUSH_SETTINGS_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // API mutations and anything non-GET go straight to the network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Google Fonts: stale-while-revalidate runtime cache.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(fontStaleWhileRevalidate(req));
    return;
  }

  // THE PAGE ITSELF: network-first, with a short timeout and a cache fallback
  // (v2.13.4). It used to be cache-first with no revalidation, which is exactly
  // how a phone gets pinned to an old version: the cached page is served
  // forever, and a new worker only takes over if the page it is serving decides
  // to reload — so any hiccup in that handshake froze the app on whatever
  // version it happened to be holding, with nothing on screen to say so.
  //
  // A navigation now asks the network first and falls back to the cache after
  // NAV_TIMEOUT_MS or on failure, so a phone with signal always gets the newest
  // page and a phone without one still opens instantly. Every OTHER asset —
  // icons, the manifest — stays cache-first: they are big, they almost never
  // change, and they are not what carries the version.
  if (url.origin === self.location.origin) {
    event.respondWith(req.mode === 'navigate' ? pageNetworkFirst(req) : shellCacheFirst(req));
  }
});

/** How long a navigation waits for the network before falling back to the saved
 *  copy. Short on purpose: the point is a fresh version when the signal allows,
 *  never a phone staring at a blank screen because the signal is poor. */
const NAV_TIMEOUT_MS = 2500;

async function fontStaleWhileRevalidate(req) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await refresh) || Response.error();
}

async function pageNetworkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  let timer = null;
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('slow')), NAV_TIMEOUT_MS); })
    ]);
    if (res && res.ok) cache.put('./index.html', res.clone());
    return res;
  } catch (err) {
    // No signal, or too slow to wait for: the saved copy, which is the whole
    // reason this app works at the stall at all.
    const hit = (await cache.match(req, { ignoreSearch: true })) ||
                (await cache.match('./index.html'));
    if (hit) return hit;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shellCacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

// Persistent read-only capability: survives worker suspension and app updates.
// The shop's API write token is deliberately never stored in this worker.
function pushSettingsURL(){return new URL('__stock_alert_settings__',self.registration.scope).href;}
function validPushSettings(d){
  return d && /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(d.apiUrl || '') &&
    /^[A-Za-z0-9_-]{43}$/.test(d.id || '') && /^[a-f0-9]{64}$/.test(d.readToken || '');
}
self.addEventListener('message',event=>{
  if(!event.data || event.data.type!=='stock-alert-settings')return;
  const port=event.ports && event.ports[0];
  event.waitUntil((async()=>{
    try{
      if(!event.source || !event.source.url || !event.source.url.startsWith(self.registration.scope))throw new Error('Unknown app');
      const d=event.data.data;
      if(d===null)await caches.delete(PUSH_SETTINGS_CACHE);
      else{
        if(!validPushSettings(d))throw new Error('Invalid registration');
        const cache=await caches.open(PUSH_SETTINGS_CACHE);
        await cache.put(pushSettingsURL(),new Response(JSON.stringify({apiUrl:d.apiUrl,id:d.id,readToken:d.readToken}),{headers:{'Content-Type':'application/json'}}));
      }
      if(port)port.postMessage({ok:true});
    }catch(_){if(port)port.postMessage({ok:false});}
  })());
});
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let notice={title:'Octogo stock alert',body:'Open Octogo to check your latest supply counts.'};
    let timer;
    try{
      const cache=await caches.open(PUSH_SETTINGS_CACHE), saved=await cache.match(pushSettingsURL());
      const d=saved?await saved.json():null;
      if(!validPushSettings(d))throw new Error('Registration missing');
      const controller=new AbortController();timer=setTimeout(()=>controller.abort(),10000);
      const response=await fetch(d.apiUrl,{method:'POST',redirect:'follow',signal:controller.signal,
        body:JSON.stringify({action:'pushNotice',payload:{id:d.id,readToken:d.readToken}})});
      const result=await response.json();
      if(response.ok && result.ok && result.data && typeof result.data.title==='string' && typeof result.data.body==='string')
        notice={title:result.data.title.slice(0,100),body:result.data.body.slice(0,400)};
    }catch(_){/* Show a useful alert even if the follow-up fetch is offline. */}
    finally{clearTimeout(timer);}
    await self.registration.showNotification(notice.title,{
      body:notice.body,icon:new URL('icon-192.png',self.registration.scope).href,
      tag:'octogo-stock',renotify:true,data:{view:'stock'}
    });
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(c=>c.url.startsWith(self.registration.scope));
    if(existing){await existing.focus();existing.postMessage({type:'open-stock'});}
    else await self.clients.openWindow(new URL('?view=stock',self.registration.scope).href);
  })());
});
