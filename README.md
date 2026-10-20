# Travel Partner Viajes Casal

Prototipo navegable de la plataforma comercial de Viajes Bumeran Casal, servido mediante Node.js y Express.

## Requisitos

- Node.js 22.x
- npm

## Instalación y ejecución

```bash
npm install
npm start
```

Abre:

- Aplicación: `http://localhost:3000`
- Estado del servidor: `http://localhost:3000/api/health`

Puedes copiar `.env.example` a `.env` para desarrollo local. No publiques `.env` ni credenciales.

## Funciones incluidas en el prototipo

- Dashboard, leads, cotizaciones, clientes, viajes, seguimientos, reportes y configuración.
- Navegación responsive y modo oscuro.
- Leads, cotizaciones, clientes, viajes y seguimientos guardados en MySQL.
- Dashboard y reportes calculados con datos reales y la fecha de Cancún.
- Duplicación de cotizaciones con folio automático.
- Vista imprimible individual para guardar una cotización como PDF desde el navegador.
- Selección validada de hasta tres cotizaciones del mismo cliente.
- Preparación de un único mensaje de WhatsApp.
- Login real con contraseñas hasheadas mediante bcrypt.
- Sesiones seguras y persistentes en MySQL para producción.
- Roles `admin` y `travel_partner`.
- Cierre de sesión, cambio obligatorio de contraseña y registro de actividad.
- Helmet y limitación de intentos de acceso.

## Datos del CRM (TP-001)

Leads, clientes, cotizaciones, viajes, seguimientos y el perfil de la agencia se guardan en MySQL. Las tablas se crean solas al iniciar el servidor (`CREATE TABLE IF NOT EXISTS`), sin borrar datos existentes:

| Tabla | Contenido |
| --- | --- |
| `crm_clients` | Nombre, WhatsApp, correo, preferencias y notas |
| `crm_leads` | Oportunidad por cliente: destino, fechas, viajeros, presupuesto, etapa, prioridad y origen |
| `crm_quotes` | Folio automático `COT-AAAA-0001`, hotel, precio, modalidad, vigencia y estado |
| `crm_trips` | Viajes confirmados con fechas y estado operativo |
| `crm_followups` | Llamadas, mensajes y pagos programados con fecha y hora |
| `crm_settings` | Perfil de la agencia |

Reglas principales:

- Al registrar un lead se reutiliza el cliente si el WhatsApp ya existe (se comparan los últimos 10 dígitos).
- Al crear una cotización ligada a un lead nuevo o calificado, el lead pasa a **Cotizado**; al aceptarla, pasa a **Vendido**.
- Solo el rol `admin` puede eliminar registros. Eliminar un cliente elimina su historial.
- Fechas y horas se manejan en hora de Cancún (UTC-5).
- Toda alta, edición o eliminación queda en `activity_logs`.

API (requiere sesión): `GET /api/crm`, `POST|PATCH|DELETE /api/{clients|leads|quotes|trips|followups}`, `POST /api/quotes/:id/duplicate`, `PUT /api/settings/agency`.

Pruebas: `npm test` usa memoria. Para probar contra MySQL: `TEST_DB_NAME=... TEST_DB_USER=... TEST_DB_PASSWORD=... node --test test/crm.test.js` (usar una base vacía de pruebas, nunca la de producción).

Los enlaces persistentes de PDF se habilitarán cuando se conecte Google Drive; no se incluyen OpenAI API, WhatsApp API ni secretos.

## Usuarios y roles (TP-002)

| Rol (valor en BD) | Ve | Puede |
| --- | --- | --- |
| Administrador (`admin`) | Todo | Todo: reasignar leads, eliminar, gestionar usuarios y configuración |
| Vendedor (`travel_partner`) | Sus leads y los clientes, cotizaciones, viajes y seguimientos que cuelgan de ellos | Crear y editar dentro de lo suyo |
| Operaciones (`operaciones`) | Todos los clientes, cotizaciones y viajes; no ve leads | Crear y editar viajes y sus propios seguimientos |
| Consulta (`consulta`) | Todo | Solo lectura (rol heredado) |
| Proveedor (`proveedor`) | Solo su portal `/proveedor` (TP-009) | Cotizar, confirmar y ver sus pagos |

- Las reglas viven en `src/access.js` y se aplican en el servidor; un registro ajeno responde 404.
- El administrador crea usuarios en **Configuración › Usuarios**. Se genera una contraseña temporal de 14 caracteres que el usuario cambia en su primer acceso.
- Desactivar un usuario o restablecer su contraseña cierra sus sesiones abiertas. Cambiar el rol aplica desde la siguiente acción.
- Siempre queda al menos un administrador activo; nadie puede quitarse a sí mismo el rol de administrador.
- Si un vendedor registra un WhatsApp que ya atiende otro vendedor, el lead se crea con un aviso y el administrador ve la marca **Cliente compartido**.
- Al reasignar un lead se mueven con él sus cotizaciones y seguimientos pendientes.
- Las variables `ADMIN_*` y `PARTNER_*` solo crean las cuentas iniciales si no existen; si falta la contraseña inicial, el servidor arranca igual y lo avisa en el registro.
- Para que Hostinger no muestre archivos viejos, `index.html` carga `app.js?v=...` y `styles.css?v=...`; cambia ese valor en cada versión.

