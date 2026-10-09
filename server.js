'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');
const bcrypt = require('bcryptjs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const session = require('express-session');
const MySQLSession = require('express-mysql-session')(session);
const { createDataStore, databaseConfigFromEnv } = require('./src/data-store');
const { createCrmRouter } = require('./src/crm-routes');
const { createUserRouter } = require('./src/user-routes');
const { ROLE_LABELS } = require('./src/access');
const { createMailer } = require('./src/mailer');
const { createLoginFlow, requiresTwofa } = require('./src/login-flow');
const { createPasswordResetService, createRecoveryRouter, createMailAdminRouter, passwordPolicyError } = require('./src/password-reset');
const { createBackupService, createBackupRouter } = require('./src/backup');
const { createBotRouter, createBotAdminRouter } = require('./src/bot-routes');
const { createWebform, createWebformAdminRouter } = require('./src/webform');
const { createAssignment, createAssignmentRouter } = require('./src/assignment');

const PORT = process.env.PORT || 3000;
const ACTIVITY_RETENTION_DAYS = 730;
const isProduction = process.env.NODE_ENV === 'production';
const publicDirectory = path.join(__dirname, 'public');
const indexFile = path.join(publicDirectory, 'index.html');

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    mustChangePassword: Boolean(user.must_change_password)
  };
}

// Huella de la contraseña: si el administrador la restablece, las sesiones abiertas se cierran.
const passwordStamp = (user) => String(user.password_hash || '').slice(-16);

function requireAuthentication(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ ok: false, error: 'Autenticación requerida' });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ ok: false, error: 'Acceso no autorizado' });
    }
    return next();
  };
}

