// Service worker: cachea el "cascarón" de la app (HTML/CSS/JS) para que
// abra instantáneo y sin errores aunque no haya internet. Los DATOS
// (préstamos, pagos) NO pasan por aquí — de eso se encarga la caché
// local de Firestore, que es más robusta para sincronizar y sube todo
// sola en cuanto vuelve la conexión.
const CACHE_NAME = "prestahelp-v6";
const ARCHIVOS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  // El SDK de Firebase se importa como módulo JS normal en app.js.
  // Si no lo guardamos aquí, sin internet esa importación falla y
  // TODA la app deja de funcionar (aunque el resto sí esté en caché).
  // Guardarlo es lo que permite que la app abra 100% sin conexión.
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Guardamos cada archivo por separado: si uno falla (por ejemplo
      // un ícono que no cargó a tiempo) los demás igual quedan
      // guardados. Con cache.addAll() bastaba con que fallara UNO para
      // que no se guardara NADA, y por eso la app no abría sin internet.
      Promise.allSettled(
        ARCHIVOS.map((archivo) =>
          cache.add(archivo).catch((err) => {
            console.warn("No se pudo cachear:", archivo, err);
          })
        )
      )
    )
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
  const req = event.request;
  const url = new URL(req.url);

  // Nunca cachear las llamadas de DATOS a Firebase/Firestore — esas deben
  // ir siempre a la red (o fallar y dejar que Firestore maneje su propia
  // cola offline). El SDK en sí (los archivos .js de gstatic.com) SÍ se
  // cachea más abajo como cualquier otro archivo del cascarón, porque sin
  // él la app ni siquiera arranca sin conexión.
  const esLlamadaDeDatos =
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("googlesyndication.com");
  if (esLlamadaDeDatos) return;

  // Las navegaciones (abrir la app / el acceso directo) son las más
  // importantes de proteger: si Netlify redirige la URL de una forma
  // que no coincide exactamente con lo que guardamos, igual respondemos
  // con el cascarón de la app guardado en caché en vez de mostrar el
  // error "sin conexión" del navegador.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match("./index.html").then((cached) => cached || caches.match("./"))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          // Guardamos también lo que se vaya pidiendo con éxito (por si
          // agregamos archivos nuevos más adelante), sin romper la
          // respuesta si no se puede cachear por algún motivo.
          if (resp && resp.ok && req.method === "GET") {
            const copia = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copia)).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached);
    })
  );
});