## Recuperar contraseña (TP-003)

- En el inicio de sesión, **¿Olvidaste tu contraseña?** pide el correo y envía un enlace `APP_URL/#reset=...` que vence en **30 minutos** y sirve **una sola vez**.
- La respuesta es la misma exista o no la cuenta (no revela qué correos están registrados) y el correo se envía después de responder.
- Límites: 5 solicitudes por IP cada 15 minutos y una por usuario cada 60 segundos. Pedir un enlace nuevo invalida el anterior.
- El token se guarda solo como hash SHA-256 en `password_resets`. Al usarlo se cierran las sesiones abiertas del usuario.
- El administrador puede enviar el enlace desde **Configuración › Usuarios › Nueva contraseña**, y probar el correo desde **Configuración › Integraciones**.
- Variables en Hostinger: `APP_URL`, `SMTP_HOST` (`smtp.hostinger.com`), `SMTP_PORT` (`465`), `SMTP_USER`, `SMTP_PASSWORD` y `MAIL_FROM`. Sin ellas, en producción la recuperación responde que no está activa; en desarrollo el enlace se muestra en la consola.

## Verificación en dos pasos (TP-004)

- **Administradores:** obligatoria. **Vendedores y Operaciones:** opcional, desde **Mi cuenta** (botón ⚙ junto al nombre).
- **Métodos:** código de 6 dígitos por correo (vence en 10 minutos) o app de autenticación (Google o Microsoft Authenticator, estándar TOTP). Quien usa la app tiene 8 códigos de respaldo de un solo uso y puede pedir el código por correo si no trae el celular.
- **Recordar este equipo:** 30 días (cookie `tp.td`, guardada solo como hash en `trusted_devices`). Restablecer la contraseña por correo olvida todos los equipos.
- **Límites:** 5 códigos incorrectos cancelan el intento; 60 segundos entre reenvíos; 20 intentos por IP cada 15 minutos.
- Las sesiones de quien requiere el segundo paso y no lo completó se cierran (por ejemplo, al publicar esta versión o al ascender a alguien a administrador).
- El secreto de la app se guarda cifrado con una llave derivada de `SESSION_SECRET`. **Si cambias `SESSION_SECRET`, las apps dejan de funcionar** y esos usuarios entrarán con el código por correo hasta volver a configurarla.
- Si el correo no está configurado y el usuario no usa app, el sistema no bloquea el acceso: registra `twofa_skipped_no_mail` en la actividad.
- El administrador puede **Quitar app** a otro usuario desde **Configuración › Usuarios** (celular perdido).

## Bitácora de actividad (TP-005)

- Cada alta, edición, eliminación, duplicado y reasignación de clientes, leads, cotizaciones, viajes y seguimientos queda en `activity_logs` con usuario, fecha y hora, un resumen del registro (sobrevive aunque se elimine) y los cambios campo por campo (`Etapa: Cotizado → Vendido`).
- También se registran los cambios automáticos (por ejemplo, el lead que pasa a Vendido al aceptar su cotización) y lo que se elimina en cascada con un cliente.
- **Administrador:** pantalla **Bitácora** con filtros por usuario, tipo (comercial / accesos y seguridad), sección y fechas, paginación y exportación CSV (`GET /api/activity`).
- **Cualquier rol:** botón **Ver historial de cambios** en leads, cotizaciones, clientes y viajes que puede ver (`GET /api/history/:entidad/:id`).
- Se conserva **2 años**: lo más antiguo se borra al iniciar el servidor y una vez al día.
- Los registros anteriores a esta versión se siguen mostrando (sin el detalle de cambios, que no se guardaba).
- Los pagos se integrarán a la bitácora cuando existan (TP-201/202).

## Variables de seguridad

La aplicación no inicia en producción si falta alguna variable requerida. Configúralas exclusivamente en Hostinger:

```text
NODE_ENV=production
SESSION_SECRET=
DB_HOST=
DB_PORT=3306
DB_NAME=
DB_USER=
DB_PASSWORD=
ADMIN_EMAIL=
ADMIN_INITIAL_PASSWORD=
PARTNER_EMAIL=
PARTNER_INITIAL_PASSWORD=
APP_URL=
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM=
```

Las contraseñas iniciales solo se utilizan para crear cuentas inexistentes. Después del primer cambio de contraseña pueden eliminarse del entorno y redesplegarse. Nunca deben añadirse al repositorio.

## Despliegue en Hostinger

1. En hPanel, entra en **Websites > Add Website > Deploy Web App**.
2. Selecciona **Import Git Repository** y conecta este repositorio.
3. Elige Express y Node.js **22.x**.
4. Usa la raíz del repositorio, donde se encuentran `package.json` y `server.js`.
5. Configura `server.js` como entry file. No hay directorio de build.
6. Hostinger instalará las dependencias y ejecutará el script `npm start`.
7. Configura `NODE_ENV=production`; no definas `PORT`, porque Hostinger lo proporciona.
8. Asocia `travelpartner.viajescasal.com` y despliega.
9. Verifica `/` y `/api/health` desde el subdominio.

## Estructura

```text
.
├── src/
│   ├── access.js
│   ├── audit.js
│   ├── crm-routes.js
│   ├── crm-schema.js
│   ├── data-store.js
│   ├── login-flow.js
│   ├── mailer.js
│   ├── password-reset.js
│   ├── twofa.js
│   └── user-routes.js
├── test/
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── .env.example
├── .gitignore
├── package.json
├── server.js
└── README.md
```

