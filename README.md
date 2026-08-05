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

- Login demostrativo sin autenticación real.
- Dashboard, leads, cotizaciones, clientes, viajes, seguimientos, reportes y configuración.
- Navegación responsive y modo oscuro.
- Formularios locales para leads y cotizaciones.
- Duplicación local de cotizaciones.
- Vista imprimible individual para guardar una cotización como PDF desde el navegador.
- Selección validada de hasta tres cotizaciones del mismo cliente.
- Preparación de un único mensaje de WhatsApp.
- Login real con contraseñas hasheadas mediante bcrypt.
- Sesiones seguras y persistentes en MySQL para producción.
- Roles `admin` y `travel_partner`.
- Cierre de sesión, cambio obligatorio de contraseña y registro de actividad.
- Helmet y limitación de intentos de acceso.

Los datos comerciales siguen siendo demostrativos y se reinician al recargar. MySQL almacena únicamente acceso, sesiones y actividad. Los enlaces persistentes de PDF se habilitarán cuando se conecte Google Drive; no se incluyen OpenAI API, WhatsApp API, CRM real ni secretos.

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
