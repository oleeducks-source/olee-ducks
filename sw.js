// Service worker minimal : met en cache la coquille de l'application
// (HTML/CSS/JS) pour un chargement instantané et un fonctionnement
// hors-ligne partiel. Les données métier, elles, sont gérées par la
// persistance hors-ligne de Firestore (voir firebase-config.js).
const CACHE_NAME = "oleeducks-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/app.js",
  "./js/firebase-config.js",
  "./js/utils.js",
  "./js/inventaire.js",
  "./js/nids.js",
  "./js/finances.js",
  "./js/stocks.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Ne jamais mettre en cache les appels Firebase/Firestore : ils doivent
  // toujours passer par le réseau (ou la persistance IndexedDB de Firestore).
  if (url.hostname.includes("firestore") || url.hostname.includes("googleapis") || url.hostname.includes("google.com")) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => cached))
  );
});
