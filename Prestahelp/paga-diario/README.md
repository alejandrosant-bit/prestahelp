# Paga Diario

App web (PWA) para el cobro de préstamos "paga diario" — funciona sin
internet y sincroniza sola con Firebase cuando hay conexión.

## Cómo ponerla a funcionar

1. **Crea un proyecto de Firebase** (gratis) en https://console.firebase.google.com
2. Dentro del proyecto:
   - Activa **Authentication → Correo/contraseña**.
   - Activa **Firestore Database** (modo producción).
   - Ve a **Configuración del proyecto → Tus apps → Web** y copia la configuración.
3. Pega esa configuración en `firebase-config.js` (reemplaza los valores de ejemplo).
4. Sube las reglas de `firestore.rules` a tu proyecto (Firestore → Reglas → pega el contenido → Publicar).
5. Sube estos archivos a un hosting (Firebase Hosting, Hostinger, o el que ya usas para los otros proyectos).
6. Abre la página en el celular del cobrador → botón "Compartir" o menú del navegador → **"Agregar a pantalla de inicio"**. Eso crea el acceso directo como si fuera una app nativa.
7. La primera vez que un cobrador entra necesita internet (para iniciar sesión). Después de eso, la sesión queda guardada en el teléfono y puede trabajar sin conexión indefinidamente.

## Cómo crear la cuenta de cada cobrador (no hay auto-registro)

La app no deja que nadie se cree su propia cuenta — la creas tú manualmente
cada vez que vendes un acceso:

1. En Firebase Console → **Authentication → Users → Add user**.
2. Pones el correo y la clave que le vas a entregar a ese cobrador.
3. Le compartes esos datos (correo + clave) y con eso entra a la app.

Cada cobrador que crees así automáticamente tiene su propia cartera aislada
(gracias a las reglas de `firestore.rules`, que separan los datos por el
`uid` de cada usuario) — no hace falta ninguna configuración extra por
cobrador.

## Cómo funciona el modelo de datos (multi-tenant)

Cada cobrador que se registra tiene su propia cartera, completamente
aislada de los demás gracias a las reglas de `firestore.rules`:

```
cobradores/{uid}/prestamos/{prestamoId}
cobradores/{uid}/prestamos/{prestamoId}/pagos/{fecha}
```

- El **préstamo** guarda: cliente, monto, interés, plan, total calculado y valor de cada cuota.
- Cada **pago** se guarda con el ID igual a la fecha (`2026-09-13`). Esto es clave: si el teléfono pierde señal a mitad de una subida y reintenta, el pago de ese día simplemente sobreescribe el mismo documento — nunca se duplica ni se cobra dos veces.
- El progreso (cuotas pagadas, fecha estimada de vencimiento) se calcula contando esos documentos, nunca con un contador que se pueda desincronizar.
- Si un cliente se atrasa, esa cuota queda pendiente en la cuenta y la fecha de vencimiento estimada se recalcula sola corriéndose hacia adelante.

## Qué falta antes de venderla a varios cobradores

- Íconos reales para `manifest.json` (`icon-192.png`, `icon-512.png`) — por ahora no están incluidos.
- Pantalla para editar/eliminar un préstamo o cliente.
- Si quieres reportes (total cobrado por día, mora, etc.) se pueden agregar sin tocar el modelo de datos, ya que todo se puede calcular a partir de los pagos guardados.
