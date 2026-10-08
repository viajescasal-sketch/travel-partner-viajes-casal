'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const tf = require('./twofa');
const { twofaCodeEmail } = require('./mailer');

const PENDING_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

// Administradores siempre; el resto solo si la activó.
const requiresTwofa = (user) => user.role === 'admin' || Boolean(user.twofa_enabled) || Boolean(user.totp_enabled);
const emailCodeHash = (userId, code) => tf.sha256(`email:${userId}:${code}`);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function createLoginFlow({ dataStore, mailer, env = process.env, publicUser, passwordStamp, isProduction }) {
  const sessionSecret = env.SESSION_SECRET;
  const cookieOptions = (maxAge) => ({ httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/', maxAge });

  const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((error) => (error ? reject(error) : resolve())));
  const agencyName = async () => (await dataStore.getSetting('agency'))?.name || 'Viajes Bumeran Casal';

  async function sendEmailCode(user) {
    const code = tf.generateEmailCode();
    await dataStore.createEmailCode({ userId: user.id, codeHash: emailCodeHash(user.id, code), expiresAt: Date.now() + tf.EMAIL_CODE_MINUTES * 60 * 1000 });
    await mailer.send({ to: user.email, ...twofaCodeEmail({ name: user.name, code, agencyName: await agencyName(), minutes: tf.EMAIL_CODE_MINUTES }) });
  }

  // Inicia la sesión completa (después de la contraseña y, si aplica, del código).
  async function complete(req, res, user, { mfa, method, remember }) {
    await regenerate(req);
    req.session.user = publicUser(user);
    req.session.pwd = passwordStamp(user);
    req.session.mfa = Boolean(mfa);
    await dataStore.touchLogin(user.id);
    await dataStore.logActivity(user.id, 'login_success', req, method ? { twofa: method } : null);
    if (remember && mfa) {
      const token = crypto.randomBytes(32).toString('base64url');
      const maxAge = tf.TRUSTED_DAYS * 24 * 60 * 60 * 1000;
      await dataStore.createTrustedDevice({ userId: user.id, tokenHash: tf.sha256(token), expiresAt: Date.now() + maxAge, userAgent: req.get('user-agent') });
      res.cookie(tf.TRUSTED_COOKIE, token, cookieOptions(maxAge));
    }
    return res.json({ ok: true, user: req.session.user });
  }

  // Paso 1: la contraseña ya es correcta. Decide si pide código.
  async function startLogin(req, res, user) {
    if (!requiresTwofa(user)) return complete(req, res, user, { mfa: false });

    const trustedToken = tf.readCookie(req, tf.TRUSTED_COOKIE);
    if (trustedToken) {
      const device = await dataStore.findTrustedDevice(tf.sha256(trustedToken));
      if (device && device.user_id === user.id && device.expires_at > Date.now()) {
        await dataStore.touchTrustedDevice(device.id);
        return complete(req, res, user, { mfa: true, method: 'equipo recordado' });
      }
    }

    // Sin correo configurado ni app: no se bloquea el acceso, pero queda registrado.
    if (!user.totp_enabled && !mailer.configured) {
      await dataStore.logActivity(user.id, 'twofa_skipped_no_mail', req);
      return complete(req, res, user, { mfa: true, method: 'omitido sin correo' });
    }

    await regenerate(req);
    const method = user.totp_enabled ? 'app' : 'email';
    req.session.pending = { userId: user.id, at: Date.now(), attempts: 0, method };
    if (method === 'email') {
      try {
        await sendEmailCode(user);
      } catch (error) {
        console.error('No se pudo enviar el código de verificación:', error.message);
        delete req.session.pending;
        throw httpError(502, 'No pudimos enviar el código a tu correo. Intenta de nuevo en unos minutos.');
      }
    }
    return res.json({ ok: true, twofa: { method, email: tf.maskEmail(user.email), canUseEmail: mailer.configured } });
  }

  // ---- Rutas públicas del segundo paso ----
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { ok: false, error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' }
  });

  async function pendingUser(req) {
    const pending = req.session?.pending;
    if (!pending || Date.now() - pending.at > PENDING_MINUTES * 60 * 1000) {
      if (req.session) delete req.session.pending;
      throw httpError(401, 'La verificación venció. Vuelve a iniciar sesión.');
    }
    const user = await dataStore.findUserById(pending.userId);
    if (!user || !user.active) {
      delete req.session.pending;
      throw httpError(401, 'Vuelve a iniciar sesión.');
    }
    return { pending, user };
  }

  router.post('/2fa/verify', limiter, async (req, res, next) => {
    try {
      const { pending, user } = await pendingUser(req);
      const raw = String(req.body?.code || '').trim();
      const digits = raw.replace(/\s/g, '');
      let method = null;

      if (/^\d{6}$/.test(digits)) {
        if (user.totp_enabled) {
          const secret = tf.decryptSecret(user.totp_secret, sessionSecret);
          if (secret && tf.verifyTotp(secret, digits)) method = 'app';
        }
        if (!method) {
          const code = await dataStore.activeEmailCode(user.id);
          if (code && code.attempts < MAX_ATTEMPTS) {
            if (code.code_hash === emailCodeHash(user.id, digits)) {
              await dataStore.useEmailCode(code.id);
              method = 'correo';
            } else {
              await dataStore.addCodeAttempt(code.id);
            }
          }
        }
      } else if (tf.normalizeBackupCode(raw).length === 8) {
        const codes = JSON.parse(user.backup_codes || '[]');
        const index = codes.indexOf(tf.hashBackupCode(raw));
        if (index >= 0) {
          codes.splice(index, 1);
          await dataStore.updateUserSecurity(user.id, { backup_codes: JSON.stringify(codes) });
          await dataStore.logActivity(user.id, 'twofa_backup_code_used', req, { left: codes.length });
          method = 'código de respaldo';
        }
      }

      if (!method) {
        pending.attempts += 1;
        if (pending.attempts >= MAX_ATTEMPTS) {
          delete req.session.pending;
          await dataStore.logActivity(user.id, 'twofa_failed', req);
          throw httpError(401, 'Demasiados códigos incorrectos. Vuelve a iniciar sesión.');
        }
        throw httpError(400, `Código incorrecto. Te quedan ${MAX_ATTEMPTS - pending.attempts} intentos.`);
      }
      return complete(req, res, user, { mfa: true, method, remember: Boolean(req.body?.remember) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/2fa/send-email', limiter, async (req, res, next) => {
    try {
      const { user } = await pendingUser(req);
      if (!mailer.configured) throw httpError(400, 'El correo de la plataforma no está configurado');
      // La pausa solo aplica si hay un código pendiente enviado hace menos de 60 s.
      const last = (await dataStore.activeEmailCode(user.id))?.created_at;
      if (last && Date.now() - last < RESEND_COOLDOWN_MS) {
        throw httpError(429, `Espera ${Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - last)) / 1000)} segundos para pedir otro código.`);
      }
      try {
        await sendEmailCode(user);
      } catch (error) {
        console.error('No se pudo reenviar el código:', error.message);
        throw httpError(502, 'No pudimos enviar el código. Intenta de nuevo en unos minutos.');
      }
      req.session.pending.method = 'email';
      return res.json({ ok: true, email: tf.maskEmail(user.email) });
    } catch (error) {
      return next(error);
    }
  });

  // ---- “Mi cuenta”: requiere sesión ----
  const account = express.Router();
  const wrap = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error); } };
  const me = async (req) => dataStore.findUserById(req.session.user.id);
  async function checkPassword(user, password) {
    if (!password || !(await bcrypt.compare(String(password), user.password_hash))) throw httpError(400, 'La contraseña no es correcta');
  }

  async function status(user) {
    return {
      required: user.role === 'admin',
      active: requiresTwofa(user),
      email: user.role === 'admin' || Boolean(user.twofa_enabled),
      app: Boolean(user.totp_enabled),
      backupCodesLeft: JSON.parse(user.backup_codes || '[]').length,
      trustedDevices: await dataStore.countTrustedDevices(user.id),
      mailConfigured: mailer.configured,
      email_masked: tf.maskEmail(user.email)
    };
  }

  account.get('/', wrap(async (req, res) => {
    const user = await me(req);
    res.json({ ok: true, user: publicUser(user), twofa: await status(user) });
  }));

  // Vendedores y Operaciones: activar o desactivar el código por correo.
  account.post('/twofa', wrap(async (req, res) => {
    const user = await me(req);
    const enabled = Boolean(req.body?.enabled);
    if (user.role === 'admin') throw httpError(400, 'Para administradores la verificación es obligatoria');
    if (enabled) {
      if (!mailer.configured && !user.totp_enabled) throw httpError(400, 'El correo de la plataforma no está configurado');
      await dataStore.updateUserSecurity(user.id, { twofa_enabled: true });
      req.session.mfa = true;
    } else {
      await checkPassword(user, req.body?.password);
      await dataStore.updateUserSecurity(user.id, { twofa_enabled: false, totp_enabled: false, totp_secret: null, backup_codes: null });
      await dataStore.deleteTrustedDevices(user.id);
    }
    await dataStore.logActivity(user.id, enabled ? 'twofa_enabled' : 'twofa_disabled', req);
    res.json({ ok: true, twofa: await status(await me(req)) });
  }));

  account.post('/totp/setup', wrap(async (req, res) => {
    const user = await me(req);
    const secret = tf.generateTotpSecret();
    req.session.totpSetup = { secret, at: Date.now() };
    const url = tf.otpauthUrl(secret, user.email, await agencyName());
    res.json({ ok: true, secret, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
  }));

  account.post('/totp/enable', wrap(async (req, res) => {
    const user = await me(req);
    const setup = req.session.totpSetup;
    if (!setup || Date.now() - setup.at > 15 * 60 * 1000) throw httpError(400, 'Vuelve a empezar la configuración de la app');
    if (!tf.verifyTotp(setup.secret, req.body?.code)) throw httpError(400, 'El código no coincide. Revisa que la hora de tu celular sea automática.');
    const codes = tf.generateBackupCodes();
    await dataStore.updateUserSecurity(user.id, {
      totp_enabled: true,
      totp_secret: tf.encryptSecret(setup.secret, sessionSecret),
      backup_codes: JSON.stringify(codes.map(tf.hashBackupCode)),
      twofa_enabled: true
    });
    delete req.session.totpSetup;
    req.session.mfa = true;
    await dataStore.logActivity(user.id, 'totp_enabled', req);
    res.json({ ok: true, backupCodes: codes, twofa: await status(await me(req)) });
  }));

  account.post('/totp/disable', wrap(async (req, res) => {
    const user = await me(req);
    await checkPassword(user, req.body?.password);
    await dataStore.updateUserSecurity(user.id, { totp_enabled: false, totp_secret: null, backup_codes: null });
    await dataStore.logActivity(user.id, 'totp_disabled', req);
    res.json({ ok: true, twofa: await status(await me(req)) });
  }));

  account.post('/backup-codes', wrap(async (req, res) => {
    const user = await me(req);
    if (!user.totp_enabled) throw httpError(400, 'Los códigos de respaldo son para quienes usan una app');
    await checkPassword(user, req.body?.password);
    const codes = tf.generateBackupCodes();
    await dataStore.updateUserSecurity(user.id, { backup_codes: JSON.stringify(codes.map(tf.hashBackupCode)) });
    await dataStore.logActivity(user.id, 'backup_codes_regenerated', req);
    res.json({ ok: true, backupCodes: codes });
  }));

  account.post('/forget-devices', wrap(async (req, res) => {
    await dataStore.deleteTrustedDevices(req.session.user.id);
    res.clearCookie(tf.TRUSTED_COOKIE, cookieOptions(0));
    await dataStore.logActivity(req.session.user.id, 'trusted_devices_cleared', req);
    res.json({ ok: true });
  }));

  // Administrador: quitar la app y los equipos recordados de otro usuario (celular perdido).
  async function adminReset(req, res, next) {
    try {
      const id = Number(req.params.id);
      const user = await dataStore.findUserById(id);
      if (!user) throw httpError(404, 'No se encontró el usuario');
      await dataStore.updateUserSecurity(id, { totp_enabled: false, totp_secret: null, backup_codes: null });
      await dataStore.deleteTrustedDevices(id);
      await dataStore.logActivity(req.session.user.id, 'twofa_reset_by_admin', req, { id });
      res.json({ ok: true, message: `Se quitó la app y los equipos recordados de ${user.name}. Recibirá el código por correo.` });
    } catch (error) {
      next(error);
    }
  }

  return { startLogin, router, account, adminReset, requiresTwofa };
}

module.exports = { createLoginFlow, requiresTwofa };
