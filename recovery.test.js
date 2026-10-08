'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_INITIAL_PASSWORD = 'AdminTemporal123';
process.env.PARTNER_EMAIL = 'paulina@example.test';
process.env.PARTNER_INITIAL_PASSWORD = 'PartnerTemporal123';
process.env.APP_URL = 'https://travelpartner.viajescasal.com/';

const { createApp } = require('../server');
const { MySQLDataStore } = require('../src/data-store');
const { hashToken, GENERIC_MESSAGE } = require('../src/password-reset');

// Correo simulado: guarda lo que se “envía”.
function fakeMailer() {
  const sent = [];
  return { configured: true, from: 'no-responder@viajescasal.com', sent, async send(message) { sent.push(message); return { delivered: true }; } };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tokenFrom = (message) => /#reset=([\w-]+)/.exec(message.text)[1];

async function startApp(context, mailer) {
  let dataStore;
  if (process.env.TEST_DB_NAME) {
    dataStore = new MySQLDataStore({ ...process.env, DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1', DB_NAME: process.env.TEST_DB_NAME, DB_USER: process.env.TEST_DB_USER, DB_PASSWORD: process.env.TEST_DB_PASSWORD });
    context.after(() => dataStore.pool.end());
  }
  const app = await createApp({ mailer, ...(dataStore ? { dataStore } : {}) });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, app };
}

function clientFor(baseUrl) {
  let cookie = '';
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return call;
}

test('recuperación de contraseña por correo', async (context) => {
  const mailer = fakeMailer();
  const { baseUrl, app } = await startApp(context, mailer);
  const anon = clientFor(baseUrl);

  // Correo inválido
  assert.equal((await anon('POST', '/api/auth/forgot-password', { email: 'no-es-correo' })).status, 400);

  // Correo inexistente: misma respuesta y ningún envío
  const unknown = await anon('POST', '/api/auth/forgot-password', { email: 'nadie@example.test' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.message, GENERIC_MESSAGE);
  await wait(80);
  assert.equal(mailer.sent.length, 0);

  // Paulina con sesión abierta
  const paulina = clientFor(baseUrl);
  assert.equal((await paulina('POST', '/api/auth/login', { email: 'paulina@example.test', password: 'PartnerTemporal123' })).status, 200);
  assert.equal((await paulina('GET', '/api/auth/me')).status, 200);

  // Solicitud real (mayúsculas y espacios en el correo)
  const asked = await anon('POST', '/api/auth/forgot-password', { email: '  Paulina@Example.test ' });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.message, GENERIC_MESSAGE);
  await wait(80);
  assert.equal(mailer.sent.length, 1);
  const mail = mailer.sent[0];
  assert.equal(mail.to, 'paulina@example.test');
  assert.match(mail.subject, /nueva contraseña/i);
  assert.match(mail.text, /^Hola Paulina/);
  assert.match(mail.text, /30 minutos/);
  assert.ok(mail.html.includes('https://travelpartner.viajescasal.com/#reset='), 'usa APP_URL sin doble barra');
  const token = tokenFrom(mail);
  assert.ok(token.length >= 40);

  // Repetir de inmediato no manda otro correo (pausa de 60 s)
  await anon('POST', '/api/auth/forgot-password', { email: 'paulina@example.test' });
  await wait(80);
  assert.equal(mailer.sent.length, 1);

  // Verificación del enlace
  assert.deepEqual((await anon('POST', '/api/auth/reset-password/verify', { token })).body, { ok: true, valid: true, name: 'Paulina' });
  assert.equal((await anon('POST', '/api/auth/reset-password/verify', { token: 'inventado' })).body.valid, false);

  // Contraseña débil
  const weak = await anon('POST', '/api/auth/reset-password', { token, newPassword: 'corta' });
  assert.equal(weak.status, 400);
  assert.match(weak.body.error, /12 caracteres/);

  // Cambio exitoso
  const done = await anon('POST', '/api/auth/reset-password', { token, newPassword: 'RecuperadaPaulina2026' });
  assert.equal(done.status, 200);
  // El enlace ya no sirve
  assert.equal((await anon('POST', '/api/auth/reset-password', { token, newPassword: 'OtraClaveSegura2026' })).status, 400);
  assert.equal((await anon('POST', '/api/auth/reset-password/verify', { token })).body.valid, false);
  // La sesión abierta se cerró
  assert.equal((await paulina('GET', '/api/auth/me')).status, 401);
  // Contraseña vieja falla, la nueva funciona y ya no pide cambio obligatorio
  assert.equal((await clientFor(baseUrl)('POST', '/api/auth/login', { email: 'paulina@example.test', password: 'PartnerTemporal123' })).status, 401);
  const relogin = await clientFor(baseUrl)('POST', '/api/auth/login', { email: 'paulina@example.test', password: 'RecuperadaPaulina2026' });
  assert.equal(relogin.status, 200);
  assert.equal(relogin.body.user.mustChangePassword, false);

  // Enlace vencido
  const dataStore = app.locals.dataStore;
  const paulinaUser = await dataStore.findUserByEmail('paulina@example.test');
  await dataStore.createPasswordReset({ userId: paulinaUser.id, tokenHash: hashToken('vencido-123'), expiresAt: Date.now() - 1000 });
  assert.equal((await anon('POST', '/api/auth/reset-password', { token: 'vencido-123', newPassword: 'RecuperadaPaulina2027' })).status, 400);

  // --- Administrador ---
  const admin = clientFor(baseUrl);
  const adminLogin = await admin('POST', '/api/auth/login', { email: 'admin@example.test', password: 'AdminTemporal123' });
  assert.equal(adminLogin.body.twofa.method, 'email', 'el administrador necesita código');
  const adminCode = /(\d{6})/.exec(mailer.sent.at(-1).subject)[1];
  assert.equal((await admin('POST', '/api/auth/2fa/verify', { code: adminCode })).status, 200);
  await admin('POST', '/api/auth/change-password', { currentPassword: 'AdminTemporal123', newPassword: 'AdminNueva2026x' });
  const status = await admin('GET', '/api/settings/mail-status');
  assert.deepEqual([status.body.configured, status.body.appUrl], [true, 'https://travelpartner.viajescasal.com']);
  const testMail = await admin('POST', '/api/settings/test-email');
  assert.equal(testMail.status, 200);
  assert.equal(mailer.sent.at(-1).to, 'admin@example.test');
  const sentByAdmin = await admin('POST', `/api/users/${paulinaUser.id}/send-reset`);
  assert.equal(sentByAdmin.status, 200);
  assert.equal(mailer.sent.at(-1).to, 'paulina@example.test');
  // El enlace nuevo invalida el anterior pendiente
  const second = tokenFrom(mailer.sent.at(-1));
  await admin('POST', `/api/users/${paulinaUser.id}/send-reset`);
  assert.equal((await anon('POST', '/api/auth/reset-password/verify', { token: second })).body.valid, false);

  // Un vendedor no accede a las rutas de correo, pero el CRM le sigue funcionando
  const seller = clientFor(baseUrl);
  await seller('POST', '/api/auth/login', { email: 'paulina@example.test', password: 'RecuperadaPaulina2026' });
  assert.equal((await seller('GET', '/api/settings/mail-status')).status, 403);
  assert.equal((await seller('POST', `/api/users/${paulinaUser.id}/send-reset`)).status, 403);
  assert.equal((await seller('GET', '/api/crm')).status, 200);

  // Usuario desactivado: no recibe correo
  await admin('PATCH', `/api/users/${paulinaUser.id}`, { active: false });
  const before = mailer.sent.length;
  const lastToken = tokenFrom(mailer.sent.at(-1));
  assert.equal((await anon('POST', '/api/auth/reset-password/verify', { token: lastToken })).body.valid, false, 'enlace de usuario desactivado no sirve');
  await anon('POST', '/api/auth/forgot-password', { email: 'admin@example.test' });
  await wait(80);
  assert.equal(mailer.sent.length, before + 1, 'el admin sí lo recibe');

  // Límite de intentos por IP
  let limited = false;
  for (let i = 0; i < 6; i += 1) {
    if ((await anon('POST', '/api/auth/forgot-password', { email: 'x@example.test' })).status === 429) limited = true;
  }
  assert.ok(limited, 'se bloquean demasiados intentos');
});
