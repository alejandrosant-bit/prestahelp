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
cobradores/{uid}/prestamos/{prestamoId}/pagos/{cuota_NN}
```

- El **préstamo** guarda: cliente, monto, interés, plan, total calculado, valor de cada cuota y fecha de inicio.
- Cada **pago** se guarda con el ID igual al número de cuota (`cuota_01`, `cuota_02`, …), no a la fecha en que se cobró. Esto es clave por dos razones: si el teléfono pierde señal a mitad de una subida y reintenta, marcar la misma cuota dos veces sobreescribe el mismo documento — nunca se duplica; y desmarcar una cuota (por error) es simplemente borrar ese documento, sin dejar rastro.
- Cada cuota tiene una **fecha nominal** calculada (fecha de inicio + (número de cuota − 1) × el período del plan). Esa fecha es la que decide en qué sección del panel aparece el cliente: si la próxima cuota pendiente cae antes de hoy va a "Atrasados", si cae hoy va a "Cobrar hoy", si es mañana va a "Cobrar mañana", y si es más adelante va a "Al día". Todo esto se recalcula solo, sin ningún contador que se pueda desincronizar — se basa en contar qué documentos `cuota_NN` existen.
- El cronograma completo de cada cliente (todas las cuotas, pagadas o no) se ve entrando a "Ver cronograma" desde su tarjeta; ahí se puede marcar y desmarcar cualquier cuota individualmente, no solo la de hoy.

## Qué falta antes de venderla a varios cobradores

- Pantalla para editar/eliminar un préstamo o cliente completo (hoy se puede corregir cuota por cuota, pero no borrar el préstamo entero desde la app).
- Si quieres reportes (total cobrado por día, mora, etc.) se pueden agregar sin tocar el modelo de datos, ya que todo se puede calcular a partir de los pagos guardados.
