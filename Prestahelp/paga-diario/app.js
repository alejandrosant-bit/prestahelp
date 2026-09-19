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
// Formato de números y fechas (todo en pesos, con separador de
// miles, excepto el teléfono, que se deja tal cual)
// ------------------------------------------------------------
function miles(n) {
  return "$" + Math.round(n).toLocaleString("es-CO");
}

// ------------------------------------------------------------
// Formato de miles EN VIVO mientras se escribe un monto, para que
// no se pasen o falten ceros al ingresarlo (ej. "$500.000" en vez de
// "500000", donde un cero de más o de menos es fácil de pasar por
// alto). El campo se ve siempre formateado; para calcular se le
// quitan el símbolo y los puntos y se convierte a número.
function formatearInputMiles(valorCrudo) {
  const digitos = (valorCrudo || "").replace(/\D/g, "");
  if (!digitos) return "";
  return "$" + Number(digitos).toLocaleString("es-CO");
}

function numeroDesdeInputMiles(valorFormateado) {
  const digitos = (valorFormateado || "").replace(/\D/g, "");
  return digitos ? Number(digitos) : NaN;
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

// El cobrador nunca cobra los domingos — ese día no cuenta para nada
// del préstamo. Si una fecha cae domingo, se corre al lunes.
function esDomingo(fechaISOStr) {
  return new Date(fechaISOStr + "T00:00:00").getDay() === 0;
}

function saltarDomingo(fechaISOStr) {
  let f = fechaISOStr;
  while (esDomingo(f)) f = sumarDias(f, 1);
  return f;
}

// Fecha "nominal" de una cuota: la fecha en la que le tocaría caer
// según el plan, contando desde la fecha de inicio, saltándose
// siempre los domingos (si un pago cayera domingo, pasa al lunes).
// Se calcula cuota por cuota (no con una sola resta) porque saltar
// domingos no es una simple multiplicación.
function fechaNominalCuota(fechaInicio, periodoDias, numero) {
  let fecha = saltarDomingo(fechaInicio);
  for (let i = 2; i <= numero; i++) {
    fecha = saltarDomingo(sumarDias(fecha, periodoDias));
  }
  return fecha;
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
const modalEditar = $("#modal-editar-prestamo");
const formEditarPrestamo = $("#form-editar-prestamo");
const btnCerrarModalEditar = $("#btn-cerrar-modal-editar");
const previewEditar = $("#preview-editar");
const epFechaInicio = $("#ep-fecha-inicio");
const epFechaFin = $("#ep-fecha-fin");
const btnEditarPrestamo = $("#btn-editar-prestamo");
const vistaBloqueo = $("#vista-bloqueo");
const btnDesbloquear = $("#btn-desbloquear");
const bloqueoError = $("#bloqueo-error");
const btnSeguridad = $("#btn-seguridad");
const modalSeguridad = $("#modal-seguridad");
const btnCerrarSeguridad = $("#btn-cerrar-seguridad");
const chkBloqueoHuella = $("#chk-bloqueo-huella");
const seguridadError = $("#seguridad-error");

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
// Bloqueo con huella / rostro (WebAuthn del propio teléfono).
// Es un bloqueo LOCAL de este dispositivo — no depende de internet ni
// de un servidor: el teléfono es quien verifica la huella, y aquí solo
// se guarda si el cobrador activó el bloqueo y con qué credencial. Así
// aunque la sesión quede guardada, nadie puede abrir la app sin pasar
// por la huella (o el rostro) configurada en el teléfono.
// ------------------------------------------------------------
function claveBloqueo(id) { return `prestahelp_bloqueo_${id}`; }
function claveCredencial(id) { return `prestahelp_credencial_${id}`; }

function bloqueoActivado() {
  return (
    localStorage.getItem(claveBloqueo(cobradorId)) === "1" &&
    !!localStorage.getItem(claveCredencial(cobradorId))
  );
}

async function huellaDisponible() {
  return !!(
    window.PublicKeyCredential &&
    typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function" &&
    (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
  );
}

function bufferABase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ABuffer(b64) {
  const binario = atob(b64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes.buffer;
}

async function registrarHuella() {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Prestahelp" },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: "cobrador",
        displayName: "Cobrador Prestahelp",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60000,
    },
  });
  if (!cred) throw new Error("No se pudo registrar la huella");
  localStorage.setItem(claveCredencial(cobradorId), bufferABase64(cred.rawId));
  localStorage.setItem(claveBloqueo(cobradorId), "1");
}

async function verificarHuella() {
  const idB64 = localStorage.getItem(claveCredencial(cobradorId));
  if (!idB64) return false;
  const asercion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: base64ABuffer(idB64), type: "public-key" }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  return !!asercion;
}