## Encuestas del sitio conectadas al CRM

Además del formulario del CRM (`/formulario`, incrustado con `formulario-embed.js`), las encuestas propias de viajescasal.com
(paquetes: "Solicitar cotización"; tours: "Cotizar", "Aparta tu fecha"…) registran el lead en el CRM sin cambiar su diseño ni su mensaje de WhatsApp.

- `public/puente-encuestas.js` lee la encuesta cuando el cliente la envía (después de que pasa sus validaciones y abre WhatsApp) y la manda a `POST /api/public/lead`.
- `formulario-embed.js` carga el puente automáticamente, así que no hay que tocar el código del sitio.
- El lead llega con origen `encuesta-paquetes-viajescasal` o `encuesta-tours-viajescasal` y, en sus notas, todas las respuestas tal cual las vio el cliente.
- CORS solo para `viajescasal.com`, `www.viajescasal.com` y `paulina.viajescasal.com`; para agregar otro sitio usa la variable `WEBFORM_ORIGINS` (separados por coma).
- Encuesta nueva: agrega al `<form>` el atributo `data-crm-encuesta="Nombre"` y usa `name="nombre"`, `"whatsapp"`, `"correo"`, `"destino"`…

## Calendario de seguimientos (TP-105)

- **Seguimientos** muestra el calendario en vista **Día, Semana o Mes** (se recuerda la última vista). El administrador puede filtrar por vendedor.
- Colores por tipo (llamada, WhatsApp, cotización, pago, otro); los vencidos se marcan en rojo.
- **Arrastrar para reprogramar:** en Semana/Día cambia día y hora (bloques de 30 min); en Mes cambia el día y conserva la hora. Doble clic en un horario vacío crea un seguimiento a esa hora.
- **Desde la ficha del lead:** botones *Programar llamada*, *Programar WhatsApp* y *Otro seguimiento*, y la lista de seguimientos del lead. La ficha del seguimiento trae atajos de fecha (en 1 hora, mañana 10:00, lunes…), *Abrir WhatsApp*, *Llamar* y *Agregar a Google Calendar*.
- **Google Calendar (suscripción, una vía):** botón *Google Calendar* → liga privada `/calendario/<token>.ics` por usuario (`src/calendar.js`). El vendedor la agrega en Google Calendar › Agregar desde URL. Incluye seguimientos de los últimos 60 días y los próximos, con aviso 10 min antes. *Generar liga nueva* invalida la anterior. Las ligas viven en `crm_settings` (`calendar_feeds`).
- Pendiente: sincronización completa en dos vías con la API de Google Calendar (OAuth).

## Recordatorios automáticos (TP-106)

Revisión cada 5 minutos en el servidor (`src/reminders.js`, también al primer uso si el servidor estuvo dormido). Se configura en **Configuración › Recordatorios** (solo administrador).

- **Cotización sin respuesta:** si una cotización lleva 48 h en estado *Enviada* (`sent_at`), se crea un seguimiento tipo *Cotización* para el vendedor (si no tiene ya uno pendiente) y se le avisa por campanita y correo. Una sola vez por envío (`reminder_at`); si la cotización cambia de estado y se vuelve a enviar, el tiempo se reinicia.
- **Lead sin contacto:** los leads que llegan solos (bot, formulario) o que asigna otra persona tienen 2 h **laborales** (09:00–20:00, configurable) para el primer contacto (`assigned_at`). Al vencer, aviso al vendedor (`contact_alert_at`); 2 h laborales después, aviso a los administradores (`contact_escalated_at`).
- **Cuenta como contactado** (`contacted_at`): salir de *Nuevo*, completar un seguimiento del lead, o el botón **✅ Ya lo contacté** (ficha del lead y tablero; `POST /api/leads/:id/contacted`). Los leads que registra su propio vendedor ya cuentan como contactados. Reasignar un lead sin contacto reinicia su tiempo.
- Lo que ya existía antes de activar la función no dispara alertas de golpe (`reminders_state.startedAt`); las cotizaciones enviadas antes cuentan sus 48 h desde la activación.
- API (admin): `GET|PUT /api/reminders`, `POST /api/reminders/run` (revisar ahora).

## Plantillas de WhatsApp por etapa (TP-107)

- Etapas: primer contacto, envío de cotización, seguimiento, cierre y postviaje (`src/templates.js`, con plantillas iniciales).
- El administrador las edita en **Configuración › Plantillas WhatsApp** (variables `{nombre}`, `{destino}`, `{fechas}`, `{folio}`, `{hotel}`, `{precio}`, `{vigencia}`, `{viajeros}`, `{vendedor}`, `{agencia}`, `{liga_resenas}`; vista previa y *Restaurar plantillas originales*). Se guardan en `crm_settings` (`wa_templates`).
- El vendedor abre **💬 Plantilla WhatsApp** desde la ficha del lead, la ficha 360 o el viaje: elige lead/cotización/viaje, la etapa se sugiere sola, el CRM llena los datos (lo que falta queda como `[dato]`) y puede retocar el texto. **Abrir WhatsApp** abre `wa.me` con el mensaje listo en el WhatsApp del vendedor; **Copiar** lo copia. Ambos lo registran en la ficha 360 y, en la etapa de cotización, pueden marcar la cotización como *Enviada*.
- API: `GET /api/templates` (todos), `PUT /api/templates` (admin; `{ restoreDefaults: true }` restaura).

