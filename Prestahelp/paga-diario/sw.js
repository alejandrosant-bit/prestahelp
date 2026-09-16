// Service worker: cachea el "cascarón" de la app (HTML/CSS/JS) para que
// abra instantáneo y sin errores aunque no haya internet. Los DATOS
// (préstamos, pagos) NO pasan por aquí — de eso se encarga la caché
// local de Firestore, que es más robusta para sincronizar.
const CACHE_NAME = "prestahelp-v3";
const ARCHIVOS = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(nombres.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Nunca cachear llamadas a Firebase/Firestore — esas deben ir siempre
  // a la red (o fallar y dejar que Firestore maneje su propia cola offline).
  const esFirebase =
    url.hostname.includes("googleapis.com") ||
    (url.hostname.includes("gstatic.com") && url.pathname.includes("firebasejs"));
  if (esFirebase) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
