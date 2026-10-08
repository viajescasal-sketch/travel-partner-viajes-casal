'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { passwordResetEmail, testEmail } = require('./mailer');

const RESET_MINUTES = 30;
const RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_MESSAGE = 'Si el correo está registrado, te enviamos un enlace para crear una nueva contraseña. Revisa tu bandeja de entrada y la carpeta de spam.';

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Misma política que el cambio de contraseña.
function passwordPolicyError(password) {
  if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return 'La nueva contraseña debe tener 12 caracteres, mayúscula, minúscula y número';
  }
  if (password.length > 200) return 'La contraseña es demasiado larga';
  return null;
}

function appUrlFor(req, env) {
  const configured = String(env.APP_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

function createPasswordResetService(dataStore, mailer, env = process.env) {
  async function agencyName() {
    return (await dataStore.getSetting('agency'))?.name || 'Viajes Bumeran Casal';
  }

  // Genera el enlace, invalida los anteriores y envía el correo.
  async function issue(user, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    await dataStore.invalidatePasswordResets(user.id);
    await dataStore.createPasswordReset({ userId: user.id, tokenHash: hashToken(token), expiresAt: Date.now() + RESET_MINUTES * 60 * 1000, ip: req.ip });
    const link = `${appUrlFor(req, env)}/#reset=${token}`;
    const message = passwordResetEmail({ name: user.name, link, agencyName: await agencyName(), minutes: RESET_MINUTES });
    await mailer.send({ to: user.email, ...message });
    return { link };
  }

  async function validToken(token) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const reset = await dataStore.findPasswordReset(hashToken(token));
    if (!reset || reset.used_at || reset.expires_at < Date.now()) return null;
    const user = await dataStore.findUserById(reset.user_id);
    if (!user || !user.active) return null;
    return { reset, user };
  }

  return { issue, validToken, agencyName };
}

// Rutas públicas: “¿Olvidaste tu contraseña?”.
function createRecoveryRouter(dataStore, mailer, service, env = process.env) {
  const router = express.Router();
  const isProduction = env.NODE_ENV === 'production';
  const limiter = (limit) => rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { ok: false, error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' }
  });

  router.post('/forgot-password', limiter(5), async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) {
        return res.status(400).json({ ok: false, error: 'Escribe un correo válido' });
      }
      if (isProduction && !mailer.configured) {
        return res.status(503).json({ ok: false, error: 'La recuperación por correo aún no está activa. Pide al administrador una contraseña temporal.' });
      }
      // Se responde igual exista o no la cuenta, y el envío ocurre después de responder.
      res.json({ ok: true, message: GENERIC_MESSAGE });
      const user = await dataStore.findUserByEmail(email);
      if (!user || !user.active) return undefined;
      const last = await dataStore.lastPasswordResetAt(user.id);
      if (last && Date.now() - last < RESEND_COOLDOWN_MS) return undefined;
      try {
        await service.issue(user, req);
        await dataStore.logActivity(user.id, 'password_reset_requested', req);
      } catch (error) {
        console.error('No se pudo enviar el correo de recuperación:', error.message);
        await dataStore.logActivity(user.id, 'password_reset_mail_failed', req, { error: error.code || 'error' });
      }
      return undefined;
    } catch (error) {
      if (res.headersSent) return console.error(error);
      return next(error);
    }
  });

  router.post('/reset-password/verify', limiter(30), async (req, res, next) => {
    try {
      const found = await service.validToken(req.body?.token);
      res.json({ ok: true, valid: Boolean(found), name: found?.user.name || null });
    } catch (error) {
      next(error);
    }
  });

  router.post('/reset-password', limiter(10), async (req, res, next) => {
    try {
      const found = await service.validToken(req.body?.token);
      if (!found) return res.status(400).json({ ok: false, error: 'El enlace no es válido o ya venció. Solicita uno nuevo.' });
      const password = String(req.body?.newPassword || '');
      const policy = passwordPolicyError(password);
      if (policy) return res.status(400).json({ ok: false, error: policy });
      await dataStore.updatePassword(found.user.id, await bcrypt.hash(password, 12));
      await dataStore.invalidatePasswordResets(found.user.id);
      await dataStore.deleteTrustedDevices(found.user.id);
      await dataStore.logActivity(found.user.id, 'password_reset_completed', req);
      return res.json({ ok: true, message: 'Tu contraseña se actualizó. Ya puedes iniciar sesión.' });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

// Rutas del administrador: estado del correo, prueba y envío de enlace a un usuario.
function createMailAdminRouter(dataStore, mailer, service, { requireRole }, env = process.env) {
  const router = express.Router();
  const admin = requireRole('admin');
  const fail = (res, error) => res.status(502).json({ ok: false, error: `No se pudo enviar el correo (${error.code || error.responseCode || 'error'}). Revisa las variables SMTP en Hostinger.` });

  router.get('/settings/mail-status', admin, (req, res) => {
    res.json({ ok: true, configured: mailer.configured, from: mailer.from, appUrl: appUrlFor(req, env), appUrlConfigured: Boolean(env.APP_URL) });
  });

  router.post('/settings/test-email', admin, async (req, res) => {
    if (!mailer.configured) return res.status(400).json({ ok: false, error: 'El correo no está configurado todavía' });
    try {
      const user = req.session.user;
      await mailer.send({ to: user.email, ...testEmail({ name: user.name, agencyName: await service.agencyName(), appUrl: appUrlFor(req, env) }) });
      await dataStore.logActivity(user.id, 'mail_test_sent', req);
      return res.json({ ok: true, message: `Correo de prueba enviado a ${user.email}` });
    } catch (error) {
      console.error('Fallo el correo de prueba:', error.message);
      return fail(res, error);
    }
  });

  router.post('/users/:id/send-reset', admin, async (req, res) => {
    if (!mailer.configured) return res.status(400).json({ ok: false, error: 'Configura el correo de la plataforma para enviar enlaces' });
    const user = await dataStore.findUserById(Number(req.params.id));
    if (!user) return res.status(404).json({ ok: false, error: 'No se encontró el usuario' });
    if (!user.active) return res.status(400).json({ ok: false, error: 'El usuario está desactivado' });
    try {
      await service.issue(user, req);
      await dataStore.logActivity(req.session.user.id, 'password_reset_sent_by_admin', req, { id: user.id });
      return res.json({ ok: true, message: `Enlace enviado a ${user.email}` });
    } catch (error) {
      console.error('Fallo el envío del enlace:', error.message);
      return fail(res, error);
    }
  });

  return router;
}

module.exports = {
  RESET_MINUTES,
  GENERIC_MESSAGE,
  hashToken,
  passwordPolicyError,
  createPasswordResetService,
  createRecoveryRouter,
  createMailAdminRouter
};