## Ficha 360 del cliente (TP-108)

- Al abrir un cliente se ve su **línea de tiempo única**: cliente registrado, leads (creación, primer contacto, vendido/perdido), cotizaciones (creada, enviada, aceptada), viajes (salida, regreso y estado de pago de la confirmación), seguimientos hechos, mensajes de WhatsApp, pagos, reseñas y notas; filtros por tipo y agrupada por mes.
- Arriba: vendido, pagado, saldo, viajes, promedio de reseñas y último contacto; notas fijas y preferencias del cliente; próximos seguimientos.
- Botones **Registrar pago** (monto, concepto, forma de pago, fecha, viaje/cotización), **Registrar reseña** (1–5 estrellas, plataforma, comentario) y **Agregar nota**. La pestaña *Datos del cliente* conserva el formulario de antes.
- Tabla `crm_client_events` (se borra con el cliente; incluida en el respaldo JSON). API: `GET|POST /api/clients/:id/events`, `DELETE /api/client-events/:id` (solo admin). Cada vendedor ve y registra solo en sus clientes.

## Calificación automática de leads (TP-109)

- `src/scoring.js`: puntaje 0–100 con presupuesto por persona, cercanía de fechas, tamaño del grupo, respuesta del cliente y las preguntas de calificación (si se contestaron; si no, su peso se reparte). Caliente/Tibio/Frío → prioridad Alta/Media/Baja, que ya no se elige a mano (se guarda sola al cambiar).
- Respuesta del cliente: botones ⚡ Responde rápido · 🕒 Tarda · 😶 No responde en la ficha del lead (`POST /api/leads/:id/response`), más señales automáticas: volvió a escribir al bot o al formulario (`reengaged_at`) o abrió la liga de la cotización.
- Pesos y umbrales en **Configuración › Calificación de leads** (`GET|PUT /api/scoring`, setting `lead_scoring`).

## Centro de notificaciones (TP-110)

- Campanita con pestañas *Todos / Sin leer*, ícono por tipo y clic que abre el lead, la cotización, el cliente o el seguimiento (`crm_notifications.link`).
- Avisos: lead nuevo (al vendedor asignado y, si entra por bot o formulario, a los administradores), **cotización vista** (liga privada `/cotizacion/<token>`, máximo un aviso por hora; las vistas del equipo no cuentan), **pago recibido** (al registrar un pago en la ficha 360: vendedor y administradores) y **seguimiento vencido** (15 min después de la hora, una vez; se reinicia al reprogramar). También los recordatorios de TP-106.
- Liga privada: botón **🔗 Liga** en la cotización (`POST /api/quotes/:id/share`, `{ enabled: false }` la desactiva); variable `{liga_cotizacion}` en las plantillas de WhatsApp. Vista pública: `src/public-quote.js` (sin datos de contacto del cliente; imágenes servidas por la misma liga).

## Duplicados (TP-111)

- Aviso al escribir WhatsApp o correo en *Nuevo cliente*, *Nuevo lead* y *Datos del cliente* (`GET /api/clients/duplicates/check`). Crear un cliente que ya existe pide confirmación (409). Un lead nuevo con un correo ya registrado se agrega a ese cliente.
- Administrador: aviso en **Clientes** y en la ficha 360, revisión por grupos (mismo WhatsApp, correo o nombre) y **Conservar este** para fusionar (`GET /api/duplicates`, `POST /api/clients/merge`): mueve leads, cotizaciones, viajes, seguimientos y ficha 360, completa datos faltantes y elimina el duplicado.

## Vista Canvas del viaje (TP-302)

- **Desde el lead:** botón **🧩 Armar en Canvas** en la ficha del lead. Lienzo con un día por columna (fechas del lead) y bloques que se arrastran con mouse o con el dedo: ✈️ Vuelo, 🚐 Traslado, 🏨 Hotel (con noches), 🎟️ Tour/actividad, 🛡️ Seguro y 📝 Nota. También se puede tocar un bloque de la paleta para agregarlo al día marcado, o cambiar el día desde el editor.
- Cada bloque lleva hora, proveedor, **costo neto** y **precio de venta**; abajo se ven costo, venta, utilidad con % de margen, precio por persona y los bloques sin precio.
- **📄 Crear cotización:** genera una cotización en *Borrador* en el formato del Cotizador (vuelo, hotel, traslados, tours y seguro; precio = suma de ventas) y el lead pasa a *Cotizado*. Si la cotización sigue en borrador, **↻ Actualizar** la rehace con el lienzo. La cotización guarda el lienzo (`details.canvas`) aunque después se edite en el Cotizador.
- **Desde el viaje:** botón **🧩 Canvas**. Si el viaje viene de una cotización hecha en Canvas, el lienzo se carga solo; si no, se arma uno inicial con la confirmación de servicios. **Aplicar al itinerario y confirmación** reemplaza el día por día del itinerario digital (TP-301) y llena vuelos, hotel, traslados, actividades y seguro de la confirmación, sin tocar los demás datos.
- Reglas en `public/viaje-core.js` (compartido con el servidor); campos `crm_leads.canvas` y `crm_trips.canvas` (JSON, máximo 80 bloques y 45 días; el servidor los valida y ordena).

