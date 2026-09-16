// ============================================================
// Prestahelp — lógica de la app
// Offline-first: Firestore guarda todo en el teléfono primero
// (persistencia local) y sincroniza solo cuando hay internet.
// ============================================================

import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  browserLocalPersistence,
  setPersistence,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Firestore con caché local persistente (IndexedDB en el teléfono).
// Esto es lo que permite que la app funcione sin internet: todas las
// lecturas/escrituras van primero al caché local y se sincronizan
// solas en cuanto vuelve la señal.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager({}) }),
});

await setPersistence(auth, browserLocalPersistence);

// ------------------------------------------------------------
// Definición de los planes de pago
// ------------------------------------------------------------
const PLANES = {
  "24dias": { nombre: "24 días (diario)", numCuotas: 24, periodoDias: 1 },
  "8semanas": { nombre: "8 semanas (semanal)", numCuotas: 8, periodoDias: 7 },
  "4semanas": { nombre: "4 semanas (semanal)", numCuotas: 4, periodoDias: 7 },
};

function calcularPrestamo({ monto, interesPct, plan }) {
  const montoTotal = Math.round(monto * (1 + interesPct / 100));
  const { numCuotas, periodoDias } = PLANES[plan];
  const valorCuota = Math.round(montoTotal / numCuotas);
  return { montoTotal, numCuotas, periodoDias, valorCuota };
}

// ------------------------------------------------------------
// Formato de números y fechas (todo en "unidades de mil" con
// separador de miles, excepto el teléfono, que se deja tal cual)
// ------------------------------------------------------------
function miles(n) {
  return Math.round(n).toLocaleString("es-VE");
}

