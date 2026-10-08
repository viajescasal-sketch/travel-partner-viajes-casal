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