async function createApp(options = {}) {
  if (!process.env.SESSION_SECRET) {
    throw new Error('Falta la variable de entorno SESSION_SECRET');
  }
  const app = express();
  const dataStore = options.dataStore || createDataStore(process.env);
  await dataStore.initialize();
  const mailer = options.mailer || createMailer(process.env);
  const resetService = createPasswordResetService(dataStore, mailer, process.env);
  // Conserva la bitácora 2 años: limpia al iniciar y una vez al día.
  const purge = () => dataStore.purgeActivity(ACTIVITY_RETENTION_DAYS)
    .then((n) => { if (n) console.log(`Bitácora: se eliminaron ${n} registros con más de 2 años`); })
    .catch((error) => console.error('No se pudo limpiar la bitácora:', error.message));
  await purge();
  if (!options.skipPurgeTimer) setInterval(purge, 24 * 60 * 60 * 1000).unref();
  // Respaldo automático diario (2:00 a.m. de Cancún) con copia por correo.
  const backupService = createBackupService({ dataStore, mailer });
  if (!options.skipPurgeTimer && !options.skipBackupTimer) backupService.start();
  const loginFlow = createLoginFlow({ dataStore, mailer, env: process.env, publicUser, passwordStamp, isProduction });

  if (isProduction) {
    app.set('trust proxy', 1);
  }

  // Revisa en cada petición que el usuario siga activo y toma su rol actual.
  const authenticate = async (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Autenticación requerida' });
    try {
      const user = await dataStore.findUserById(req.session.user.id);
      if (!user || !user.active || (req.session.pwd && req.session.pwd !== passwordStamp(user))) {
        await new Promise((resolve) => req.session.destroy(() => resolve()));
        return res.status(401).json({ ok: false, error: 'Tu sesión terminó. Vuelve a iniciar sesión.' });
      }
      // Sesiones abiertas antes de exigir el segundo paso deben volver a entrar.
      if (requiresTwofa(user) && !req.session.mfa) {
        await new Promise((resolve) => req.session.destroy(() => resolve()));
        return res.status(401).json({ ok: false, error: 'Por seguridad vuelve a iniciar sesión para verificar tu identidad.' });
      }
      req.session.user = publicUser(user);
      return next();
    } catch (error) {
      return next(error);
    }
  };

  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  const sessionOptions = {
    name: 'tp.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000
    }
  };

  if (isProduction) {
    sessionOptions.store = new MySQLSession({
      ...databaseConfigFromEnv(process.env),
      createDatabaseTable: true,
      expiration: sessionOptions.cookie.maxAge,
      schema: { tableName: 'user_sessions' }
    });
  }

  app.use(session(sessionOptions));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { ok: false, error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, app: 'Travel Partner Viajes Casal' });
  });

  app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const user = email ? await dataStore.findUserByEmail(email) : null;
      const valid = user?.active && await bcrypt.compare(password, user.password_hash);

      if (!valid) {
        await dataStore.logActivity(null, 'login_failed', req, { email });
        return res.status(401).json({ ok: false, error: 'Correo o contraseña incorrectos' });
      }

      return await loginFlow.startLogin(req, res, user);
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ ok: true, user: req.session.user });
  });

  app.post('/api/auth/change-password', authenticate, async (req, res, next) => {
    try {
      const currentPassword = String(req.body.currentPassword || '');
      const newPassword = String(req.body.newPassword || '');
      const policyError = passwordPolicyError(newPassword);
      if (policyError) return res.status(400).json({ ok: false, error: policyError });
      const user = await dataStore.findUserById(req.session.user.id);
      if (!user || !await bcrypt.compare(currentPassword, user.password_hash)) {
        return res.status(401).json({ ok: false, error: 'La contraseña actual es incorrecta' });
      }
      const passwordHash = await bcrypt.hash(newPassword, 12);
      await dataStore.updatePassword(user.id, passwordHash);
      req.session.user.mustChangePassword = false;
      req.session.pwd = passwordStamp({ password_hash: passwordHash });
      await dataStore.logActivity(user.id, 'password_changed', req);
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/auth/logout', authenticate, async (req, res, next) => {
    const userId = req.session.user.id;
    try {
      await dataStore.logActivity(userId, 'logout', req);
      await new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
      res.clearCookie('tp.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax' });
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // Bitácora completa con filtros (solo administradores).
  app.get('/api/activity', authenticate, requireRole('admin'), async (req, res, next) => {
    try {
      const q = req.query;
      const dayMs = (value, plusDays = 0) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
        const ms = Date.parse(`${value}T00:00:00-05:00`);
        return Number.isNaN(ms) ? null : ms + plusDays * 86400000;
      };
      const items = await dataStore.listActivity({
        userId: Number(q.user) || null,
        type: ['crm', 'security'].includes(q.type) ? q.type : null,
        entity: ['clients', 'leads', 'quotes', 'trips', 'followups'].includes(q.entity) ? q.entity : null,
        entityId: Number(q.entityId) || null,
        fromMs: dayMs(q.from),
        toMs: dayMs(q.to, 1),
        beforeId: Number(q.before) || null,
        limit: Number(q.limit) || 100
      });
      res.json({ ok: true, items, activity: items });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api/auth', loginFlow.router);
  app.use('/api/auth', createRecoveryRouter(dataStore, mailer, resetService, process.env));
  // Bot de WhatsApp (Botpress): entra con su propia clave, no con sesión.
  const assignment = createAssignment(dataStore, mailer, process.env);
  const bot = createBotRouter(dataStore, { assignment });
  app.use('/api', bot.router);
  // Formulario web público (sitio y landings): crea el lead sin sesión.
  const webform = createWebform(dataStore, mailer, process.env, { assignment });
  app.use('/api', webform.router);
  app.use('/api', authenticate);
  // Si el servidor estuvo dormido a la hora del respaldo, se revisa al primer uso (máximo cada 5 minutos).
  let lastBackupCheck = 0;
  app.use('/api', (req, res, next) => {
    if (!options.skipPurgeTimer && Date.now() - lastBackupCheck > 5 * 60 * 1000) {
      lastBackupCheck = Date.now();
      backupService.runIfDue().catch((error) => console.error('Respaldo automático falló:', error.message));
    }
    next();
  });
  app.use('/api', (req, res, next) => {
    if (req.session.user.mustChangePassword) {
      return res.status(403).json({ ok: false, error: 'Cambia tu contraseña temporal para continuar' });
    }
    return next();
  });
  app.use('/api/account', loginFlow.account);
  app.post('/api/users/:id/reset-2fa', requireRole('admin'), loginFlow.adminReset);
  app.use('/api', createMailAdminRouter(dataStore, mailer, resetService, { requireRole }, process.env));
  app.use('/api/users', createUserRouter(dataStore, { requireRole, destroyUserSessions: async () => {} }));
  app.use('/api', createBackupRouter(dataStore, backupService, { requireRole }));
  app.use('/api', createBotAdminRouter(dataStore, bot, { requireRole }));
  app.use('/api', createWebformAdminRouter(dataStore, webform, { requireRole }));
  app.use('/api', createAssignmentRouter(dataStore, assignment, { requireRole }));
  app.use('/api', createCrmRouter(dataStore, { requireRole, assignment }));
  // La página del formulario se puede mostrar dentro de otros sitios (iframe); el resto de la plataforma no.
  const formPage = path.join(publicDirectory, 'formulario.html');
  app.get(['/formulario', '/formulario.html'], (req, res) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', String(res.getHeader('Content-Security-Policy') || '').replace("frame-ancestors 'none'", 'frame-ancestors *'));
    res.set('Cache-Control', 'no-cache');
    res.sendFile(formPage);
  });
  app.get('/formulario-embed.js', (req, res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(publicDirectory, 'formulario-embed.js'));
  });
  app.use(express.static(publicDirectory, { index: false, dotfiles: 'ignore' }));

  app.get('*', (req, res, next) => {
    if (req.accepts('html') && !path.extname(req.path)) return res.sendFile(indexFile);
    return next();
  });

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'Recurso no encontrado' }));
  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    const message = status >= 500 ? 'Error interno del servidor' : (error.expose && error.message) || 'Solicitud inválida';
    res.status(status).json({ ok: false, error: message });
  });

  app.locals.dataStore = dataStore;
  app.locals.mailer = mailer;
  app.locals.backupService = backupService;
  return app;
}