function desactivarBloqueo() {
  localStorage.removeItem(claveBloqueo(cobradorId));
  localStorage.removeItem(claveCredencial(cobradorId));
}

function mostrarBloqueo() {
  vistaApp.classList.add("oculto");
  bloqueoError.textContent = "";
  vistaBloqueo.classList.remove("oculto");
}

function entrarALaApp() {
  vistaBloqueo.classList.add("oculto");
  vistaApp.classList.remove("oculto");
  suscribirPrestamos();
}

btnDesbloquear.addEventListener("click", async () => {
  bloqueoError.textContent = "";
  try {
    const ok = await verificarHuella();
    if (ok) entrarALaApp();
    else bloqueoError.textContent = "No se pudo verificar. Intenta de nuevo.";
  } catch (err) {
    bloqueoError.textContent = "No se pudo verificar la huella. Intenta de nuevo.";
  }
});

btnSeguridad.addEventListener("click", () => {
  seguridadError.textContent = "";
  chkBloqueoHuella.checked = bloqueoActivado();
  modalSeguridad.classList.remove("oculto");
});
btnCerrarSeguridad.addEventListener("click", () => modalSeguridad.classList.add("oculto"));

chkBloqueoHuella.addEventListener("change", async () => {
  seguridadError.textContent = "";
  if (chkBloqueoHuella.checked) {
    if (!(await huellaDisponible())) {
      chkBloqueoHuella.checked = false;
      seguridadError.textContent = "Este teléfono o navegador no tiene huella/rostro configurado.";
      return;
    }
    try {
      await registrarHuella();
    } catch (err) {
      chkBloqueoHuella.checked = false;
      seguridadError.textContent = "No se pudo activar. Intenta de nuevo.";
    }
  } else {
    desactivarBloqueo();
  }
});

// ------------------------------------------------------------
// Autenticación
// ------------------------------------------------------------
onAuthStateChanged(auth, (user) => {
  if (user) {
    cobradorId = user.uid;
    vistaLogin.classList.add("oculto");
    if (bloqueoActivado()) {
      mostrarBloqueo();
    } else {
      vistaApp.classList.remove("oculto");
      suscribirPrestamos();
    }
  } else {
    cobradorId = null;
    vistaApp.classList.add("oculto");
    vistaDetalle.classList.add("oculto");
    vistaBloqueo.classList.add("oculto");
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
// Si el cobrador toca a mano el campo de fecha de finalización, ya no
// se la volvemos a pisar automáticamente cuando cambie el monto, el
// interés o el plan — se respeta lo que él decidió.
let fechaFinTocadaManualmente = false;
npFechaFin.addEventListener("input", () => {
  fechaFinTocadaManualmente = true;
});

btnNuevo.addEventListener("click", () => {
  formNuevoPrestamo.reset();
  npFechaInicio.value = fechaISO(new Date());
  npFechaFin.value = "";
  fechaFinTocadaManualmente = false;
  previewCalculo.textContent = "";
  modalNuevo.classList.remove("oculto");
});
btnCerrarModal.addEventListener("click", () => modalNuevo.classList.add("oculto"));

function leerFormularioPrestamo() {
  const monto = numeroDesdeInputMiles($("#np-monto").value);
  const interesPct = parseFloat($("#np-interes").value);
  const plan = $("#np-plan").value;
  const fechaInicio = npFechaInicio.value || fechaISO(new Date());
  return { monto, interesPct, plan, fechaInicio };
}

// Mientras se escribe el monto, lo reformatea con separador de miles
// en vivo (ej. escribe "500000" y se ve "500.000").
$("#np-monto").addEventListener("input", (e) => {
  e.target.value = formatearInputMiles(e.target.value);
});

function actualizarPreview() {
  const { monto, interesPct, plan, fechaInicio } = leerFormularioPrestamo();
  if (!monto || isNaN(interesPct) || !plan) {
    previewCalculo.textContent = "";
    if (!fechaFinTocadaManualmente) npFechaFin.value = "";
    return;
  }
  const { montoTotal, numCuotas, periodoDias, valorCuota } = calcularPrestamo({ monto, interesPct, plan });
  // Misma lógica que el cronograma real: la fecha de la última cuota,
  // saltándose domingos (el cobrador no cobra ese día). Si el cobrador
  // ya la cambió a mano, no se la volvemos a calcular encima.
  if (!fechaFinTocadaManualmente) {
    npFechaFin.value = fechaNominalCuota(fechaInicio, periodoDias, numCuotas);
  }
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
  // Si el cobrador la dejó en blanco por error, se recalcula sola.
  const fechaFin = npFechaFin.value || fechaNominalCuota(fechaInicio, periodoDias, numCuotas);

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
    fechaFin,
    fechaFinManual: fechaFinTocadaManualmente,
    estado: "activo",
    creadoEn: serverTimestamp(),
  });

  modalNuevo.classList.add("oculto");
});

