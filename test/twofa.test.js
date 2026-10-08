'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_INITIAL_PASSWORD = 'AdminTemporal123';
process.env.PARTNER_EMAIL = 'paulina@example.test';
process.env.PARTNER_INITIAL_PASSWORD = 'PartnerTemporal123';

const { createApp } = require('../server');
const { MySQLDataStore } = require('../src/data-store');
const { totpAt } = require('../src/twofa');

function fakeMailer() {
  const sent = [];
  return { configured: true, from: 'no-responder@viajescasal.com', sent, async send(message) { sent.push(message); return { delivered: true }; } };
}
const codeFrom = (mail) => /(\d{6})/.exec(mail.subject)[1];
const totpNow = (secret) => totpAt(secret, Math.floor(Date.now() / 30000));

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
  return `http://127.0.0.1:${server.address().port}`;
}

// Navegador simulado con todas sus cookies (sesión y equipo recordado).
function browser(baseUrl, jar = new Map()) {
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [key, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (!value || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(key); else jar.set(key, value);
    }
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  call.jar = jar;
  call.forgetSession = () => jar.delete('tp.sid');
  return call;
}

test('verificación en dos pasos', async (context) => {
  const mailer = fakeMailer();
  const baseUrl = await startApp(context, mailer);

  // --- Administrador: código por correo obligatorio ---
  const admin = browser(baseUrl);
  const step1 = await admin('POST', '/api/auth/login', { email: 'admin@example.test', password: 'AdminTemporal123' });
  assert.equal(step1.status, 200);
  assert.deepEqual(step1.body.twofa, { method: 'email', email: 'a***n@example.test', canUseEmail: true });
  assert.equal(step1.body.user, undefined, 'todavía no hay sesión');
  assert.equal((await admin('GET', '/api/auth/me')).status, 401);
  assert.equal((await admin('GET', '/api/crm')).status, 401);
  const mail = mailer.sent.at(-1);
  assert.equal(mail.to, 'admin@example.test');
  assert.match(mail.text, /10 minutos/);
  const code = codeFrom(mail);

  const wrong = await admin('POST', '/api/auth/2fa/verify', { code: code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /4 intentos/);
  assert.equal((await admin('POST', '/api/auth/2fa/send-email')).status, 429, 'pausa de 60 s para reenviar');
  const ok = await admin('POST', '/api/auth/2fa/verify', { code, remember: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'admin');
  assert.ok(admin.jar.has('tp.td'), 'equipo recordado');
  assert.equal((await admin('POST', '/api/auth/2fa/verify', { code })).status, 401, 'el código no se reutiliza');
  assert.equal((await admin('POST', '/api/auth/change-password', { currentPassword: 'AdminTemporal123', newPassword: 'AdminNueva2026x' })).status, 200);

  // Equipo recordado: siguiente inicio sin código
  await admin('POST', '/api/auth/logout');
  const sentBefore = mailer.sent.length;
  const remembered = await admin('POST', '/api/auth/login', { email: 'admin@example.test', password: 'AdminNueva2026x' });
  assert.equal(remembered.body.user?.role, 'admin');
  assert.equal(mailer.sent.length, sentBefore, 'no se envió código');

  // La cookie de un equipo recordado no sirve para otra cuenta
  const paulina = browser(baseUrl, new Map([['tp.td', admin.jar.get('tp.td')]]));
  const p1 = await paulina('POST', '/api/auth/login', { email: 'paulina@example.test', password: 'PartnerTemporal123' });
  assert.equal(p1.body.user.role, 'travel_partner', 'vendedor sin verificación activada entra directo');
  await paulina('POST', '/api/auth/change-password', { currentPassword: 'PartnerTemporal123', newPassword: 'PaulinaNueva2026' });

  // --- Vendedor activa la verificación por correo ---
  const acc = await paulina('GET', '/api/account');
  assert.deepEqual([acc.body.twofa.required, acc.body.twofa.active], [false, false]);
  assert.equal((await paulina('POST', '/api/account/twofa', { enabled: true })).body.twofa.active, true);
  assert.equal((await paulina('GET', '/api/crm')).status, 200, 'la sesión actual sigue activa');
  await paulina('POST', '/api/auth/logout');
  const p2 = await paulina('POST', '/api/auth/login', { email: 'paulina@example.test', password: 'PaulinaNueva2026' });
  assert.equal(p2.body.twofa.method, 'email', 'la cookie del admin no le sirve');
  assert.equal((await paulina('POST', '/api/auth/2fa/verify', { code: codeFrom(mailer.sent.at(-1)) })).status, 200);
  assert.equal((await paulina('POST', '/api/account/twofa', { enabled: false, password: 'mala' })).status, 400);
  assert.equal((await paulina('POST', '/api/account/twofa', { enabled: false, password: 'PaulinaNueva2026' })).body.twofa.active, false);
  assert.equal((await admin('POST', '/api/account/twofa', { enabled: false })).status, 400, 'el admin no puede apagarla');

  // --- App de autenticación ---
  const setup = await admin('POST', '/api/account/totp/setup');
  assert.match(setup.body.qr, /^data:image\/png;base64,/);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.equal((await admin('POST', '/api/account/totp/enable', { code: '123456' })).status, 400);
  const enabled = await admin('POST', '/api/account/totp/enable', { code: totpNow(setup.body.secret) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.backupCodes.length, 8);
  assert.match(enabled.body.backupCodes[0], /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(enabled.body.twofa.app, true);

  // Inicio en un equipo nuevo con la app
  const laptop = browser(baseUrl);
  const l1 = await laptop('POST', '/api/auth/login', { email: 'admin@example.test', password: 'AdminNueva2026x' });
  assert.equal(l1.body.twofa.method, 'app');
  assert.equal((await laptop('POST', '/api/auth/2fa/verify', { code: totpNow(setup.body.secret) })).status, 200);

  // Código de respaldo: funciona una vez
  const backup = enabled.body.backupCodes[0];
  const phoneLost = browser(baseUrl);
  await phoneLost('POST', '/api/auth/login', { email: 'admin@example.test', password: 'AdminNueva2026x' });
  assert.equal((await phoneLost('POST', '/api/auth/2fa/verify', { code: backup.toLowerCase().replace('-', ' ') })).status, 200);
  const again = browser(baseUrl);
  await again('POST', '/api/auth/login', { email: 'admin@example.test', password: 'AdminNueva2026x' });
  assert.equal((await again('POST', '/api/auth/2fa/verify', { code: backup })).status, 400);
  // Respaldo por correo aunque use la app
  await new Promise((resolve) => setTimeout(resolve, 0));
  const viaEmail = await again('POST', '/api/auth/2fa/send-email');
  assert.equal(viaEmail.status, 200);
  assert.equal((await again('POST', '/api/auth/2fa/verify', { code: codeFrom(mailer.sent.at(-1)) })).status, 200);
  assert.equal((await again('GET', '/api/account')).body.twofa.backupCodesLeft, 7);

  // Cinco códigos incorrectos cancelan el intento
  const attacker = browser(baseUrl);
  await attacker('POST', '/api/auth/login', { email: 'admin@example.test', password: 'AdminNueva2026x' });
  let last;
  for (let i = 0; i < 5; i += 1) last = await attacker('POST', '/api/auth/2fa/verify', { code: '999999' });
  assert.equal(last.status, 401);
  assert.equal((await attacker('POST', '/api/auth/2fa/verify', { code: totpNow(setup.body.secret) })).status, 401, 'debe volver a iniciar sesión');

  // --- Administrador quita la app de otro usuario ---
  const users = (await admin('GET', '/api/users')).body.users;
  const paulinaId = users.find((u) => u.email === 'paulina@example.test').id;
  const adminId = users.find((u) => u.email === 'admin@example.test').id;
  assert.deepEqual([users.find((u) => u.id === adminId).twofa, users.find((u) => u.id === adminId).twofaApp], [true, true]);
  assert.equal((await paulina('POST', `/api/users/${adminId}/reset-2fa`)).status, 403);
  assert.equal((await admin('POST', `/api/users/${paulinaId}/reset-2fa`)).status, 200);

  // Si un vendedor que entró sin código pasa a administrador, su sesión se cierra
  const created = await admin('POST', '/api/users', { name: 'Bruno', email: 'bruno@example.test', role: 'travel_partner' });
  const bruno = browser(baseUrl);
  assert.ok((await bruno('POST', '/api/auth/login', { email: 'bruno@example.test', password: created.body.temporaryPassword })).body.user);
  await bruno('POST', '/api/auth/change-password', { currentPassword: created.body.temporaryPassword, newPassword: 'BrunoNueva2026x' });
  assert.equal((await bruno('GET', '/api/crm')).status, 200);
  await admin('PATCH', `/api/users/${created.body.user.id}`, { role: 'admin' });
  assert.equal((await bruno('GET', '/api/crm')).status, 401);
  // Quien ya verificó con código en esta sesión no pierde el acceso al cambiar de rol
  await admin('PATCH', `/api/users/${paulinaId}`, { role: 'admin' });
  assert.equal((await paulina('GET', '/api/crm')).status, 200);

  // Desactivar la app requiere contraseña; olvidar equipos borra la cookie
  assert.equal((await admin('POST', '/api/account/totp/disable', { password: 'mala' })).status, 400);
  assert.equal((await admin('POST', '/api/account/totp/disable', { password: 'AdminNueva2026x' })).body.twofa.app, false);
  assert.equal((await admin('POST', '/api/account/forget-devices')).status, 200);
  assert.equal(admin.jar.has('tp.td'), false);
  assert.equal((await admin('GET', '/api/account')).body.twofa.trustedDevices, 0);
});

test('sin correo configurado el administrador no queda bloqueado', async (context) => {
  const baseUrl = await startApp(context, { configured: false, from: null, async send() { throw new Error('no'); } });
  const admin = browser(baseUrl);
  // Con MySQL la base es la misma de la prueba anterior, donde la contraseña ya cambió.
  let login = await admin('POST', '/api/auth/login', { email: 'admin@example.test', password: 'AdminTemporal123' });
  if (login.status === 401) login = await admin('POST', '/api/auth/login', { email: 'admin@example.test', password: 'AdminNueva2026x' });
  assert.equal(login.body.user.role, 'admin');
});