// Página mientras la plataforma termina de arrancar (por ejemplo, justo después de publicar).
const STARTING_PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>Actualizando · Travel Partner</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7f9;font-family:Arial,Helvetica,sans-serif;color:#203342"><main style="max-width:420px;padding:24px;text-align:center"><h1 style="color:#073b66;font-size:22px">Estamos actualizando la plataforma</h1><p>Tarda menos de un minuto. Esta página se recarga sola.</p></main></body></html>`;

async function start() {
  const bootstrapApp = express();
  bootstrapApp.disable('x-powered-by');
  let ready = false;
  bootstrapApp.get('/api/health', (_req, res) => {
    res.json({ ok: true, app: 'Travel Partner Viajes Casal', ready });
  });
  bootstrapApp.use((req, res, next) => {
    if (ready) return next();
    res.set('Retry-After', '10');
    res.set('Cache-Control', 'no-store');
    if (req.path.startsWith('/api/')) return res.status(503).json({ ok: false, error: 'La plataforma se está actualizando. Intenta de nuevo en un minuto.' });
    return res.status(503).type('html').send(STARTING_PAGE);
  });

  const server = bootstrapApp.listen(PORT, () => {
    console.log(`Travel Partner Viajes Casal disponible en http://localhost:${PORT}`);
  });

  try {
    const app = await createApp();
    bootstrapApp.use(app);
    ready = true;
    console.log('Travel Partner Viajes Casal lista');
  } catch (error) {
    server.close();
    throw error;
  }
}

if (process.env.NODE_ENV !== 'test') {
  start().catch((error) => {
    console.error('No se pudo iniciar Travel Partner:', error.message);
    process.exit(1);
  });
}

module.exports = { createApp, requireAuthentication, requireRole };