// ------------------------------------------------------------
// Editar préstamo — el cobrador puede corregir el nombre, teléfono,
// monto, interés, plan o fechas de un cliente después de haberlo
// creado, por si se equivocó o el cliente pidió un cambio. Si cambia
// monto/interés/plan/fecha de inicio, el cronograma se recalcula
// solo; los pagos ya marcados quedan igual (se guardan por número de
// cuota, no se pierden).
// ------------------------------------------------------------
let prestamoEditandoId = null;
let fechaFinEditarTocadaManualmente = false;

// El teléfono se guarda como "códigoDigitos" pegado (ej. "584141234567");
// al editar, intentamos separar de nuevo el código para mostrarlo en el
// selector correcto.
function separarTelefono(telCompleto) {
  const t = telCompleto || "";
  if (t.startsWith("58")) return { codigo: "58", resto: t.slice(2) };
  if (t.startsWith("57")) return { codigo: "57", resto: t.slice(2) };
  return { codigo: "", resto: t };
}

function abrirModalEditar(id, p) {
  prestamoEditandoId = id;
  fechaFinEditarTocadaManualmente = false;
  $("#ep-nombre").value = p.clienteNombre || "";
  const { codigo, resto } = separarTelefono(p.clienteTelefono);
  $("#ep-tel-codigo").value = codigo;
  $("#ep-telefono").value = resto;
  $("#ep-monto").value = formatearInputMiles(String(p.monto || ""));
  $("#ep-interes").value = p.interesPct;
  $("#ep-plan").value = p.plan;
  epFechaInicio.value = p.fechaInicio;
  epFechaFin.value = p.fechaFin || fechaNominalCuota(p.fechaInicio, p.periodoDias, p.numCuotas);
  previewEditar.textContent = "";
  modalEditar.classList.remove("oculto");
}

btnCerrarModalEditar.addEventListener("click", () => modalEditar.classList.add("oculto"));

epFechaFin.addEventListener("input", () => {
  fechaFinEditarTocadaManualmente = true;
});

function leerFormularioEditar() {
  const monto = numeroDesdeInputMiles($("#ep-monto").value);
  const interesPct = parseFloat($("#ep-interes").value);
  const plan = $("#ep-plan").value;
  const fechaInicio = epFechaInicio.value;
  return { monto, interesPct, plan, fechaInicio };
}

$("#ep-monto").addEventListener("input", (e) => {
  e.target.value = formatearInputMiles(e.target.value);
});

function actualizarPreviewEditar() {
  const { monto, interesPct, plan, fechaInicio } = leerFormularioEditar();
  if (!monto || isNaN(interesPct) || !plan || !fechaInicio) {
    previewEditar.textContent = "";
    return;
  }
  const { montoTotal, numCuotas, periodoDias, valorCuota } = calcularPrestamo({ monto, interesPct, plan });
  if (!fechaFinEditarTocadaManualmente) {
    epFechaFin.value = fechaNominalCuota(fechaInicio, periodoDias, numCuotas);
  }
  previewEditar.textContent =
    `Total a pagar: ${miles(montoTotal)} — ${numCuotas} cuotas de ${miles(valorCuota)} cada una`;
}
["ep-monto", "ep-interes", "ep-plan", "ep-fecha-inicio"].forEach((id) =>
  $("#" + id).addEventListener("input", actualizarPreviewEditar)
);

