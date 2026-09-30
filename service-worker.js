/* Kanji + Words GitHub Pages release v22 */
importScripts("./config-live.js?v=22");

const SHELL_CACHE = `${CONFIG.CACHE_VERSION}-shell`;
const IMAGE_CACHE = `${CONFIG.CACHE_VERSION}-images`;
const SHELL = [
  "./", "./index.html", "./manifest.json", "./styles.css?v=23",
  "./config-live.js?v=22", "./app-card.js?v=22", "./storage.js?v=22", "./scheduler.js?v=22", "./quiz-engine.mjs?v=22", "./data-sync.mjs?v=22",
  "./icons/icon-48.png", "./icons/icon-72.png", "./icons/icon-96.png", "./icons/icon-128.png",
  "./icons/icon-144.png", "./icons/icon-152.png", "./icons/icon-180.png", "./icons/icon-192.png",
  "./icons/icon-384.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"
];

self.addEventListener("install", event => event.waitUntil(
  caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
));

self.addEventListener("activate", event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => ![SHELL_CACHE, IMAGE_CACHE].includes(key)).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.href.startsWith(CONFIG.API_URL)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) caches.open(SHELL_CACHE).then(cache => cache.put("./index.html", response.clone()));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  if (request.destination === "image") {
    event.respondWith(caches.open(IMAGE_CACHE).then(async cache => {
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return new Response("", { status: 504, statusText: "Offline" });
      }
    }));
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && url.origin === self.location.origin) {
        caches.open(SHELL_CACHE).then(cache => cache.put(request, response.clone()));
      }
      return response;
    }))
  );
});