## Pasajeros y acompañantes (TP-303)

- Botón **👥 Pasajeros** en el viaje: nombre como en la identificación, fecha de nacimiento, tipo (adulto 12+, menor 2–11, infante < 2, calculado con la edad al día de salida), parentesco, documento (pasaporte, INE, visa, acta, licencia), número, vigencia, nacionalidad, celular, notas y titular de la reserva.
- **Avisos:** documento vencido antes de salir o durante el viaje (⛔), pasaporte con menos de 6 meses de vigencia al regreso (⚠), y datos faltantes; además, cuántos viajeros faltan contra el lead. La tarjeta del viaje en **Viajes** muestra 👥 y los avisos.
- **Acompañantes frecuentes:** al guardar, los pasajeros se recuerdan en el cliente (`crm_clients.companions`) y se ofrecen con un clic en su siguiente viaje; se pueden quitar desde **Ficha 360 › Datos del cliente**.
- La **confirmación de servicios** toma titular, número y lista de pasajeros de esta lista (con “menor, 8 años”). El **itinerario digital** del cliente solo muestra nombres y tipo.
- **Privacidad:** número de documento y fecha de nacimiento solo los ve el equipo; no salen en ligas públicas ni en la bitácora (que solo anota “Pasajeros actualizados: 3”). Solo se escriben por `PUT /api/trips/:id/passengers` (`GET` para leer) y `PUT /api/clients/:id/companions`.

## Reservas centralizadas (TP-304)

- Botón **🧾 Reservas** en el viaje: un renglón por servicio (vuelo, hotel, traslado, tour, seguro u otro) con proveedor (del catálogo o escrito), número de confirmación, estado (*Por reservar → Solicitada → Confirmada* o *Cancelada*), fechas y hora, costo neto, precio de venta, fecha límite para pagar al proveedor, “Pagado” y notas internas.
- **✨ Crear reservas desde el Canvas** (o desde la confirmación si no hay lienzo): un renglón por bloque, ligado al catálogo, sin repetir los que ya existen. Si el proveedor tiene comisión y no hay costo, el costo neto se calcula solo (precio − comisión).
- **Documentos:** cada reserva puede adjuntar o ligar documentos del viaje (los mismos del itinerario digital, así que el cliente también los ve).
- **Avisos:** sin reservar y el viaje sale en ≤ 30 días (⛔), solicitada sin confirmar a ≤ 15 días, confirmada sin clave, pago al proveedor por vencer (7 días) o vencido.
- **Viajes › Reservas:** panel con todas las reservas de los viajes abiertos (por reservar, solicitadas, confirmadas, total por pagar a proveedores y lo que vence en 7 días), filtros por estado y proveedor, y “Solo lo que requiere atención”. La tarjeta del viaje muestra 🧾 confirmadas/total.
- **Cliente:** su itinerario digital muestra solo las reservas **confirmadas** con proveedor y clave; nunca costos ni pagos al proveedor. La clave del vuelo confirmado llena “Reserva de vuelo” en la confirmación.
- Campo `crm_trips.bookings` (JSON interno, máximo 40). API: `GET|PUT /api/trips/:id/bookings`. La bitácora anota altas, bajas y cambios de estado.

## Catálogo de proveedores (TP-305)

- Menú **Proveedores**: nombre, tipo (hotel, mayorista, operador de tours, traslados, aerolínea, seguro, otro), destinos, contacto, teléfono, WhatsApp, correo, sitio, **% de comisión**, tarifas de referencia, condiciones de pago, notas y activo/inactivo. Cada tarjeta muestra cuántas reservas tiene y cuánto se le debe.
- Todos lo consultan; **administrador y Operaciones** lo editan; solo el administrador elimina (se recomienda marcar inactivo).
- Se elige al cotizar (proveedor de cada bloque del Canvas y hotel del Cotizador) y al reservar. Con comisión registrada, el costo neto se calcula solo.
- Se precargaron HotelDO, Azabache, Grupo Xcaret y Travel Shop (una sola vez; completa contacto y comisión).
- Tabla `crm_suppliers` (se crea sola) e incluida en el respaldo JSON. API: `GET|POST /api/suppliers`, `PATCH|DELETE /api/suppliers/:id`.

## Portal del proveedor de traslados (TP-009)