formEditarPrestamo.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!prestamoEditandoId) return;
  const nombreCliente = $("#ep-nombre").value.trim();
  const codigoPais = $("#ep-tel-codigo").value;
  const telefonoCliente = codigoPais + soloDigitos($("#ep-telefono").value);
  const { monto, interesPct, plan, fechaInicio } = leerFormularioEditar();
  if (!nombreCliente || !monto || isNaN(interesPct) || !plan || !fechaInicio) return;

  const { montoTotal, numCuotas, periodoDias, valorCuota } = calcularPrestamo({ monto, interesPct, plan });
  const fechaFin = epFechaFin.value || fechaNominalCuota(fechaInicio, periodoDias, numCuotas);

  const ref = doc(db, "cobradores", cobradorId, "prestamos", prestamoEditandoId);
  await setDoc(
    ref,
    {
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
      fechaFin,
      fechaFinManual: fechaFinEditarTocadaManualmente,
    },
    { merge: true }
  );

  modalEditar.classList.add("oculto");

  // Si el préstamo editado es el que está abierto en la vista de
  // detalle, la refrescamos para que se vea el cambio de una vez.
  if (detalleActualId === prestamoEditandoId) {
    mostrarDetalle(prestamoEditandoId, {
      ...detalleActualP,
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
      fechaFin,
      fechaFinManual: fechaFinEditarTocadaManualmente,
    });
  }
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
  const nota = p.notaGeneral || "";

  div.innerHTML = `
    <div class="tarjeta-header">
      <strong>${p.clienteNombre}</strong>
      <span class="plan-chip">${PLANES[p.plan]?.nombre ?? p.plan}</span>
    </div>
    <div class="tarjeta-info">Monto: ${miles(p.monto)} · Total: ${miles(p.montoTotal)} · Cuota: ${miles(p.valorCuota)}</div>
    <div class="tarjeta-info">${lineaEstado}</div>
    ${nota ? `<div class="cuota-nota">📌 ${nota}</div>` : ""}
    <div class="tarjeta-acciones">
      ${clasif.categoria !== "completado" ? `<button type="button" class="btn btn-pagar" data-id="${id}">Marcar cuota ${clasif.proximaCuota}</button>` : ""}
      <button type="button" class="btn btn-secundario" data-ver="${id}">Ver cronograma</button>
      <button type="button" class="btn btn-secundario" data-editar="${id}">✏️ Editar</button>
      <button type="button" class="btn btn-secundario" data-nota-prestamo="${id}">📝 Nota</button>
      ${wa ? `<a class="btn btn-whatsapp" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
      <button type="button" class="btn btn-eliminar" data-eliminar="${id}">Eliminar</button>
    </div>
  `;
  const btnPagar = div.querySelector(".btn-pagar");
  if (btnPagar) {
    btnPagar.addEventListener("click", () => marcarCuota(id, clasif.proximaCuota, p.valorCuota));
  }
  div.querySelector("[data-ver]").addEventListener("click", () => mostrarDetalle(id, p));
  div.querySelector("[data-editar]").addEventListener("click", () => abrirModalEditar(id, p));
  div.querySelector("[data-nota-prestamo]").addEventListener("click", () => pedirNotaPrestamo(id, nota));
  div.querySelector("[data-eliminar]").addEventListener("click", () => eliminarPrestamo(id, p.clienteNombre));
  return div;
}

// ------------------------------------------------------------
// Nota general del préstamo (no de una cuota en particular) — para
// dejar un recordatorio visible de una vez en la lista principal, sin
// tener que entrar al cronograma (ej. "vive al fondo de la calle",
// "pide que le avisen antes de ir").
// ------------------------------------------------------------
async function guardarNotaPrestamo(prestamoId, texto) {
  const ref = doc(db, "cobradores", cobradorId, "prestamos", prestamoId);
  await setDoc(ref, { notaGeneral: (texto || "").trim() }, { merge: true });
}

function pedirNotaPrestamo(prestamoId, notaActual) {
  const nueva = prompt(
    "Nota para este préstamo (se ve en la lista principal). Déjalo vacío para borrarla:",
    notaActual || ""
  );
  if (nueva === null) return;
  guardarNotaPrestamo(prestamoId, nueva);
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
// Nota / observación por cuota (independiente de si está pagada o
// no) — para casos como un abono parcial, una promesa de pago, etc.
// Se guarda en su propia subcolección para no mezclarse con el
// registro de pago (que es lo que decide si la cuota cuenta como
// pagada). El mismo ID determinístico evita duplicados offline.
// ------------------------------------------------------------
async function guardarNotaCuota(prestamoId, numero, texto) {
  const ref = doc(db, "cobradores", cobradorId, "prestamos", prestamoId, "notas", idCuota(numero));
  const limpio = (texto || "").trim();
  if (!limpio) {
    await deleteDoc(ref);
  } else {
    await setDoc(ref, { texto: limpio, actualizadoEn: serverTimestamp() });
  }
}

function pedirNotaCuota(prestamoId, numero, notaActual) {
  const nueva = prompt(
    `Nota / observación para la cuota #${numero} (por ejemplo, "abonó 5.000, falta el resto"). Déjalo vacío para borrar la nota:`,
    notaActual || ""
  );
  if (nueva === null) return; // canceló
  guardarNotaCuota(prestamoId, numero, nueva);
}