function fechaISO(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function sumarDias(fechaBase, dias) {
  const d = new Date(fechaBase + "T00:00:00");
  d.setDate(d.getDate() + dias);
  return fechaISO(d);
}

function formatoBonito(fechaISOStr) {
  if (!fechaISOStr) return "";
  const [y, m, d] = fechaISOStr.split("-");
  return `${d}/${m}/${y}`;
}

// ID determinístico por número de cuota: marcar/desmarcar la misma
// cuota siempre escribe o borra el mismo documento — así nunca se
// duplica un pago, sea cual sea el orden en que se marquen o el
// número de veces que se reintente por cortes de señal.
function idCuota(numero) {
  return "cuota_" + String(numero).padStart(2, "0");
}

// Fecha "nominal" de una cuota: la fecha en la que le tocaría caer
// según el plan, contando desde la fecha de inicio.
function fechaNominalCuota(fechaInicio, periodoDias, numero) {
  return sumarDias(fechaInicio, (numero - 1) * periodoDias);
}

// Deja solo dígitos en el teléfono para armar el link de WhatsApp
// (el número en sí NUNCA se le pone formato de miles).
function soloDigitos(telefono) {
  return (telefono || "").replace(/\D/g, "");
}

function linkWhatsapp(telefono, nombreCliente) {
  const digitos = soloDigitos(telefono);
  if (!digitos) return null;
  const mensaje = encodeURIComponent(`Hola ${nombreCliente || ""}, te escribo de parte de Prestahelp sobre tu préstamo.`);
  return `https://wa.me/${digitos}?text=${mensaje}`;
}

// Con el conjunto de cuotas ya pagadas, calcula la próxima cuota
// pendiente (la primera que falte, no necesariamente la siguiente en
// número si alguna quedó desmarcada) y en qué categoría cae el
// cliente: atrasado / hoy / mañana / al día / completado.
function clasificarPrestamo(p, pagadasSet) {
  let proximaCuota = null;
  for (let n = 1; n <= p.numCuotas; n++) {
    if (!pagadasSet.has(n)) {
      proximaCuota = n;
      break;
    }
  }
  const pagados = pagadasSet.size;

  if (proximaCuota === null) {
    return { categoria: "completado", pagados, proximaCuota: null, proximaFecha: null };
  }

  const proximaFecha = fechaNominalCuota(p.fechaInicio, p.periodoDias, proximaCuota);
  const hoy = fechaISO(new Date());
  const manana = sumarDias(hoy, 1);

  let categoria;
  if (proximaFecha < hoy) categoria = "atrasado";
  else if (proximaFecha === hoy) categoria = "hoy";
  else if (proximaFecha === manana) categoria = "manana";
  else categoria = "al_dia";

  return { categoria, pagados, proximaCuota, proximaFecha };
}

const SECCIONES = [
  { key: "atrasado", titulo: "Atrasados" },
  { key: "hoy", titulo: "Cobrar hoy" },
  { key: "manana", titulo: "Cobrar mañana" },
  { key: "al_dia", titulo: "Al día" },
  { key: "completado", titulo: "Completados" },
];

// ------------------------------------------------------------
// Estado en memoria
// ------------------------------------------------------------
let cobradorId = null;
let unsubPrestamos = null;
let unsubDetalle = null;
// Un préstamo por entrada: { p, pagadasSet, cargado, unsubPagos }
const prestamos = new Map();

// ------------------------------------------------------------
// Referencias del DOM
// ------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const vistaLogin = $("#vista-login");
const vistaApp = $("#vista-app");
const formLogin = $("#form-login");
const loginError = $("#login-error");
const btnSalir = $("#btn-salir");
const listaPrestamos = $("#lista-prestamos");
const badgeConexion = $("#badge-conexion");
const formNuevoPrestamo = $("#form-nuevo-prestamo");
const previewCalculo = $("#preview-calculo");
const modalNuevo = $("#modal-nuevo-prestamo");
const btnNuevo = $("#btn-nuevo-prestamo");
const btnCerrarModal = $("#btn-cerrar-modal");
const vistaDetalle = $("#vista-detalle");
const btnVolverLista = $("#btn-volver-lista");
const npFechaInicio = $("#np-fecha-inicio");
const npFechaFin = $("#np-fecha-fin");

// ------------------------------------------------------------
// Indicador de conexión (solo informativo — la app funciona
// exactamente igual online u offline, esto es solo para que el
// cobrador sepa si sus datos ya subieron o siguen pendientes)
// ------------------------------------------------------------
function actualizarBadgeConexion() {
  if (navigator.onLine) {
    badgeConexion.textContent = "En línea";
    badgeConexion.className = "badge badge-online";
  } else {
    badgeConexion.textContent = "Sin conexión — guardando en el teléfono";
    badgeConexion.className = "badge badge-offline";
  }
}
window.addEventListener("online", actualizarBadgeConexion);
window.addEventListener("offline", actualizarBadgeConexion);
actualizarBadgeConexion();

// ------------------------------------------------------------
// Autenticación
// ------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  if (user) {
    cobradorId = user.uid;
    vistaLogin.classList.add("oculto");
    vistaApp.classList.remove("oculto");
    suscribirPrestamos();
  } else {
    cobradorId = null;
    vistaApp.classList.add("oculto");
    vistaDetalle.classList.add("oculto");
    vistaLogin.classList.remove("oculto");
    if (unsubPrestamos) unsubPrestamos();
    if (unsubDetalle) unsubDetalle();
    limpiarPrestamos();
  }
});

formLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const email = $("#login-email").value.trim();
  const pass = $("#login-pass").value;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    loginError.textContent = traducirErrorAuth(err);
  }
});

btnSalir.addEventListener("click", () => signOut(auth));

function traducirErrorAuth(err) {
  const code = err.code || "";
  if (code.includes("wrong-password") || code.includes("invalid-credential")) return "Correo o clave incorrectos.";
  if (code.includes("user-not-found")) return "No existe una cuenta con ese correo. Pide que te la creen.";
  if (code.includes("network-request-failed")) return "Sin conexión para iniciar sesión por primera vez. Necesitas internet la primera vez que entras en un teléfono nuevo.";
  return "No se pudo completar la operación (" + code + ").";
}