- **Acceso:** Configuración › Usuarios › Nuevo usuario con rol **Proveedor** y el proveedor del catálogo al que pertenece (obligatorio). Entra por la misma página de inicio, cambia su contraseña temporal y lo lleva solo a **`/proveedor`**. En la API solo puede usar `/api/proveedor/*`, su cuenta y sus avisos; todo lo demás responde 403. No aparece en las listas del equipo.
- **Flujo:** en **🧾 Reservas** del viaje, una reserva guardada con un proveedor que tiene acceso muestra **📨 Pedir precio al proveedor**. El formulario se llena con lo que ya sabe el viaje (titular, WhatsApp, adultos/menores, fecha, hora, aeropuerto → hotel, vuelo, regreso, unidad e indicaciones) y se envía con folio `TR-0001`. Estados: *Por cotizar → Precio enviado → (aceptado) Por confirmar → Confirmado*, o *Precio no aceptado*, *No disponible* y *Cancelado*.
- **El proveedor** (celular o computadora): *Inicio* (por cotizar, por confirmar, próximos 7 días, por cobrar), *Solicitudes* (envía o corrige su precio, o “No tengo disponibilidad”), *Servicios* (por confirmar con folio, chofer, celular y unidad; próximos; realizados; cancelados), *Pagos* (por cobrar, vencido, pagado en el mes y **calendario mensual** por fecha de pago) y *Avisos*.
- **El equipo:** acepta el precio (pasa a **costo neto** de la reserva, tarifa neta, y la fecha de pago al proveedor queda en la fecha del servicio si estaba vacía) o lo rechaza con un motivo; puede cancelar la solicitud. Al confirmar, la reserva queda *Confirmada* con el folio del proveedor y el chofer. Al marcar “Pagado” en la reserva se guarda la fecha y el proveedor la ve en su calendario. **Viajes › Reservas** avisa de los precios por revisar.
- **Avisos:** campanita (y correo si hay SMTP) al proveedor por solicitud nueva/actualizada, precio aceptado o rechazado y cancelación; al vendedor del viaje, administradores y Operaciones cuando el proveedor envía precio, no tiene disponibilidad o confirma.
- **Privacidad:** el proveedor solo ve los datos operativos que se le enviaron en la solicitud; nunca el precio de venta, comisiones, correo del cliente ni otras reservas.
- **Protecciones:** si alguien guarda las reservas con una copia vieja mientras el proveedor respondía, se conserva lo del proveedor; no se puede cambiar de proveedor ni quitar una reserva con solicitud abierta (primero se cancela). Todo queda en la bitácora.
- Reglas en `public/proveedor-core.js`; rutas en `src/proveedor-portal.js` (`GET /api/proveedor/portal`, `POST /api/proveedor/services/:viaje/:reserva/{quote|decline|confirm}`, `POST /api/trips/:id/bookings/:bid/portal/{request|decision|cancel}`, `GET /api/supplier-portal/links`). Campo interno `portal` en cada reserva; liga usuario → proveedor en `crm_settings` (`supplier_portal`). El rol se agrega solo a la tabla `users` al iniciar.

## Encuesta y reseña postviaje (TP-308)

- **Automática:** el motor de recordatorios (cada 5 min, en horario laboral) genera la liga privada `/encuesta/<token>` **1 día después del regreso** (configurable): correo al cliente si tiene, aviso al vendedor y seguimiento de WhatsApp con la liga; el viaje pasa a *Solicitar reseña*. Solo viajes que regresan desde que se activó la función.
- **Encuesta (celular):** estrellas del viaje (obligatoria), hotel, traslados y Travel Partner, recomendación 0–10 y comentario (con permiso para publicarlo). Una sola respuesta por viaje.
- **Al contestar:** reseña en la Ficha 360 (plataforma “Encuesta postviaje”), el viaje pasa a *Postventa* y aviso al vendedor. Con 4★ o más (configurable) se le ofrecen Google y TripAdvisor y su liga de referido; con 3★ o menos se avisa también al administrador (y por correo al vendedor) para recuperar al cliente.
- **En el viaje:** botón **⭐ Encuesta** con la liga, el estado (enviada, abierta, contestada), las respuestas, **Enviar por WhatsApp** (plantilla “Encuesta postviaje”, `{liga_encuesta}`), **Enviar por correo** y **Marcar como enviada**.
- **Reportes › Satisfacción postviaje:** respondidas/enviadas, calificación promedio, NPS, clics a reseña y últimos comentarios.
- Configuración › **Postviaje y referidos**. Campo `crm_trips.survey` (interno). API: `POST /api/trips/:id/survey` (`{ email, markSent }`), públicas `GET|POST /api/public/survey/:token`.

## Programa de referidos (TP-309)

- Cada cliente tiene un **código** (`VC-` + 3 letras + 3 caracteres) y una **liga** `/r/<código>`: página con el descuento de bienvenida, botón de WhatsApp con el mensaje y el código ya escritos, y el formulario del CRM con el código.
- **Ligar al lead:** por la liga (formulario), si el cliente escribe el código en su mensaje (bot o formulario) o a mano desde la ficha del lead (“🤝 ¿Viene recomendado?”). Nadie se refiere a sí mismo.
- **Beneficios (configurables):** el referido tiene **$300 MXN** de descuento de bienvenida (estado *Por aplicar / Aplicado*); cuando el lead pasa a **Vendido** (cotización aceptada o tablero), quien refirió gana **$500 MXN** de crédito (*Pendiente / Aplicado / Cancelado*), una sola vez por lead, con aviso al vendedor y al administrador.
- **Ficha 360 › Datos del cliente:** código, liga, **Invitar por WhatsApp** (plantilla “Invitar a referir”), a quién ha referido y sus créditos. La encuesta postviaje también le muestra su liga para compartir.
- **Reportes › Referidos:** leads referidos, vendidos, créditos por aplicar y aplicados, y quién recomienda más.
- Plantillas: `{codigo_referido}`, `{liga_referido}`, `{beneficio_referido}`, `{descuento_referido}`. Campos `crm_clients.referral` y `crm_leads.referral` (internos). API: `GET /api/clients/:id/referral`, `PATCH /api/clients/:id/referral/rewards/:id`, `PUT|PATCH /api/leads/:id/referral`, públicas `GET /api/public/ref/:código`.