// ------------------------------------------------------------
// Detalle / cronograma completo de un préstamo
// ------------------------------------------------------------
btnVolverLista.addEventListener("click", () => {
  vistaDetalle.classList.add("oculto");
  vistaApp.classList.remove("oculto");
  if (unsubDetalle) unsubDetalle();
});

// El botón "Editar" de la vista de detalle abre el mismo modal de
// edición, usando el préstamo que esté abierto en ese momento.
let detalleActualId = null;
let detalleActualP = null;
btnEditarPrestamo.addEventListener("click", () => {
  if (detalleActualId && detalleActualP) abrirModalEditar(detalleActualId, detalleActualP);
});

function mostrarDetalle(prestamoId, p) {
  if (unsubDetalle) unsubDetalle();
  detalleActualId = prestamoId;
  detalleActualP = p;
  vistaApp.classList.add("oculto");
  vistaDetalle.classList.remove("oculto");
  $("#detalle-titulo").textContent = p.clienteNombre;
  const fechaFinMostrar = p.fechaFin || fechaNominalCuota(p.fechaInicio, p.periodoDias, p.numCuotas);
  $("#detalle-info").textContent =
    `Plan: ${PLANES[p.plan]?.nombre} · Monto: ${miles(p.monto)} · Interés: ${p.interesPct}% · Total: ${miles(p.montoTotal)} · Inicio: ${formatoBonito(p.fechaInicio)} · Fin: ${formatoBonito(fechaFinMostrar)}`;

  const contWa = $("#detalle-whatsapp-cont");
  const wa = linkWhatsapp(p.clienteTelefono, p.clienteNombre);
  contWa.innerHTML = wa
    ? `<a class="btn btn-whatsapp grande" href="${wa}" target="_blank" rel="noopener">Escribirle por WhatsApp</a>`
    : "";

  const contCuotas = $("#detalle-cuotas");
  const contResumen = $("#detalle-resumen");
  contCuotas.innerHTML = "Cargando…";

  // Guardamos el último snapshot de pagos y de notas para poder
  // volver a dibujar el cronograma cuando cambie cualquiera de los
  // dos (son dos listeners independientes).
  let pagadasSet = new Set();
  let notasMap = new Map(); // numero -> texto

  function repintar() {
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
      const nota = notasMap.get(n) || "";

      const fila = document.createElement("div");
      fila.className = `cuota-fila-cont`;
      fila.innerHTML = `
        <div class="cuota-fila ${pagada ? "pagada" : atrasada ? "atrasada" : "pendiente"}">
          <span class="cuota-num">#${n}</span>
          <span class="cuota-fecha">${formatoBonito(fechaNom)}</span>
          <span class="cuota-monto">${miles(p.valorCuota)}</span>
          <span class="cuota-estado">${pagada ? "✓ Pagada" : atrasada ? "Atrasada" : "Pendiente"}</span>
          <button type="button" class="btn-nota" data-nota="${n}" title="Agregar/editar nota">📝</button>
        </div>
        ${nota ? `<div class="cuota-nota">📌 ${nota}</div>` : ""}
      `;
      fila.querySelector(".cuota-fila").addEventListener("click", () => {
        if (pagada) desmarcarCuota(prestamoId, n);
        else marcarCuota(prestamoId, n, p.valorCuota);
      });
      fila.querySelector(".btn-nota").addEventListener("click", (e) => {
        e.stopPropagation();
        pedirNotaCuota(prestamoId, n, nota);
      });
      contCuotas.appendChild(fila);
    }
  }

  const unsubPagos = onSnapshot(
    collection(db, "cobradores", cobradorId, "prestamos", prestamoId, "pagos"),
    (snap) => {
      pagadasSet = new Set();
      snap.forEach((d) => {
        const n = parseInt(d.id.replace("cuota_", ""), 10);
        if (!isNaN(n)) pagadasSet.add(n);
      });
      repintar();
    }
  );

  const unsubNotas = onSnapshot(
    collection(db, "cobradores", cobradorId, "prestamos", prestamoId, "notas"),
    (snap) => {
      notasMap = new Map();
      snap.forEach((d) => {
        const n = parseInt(d.id.replace("cuota_", ""), 10);
        if (!isNaN(n)) notasMap.set(n, d.data().texto || "");
      });
      repintar();
    }
  );

  unsubDetalle = () => {
    unsubPagos();
    unsubNotas();
  };
}

// ------------------------------------------------------------
// Registro del service worker (app shell offline)
// ------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(console.error);
  });
}
