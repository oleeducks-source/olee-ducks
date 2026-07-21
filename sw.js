// Service worker : stratégie "réseau en premier". Chaque fichier de
// l'application est TOUJOURS récupéré en ligne quand une connexion est
// disponible (donc toute mise à jour du code apparaît immédiatement à la
// prochaine ouverture), et la version en cache ne sert que de secours en
// cas de coupure réseau. Les données métier, elles, sont gérées par la
// persistance hors-ligne de Firestore (voir firebase-config.js).
//
// IMPORTANT : le numéro de version ci-dessous doit être incrémenté à
// chaque mise à jour de ce fichier pour forcer le navigateur à détecter
// un nouveau service worker et à vider l'ancien cache.
const CACHE_NAME = "oleeducks-shell-v3";
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
  "./js/comptabilite.js",
  "./js/pieces-jointes.js",
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
  // Ne jamais intercepter les appels Firebase/Google : ils doivent
  // toujours passer par le réseau (ou la persistance IndexedDB de Firestore).
  if (url.hostname.includes("firestore") || url.hostname.includes("googleapis") || url.hostname.includes("google.com") || url.hostname.includes("gstatic.com") || url.hostname.includes("cdnjs.cloudflare.com")) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Toujours mettre à jour le cache avec la version fraîche obtenue.
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request)) // hors-ligne uniquement : repli sur le cache
  );
});
