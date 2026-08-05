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

const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const publicDirectory = path.join(__dirname, 'public');
const indexFile = path.join(publicDirectory, 'index.html');

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: Boolean(user.must_change_password)
  };
}

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

  if (isProduction) {
    app.set('trust proxy', 1);
  }

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
  app.use(express.json({ limit: '100kb' }));
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
      createDatabaseTable: true,
      expiration: sessionOptions.cookie.maxAge,
      schema: { tableName: 'user_sessions' }
    }, databaseConfigFromEnv(process.env));
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

      await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
      req.session.user = publicUser(user);
      await dataStore.logActivity(user.id, 'login_success', req);
      return res.json({ ok: true, user: req.session.user });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/auth/me', requireAuthentication, (req, res) => {
    res.json({ ok: true, user: req.session.user });
  });

  app.post('/api/auth/change-password', requireAuthentication, async (req, res, next) => {
    try {
      const currentPassword = String(req.body.currentPassword || '');
      const newPassword = String(req.body.newPassword || '');
      if (newPassword.length < 12 || !/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
        return res.status(400).json({ ok: false, error: 'La nueva contraseña debe tener 12 caracteres, mayúscula, minúscula y número' });
      }
      const user = await dataStore.findUserById(req.session.user.id);
      if (!user || !await bcrypt.compare(currentPassword, user.password_hash)) {
        return res.status(401).json({ ok: false, error: 'La contraseña actual es incorrecta' });
      }
      const passwordHash = await bcrypt.hash(newPassword, 12);
      await dataStore.updatePassword(user.id, passwordHash);
      req.session.user.mustChangePassword = false;
      await dataStore.logActivity(user.id, 'password_changed', req);
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/auth/logout', requireAuthentication, async (req, res, next) => {
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

  app.get('/api/users', requireAuthentication, requireRole('admin'), async (_req, res, next) => {
    try {
      res.json({ ok: true, users: await dataStore.listUsers() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/activity', requireAuthentication, requireRole('admin'), async (_req, res, next) => {
    try {
      res.json({ ok: true, activity: await dataStore.listActivity() });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', requireAuthentication);
  app.use(express.static(publicDirectory, { index: false, dotfiles: 'ignore' }));

  app.get('*', (req, res, next) => {
    if (req.accepts('html') && !path.extname(req.path)) return res.sendFile(indexFile);
    return next();
  });

  app.use((_req, res) => res.status(404).json({ ok: false, error: 'Recurso no encontrado' }));
  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ ok: false, error: status >= 500 ? 'Error interno del servidor' : 'Solicitud inválida' });
  });

  app.locals.dataStore = dataStore;
  return app;
}

async function start() {
  const app = await createApp();
  app.listen(PORT, () => console.log(`Travel Partner Viajes Casal disponible en http://localhost:${PORT}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('No se pudo iniciar Travel Partner:', error.message);
    process.exit(1);
  });
}

module.exports = { createApp, requireAuthentication, requireRole };