// ------------------------------------------------------------
// Nuevo préstamo
// ------------------------------------------------------------
btnNuevo.addEventListener("click", () => {
  formNuevoPrestamo.reset();
  npFechaInicio.value = fechaISO(new Date());
  npFechaFin.value = "";
  previewCalculo.textContent = "";
  modalNuevo.classList.remove("oculto");
});
btnCerrarModal.addEventListener("click", () => modalNuevo.classList.add("oculto"));

function leerFormularioPrestamo() {
  const monto = parseFloat($("#np-monto").value);
  const interesPct = parseFloat($("#np-interes").value);
  const plan = $("#np-plan").value;
  const fechaInicio = npFechaInicio.value || fechaISO(new Date());
  return { monto, interesPct, plan, fechaInicio };
}

function actualizarPreview() {
  const { monto, interesPct, plan, fechaInicio } = leerFormularioPrestamo();
  if (!monto || isNaN(interesPct) || !plan) {
    previewCalculo.textContent = "";
    npFechaFin.value = "";
    return;
  }
  const { montoTotal, numCuotas, periodoDias, valorCuota } = calcularPrestamo({ monto, interesPct, plan });
  npFechaFin.value = sumarDias(fechaInicio, numCuotas * periodoDias);
  previewCalculo.textContent =
    `Total a pagar: ${miles(montoTotal)} — ${numCuotas} cuotas de ${miles(valorCuota)} cada una`;
}
["np-monto", "np-interes", "np-plan", "np-fecha-inicio"].forEach((id) =>
  $("#" + id).addEventListener("input", actualizarPreview)
);

formNuevoPrestamo.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nombreCliente = $("#np-nombre").value.trim();
  const codigoPais = $("#np-tel-codigo").value;
  const telefonoCliente = codigoPais + soloDigitos($("#np-telefono").value);
  const { monto, interesPct, plan, fechaInicio } = leerFormularioPrestamo();
  if (!nombreCliente || !monto || isNaN(interesPct) || !plan) return;

  const { montoTotal, numCuotas, periodoDias, valorCuota } = calcularPrestamo({ monto, interesPct, plan });

  // ID determinístico para el préstamo también evita duplicados si el
  // formulario se reenvía por error mientras no hay señal.
  const prestamoId = `prestamo_${cobradorId}_${Date.now()}`;
  const ref = doc(db, "cobradores", cobradorId, "prestamos", prestamoId);

  await setDoc(ref, {
    clienteNombre: nombreCliente,
    clienteTelefono: telefonoCliente,
    monto,
    interesPct,
    montoTotal,
    plan,
    numCuotas,
    periodoDias,
    valorCuota,
    fechaInicio,
    estado: "activo",
    creadoEn: serverTimestamp(),
  });

  modalNuevo.classList.add("oculto");
});

// ------------------------------------------------------------
// Lista de préstamos, dividida en secciones (atrasados / hoy /
// mañana / al día / completados) — todo en tiempo real, incluso
// con la caché offline.
// ------------------------------------------------------------
function limpiarPrestamos() {
  prestamos.forEach((entry) => entry.unsubPagos && entry.unsubPagos());
  prestamos.clear();
}

function suscribirPrestamos() {
  const q = query(
    collection(db, "cobradores", cobradorId, "prestamos"),
    orderBy("creadoEn", "desc")
  );
  unsubPrestamos = onSnapshot(q, (snap) => {
    const idsVistos = new Set();
    snap.forEach((docSnap) => {
      const id = docSnap.id;
      idsVistos.add(id);
      const p = docSnap.data();
      if (!prestamos.has(id)) {
        const entry = { p, pagadasSet: new Set(), cargado: false, unsubPagos: null };
        prestamos.set(id, entry);
        entry.unsubPagos = onSnapshot(
          collection(db, "cobradores", cobradorId, "prestamos", id, "pagos"),
          (pagosSnap) => {
            const nuevoSet = new Set();
            pagosSnap.forEach((d) => {
              const n = parseInt(d.id.replace("cuota_", ""), 10);
              if (!isNaN(n)) nuevoSet.add(n);
            });
            entry.pagadasSet = nuevoSet;
            entry.cargado = true;
            renderLista();
          }
        );
      } else {
        prestamos.get(id).p = p;
      }
    });
    // Limpia préstamos que ya no están (por si se borra uno)
    for (const id of Array.from(prestamos.keys())) {
      if (!idsVistos.has(id)) {
        const entry = prestamos.get(id);
        if (entry.unsubPagos) entry.unsubPagos();
        prestamos.delete(id);
      }
    }
    renderLista();
  });
}

