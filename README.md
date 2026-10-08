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
│   ├── crm-routes.js
│   ├── crm-schema.js
│   └── data-store.js
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
