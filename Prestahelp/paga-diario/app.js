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
  const d = new Date(fechaBase);
  d.setDate(d.getDate() + dias);
  return d;
}

function formatoBonito(fechaISOStr) {
  if (!fechaISOStr) return "";
  const [y, m, d] = fechaISOStr.split("-");
  return `${d}/${m}/${y}`;
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

// ------------------------------------------------------------
// Estado en memoria
// ------------------------------------------------------------
let cobradorId = null;
let unsubPrestamos = null;
let unsubDetalle = null;
// listeners de progreso de cada tarjeta (para poder cerrarlos al
// re-renderizar la lista y que no se acumulen)
let unsubsProgreso = [];

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
    limpiarListenersProgreso();
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
  const vencimiento = sumarDias(fechaInicio, numCuotas * periodoDias);
  npFechaFin.value = fechaISO(vencimiento);
  previewCalculo.textContent =
    `Total a pagar: ${miles(montoTotal)} — ${numCuotas} cuotas de ${miles(valorCuota)} cada una`;
}
["np-monto", "np-interes", "np-plan", "np-fecha-inicio"].forEach((id) =>
  $("#" + id).addEventListener("input", actualizarPreview)
);

formNuevoPrestamo.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nombreCliente = $("#np-nombre").value.trim();
  const telefonoCliente = $("#np-telefono").value.trim();
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
// Lista de préstamos (tiempo real, funciona con caché offline)
// ------------------------------------------------------------
function limpiarListenersProgreso() {
  unsubsProgreso.forEach((fn) => fn());
  unsubsProgreso = [];
}

function suscribirPrestamos() {
  const q = query(
    collection(db, "cobradores", cobradorId, "prestamos"),
    orderBy("creadoEn", "desc")
  );
  unsubPrestamos = onSnapshot(q, (snap) => {
    limpiarListenersProgreso();
    listaPrestamos.innerHTML = "";
    snap.forEach((docSnap) => {
      const p = docSnap.data();
      listaPrestamos.appendChild(renderTarjetaPrestamo(docSnap.id, p));
    });
    if (snap.empty) {
      listaPrestamos.innerHTML = `<p class="vacio">Todavía no tienes préstamos. Toca "+ Nuevo préstamo" para crear el primero.</p>`;
    }
  });
}

function renderTarjetaPrestamo(id, p) {
  const div = document.createElement("div");
  div.className = "tarjeta";
  const wa = linkWhatsapp(p.clienteTelefono, p.clienteNombre);
  div.innerHTML = `
    <div class="tarjeta-header">
      <strong>${p.clienteNombre}</strong>
      <span class="plan-chip">${PLANES[p.plan]?.nombre ?? p.plan}</span>
    </div>
    <div class="tarjeta-info">Monto: ${miles(p.monto)} · Total: ${miles(p.montoTotal)} · Cuota: ${miles(p.valorCuota)}</div>
    <div class="tarjeta-info">Inicio: ${formatoBonito(p.fechaInicio)}</div>
    <div class="tarjeta-info" data-progreso>Cargando progreso…</div>
    <div class="tarjeta-acciones">
      <button type="button" class="btn btn-pagar" data-id="${id}">Marcar pago de hoy</button>
      <button type="button" class="btn btn-secundario" data-ver="${id}">Ver historial</button>
      ${wa ? `<a class="btn btn-whatsapp" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
    </div>
  `;
  const elProgreso = div.querySelector("[data-progreso]");
  const btnPagar = div.querySelector(".btn-pagar");
  suscribirProgreso(id, p, elProgreso, btnPagar);
  btnPagar.addEventListener("click", () => marcarPagoHoy(id, p));
  div.querySelector("[data-ver]").addEventListener("click", () => mostrarDetalle(id, p));
  return div;
}

// Progreso en tiempo real: se suscribe a la subcolección de pagos, así
// que en cuanto se marca un pago (aunque sea offline) el contador y el
// botón se actualizan solos sin tener que recargar nada.
function suscribirProgreso(prestamoId, p, elProgreso, btnPagar) {
  const hoyId = fechaISO(new Date());
  const unsub = onSnapshot(
    collection(db, "cobradores", cobradorId, "prestamos", prestamoId, "pagos"),
    (snap) => {
      const pagados = snap.size;
      const yaPagoHoy = snap.docs.some((d) => d.id === hoyId);
      const faltantes = Math.max(p.numCuotas - pagados, 0);
      const vencimientoEstimado = fechaISO(sumarDias(new Date(), faltantes * p.periodoDias));

      if (faltantes === 0) {
        elProgreso.textContent = `✅ Préstamo completado (${pagados}/${p.numCuotas})`;
        btnPagar.disabled = true;
        btnPagar.textContent = "Completado";
      } else {
        elProgreso.textContent = `Cuotas: ${pagados}/${p.numCuotas} · Vence aprox. ${formatoBonito(vencimientoEstimado)}`;
        btnPagar.disabled = yaPagoHoy;
        btnPagar.textContent = yaPagoHoy ? "✓ Ya pagó hoy" : "Marcar pago de hoy";
      }
    }
  );
  unsubsProgreso.push(unsub);
}

// ------------------------------------------------------------
// Marcar el pago de hoy — ID determinístico por fecha, así una
// escritura repetida (por reintento de red) sobreescribe el mismo
// documento en lugar de crear un pago duplicado.
// ------------------------------------------------------------
async function marcarPagoHoy(prestamoId, p) {
  const hoyId = fechaISO(new Date());
  const ref = doc(db, "cobradores", cobradorId, "prestamos", prestamoId, "pagos", hoyId);
  await setDoc(ref, {
    monto: p.valorCuota,
    fecha: hoyId,
    registradoEn: serverTimestamp(),
  });
  // el listener de suscribirProgreso se encarga de refrescar la tarjeta sola
}

// ------------------------------------------------------------
// Detalle / historial de un préstamo
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

  const listaHistorial = $("#detalle-historial");
  listaHistorial.innerHTML = "Cargando…";

  unsubDetalle = onSnapshot(
    query(collection(db, "cobradores", cobradorId, "prestamos", prestamoId, "pagos"), orderBy("fecha", "desc")),
    (snap) => {
      listaHistorial.innerHTML = "";
      snap.forEach((d) => {
        const pago = d.data();
        const li = document.createElement("li");
        li.textContent = `${formatoBonito(pago.fecha)} — pagó ${miles(pago.monto)}`;
        listaHistorial.appendChild(li);
      });
      if (snap.empty) listaHistorial.innerHTML = "<li>Sin pagos registrados todavía.</li>";
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