// Nombres con los que se identifica al mismo cliente aunque tenga
// varios préstamos (activos o ya completados) — así en la lista
// aparece UNA sola vez, y se despliega al tocar su nombre.
const ORDEN_URGENCIA = ["atrasado", "hoy", "manana", "al_dia", "completado"];
const clientesExpandidos = new Set();

function claveCliente(p) {
  return (p.clienteNombre || "").trim().toLowerCase();
}

function estadoTexto(clasif, p) {
  if (clasif.categoria === "completado") {
    return `✅ Completado (${clasif.pagados}/${p.numCuotas})`;
  }
  const etiqueta =
    clasif.categoria === "atrasado" ? "Atrasado desde" :
    clasif.categoria === "hoy" ? "Cobrar hoy" :
    clasif.categoria === "manana" ? "Cobrar mañana" : "Próximo cobro";
  return `${etiqueta}: ${formatoBonito(clasif.proximaFecha)} · Cuota ${clasif.proximaCuota}/${p.numCuotas}`;
}

function renderLista() {
  const porCliente = new Map(); // clave -> { nombre, items: [{id, p, clasif}] }
  let hayCargando = false;

  prestamos.forEach((entry, id) => {
    if (!entry.cargado) { hayCargando = true; return; }
    const clasif = clasificarPrestamo(entry.p, entry.pagadasSet);
    const clave = claveCliente(entry.p);
    if (!porCliente.has(clave)) porCliente.set(clave, { nombre: entry.p.clienteNombre, items: [] });
    porCliente.get(clave).items.push({ id, p: entry.p, clasif });
  });

  // A cada cliente le asigna la sección de su préstamo más urgente
  // (si tiene varios), así nunca queda "escondido" en Completados
  // mientras tenga algo pendiente en otro préstamo.
  const seccionesClientes = { atrasado: [], hoy: [], manana: [], al_dia: [], completado: [] };
  porCliente.forEach((cliente, clave) => {
    let mejor = "completado";
    cliente.items.forEach(({ clasif }) => {
      if (ORDEN_URGENCIA.indexOf(clasif.categoria) < ORDEN_URGENCIA.indexOf(mejor)) mejor = clasif.categoria;
    });
    seccionesClientes[mejor].push({ clave, cliente });
  });

  listaPrestamos.innerHTML = "";

  if (prestamos.size === 0) {
    listaPrestamos.innerHTML = `<p class="vacio">Todavía no tienes préstamos. Toca "+ Nuevo préstamo" para crear el primero.</p>`;
    return;
  }

  SECCIONES.forEach(({ key, titulo }) => {
    const items = seccionesClientes[key];
    if (!items || items.length === 0) return;

    const h = document.createElement("div");
    h.className = `seccion-titulo seccion-${key}`;
    h.innerHTML = `<span class="punto"></span> ${titulo} <span class="cuenta">(${items.length})</span>`;
    listaPrestamos.appendChild(h);

    items.forEach(({ clave, cliente }) => {
      listaPrestamos.appendChild(renderFilaCliente(clave, cliente));
    });
  });

  if (hayCargando && listaPrestamos.innerHTML === "") {
    listaPrestamos.innerHTML = `<p class="vacio">Cargando…</p>`;
  }
}

