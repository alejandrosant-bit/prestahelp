// Service worker: guarda el "cascarón" de la app (HTML/CSS/JS) en el
// teléfono para que abra al instante y SIN internet. Los DATOS
// (préstamos, pagos) NO pasan por aquí — de eso se encarga la caché
// local de Firestore, que los guarda en el teléfono y los sube sola en
// cuanto vuelve la conexión.
//
// IMPORTANTE: cada vez que se cambie cualquier archivo de la app hay que
// subir este número, así los teléfonos bajan la versión nueva.
const CACHE_NAME = "prestahelp-v17";
const ARCHIVOS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  // El SDK de Firebase se importa como módulo en app.js: sin guardarlo
  // aquí, la app no podría arrancar sin conexión.
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js",
];

// Netlify redirige "/index.html" a "/". Una respuesta que vino de una
// redirección NO se puede usar para abrir la app desde la caché (el
// navegador la rechaza y muestra "sin conexión"), así que la guardamos
// "limpia", como si hubiera venido directo.
async function respuestaLimpia(resp) {
  if (!resp.redirected) return resp;
  const cuerpo = await resp.blob();
  return new Response(cuerpo, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cada archivo por separado: si uno falla, los demás igual quedan.
      Promise.allSettled(
        ARCHIVOS.map(async (archivo) => {
          try {
            const resp = await fetch(archivo, { cache: "reload" });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            await cache.put(archivo, await respuestaLimpia(resp));
          } catch (err) {
            console.warn("No se pudo guardar:", archivo, err);
          }
        })
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((nombres) =>
        Promise.all(nombres.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

async function cascaronGuardado() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match("./")) || (await cache.match("./index.html"));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Las llamadas de DATOS a Firebase nunca pasan por aquí: van directo
  // a la red y, si no hay señal, Firestore las guarda en su propia cola
  // dentro del teléfono y las sube después.
  if (
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("firebaseapp.com")
  ) {
    return;
  }

  // Abrir la app (el acceso directo): se responde PRIMERO con la copia
  // guardada en el teléfono, sin esperar a la red. Así abre igual con
  // señal nula o muy débil (con señal débil la red se queda "pensando"
  // y la app parecía no abrir).
  if (req.mode === "navigate") {
    event.respondWith(
      cascaronGuardado().then(
        (guardado) =>
          guardado ||
          fetch(req).catch(
            () => new Response("Sin conexión. Abre la app una vez con internet.", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
          )
      )
    );
    return;
  }

  // Resto de archivos (CSS, JS, íconos, SDK de Firebase): primero la
  // copia guardada; si no está, se busca en la red y se guarda.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((guardado) => {
      if (guardado) return guardado;
      return fetch(req).then((resp) => {
        if (resp && resp.ok && (url.origin === self.location.origin || url.hostname.includes("gstatic.com"))) {
          const copia = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copia)).catch(() => {});
        }
        return resp;
      });
    })
  );
});