## Campañas de recompra (TP-310)

- **Bandeja “📣 Campañas”** (menú, con contador): cada día, en horario laboral, se agregan los clientes que toca contactar; el vendedor recibe un aviso. Cada contacto tiene **💬 WhatsApp** (abre la plantilla de la etapa *Recompra* con los datos de la campaña y al enviarse se marca solo), **✓ Enviado** y **Omitir**. Indicadores: por contactar, enviados en el mes, clientes que volvieron a cotizar después de un mensaje y omitidos.
- **Campañas:** 🌴 *Aniversario del viaje* (30 días antes de que se cumpla un año más; con viaje anterior y sin lead abierto ni viaje próximo), 🎂 *Cumpleaños* (3 días antes) y 📅 *Temporadas* con fecha fija (el verano 15-abr, fin de año 15-sep, Semana Santa 20-ene desactivada) a clientes anteriores sin lead abierto ni viaje próximo. Un contacto sigue en la bandeja hasta 14 días después de su fecha y nunca se repite.
- **Correo opcional** por campaña (felicitación, aniversario o temporada) si el cliente tiene correo y el SMTP está configurado.
- **Cliente:** *Fecha de nacimiento* y *No contactar en campañas* en Ficha 360 › Datos del cliente; la fecha se llena sola con la del pasajero que se llama igual que el cliente (TP-303).
- Configuración › **Campañas de recompra** (días de anticipación, correo, temporadas). Plantillas `rc1–rc3` con `{campana}`, `{anos_viaje}`, `{destino_anterior}`. Campo `crm_clients.campaigns` (interno). API: `GET /api/campaigns`, `PATCH /api/clients/:id/campaigns/:id`, `GET|PUT /api/campaigns/settings`, `POST /api/campaigns/run` (admin).

## Reportes por vendedor y por origen (TP-311)

- **Reportes › Desempeño** con **Por vendedor / Por origen**, periodo (este mes, mes anterior, 90 días, este año, todo) y **CSV**.
- Columnas: leads, % contactados, **1ª respuesta** (mediana entre la asignación y el primer contacto), cotizaciones enviadas, ventas, ingresos (cotización aceptada), ticket, conversión de los leads del periodo, perdidos, ganadas/cerradas, días al cierre y **utilidad** (reservas de tarifa neta: venta − costo; comisionables: comisión del proveedor, TP-205). Totales al final.
- Leads, contacto y conversión cuentan los leads **creados** en el periodo; ventas, ingresos, perdidos y utilidad, los **cerrados** en el periodo. Por origen, los leads del programa de referidos (TP-309) aparecen como “Programa de referidos”.
- La tarjeta **Satisfacción** de Reportes ya toma la calificación de las encuestas postviaje (TP-308). Columna **Comisión vendedor** (TP-206) en la vista por vendedor.
- Cálculo en `public/reportes-core.js` (también lo usan las pruebas).

## Contrato y términos con firma (TP-204)

- Al armarse el plan de pagos de una venta (aceptada en línea o en la plataforma) la cotización queda con **contrato pendiente de firma**. La liga de pago (`/pagar/<token>`) muestra primero “Paso 1: firma tu contrato” y no deja pagar en línea hasta firmar; al aceptar la cotización en línea, el botón lleva directo al contrato.
- **Página del cliente `/contrato/<token>`** (misma liga de pago): datos del viaje, total y plan de pagos, cláusulas; el cliente escribe su nombre, marca la aceptación y **firma con el dedo o el mouse**. Se guarda copia del texto firmado, la imagen de la firma, fecha y hora, IP, dispositivo y **huella SHA-256**. Si el contrato cambió mientras lo leía, se le pide revisarlo de nuevo. Puede descargarlo/imprimirlo y le llega copia por correo; el vendedor y el administrador reciben aviso y queda en la ficha 360 y la bitácora.
- En el **Plan de pagos** se ve el estado del contrato: pendiente (con *Ver contrato*), firmado (y aviso si el total cambió después de la firma), *Pedir firma al cliente* para ventas anteriores y *Lo firmó en papel* (solo administrador).
- Configuración › **Contrato**: activar/desactivar, título, ciudad y cláusulas con variables (`{cliente}`, `{total}`, `{anticipo}`, `{politicas}`, `{terminos}`…) y vista previa. El texto sugerido es un punto de partida: debe revisarlo un abogado.
- Lógica en `public/contrato-core.js`; rutas en `src/contracts.js` (`GET /contrato/:token`, `GET /api/public/contract/:token`, `POST /api/public/contract/:token/sign`, `GET|PUT /api/contract/settings`, `GET|POST /api/quotes/:id/contract`). Campo interno `crm_quotes.contract`.

## Comisiones por proveedor (TP-205)

- Cada proveedor indica **cómo ganas**: *Tarifa neta* (utilidad = venta − costo) o *Comisionable* (el proveedor paga un % después del viaje), su % y los **días para cobrar** la comisión (30 por omisión).
- En **🧾 Reservas** cada servicio tiene *Cómo ganas*; las comisionables registran % y comisión esperada (se calcula sola), **fecha de cobro** (fin del servicio + días del proveedor) y estado **Pendiente / Facturada / Cobrada / Cancelada**, con aviso si se vence.
- Proveedores › **Comisiones por cobrar**: totales por cobrar, vencidas y cobradas en el mes, agrupadas por proveedor; el administrador y Operaciones cambian el estado (factura y fecha de cobro). API `PATCH /api/trips/:id/bookings/:bid/commission`.
- La utilidad de reportes y comisiones de vendedores ya suma estas comisiones.

