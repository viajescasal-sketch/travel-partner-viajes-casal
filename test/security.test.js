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

function cookieFrom(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

test('autenticación, roles, cambio de contraseña y cierre de sesión', async (context) => {
  const app = await createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, app: 'Travel Partner Viajes Casal' });
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.ok(health.headers.get('content-security-policy'));

  const anonymous = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(anonymous.status, 401);

  const invalid = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: 'incorrecta' })
  });
  assert.equal(invalid.status, 401);

  const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_INITIAL_PASSWORD })
  });
  assert.equal(adminLogin.status, 200);
  const setCookie = adminLogin.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const adminCookie = cookieFrom(adminLogin);

  const adminUsers = await fetch(`${baseUrl}/api/users`, { headers: { cookie: adminCookie } });
  assert.equal(adminUsers.status, 200);
  const usersPayload = await adminUsers.json();
  assert.equal(usersPayload.users.length, 2);
  assert.equal(JSON.stringify(usersPayload).includes('password_hash'), false);

  const change = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: process.env.ADMIN_INITIAL_PASSWORD, newPassword: 'NuevaSegura12345' })
  });
  assert.equal(change.status, 200);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: adminCookie } });
  assert.equal(logout.status, 200);

  const partnerLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.PARTNER_EMAIL, password: process.env.PARTNER_INITIAL_PASSWORD })
  });
  assert.equal(partnerLogin.status, 200);
  const partnerCookie = cookieFrom(partnerLogin);
  const forbiddenUsers = await fetch(`${baseUrl}/api/users`, { headers: { cookie: partnerCookie } });
  assert.equal(forbiddenUsers.status, 403);
});