function renderFilaCliente(clave, cliente) {
  const expandido = clientesExpandidos.has(clave);
  const wrap = document.createElement("div");
  wrap.className = "cliente-grupo";

  const cabecera = document.createElement("div");
  cabecera.className = "cliente-cabecera";
  const resumen = cliente.items.length === 1
    ? estadoTexto(cliente.items[0].clasif, cliente.items[0].p)
    : `${cliente.items.length} préstamos`;
  cabecera.innerHTML = `
    <span class="cliente-flecha">${expandido ? "▾" : "▸"}</span>
    <strong class="cliente-nombre">${cliente.nombre}</strong>
    <span class="cliente-resumen">${resumen}</span>
  `;
  cabecera.addEventListener("click", () => {
    if (expandido) clientesExpandidos.delete(clave);
    else clientesExpandidos.add(clave);
    renderLista();
  });
  wrap.appendChild(cabecera);

  if (expandido) {
    cliente.items.forEach(({ id, p, clasif }) => {
      wrap.appendChild(renderTarjetaPrestamo(id, p, clasif));
    });
  }

  return wrap;
}

function renderTarjetaPrestamo(id, p, clasif) {
  const div = document.createElement("div");
  div.className = `tarjeta ${clasif.categoria}`;
  const wa = linkWhatsapp(p.clienteTelefono, p.clienteNombre);
  const lineaEstado = estadoTexto(clasif, p);

  div.innerHTML = `
    <div class="tarjeta-header">
      <strong>${p.clienteNombre}</strong>
      <span class="plan-chip">${PLANES[p.plan]?.nombre ?? p.plan}</span>
    </div>
    <div class="tarjeta-info">Monto: ${miles(p.monto)} · Total: ${miles(p.montoTotal)} · Cuota: ${miles(p.valorCuota)}</div>
    <div class="tarjeta-info">${lineaEstado}</div>
    <div class="tarjeta-acciones">
      ${clasif.categoria !== "completado" ? `<button type="button" class="btn btn-pagar" data-id="${id}">Marcar cuota ${clasif.proximaCuota}</button>` : ""}
      <button type="button" class="btn btn-secundario" data-ver="${id}">Ver cronograma</button>
      ${wa ? `<a class="btn btn-whatsapp" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
      <button type="button" class="btn btn-eliminar" data-eliminar="${id}">Eliminar</button>
    </div>
  `;
  const btnPagar = div.querySelector(".btn-pagar");
  if (btnPagar) {
    btnPagar.addEventListener("click", () => marcarCuota(id, clasif.proximaCuota, p.valorCuota));
  }
  div.querySelector("[data-ver]").addEventListener("click", () => mostrarDetalle(id, p));
  div.querySelector("[data-eliminar]").addEventListener("click", () => eliminarPrestamo(id, p.clienteNombre));
  return div;
}

// ------------------------------------------------------------
// Eliminar un préstamo por completo (por si se creó por error).
// Borra primero todas sus cuotas guardadas y después el préstamo,
// para no dejar datos sueltos en Firestore.
// ------------------------------------------------------------
async function eliminarPrestamo(prestamoId, nombreCliente) {
  const ok = confirm(`¿Eliminar el préstamo de ${nombreCliente}? Esto borra también todo su historial de pagos y no se puede deshacer.`);
  if (!ok) return;

  const pagosRef = collection(db, "cobradores", cobradorId, "prestamos", prestamoId, "pagos");
  const pagosSnap = await getDocs(pagosRef);
  await Promise.all(pagosSnap.docs.map((d) => deleteDoc(d.ref)));

  await deleteDoc(doc(db, "cobradores", cobradorId, "prestamos", prestamoId));
}

// ------------------------------------------------------------
// Marcar / desmarcar una cuota. El ID del documento es siempre el
// mismo para una cuota dada, así que marcarla dos veces (por un
// reintento offline) no duplica nada, y desmarcarla simplemente
// borra ese mismo documento — que es exactamente lo mismo que
// "eliminar el pago" en caso de un error.
// ------------------------------------------------------------
async function marcarCuota(prestamoId, numero, valorCuota) {
  const ref = doc(db, "cobradores", cobradorId, "prestamos", prestamoId, "pagos", idCuota(numero));
  await setDoc(ref, {
    numero,
    monto: valorCuota,
    registradoEn: serverTimestamp(),
  });
}

async function desmarcarCuota(prestamoId, numero) {
  const ref = doc(db, "cobradores", cobradorId, "prestamos", prestamoId, "pagos", idCuota(numero));
  await deleteDoc(ref);
}

// ------------------------------------------------------------
// Detalle / cronograma completo de un préstamo
// ------------------------------------------------------------
btnVolverLista.addEventListener("click", () => {
  vistaDetalle.classList.add("oculto");
  vistaApp.classList.remove("oculto");
  if (unsubDetalle) unsubDetalle();
});

function mostrarDetalle(prestamoId, p) {
  if (unsubDetalle) unsubDetalle();
  vistaApp.classList.add("oculto");
  vistaDetalle.classList.remove("oculto");
  $("#detalle-titulo").textContent = p.clienteNombre;
  $("#detalle-info").textContent =
    `Plan: ${PLANES[p.plan]?.nombre} · Monto: ${miles(p.monto)} · Interés: ${p.interesPct}% · Total: ${miles(p.montoTotal)} · Inicio: ${formatoBonito(p.fechaInicio)}`;

  const contWa = $("#detalle-whatsapp-cont");
  const wa = linkWhatsapp(p.clienteTelefono, p.clienteNombre);
  contWa.innerHTML = wa
    ? `<a class="btn btn-whatsapp grande" href="${wa}" target="_blank" rel="noopener">Escribirle por WhatsApp</a>`
    : "";

  const contCuotas = $("#detalle-cuotas");
  const contResumen = $("#detalle-resumen");
  contCuotas.innerHTML = "Cargando…";

  unsubDetalle = onSnapshot(
    collection(db, "cobradores", cobradorId, "prestamos", prestamoId, "pagos"),
    (snap) => {
      const pagadasSet = new Set();
      snap.forEach((d) => {
        const n = parseInt(d.id.replace("cuota_", ""), 10);
        if (!isNaN(n)) pagadasSet.add(n);
      });

      const clasif = clasificarPrestamo(p, pagadasSet);
      contResumen.textContent =
        clasif.categoria === "completado"
          ? `Préstamo completado — ${pagadasSet.size}/${p.numCuotas} cuotas pagadas`
          : `${pagadasSet.size}/${p.numCuotas} cuotas pagadas · Próxima: cuota ${clasif.proximaCuota} (${formatoBonito(clasif.proximaFecha)})`;

      const hoy = fechaISO(new Date());
      contCuotas.innerHTML = "";
      for (let n = 1; n <= p.numCuotas; n++) {
        const pagada = pagadasSet.has(n);
        const fechaNom = fechaNominalCuota(p.fechaInicio, p.periodoDias, n);
        const atrasada = !pagada && fechaNom < hoy;

        const fila = document.createElement("div");
        fila.className = `cuota-fila ${pagada ? "pagada" : atrasada ? "atrasada" : "pendiente"}`;
        fila.innerHTML = `
          <span class="cuota-num">#${n}</span>
          <span class="cuota-fecha">${formatoBonito(fechaNom)}</span>
          <span class="cuota-estado">${pagada ? "✓ Pagada" : atrasada ? "Atrasada" : "Pendiente"}</span>
        `;
        fila.addEventListener("click", () => {
          if (pagada) desmarcarCuota(prestamoId, n);
          else marcarCuota(prestamoId, n, p.valorCuota);
        });
        contCuotas.appendChild(fila);
      }
    }
  );
}

// ------------------------------------------------------------
// Registro del service worker (app shell offline)
// ------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.error);
  });
}