## Metas y comisiones por vendedor (TP-206)

- Configuración › **Metas y comisiones**: meta mensual por vendedor (con ajuste para un mes específico), medida en ventas o en utilidad, y **% de comisión sobre la utilidad**.
- **Dashboard**: el vendedor ve su avance del mes (vendido vs. meta, lo que falta) y su comisión por liberar / por pagar / pagada; el administrador ve a todo el equipo. *Ver comisiones* abre el detalle por venta.
- La comisión queda **Por liberar** hasta que el cliente liquida su plan de pagos, luego **Por pagar**; el administrador la marca **Pagada** en Reportes › *Comisiones de vendedores* (se congela el monto pagado).
- Cálculo en `public/comisiones-core.js`; rutas `GET|PUT /api/goals`, `POST /api/quotes/:id/seller-commission`. Campo interno `crm_quotes.seller_commission`.

## Campos personalizables (TP-306)

- Configuración › **Campos personalizables** (administrador): campos propios para **Leads, Clientes y Viajes** de tipo texto corto o largo, número, fecha, lista (una o varias opciones) y Sí/No; obligatorio, “Mostrar en tarjetas”, ayuda, orden y activar/desactivar (desactivar oculta el campo sin borrar lo capturado).
- Aparecen en el formulario del lead, la ficha 360 del cliente (Datos del cliente y resumen en la línea de tiempo) y el viaje; como etiquetas en el tablero, la lista de leads y las tarjetas de viajes; en la búsqueda de leads; en la exportación a Excel/CSV; en la bitácora (un cambio por campo) y en las automatizaciones.
- Los obligatorios se piden al crear o editar desde el formulario; mover un lead en el tablero o los leads del bot y del formulario web no los exigen.
- Lógica en `public/campos-core.js`; API `GET|PUT /api/custom-fields`; campos internos `custom` en `crm_leads`, `crm_clients` y `crm_trips`.

## Constructor de automatizaciones (TP-307)

- Configuración › **Automatizaciones** (solo administrador): reglas “**Cuando** … **Si** … **Entonces** …” con interruptor de activa/apagada, duplicar, eliminar, historial de ejecuciones y **Probar sin hacer cambios** con un lead, viaje o cotización.
- **Cuando:** llega un lead nuevo (plataforma, bot o formulario), cambia de etapa, una cotización cambia de estado, se recibe un pago (o se liquida el viaje), un lead lleva N días sin movimiento, faltan N días para un viaje, pasaron N días del regreso, o la fecha de un campo personalizado (antes/después, cada año). Las de fecha se revisan cada hora en horario laboral y no se repiten.
- **Si:** condiciones sobre origen, destino, presupuesto, viajeros, etapa, prioridad, puntaje, vendedor, preferencias, monto, estado del viaje y cualquier campo personalizado (todas o alguna).
- **Entonces:** crear seguimiento, **tarea de WhatsApp con plantilla** (el vendedor la abre desde el seguimiento con “💬 Abrir plantilla” y se marca hecha al enviarla), correo al cliente (respeta “No contactar”), aviso al equipo (campanita y correo opcional), cambiar etapa, asignar vendedor, llenar un campo personalizado y agregar preferencia. Textos con `{nombre}`, `{cliente}`, `{destino}`, `{fechas}`, `{vendedor}`, `{folio}`, `{etapa}`, `{monto}`, `{dias}`.
- Se precargan 5 reglas de ejemplo **apagadas**. Los recordatorios existentes (TP-106, cobros, postviaje, campañas) siguen igual. Cada ejecución queda en la bitácora (“🤖 Automatización”).
- Lógica en `public/automatizaciones-core.js` y `src/automations.js`; API `GET|POST /api/automations`, `PUT|DELETE /api/automations/:id`, `POST /api/automations/test`, `POST /api/automations/run`. Campo interno `crm_followups.auto`.

## Diseño, avatares y recorrido guiado

- **Pantallas de cualquier tamaño:** el menú lateral se desplaza y se compacta en pantallas bajas (laptops con zoom), y en celular se abre con el botón ☰. Archivo: `public/ui.css`.
- **Íconos:** un solo juego de íconos de línea (estilo Lucide) en `public/iconos.js`. En HTML se usa `<i data-ic="nombre"></i>`; en JS, `icon('nombre')`.
- **Avatar de cada agente:** clic en la foto del menú → subir foto o elegir uno de 12 animales ilustrados con movimiento suave (`public/avatares.js`). Sin elección, cada usuario recibe un animal fijo por defecto. Se guarda en el ajuste `ui_prefs` (`PUT /api/me/avatar`).
- **Recorrido guiado:** aparece solo la primera vez que alguien entra, con la opción "No volver a mostrar". Se repite con "Abrir guía" en el menú, y cada sección tiene un botón **?** con su guía propia (`public/recorrido.js`). En Configuración → Usuarios, el administrador puede volver a mostrarlo a todo el equipo (`POST /api/tour/reset`).
